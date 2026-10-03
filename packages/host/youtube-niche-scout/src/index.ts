/**
 * The YouTube niche scout: a weekly shift that researches which YouTube niche
 * a faceless, AI-hosted long-form commentary channel (8–15 minutes, 16:9)
 * should enter. It finds outlier channels and videos with the YouTube Data
 * API, expands seed topics into long-tail searches with autocomplete, scores
 * niches on demand, outlier evidence, RPM, competition, policy risk and
 * production fit, and sends the owner a signed report link on WhatsApp with
 * the recommendation. Reports are kept so weeks can be compared.
 *
 * @module @deepseek-ai/dsh-host-youtube-niche-scout
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PreToolDecision, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { FallbackRouter, installFallback, localTime, parseShiftTime, startShift } from '@deepseek-ai/dsh-host-employee-kit'
import { reportMessage, reportPage } from './report.ts'
import { parseWeekday, quotaDay, runNowRefusal, weeklyDue } from './scoring.ts'
import { whatsAppSender } from './sender.ts'
import { ScoutStore } from './store.ts'
import { suggester } from './suggest.ts'
import { buildScoutTools, quotaCharger, ranked, startRun } from './tools.ts'
import { youTube } from './youtube.ts'

export { rankChanges, reportMessage, reportPage, rpmText } from './report.ts'
export {
  ageMonths, CATEGORIES, channelIsOutlier, channelProfile, competition, geoFactor, monetization, nicheScore, parseWeekday, policyRisk,
  quotaDay, quotaRefusal, runNowRefusal, videoOutlier, weeklyDue, WEIGHTS,
} from './scoring.ts'
export type { CategoryKey, ChannelProfile, Competition, Monetization, NicheCategory, OutlierTier, ScoreParts, VideoOutlier } from './scoring.ts'
export { whatsAppSender } from './sender.ts'
export { emptyState, prune, ScoutStore } from './store.ts'
export type { IdeaSet, NicheRecord, ReportRecord, RunRecord, ScoutState } from './store.ts'
export { expansionQueries, parseSuggestions, pooled, QUESTION_PREFIXES, suggester } from './suggest.ts'
export type { Expansion, SuggestRequest, SuggestSource } from './suggest.ts'
export { buildScoutTools, MAX_IDEAS, MAX_NICHES, MIN_IDEAS, MIN_NICHES, openRun, quotaCharger, ranked, startRun } from './tools.ts'
export type { ScoutDeps, ScoutSettings } from './tools.ts'
export { channelRef, parseChannel, parseDuration, parseVideo, QUOTA_COST, QuotaExhausted, youTube, YouTubeError } from './youtube.ts'
export type { ChannelInfo, SearchOptions, SearchPage, VideoInfo, YouTube } from './youtube.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** The prompt that opens a YouTube niche scout run. */
    'youtube-niche-scout': {
      readonly kind: 'youtube-niche-scout'
      readonly form: 'notice'
      readonly summary: string
    }
  }
}

/** Plugin name. */
export const name = 'youtube-niche-scout'
/** Services the plugin needs. */
export const inject = ['agents', 'webServer', 'agentDefaultModel', 'agentPresets', 'permissionPresets', 'sessionTitle', 'workspaceRegistry']

/** Session ids of the scout's runs start with this. */
const SESSION_PREFIX = 'yns-'
/** How long after one run starts another is refused. */
export const RUN_NOW_GAP_MS = 15 * 60_000

