/**
 * Dokploy control for the harness: a settings-configured roster of Dokploy
 * servers, and the agent tools that query and deploy through their REST API.
 *
 * Servers live in the `dokploy` user-settings namespace, so they are added and
 * edited the same way models are — one entry per server, each with a name, a
 * base URL, and an API key marked secret so the configuration surface masks it.
 * The tools resolve a server by name against that roster and never take a URL or
 * key from the model, so a prompt cannot point them at an arbitrary host.
 *
 * @module @deepseek-ai/dsh-host-dokploy
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-host-webserver'

/** The settings namespace holding the server roster. */
const NS = 'dokploy'

/** One configured Dokploy server, as stored in settings. */
interface DokployServer {
  name: string
  url: string
  /** Name of the environment variable holding this server's API key. */
  apiKeyEnv: string
}

/** The resolved `dokploy` settings section. */
interface DokployConfig {
  servers: DokployServer[]
}

/** Schema for the settings namespace; the API key is a masked secret. */
const CONFIG_SCHEMA: z<DokployConfig> = z.object({
  servers: z.array(z.object({
    name: z.string().required().description('A short label you choose for this server, used when asking a tool to act on it.'),
    url: z.string().required().description('Base URL of the Dokploy server, for example https://server.example.com.'),
    apiKeyEnv: z.string().required().description('Name of the environment variable that holds this server API key, for example DOKPLOY_KEY_MAIN. The key itself lives in the environment, never in settings.'),
  })).default([]).description('Dokploy servers this harness may query and deploy through.'),
})

/** The plugin name, for the Loader. */
export const name = 'dokploy'

/** The services this plugin reads. */
export const inject = ['settings', 'agents', 'webServer']

/** Composition config; the roster lives in settings, so nothing is required here. */
export interface Config {
  /** Milliseconds one API call may take before it is abandoned. */
  timeoutMs: number
  /** Absolute path of the token-guarded command route MCP clients reach. */
  path: string
  /** Shared secret the command route requires; empty leaves the route unmounted. */
  token: string
}

/** Composition config; the roster lives in settings, so nothing is required here. */
export const Config: z<Config> = z.object({
  timeoutMs: z.natural().min(1000).default(15_000),
  path: z.string().default('/dokploy'),
  token: z.string().default(''),
})

/** Largest command body accepted on the MCP route. */
const MAX_COMMAND_BODY_BYTES = 64 * 1024

/** Compare two secrets without leaking their relationship through timing. */
function secretEquals(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest())
}

/**
 * Read a request body, refusing one past the cap rather than buffering it.
 * @param req - the request to drain. @param limit - most bytes to accept.
 * @returns the body text, or undefined when it exceeded the cap.
 */
async function readBody(req: IncomingMessage, limit: number): Promise<string | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > limit) return undefined
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** The canonical output of every Dokploy tool: text for the model to read. */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: {
      type: 'string',
      required: true,
      description: 'What Dokploy reported, as text.',
    },
  },
} as const satisfies ValueSchemaSpec

/** Trim a base URL to its origin, so a trailing slash or /api does not double up. */
function apiBase(url: string): string {
  return url.replace(/\/+$/u, '').replace(/\/api$/u, '')
}

/** Read the server roster live from settings each call, so edits take effect at once. */
type ReadServers = () => readonly DokployServer[]

/**
 * Resolve a server by name, or explain which names exist.
 * @param servers - the current roster.
 * @param requested - the name the model asked for, if any.
 * @returns the matched server.
 * @throws when none are configured, the name is unknown, or several exist and
 * the caller named none — never guessing, since deploying to the wrong server
 * is worse than refusing.
 */
function resolveServer(servers: readonly DokployServer[], requested: string | undefined): DokployServer {
  if (servers.length === 0) {
    throw new Error('No Dokploy servers are configured; add one under Settings → dokploy.')
  }
  if (requested !== undefined && requested !== '') {
    const match = servers.find(server => server.name === requested)
    if (match === undefined) {
      throw new Error(`No Dokploy server named ${JSON.stringify(requested)}; configured: ${servers.map(s => s.name).join(', ')}.`)
    }
    return match
  }
  if (servers.length > 1) {
    throw new Error(`Several Dokploy servers are configured (${servers.map(s => s.name).join(', ')}); pass server to choose one.`)
  }
  return servers[0] as DokployServer
}

/**
 * Call one Dokploy REST endpoint.
 * @param server - the resolved server, carrying its URL and key.
 * @param endpoint - the API path after `/api/`, for example `project.all`.
 * @param init - method and body; GET when omitted.
 * @param timeoutMs - abandon the call after this long.
 * @returns the parsed JSON response.
 * @throws when the request fails or Dokploy answers with an error status.
 */
