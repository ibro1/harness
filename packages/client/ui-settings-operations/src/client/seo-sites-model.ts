/**
 * The SEO employee's Host answers as the browser reads them, and the pure
 * helpers the settings card and the sites page share: reading `/seo/status`,
 * turning a site into an editable form and back into a `save-site` body, and
 * posting an owner action. The shapes are spelled here rather than imported:
 * a client package must not depend on a Host package.
 */

import { en } from './locales.ts'

/** Base path of the SEO employee's owner routes. */
export const SEO_PATH = '/seo'
/** The status route both the card and the sites page read. */
export const SEO_STATUS_PATH = `${SEO_PATH}/status`
/** The owner-action route. */
export const SEO_ACTION_PATH = `${SEO_PATH}/action`
/** Opens Google's consent screen and lands back on a small page. */
export const SEO_OAUTH_START_PATH = `${SEO_PATH}/oauth/start`

/** Same-origin HTTP, injectable for tests. */
export type SeoRequest = (url: string, init?: RequestInit) => Promise<Response>

/** Which connector publishes a site's articles. */
export type SeoPublisherKind = 'klipara' | 'wordpress'

/** One market a site is researched for. */
export interface SeoMarket {
  label: string
  /** Google Ads geo target id; empty means worldwide. */
  geoId: string
  /** Google Ads language id; empty means all languages. */
  languageId: string
}

/** A site as `/seo/status` reports it; never its credentials. */
export interface SeoSite {
  id: string
  name: string
  baseUrl: string
  kind: SeoPublisherKind
  enabled: boolean
  profile: { business: string; audience: string; offer: string; voice: string; cta: { text: string; url: string } }
  markets: SeoMarket[]
  seeds: string[]
  gscProperty: string
  articlesPerWeek: number
  author: { name: string; url: string; bio: string }
  createdAt: string
  /** Which credentials the Host holds for the site. */
  secretsSet: { apiKey: boolean; wpUser: boolean; wpAppPassword: boolean }
  /** Articles published this ISO week. */
  thisWeek: number
  /** Colours and fonts for the site's graphics; empty fields are read from the site's own stylesheets. */
  brand: { accent: string; paper: string; ink: string; displayFont: string; bodyFont: string }
  /** How the site reaches Google; sites saved before per-site access use the shared access. */
  google: { access: SeoGoogleAccess; adsCustomerId: string; adsLoginCustomerId: string }
  /** For a site on its owner's own sign-in: whether it is connected, and the link to send them. Null on the shared access. */
  googleConnection: { connected: boolean; connectedAt: string | null; connectLink: string } | null
}

/** `shared`: the employee's own Google access. `own`: the site owner's sign-in. */
export type SeoGoogleAccess = 'shared' | 'own'

/** Questions the employee asked the owner about one topic. */
export interface SeoQuestion {
  tag: string
  siteId: string
  topicId: string
  questions: string[]
  askedAt: string
  answer?: string
  answeredAt?: string
  keyword: string
}

/** One topic on the content map. */
export interface SeoTopic {
  id: string
  siteId: string
  keyword: string
  status: string
  /** `new`, or the URL of the article it refreshes. */
  target: string
  why: string
  reason?: string
}

/** The editor model's recorded verdict on a draft. */
export interface SeoEditorVerdict {
  total: number
  pass: boolean
  mustFix: string[]
}

/** A draft waiting for review or publication. */
export interface SeoDraft {
  id: string
  siteId: string
  topicId: string
  title: string
  submittedAt: string
  editor: SeoEditorVerdict | null
}

/** One Search Console reading of an article. */
export interface SeoMetric {
  at: string
  days: number
  clicks: number
  impressions: number
  position: number
}

/** A published article and how it is doing. */
export interface SeoArticle {
  id: string
  siteId: string
  keyword: string
  title: string
  url: string
  publishedAt: string
  editorTotal: number
  unpublishedAt?: string
  metrics: SeoMetric[]
  /** Signed link that takes the article down. */
  unpublishUrl: string
}

