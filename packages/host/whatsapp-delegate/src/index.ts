/**
 * The WhatsApp delegate: an employee that answers the owner's work contacts on
 * WhatsApp as the owner. It reads each listed contact's chats every few
 * seconds, waits for a burst of messages to go quiet, and hands it to that
 * contact's own long-lived Session in the contact's project, which triages,
 * fixes and deploys when asked, and replies through the delegate's tools.
 * Routine replies go out at once; anything that commits the owner waits for
 * his "ok" on WhatsApp or on the Plugins page.
 *
 * @module @deepseek-ai/dsh-host-whatsapp-delegate
 */

import { timingSafeEqual } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { brandString } from '@deepseek-ai/dsh-brand'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { PreToolDecision, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { FallbackRouter, installFallback, startShift } from '@deepseek-ai/dsh-host-employee-kit'
import { DelegateEngine, type EngineSettings, type SessionDriver } from './engine.ts'
import { contactFrom, envSecrets, type Contact } from './logic.ts'
import { DelegateStore } from './store.ts'
import { bindTools } from './tools.ts'
import { transcribe, whatsAppClient } from './whatsapp.ts'

export { DelegateEngine, digestText } from './engine.ts'
export type { EngineDeps, EngineSettings, SessionDriver } from './engine.ts'
export {
  chatJid, contactFrom, contactNamed, envSecrets, findSecrets, localStamp, messageLine, ownerTyped, parseOwnerCommand, planBatch,
  splitReply, withinRateLimit,
} from './logic.ts'
export type { BatchPlan, BatchTiming, Contact, OwnerCommand, QueuedRow, WaRow } from './logic.ts'
export { contactState, DelegateStore, emptyState } from './store.ts'
export type { ActivityEntry, Approval, BatchAction, BatchRecord, ContactState, DelegateState, SentRecord } from './store.ts'
export { bindTools, DELEGATE_TOOLS, wrongContact } from './tools.ts'
export type { DelegateToolSpec } from './tools.ts'
export { transcribe, whatsAppClient } from './whatsapp.ts'
export type { SendOutcome, WhatsAppClient, WhatsAppRoute } from './whatsapp.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** A batch of a contact's WhatsApp messages, or the owner's instruction, handed to the contact's Session. */
    'whatsapp-delegate': {
      readonly kind: 'whatsapp-delegate'
      readonly form: 'notice'
      readonly summary: string
    }
  }
}

/** Plugin name. */
export const name = 'whatsapp-delegate'
/** Services the plugin needs. */
export const inject = ['agents', 'webServer', 'agentDefaultModel', 'agentPresets', 'permissionPresets', 'sessionTitle', 'workspaceRegistry']

/** Session ids of the delegate start with this, then the contact id, a dash, and a UUID. */
const SESSION_PREFIX = 'wad-'
/** Length of the UUID that ends a Session id. */
const UUID_LENGTH = 36

/** Composition and live settings; the `Volatile` fields are edited on the Plugins page. */
export interface Config {
  enabled: Volatile<boolean>
  /** The people the delegate answers; see the README for the fields. */
  contacts: Volatile<unknown[]>
  /** The owner's own WhatsApp number (or his "message yourself" chat) for approvals, digests and his replies. */
  notifyTo: Volatile<string>
  timeZone: Volatile<string>
  pollSeconds: Volatile<number>
  quietSeconds: Volatile<number>
  maxWaitSeconds: Volatile<number>
  ownerActiveMinutes: Volatile<number>
  contextMessages: Volatile<number>
  maxReplies: Volatile<number>
  rateWindowMinutes: Volatile<number>
  maxReplyChars: Volatile<number>
  digest: Volatile<boolean>
  provider: Volatile<string>
  model: Volatile<string>
  fallbackProvider: Volatile<string>
  fallbackModel: Volatile<string>
  fallbackCooldownMinutes: Volatile<number>
  /** Groq key for voice notes; write-only on the settings page. Wins over `envGroqApiKey`. */
  groqApiKey: Volatile<string>
  envGroqApiKey: string
  transcriptionModel: Volatile<string>
  dataDir: string
  path: string
  /** Shared secret for the CLI command route; empty leaves it unmounted. */
  token: string
  agentPreset: string
  permissionPreset: string
  whatsappUrl: string
  whatsappToken: string
  /** MCP server name of the browser these Sessions must never use. */
  forbiddenBrowser: string
}

