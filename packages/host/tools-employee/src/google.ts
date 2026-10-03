/**
 * The two Google data sources the employee borrows instead of paying for
 * keyword tools. Keyword Planner volumes come from the SEO employee, through
 * its token-guarded command route (`seo_keyword_volumes`), so its Google Ads
 * access, cache and rate limits are reused rather than duplicated. Search
 * Console data comes from the SEO employee's Search Console client and
 * service-account sign-in, with this employee's own copy of the key. The
 * weekly review finds striking-distance queries (positions 5–20), titles
 * that earn too few clicks for their position, and tools with no
 * impressions months after launch.
 */

import { gscWindow, queryAll, strikingDistance, type GscRow } from '@deepseek-ai/dsh-host-seo-employee'
import type { GscReview } from './store.ts'

/** The SEO employee's command route. */
export interface SeoRoute {
  url: string
  token: string
  /** The SEO employee site whose Keyword Planner access is borrowed; empty turns volumes off. */
  siteId: () => string
}

/** Volumes by keyword (null: Keyword Planner has no data), or why there are none. */
export type VolumeAnswer = { ok: true; market: string; volumes: Map<string, number | null> } | { ok: false; reason: string }

/**
 * Read `seo_keyword_volumes`'s answer: `- keyword: ~1300/mo, …` lines, `volume unknown`, and `No data: a, b.`.
 * @param text - the tool's text.
 * @param asked - the keywords asked for.
 * @returns the market line and each keyword's volume.
 */
export function parseVolumes(text: string, asked: readonly string[]): { market: string; volumes: Map<string, number | null> } {
  const volumes = new Map<string, number | null>()
  for (const line of text.split('\n')) {
    const row = /^- (.+?): (?:~(\d+)\/mo|volume unknown)/u.exec(line)
    if (row !== null) volumes.set((row[1] ?? '').trim().toLowerCase(), row[2] === undefined ? null : Number(row[2]))
  }
  for (const keyword of asked) if (!volumes.has(keyword.toLowerCase())) volumes.set(keyword.toLowerCase(), null)
  return { market: (text.split('\n')[0] ?? '').replace(/:$/u, '').trim(), volumes }
}

/**
 * Build the Keyword Planner lookup.
 * @param route - the SEO employee's route and site.
 * @param fetcher - HTTP.
 * @returns a function answering volumes for up to 30 keywords.
 */
export function seoVolumes(
  route: SeoRoute, fetcher: typeof fetch = fetch,
): (keywords: string[], signal: AbortSignal) => Promise<VolumeAnswer> {
  return async (keywords, signal) => {
    const siteId = route.siteId().trim()
    if (route.url === '' || route.token === '') return { ok: false, reason: 'the SEO employee is not running here' }
    if (siteId === '') return { ok: false, reason: 'no SEO employee site is chosen for Keyword Planner on the tools employee card' }
    try {
      const response = await fetcher(route.url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${route.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'seo_keyword_volumes', args: { site_id: siteId, keywords: keywords.slice(0, 30) } }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
      })
      const body = await response.json() as { error?: unknown; result?: { text?: unknown } }
      if (body.error !== undefined) return { ok: false, reason: typeof body.error === 'string' ? body.error : JSON.stringify(body.error) }
      const text = typeof body.result?.text === 'string' ? body.result.text : ''
      if (!response.ok || text === '') return { ok: false, reason: `the SEO employee answered HTTP ${String(response.status)}` }
      return { ok: true, ...parseVolumes(text, keywords) }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }
}

/** Expected click-through rate by position, from public CTR studies; a page far below it needs a better title. */
export function expectedCtr(position: number): number {
  if (position < 1.5) return 0.28
  if (position < 2.5) return 0.15
  if (position < 3.5) return 0.11
  if (position < 4.5) return 0.08
  if (position < 5.5) return 0.06
  if (position <= 10) return 0.03
  return 0.01
}

/** One tool as the review sees it. */
export interface ReviewTool {
  slug: string
  url: string
  /** When it first went live; undefined when it never did. */
  publishedAt?: string
}

/** Thresholds of the review. */
export interface ReviewRules {
  /** Fewest impressions for a striking-distance or low-CTR query. */
  minImpressions: number
  /** A tool live this many days with no impressions is flagged for pruning. */
  pruneAfterDays: number
}

/**
 * Turn Search Console rows into the weekly review.
 * @param input - query-and-page rows for the last 28 days, page rows for the last 90, the tools, the time and rules.
 * @returns the review, and each tool's numbers and flag.
 */