/** The Google connection as the Host reports it. */
export interface SeoGoogleStatus {
  /** Both the OAuth client id and secret are saved. */
  clientSet: boolean
  /** The Ads developer token and customer id are saved. */
  adsSet: boolean
  /** The Ads account Keyword Planner runs in for shared-access sites: typed, found from the sign-in, none, or a lookup error. */
  adsAccount: { source: 'configured' | 'found' | 'none' | 'error'; id: string | null; name: string; error: string | null; seen: string }
  /** The service account Google is reached as, when its key is saved; `error` says why a saved key is unusable. */
  serviceAccount: { email: string | null; error: string | null } | null
  /** The OAuth client secret is saved; never the secret itself. */
  clientSecretSet: boolean
  /** The Ads developer token is saved; never the token itself. */
  developerTokenSet: boolean
  connected: boolean
  connectedAt: string | null
}

/** The whole `/seo/status` answer. */
export interface SeoStatus {
  redirectUri: string
  google: SeoGoogleStatus
  paused: { reason: string; at: string } | null
  lastShiftDate: string | null
  sites: SeoSite[]
  questions: SeoQuestion[]
  topics: SeoTopic[]
  drafts: SeoDraft[]
  articles: SeoArticle[]
  /** Klipara samples the owner said may be featured in articles. */
  clipPermissions: SeoClipPermission[]
}

/** One sample the owner permitted, and why. */
export interface SeoClipPermission {
  sampleId: string
  basis: 'own' | 'cc' | 'permission'
  note: string
  credit: string
  at: string
}

/** The markets the site form offers, keyed for the locale dictionary. */
export const SEO_MARKETS = [
  { key: 'ng', geoId: '2566', languageId: '1000' },
  { key: 'gh', geoId: '2288', languageId: '1000' },
  { key: 'ke', geoId: '2404', languageId: '1000' },
  { key: 'za', geoId: '2710', languageId: '1000' },
  { key: 'us', geoId: '2840', languageId: '1000' },
  { key: 'uk', geoId: '2826', languageId: '1000' },
  { key: 'world', geoId: '', languageId: '1000' },
  { key: 'ha', geoId: '2566', languageId: '' },
] as const

/** A market the form offers. */
export type SeoMarketKey = typeof SEO_MARKETS[number]['key']

