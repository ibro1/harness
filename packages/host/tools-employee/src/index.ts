/**
 * The tools employee: a weekly shift that finds small web tools
 * (calculators, converters, checkers) people search for and a new site can
 * rank with, proposes a shortlist to the owner on WhatsApp, builds only what
 * the owner approves, with known-answer tests and sourced content, and
 * publishes them to tools.linkfa.de, a static site the Dokploy app builds
 * from the site repository. It reviews Search Console weekly and reports
 * when the site is ready for AdSense.
 *
 * @module @deepseek-ai/dsh-host-tools-employee
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PreToolDecision, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { FallbackRouter, installFallback, localTime, parseShiftTime, startShift, whatsAppReader } from '@deepseek-ai/dsh-host-employee-kit'
import { resolveBrowserPath } from '@deepseek-ai/dsh-host-capture'
import { parseServiceAccountKey, ServiceAccountTokens, type ServiceAccountKey } from '@deepseek-ai/dsh-host-seo-employee'
// The meeting-reminders sender, which reads the WhatsApp route's `{ result: { error } }` refusals; the scout re-exports it.
import { suggester, whatsAppSender } from '@deepseek-ai/dsh-host-youtube-niche-scout'
import { isoWeek, MAX_TOOLS_PER_WEEK, parseApproval, parseWeekday, runNowRefusal, weeklyDue } from './gate.ts'
import { readSearchConsole, seoVolumes } from './google.ts'
import { adsenseReadiness, decidedPage, shortlistPage } from './report.ts'
import { serpReader } from './serp.ts'
import { SiteRepo } from './site.ts'
import { ToolsStore } from './store.ts'
import { approvedBacklog, buildEmployeeTools, decide, expireShortlists, MAX_SERPS_PER_DAY, serpsToday } from './tools.ts'

export {
  demandScore, isoWeek, keywordGate, marketFactor, MAX_TOOLS_PER_WEEK, NICHE_RPM, paceRefusal, parseApproval, parseWeekday, rpmBand,
  rpmText, runNowRefusal, spikeReason, weeklyDue,
} from './gate.ts'
export type { ApprovalReply, DemandEvidence, GateInput, GateResult, Niche } from './gate.ts'
export { expectedCtr, parseVolumes, review, seoVolumes } from './google.ts'
export type { ReviewRules, ReviewTool, SeoRoute, VolumeAnswer } from './google.ts'
export { adsenseReadiness, decidedPage, shortlistMessage, shortlistPage } from './report.ts'
export type { ReadinessCheck, ReadinessRules } from './report.ts'
export { answerWidget, EXTRACT_SERP, hostKind, peopleAsk, proxyOption, serpReader, serpUrl, serpVerdict } from './serp.ts'
export type { HostKind, SerpExtract, SerpResult, SerpVerdict } from './serp.ts'
export { authArgs, dirHash, fill, liveCheck, redact, run, SiteRepo, SLUG } from './site.ts'
export type { BuildReport, CommandResult, ScaffoldFields, SiteSettings } from './site.ts'
export { emptyState, prune, ToolsStore } from './store.ts'
export type { Candidate, RunRecord, Shortlist, ShortlistItem, ToolRecord, ToolsState } from './store.ts'
export { approvedBacklog, buildEmployeeTools, decide, expireShortlists, MAX_SERPS_PER_DAY, MAX_SHORTLIST, serpsToday } from './tools.ts'
export type { ToolsDeps, ToolsSettings } from './tools.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** The prompt that opens a tools employee run. */
    'tools-employee': {
      readonly kind: 'tools-employee'
      readonly form: 'notice'
      readonly summary: string
    }
  }
}

/** Plugin name. */
export const name = 'tools-employee'
/** Services the plugin needs. */
export const inject = ['agents', 'webServer', 'agentDefaultModel', 'agentPresets', 'permissionPresets', 'sessionTitle', 'workspaceRegistry']

/** Session ids of the employee's runs start with this. */
const SESSION_PREFIX = 'tle-'
/** How long after one run starts another is refused. */
export const RUN_NOW_GAP_MS = 15 * 60_000