export function review(input: {
  property: string
  queryPages: GscRow[]
  pages90: GscRow[]
  tools: ReviewTool[]
  now: Date
  rules: ReviewRules
}): { review: GscReview; perTool: Map<string, { clicks: number; impressions: number; ctr: number; position: number; flag?: string }> } {
  const { rules, now } = input
  const bySlug = (page: string | undefined): ReviewTool | undefined => input.tools.find(t => page !== undefined && page.replace(/[?#].*$/u, '').startsWith(t.url))
  const striking = strikingDistance(input.queryPages, { minImpressions: rules.minImpressions })
    .map(r => ({ query: r.query, page: r.page, impressions: r.impressions, position: Math.round(r.position * 10) / 10 }))
  const lowCtr = input.queryPages
    .filter(r => r.query !== undefined && r.page !== undefined && r.impressions >= rules.minImpressions * 2
      && r.position <= 10 && r.ctr < expectedCtr(r.position) / 2)
    .sort((a, b) => b.impressions - a.impressions)
    .map(r => ({ query: r.query ?? '', page: r.page ?? '', impressions: r.impressions, ctr: Math.round(r.ctr * 1000) / 1000, position: Math.round(r.position * 10) / 10 }))
  const perTool = new Map<string, { clicks: number; impressions: number; ctr: number; position: number; flag?: string }>()
  for (const tool of input.tools) {
    const rows = input.queryPages.filter(r => bySlug(r.page)?.slug === tool.slug)
    const clicks = rows.reduce((s, r) => s + r.clicks, 0)
    const impressions = rows.reduce((s, r) => s + r.impressions, 0)
    const position = impressions === 0 ? 0 : rows.reduce((s, r) => s + r.position * r.impressions, 0) / impressions
    const ctr = impressions === 0 ? 0 : clicks / impressions
    perTool.set(tool.slug, { clicks, impressions, ctr, position: Math.round(position * 10) / 10 })
  }
  const prune: string[] = []
  for (const tool of input.tools) {
    if (tool.publishedAt === undefined) continue
    const age = (now.getTime() - Date.parse(tool.publishedAt)) / 86_400_000
    const seen = input.pages90.filter(r => bySlug(r.page)?.slug === tool.slug).reduce((s, r) => s + r.impressions, 0)
    const entry = perTool.get(tool.slug)
    if (age >= rules.pruneAfterDays && seen === 0) {
      prune.push(tool.slug)
      if (entry !== undefined) entry.flag = `no impressions in ${String(Math.round(age))} days: improve it substantially or remove it (noindex) so it does not drag the site down`
    } else if (entry !== undefined) {
      const near = striking.filter(s => bySlug(s.page)?.slug === tool.slug)
      const weak = lowCtr.filter(s => bySlug(s.page)?.slug === tool.slug)
      if (weak.length > 0) entry.flag = `retitle: "${weak[0]?.query ?? ''}" shows it at ${String(weak[0]?.position ?? 0)} but few click`
      else if (near.length > 0) entry.flag = `improve: ${String(near.length)} queries at positions 5–20, such as "${near[0]?.query ?? ''}" (${String(near[0]?.position ?? 0)})`
    }
  }
  const totals = { clicks: 0, impressions: 0 }
  for (const r of input.queryPages) {
    totals.clicks += r.clicks
    totals.impressions += r.impressions
  }
  const summary = {
    at: now.toISOString(), property: input.property, striking: striking.slice(0, 40), lowCtr: lowCtr.slice(0, 20), prune, totals,
  }
  return { review: summary, perTool }
}

/**
 * Read the Search Console rows the review needs, for the site's pages only.
 * @param fetcher - HTTP.
 * @param token - an access token with a `webmasters` scope.
 * @param property - the Search Console property.
 * @param host - the site's host, to keep other sites in a domain property out.
 * @param now - the time.
 * @param signal - cancels the calls.
 * @returns query-and-page rows for 28 days and page rows for 90.
 */
export async function readSearchConsole(
  fetcher: typeof fetch, token: string, property: string, host: string, now: Date, signal: AbortSignal,
): Promise<{ queryPages: GscRow[]; pages90: GscRow[] }> {
  const filter = [{ filters: [{ dimension: 'page' as const, operator: 'contains' as const, expression: `//${host}/` }] }]
  const queryPages = await queryAll(fetcher, token, property, { ...gscWindow(now, 28), dimensions: ['query', 'page'], dimensionFilterGroups: filter }, 5000, signal)
  const pages90 = await queryAll(fetcher, token, property, { ...gscWindow(now, 90), dimensions: ['page'], dimensionFilterGroups: filter }, 1000, signal)
  return { queryPages, pages90 }
}