/** The site form's editable values; every text exactly as typed. */
export interface SeoSiteForm {
  /** Empty for a new site: the Host derives the id from the name. */
  id: string
  name: string
  baseUrl: string
  kind: SeoPublisherKind
  enabled: boolean
  business: string
  audience: string
  offer: string
  voice: string
  ctaText: string
  ctaUrl: string
  markets: SeoMarketKey[]
  /** Markets saved by other means that the checkboxes do not offer; kept on save. */
  otherMarkets: SeoMarket[]
  seeds: string
  gscProperty: string
  articlesPerWeek: string
  authorName: string
  authorUrl: string
  authorBio: string
  brandAccent: string
  brandPaper: string
  brandInk: string
  brandDisplayFont: string
  brandBodyFont: string
  googleAccess: SeoGoogleAccess
  /** The site's own Google Ads account and its manager; empty uses the employee's account. */
  adsCustomerId: string
  adsLoginCustomerId: string
  /** Write-only credentials: blank keeps what the Host holds. */
  apiKey: string
  wpUser: string
  wpAppPassword: string
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
const str = (value: unknown): string => typeof value === 'string' ? value : ''
const num = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : []
const optional = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined

/**
 * Read a `/seo/status` answer, filling what an older or partial Host leaves out.
 * @param raw - the parsed JSON body.
 * @returns the status the card and page render.
 */
export function parseSeoStatus(raw: unknown): SeoStatus {
  const body = record(raw)
  const google = record(body['google'])
  const paused = body['paused'] === null || body['paused'] === undefined ? null : record(body['paused'])
  return {
    redirectUri: str(body['redirectUri']),
    google: {
      clientSet: google['clientSet'] === true,
      adsSet: google['adsSet'] === true,
      serviceAccount: google['serviceAccount'] === null || google['serviceAccount'] === undefined ? null : {
        email: typeof record(google['serviceAccount'])['email'] === 'string' ? str(record(google['serviceAccount'])['email']) : null,
        error: typeof record(google['serviceAccount'])['error'] === 'string' ? str(record(google['serviceAccount'])['error']) : null,
      },
      adsAccount: (() => {
        const ads = record(google['adsAccount'])
        const source = ads['source']
        return {
          source: source === 'configured' || source === 'found' || source === 'error' ? source : 'none',
          id: typeof ads['id'] === 'string' ? ads['id'] : null,
          name: str(ads['name']),
          error: typeof ads['error'] === 'string' ? ads['error'] : null,
          seen: str(ads['seen']),
        }
      })(),
      clientSecretSet: google['clientSecretSet'] === true,
      developerTokenSet: google['developerTokenSet'] === true,
      connected: google['connected'] === true,
      connectedAt: typeof google['connectedAt'] === 'string' ? google['connectedAt'] : null,
    },
    paused: paused === null ? null : { reason: str(paused['reason']), at: str(paused['at']) },
    lastShiftDate: typeof body['lastShiftDate'] === 'string' ? body['lastShiftDate'] : null,
    sites: list(body['sites']).map((value) => {
      const site = record(value)
      const profile = record(site['profile'])
      const cta = record(profile['cta'])
      const author = record(site['author'])
      const secrets = record(site['secretsSet'])
      return {
        id: str(site['id']),
        name: str(site['name']),
        baseUrl: str(site['baseUrl']),
        kind: site['kind'] === 'wordpress' ? 'wordpress' : 'klipara',
        enabled: site['enabled'] !== false,
        profile: {
          business: str(profile['business']), audience: str(profile['audience']), offer: str(profile['offer']), voice: str(profile['voice']),
          cta: { text: str(cta['text']), url: str(cta['url']) },
        },
        markets: list(site['markets']).map((m) => {
          const market = record(m)
          return { label: str(market['label']), geoId: str(market['geoId']), languageId: str(market['languageId']) }
        }),
        seeds: list(site['seeds']).map(str).filter(seed => seed !== ''),
        gscProperty: str(site['gscProperty']),
        articlesPerWeek: num(site['articlesPerWeek']),
        author: { name: str(author['name']), url: str(author['url']), bio: str(author['bio']) },
        createdAt: str(site['createdAt']),
        secretsSet: { apiKey: secrets['apiKey'] === true, wpUser: secrets['wpUser'] === true, wpAppPassword: secrets['wpAppPassword'] === true },
        thisWeek: num(site['thisWeek']),
        brand: (() => {
          const brand = record(site['brand'])
          return { accent: str(brand['accent']), paper: str(brand['paper']), ink: str(brand['ink']), displayFont: str(brand['displayFont']), bodyFont: str(brand['bodyFont']) }
        })(),
        google: (() => {
          const google = record(site['google'])
          return { access: google['access'] === 'own' ? 'own' : 'shared', adsCustomerId: str(google['adsCustomerId']), adsLoginCustomerId: str(google['adsLoginCustomerId']) }
        })() satisfies SeoSite['google'],
        googleConnection: (() => {
          if (site['googleConnection'] === null || site['googleConnection'] === undefined) return null
          const connection = record(site['googleConnection'])
          return {
            connected: connection['connected'] === true,
            connectedAt: typeof connection['connectedAt'] === 'string' ? connection['connectedAt'] : null,
            connectLink: str(connection['connectLink']),
          }
        })(),
      } satisfies SeoSite
    }),
    clipPermissions: list(body['clipPermissions']).map((value) => {
      const p = record(value)
      const basis = p['basis']
      return {
        sampleId: str(p['sampleId']), basis: basis === 'own' || basis === 'cc' ? basis : 'permission',
        note: str(p['note']), credit: str(p['credit']), at: str(p['at']),
      } satisfies SeoClipPermission
    }).filter(p => p.sampleId !== ''),
    questions: list(body['questions']).map((value) => {
      const q = record(value)
      const answer = optional(q['answer'])
      const answeredAt = optional(q['answeredAt'])
      return {
        tag: str(q['tag']), siteId: str(q['siteId']), topicId: str(q['topicId']),
        questions: list(q['questions']).map(str).filter(text => text !== ''),
        askedAt: str(q['askedAt']), keyword: str(q['keyword']),
        ...answer === undefined ? {} : { answer },
        ...answeredAt === undefined ? {} : { answeredAt },
      }
    }),
    topics: list(body['topics']).map((value) => {
      const topic = record(value)
      const reason = optional(topic['reason'])
      return {
        id: str(topic['id']), siteId: str(topic['siteId']), keyword: str(topic['keyword']), status: str(topic['status']),
        target: str(topic['target']), why: str(topic['why']),
        ...reason === undefined ? {} : { reason },
      }
    }),
    drafts: list(body['drafts']).map((value) => {
      const draft = record(value)
      const editor = draft['editor'] === null || draft['editor'] === undefined ? null : record(draft['editor'])
      return {
        id: str(draft['id']), siteId: str(draft['siteId']), topicId: str(draft['topicId']), title: str(draft['title']),
        submittedAt: str(draft['submittedAt']),
        editor: editor === null ? null : { total: num(editor['total']), pass: editor['pass'] === true, mustFix: list(editor['mustFix']).map(str) },
      }
    }),
    articles: list(body['articles']).map((value) => {
      const article = record(value)
      const unpublishedAt = optional(article['unpublishedAt'])
      return {
        id: str(article['id']), siteId: str(article['siteId']), keyword: str(article['keyword']), title: str(article['title']),
        url: str(article['url']), publishedAt: str(article['publishedAt']), editorTotal: num(article['editorTotal']),
        metrics: list(article['metrics']).map((m) => {
          const metric = record(m)
          return { at: str(metric['at']), days: num(metric['days']), clicks: num(metric['clicks']), impressions: num(metric['impressions']), position: num(metric['position']) }
        }),
        unpublishUrl: str(article['unpublishUrl']),
        ...unpublishedAt === undefined ? {} : { unpublishedAt },
      }
    }),
  }
}

/**
 * The form for a site not yet saved.
 * @returns blank fields with two articles a week and the site turned on.
 */
export function emptySiteForm(): SeoSiteForm {
  return {
    id: '', name: '', baseUrl: 'https://', kind: 'klipara', enabled: true,
    business: '', audience: '', offer: '', voice: '', ctaText: '', ctaUrl: '',
    markets: [], otherMarkets: [], seeds: '', gscProperty: '', articlesPerWeek: '2',
    authorName: '', authorUrl: '', authorBio: '', brandAccent: '', brandPaper: '', brandInk: '', brandDisplayFont: '', brandBodyFont: '', googleAccess: 'shared', adsCustomerId: '', adsLoginCustomerId: '',
    apiKey: '', wpUser: '', wpAppPassword: '',
  }
}

/**
 * The form for editing a saved site. Credentials start blank: they never reach the browser.
 * @param site - the site as the Host reports it.
 * @returns its editable values.
 */
export function siteFormFrom(site: SeoSite): SeoSiteForm {
  const markets: SeoMarketKey[] = []
  const otherMarkets: SeoMarket[] = []
  for (const market of site.markets) {
    const known = SEO_MARKETS.find(m => m.geoId === market.geoId && m.languageId === market.languageId)
    if (known === undefined) otherMarkets.push(market)
    else if (!markets.includes(known.key)) markets.push(known.key)
  }
  return {
    id: site.id, name: site.name, baseUrl: site.baseUrl, kind: site.kind, enabled: site.enabled,
    business: site.profile.business, audience: site.profile.audience, offer: site.profile.offer, voice: site.profile.voice,
    ctaText: site.profile.cta.text, ctaUrl: site.profile.cta.url,
    markets, otherMarkets,
    seeds: site.seeds.join('\n'), gscProperty: site.gscProperty, articlesPerWeek: String(site.articlesPerWeek),
    authorName: site.author.name, authorUrl: site.author.url, authorBio: site.author.bio,
    brandAccent: site.brand.accent, brandPaper: site.brand.paper, brandInk: site.brand.ink,
    brandDisplayFont: site.brand.displayFont, brandBodyFont: site.brand.bodyFont,
    googleAccess: site.google.access, adsCustomerId: site.google.adsCustomerId, adsLoginCustomerId: site.google.adsLoginCustomerId,
    apiKey: '', wpUser: '', wpAppPassword: '',
  }
}

/**
 * Articles per week as typed, when it is a whole number from 0 to 7.
 * @param text - the field's text.
 * @returns the number, or undefined when the Host would refuse it.
 */
export function parseArticlesPerWeek(text: string): number | undefined {
  const trimmed = text.trim()
  if (!/^\d+$/u.test(trimmed)) return undefined
  const value = Number(trimmed)
  return value <= 7 ? value : undefined
}

/** A `save-site` action body. */
export interface SeoSaveSiteBody {
  action: 'save-site'
  site: Record<string, unknown>
  /** Only the credentials typed for the site's publisher; blank ones are left out so the Host keeps them. */
  secrets: { apiKey?: string; wpUser?: string; wpAppPassword?: string }
}

/**
 * Build the `save-site` body for a form. Market labels are written in
 * English: they are data the writer reads, not page copy.
 * @param form - the form's values.
 * @returns the body, or undefined when articles per week is not 0 to 7.
 */
export function buildSaveSiteBody(form: SeoSiteForm): SeoSaveSiteBody | undefined {
  const articlesPerWeek = parseArticlesPerWeek(form.articlesPerWeek)
  if (articlesPerWeek === undefined) return undefined
  const markets: SeoMarket[] = [
    ...SEO_MARKETS.filter(m => form.markets.includes(m.key)).map(m => ({ label: en[`seoMarket.${m.key}`], geoId: m.geoId, languageId: m.languageId })),
    ...form.otherMarkets,
  ]
  const secrets: SeoSaveSiteBody['secrets'] = {}
  const put = (key: keyof SeoSaveSiteBody['secrets'], value: string): void => { if (value.trim() !== '') secrets[key] = value.trim() }
  if (form.kind === 'klipara') put('apiKey', form.apiKey)
  else { put('wpUser', form.wpUser); put('wpAppPassword', form.wpAppPassword) }
  return {
    action: 'save-site',
    site: {
      ...form.id === '' ? {} : { id: form.id },
      name: form.name.trim(),
      baseUrl: form.baseUrl.trim(),
      kind: form.kind,
      enabled: form.enabled,
      profile: {
        business: form.business.trim(), audience: form.audience.trim(), offer: form.offer.trim(), voice: form.voice.trim(),
        cta: { text: form.ctaText.trim(), url: form.ctaUrl.trim() },
      },
      markets,
      seeds: form.seeds.split('\n').map(line => line.trim()).filter(line => line !== ''),
      gscProperty: form.gscProperty.trim(),
      articlesPerWeek,
      author: { name: form.authorName.trim(), url: form.authorUrl.trim(), bio: form.authorBio.trim() },
      brand: {
        accent: form.brandAccent.trim(), paper: form.brandPaper.trim(), ink: form.brandInk.trim(),
        displayFont: form.brandDisplayFont.trim(), bodyFont: form.brandBodyFont.trim(),
      },
      google: { access: form.googleAccess, adsCustomerId: form.adsCustomerId.trim(), adsLoginCustomerId: form.adsLoginCustomerId.trim() },
    },
    secrets,
  }
}

/** What an owner action answered. */
export type SeoActionResult = { ok: true; body: Record<string, unknown> } | { ok: false; error: string }

/**
 * Post one owner action and read its answer.
 * @param request - same-origin HTTP.
 * @param body - the action and its fields.
 * @returns the answer body, or the Host's error (or the HTTP status when it gave none).
 */
export async function postSeoAction(request: SeoRequest, body: Record<string, unknown>): Promise<SeoActionResult> {
  try {
    const response = await request(SEO_ACTION_PATH, {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    let answer: Record<string, unknown> = {}
    try {
      answer = record(await response.json())
    } catch {
      // A non-JSON answer (a proxy error page) is reported by its status.
    }
    if (!response.ok) return { ok: false, error: typeof answer['error'] === 'string' ? answer['error'] : `HTTP ${String(response.status)}` }
    return { ok: true, body: answer }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Read `/seo/status`.
 * @param request - same-origin HTTP.
 * @returns the status.
 * @throws when the route fails or answers an error status.
 */
export async function fetchSeoStatus(request: SeoRequest): Promise<SeoStatus> {
  const response = await request(SEO_STATUS_PATH, { cache: 'no-store', credentials: 'same-origin' })
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
  return parseSeoStatus(await response.json())
}
