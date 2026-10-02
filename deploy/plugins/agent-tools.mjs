// Agent tools for the CLIs: the Agent Teams tools (spawn_teammate,
// send_message, wait_agent, team_task_*, ...) over one token-guarded command
// route, for the agy and opencode CLIs' MCP clients.
//
// Those CLIs run their own agent loop and drop the harness's tools. The team
// tools cannot be rebuilt beside the route the way session-tools rebuilds
// outputs and capture: they are registered per agent, only on a team member,
// and act as the calling agent (the Lead's roster, the teammate's own inbox).
// So this route finds the live agent the CLI is serving — the bridges pass the
// session id as DSH_SESSION_ID, and an agent's id is its session id — and
// runs the named tool through `ctx.tools.execute` with that agent. The call
// takes the same path an agent-loop call does: the agent's tool view, its
// pre-execute hooks (approval, auto-review), guards and output checks. A tool
// the agent cannot see is refused as unknown, exactly as for the model.
//
// Teammates inherit the Lead's provider, so a teammate of an agy Lead is also
// an agy session with its own DSH_SESSION_ID, and reaches its own team tools
// through the same route.
//
// The catalogue is per agent: GET names the session, and the answer is that
// agent's visible tools filtered to `tools`. An agent that is not live, or is
// not a team member, lists none.
//
// `wait_agent` may block for up to an hour. The answer's headers go out at
// once and a space every 20 s until the JSON follows, so the MCP server's HTTP
// client never times out on a quiet socket; JSON.parse ignores the spaces.
//
// Called by a process inside the container, not the browser, so the route is
// not behind the password gate; the token is its auth. Every connection
// arrives from the socat forwarder on loopback, so the peer address proves
// nothing here, and the token is generated per boot by the entrypoint.

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import { mountSwitch } from '../../packages/host/plugin-switch/lib/index.js'

export const name = 'agent-tools'
export const inject = ['webServer', 'agents', 'tools']

/** The Agent Teams tools, as `tool-agent-team` registers them. */
const TEAM_TOOLS = [
  'spawn_teammate', 'send_message', 'list_agents', 'wait_agent', 'interrupt_agent',
  'team_task_create', 'team_task_list', 'team_task_get', 'team_task_update',
]

export const Config = z.object({
  path: z.string().default('/agent-tools'),
  token: z.string().default(''),
  tools: z.array(z.string()).default(TEAM_TOOLS),
  keepAliveMs: z.natural().default(20_000),
})

/** Largest command body accepted: a tool call's arguments, never a file. */
const MAX_COMMAND_BODY_BYTES = 256 * 1024

/** @param {string} message - one line for the container log. */
function announce(message) { process.stderr.write(`agent-tools: ${message}\n`) }

/** Compare two secrets in constant time, whatever their lengths. */
function secretEquals(a, b) {
  const digest = value => createHash('sha256').update(value).digest()
  return timingSafeEqual(digest(a), digest(b))
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** Read the request body, or undefined when it exceeds the limit. */
async function readBody(req, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) return undefined
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * The text of a tool result's content blocks, as the model would read it.
 * @param {Array<{type: string, text?: string}>} content
 * @returns {string}
 */
function contentText(content) {
  return content.map(block => block.type === 'text' ? block.text ?? '' : `[${block.type} content omitted]`).join('\n')
}

export function apply(ctx, config) {
  // Mounted before the token check, so the Plugins page can say the route is missing its token.
  const toggle = mountSwitch(ctx, {
    id: 'agent-tools',
    defaultEnabled: true,
    health: () => config.token === ''
      ? { healthy: false, facts: [{ key: 'token', flag: false }], problem: 'No token was generated for this route at boot, so the CLIs cannot reach it.' }
      : { healthy: true, facts: [{ key: 'token', flag: true }, { key: 'route', value: `${config.path}/command` }, { key: 'tools', value: config.tools.join(', ') }] },
  })
  if (config.token === '') {
    announce('no token configured — route not mounted')
    return
  }
  const allowed = new Set(config.tools)

  /**
   * The live agent serving a session.
   * @param {unknown} session - the id the CLI's MCP server sent.
   * @returns {object} the agent.
   */
  const agentFor = (session) => {
    if (typeof session !== 'string' || session === '') {
      throw new Error('These tools act as a harness agent, and the call named no session. They work only inside a harness session.')
    }
    const agent = ctx.agents.get(session)
    if (agent === undefined) throw new Error(`Session ${session} has no live agent in the harness.`)
    return agent
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${config.path}/command`,
    authenticate: false,
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://x')
      const header = req.headers.authorization ?? ''
      const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : url.searchParams.get('token') ?? ''
      if (!secretEquals(presented, config.token)) {
        res.writeHead(404)
        res.end()
        return
      }
      if (!toggle.isOn()) {
        // Switched off on the Plugins page: the CLI lists no tools and every call is refused.
        if (req.method === 'GET') json(res, 200, { tools: [] })
        else json(res, 200, { error: 'Agent Teams tools for the CLIs is switched off on the Plugins page; ask the owner to switch it on.' })
        return
      }
      if (req.method === 'GET') {
        let agent
        try {
          agent = agentFor(url.searchParams.get('session') ?? '')
        } catch {
          json(res, 200, { tools: [] })
          return
        }
        const listed = ctx.tools.schemas(agent).filter(schema => allowed.has(schema.name))
        json(res, 200, { tools: listed.map(t => ({ name: t.name, description: t.description, parameters: t.parameters })) })
        return
      }
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Allow': 'GET, POST' })
        res.end()
        return
      }
      const body = await readBody(req, MAX_COMMAND_BODY_BYTES)
      if (body === undefined) { json(res, 413, { error: 'the command body is too large' }); return }
      let request
      try {
        request = JSON.parse(body)
      } catch {
        json(res, 400, { error: 'the command body is not JSON' })
        return
      }
      if (!allowed.has(request.name)) { json(res, 400, { error: `no such tool: ${String(request.name)}` }); return }
      let agent
      try {
        agent = agentFor(request.session)
      } catch (error) {
        json(res, 200, { error: error instanceof Error ? error.message : String(error) })
        return
      }
      // wait_agent can run for an hour; stop it if the CLI goes away.
      const abort = new AbortController()
      res.on('close', () => { if (!res.writableEnded) abort.abort() })
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      const keepAlive = setInterval(() => { res.write(' ') }, config.keepAliveMs)
      try {
        const result = await ctx.tools.execute({
          callId: `bridge-${randomUUID()}`,
          name: request.name,
          arguments: typeof request.args === 'object' && request.args !== null ? request.args : {},
          agent,
          signal: abort.signal,
        })
        const text = contentText(result.content)
        res.end(JSON.stringify(result.isError ? { error: text } : { result: text }))
      } catch (error) {
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
      } finally {
        clearInterval(keepAlive)
      }
    },
  }), `agent-tools: ${config.path}/command`)
  announce(`command route ${config.path}/command (token; ${config.tools.length} tools)`)
}