/** Composition and live settings; the `Volatile` fields are edited on the Plugins page. */
export interface Config {
  enabled: Volatile<boolean>
  /** The day of the weekly run, `monday` to `sunday`. */
  weekday: Volatile<string>
  shiftTime: Volatile<string>
  timeZone: Volatile<string>
  /** WhatsApp chat name or number that gets the report link. */
  notifyTo: Volatile<string>
  provider: Volatile<string>
  model: Volatile<string>
  fallbackProvider: Volatile<string>
  fallbackModel: Volatile<string>
  fallbackCooldownMinutes: Volatile<number>
  /** Topics the run starts from. */
  seedTopics: Volatile<string[]>
  /** Audience countries (ISO codes); the first is the default search region. */
  markets: Volatile<string[]>
  /** Languages (ISO codes); the first is the default. */
  languages: Volatile<string[]>
  /** YouTube Data API v3 key; write-only on the settings page. Wins over `envYoutubeApiKey`. */
  youtubeApiKey: Volatile<string>
  /** The same key from the deployment environment (`YOUTUBE_API_KEY`). */
  envYoutubeApiKey: string
  /** The key's daily quota in units (10,000 unless Google raised it). */
  dailyQuota: Volatile<number>
  /** Topic searches (100 units each) one run may make. */
  searchesPerRun: Volatile<number>
  /** How far back topic searches look, in days. */
  windowDays: Volatile<number>
  /** Channels at most this old count as young. */
  maxChannelAgeMonths: Volatile<number>
  /** How long searches, channels and suggestions are reused, in days. */
  cacheDays: Volatile<number>
  dataDir: string
  /** Absolute origin report links are built on, for example `https://harness.example.com`. */
  publicBaseUrl: string
  path: string
  /** Shared secret for the CLI command route; empty leaves it unmounted. */
  token: string
  workspacePath: string
  agentPreset: string
  permissionPreset: string
  /** The run's opening message; `{skill}` becomes the skill file's path. */
  shiftPrompt: string
  whatsappUrl: string
  whatsappToken: string
  /** MCP server name of the browser these Sessions must never use. */
  forbiddenBrowser: string
}

/** Seeds across faceless-friendly, well-paid categories, for an owner who has not chosen any. */
const DEFAULT_SEEDS = [
  'personal finance explained', 'ai tools explained', 'business case study', 'tech news explained', 'history explained',
  'psychology explained', 'geopolitics explained', 'real estate market explained', 'car industry news', 'science explained',
]

