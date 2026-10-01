/**
 * The SEO employee's tools. Every rule that protects the owner's sites is
 * enforced here, in the operation that makes the decision, not in the prompt:
 * one page per topic, the wait for the owner's answers, the draft checks, the
 * editor's recorded verdict, the weekly cap and the pause switch.
 */

import { createHash, randomBytes } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ParameterSchemaSpec, ToolDefinition, ToolRunContext, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { WhatsAppMessage } from '@deepseek-ai/dsh-host-employee-kit'
import { generateKeywordHistoricalMetrics, generateKeywordIdeas, isPlannableKeyword, type AdsAuth } from './google/ads.ts'
import { cannibalization, gscWindow, queryAll, strikingDistance, submitSitemap } from './google/gsc.ts'
import { imageProblem, type ImageRequest, type MadeImage } from './images.ts'
import { draftProblems } from './quality/draft.ts'
import { editorPrompt, parseEditorReply } from './quality/editor.ts'
import {
  clipIds, freshResearch, publishedThisWeek, recordResearch,
  type Article, type Draft, type SeoState, type SeoStore, type Topic, type TopicStatus,
} from './store.ts'
import type { ArticleDraft, Faq, KeywordIdea, Market, Publisher, Site, Source } from './types.ts'

/** The settings the tools read, live. */
export interface SeoToolSettings {
  adsApiVersion: () => string
  researchCacheDays: () => number
  answerWaitHours: () => number
  /** The service account Google is reached as, when one is set instead of an OAuth sign-in. */
  serviceAccountEmail?: () => string | undefined
}

/** Everything the tools read or call, injectable for tests. */
export interface SeoDeps {
  store: SeoStore
  settings: SeoToolSettings
  fetch: typeof fetch
  now: () => Date
  /** A Google access token for a site (its own sign-in, or the shared access), or an error saying how to connect. */
  googleToken: (signal: AbortSignal, site: Site) => Promise<string>
  /**
   * Keyword Planner credentials and account for a site: the account set for it, or else the first active account its
   * sign-in reaches. Undefined when it reaches none.
   */
  adsAuth: (site: Site, signal: AbortSignal) => Promise<(AdsAuth & { customerId: string }) | undefined>
  /** The site's connector, with its stored credentials. */
  publisher: (site: Site) => Promise<Publisher>
  /** Run the editor model; returns its reply and which model answered. */
  editor: (prompt: string, signal: AbortSignal) => Promise<{ text: string; provider: string; model: string }>
  notify: (text: string) => Promise<string>
  readWhatsApp: (limit: number) => Promise<WhatsAppMessage[]>
  /** Make one article image from a real source; the tool uploads it to the site. */
  makeImage: (site: Site, request: ImageRequest, signal: AbortSignal) => Promise<MadeImage>
  /** The owner's one-tap unpublish link for an article. */
  unpublishLink: (articleId: string) => string
  reportFailure?: (stage: string, error: unknown) => void
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string', required: true, description: 'What happened, as text.' },
  },
} as const satisfies ValueSchemaSpec

/** Topic statuses that still hold their keywords against a new topic. */
const LIVE_TOPICS: readonly TopicStatus[] = ['planned', 'asked', 'drafted', 'published']

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24)
}