async function callDokploy(
  server: DokployServer,
  endpoint: string,
  init: { method?: string; body?: unknown } | undefined,
  timeoutMs: number,
): Promise<unknown> {
  const apiKey = process.env[server.apiKeyEnv]?.trim()
  if (apiKey === undefined || apiKey === '') {
    throw new Error(`Dokploy ${server.name} has no API key: set the ${server.apiKeyEnv} environment variable.`)
  }
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, timeoutMs)
  try {
    const method = init?.method ?? 'GET'
    const response = await fetch(`${apiBase(server.url)}/api/${endpoint}`, {
      method,
      headers: {
        'x-api-key': apiKey,
        'Accept': 'application/json',
        ...(init?.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: controller.signal,
    })
    const text = await response.text()
    if (!response.ok) {
      // Dokploy's own message is the useful part; surface it, trimmed.
      throw new Error(`Dokploy ${server.name} answered ${String(response.status)}: ${text.slice(0, 300)}`)
    }
    try {
      return JSON.parse(text) as unknown
    } catch {
      return text
    }
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`Dokploy ${server.name} did not answer within ${String(timeoutMs)}ms`)
    throw error instanceof Error ? error : new Error(String(error))
  } finally {
    clearTimeout(timer)
  }
}

/** A record whose shape Dokploy owns; read defensively. */
type Json = Record<string, unknown>

/** Best-effort string field. */
function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Best-effort array of records. */
function rows(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter((row): row is Json => typeof row === 'object' && row !== null) : []
}

/**
 * Register the Dokploy tools on one agent's context.
 * @param ctx - the agent's context, carrying its tool registry.
 * @param readServers - live reader of the configured roster.
 * @param timeoutMs - per-call timeout.
 */
function registerDokployTools(ctx: Context, readServers: ReadServers, timeoutMs: number): void {
  for (const tool of buildDokployTools(readServers, timeoutMs)) {
    ctx.effect(() => ctx.tools.register(tool), `dokploy: ${tool.name}`)
  }
}

/**
 * Build the Dokploy tools without registering them, so one definition serves
 * both the per-agent registry and the MCP command route.
 * @param readServers - live reader of the configured roster.
 * @param timeoutMs - per-call timeout.
 * @returns the tool definitions.
 */
export function buildDokployTools(readServers: ReadServers, timeoutMs: number): ToolDefinition[] {
  const serverParameter = {
    type: 'string',
    description: 'Which configured Dokploy server to act on, by its name. Omit when only one is configured; use dokploy_servers to see the names.',
  } as const

  const reply = (text: string): { text: string } => ({ text })

  return [
    defineTool({
      name: 'dokploy_servers',
      description: 'List the Dokploy servers this harness is configured to manage, by name and URL. API keys are never shown.',
      parameters: {},
      output: { schema: OUTPUT_SCHEMA, render: (_a, v) => [{ type: 'text', text: v.text }] },
      execute: (_args, exec: ToolRunContext) => {
        exec.signal.throwIfAborted()
        const servers = readServers()
        const text = servers.length === 0
          ? 'No Dokploy servers are configured. Add one under Settings → dokploy.'
          : `Configured Dokploy servers:\n${servers.map(s => `- ${s.name} (${s.url})`).join('\n')}`
        return Promise.resolve(reply(text))
      },
      presentCall: () => ({ card: 'generic', title: 'List Dokploy servers', kind: 'other', rawInput: '' }),
    }),

    defineTool({
      name: 'dokploy_projects',
      description: 'List the projects on a Dokploy server, with the applications and services inside each. Use it to find the application id a deploy needs.',
      parameters: { server: serverParameter },
      output: { schema: OUTPUT_SCHEMA, render: (_a, v) => [{ type: 'text', text: v.text }] },
      execute: async (args, exec: ToolRunContext) => {
        exec.signal.throwIfAborted()
        const server = resolveServer(readServers(), args.server)
        const data = await callDokploy(server, 'project.all', undefined, timeoutMs)
        const projects = rows(data)
        if (projects.length === 0) return reply(`No projects on ${server.name}.`)
        const lines = projects.map((project) => {
          const apps = rows(project['applications']).map(a => `    app "${str(a['name'])}" [${str(a['applicationId'])}] ${str(a['applicationStatus'] || a['status'])}`)
          const composes = rows(project['compose']).map(c => `    compose "${str(c['name'])}" [${str(c['composeId'])}]`)
          const body = [...apps, ...composes]
          return `- ${str(project['name'])} [${str(project['projectId'])}]\n${body.join('\n') || '    (no applications)'}`
        })
        return reply(`Projects on ${server.name}:\n${lines.join('\n')}`)
      },
      presentCall: args => ({ card: 'generic', title: 'List Dokploy projects', kind: 'other', rawInput: args.server ?? '' }),
    }),

    defineTool({
      name: 'dokploy_deploy',
      description: 'Trigger a deployment of one application by its id. Get the id from dokploy_projects first. This starts a real deploy on the server.',
      parameters: {
        server: serverParameter,
        applicationId: { type: 'string', required: true, description: 'The application id to deploy, as shown by dokploy_projects.' },
      },
      output: { schema: OUTPUT_SCHEMA, render: (_a, v) => [{ type: 'text', text: v.text }] },
      execute: async (args, exec: ToolRunContext) => {
        exec.signal.throwIfAborted()
        const server = resolveServer(readServers(), args.server)
        await callDokploy(server, 'application.deploy', { method: 'POST', body: { applicationId: args.applicationId } }, timeoutMs)
        return reply(`Started a deployment of application ${args.applicationId} on ${server.name}.`)
      },
      presentCall: args => ({ card: 'generic', title: `Deploy ${args.applicationId}`, kind: 'other', rawInput: args.applicationId }),
    }),

    defineTool({
      name: 'dokploy_status',
      description: 'Read the current state of one application by its id: its deployment status and basic details.',
      parameters: {
        server: serverParameter,
        applicationId: { type: 'string', required: true, description: 'The application id to inspect, as shown by dokploy_projects.' },
      },
      output: { schema: OUTPUT_SCHEMA, render: (_a, v) => [{ type: 'text', text: v.text }] },
      execute: async (args, exec: ToolRunContext) => {
        exec.signal.throwIfAborted()
        const server = resolveServer(readServers(), args.server)
        const data = await callDokploy(server, `application.one?applicationId=${encodeURIComponent(args.applicationId)}`, undefined, timeoutMs)
        const app = (typeof data === 'object' && data !== null ? data : {}) as Json
        const name_ = str(app['name'])
        const status = str(app['applicationStatus'] || app['status'])
        return reply(`Application "${name_ || args.applicationId}" on ${server.name}: ${status || 'status unknown'}.`)
      },
      presentCall: args => ({ card: 'generic', title: `Status of ${args.applicationId}`, kind: 'other', rawInput: args.applicationId }),
    }),
  ]
}