/** Composition and live settings; the `Volatile` fields are edited on the Plugins page. */
export interface Config {
  enabled: Volatile<boolean>
  /** The day of the weekly shift, `monday` to `sunday`. */
  weekday: Volatile<string>
  shiftTime: Volatile<string>
  timeZone: Volatile<string>
  /** WhatsApp chat name or number that gets shortlists and reports, and whose replies approve. */
  notifyTo: Volatile<string>
  provider: Volatile<string>
  model: Volatile<string>
  fallbackProvider: Volatile<string>
  fallbackModel: Volatile<string>
  fallbackCooldownMinutes: Volatile<number>
  /** Topics research starts from. */
  seedTopics: Volatile<string[]>
  /** Audience countries (two-letter); the first is the default Google market. */
  markets: Volatile<string[]>
  /** New tools a week (the plugin never allows more than `MAX_TOOLS_PER_WEEK`). */
  maxToolsPerWeek: Volatile<number>
  /** Live Google results pages a day (never more than `MAX_SERPS_PER_DAY`). */
  serpPerDay: Volatile<number>
  /** AdSense client (`ca-pub-…`); empty keeps ads and ads.txt off. */
  adsenseClient: Volatile<string>
  /** Search Console property, such as `https://tools.linkfa.de/` or `sc-domain:linkfa.de`. */
  gscProperty: Volatile<string>
  /** Service account JSON key for Search Console; write-only on the settings page. */
  googleServiceAccountKey: Volatile<string>
  /** The SEO employee site whose Keyword Planner access is borrowed; empty uses autocomplete only. */
  seoSiteId: Volatile<string>
  /** The site repository's https address the Dokploy app builds from. */
  siteRepo: Volatile<string>
  /** Dokploy deploy webhook; only needed when the app does not deploy on push. */
  deployHook: Volatile<string>
  /** Token with push access to `siteRepo` (`TOOLS_SITE_GIT_TOKEN`). */
  siteToken: string
  siteBranch: string
  /** The public site. */
  siteUrl: string
  /** The shipped framework; empty uses `sites/tools-linkfa` in the harness checkout. */
  templateDir: string
  /** Chromium for reading Google; empty finds it on PATH. */
  browserPath: string
  /** Proxy for reading Google (`TTS_PROXY_URL`); empty reads from the server's own address. */
  proxy: string
  /** Shortest wait between two live results-page reads, in seconds. */
  serpGapSeconds: number
  /** How long results pages, autocomplete and volumes are reused, in days. */
  cacheDays: number
  /** Published tools with passing tests before AdSense readiness. */
  adsenseMinTools: number
  /** Search clicks in 28 days before AdSense readiness. */
  adsenseMinClicks28: number
  /** Fewest impressions for a query to count in the Search Console review. */
  reviewMinImpressions: number
  /** Days live without an impression before a tool is flagged for pruning. */
  pruneAfterDays: number
  /** How often WhatsApp is read for the owner's approval while a shortlist waits. */
  approvalCheckMs: number
  seoCommandUrl: string
  seoToken: string
  dataDir: string
  /** Absolute origin review links are built on. */
  publicBaseUrl: string
  path: string
  /** Shared secret for the CLI command route; empty leaves it unmounted. */
  token: string
  workspacePath: string
  agentPreset: string
  permissionPreset: string
  /** The weekly shift's opening message; `{skill}` becomes the skill file's path. */
  shiftPrompt: string
  /** The opening message of a run started by the owner's approval. */
  buildPrompt: string
  whatsappUrl: string
  whatsappToken: string
  /** MCP server name of the browser these Sessions must never use. */
  forbiddenBrowser: string
}

/** Seeds in niches with tier-1 demand and tools Google does not answer itself. */
const DEFAULT_SEEDS = [
  'zakat calculator', 'islamic inheritance calculator', 'uk tax calculator', 'salary sacrifice calculator', 'stamp duty calculator',
  'pension calculator uk', 'student loan repayment calculator', 'mortgage overpayment calculator', 'notice period calculator',
  'holiday entitlement calculator', 'redundancy pay calculator', 'vat calculator',
]

