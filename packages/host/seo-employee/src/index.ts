/**
 * The SEO employee: a daily shift that researches keywords for the owner's
 * sites (Search Console, Google Ads Keyword Planner, Google suggestions),
 * plans one page per search intent, asks the owner for first-hand material,
 * writes articles under code-enforced checks and an editor model's recorded
 * verdict, publishes them to Klipara or WordPress within a weekly cap, and
 * reports how they rank.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PreToolDecision, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { brandString } from '@deepseek-ai/dsh-brand'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  FallbackRouter, installFallback, localTime, parseShiftTime, shiftDue, startShift, whatsAppNotifier, whatsAppReader,
} from '@deepseek-ai/dsh-host-employee-kit'
import { askEditor } from './editor-call.ts'
import {
  GoogleTokens, ServiceAccountTokens, authorizationUrl, exchangeCode, parseServiceAccountKey, pkcePair, randomState, type ServiceAccountKey,
} from './google/oauth.ts'
import { accessibleAccounts } from './google/ads.ts'
import { listSites } from './google/gsc.ts'
import { createPublisher } from './publishers/index.ts'
import { probeWordPress } from './publishers/wordpress.ts'
import { SeoStore, publishedThisWeek } from './store.ts'
import { buildSeoTools, type SeoDeps } from './tools.ts'
import type { Market, PublisherKind, Site, SiteGoogle, SiteSecrets } from './types.ts'

export { SeoStore, emptyState, isoWeek, publishedThisWeek } from './store.ts'
export type { Article, Draft, OwnerQuestion, SeoState, Topic } from './store.ts'
export { buildSeoTools } from './tools.ts'
export type { SeoDeps } from './tools.ts'
export type * from './types.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** The prompt that opens an SEO employee shift, or wakes it with the owner's answers. */
    'seo-employee': {
      readonly kind: 'seo-employee'
      readonly form: 'notice'
      readonly summary: string
    }
  }
}

/** Plugin name. */
export const name = 'seo-employee'
/** Services the plugin needs. */
export const inject = ['agents', 'webServer', 'llm', 'agentDefaultModel', 'agentPresets', 'permissionPresets', 'sessionTitle', 'workspaceRegistry']

/** Session ids of the employee's shifts start with this. */
const SESSION_PREFIX = 'seo-'

/** Plugin configuration; fields marked volatile are edited on the SEO employee page. */
export interface Config {
  enabled: Volatile<boolean>
  shiftTime: Volatile<string>
  timeZone: Volatile<string>
  notifyTo: Volatile<string>
  provider: Volatile<string>
  model: Volatile<string>
  fallbackProvider: Volatile<string>
  fallbackModel: Volatile<string>
  fallbackCooldownMinutes: Volatile<number>
  /** The editor model; empty uses the shift's model. */
  editorProvider: Volatile<string>
  editorModel: Volatile<string>
  /** A service account's JSON key; when set, Google is reached as that account and the OAuth client is not used. */
  googleServiceAccountKey: Volatile<string>
  googleClientId: Volatile<string>
  googleClientSecret: Volatile<string>
  /** Legacy and optional: Google ignores the developer token since 2026-09-09. */
  adsDeveloperToken: Volatile<string>
  adsLoginCustomerId: Volatile<string>
  adsCustomerId: Volatile<string>
  adsApiVersion: Volatile<string>
  researchCacheDays: Volatile<number>
  answerWaitHours: Volatile<number>
  /** Directory for the state file; empty uses `<DSH home>/seo-employee`. */
  dataDir: string
  /** Absolute origin of this harness, for the OAuth redirect and unpublish links. */
  publicBaseUrl: string
  /** Route prefix. */
  path: string
  /** Shared secret for the CLI command route; empty leaves it unmounted. */
  token: string
  workspacePath: string
  agentPreset: string
  permissionPreset: string
  /** The shift's opening message; `{skill}` becomes the skill file's path. */
  shiftPrompt: string
  timeoutMs: number
  /** How often owner answers are collected from WhatsApp. */
  answerCheckMs: number
  whatsappUrl: string
  whatsappToken: string
  /** MCP server name of the browser whose Google account Klipara downloads with; shifts may not use it. */
  forbiddenBrowser: string
}

/** Composition config. */
export const Config = z.object({
  enabled: z.boolean().default(false).volatile(),
  shiftTime: z.string().default('10:00').volatile(),
  timeZone: z.string().default('Africa/Lagos').volatile(),
  notifyTo: z.string().default('').volatile(),
  provider: z.string().default('').volatile(),
  model: z.string().default('').volatile(),
  fallbackProvider: z.string().default('opencode').volatile(),
  fallbackModel: z.string().default('big-pickle').volatile(),
  fallbackCooldownMinutes: z.natural().default(15).volatile(),
  editorProvider: z.string().default('').volatile(),
  editorModel: z.string().default('').volatile(),
  googleServiceAccountKey: z.string().role('secret').default('').volatile(),
  googleClientId: z.string().default('').volatile(),
  googleClientSecret: z.string().role('secret').default('').volatile(),
  adsDeveloperToken: z.string().role('secret').default('').volatile(),
  adsLoginCustomerId: z.string().default('').volatile(),
  adsCustomerId: z.string().default('').volatile(),
  adsApiVersion: z.string().default('v25').volatile(),
  researchCacheDays: z.natural().min(1).default(30).volatile(),
  answerWaitHours: z.natural().default(48).volatile(),
  dataDir: z.string().default(''),
  publicBaseUrl: z.string().default(''),
  path: z.string().default('/seo'),
  token: z.string().default(''),
  workspacePath: z.string().default('/workspace/seo-employee'),
  agentPreset: z.string().default('standard'),
  permissionPreset: z.string().default('workspace-write'),
  shiftPrompt: z.string().default('Run today\'s SEO employee shift. Your instructions are the seo-employee skill at {skill}: read that file first, then follow it exactly.'),
  timeoutMs: z.natural().min(1000).default(60_000),
  answerCheckMs: z.natural().min(60_000).default(15 * 60_000),
  whatsappUrl: z.string().default(''),
  whatsappToken: z.string().default(''),
  forbiddenBrowser: z.string().default('deerflow'),
})