function newId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString('hex')}`
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(str).filter(v => v !== '') : []
}

function normalizeKeyword(value: string): string {
  return value.toLowerCase().replace(/\s+/gu, ' ').trim()
}

function findSite(state: SeoState, id: string): Site {
  const site = state.sites.find(s => s.id === id)
  if (site === undefined) throw new Error(`No site with id "${id}"; seo_status lists the sites.`)
  return site
}

function findTopic(state: SeoState, id: string): Topic {
  const topic = state.topics.find(t => t.id === id)
  if (topic === undefined) throw new Error(`No topic with id "${id}"; seo_topics lists them.`)
  return topic
}

function marketOf(site: Site, label: string): Market {
  if (label === '') {
    const first = site.markets[0]
    if (first === undefined) throw new Error(`${site.name} has no markets set; the owner adds them on the SEO sites page.`)
    return first
  }
  const market = site.markets.find(m => m.label.toLowerCase() === label.toLowerCase())
  if (market === undefined) throw new Error(`${site.name} has no market "${label}". Its markets: ${site.markets.map(m => m.label).join(', ')}.`)
  return market
}

function formatIdea(idea: KeywordIdea, covered: Set<string>): string {
  const volume = idea.avgMonthlySearches === undefined ? 'volume unknown' : `~${String(idea.avgMonthlySearches)}/mo`
  const bids = idea.highTopOfPageBidMicros === undefined ? '' : `, top-of-page bid up to ${(idea.highTopOfPageBidMicros / 1e6).toFixed(2)}`
  const index = idea.competitionIndex === undefined ? '' : ` ${String(idea.competitionIndex)}/100`
  return `- ${idea.text}: ${volume}, ad competition ${idea.competition.toLowerCase()}${index}${bids}${covered.has(normalizeKeyword(idea.text)) ? ' [already covered]' : ''}`
}

/** How the employee reaches Google, for seo_status. */
function googleLine(state: SeoState, serviceAccount: string | undefined): string {
  if (serviceAccount !== undefined) return `Google reached as the service account ${serviceAccount}.`
  if (state.google !== null) return `Google connected ${state.google.connectedAt}.`
  return 'Google is NOT connected: Search Console and Keyword Planner tools will fail until the owner connects it on the SEO employee page.'
}

/** Keywords a site's live topics and articles already target. */
function coveredKeywords(state: SeoState, siteId: string): Set<string> {
  const covered = new Set<string>()
  for (const topic of state.topics) {
    if (topic.siteId !== siteId || !LIVE_TOPICS.includes(topic.status)) continue
    covered.add(normalizeKeyword(topic.keyword))
    for (const k of topic.cluster) covered.add(normalizeKeyword(k))
  }
  return covered
}

/** Read the article fields of a tool call. */
function draftFromArgs(args: Record<string, unknown>): ArticleDraft {
  const faq: Faq[] = Array.isArray(args['faq'])
    ? args['faq'].flatMap((f: unknown) => typeof f === 'object' && f !== null
      ? [{ q: str((f as Record<string, unknown>)['q']), a: str((f as Record<string, unknown>)['a']) }]
      : [])
    : []
  const sources: Source[] = Array.isArray(args['sources'])
    ? args['sources'].flatMap((s: unknown) => typeof s === 'object' && s !== null
      ? [{ title: str((s as Record<string, unknown>)['title']), url: str((s as Record<string, unknown>)['url']) }]
      : [])
    : []
  const cover = str(args['cover_image_url'])
  return {
    slug: str(args['slug']),
    title: str(args['title']),
    metaTitle: str(args['meta_title']),
    metaDescription: str(args['meta_description']),
    dek: str(args['dek']),
    bodyMarkdown: typeof args['body_markdown'] === 'string' ? args['body_markdown'] : '',
    tags: strings(args['tags']),
    faq,
    sources,
    ...cover === '' ? {} : { coverImageUrl: cover, coverAlt: str(args['cover_alt']) },
  }
}

/**
 * The site's live page addresses: its sitemap plus what the publisher lists.
 * @param deps - HTTP and the publisher.
 * @param site - the site.
 * @param signal - cancels the reads.
 * @returns absolute URLs, and the publisher's article list.
 */
export async function sitePages(deps: SeoDeps, site: Site, signal: AbortSignal): Promise<{ urls: string[]; articles: Awaited<ReturnType<Publisher['list']>> }> {
  const articles = await (await deps.publisher(site)).list(signal)
  const urls = new Set(articles.filter(a => a.status === 'published').map(a => a.url))
  const base = site.baseUrl.replace(/\/+$/u, '')
  urls.add(`${base}/`)
  for (const path of ['/sitemap.xml', '/wp-sitemap.xml', '/sitemap_index.xml']) {
    try {
      const response = await deps.fetch(`${base}${path}`, { signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) })
      if (!response.ok) continue
      const xml = await response.text()
      const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/giu)].map(m => m[1] ?? '')
      for (const loc of locs) {
        // A sitemap index lists more sitemaps; read one level of them.
        if (/\.xml(?:\?|$)/iu.test(loc)) {
          const inner = await deps.fetch(loc, { signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) }).then(r => r.ok ? r.text() : '', () => '')
          for (const m of inner.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/giu)) {
            if (m[1] !== undefined && !/\.xml(?:\?|$)/iu.test(m[1])) urls.add(m[1])
          }
        } else if (loc !== '') {
          urls.add(loc)
        }
      }
      break
    } catch (error) {
      // An unreachable sitemap leaves the publisher's list as the known pages.
      if (signal.aborted) throw error
    }
  }
  return { urls: [...urls], articles }
}

/**
 * Build the SEO employee's tools without registering them, so one definition
 * serves both its shift Sessions and the CLI command route.
 * @param deps - the store, settings, and external calls.
 * @returns the tool definitions.
 */
export function buildSeoTools(deps: SeoDeps): ToolDefinition[] {
  const { store, settings } = deps
  const iso = (): string => deps.now().toISOString()
  const siteParameter = { type: 'string', required: true, description: 'The site id, as seo_status lists it.' } as const
  const topicParameter = { type: 'string', required: true, description: 'The topic id, as seo_topics lists it.' } as const
  const refuseWhilePaused = (state: SeoState): void => {
    if (state.paused !== null) throw new Error(`The SEO employee is paused (${state.paused.reason}). Stop; only the owner resumes it.`)
  }
  const tool = (spec: {
    name: string
    description: string
    parameters: ParameterSchemaSpec
    run: (args: Record<string, unknown>, exec: ToolRunContext) => Promise<string>
  }): ToolDefinition => defineTool({
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: { schema: OUTPUT_SCHEMA, render: (_args, value) => [{ type: 'text', text: value.text }] },
    execute: async (args, exec) => ({ text: await spec.run(args as Record<string, unknown>, exec) }),
    presentCall: () => ({ card: 'generic', title: spec.name.replace(/_/gu, ' '), kind: 'other', rawInput: '' }),
  })
  /** Run a research call through the 30-day cache. */
  const cached = async <T>(kind: 'ideas' | 'metrics' | 'gsc' | 'suggest', siteId: string, summary: string, request: unknown, maxAgeDays: number,
    run: () => Promise<T>): Promise<{ result: T; cachedAt?: string }> => {
    const key = hash({ kind, siteId, request })
    const hit = freshResearch(await store.read(), key, maxAgeDays, deps.now())
    if (hit !== undefined) return { result: hit.result as T, cachedAt: hit.at }
    const result = await run()
    await store.update((s) => { recordResearch(s, { key, kind, siteId, summary, at: iso(), result }) })
    return { result }
  }

  const draftArticleParameters = {
    slug: { type: 'string', required: true, description: 'Lowercase words joined by hyphens, at most 70 characters, unique on the site.' },
    title: { type: 'string', required: true, description: 'The headline, at most 70 characters.' },
    meta_title: { type: 'string', required: true, description: 'The search result title, at most 60 characters.' },
    meta_description: { type: 'string', required: true, description: 'The search result snippet, 70 to 160 characters.' },
    dek: { type: 'string', required: true, description: 'One-line subtitle under the headline, at most 160 characters.' },
    body_markdown: { type: 'string', required: true, description: 'The article in Markdown: no H1 (the title is the H1), at least three ## sections, no raw HTML. Klipara clips embed as a line ::clip[<sample id>].' },
    tags: { type: 'array', items: { type: 'string' }, required: true, description: '1 to 5 tags.' },
    faq: {
      type: 'array',
      description: 'Optional: 3 to 6 questions searchers ask, each answered in 30 to 80 words.',
      items: { type: 'object', additionalProperties: false, properties: { q: { type: 'string', required: true }, a: { type: 'string', required: true } } },
    },
    sources: {
      type: 'array',
      description: 'Every outside source the article relies on; each must also be linked in the body. Required when the article states any statistic.',
      items: { type: 'object', additionalProperties: false, properties: { title: { type: 'string', required: true }, url: { type: 'string', required: true } } },
    },
    cover_image_url: { type: 'string', description: 'Optional https image to use as the cover; it is copied to the site.' },
    cover_alt: { type: 'string', description: 'What the cover shows; required with a cover.' },
  } as const

  return [
    tool({
      name: 'seo_status',
      description: 'Show the sites you write for (profile, markets, Search Console property, articles this week against the cap), whether Google is connected, whether you are paused, open owner questions, drafts waiting, and the content map\'s counts. Call it first in a shift.',
      parameters: {},
      run: async () => {
        const state = await store.read()
        const now = deps.now()
        const lines = [
          state.paused === null ? 'Running.' : `PAUSED since ${state.paused.at}: ${state.paused.reason}. Stop the shift.`,
          googleLine(state, settings.serviceAccountEmail?.()),
        ]
        for (const site of state.sites) {
          const topics = state.topics.filter(t => t.siteId === site.id)
          const count = (status: TopicStatus): number => topics.filter(t => t.status === status).length
          lines.push(
            '',
            `## ${site.name} (id ${site.id}) ${site.enabled ? '' : '[DISABLED: do not write for it]'}`,
            `${site.baseUrl}, published with ${site.kind}; Search Console: ${site.gscProperty || 'not set'}; markets: ${site.markets.map(m => m.label).join(', ') || 'none'}.`,
            site.google?.access === 'own'
              ? `Google: the site owner's own sign-in (${state.siteGoogle[site.id] === undefined ? 'NOT connected yet: skip Google research for this site' : 'connected'}).`
              : 'Google: the shared access.',
            `This week: ${String(publishedThisWeek(state, site.id, now))}/${String(site.articlesPerWeek)} articles.`,
            `Business: ${site.profile.business}`,
            `Readers: ${site.profile.audience}`,
            `Offer: ${site.profile.offer}`,
            `Voice: ${site.profile.voice}`,
            `Call to action: ${site.profile.cta.text} (${site.profile.cta.url})`,
            `Seeds: ${site.seeds.join('; ') || 'none'}`,
            `Topics: planned ${String(count('planned'))}, asked ${String(count('asked'))}, drafted ${String(count('drafted'))}, published ${String(count('published'))}, rejected ${String(count('rejected'))}.`,
          )
        }
        const open = state.questions.filter(q => q.answer === undefined)
        if (open.length > 0) lines.push('', `Owner questions waiting: ${open.map(q => `${q.tag} (topic ${q.topicId}, asked ${q.askedAt})`).join('; ')}.`)
        const waiting = state.drafts.filter(d => d.editor?.pass !== true)
        if (waiting.length > 0) lines.push(`Drafts not yet passed by the editor: ${waiting.map(d => `${d.id} (topic ${d.topicId})`).join(', ')}.`)
        if (state.sites.length === 0) lines.push('', 'No sites yet. The owner adds them on the SEO sites page; stop the shift.')
        return lines.join('\n')
      },
    }),
    tool({
      name: 'seo_search_console',
      description: 'Read a site\'s Google Search Console data. `striking` lists queries whose best page sits at positions 5 to 20 (the quickest wins: improve that page or write the missing one); `queries` the top queries; `pages` the top pages; `cannibalization` queries split across several of the site\'s pages. Cached for a day.',
      parameters: {
        site_id: siteParameter,
        report: { type: 'string', required: true, enum: ['striking', 'queries', 'pages', 'cannibalization'] },
        days: { type: 'integer', description: 'Days to look back, 7 to 90. Defaults to 28.' },
        limit: { type: 'integer', description: 'Rows to return, 1 to 100. Defaults to 40.' },
      },
      run: async (args, exec) => {
        const state = await store.read()
        const site = findSite(state, str(args['site_id']))
        if (site.gscProperty === '') throw new Error(`${site.name} has no Search Console property set; the owner adds it on the SEO sites page.`)
        const report = str(args['report'])
        const days = Math.min(Math.max(typeof args['days'] === 'number' ? args['days'] : 28, 7), 90)
        const limit = Math.min(Math.max(typeof args['limit'] === 'number' ? args['limit'] : 40, 1), 100)
        const window = gscWindow(deps.now(), days)
        const dimensions = report === 'pages' ? ['page' as const] : report === 'queries' ? ['query' as const] : ['query' as const, 'page' as const]
        const { result: rows, cachedAt } = await cached('gsc', site.id, `${report} ${String(days)}d`, { dimensions, window }, 1, async () => {
          const token = await deps.googleToken(exec.signal, site)
          return queryAll(deps.fetch, token, site.gscProperty, { ...window, dimensions }, 5000, exec.signal)
        })
        const head = `${site.name}, ${window.startDate} to ${window.endDate}${cachedAt === undefined ? '' : ` (cached ${cachedAt})`}:`
        if (report === 'striking') {
          const found = strikingDistance(rows).slice(0, limit)
          if (found.length === 0) return `${head} no queries at positions 5 to 20 with 50+ impressions yet. Use seo_keyword_ideas.`
          return [head, ...found.map(r => `- "${r.query}" → ${r.page}: position ${r.position.toFixed(1)}, ${String(r.impressions)} impressions, ${String(r.clicks)} clicks`)].join('\n')
        }
        if (report === 'cannibalization') {
          const found = cannibalization(rows).slice(0, limit)
          if (found.length === 0) return `${head} no query splits its impressions across several pages.`
          return [head, ...found.map(c => `- "${c.query}": ${c.pages.map(p => `${p.page} (${String(p.impressions)} impressions, position ${p.position.toFixed(1)})`).join(' vs ')}`)].join('\n')
        }
        const top = [...rows].sort((a, b) => b.impressions - a.impressions).slice(0, limit)
        return [head, ...top.map(r => `- ${r.query ?? r.page ?? ''}: ${String(r.clicks)} clicks, ${String(r.impressions)} impressions, CTR ${(r.ctr * 100).toFixed(1)}%, position ${r.position.toFixed(1)}`)].join('\n')
      },
    }),
    tool({
      name: 'seo_keyword_ideas',
      description: 'Get keyword ideas from Google Keyword Planner for a site and one of its markets, seeded by keywords and/or a page URL. Shows rounded monthly searches and AD competition (how crowded the ads are, not how hard it is to rank). Ideas a live topic already targets are marked. Cached for the configured number of days; never quote these volumes in an article.',
      parameters: {
        site_id: siteParameter,
        seeds: { type: 'array', items: { type: 'string' }, description: 'Up to 10 seed keywords. Omit to use the site\'s seeds.' },
        url: { type: 'string', description: 'Optional page on the site to seed from.' },
        market: { type: 'string', description: 'A market label of the site, for example Nigeria. Defaults to its first market.' },
        limit: { type: 'integer', description: 'Ideas to show, 10 to 100. Defaults to 40.' },
      },
      run: async (args, exec) => {
        const state = await store.read()
        const site = findSite(state, str(args['site_id']))
        const market = marketOf(site, str(args['market']))
        const auth = await deps.adsAuth(site, exec.signal)
        if (auth === undefined) throw new Error(`Keyword Planner has no active Google Ads account for ${site.name}. Use seo_search_console and seo_autocomplete instead.`)
        const { customerId } = auth
        const seeds = (strings(args['seeds']).length > 0 ? strings(args['seeds']) : site.seeds).filter(isPlannableKeyword).slice(0, 10)
        const url = str(args['url'])
        if (seeds.length === 0 && url === '') throw new Error('Give seed keywords or a page URL; the site has no plannable seeds.')
        const limit = Math.min(Math.max(typeof args['limit'] === 'number' ? args['limit'] : 40, 10), 100)
        const request = { seeds, url, geo: market.geoId, language: market.languageId }
        const { result: ideas, cachedAt } = await cached('ideas', site.id, `ideas ${market.label}: ${seeds.join(', ')} ${url}`, request, settings.researchCacheDays(),
          () => generateKeywordIdeas(deps.fetch, auth, {
            customerId,
            ...seeds.length > 0 ? { keywords: seeds } : {},
            ...url === '' ? {} : { url },
            geoIds: market.geoId === '' ? [] : [market.geoId],
            ...market.languageId === '' ? {} : { languageId: market.languageId },
            maxResults: 300,
          }, exec.signal, settings.adsApiVersion()))
        const covered = coveredKeywords(state, site.id)
        const ranked = [...ideas].sort((a, b) => (b.avgMonthlySearches ?? 0) - (a.avgMonthlySearches ?? 0)).slice(0, limit)
        return [
          `${String(ideas.length)} ideas for ${site.name} in ${market.label}${cachedAt === undefined ? '' : ` (cached ${cachedAt})`}, most searched first:`,
          ...ranked.map(i => formatIdea(i, covered)),
        ].join('\n')
      },
    }),
    tool({
      name: 'seo_keyword_volumes',
      description: 'Get Keyword Planner\'s rounded monthly searches and ad competition for exact keywords in one of a site\'s markets, to compare candidate wordings of a topic.',
      parameters: {
        site_id: siteParameter,
        keywords: { type: 'array', items: { type: 'string' }, required: true, description: '1 to 30 keywords.' },
        market: { type: 'string', description: 'A market label of the site. Defaults to its first market.' },
      },
      run: async (args, exec) => {
        const state = await store.read()
        const site = findSite(state, str(args['site_id']))
        const market = marketOf(site, str(args['market']))
        const auth = await deps.adsAuth(site, exec.signal)
        if (auth === undefined) throw new Error(`Keyword Planner has no active Google Ads account for ${site.name}.`)
        const { customerId } = auth
        const keywords = [...new Set(strings(args['keywords']).map(normalizeKeyword))].slice(0, 30)
        const { result: metrics, cachedAt } = await cached('metrics', site.id, `volumes ${market.label}: ${keywords.join(', ')}`, { keywords, market },
          settings.researchCacheDays(), () => generateKeywordHistoricalMetrics(deps.fetch, auth, {
            customerId, keywords, geoIds: market.geoId === '' ? [] : [market.geoId], ...market.languageId === '' ? {} : { languageId: market.languageId },
          }, exec.signal, settings.adsApiVersion()))
        const covered = coveredKeywords(state, site.id)
        const missing = keywords.filter(k => !metrics.some(m => normalizeKeyword(m.text) === k))
        return [
          `${market.label}${cachedAt === undefined ? '' : ` (cached ${cachedAt})`}:`,
          ...metrics.map(m => formatIdea(m, covered)),
          ...missing.length > 0 ? [`No data: ${missing.join(', ')}.`] : [],
        ].join('\n')
      },
    }),
    tool({
      name: 'seo_autocomplete',
      description: 'Read Google\'s search suggestions for a phrase in one of a site\'s markets: how people actually phrase the question. Ideas only, never volumes. Cached.',
      parameters: {
        site_id: siteParameter,
        query: { type: 'string', required: true, description: 'The start of a search.' },
        market: { type: 'string', description: 'A market label of the site. Defaults to its first market.' },
      },
      run: async (args, exec) => {
        const state = await store.read()
        const site = findSite(state, str(args['site_id']))
        const market = marketOf(site, str(args['market']))
        const query = str(args['query'])
        if (query === '') throw new Error('Give a query.')
        const country = Object.entries({ 2566: 'ng', 2288: 'gh', 2404: 'ke', 2710: 'za', 2840: 'us', 2826: 'gb' }).find(([id]) => id === market.geoId)?.[1] ?? ''
        const { result } = await cached('suggest', site.id, `suggest ${market.label}: ${query}`, { query, country }, settings.researchCacheDays(), async () => {
          const url = new URL('https://suggestqueries.google.com/complete/search')
          url.search = new URLSearchParams({ client: 'firefox', q: query, hl: 'en', ...country === '' ? {} : { gl: country } }).toString()
          const response = await deps.fetch(url, { signal: AbortSignal.any([exec.signal, AbortSignal.timeout(15_000)]) })
          if (!response.ok) throw new Error(`Google suggestions answered HTTP ${String(response.status)}; continue without them.`)
          const body: unknown = await response.json()
          return Array.isArray(body) && Array.isArray(body[1]) ? body[1].filter((s: unknown): s is string => typeof s === 'string') : []
        })
        return result.length === 0 ? `No suggestions for "${query}".` : [`Suggestions for "${query}" (${market.label}):`, ...result.map(s => `- ${s}`)].join('\n')
      },
    }),
    tool({
      name: 'seo_site_pages',
      description: 'List a site\'s live pages (from its sitemap) and its articles with their status. Use it to pick internal links (only these URLs exist) and to check a topic is not already covered.',
      parameters: { site_id: siteParameter },
      run: async (args, exec) => {
        const site = findSite(await store.read(), str(args['site_id']))
        const { urls, articles } = await sitePages(deps, site, exec.signal)
        return [
          `${site.name}: ${String(urls.length)} live pages.`,
          ...urls.slice(0, 300).map(u => `- ${u}`),
          '',
          `Articles (${String(articles.length)}):`,
          ...articles.map(a => `- [${a.status}] ${a.title} → ${a.url}${a.tags.length > 0 ? ` (tags: ${a.tags.join(', ')})` : ''}`),
        ].join('\n')
      },
    }),
    tool({
      name: 'seo_topics',
      description: 'List the content map: each topic\'s id, site, main keyword, cluster, status and target page.',
      parameters: {
        site_id: { type: 'string', description: 'Only this site.' },
        status: { type: 'string', enum: ['planned', 'asked', 'drafted', 'published', 'rejected'], description: 'Only this status.' },
      },
      run: async (args) => {
        const state = await store.read()
        const siteId = str(args['site_id'])
        const status = str(args['status'])
        const topics = state.topics.filter(t => (siteId === '' || t.siteId === siteId) && (status === '' || t.status === status))
        if (topics.length === 0) return 'No topics match.'
        return topics.map(t => `- ${t.id} [${t.status}] ${t.siteId}: "${t.keyword}"${t.cluster.length > 0 ? ` + ${t.cluster.join(', ')}` : ''} → ${t.target}${t.reason === undefined ? '' : ` (${t.reason})`}`).join('\n')
      },
    }),
    tool({
      name: 'seo_save_topic',
      description: 'Add a topic to a site\'s content map: one page for one search intent. Refused when its keyword or any cluster keyword already belongs to a live topic of the site (one page per query, so the site\'s pages never compete). Record why and what the top results miss.',
      parameters: {
        site_id: siteParameter,
        keyword: { type: 'string', required: true, description: 'The main query the page targets.' },
        cluster: { type: 'array', items: { type: 'string' }, description: 'Other queries with the same intent whose top results overlap; the same page serves them.' },
        intent: { type: 'string', required: true, enum: ['informational', 'commercial', 'transactional', 'navigational'] },
        why: { type: 'string', required: true, description: 'Why this topic, with the numbers you saw (Search Console position and impressions, Keyword Planner volume).' },
        serp_notes: { type: 'string', required: true, description: 'Who ranks now, what format wins, and what those pages miss that the site can add.' },
        target: { type: 'string', description: '`new` (default) or the URL of the site\'s existing article to refresh.' },
      },
      run: async args => await store.update((s) => {
        refuseWhilePaused(s)
        const site = findSite(s, str(args['site_id']))
        if (!site.enabled) throw new Error(`${site.name} is disabled.`)
        const keyword = normalizeKeyword(str(args['keyword']))
        if (keyword === '') throw new Error('Give the keyword.')
        const cluster = [...new Set(strings(args['cluster']).map(normalizeKeyword))].filter(k => k !== keyword)
        const target = str(args['target']) || 'new'
        // A refresh may re-plan the queries of the article it targets; anything else must be new ground.
        const clash = s.topics.find(t => t.siteId === site.id && LIVE_TOPICS.includes(t.status) && !(target !== 'new' && t.target === target)
          && [t.keyword, ...t.cluster].map(normalizeKeyword).some(k => k === keyword || cluster.includes(k)))
        if (clash !== undefined) {
          throw new Error(`Topic ${clash.id} ("${clash.keyword}", ${clash.status}) already targets this query. Refresh that page instead (target its URL), or pick a different intent.`)
        }
        const topic: Topic = {
          id: newId('t'), siteId: site.id, keyword, cluster, intent: str(args['intent']) as Topic['intent'],
          why: str(args['why']), serpNotes: str(args['serp_notes']), target, status: 'planned', createdAt: iso(), updatedAt: iso(),
        }
        s.topics.push(topic)
        return `Topic ${topic.id} saved for ${site.name}: "${keyword}". Next: seo_ask_owner for first-hand material.`
      }),
    }),
    tool({
      name: 'seo_reject_topic',
      description: 'Drop a topic from the content map with the reason (for example the results are all big brands, or the intent does not fit the business).',
      parameters: { topic_id: topicParameter, reason: { type: 'string', required: true } },
      run: async args => await store.update((s) => {
        const topic = findTopic(s, str(args['topic_id']))
        if (topic.status === 'published') throw new Error('A published topic cannot be rejected; its article is live.')
        topic.status = 'rejected'
        topic.reason = str(args['reason'])
        topic.updatedAt = iso()
        return `Topic ${topic.id} rejected.`
      }),
    }),
    tool({
      name: 'seo_ask_owner',
      description: 'Ask the owner 1 to 3 short questions on WhatsApp for first-hand material the article needs: a real example, a number from their own work, what they saw happen. Specific questions get answers; "any thoughts?" does not. The draft waits for the answer up to the configured hours.',
      parameters: {
        topic_id: topicParameter,
        questions: { type: 'array', items: { type: 'string' }, required: true, description: '1 to 3 questions.' },
      },
      run: async (args) => {
        const questions = strings(args['questions']).slice(0, 3)
        if (questions.length === 0) throw new Error('Give 1 to 3 questions.')
        const asked = await store.update((s) => {
          refuseWhilePaused(s)
          const topic = findTopic(s, str(args['topic_id']))
          if (s.questions.some(q => q.topicId === topic.id && q.answer === undefined)) throw new Error('Questions for this topic are already waiting for the owner.')
          const site = findSite(s, topic.siteId)
          const tag = `#q${randomBytes(2).toString('hex')}`
          s.questions.push({ tag, siteId: site.id, topicId: topic.id, questions, askedAt: iso() })
          topic.status = 'asked'
          topic.updatedAt = iso()
          return { tag, site, topic }
        })
        const text = [
          `SEO employee, ${asked.site.name}: I'm writing about "${asked.topic.keyword}". A short answer from you makes it worth reading.`,
          ...questions.map((q, i) => `${String(i + 1)}. ${q}`),
          `Reply starting with ${asked.tag} (voice-to-text is fine), or answer on the SEO employee page.`,
        ].join('\n')
        const sent = await deps.notify(text)
        return `Asked ${asked.tag}: ${sent}. Check with seo_check_answers; meanwhile research or draft another topic.`
      },
    }),
    tool({
      name: 'seo_check_answers',
      description: 'Collect the owner\'s answers (WhatsApp replies starting with the question\'s tag, or answers given on the SEO employee page) and list what is still waiting.',
      parameters: {},
      run: async () => {
        const state = await store.read()
        const open = state.questions.filter(q => q.answer === undefined)
        let messages: WhatsAppMessage[] = []
        let readError = ''
        if (open.length > 0) {
          try {
            messages = await deps.readWhatsApp(100)
          } catch (error) {
            readError = error instanceof Error ? error.message : String(error)
          }
        }
        const found = await store.update((s) => {
          const got: string[] = []
          for (const q of s.questions) {
            if (q.answer !== undefined) continue
            const asked = Date.parse(q.askedAt) / 1000
            const replies = messages.filter(m => m.ts >= asked && m.body.trim().toLowerCase().startsWith(q.tag)).sort((a, b) => a.ts - b.ts)
            if (replies.length === 0) continue
            q.answer = replies.map(m => m.body.trim().slice(q.tag.length).replace(/^[\s:,-]+/u, '')).join('\n')
            q.answeredAt = new Date((replies.at(-1)?.ts ?? 0) * 1000).toISOString()
            got.push(q.tag)
          }
          return got
        })
        const after = await store.read()
        const lines = after.questions
          .filter(q => q.answer !== undefined && Date.now() - Date.parse(q.answeredAt ?? q.askedAt) < 30 * 86_400_000)
          .map(q => `- ${q.tag} (topic ${q.topicId}) answered:\n  Q: ${q.questions.join(' / ')}\n  A: ${q.answer ?? ''}`)
        const waiting = after.questions.filter(q => q.answer === undefined).map(q => `- ${q.tag} (topic ${q.topicId}) waiting since ${q.askedAt}`)
        return [
          found.length > 0 ? `New answers: ${found.join(', ')}.` : 'No new answers.',
          ...readError === '' ? [] : [`WhatsApp could not be read (${readError}); answers given on the page still count.`],
          ...lines.length > 0 ? ['Answers (use them as the article\'s first-hand material, in the owner\'s own words where you quote):', ...lines] : [],
          ...waiting.length > 0 ? ['Still waiting:', ...waiting] : [],
        ].join('\n')
      },
    }),
    tool({
      name: 'seo_add_image',
      description: 'Make one image for an article and copy it into the site\'s media library; returns the site URL and the Markdown line to put in the body (or use as cover_image_url). Real sources only, in this order of preference: `clip-cover` (a Klipara sample\'s designed cover: the best cover for an article that embeds that clip), `screenshot` (one of the site\'s own public pages, optionally cropped to a CSS selector: for how-to steps), `graphic` with template `cover` (title card in the site\'s colours, when there is no clip), `steps` (numbered steps) or `chart` (bars of real numbers with their source). Never use an image to show a person, a screen or a result that does not exist.',
      parameters: {
        site_id: siteParameter,
        kind: { type: 'string', required: true, enum: ['clip-cover', 'screenshot', 'graphic'] },
        alt: { type: 'string', required: true, description: 'What the image shows, for screen readers and search: specific, under 125 characters, no "image of".' },
        sample_id: { type: 'string', description: 'clip-cover: the id from the sample\'s /s/<id> link.' },
        url: { type: 'string', description: 'screenshot: a page on the site.' },
        selector: { type: 'string', description: 'screenshot: optional CSS selector to crop to.' },
        mobile: { type: 'boolean', description: 'screenshot: render as a phone (390px wide).' },
        template: { type: 'string', enum: ['cover', 'steps', 'chart'], description: 'graphic: which template.' },
        title: { type: 'string', description: 'graphic: the headline on the image.' },
        subtitle: { type: 'string', description: 'graphic cover: optional line under the title.' },
        steps: { type: 'array', items: { type: 'string' }, description: 'graphic steps: 2 to 8 short steps.' },
        bars: {
          type: 'array',
          description: 'graphic chart: 2 to 10 bars of real numbers.',
          items: { type: 'object', additionalProperties: false, properties: { label: { type: 'string', required: true }, value: { type: 'number', required: true } } },
        },
        unit: { type: 'string', description: 'graphic chart: unit after each value, for example % or " views".' },
        source: { type: 'string', description: 'graphic chart: where the numbers come from; required.' },
      },
      run: async (args, exec) => {
        const state = await store.read()
        refuseWhilePaused(state)
        const site = findSite(state, str(args['site_id']))
        const alt = str(args['alt'])
        if (alt.length < 5 || alt.length > 125 || /^(?:an? )?(?:image|picture|photo|screenshot) of\b/iu.test(alt)) {
          throw new Error('alt must say what the image shows in 5 to 125 characters, without "image of".')
        }
        const kind = str(args['kind'])
        let request: ImageRequest
        if (kind === 'clip-cover') request = { kind, sampleId: str(args['sample_id']) }
        else if (kind === 'screenshot') {
          const selector = str(args['selector'])
          request = { kind, url: str(args['url']), mobile: args['mobile'] === true, ...selector === '' ? {} : { selector } }
        } else {
          const template = str(args['template'])
          const title = str(args['title'])
          if (template === 'steps') request = { kind: 'graphic', template, title, steps: strings(args['steps']) }
          else if (template === 'chart') {
            const bars = Array.isArray(args['bars'])
              ? args['bars'].flatMap((b: unknown) => {
                if (typeof b !== 'object' || b === null) return []
                const row = b as Record<string, unknown>
                return typeof row['value'] === 'number' ? [{ label: str(row['label']), value: row['value'] }] : []
              })
              : []
            request = { kind: 'graphic', template, title, bars, unit: str(args['unit']), source: str(args['source']) }
          } else request = { kind: 'graphic', template: 'cover', title, subtitle: str(args['subtitle']) }
        }
        if (request.kind === 'clip-cover' && (state.clipPermissions ?? {})[request.sampleId] === undefined) {
          throw new Error(`The clip ${request.sampleId} is not on the owner's list of clips that may be featured; its cover cannot be used either.`)
        }
        const problem = imageProblem(site, request)
        if (problem !== undefined) throw new Error(problem)
        const made = await deps.makeImage(site, request, exec.signal)
        const hosted = await (await deps.publisher(site)).uploadMedia(made.sourceUrl, alt, exec.signal)
        return [
          `Made ${made.description} and copied it to ${site.name}: ${hosted}`,
          `In the body: ![${alt}](${hosted})`,
          `As the cover: cover_image_url "${hosted}", cover_alt "${alt}"`,
        ].join('\n')
      },
    }),
    tool({
      name: 'seo_submit_draft',
      description: 'Submit an article draft for a topic. The plugin checks it (lengths, headings, internal links that exist, sources for every statistic, no AI-writing tells, no raw HTML) and refuses it with every problem named; fix them all and submit again. Refused while the owner\'s answers are still due. A passing draft is saved; then call seo_review_draft.',
      parameters: {
        topic_id: topicParameter,
        article_id: { type: 'string', description: 'Set when this refreshes a published article (its id from seo_articles).' },
        ...draftArticleParameters,
      },
      run: async (args, exec) => {
        const state = await store.read()
        refuseWhilePaused(state)
        const topic = findTopic(state, str(args['topic_id']))
        const site = findSite(state, topic.siteId)
        if (topic.status === 'rejected') throw new Error('That topic is rejected.')
        const question = state.questions.findLast(q => q.topicId === topic.id)
        const waitMs = settings.answerWaitHours() * 3_600_000
        if (question !== undefined && question.answer === undefined && deps.now().getTime() - Date.parse(question.askedAt) < waitMs) {
          const until = new Date(Date.parse(question.askedAt) + waitMs).toISOString()
          throw new Error(`The owner has not answered ${question.tag} yet. Call seo_check_answers; the draft may go without the answer after ${until}.`)
        }
        const articleId = str(args['article_id'])
        const refreshing = articleId === '' ? undefined : state.articles.find(a => a.id === articleId && a.siteId === site.id)
        if (articleId !== '' && refreshing === undefined) throw new Error(`No article ${articleId} on ${site.name}.`)
        const draft = draftFromArgs(args)
        const { urls, articles } = await sitePages(deps, site, exec.signal)
        const problems: { field: string; rule: string; reason: string }[] = draftProblems(draft, {
          siteBaseUrl: site.baseUrl,
          existing: articles,
          internalUrls: urls,
          ...refreshing === undefined ? {} : { updatingId: refreshing.remoteId },
          bannedPhrases: site.profile.voice.split(/\n/u).flatMap(line => /^avoid:/iu.test(line.trim()) ? line.replace(/^avoid:/iu, '').split(',').map(p => p.trim()).filter(Boolean) : []),
        })
        const permitted = state.clipPermissions ?? {}
        for (const id of clipIds(draft.bodyMarkdown)) {
          const permission = permitted[id]
          if (permission === undefined) {
            problems.push({
              field: 'body', rule: 'clip-not-permitted',
              reason: `The clip ${id} is not on the owner's list of clips that may be featured (a creator's clip needs their permission). Remove it, or ask the owner with seo_ask_owner to add it on the SEO sites page.`,
            })
          } else if (permission.credit !== '' && !draft.bodyMarkdown.includes(permission.credit)) {
            problems.push({ field: 'body', rule: 'clip-credit', reason: `The clip ${id} must be credited in the body with: "${permission.credit}".` })
          }
        }
        if (problems.length > 0) {
          throw new Error(`The draft is refused. Fix every one of these and submit again:\n${problems.map(p => `- ${p.field}: ${p.reason}`).join('\n')}`)
        }
        const saved: Draft = {
          id: newId('d'), siteId: site.id, topicId: topic.id, draft, submittedAt: iso(), ...refreshing === undefined ? {} : { articleId: refreshing.id },
        }
        await store.update((s) => {
          s.drafts = s.drafts.filter(d => d.topicId !== topic.id)
          s.drafts.push(saved)
          const t = findTopic(s, topic.id)
          if (t.status !== 'published') t.status = 'drafted'
          t.updatedAt = iso()
        })
        return `Draft ${saved.id} passed the checks (${String(draft.bodyMarkdown.split(/\s+/u).length)} words). Next: seo_review_draft.`
      },
    }),
    tool({
      name: 'seo_review_draft',
      description: 'Send a saved draft to the editor model, a strict second reader that scores it on five dimensions. The plugin records the verdict; only a passing verdict can be published. On a fail, revise using the must-fix list and submit the draft again.',
      parameters: { draft_id: { type: 'string', required: true } },
      run: async (args, exec) => {
        const state = await store.read()
        const draft = state.drafts.find(d => d.id === str(args['draft_id']))
        if (draft === undefined) throw new Error('No such draft; submit it again with seo_submit_draft.')
        const site = findSite(state, draft.siteId)
        const topic = findTopic(state, draft.topicId)
        const reply = await deps.editor(editorPrompt(draft.draft, site, topic.keyword), exec.signal)
        const verdict = parseEditorReply(reply.text)
        await store.update((s) => {
          const d = s.drafts.find(x => x.id === draft.id)
          if (d === undefined) return
          d.editor = {
            at: iso(), provider: reply.provider, model: reply.model, scores: Object.fromEntries(Object.entries(verdict.scores)),
            total: verdict.total, mustFix: verdict.mustFix, pass: verdict.pass,
          }
        })
        const scores = Object.entries(verdict.scores).map(([k, v]) => `${k} ${String(v)}`).join(', ')
        return verdict.pass
          ? `Editor (${reply.model}): PASS ${String(verdict.total)}/50 (${scores}). Next: seo_publish.`
          : `Editor (${reply.model}): REVISE ${String(verdict.total)}/50 (${scores}).\nMust fix:\n${verdict.mustFix.map(m => `- ${m}`).join('\n') || '- raise every dimension to 6 or more'}\nRevise and call seo_submit_draft again.`
      },
    }),
    tool({
      name: 'seo_publish',
      description: 'Publish a draft the editor passed, or update the article it refreshes, within the site\'s weekly cap. Copies the cover to the site, tells Search Console about the sitemap, and sends the owner the link with a one-tap unpublish link.',
      parameters: { draft_id: { type: 'string', required: true } },
      run: async (args, exec) => {
        const state = await store.read()
        refuseWhilePaused(state)
        const draft = state.drafts.find(d => d.id === str(args['draft_id']))
        if (draft === undefined) throw new Error('No such draft.')
        if (draft.editor === undefined) throw new Error('This draft has not been reviewed; call seo_review_draft.')
        if (!draft.editor.pass) throw new Error(`The editor did not pass this draft (${String(draft.editor.total)}/50). Revise and submit it again.`)
        const site = findSite(state, draft.siteId)
        if (!site.enabled) throw new Error(`${site.name} is disabled.`)
        const refreshing = draft.articleId === undefined ? undefined : state.articles.find(a => a.id === draft.articleId)
        if (refreshing === undefined && publishedThisWeek(state, site.id, deps.now()) >= site.articlesPerWeek) {
          throw new Error(`${site.name} has had its ${String(site.articlesPerWeek)} articles this week. Keep the draft; it can be published next week.`)
        }
        const topic = findTopic(state, draft.topicId)
        const publisher = await deps.publisher(site)
        let body = draft.draft
        if (body.coverImageUrl !== undefined) {
          try {
            body = { ...body, coverImageUrl: await publisher.uploadMedia(body.coverImageUrl, body.coverAlt ?? '', exec.signal) }
          } catch (error) {
            deps.reportFailure?.('publish', error)
            const { coverImageUrl: _dropped, coverAlt: _alt, ...rest } = body
            body = rest
          }
        }
        const remote = refreshing === undefined
          ? await publisher.create(body, 'published', site.author, exec.signal)
          : await publisher.update(refreshing.remoteId, body, 'published', site.author, exec.signal)
        const article: Article = refreshing === undefined
          ? {
            id: newId('a'), siteId: site.id, topicId: topic.id, keyword: topic.keyword, remoteId: remote.id, slug: remote.slug, title: remote.title, url: remote.url,
            publishedAt: iso(), updatedAt: iso(), editorTotal: draft.editor.total, metrics: [],
          }
          : { ...refreshing, slug: remote.slug, title: remote.title, url: remote.url, updatedAt: iso(), editorTotal: draft.editor.total }
        await store.update((s) => {
          s.articles = s.articles.filter(a => a.id !== article.id)
          s.articles.push(article)
          s.drafts = s.drafts.filter(d => d.id !== draft.id)
          const t = findTopic(s, topic.id)
          t.status = 'published'
          t.target = article.url
          t.updatedAt = iso()
        })
        let sitemap = 'Search Console not told (no property set).'
        if (site.gscProperty !== '') {
          try {
            await submitSitemap(deps.fetch, await deps.googleToken(exec.signal, site), site.gscProperty, `${site.baseUrl.replace(/\/+$/u, '')}/sitemap.xml`, exec.signal)
            sitemap = 'Sitemap resubmitted to Search Console.'
          } catch (error) {
            sitemap = `Sitemap not resubmitted (${error instanceof Error ? error.message : String(error)}).`
          }
        }
        const told = await deps.notify([
          `SEO employee ${refreshing === undefined ? 'published' : 'updated'} on ${site.name}: "${article.title}"`,
          article.url,
          `Editor score ${String(article.editorTotal)}/50. Unpublish with one tap: ${deps.unpublishLink(article.id)}`,
        ].join('\n'))
        return `${refreshing === undefined ? 'Published' : 'Updated'} ${article.url} (article ${article.id}). ${sitemap} Owner: ${told}.`
      },
    }),
    tool({
      name: 'seo_articles',
      description: 'List a site\'s published articles with their Search Console clicks, impressions and position over the last 28 days (recorded each call), and flag the ones to refresh: older than 45 days and below position 15, or losing impressions.',
      parameters: { site_id: siteParameter },
      run: async (args, exec) => {
        const state = await store.read()
        const site = findSite(state, str(args['site_id']))
        const articles = state.articles.filter(a => a.siteId === site.id && a.unpublishedAt === undefined)
        if (articles.length === 0) return `${site.name} has no published articles yet.`
        let rows: { page?: string; clicks: number; impressions: number; position: number }[] = []
        let note = ''
        if (site.gscProperty !== '') {
          try {
            const token = await deps.googleToken(exec.signal, site)
            rows = await queryAll(deps.fetch, token, site.gscProperty, { ...gscWindow(deps.now(), 28), dimensions: ['page'] }, 5000, exec.signal)
          } catch (error) {
            note = `Search Console unavailable: ${error instanceof Error ? error.message : String(error)}`
          }
        }
        const at = iso()
        const lines = await store.update(s => articles.map((a) => {
          const row = rows.find(r => r.page === a.url)
          const stored = s.articles.find(x => x.id === a.id)
          const previous = stored?.metrics.at(-1)
          if (row !== undefined && stored !== undefined) {
            stored.metrics.push({ at, days: 28, clicks: row.clicks, impressions: row.impressions, position: row.position })
          }
          const age = (deps.now().getTime() - Date.parse(a.publishedAt)) / 86_400_000
          const flag = row !== undefined && age > 45 && (row.position > 15 || (previous !== undefined && row.impressions < previous.impressions * 0.7)) ? ' [REFRESH]' : ''
          return `- ${a.id} "${a.title}" (${a.url}), ${String(Math.round(age))} days: ${row === undefined ? 'no Search Console data yet' : `${String(row.clicks)} clicks, ${String(row.impressions)} impressions, position ${row.position.toFixed(1)}`}${flag}`
        }))
        return [`${site.name} articles, last 28 days:`, ...note === '' ? [] : [note], ...lines].join('\n')
      },
    }),
    tool({
      name: 'seo_pause',
      description: 'Stop all publishing and alert the owner. Use it at once if a site, Google or a publisher reports anything that looks like a penalty, a security block or a spam warning.',
      parameters: { reason: { type: 'string', required: true } },
      run: async (args) => {
        const reason = str(args['reason']) || 'no reason given'
        await store.update((s) => { s.paused = { reason, at: iso() } })
        const told = await deps.notify(`SEO employee paused itself: ${reason}. Nothing will be published until you resume it.`)
        return `Paused. Owner: ${told}. End the shift.`
      },
    }),
    tool({
      name: 'seo_resume',
      description: 'Resume after a pause. Only when the owner asks for it in this conversation.',
      parameters: {},
      run: async () => {
        await store.update((s) => { s.paused = null })
        return 'Resumed.'
      },
    }),
  ]
}