/** Composition config. */
export const Config = z.object({
  enabled: z.boolean().default(false).volatile(),
  weekday: z.string().default('tuesday').volatile(),
  shiftTime: z.string().default('09:00').volatile(),
  timeZone: z.string().default('Africa/Lagos').volatile(),
  notifyTo: z.string().default('').volatile(),
  provider: z.string().default('').volatile(),
  model: z.string().default('').volatile(),
  fallbackProvider: z.string().default('opencode').volatile(),
  fallbackModel: z.string().default('big-pickle').volatile(),
  fallbackCooldownMinutes: z.natural().default(15).volatile(),
  seedTopics: z.array(z.string()).default([...DEFAULT_SEEDS]).volatile(),
  markets: z.array(z.string()).default(['GB', 'US']).volatile(),
  maxToolsPerWeek: z.natural().default(2).volatile(),
  serpPerDay: z.natural().default(12).volatile(),
  adsenseClient: z.string().default('').volatile(),
  gscProperty: z.string().default('https://tools.linkfa.de/').volatile(),
  googleServiceAccountKey: z.string().role('secret').default('').volatile(),
  seoSiteId: z.string().default('').volatile(),
  siteRepo: z.string().default('').volatile(),
  deployHook: z.string().role('secret').default('').volatile(),
  siteToken: z.string().default(''),
  siteBranch: z.string().default('main'),
  siteUrl: z.string().default('https://tools.linkfa.de'),
  templateDir: z.string().default(''),
  browserPath: z.string().default(''),
  proxy: z.string().default(''),
  serpGapSeconds: z.natural().default(30),
  cacheDays: z.natural().min(1).default(14),
  adsenseMinTools: z.natural().default(15),
  adsenseMinClicks28: z.natural().default(50),
  reviewMinImpressions: z.natural().default(20),
  pruneAfterDays: z.natural().default(120),
  approvalCheckMs: z.natural().min(60_000).default(10 * 60_000),
  seoCommandUrl: z.string().default(''),
  seoToken: z.string().default(''),
  dataDir: z.string().default(''),
  publicBaseUrl: z.string().default(''),
  path: z.string().default('/tools'),
  token: z.string().default(''),
  workspacePath: z.string().default('/workspace/tools-employee'),
  agentPreset: z.string().default('standard'),
  permissionPreset: z.string().default('workspace-write'),
  shiftPrompt: z.string().default('Run this week\'s tools employee shift. Your instructions are the tools-employee skill at {skill}: read that file first, then follow it exactly.'),
  buildPrompt: z.string().default('The owner approved tools to build. Your instructions are the tools-employee skill at {skill}: read that file first, then build and publish the approved tools as it says.'),
  whatsappUrl: z.string().default(''),
  whatsappToken: z.string().default(''),
  forbiddenBrowser: z.string().default('deerflow'),
})

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

function htmlPage(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' })
  res.end(body)
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

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.mjs': 'application/javascript', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.xml': 'application/xml', '.txt': 'text/plain; charset=utf-8',
}

/**
 * Mount the employee: store, status and action routes, the signed shortlist page, the site preview, tools on its
 * Sessions, the CLI command route, the WhatsApp approval reader and the weekly timer.
 * @param ctx - the plugin context.
 * @param config - validated composition config.
 */