const SITE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/u
/** How long a started Google sign-in may take. */
const OAUTH_FLOW_MS = 15 * 60_000

/**
 * Whether an agent drives one of the employee's Sessions.
 * @param agent - the agent.
 * @returns true for a Session this plugin started.
 */
function isSession(agent: Agent): boolean {
  return String(agent.session.id).startsWith(SESSION_PREFIX)
}

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

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

function html(value: string): string {
  return value.replace(/[&<>"']/gu, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[c] ?? c)
}

/**
 * A small page for the owner's browser: the OAuth result and the unpublish confirmation.
 * @param title - the heading.
 * @param body - HTML below it.
 * @param head - extra head markup.
 * @returns the document.
 */
function page(title: string, body: string, head = ''): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${html(title)}</title>${head}
<style>:root{color-scheme:light dark;--bg:#fafafa;--fg:#111;--muted:#666;--accent:#b4232c}@media (prefers-color-scheme:dark){:root{--bg:#111;--fg:#eee;--muted:#aaa}}
body{margin:0;padding:24px 16px;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}main{max-width:560px;margin:0 auto}p{color:var(--muted)}
button{font:inherit;padding:10px 18px;border:0;border-radius:6px;background:var(--accent);color:#fff;cursor:pointer}a{color:inherit}</style></head>
<body><main><h1>${html(title)}</h1>${body}</main></body></html>`
}

/**
 * Validate a site the owner saved on the SEO sites page.
 * @param input - the posted site.
 * @param existing - the stored site with the same id, if any.
 * @param now - ISO time.
 * @returns the site, or the reason it is refused.
 */
export function parseSite(input: unknown, existing: Site | undefined, now: string): Site | string {
  if (typeof input !== 'object' || input === null) return 'The site is not an object.'
  const r = input as Record<string, unknown>
  const text = (v: unknown): string => typeof v === 'string' ? v.trim() : ''
  const obj = (v: unknown): Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {}
  const name = text(r['name'])
  if (name === '') return 'Give the site a name.'
  const id = text(r['id']) || name.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 40)
  if (!SITE_ID.test(id)) return 'The site id must be lowercase letters, digits and hyphens.'
  let baseUrl: string
  try {
    const url = new URL(text(r['baseUrl']))
    if (url.protocol !== 'https:') return 'The site address must start with https://.'
    baseUrl = url.origin
  } catch {
    return 'The site address is not a URL.'
  }
  const kind = r['kind']
  if (kind !== 'klipara' && kind !== 'wordpress') return 'Choose how articles are published: klipara or wordpress.'
  const profile = obj(r['profile'])
  const cta = obj(profile['cta'])
  const markets: Market[] = Array.isArray(r['markets'])
    ? r['markets'].flatMap((m: unknown) => {
      const o = obj(m)
      const label = text(o['label'])
      return label === '' ? [] : [{ label, geoId: text(o['geoId']).replace(/\D/gu, ''), languageId: text(o['languageId']).replace(/\D/gu, '') }]
    })
    : []
  const author = obj(r['author'])
  const google = obj(r['google'])
  const perWeek = typeof r['articlesPerWeek'] === 'number' ? Math.floor(r['articlesPerWeek']) : 2
  if (perWeek < 0 || perWeek > 7) return 'Articles per week must be 0 to 7.'
  const site: Site = {
    id,
    name,
    baseUrl,
    kind: kind satisfies PublisherKind,
    enabled: r['enabled'] !== false,
    profile: {
      business: text(profile['business']),
      audience: text(profile['audience']),
      offer: text(profile['offer']),
      voice: text(profile['voice']),
      cta: { text: text(cta['text']), url: text(cta['url']) },
    },
    markets,
    seeds: Array.isArray(r['seeds']) ? r['seeds'].map(text).filter(s => s !== '').slice(0, 30) : [],
    gscProperty: text(r['gscProperty']),
    articlesPerWeek: perWeek,
    author: { name: text(author['name']), url: text(author['url']), bio: text(author['bio']) },
    google: {
      access: google['access'] === 'own' ? 'own' : 'shared',
      adsCustomerId: text(google['adsCustomerId']).replace(/\D/gu, ''),
      adsLoginCustomerId: text(google['adsLoginCustomerId']).replace(/\D/gu, ''),
    } satisfies SiteGoogle,
    createdAt: existing?.createdAt ?? now,
  }
  if (site.profile.business === '' || site.profile.audience === '' || site.profile.offer === '') return 'Fill in the business, readers and offer: the writer works from them.'
  if (site.author.name === '') return 'Give the author name articles are published under.'
  return site
}

/**
 * Mount the SEO employee: its store, the owner's routes, the tools on its
 * shift Sessions, the CLI command route, and the daily timer.
 * @param ctx - the plugin context.
 * @param config - validated composition config.
 */
export function apply(ctx: Context, config: Config): void {
  const dataDir = config.dataDir !== '' ? config.dataDir : join(process.env['DSH_HOME'] ?? join(homedir(), '.dsh'), 'seo-employee')
  const store = new SeoStore(join(dataDir, 'state.json'))
  const prefix = config.path.replace(/\/+$/u, '')
  const publicBase = config.publicBaseUrl.replace(/\/+$/u, '')
  const redirectUri = `${publicBase}${prefix}/oauth/callback`
  const route = { url: config.whatsappUrl, token: config.whatsappToken, to: () => config.notifyTo.get() }
  const notify = whatsAppNotifier(route)
  const readWhatsApp = whatsAppReader(route)
  // Signs the owner's unpublish links with a key kept in the state file.
  let linkKey = ''
  void store.update((s) => {
    s.linkKey ??= randomBytes(32).toString('hex')
    return s.linkKey
  }).then((key) => { linkKey = key }, (error: unknown) => {
    process.stderr.write(`seo-employee: the state file could not be read: ${error instanceof Error ? error.message : String(error)}\n`)
  })
  const sign = (articleId: string): string => createHmac('sha256', linkKey).update(articleId).digest('hex').slice(0, 32)
  /** The sign-in link the owner sends a site's owner. */
  const connectLink = (siteId: string): string => `${publicBase}${prefix}/connect/${encodeURIComponent(siteId)}?sig=${sign(`connect:${siteId}`)}`

  let refreshToken = ''
  void store.read().then((s) => { refreshToken = s.google?.refreshToken ?? '' }, () => undefined)
  const tokens = new GoogleTokens(fetch, () => ({
    clientId: config.googleClientId.get().trim(), clientSecret: config.googleClientSecret.get().trim(), refreshToken,
  }))
  // A service account, when its key is saved, replaces the OAuth sign-in: no consent screen, nothing to expire.
  const serviceAccount = (): ServiceAccountKey | string | undefined => {
    const raw = config.googleServiceAccountKey.get().trim()
    return raw === '' ? undefined : parseServiceAccountKey(raw)
  }
  const accountTokens = new ServiceAccountTokens(fetch, () => {
    const key = serviceAccount()
    if (key === undefined || typeof key === 'string') throw new Error(key ?? 'No service account key is saved.')
    return key
  })
  /** The employee's own Google access: its service account, or the owner's sign-in on the settings page. */
  const sharedToken = async (signal: AbortSignal): Promise<string> => {
    const key = serviceAccount()
    if (typeof key === 'string') throw new Error(`The Google service account key on the SEO employee page is unusable: ${key}`)
    if (key !== undefined) return accountTokens.accessToken(signal)
    if (config.googleClientId.get().trim() === '' || config.googleClientSecret.get().trim() === '') {
      throw new Error('Google is not set up: the owner enters a service account key, or an OAuth client id and secret, on the SEO employee page.')
    }
    if (refreshToken === '') refreshToken = (await store.read()).google?.refreshToken ?? ''
    if (refreshToken === '') throw new Error('Google is not connected: the owner presses Connect Google on the SEO employee page.')
    return tokens.accessToken(signal)
  }
  // Sites whose owners connected their own Google account: one token cache per site, refreshed from that site's sign-in.
  const siteTokens = new Map<string, { refreshToken: string; tokens: GoogleTokens }>()
  const ownToken = async (signal: AbortSignal, site: Site): Promise<string> => {
    const connection = (await store.read()).siteGoogle[site.id]
    if (connection === undefined) {
      throw new Error(`${site.name} uses its owner's own Google sign-in, which is not connected yet: send them the sign-in link from the SEO sites page.`)
    }
    let entry = siteTokens.get(site.id)
    if (entry?.refreshToken !== connection.refreshToken) {
      const token = connection.refreshToken
      entry = {
        refreshToken: token,
        tokens: new GoogleTokens(fetch, () => ({
          clientId: config.googleClientId.get().trim(), clientSecret: config.googleClientSecret.get().trim(), refreshToken: token,
        })),
      }
      siteTokens.set(site.id, entry)
    }
    return entry.tokens.accessToken(signal)
  }
  const googleToken = (signal: AbortSignal, site?: Site): Promise<string> =>
    site?.google?.access === 'own' ? ownToken(signal, site) : sharedToken(signal)
  const editorRoute = (): { provider: string; model: string } => {
    const provider = config.editorProvider.get().trim()
    const model = config.editorModel.get().trim()
    if (provider !== '' && model !== '') return { provider, model }
    if (config.provider.get().trim() !== '' && config.model.get().trim() !== '') return { provider: config.provider.get().trim(), model: config.model.get().trim() }
    const selected = ctx.agentDefaultModel.currentSelection()
    return { provider: selected.provider, model: selected.model }
  }
  // Ads accounts found for each sign-in when none is configured, rechecked hourly.
  const discovered = new Map<string, { at: number; customerId?: string; name?: string; error?: string }>()
  const deps: SeoDeps = {
    store,
    settings: {
      adsApiVersion: () => config.adsApiVersion.get().trim() || 'v25',
      researchCacheDays: () => config.researchCacheDays.get(),
      answerWaitHours: () => config.answerWaitHours.get(),
      serviceAccountEmail: () => {
        const key = serviceAccount()
        return key === undefined || typeof key === 'string' ? undefined : key.clientEmail
      },
    },
    fetch,
    now: () => new Date(),
    googleToken,
    adsAuth: async (site, signal) => {
      // A site's own Ads account (with its manager, if any) wins over the employee's; with neither set, the first active
      // account the site's sign-in reaches. The developer token is legacy and optional.
      const developerToken = config.adsDeveloperToken.get().trim()
      const base = {
        accessToken: (s: AbortSignal) => googleToken(s, site),
        ...developerToken === '' ? {} : { developerToken },
      }
      const own = site.google?.adsCustomerId.trim() ?? ''
      const configured = own !== '' ? own : config.adsCustomerId.get().trim()
      const login = own !== '' ? site.google?.adsLoginCustomerId.trim() ?? '' : config.adsLoginCustomerId.get().trim()
      if (configured !== '') return { ...base, customerId: configured, ...login === '' ? {} : { loginCustomerId: login } }
      const identity = site.google?.access === 'own' ? `site:${site.id}` : 'shared'
      const known = discovered.get(identity)
      if (known !== undefined && Date.now() - known.at < 3_600_000) {
        return known.customerId === undefined ? undefined : { ...base, customerId: known.customerId, loginCustomerId: known.customerId }
      }
      const accounts = await accessibleAccounts(fetch, base, signal, config.adsApiVersion.get().trim() || 'v25')
      const chosen = accounts.find(a => a.status === 'ENABLED')
      discovered.set(identity, { at: Date.now(), ...chosen === undefined ? {} : { customerId: chosen.customerId, name: chosen.name } })
      return chosen === undefined ? undefined : { ...base, customerId: chosen.customerId, loginCustomerId: chosen.customerId }
    },
    publisher: async (site) => {
      const secrets: SiteSecrets = (await store.read()).secrets[site.id] ?? {}
      return createPublisher(fetch, site, () => secrets, config.timeoutMs)
    },
    editor: async (prompt, signal) => {
      const target = editorRoute()
      return { ...target, text: await askEditor(ctx.llm, target, prompt, signal) }
    },
    notify,
    readWhatsApp,
    unpublishLink: articleId => `${publicBase}${prefix}/unpublish/${encodeURIComponent(articleId)}?sig=${sign(articleId)}`,
    reportFailure: (stage, error) => {
      process.stderr.write(`seo-employee: ${stage} failed: ${error instanceof Error ? error.message : String(error)}\n`)
    },
  }
  const tools = buildSeoTools(deps)

  const resolveRoute = (provider: string, model: string): { provider: string; model: string } | undefined =>
    provider.trim() === '' || model.trim() === '' ? undefined : { provider: provider.trim(), model: model.trim() }
  const router = new FallbackRouter({
    fallback: () => resolveRoute(config.fallbackProvider.get(), config.fallbackModel.get()),
    shift: () => resolveRoute(config.provider.get(), config.model.get()),
    cooldownMs: () => config.fallbackCooldownMinutes.get() * 60_000,
    onSwitch: (change) => {
      process.stderr.write(`seo-employee: ${change.from.provider}/${change.from.model} failed (${change.failure.code}); shift turns use ${change.to.provider}/${change.to.model} until ${change.until.toISOString()}\n`)
    },
  })
  installFallback(ctx, router, isSession)

  // ----- The owner's routes -----

  /** The account discovery for the shared access, run at most hourly (every 5 minutes after a failure). */
  const sharedAds = async (): Promise<{ customerId?: string; name?: string; error?: string }> => {
    if (config.adsCustomerId.get().trim() !== '') return {}
    const known = discovered.get('shared')
    if (known !== undefined && Date.now() - known.at < (known.error === undefined ? 3_600_000 : 300_000)) return known
    try {
      const accounts = await accessibleAccounts(fetch, { accessToken: s => sharedToken(s) }, AbortSignal.timeout(30_000), config.adsApiVersion.get().trim() || 'v25')
      const chosen = accounts.find(a => a.status === 'ENABLED')
      const entry = { at: Date.now(), ...chosen === undefined ? {} : { customerId: chosen.customerId, name: chosen.name } }
      discovered.set('shared', entry)
      return entry
    } catch (error) {
      const entry = { at: Date.now(), error: error instanceof Error ? error.message : String(error) }
      discovered.set('shared', entry)
      return entry
    }
  }

  const statusOf = async (): Promise<unknown> => {
    const state = await store.read()
    const ads = await sharedAds()
    const now = new Date()
    return {
      redirectUri,
      google: {
        serviceAccount: (() => {
          const key = serviceAccount()
          if (key === undefined) return null
          return typeof key === 'string' ? { email: null, error: key } : { email: key.clientEmail, error: null }
        })(),
        clientSet: config.googleClientId.get().trim() !== '' && config.googleClientSecret.get().trim() !== '',
        clientSecretSet: config.googleClientSecret.get().trim() !== '',
        developerTokenSet: config.adsDeveloperToken.get().trim() !== '',
        adsSet: config.adsCustomerId.get().trim() !== '' || ads.customerId !== undefined,
        // The Ads account Keyword Planner runs in for sites on the shared access: typed, or found from the sign-in.
        adsAccount: config.adsCustomerId.get().trim() !== ''
          ? { source: 'configured', id: config.adsCustomerId.get().trim(), name: '', error: null }
          : { source: ads.customerId === undefined ? (ads.error === undefined ? 'none' : 'error') : 'found', id: ads.customerId ?? null, name: ads.name ?? '', error: ads.error ?? null },
        connected: state.google !== null,
        connectedAt: state.google?.connectedAt ?? null,
      },
      paused: state.paused,
      lastShiftDate: state.lastShiftDate,
      sites: state.sites.map(site => ({
        ...site,
        secretsSet: {
          apiKey: (state.secrets[site.id]?.apiKey ?? '') !== '',
          wpUser: (state.secrets[site.id]?.wpUser ?? '') !== '',
          wpAppPassword: (state.secrets[site.id]?.wpAppPassword ?? '') !== '',
        },
        thisWeek: publishedThisWeek(state, site.id, now),
        googleConnection: site.google?.access === 'own'
          ? {
            connected: state.siteGoogle[site.id] !== undefined,
            connectedAt: state.siteGoogle[site.id]?.connectedAt ?? null,
            connectLink: connectLink(site.id),
          }
          : null,
      })),
      questions: state.questions
        .filter(q => q.answer === undefined || Date.parse(q.answeredAt ?? q.askedAt) > now.getTime() - 14 * 86_400_000)
        .map(q => ({ ...q, keyword: state.topics.find(t => t.id === q.topicId)?.keyword ?? '' })),
      topics: state.topics.slice(-200).reverse(),
      drafts: state.drafts.map(d => ({
        id: d.id, siteId: d.siteId, topicId: d.topicId, title: d.draft.title, submittedAt: d.submittedAt, editor: d.editor ?? null,
      })),
      articles: [...state.articles].reverse().map(a => ({ ...a, unpublishUrl: deps.unpublishLink(a.id) })),
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${prefix}/status`,
    handler: async (_req: IncomingMessage, res: ServerResponse) => { json(res, 200, await statusOf()) },
  }), `seo-employee: ${prefix}/status`)

  // Owner actions from the SEO sites page, one POST route with an `action`.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${prefix}/action`,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'POST') { json(res, 405, { error: 'POST only' }); return }
      const raw = await readBody(req, 256 * 1024)
      if (raw === undefined) { json(res, 413, { error: 'too large' }); return }
      let body: Record<string, unknown>
      try {
        body = JSON.parse(raw) as Record<string, unknown>
      } catch {
        json(res, 400, { error: 'not JSON' })
        return
      }
      const now = new Date().toISOString()
      try {
        switch (body['action']) {
          case 'save-site': {
            const result = await store.update((s) => {
              const input = body['site'] as Record<string, unknown> | undefined
              const existing = s.sites.find(x => x.id === (typeof input?.['id'] === 'string' ? input['id'] : ''))
              const site = parseSite(input, existing, now)
              if (typeof site === 'string') return site
              if (existing === undefined && s.sites.some(x => x.id === site.id)) return `A site with id ${site.id} exists.`
              s.sites = [...s.sites.filter(x => x.id !== site.id), site]
              // Blank secret fields keep what is stored; secrets are never sent back.
              const posted = typeof body['secrets'] === 'object' && body['secrets'] !== null ? body['secrets'] as Record<string, unknown> : {}
              const current = s.secrets[site.id] ?? {}
              for (const key of ['apiKey', 'wpUser', 'wpAppPassword'] as const) {
                const value = typeof posted[key] === 'string' ? posted[key].trim() : ''
                if (value !== '') current[key] = value
              }
              s.secrets[site.id] = current
              return site
            })
            if (typeof result === 'string') { json(res, 422, { error: result }); return }
            json(res, 200, { ok: true, site: result })
            return
          }
          case 'delete-site': {
            const id = (typeof body['id'] === 'string' ? body['id'] : '')
            await store.update((s) => {
              s.sites = s.sites.filter(x => x.id !== id)
              const { [id]: _removed, ...rest } = s.secrets
              s.secrets = rest
            })
            json(res, 200, { ok: true })
            return
          }
          case 'probe-site': {
            const baseUrl = (typeof body['baseUrl'] === 'string' ? body['baseUrl'] : '')
            const site = (await store.read()).sites.find(x => x.id === body['id'])
            if (body['kind'] === 'wordpress') {
              const probe = await probeWordPress(fetch, baseUrl, AbortSignal.timeout(20_000))
              // A saved site with credentials also proves the application password can read drafts.
              const secrets = site === undefined ? {} : (await store.read()).secrets[site.id] ?? {}
              if (site === undefined || !probe.isWordPress || (secrets.wpUser ?? '') === '' || (secrets.wpAppPassword ?? '') === '') {
                json(res, 200, probe)
                return
              }
              const articles = await (await deps.publisher(site)).list(AbortSignal.timeout(20_000))
              json(res, 200, { ...probe, ok: true, articles: articles.length })
              return
            }
            if (site === undefined) { json(res, 422, { error: 'Save the site first, then test it.' }); return }
            const articles = await (await deps.publisher(site)).list(AbortSignal.timeout(20_000))
            json(res, 200, { ok: true, articles: articles.length })
            return
          }
          case 'gsc-sites': {
            // With a site id, the properties that site's Google access can see (its owner's sign-in, or the shared access).
            const id = typeof body['id'] === 'string' ? body['id'] : ''
            const state = await store.read()
            const draft = parseSite(body['site'], state.sites.find(x => x.id === id), now)
            const site = typeof draft === 'string' ? state.sites.find(x => x.id === id) : { ...draft, id: id || draft.id }
            const token = await googleToken(AbortSignal.timeout(20_000), site)
            json(res, 200, { sites: await listSites(fetch, token, AbortSignal.timeout(20_000)) })
            return
          }
          case 'disconnect-site-google': {
            const id = typeof body['id'] === 'string' ? body['id'] : ''
            await store.update((s) => {
              const { [id]: _removed, ...rest } = s.siteGoogle
              s.siteGoogle = rest
            })
            siteTokens.delete(id)
            json(res, 200, { ok: true })
            return
          }
          case 'answer': {
            const tag = (typeof body['tag'] === 'string' ? body['tag'] : '')
            const answer = (typeof body['answer'] === 'string' ? body['answer'] : '').trim()
            if (answer === '') { json(res, 422, { error: 'Write an answer.' }); return }
            const found = await store.update((s) => {
              const q = s.questions.find(x => x.tag === tag)
              if (q === undefined) return false
              q.answer = answer
              q.answeredAt = now
              return true
            })
            if (!found) { json(res, 404, { error: 'No such question.' }); return }
            void wakeForAnswers()
            json(res, 200, { ok: true })
            return
          }
          case 'disconnect-google': {
            await store.update((s) => { s.google = null })
            refreshToken = ''
            tokens.clear()
            json(res, 200, { ok: true })
            return
          }
          case 'resume': {
            await store.update((s) => { s.paused = null })
            json(res, 200, { ok: true })
            return
          }
          case 'pause': {
            await store.update((s) => { s.paused = { reason: 'paused by the owner', at: now } })
            json(res, 200, { ok: true })
            return
          }
          default:
            json(res, 400, { error: 'unknown action' })
        }
      } catch (error) {
        // 422, not 502: a proxy in front of the harness may replace a 502's body, and the owner needs Google's own reason.
        json(res, 422, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), `seo-employee: ${prefix}/action`)

  /** Start a Google sign-in: for the employee's own access, or for one site whose owner connects their own account. */
  const beginOAuth = async (res: ServerResponse, siteId: string | undefined): Promise<void> => {
    const clientId = config.googleClientId.get().trim()
    if (clientId === '' || config.googleClientSecret.get().trim() === '' || publicBase === '') {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(page('Google sign-in is not set up', '<p>The OAuth client id and secret are not saved on the SEO employee page yet.</p>'))
      return
    }
    const state = randomState()
    const { verifier, challenge } = pkcePair()
    await store.update((s) => {
      const fresh = s.oauthFlows.filter(f => Date.now() - Date.parse(f.at) < OAUTH_FLOW_MS)
      s.oauthFlows = [...fresh.slice(-19), { state, verifier, at: new Date().toISOString(), ...siteId === undefined ? {} : { siteId } }]
    })
    res.writeHead(302, { Location: authorizationUrl({ clientId, redirectUri, state, codeChallenge: challenge }) })
    res.end()
  }

  // The owner's own sign-in, or (with ?site=) connecting one site from the signed-in settings page.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${prefix}/oauth/start`,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      const siteId = new URL(req.url ?? '/', 'http://x').searchParams.get('site') ?? ''
      if (siteId !== '' && !(await store.read()).sites.some(x => x.id === siteId)) { json(res, 404, { error: 'no such site' }); return }
      await beginOAuth(res, siteId === '' ? undefined : siteId)
    },
  }), `seo-employee: ${prefix}/oauth/start`)

  // The link the owner sends a site's owner: signed per site, usable without a harness login.
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: `${prefix}/connect`,
    authenticate: false,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://x')
      const siteId = decodeURIComponent(url.pathname.slice(`${prefix}/connect/`.length))
      const sig = url.searchParams.get('sig') ?? ''
      const expected = linkKey === '' ? '' : sign(`connect:${siteId}`)
      const site = (await store.read()).sites.find(x => x.id === siteId)
      if (expected === '' || site === undefined || site.google?.access !== 'own' || sig.length !== expected.length
        || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex' })
        res.end(page('Not found', '<p>This link is not valid. Ask for a new one.</p>'))
        return
      }
      if (req.method !== 'POST') {
        // A button, not a redirect: a link preview must not start a sign-in.
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' })
        res.end(page(`Connect ${site.name} to Google`, `<p>This lets the SEO assistant for <strong>${html(site.name)}</strong> (${html(site.baseUrl)}) read the site's Google Search Console data, submit its sitemap, and look up keyword ideas in Google Ads. It cannot spend money, change campaigns or see anything else in your Google account, and you can remove its access at any time at myaccount.google.com/permissions.</p>
<form method="post"><button type="submit">Continue to Google</button></form>`))
        return
      }
      await beginOAuth(res, site.id)
    },
  }), `seo-employee: ${prefix}/connect`)

  // Google returns here. Not behind the harness login: a site owner signing in has no harness account. The single-use state
  // and its PKCE verifier tie the answer to a flow this harness started.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${prefix}/oauth/callback`,
    authenticate: false,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://x')
      const answer = (status: number, title: string, body: string, head = ''): void => {
        res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' })
        res.end(page(title, body, head))
      }
      const stateParam = url.searchParams.get('state') ?? ''
      const flow = await store.update((s) => {
        const found = s.oauthFlows.find(f => f.state === stateParam && Date.now() - Date.parse(f.at) < OAUTH_FLOW_MS)
        s.oauthFlows = s.oauthFlows.filter(f => f.state !== stateParam)
        return found
      })
      if (url.searchParams.get('error') !== null) { answer(400, 'Not connected', `<p>Google said: ${html(url.searchParams.get('error') ?? '')}.</p>`); return }
      if (stateParam === '' || flow === undefined) {
        answer(400, 'Not connected', '<p>This sign-in has expired. Start again from the link you were given.</p>')
        return
      }
      try {
        const grant = await exchangeCode(fetch, {
          clientId: config.googleClientId.get().trim(), clientSecret: config.googleClientSecret.get().trim(),
          code: url.searchParams.get('code') ?? '', redirectUri, codeVerifier: flow.verifier,
        }, AbortSignal.timeout(20_000))
        const connection = { refreshToken: grant.refreshToken, scope: grant.scope, connectedAt: new Date().toISOString() }
        if (flow.siteId !== undefined) {
          const siteId = flow.siteId
          const name = await store.update((s) => {
            s.siteGoogle[siteId] = connection
            return s.sites.find(x => x.id === siteId)?.name ?? siteId
          })
          siteTokens.delete(siteId)
          void notify(`SEO employee: Google is now connected for ${name}, by the site owner's own sign-in.`)
          answer(200, 'Connected', `<p>Thank you. ${html(name)} is connected to Google. You can close this tab.</p>`, '<script>window.close()</script>')
          return
        }
        await store.update((s) => { s.google = connection })
        refreshToken = grant.refreshToken
        tokens.clear()
        // The settings page opens this flow in a popup: close it, and the page re-reads the status on focus.
        // A popup that cannot close itself (or a tab) goes back to the harness instead.
        answer(200, 'Google connected', '<p>Search Console and Keyword Planner are connected. Taking you back to the harness…</p><p><a href="/">Back to the harness</a></p>',
          '<meta http-equiv="refresh" content="3;url=/"><script>window.close()</script>')
      } catch (error) {
        answer(502, 'Not connected', `<p>${html(error instanceof Error ? error.message : String(error))}</p>`)
      }
    },
  }), `seo-employee: ${prefix}/oauth/callback`)

  // The owner's one-tap unpublish link from WhatsApp. GET only shows a button:
  // link previews fetch URLs, and a preview must not unpublish anything.
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: `${prefix}/unpublish`,
    authenticate: false,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://x')
      const articleId = decodeURIComponent(url.pathname.slice(`${prefix}/unpublish/`.length))
      const sig = url.searchParams.get('sig') ?? ''
      const expected = sign(articleId)
      const send = (status: number, title: string, body: string): void => {
        res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' })
        res.end(page(title, body))
      }
      if (linkKey === '' || sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
        send(404, 'Not found', '')
        return
      }
      const state = await store.read()
      const article = state.articles.find(a => a.id === articleId)
      if (article === undefined) { send(404, 'Not found', ''); return }
      if (article.unpublishedAt !== undefined) { send(200, 'Already unpublished', `<p>"${html(article.title)}" was unpublished ${html(article.unpublishedAt)}.</p>`); return }
      if (req.method !== 'POST') {
        send(200, 'Unpublish this article?', `<p>"${html(article.title)}"<br><a href="${html(article.url)}">${html(article.url)}</a></p>
<form method="post"><button type="submit">Unpublish</button></form><p>It goes back to draft on the site; nothing is deleted.</p>`)
        return
      }
      const site = state.sites.find(s => s.id === article.siteId)
      if (site === undefined) { send(410, 'Site removed', '<p>The site this article belongs to is no longer set up.</p>'); return }
      try {
        await (await deps.publisher(site)).unpublish(article.remoteId, AbortSignal.timeout(30_000))
        await store.update((s) => {
          const a = s.articles.find(x => x.id === articleId)
          if (a !== undefined) a.unpublishedAt = new Date().toISOString()
        })
        send(200, 'Unpublished', `<p>"${html(article.title)}" is back to draft on ${html(site.name)}.</p>`)
      } catch (error) {
        send(502, 'Could not unpublish', `<p>${html(error instanceof Error ? error.message : String(error))}</p>`)
      }
    },
  }), `seo-employee: ${prefix}/unpublish`)

  if (config.token !== '') {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: `${prefix}/command`,
      authenticate: false,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        const header = req.headers.authorization ?? ''
        const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
        const a = createHmac('sha256', 'cmp').update(presented).digest()
        const b = createHmac('sha256', 'cmp').update(config.token).digest()
        if (!timingSafeEqual(a, b)) { res.writeHead(404); res.end(); return }
        if (req.method === 'GET') { json(res, 200, { tools: tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters })) }); return }
        const raw = await readBody(req, 512 * 1024)
        if (raw === undefined) { json(res, 413, { error: 'the command body is too large' }); return }
        let request: { name?: unknown; args?: unknown }
        try {
          request = JSON.parse(raw) as { name?: unknown; args?: unknown }
        } catch {
          json(res, 400, { error: 'the command body is not JSON' })
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
    }), `seo-employee: ${prefix}/command`)
  }

  // SEO Sessions never drive the DeerFlow browser: its Google account is the
  // one Klipara downloads YouTube videos with.
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    if (exec.agent !== undefined && isSession(exec.agent) && exec.name.startsWith(`mcp__${config.forbiddenBrowser}__`)) {
      return { kind: 'deny', reason: `SEO employee sessions may not use the ${config.forbiddenBrowser} browser. Use the web search and fetch tools.` }
    }
    return next()
  })

  // Tools only on the employee's Sessions.
  const installed = new Map<Agent, { dispose: () => Promise<void> }>()
  const install = (agent: Agent): void => {
    if (installed.has(agent) || !isSession(agent)) return
    installed.set(agent, agent.ctx.inject(['tools'], (scope) => {
      for (const definition of tools) scope.effect(() => scope.tools.register(definition), `seo-employee: ${definition.name}`)
    }))
  }
  for (const agent of ctx.agents.list()) install(agent)
  ctx.on('agent/created', ({ agent }) => { install(agent) })
  ctx.on('agent/disposed', ({ agent }) => {
    const fiber = installed.get(agent)
    installed.delete(agent)
    void fiber?.dispose().catch(() => undefined)
  })

  const skillPath = join(process.env['DSH_HOME'] ?? join(homedir(), '.dsh'), 'skills', 'seo-employee', 'SKILL.md')
  const start = async (title: string, prompt: string): Promise<string> => {
    await mkdir(config.workspacePath, { recursive: true })
    const sessionId = await startShift(ctx, {
      workspacePath: config.workspacePath,
      title,
      prompt,
      agentPreset: config.agentPreset,
      permissionPreset: config.permissionPreset,
      provider: config.provider.get(),
      model: config.model.get(),
      sessionPrefix: SESSION_PREFIX,
      source: summary => ({ kind: 'seo-employee', form: 'notice', summary }),
    }, AbortSignal.timeout(120_000))
    await store.update((s) => { s.lastShiftSession = sessionId })
    return sessionId
  }

  // The shift clock: checked every minute, at most one shift per local day; a
  // failed start is retried after half an hour.
  let starting = false
  let retryAt = 0
  const tick = async (): Promise<void> => {
    if (starting || !config.enabled.get() || Date.now() < retryAt) return
    const at = parseShiftTime(config.shiftTime.get())
    if (at === undefined) return
    const now = localTime(new Date(), config.timeZone.get())
    const state = await store.read()
    if (state.paused !== null || state.sites.every(s => !s.enabled) || !shiftDue(now, at, state.lastShiftDate)) return
    starting = true
    const previous = state.lastShiftDate
    try {
      await store.update((s) => { s.lastShiftDate = now.date })
      const sessionId = await start(`SEO employee shift ${now.date}`, config.shiftPrompt.replaceAll('{skill}', skillPath))
      process.stderr.write(`seo-employee: started the ${now.date} shift as session ${sessionId}\n`)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      await store.update((s) => { s.lastShiftDate = previous })
      retryAt = Date.now() + 30 * 60_000
      process.stderr.write(`seo-employee: the shift did not start: ${reason}\n`)
      void notify(`SEO employee: today's shift did not start (${reason.slice(0, 200)}). Retrying in 30 minutes.`)
    } finally {
      starting = false
    }
  }
  const timer = setInterval(() => { void tick() }, 60_000)
  ctx.effect(() => () => { clearInterval(timer) })

  // Owner answers: collected from WhatsApp every few minutes without a model
  // turn; when one lands for a topic still waiting, the latest shift is woken
  // (or a short session started) to write that article.
  let collecting = false
  const wakeForAnswers = async (): Promise<void> => {
    if (collecting || !config.enabled.get()) return
    collecting = true
    try {
      const before = await store.read()
      if (before.paused !== null) return
      const open = before.questions.filter(q => q.answer === undefined)
      if (open.length > 0 && config.whatsappUrl !== '') {
        const messages = await readWhatsApp(100).catch(() => [])
        await store.update((s) => {
          for (const q of s.questions) {
            if (q.answer !== undefined) continue
            const replies = messages
              .filter(m => m.ts >= Date.parse(q.askedAt) / 1000 && m.body.trim().toLowerCase().startsWith(q.tag))
              .sort((a, b) => a.ts - b.ts)
            if (replies.length === 0) continue
            q.answer = replies.map(m => m.body.trim().slice(q.tag.length).replace(/^[\s:,-]+/u, '')).join('\n')
            q.answeredAt = new Date((replies.at(-1)?.ts ?? 0) * 1000).toISOString()
          }
        })
      }
      const state = await store.read()
      const ready = state.questions.filter(q => q.answer !== undefined && state.topics.some(t => t.id === q.topicId && t.status === 'asked'))
      if (ready.length === 0) return
      const text = `The owner answered ${ready.map(q => `${q.tag} (topic ${q.topicId})`).join(', ')}. Call seo_check_answers, then write, review and publish those articles as the seo-employee skill says, within each site's weekly cap.`
      const shift = state.lastShiftSession === undefined ? undefined : ctx.agents.get(brandString<SessionId>(state.lastShiftSession))
      if (shift !== undefined) {
        shift.followup(createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'seo-employee', form: 'notice', summary: boundContextSummary('Owner answers arrived') },
        }))
      } else {
        await start(`SEO employee: owner answers ${new Date().toISOString().slice(0, 10)}`, `${text}\nYour instructions are the seo-employee skill at ${skillPath}.`)
      }
      // Mark them so the same answers do not wake another session.
      await store.update((s) => {
        for (const q of ready) {
          const t = s.topics.find(x => x.id === q.topicId)
          if (t !== undefined && t.status === 'asked') { t.status = 'planned'; t.updatedAt = new Date().toISOString() }
        }
      })
    } catch (error) {
      process.stderr.write(`seo-employee: answer check failed: ${error instanceof Error ? error.message : String(error)}\n`)
    } finally {
      collecting = false
    }
  }
  const answers = setInterval(() => { void wakeForAnswers() }, config.answerCheckMs)
  ctx.effect(() => () => { clearInterval(answers) })
}