/** Composition config. */
export const Config = z.object({
  enabled: z.boolean().default(false).volatile(),
  contacts: z.array(z.any()).default([]).volatile(),
  notifyTo: z.string().default('').volatile(),
  timeZone: z.string().default('Africa/Lagos').volatile(),
  pollSeconds: z.natural().min(5).default(20).volatile(),
  quietSeconds: z.natural().default(90).volatile(),
  maxWaitSeconds: z.natural().default(240).volatile(),
  ownerActiveMinutes: z.natural().default(10).volatile(),
  contextMessages: z.natural().max(200).default(30).volatile(),
  maxReplies: z.natural().min(1).default(6).volatile(),
  rateWindowMinutes: z.natural().min(1).default(10).volatile(),
  maxReplyChars: z.natural().min(200).default(1500).volatile(),
  digest: z.boolean().default(true).volatile(),
  provider: z.string().default('').volatile(),
  model: z.string().default('').volatile(),
  fallbackProvider: z.string().default('opencode').volatile(),
  fallbackModel: z.string().default('big-pickle').volatile(),
  fallbackCooldownMinutes: z.natural().default(15).volatile(),
  groqApiKey: z.string().role('secret').default('').volatile(),
  envGroqApiKey: z.string().default(''),
  transcriptionModel: z.string().default('whisper-large-v3-turbo').volatile(),
  dataDir: z.string().default(''),
  path: z.string().default('/whatsapp-delegate'),
  token: z.string().default(''),
  agentPreset: z.string().default('standard'),
  permissionPreset: z.string().default('danger-full-access'),
  whatsappUrl: z.string().default(''),
  whatsappToken: z.string().default(''),
  forbiddenBrowser: z.string().default('deerflow'),
})

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage, limit: number): Promise<string | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += buffer.length
    if (size > limit) return undefined
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * The contact a delegate Session id belongs to.
 * @param sessionId - `wad-<contact id>-<uuid>`.
 * @returns the contact id, or undefined for any other Session.
 */
export function contactOfSession(sessionId: string): string | undefined {
  if (!sessionId.startsWith(SESSION_PREFIX) || sessionId.length < SESSION_PREFIX.length + UUID_LENGTH + 2) return undefined
  const id = sessionId.slice(SESSION_PREFIX.length, -(UUID_LENGTH + 1))
  return id === '' ? undefined : id
}

function isSession(agent: Agent): boolean {
  return contactOfSession(String(agent.session.id)) !== undefined
}

/**
 * Mount the delegate: store, engine, routes, tools on its Sessions, the CLI command route and the poll timer.
 * @param ctx - the plugin context.
 * @param config - validated composition config.
 */