export function apply(ctx: Context, config: Config): void {
  const dataDir = config.dataDir !== '' ? config.dataDir : join(process.env['DSH_HOME'] ?? join(homedir(), '.dsh'), 'tools-employee')
  const store = new ToolsStore(join(dataDir, 'state.json'))
  const prefix = config.path.replace(/\/+$/u, '')
  const publicBase = config.publicBaseUrl.replace(/\/+$/u, '')
  const siteUrl = config.siteUrl.replace(/\/+$/u, '')
  const templateDir = config.templateDir !== '' ? config.templateDir : fileURLToPath(new URL('../../../../sites/tools-linkfa/', import.meta.url))
  const previewDir = join(dataDir, 'preview')
  const send = whatsAppSender({ url: config.whatsappUrl, token: config.whatsappToken })
  const notify = async (text: string): Promise<string> => {
    const outcome = await send(config.notifyTo.get(), text)
    if (!outcome.startsWith('sent')) process.stderr.write(`tools-employee: WhatsApp message ${outcome}: ${text.slice(0, 80)}\n`)
    return outcome
  }
  const readWhatsApp = whatsAppReader({ url: config.whatsappUrl, token: config.whatsappToken, to: () => config.notifyTo.get() })

  let linkKey = ''
  const keyReady = store.update((s) => {
    s.linkKey ??= randomBytes(32).toString('hex')
    return s.linkKey
  }).then((key) => { linkKey = key }, (error: unknown) => {
    process.stderr.write(`tools-employee: the state file could not be read: ${error instanceof Error ? error.message : String(error)}\n`)
  })
  const sign = (id: string): string => createHmac('sha256', linkKey).update(`shortlist:${id}`).digest('hex').slice(0, 32)
  const signed = (id: string, sig: string | null): boolean => {
    if (linkKey === '' || sig === null) return false
    const want = Buffer.from(sign(id))
    const got = Buffer.from(sig)
    return want.length === got.length && timingSafeEqual(want, got)
  }
  const shortlistLink = (id: string): string => `${publicBase}${prefix}/r/${id}?sig=${sign(id)}`

  const site = new SiteRepo({
    templateDir,
    workDir: join(config.workspacePath, 'site'),
    previewDir,
    repo: () => config.siteRepo.get(),
    token: () => config.siteToken,
    branch: config.siteBranch,
    deployHook: () => config.deployHook.get(),
    siteUrl: () => siteUrl,
    adsenseClient: () => config.adsenseClient.get(),
  })
  let seedCache: string[] | undefined
  const seedSlugs = (): string[] => seedCache ?? []
  void readdir(join(templateDir, 'tools'), { withFileTypes: true })
    .then((entries) => { seedCache = entries.filter(e => e.isDirectory()).map(e => e.name) }, () => { seedCache = [] })

  // Search Console through the SEO employee's client, signed in as the service account saved on this card.
  const serviceAccount = (): ServiceAccountKey | string | undefined => {
    const raw = config.googleServiceAccountKey.get().trim()
    return raw === '' ? undefined : parseServiceAccountKey(raw)
  }
  const accountTokens = new ServiceAccountTokens(fetch, () => {
    const key = serviceAccount()
    if (key === undefined || typeof key === 'string') throw new Error(key ?? 'No service account key is saved.')
    return key
  })
  const gscProblem = (): string | undefined => {
    const key = serviceAccount()
    if (config.gscProperty.get().trim() === '') return 'no Search Console property is set on the tools employee card'
    if (key === undefined) return 'no service account key is saved on the tools employee card'
    if (typeof key === 'string') return `the saved service account key is unusable: ${key}`
    return undefined
  }

  const settings = {
    seeds: () => clean(config.seedTopics.get()),
    markets: () => clean(config.markets.get()).map(m => m.toUpperCase()),
    maxToolsPerWeek: () => Math.min(MAX_TOOLS_PER_WEEK, config.maxToolsPerWeek.get()),
    serpPerDay: () => Math.min(MAX_SERPS_PER_DAY, config.serpPerDay.get()),
    serpGapMs: () => config.serpGapSeconds * 1000,
    cacheDays: () => config.cacheDays,
    timeZone: () => config.timeZone.get(),
    siteUrl: () => siteUrl,
    adsenseClient: () => config.adsenseClient.get().trim(),
    readiness: () => ({ minTools: config.adsenseMinTools, minClicks28: config.adsenseMinClicks28 }),
    review: () => ({ minImpressions: config.reviewMinImpressions, pruneAfterDays: config.pruneAfterDays }),
  }
  const tools = buildEmployeeTools({
    store,
    site,
    suggest: suggester(),
    readSerp: serpReader(() => ({ browserPath: resolveBrowserPath(config.browserPath), proxy: config.proxy, timeoutMs: 30_000 })),
    volumes: seoVolumes({ url: config.seoCommandUrl, token: config.seoToken, siteId: () => config.seoSiteId.get() }),
    searchConsole: async (signal) => {
      const problem = gscProblem()
      if (problem !== undefined) throw new Error(`Search Console is not connected: ${problem}.`)
      const property = config.gscProperty.get().trim()
      const token = await accountTokens.accessToken(signal)
      const rows = await readSearchConsole(fetch, token, property, new URL(siteUrl).host, new Date(), signal)
      return { property, ...rows }
    },
    gscProblem,
    settings,
    now: () => new Date(),
    sleep: (ms, signal) => new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms)
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')) }, { once: true })
    }),
    notify,
    shortlistLink,
    seedSlugs,
    fetch,
  })

  // ----- The shortlist page, opened from WhatsApp without the harness sign-in -----
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: `${prefix}/r`,
    authenticate: false,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      await keyReady
      const url = new URL(req.url ?? '/', 'http://x')
      const match = /^\/([\da-f]{8,40})(\/decide)?$/u.exec(url.pathname.slice(`${prefix}/r`.length))
      const id = match?.[1] ?? ''
      if (match === null || !signed(id, url.searchParams.get('sig'))) { res.writeHead(404); res.end(); return }
      if (match[2] === '/decide') {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
        const form = new URLSearchParams(await readBody(req, 4096) ?? '')
        const numbers = form.getAll('n').map(Number).filter(n => Number.isInteger(n) && n > 0)
        try {
          const approved = await store.update(s => decide(s, id, numbers, 'page', new Date()))
          htmlPage(res, 200, decidedPage(approved))
        } catch {
          // Already decided (on WhatsApp, or a second press): show the decision instead.
          const decided = (await store.read()).shortlists.find(s => s.id === id)
          if (decided === undefined) { res.writeHead(404); res.end(); return }
          htmlPage(res, 409, shortlistPage(decided, ''))
        }
        return
      }
      const list = (await store.read()).shortlists.find(s => s.id === id)
      if (list === undefined) { res.writeHead(404); res.end(); return }
      htmlPage(res, 200, shortlistPage(list, `${prefix}/r/${id}/decide?sig=${sign(id)}`))
    },
  }), `tools-employee: ${prefix}/r`)

  // ----- The latest build, for the owner to look at before the site is deployed (signed in) -----
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: `${prefix}/preview`,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://x')
      let rel = decodeURIComponent(url.pathname.slice(`${prefix}/preview`.length)) || '/'
      if (rel.endsWith('/')) rel += 'index.html'
      const file = normalize(join(previewDir, rel))
      if (!file.startsWith(previewDir + sep) || !existsSync(file)) {
        htmlPage(res, 404, '<p>Not built yet. The preview appears after the first tools_publish.</p>')
        return
      }
      const type = MIME[extname(file)] ?? 'application/octet-stream'
      let body: Buffer | string = await readFile(file)
      // The site links from its root; inside the preview those links point back into it.
      if (type.startsWith('text/html')) body = body.toString('utf8').replace(/(href|src)="\/(?!\/)/gu, `$1="${prefix}/preview/`)
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' })
      res.end(body)
    },
  }), `tools-employee: ${prefix}/preview`)

  // ----- Status and actions for the settings card (signed in) -----
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${prefix}/status`,
    handler: async (_req: IncomingMessage, res: ServerResponse) => {
      await keyReady
      const state = await store.update((s) => {
        expireShortlists(s, new Date())
        return s
      })
      const at = new Date()
      const run = state.runs.at(-1)
      const list = state.shortlists.find(s => s.status === 'pending') ?? state.shortlists.at(-1)
      const records = Object.values(state.tools)
      const gsc = gscProblem()
      const readiness = adsenseReadiness({
        site: state.siteCheck, pages: state.pages, tools: records, clicks28: gsc === undefined ? state.gsc?.totals.clicks : undefined,
        clientSet: settings.adsenseClient() !== '', rules: settings.readiness(),
      })
      const publishedNew = records.filter(t => !t.seed && t.firstPublishedAt !== undefined).map(t => t.firstPublishedAt ?? '')
      const repo = config.siteRepo.get().trim()
      const keyword = config.seoSiteId.get().trim()
      json(res, 200, {
        enabled: config.enabled.get(),
        schedule: { weekday: config.weekday.get(), time: config.shiftTime.get(), timeZone: config.timeZone.get() },
        lastShiftDate: state.lastShiftDate,
        run: run === undefined ? null : {
          id: run.id, kind: run.kind, startedAt: run.startedAt, trigger: run.trigger,
          finished: run.finishedAt !== undefined, abandoned: run.abandoned === true,
        },
        site: {
          url: siteUrl,
          state: state.siteCheck?.state ?? 'unknown',
          detail: state.siteCheck?.detail ?? 'Not checked yet: press Check site.',
          liveVersion: state.siteCheck?.liveVersion ?? null,
          localVersion: state.publish?.version ?? null,
          checkedAt: state.siteCheck?.at ?? null,
          repo,
          pushReady: repo !== '' && config.siteToken !== '',
          pushDetail: repo === ''
            ? 'No site repository is set: builds stay on the harness (preview only).'
            : config.siteToken === '' ? 'TOOLS_SITE_GIT_TOKEN is not set on the harness, so it cannot push.' : `Pushes to ${repo} (${config.siteBranch}).`,
          deployHookSet: config.deployHook.get().trim() !== '',
          previewPath: `${prefix}/preview/`,
          lastPublish: state.publish ?? null,
        },
        shortlist: list === undefined ? null : {
          id: list.id, createdAt: list.createdAt, status: list.status, link: shortlistLink(list.id),
          items: list.items.map(i => ({
            n: i.n, slug: i.slug, tool: i.tool, keyword: i.keyword, verdict: i.verdict, demand: i.demand, market: i.market, rpm: i.rpm,
            difficulty: i.difficulty, approved: i.approved, built: i.builtAt !== undefined, published: i.publishedAt !== undefined,
          })),
        },
        tools: records.sort((a, b) => (a.firstPublishedAt ?? '9').localeCompare(b.firstPublishedAt ?? '9')).map(t => ({
          slug: t.slug, title: t.title, url: `${siteUrl}/${t.slug}/`, keyword: t.keyword, publishedAt: t.firstPublishedAt ?? '', seed: t.seed,
          tests: t.tests?.status ?? 'unknown', testsAt: t.tests?.at ?? null, live: t.firstPublishedAt !== undefined && state.siteCheck?.state === 'live',
          clicks: t.gsc?.clicks ?? null, impressions: t.gsc?.impressions ?? null, position: t.gsc?.position ?? null, flag: t.flag ?? null,
        })),
        pace: {
          thisWeek: publishedNew.filter(p => isoWeek(new Date(p), config.timeZone.get()) === isoWeek(at, config.timeZone.get())).length,
          max: settings.maxToolsPerWeek(),
        },
        serp: { today: serpsToday(state, at, config.timeZone.get()), max: settings.serpPerDay() },
        adsense: { clientSet: settings.adsenseClient() !== '', ...readiness },
        gsc: {
          connected: gsc === undefined, keySet: config.googleServiceAccountKey.get().trim() !== '', property: config.gscProperty.get(),
          detail: gsc === undefined ? (state.gsc === undefined ? 'Connected; no review yet.' : `Last review ${state.gsc.at.slice(0, 10)}: ${String(state.gsc.totals.clicks)} clicks, ${String(state.gsc.totals.impressions)} impressions in 28 days.`) : `Not connected: ${gsc}.`,
          lastReviewAt: state.gsc?.at ?? null,
        },
        keywordPlanner: {
          available: keyword !== '' && config.seoCommandUrl !== '' && config.seoToken !== '',
          detail: keyword === ''
            ? 'Not used: choose an SEO employee site to borrow its Keyword Planner access. Demand rests on Google autocomplete.'
            : config.seoToken === '' ? 'The SEO employee is not running here.' : `Borrowed from the SEO employee site "${keyword}".`,
        },
      })
    },
  }), `tools-employee: ${prefix}/status`)

  let lastStart = 0
  const run = (name: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    const found = tools.find(t => t.name === name)
    if (found === undefined) throw new Error(`no tool ${name}`)
    return found.execute(args, { signal: AbortSignal.timeout(10 * 60_000) } as ToolRunContext)
  }
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
      try {
        if (body.action === 'run-now') {
          // A second press while the first run works would spend the day's results pages twice.
          const refusal = runNowRefusal(Date.now(), await lastStartedAt(), RUN_NOW_GAP_MS)
          if (refusal !== undefined) { json(res, 409, { error: refusal }); return }
          lastStart = Date.now()
          try {
            const sessionId = await start('owner', 'research', `Tools employee ${localTime(new Date(), config.timeZone.get()).date} (on request)`)
            json(res, 200, { ok: true, sessionId, message: 'Run started. The shortlist arrives on WhatsApp when it is ready.' })
          } catch (error) {
            lastStart = 0
            throw error
          }
          return
        }
        if (body.action === 'publish-site') {
          const result = await run('tools_publish') as { text: string }
          json(res, 200, { ok: true, message: result.text.split('\n').slice(0, 2).join(' ') })
          return
        }
        if (body.action === 'check-site') {
          const result = await run('tools_site_status') as { text: string }
          json(res, 200, { ok: true, message: result.text.split('\n')[0] ?? '' })
          return
        }
        json(res, 400, { error: 'unknown action' })
      } catch (error) {
        json(res, 409, { error: error instanceof Error ? error.message.slice(0, 600) : String(error) })
      }
    },
  }), `tools-employee: ${prefix}/action`)

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
    }), `tools-employee: ${prefix}/command`)
  }

  // Its Sessions never drive the DeerFlow browser, whose Google account Klipara downloads with.
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    if (exec.agent !== undefined && isSession(exec.agent) && exec.name.startsWith(`mcp__${config.forbiddenBrowser}__`)) {
      return { kind: 'deny', reason: `Tools employee sessions may not use the ${config.forbiddenBrowser} browser.` }
    }
    return next()
  })

  const installed = new Map<Agent, { dispose: () => Promise<void> }>()
  const install = (agent: Agent): void => {
    if (installed.has(agent) || !isSession(agent)) return
    installed.set(agent, agent.ctx.inject(['tools'], (scope) => {
      for (const definition of tools) scope.effect(() => scope.tools.register(definition), `tools-employee: ${definition.name}`)
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
      process.stderr.write(`tools-employee: ${change.from.provider}/${change.from.model} failed (${change.failure.code}); run turns use ${change.to.provider}/${change.to.model} until ${change.until.toISOString()}\n`)
    },
  }), isSession)

  /** The latest start, in memory or recorded: a restart does not reopen the gap. */
  const lastStartedAt = async (): Promise<number> => {
    const recorded = (await store.read()).runs.at(-1)
    return Math.max(lastStart, recorded === undefined ? 0 : Date.parse(recorded.startedAt))
  }

  const skillPath = join(process.env['DSH_HOME'] ?? join(homedir(), '.dsh'), 'skills', 'tools-employee', 'SKILL.md')
  const start = async (trigger: 'schedule' | 'owner' | 'approval', kind: 'research' | 'build', title: string): Promise<string> => {
    await mkdir(config.workspacePath, { recursive: true })
    const runId = randomBytes(6).toString('hex')
    await store.update((s) => {
      for (const r of s.runs) if (r.finishedAt === undefined) Object.assign(r, { finishedAt: new Date().toISOString(), abandoned: true })
      s.runs.push({ id: runId, kind, trigger, startedAt: new Date().toISOString() })
    })
    const brief = [
      `Seed topics: ${settings.seeds().join('; ') || '(none)'}.`,
      `Markets: ${settings.markets().join(', ') || 'GB'}. The site working copy is ${join(config.workspacePath, 'site')}.`,
    ].join('\n')
    try {
      const sessionId = await startShift(ctx, {
        workspacePath: config.workspacePath,
        title,
        prompt: `${(kind === 'build' ? config.buildPrompt : config.shiftPrompt).replaceAll('{skill}', skillPath)}\n${brief}`,
        agentPreset: config.agentPreset,
        permissionPreset: config.permissionPreset,
        provider: config.provider.get(),
        model: config.model.get(),
        sessionPrefix: SESSION_PREFIX,
        source: summary => ({ kind: 'tools-employee', form: 'notice', summary }),
      }, AbortSignal.timeout(120_000))
      await store.update((s) => {
        const live = s.runs.find(r => r.id === runId)
        if (live !== undefined) live.sessionId = sessionId
      })
      return sessionId
    } catch (error) {
      await store.update((s) => {
        const live = s.runs.find(r => r.id === runId)
        if (live !== undefined) Object.assign(live, { finishedAt: new Date().toISOString(), abandoned: true })
      })
      throw error
    }
  }

  // ----- The owner's WhatsApp reply to a pending shortlist ("build 1,3") -----
  let checking = false
  const checkReplies = async (): Promise<void> => {
    if (checking) return
    const pending = (await store.read()).shortlists.find(s => s.status === 'pending')
    if (pending === undefined) return
    checking = true
    try {
      const since = Date.parse(pending.createdAt) / 1000
      const messages = (await readWhatsApp(60)).filter(m => m.ts >= since).sort((a, b) => b.ts - a.ts)
      for (const message of messages) {
        const reply = parseApproval(message.body, pending.tag, pending.items.length)
        if (reply === undefined) continue
        const numbers = reply.kind === 'all' ? pending.items.map(i => i.n) : reply.kind === 'none' ? [] : reply.numbers
        const approved = await store.update(s => decide(s, pending.id, numbers, 'whatsapp', new Date()))
        void notify(approved.length === 0 ? 'Tools employee: noted, nothing from this shortlist will be built.' : `Tools employee: building ${approved.join(', ')}.`)
        break
      }
    } catch (error) {
      process.stderr.write(`tools-employee: reading WhatsApp for approvals failed: ${error instanceof Error ? error.message : String(error)}\n`)
    } finally {
      checking = false
    }
  }

  let starting = false
  let retryAt = 0
  let lastReplyCheck = 0
  const tick = async (): Promise<void> => {
    if (Date.now() - lastReplyCheck >= config.approvalCheckMs) {
      lastReplyCheck = Date.now()
      await checkReplies()
    }
    if (starting || Date.now() < retryAt) return
    const state = await store.read()
    if (runNowRefusal(Date.now(), await lastStartedAt(), RUN_NOW_GAP_MS) !== undefined) return
    const local = localTime(new Date(), config.timeZone.get())
    // Approved tools are built as soon as no run is working, whether or not the weekly shift is on.
    const unbuilt = approvedBacklog(state).filter(b => b.item.builtAt === undefined)
    const lastRun = state.runs.at(-1)
    const buildDue = unbuilt.length > 0 && (lastRun === undefined || Date.parse(lastRun.startedAt) < Date.parse(unbuilt[0]?.list.decidedAt ?? ''))
    const at = parseShiftTime(config.shiftTime.get())
    const weekday = parseWeekday(config.weekday.get())
    const shiftDue = config.enabled.get() && at !== undefined && weekday !== undefined && weeklyDue(local, weekday, at, state.lastShiftDate)
    if (!buildDue && !shiftDue) return
    starting = true
    const previous = state.lastShiftDate
    try {
      if (shiftDue) await store.update((s) => { s.lastShiftDate = local.date })
      lastStart = Date.now()
      const kind = shiftDue ? 'research' : 'build'
      const sessionId = await start(shiftDue ? 'schedule' : 'approval', kind, `Tools employee ${local.date}${kind === 'build' ? ' (approved tools)' : ''}`)
      process.stderr.write(`tools-employee: started the ${local.date} ${kind} run as session ${sessionId}\n`)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      if (shiftDue) await store.update((s) => { s.lastShiftDate = previous })
      retryAt = Date.now() + 30 * 60_000
      void notify(`Tools employee: the run did not start (${reason.slice(0, 200)}). Retrying in 30 minutes.`)
    } finally {
      starting = false
    }
  }
  const timer = setInterval(() => { void tick() }, 60_000)
  ctx.effect(() => () => { clearInterval(timer) })
}