/**
 * Answer one MCP command request: the catalogue on GET, one tool call on POST.
 * @param req - the request, carrying the token.
 * @param res - the response to complete.
 * @param tools - the built tool definitions.
 * @param token - the shared secret the route requires.
 */
async function handleCommand(req: IncomingMessage, res: ServerResponse, tools: ToolDefinition[], token: string): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://x')
  const header = req.headers.authorization ?? ''
  const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : url.searchParams.get('token') ?? ''
  if (token === '' || !secretEquals(presented, token)) {
    res.writeHead(404)
    res.end()
    return
  }
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ tools: tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters })) }))
    return
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Allow': 'GET, POST' })
    res.end()
    return
  }
  const body = await readBody(req, MAX_COMMAND_BODY_BYTES)
  if (body === undefined) {
    res.writeHead(413, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'the command body is too large' }))
    return
  }
  let request: { name?: unknown; args?: unknown }
  try {
    request = JSON.parse(body) as typeof request
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'the command body is not JSON' }))
    return
  }
  const tool = tools.find(t => t.name === request.name)
  if (tool === undefined) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: `no such tool: ${String(request.name)}` }))
    return
  }
  try {
    const args = (typeof request.args === 'object' && request.args !== null ? request.args : {}) as Record<string, unknown>
    const result = await tool.execute(args, { signal: new AbortController().signal } as ToolRunContext)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ result }))
  } catch (error) {
    // The caller's failure — a missing server or an unset key — is the answer.
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
  }
}

/**
 * Mount the Dokploy roster and tools.
 * @param ctx - the plugin context, injecting `settings` and `agents`.
 * @param config - validated composition config.
 */
export function apply(ctx: Context, config: Config): void {
  const scope = ctx.settings.register(NS, CONFIG_SCHEMA, { base: { servers: [] } })
  const readServers: ReadServers = () => scope.get().servers

  // A token-guarded command route, so a CLI's MCP client (agy, opencode) can
  // reach the same tools a direct-provider agent gets natively. The token is
  // the route's whole authentication; an empty one leaves it unmounted.
  if (config.token !== '') {
    const routeTools = buildDokployTools(readServers, config.timeoutMs)
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: `${config.path}/command`,
      authenticate: false,
      handler: (req: IncomingMessage, res: ServerResponse) => handleCommand(req, res, routeTools, config.token),
    }), `dokploy: ${config.path}/command`)
  }

  const installed = new Map<Agent, { dispose: () => Promise<void> }>()
  const install = (agent: Agent): void => {
    if (installed.has(agent)) return
    installed.set(agent, agent.ctx.inject(['tools'], (scope2) => {
      registerDokployTools(scope2, readServers, config.timeoutMs)
    }))
  }
  const remove = (agent: Agent): void => {
    const fiber = installed.get(agent)
    if (fiber === undefined) return
    installed.delete(agent)
    void fiber.dispose().catch(() => {
      // The agent is gone; its registry went with it.
    })
  }
  for (const agent of ctx.agents.list()) install(agent)
  ctx.on('agent/created', ({ agent }) => { install(agent) })
  ctx.on('agent/disposed', ({ agent }) => { remove(agent) })
}