export function apply(ctx: Context, config: Config): void {
  const dataDir = config.dataDir !== '' ? config.dataDir : join(process.env['DSH_HOME'] ?? join(homedir(), '.dsh'), 'whatsapp-delegate')
  const store = new DelegateStore(join(dataDir, 'state.json'))
  const prefix = config.path.replace(/\/+$/u, '')
  const skillPath = join(process.env['DSH_HOME'] ?? join(homedir(), '.dsh'), 'skills', 'whatsapp-delegate', 'SKILL.md')
  const warn = (message: string): void => { process.stderr.write(`whatsapp-delegate: ${message}\n`) }
  // Contact ids become part of Session ids, so only lower-case letters, digits and dashes are taken.
  const contacts = (): Contact[] => config.contacts.get().map(contactFrom)
    .filter((c): c is Contact => c !== undefined && /^[a-z0-9][a-z0-9-]*$/u.test(c.id))
  const groqKey = (): string => config.groqApiKey.get().trim() || config.envGroqApiKey.trim()
  const settings = (): EngineSettings => ({
    enabled: config.enabled.get(),
    notifyTo: config.notifyTo.get(),
    timeZone: config.timeZone.get(),
    timing: {
      quietMs: config.quietSeconds.get() * 1000,
      maxWaitMs: config.maxWaitSeconds.get() * 1000,
      ownerActiveMs: config.ownerActiveMinutes.get() * 60_000,
    },
    contextMessages: config.contextMessages.get(),
    maxReplies: config.maxReplies.get(),
    rateWindowMs: config.rateWindowMinutes.get() * 60_000,
    maxReplyChars: config.maxReplyChars.get(),
    digest: config.digest.get(),
    skillPath,
  })
  const workspaceOf = (contact: Contact): string => contact.workspacePath !== '' ? contact.workspacePath : join(dataDir, 'workspaces', contact.id)

  const message = (prompt: string, summary: string) => createUserMessage({
    content: [{ type: 'text', text: prompt }],
    source: { kind: 'whatsapp-delegate', form: 'notice', summary: boundContextSummary(summary) },
  })
  const driver: SessionDriver = {
    deliver: async (contact, sessionId, prompt) => {
      const summary = `WhatsApp: ${contact.name}`
      if (sessionId !== undefined) {
        const id = brandString<SessionId>(sessionId)
        let agent = ctx.agents.get(id)
        const controller = ctx.get('sessionController')
        if (agent === undefined && controller !== undefined) {
          const resolved = await ctx.agents.withoutInitiator(() => controller.resolveAgent(id))
          if ('error' in resolved) warn(`${contact.name}'s session ${sessionId} could not be resumed (${resolved.error.message}); starting a new one`)
          else agent = resolved.agent
        }
        if (agent !== undefined) {
          // A busy Session takes the new messages at its next step; an idle one starts a turn.
          if (agent.status === 'running') agent.steer(message(prompt, summary))
          else agent.followup(message(prompt, summary))
          return { sessionId, idle: agent.whenIdle() }
        }
      }
      const workspacePath = workspaceOf(contact)
      await mkdir(workspacePath, { recursive: true })
      const started = await startShift(ctx, {
        workspacePath,
        title: summary,
        prompt,
        agentPreset: config.agentPreset,
        permissionPreset: config.permissionPreset,
        provider: config.provider.get(),
        model: config.model.get(),
        sessionPrefix: `${SESSION_PREFIX}${contact.id}-`,
        source: bounded => ({ kind: 'whatsapp-delegate', form: 'notice', summary: bounded }),
      }, AbortSignal.timeout(120_000))
      return { sessionId: started, idle: ctx.agents.get(brandString<SessionId>(started))?.whenIdle() ?? Promise.resolve() }
    },
  }

  const whatsapp = whatsAppClient({ url: config.whatsappUrl, token: config.whatsappToken })
  const engine = new DelegateEngine({
    store,
    whatsapp,
    contacts,
    settings,
    driver,
    transcribe: audio => transcribe(audio, { apiKey: groqKey(), model: config.transcriptionModel.get() }),
    mediaDir: join(dataDir, 'media'),
    secrets: () => [...envSecrets(process.env), config.groqApiKey.get(), config.whatsappToken, config.token].filter(v => v.length >= 8),
    now: () => Date.now(),
    warn,
  })
  const ready = engine.recover().catch((error: unknown) => {
    warn(`the state file could not be read: ${error instanceof Error ? error.message : String(error)}`)
  })

  // ----- Status and owner actions for the settings page (signed in) -----
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${prefix}/status`,
    handler: async (_req: IncomingMessage, res: ServerResponse) => {
      await ready
      const state = await store.read()
      const list = contacts()
      json(res, 200, {
        enabled: config.enabled.get(),
        paused: state.paused,
        whatsapp: whatsapp.configured,
        notifyTo: config.notifyTo.get().trim() !== '',
        groqKey: groqKey() !== '',
        groqKeySource: config.groqApiKey.get().trim() !== '' ? 'settings' : config.envGroqApiKey.trim() !== '' ? 'environment' : 'none',
        contacts: list.map((c) => {
          const cs = state.contacts[c.id]
          return {
            id: c.id, name: c.name, enabled: c.enabled, paused: c.paused, sessionId: cs?.sessionId ?? null,
            waiting: cs?.queue.filter(r => !r.fromMe).length ?? 0,
            working: state.batches.some(b => b.contactId === c.id && b.status === 'running'),
          }
        }),
        approvals: [...state.approvals].reverse().slice(0, 30).map(a => ({
          code: a.code, contact: list.find(c => c.id === a.contactId)?.name ?? a.contactId, text: a.text, why: a.why,
          createdAt: a.createdAt, status: a.status, decidedAt: a.decidedAt ?? null, outcome: a.outcome ?? null,
        })),
        batches: [...state.batches].reverse().slice(0, 30).map(b => ({
          id: b.id, contact: list.find(c => c.id === b.contactId)?.name ?? b.contactId, startedAt: b.startedAt, endedAt: b.endedAt ?? null,
          status: b.status, messages: b.messages.map(m => m.body === '' ? `[${m.kind}]` : m.body), error: b.error ?? null,
          actions: b.actions.map(a => ({ kind: a.kind, text: a.text, code: a.code ?? null })),
        })),
        activity: [...state.activity].reverse().slice(0, 100),
      })
    },
  }), `whatsapp-delegate: ${prefix}/status`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${prefix}/action`,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'POST') { json(res, 405, { error: 'POST only' }); return }
      let body: { action?: unknown; code?: unknown; text?: unknown }
      try {
        body = JSON.parse(await readBody(req, 64 * 1024) ?? '{}') as typeof body
      } catch {
        json(res, 400, { error: 'not JSON' })
        return
      }
      await ready
      const code = typeof body.code === 'number' ? body.code : Number.NaN
      const text = typeof body.text === 'string' ? body.text.trim() : ''
      switch (body.action) {
        case 'pause':
          await store.update((s) => { s.paused = { reason: 'paused on the Plugins page', at: new Date().toISOString() } })
          json(res, 200, { ok: true })
          return
        case 'resume':
          await store.update((s) => { s.paused = null })
          json(res, 200, { ok: true })
          return
        case 'approve':
        case 'reject':
        case 'edit':
          if (!Number.isInteger(code)) { json(res, 400, { error: 'need a draft number' }); return }
          if (body.action === 'edit' && text === '') { json(res, 400, { error: 'the edited text is empty' }); return }
          json(res, 200, { ok: true, outcome: await engine.decide(code, body.action, body.action === 'edit' ? text : undefined) })
          return
        case 'poll':
          void engine.poll()
          json(res, 200, { ok: true })
          return
        default:
          json(res, 400, { error: 'unknown action' })
      }
    },
  }), `whatsapp-delegate: ${prefix}/action`)

  // ----- CLI command route: the same tools for the agy and opencode CLIs, for delegate Sessions only -----
  if (config.token !== '') {
    const catalogue = bindTools(engine, '', () => [])
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: `${prefix}/command`,
      authenticate: false,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        const header = req.headers.authorization ?? ''
        const presented = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '')
        const expected = Buffer.from(config.token)
        if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) { res.writeHead(404); res.end(); return }
        if (req.method === 'GET') {
          const url = new URL(req.url ?? '/', 'http://x')
          // Other Sessions see no tools: only a contact's own Session may speak for the owner.
          const own = contactOfSession(url.searchParams.get('session') ?? '') !== undefined
          json(res, 200, { tools: own ? catalogue.map(t => ({ name: t.name, description: t.description, parameters: t.parameters })) : [] })
          return
        }
        const raw = await readBody(req, 256 * 1024)
        if (raw === undefined) { json(res, 413, { error: 'too large' }); return }
        let request: { name?: unknown; args?: unknown; session?: unknown }
        try {
          request = JSON.parse(raw) as typeof request
        } catch {
          json(res, 400, { error: 'not JSON' })
          return
        }
        const contactId = contactOfSession(typeof request.session === 'string' ? request.session : '')
        const contact = contacts().find(c => c.id === contactId)
        if (contactId === undefined || contact === undefined) {
          json(res, 200, { error: 'Only a WhatsApp delegate session can use these tools.' })
          return
        }
        const found = bindTools(engine, contactId, () => [contact.id, contact.name]).find(t => t.name === request.name)
        if (found === undefined) { json(res, 400, { error: `no such tool: ${String(request.name)}` }); return }
        try {
          const args = typeof request.args === 'object' && request.args !== null ? request.args as Record<string, unknown> : {}
          json(res, 200, { result: await found.execute(args, { signal: AbortSignal.timeout(120_000) } as ToolRunContext) })
        } catch (error) {
          json(res, 200, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }), `whatsapp-delegate: ${prefix}/command`)
  }

  // Delegate Sessions reply only through delegate_reply, never drive the DeerFlow browser.
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    if (exec.agent !== undefined && isSession(exec.agent)) {
      if (/(?:^|_)whatsapp_(?:send|approve)$/u.test(exec.name)) {
        return { kind: 'deny', reason: 'WhatsApp delegate sessions send messages only with delegate_reply.' }
      }
      if (exec.name.startsWith(`mcp__${config.forbiddenBrowser}__`)) {
        return { kind: 'deny', reason: `WhatsApp delegate sessions may not use the ${config.forbiddenBrowser} browser.` }
      }
    }
    return next()
  })

  const installed = new Map<Agent, { dispose: () => Promise<void> }>()
  const install = (agent: Agent): void => {
    const contactId = contactOfSession(String(agent.session.id))
    if (installed.has(agent) || contactId === undefined) return
    const names = (): readonly string[] => [contactId, contacts().find(c => c.id === contactId)?.name ?? contactId]
    installed.set(agent, agent.ctx.inject(['tools'], (scope) => {
      for (const definition of bindTools(engine, contactId, names)) scope.effect(() => scope.tools.register(definition), `whatsapp-delegate: ${definition.name}`)
    }))
  }
  for (const agent of ctx.agents.list()) install(agent)
  ctx.on('agent/created', ({ agent }) => { install(agent) })
  ctx.on('agent/disposed', ({ agent }) => {
    const fiber = installed.get(agent)
    installed.delete(agent)
    void fiber?.dispose().catch(() => undefined)
  })

  const resolveRoute = (provider: string, model: string): { provider: string; model: string } | undefined =>
    provider.trim() === '' || model.trim() === '' ? undefined : { provider: provider.trim(), model: model.trim() }
  installFallback(ctx, new FallbackRouter({
    fallback: () => resolveRoute(config.fallbackProvider.get(), config.fallbackModel.get()),
    shift: () => resolveRoute(config.provider.get(), config.model.get()),
    cooldownMs: () => config.fallbackCooldownMinutes.get() * 60_000,
    onSwitch: (change) => {
      warn(`${change.from.provider}/${change.from.model} failed (${change.failure.code}); delegate turns use ${change.to.provider}/${change.to.model} until ${change.until.toISOString()}`)
    },
  }), isSession)

  let lastPoll = 0
  const timer = setInterval(() => {
    // Switched off, a round only forgets the read positions, so switching on starts from new messages.
    if (Date.now() - lastPoll < config.pollSeconds.get() * 1000) return
    lastPoll = Date.now()
    void ready.then(() => engine.poll()).catch((error: unknown) => {
      warn(`poll failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }, 5000)
  ctx.effect(() => () => { clearInterval(timer) })
}