/** Composition config. */
export const Config = z.object({
  enabled: z.boolean().default(false).volatile(),
  weekday: z.string().default('monday').volatile(),
  shiftTime: z.string().default('09:00').volatile(),
  timeZone: z.string().default('Africa/Lagos').volatile(),
  notifyTo: z.string().default('').volatile(),
  provider: z.string().default('').volatile(),
  model: z.string().default('').volatile(),
  fallbackProvider: z.string().default('opencode').volatile(),
  fallbackModel: z.string().default('big-pickle').volatile(),
  fallbackCooldownMinutes: z.natural().default(15).volatile(),
  seedTopics: z.array(z.string()).default([...DEFAULT_SEEDS]).volatile(),
  markets: z.array(z.string()).default(['US', 'GB']).volatile(),
  languages: z.array(z.string()).default(['en']).volatile(),
  youtubeApiKey: z.string().role('secret').default('').volatile(),
  envYoutubeApiKey: z.string().default(''),
  dailyQuota: z.natural().default(10_000).volatile(),
  searchesPerRun: z.natural().default(20).volatile(),
  windowDays: z.natural().default(120).volatile(),
  maxChannelAgeMonths: z.natural().default(12).volatile(),
  cacheDays: z.natural().default(6).volatile(),
  dataDir: z.string().default(''),
  publicBaseUrl: z.string().default(''),
  path: z.string().default('/yns'),
  token: z.string().default(''),
  workspacePath: z.string().default('/workspace/youtube-niche-scout'),
  agentPreset: z.string().default('standard'),
  permissionPreset: z.string().default('workspace-write'),
  shiftPrompt: z.string().default('Run this week\'s YouTube niche research. Your instructions are the youtube-niche-scout skill at {skill}: read that file first, then follow it exactly.'),
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

function isSession(agent: Agent): boolean {
  return String(agent.session.id).startsWith(SESSION_PREFIX)
}

const clean = (list: readonly string[]): string[] => list.map(s => s.trim()).filter(s => s !== '')

/**
 * Mount the scout: store, report and status routes, tools on its Sessions, the CLI command route and the weekly timer.
 * @param ctx - the plugin context.
 * @param config - validated composition config.
 */
export function apply(ctx: Context, config: Config): void {
  const dataDir = config.dataDir !== '' ? config.dataDir : join(process.env['DSH_HOME'] ?? join(homedir(), '.dsh'), 'youtube-niche-scout')
  const store = new ScoutStore(join(dataDir, 'state.json'))
  const prefix = config.path.replace(/\/+$/u, '')
  const publicBase = config.publicBaseUrl.replace(/\/+$/u, '')
  const send = whatsAppSender({ url: config.whatsappUrl, token: config.whatsappToken })
  const notify = async (text: string): Promise<string> => {
    const outcome = await send(config.notifyTo.get(), text)
    if (!outcome.startsWith('sent')) process.stderr.write(`youtube-niche-scout: WhatsApp message ${outcome}: ${text.slice(0, 80)}\n`)
    return outcome
  }

  let linkKey = ''
  const keyReady = store.update((s) => {
    s.linkKey ??= randomBytes(32).toString('hex')
    return s.linkKey
  }).then((key) => { linkKey = key }, (error: unknown) => {
    process.stderr.write(`youtube-niche-scout: the state file could not be read: ${error instanceof Error ? error.message : String(error)}\n`)
  })
  const sign = (id: string): string => createHmac('sha256', linkKey).update(`report:${id}`).digest('hex').slice(0, 32)
  const signed = (id: string, sig: string | null): boolean => {
    if (linkKey === '' || sig === null) return false
    const want = Buffer.from(sign(id))
    const got = Buffer.from(sig)
    return want.length === got.length && timingSafeEqual(want, got)
  }
  const reportPath = (id: string): string => `${prefix}/r/${id}?sig=${sign(id)}`
  const reportLink = (id: string): string => `${publicBase}${reportPath(id)}`

  const apiKey = (): string => config.youtubeApiKey.get().trim() || config.envYoutubeApiKey.trim()
  const settings = {
    seeds: () => clean(config.seedTopics.get()),
    markets: () => clean(config.markets.get()).map(m => m.toUpperCase()),
    languages: () => clean(config.languages.get()).map(l => l.toLowerCase()),
    dailyQuota: () => config.dailyQuota.get(),
    searchesPerRun: () => config.searchesPerRun.get(),
    windowDays: () => config.windowDays.get(),
    maxChannelAgeMonths: () => config.maxChannelAgeMonths.get(),
    cacheDays: () => config.cacheDays.get(),
  }
  const now = (): Date => new Date()
  const tools = buildScoutTools({
    store,
    youtube: youTube({ key: apiKey, charge: quotaCharger(store, settings, now) }),
    suggest: suggester(),
    settings,
    now,
    reportLink,
    announce: report => notify(reportMessage(report, reportLink(report.id))),
  })

  // ----- The report page, reached from WhatsApp without the harness sign-in -----
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: `${prefix}/r`,
    authenticate: false,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      await keyReady
      const url = new URL(req.url ?? '/', 'http://x')
      const id = url.pathname.slice(`${prefix}/r/`.length)
      if (!/^[\da-f]{8,40}$/u.test(id) || !signed(id, url.searchParams.get('sig'))) { res.writeHead(404); res.end(); return }
      const state = await store.read()
      const report = state.reports.find(r => r.id === id)
      if (report === undefined) { res.writeHead(404); res.end(); return }
      const history = [...state.reports].reverse().filter(r => r.id !== id).slice(0, 12)
        .map(r => ({ createdAt: r.createdAt, niche: r.recommendation.niche, link: reportPath(r.id) }))
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' })
      res.end(reportPage(report, history))
    },
  }), `youtube-niche-scout: ${prefix}/r`)

  // ----- Status and "Run now" for the settings card (signed in) -----
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${prefix}/status`,
    handler: async (_req: IncomingMessage, res: ServerResponse) => {
      await keyReady
      const state = await store.read()
      const at = new Date()
      const run = state.runs.at(-1)
      const latest = state.reports.at(-1)
      json(res, 200, {
        enabled: config.enabled.get(),
        schedule: { weekday: config.weekday.get(), time: config.shiftTime.get(), timeZone: config.timeZone.get() },
        lastShiftDate: state.lastShiftDate,
        apiKey: apiKey() !== '',
        apiKeySource: config.youtubeApiKey.get().trim() !== '' ? 'settings' : config.envYoutubeApiKey.trim() !== '' ? 'environment' : 'none',
        quota: { day: quotaDay(at), used: state.quota[quotaDay(at)] ?? 0, limit: config.dailyQuota.get() },
        run: run === undefined ? null : {
          id: run.id, startedAt: run.startedAt, trigger: run.trigger,
          finished: run.finishedAt !== undefined, abandoned: run.abandoned === true,
          searches: run.searches, searchesPerRun: config.searchesPerRun.get(), units: run.units,
          niches: ranked(run.niches).map(n => ({ name: n.name, score: n.score })),
        },
        latest: latest === undefined ? null : {
          id: latest.id, createdAt: latest.createdAt, recommendation: latest.recommendation.niche,
          why: latest.recommendation.why.slice(0, 600),
          summary: latest.summary.slice(0, 600), link: reportLink(latest.id), changes: latest.changes.slice(0, 8),
          niches: latest.niches.map(n => ({ name: n.name, score: n.score, rpm: n.rpm, category: n.category })),
        },
        reports: [...state.reports].reverse().slice(0, 12).map(r => ({
          id: r.id, createdAt: r.createdAt, recommendation: r.recommendation.niche, link: reportLink(r.id),
        })),
      })
    },
  }), `youtube-niche-scout: ${prefix}/status`)

  let lastStart = 0
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${prefix}/action`,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'POST') { json(res, 405, { error: 'POST only' }); return }
      let body: { action?: unknown }
      try {
        body = JSON.parse(await readBody(req, 4096) ?? '{}') as { action?: unknown }
      } catch {
        json(res, 400, { error: 'not JSON' })
        return
      }
      if (body.action !== 'run-now') { json(res, 400, { error: 'unknown action' }); return }
      if (apiKey() === '') { json(res, 400, { error: 'no YouTube Data API key is set' }); return }
      // A second press while the first run works would spend the searches twice.
      const refusal = runNowRefusal(Date.now(), await lastStartedAt(), RUN_NOW_GAP_MS)
      if (refusal !== undefined) { json(res, 409, { error: refusal }); return }
      lastStart = Date.now()
      try {
        const sessionId = await start('owner', `YouTube niche research ${localTime(new Date(), config.timeZone.get()).date} (on request)`)
        json(res, 200, { ok: true, sessionId })
      } catch (error) {
        lastStart = 0
        json(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), `youtube-niche-scout: ${prefix}/action`)

  // ----- CLI command route: the same tools for the agy and opencode CLIs -----
  if (config.token !== '') {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: `${prefix}/command`,
      authenticate: false,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        const header = req.headers.authorization ?? ''
        const presented = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '')
        const expected = Buffer.from(config.token)
        if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) { res.writeHead(404); res.end(); return }
        if (req.method === 'GET') { json(res, 200, { tools: tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters })) }); return }
        const raw = await readBody(req, 256 * 1024)
        if (raw === undefined) { json(res, 413, { error: 'too large' }); return }
        let request: { name?: unknown; args?: unknown }
        try {
          request = JSON.parse(raw) as { name?: unknown; args?: unknown }
        } catch {
          json(res, 400, { error: 'not JSON' })
          return
        }
        const found = tools.find(t => t.name === request.name)
        if (found === undefined) { json(res, 400, { error: `no such tool: ${String(request.name)}` }); return }
        const abort = new AbortController()
        res.on('close', () => { if (!res.writableEnded) abort.abort() })
        try {
          const args = typeof request.args === 'object' && request.args !== null ? request.args as Record<string, unknown> : {}
          json(res, 200, { result: await found.execute(args, { signal: abort.signal } as ToolRunContext) })
        } catch (error) {
          json(res, 200, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }), `youtube-niche-scout: ${prefix}/command`)
  }

  // Its Sessions never drive the DeerFlow browser, whose Google account Klipara downloads with.
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    if (exec.agent !== undefined && isSession(exec.agent) && exec.name.startsWith(`mcp__${config.forbiddenBrowser}__`)) {
      return { kind: 'deny', reason: `YouTube niche scout sessions may not use the ${config.forbiddenBrowser} browser.` }
    }
    return next()
  })

  const installed = new Map<Agent, { dispose: () => Promise<void> }>()
  const install = (agent: Agent): void => {
    if (installed.has(agent) || !isSession(agent)) return
    installed.set(agent, agent.ctx.inject(['tools'], (scope) => {
      for (const definition of tools) scope.effect(() => scope.tools.register(definition), `youtube-niche-scout: ${definition.name}`)
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
      process.stderr.write(`youtube-niche-scout: ${change.from.provider}/${change.from.model} failed (${change.failure.code}); run turns use ${change.to.provider}/${change.to.model} until ${change.until.toISOString()}\n`)
    },
  }), isSession)

  /** The latest start, in memory or recorded: a restart does not reopen the gap. */
  const lastStartedAt = async (): Promise<number> => {
    const recorded = (await store.read()).runs.filter(r => r.trigger !== 'tool').at(-1)
    return Math.max(lastStart, recorded === undefined ? 0 : Date.parse(recorded.startedAt))
  }

  const skillPath = join(process.env['DSH_HOME'] ?? join(homedir(), '.dsh'), 'skills', 'youtube-niche-scout', 'SKILL.md')
  const start = async (trigger: 'schedule' | 'owner', title: string): Promise<string> => {
    await mkdir(config.workspacePath, { recursive: true })
    const run = await store.update(s => startRun(s, new Date(), trigger))
    const brief = [
      settings.seeds().length === 0 ? '' : `Seed topics: ${settings.seeds().join('; ')}.`,
      `Markets: ${settings.markets().join(', ') || 'US'}. Languages: ${settings.languages().join(', ') || 'en'}.`,
    ].filter(line => line !== '').join('\n')
    try {
      const sessionId = await startShift(ctx, {
        workspacePath: config.workspacePath,
        title,
        prompt: `${config.shiftPrompt.replaceAll('{skill}', skillPath)}\n${brief}`,
        agentPreset: config.agentPreset,
        permissionPreset: config.permissionPreset,
        provider: config.provider.get(),
        model: config.model.get(),
        sessionPrefix: SESSION_PREFIX,
        source: summary => ({ kind: 'youtube-niche-scout', form: 'notice', summary }),
      }, AbortSignal.timeout(120_000))
      await store.update((s) => {
        const live = s.runs.find(r => r.id === run.id)
        if (live !== undefined) live.sessionId = sessionId
      })
      return sessionId
    } catch (error) {
      await store.update((s) => {
        const live = s.runs.find(r => r.id === run.id)
        if (live !== undefined) Object.assign(live, { finishedAt: new Date().toISOString(), abandoned: true })
      })
      throw error
    }
  }

  let starting = false
  let retryAt = 0
  const tick = async (): Promise<void> => {
    if (starting || !config.enabled.get() || apiKey() === '' || Date.now() < retryAt) return
    const at = parseShiftTime(config.shiftTime.get())
    const weekday = parseWeekday(config.weekday.get())
    if (at === undefined || weekday === undefined) return
    const local = localTime(new Date(), config.timeZone.get())
    const state = await store.read()
    if (!weeklyDue(local, weekday, at, state.lastShiftDate)) return
    if (runNowRefusal(Date.now(), await lastStartedAt(), RUN_NOW_GAP_MS) !== undefined) return
    starting = true
    const previous = state.lastShiftDate
    try {
      await store.update((s) => { s.lastShiftDate = local.date })
      lastStart = Date.now()
      const sessionId = await start('schedule', `YouTube niche research ${local.date}`)
      process.stderr.write(`youtube-niche-scout: started the ${local.date} run as session ${sessionId}\n`)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      await store.update((s) => { s.lastShiftDate = previous })
      retryAt = Date.now() + 30 * 60_000
      void notify(`YouTube niche scout: this week's research did not start (${reason.slice(0, 200)}). Retrying in 30 minutes.`)
    } finally {
      starting = false
    }
  }
  const timer = setInterval(() => { void tick() }, 60_000)
  ctx.effect(() => () => { clearInterval(timer) })
}
