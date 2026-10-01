/**
 * Google Search Console: the Webmasters v3 API (sites, Search Analytics,
 * sitemaps) and the v1 URL Inspection API, plus the reports the employee
 * derives from query-and-page rows (striking distance, cannibalization).
 * `strikingDistance` ports open-seo's `buildStrikingDistanceRows`
 * (MIT, see NOTICE.open-seo.md).
 */

import type { GscRow } from '../types.ts'

const API = 'https://www.googleapis.com/webmasters/v3'
const INSPECT = 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect'
const REQUEST_TIMEOUT_MS = 60_000
/** Search Analytics' largest page. */
const MAX_ROW_LIMIT = 25_000
/** Search Console data lags this many days behind today. */
const DATA_LAG_DAYS = 3
const DAY_MS = 86_400_000

/** A Search Analytics dimension. */
export type GscDimension = 'query' | 'page' | 'country' | 'device' | 'date'

/** One Search Analytics filter group, as the API takes it. */
export interface GscFilterGroup {
  groupType?: 'and'
  filters: {
    dimension: GscDimension
    operator?: 'contains' | 'equals' | 'notContains' | 'notEquals' | 'includingRegex' | 'excludingRegex'
    expression: string
  }[]
}

/** A Search Analytics query. */
export interface GscQuery {
  /** `YYYY-MM-DD`, inclusive. */
  startDate: string
  /** `YYYY-MM-DD`, inclusive. */
  endDate: string
  dimensions: GscDimension[]
  /** Rows per page, at most 25,000. */
  rowLimit?: number
  /** Zero-based offset of the first row. */
  startRow?: number
  dimensionFilterGroups?: GscFilterGroup[]
  searchType?: 'web'
}

/** A Search Console property the token can see. */
export interface GscSite {
  siteUrl: string
  permissionLevel: string
}

/** URL Inspection's index status for one page. */
export interface UrlInspection {
  /** `PASS`, `NEUTRAL`, `FAIL`, or `VERDICT_UNSPECIFIED`. */
  verdict: string
  /** Human-readable coverage, for example `Submitted and indexed`. */
  coverageState: string
  lastCrawlTime?: string
  googleCanonical?: string
}

/** A query whose best-ranking page sits just outside the top results. */
export interface StrikingDistanceRow {
  query: string
  page: string
  clicks: number
  impressions: number
  position: number
}

/** A query whose impressions split across several of the site's pages. */
export interface Cannibalization {
  query: string
  /** Pages with at least 20% of the query's impressions, most impressions first. */
  pages: { page: string; impressions: number; position: number }[]
}

/** Search Console refused a call. */
export class GscApiError extends Error {
  /** HTTP status. */
  readonly status: number

  /**
   * @param message - what failed, with Google's message.
   * @param status - HTTP status.
   */
  constructor(message: string, status: number) {
    super(message)
    this.name = 'GscApiError'
    this.status = status
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** Send one call; refusals become `GscApiError` with Google's message and never the token. */
async function call(
  fetcher: typeof fetch, accessToken: string, what: string, url: string,
  method: 'GET' | 'POST' | 'PUT', body: object | undefined, signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const response = await fetcher(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      ...body === undefined ? {} : { 'Content-Type': 'application/json' },
    },
    ...body === undefined ? {} : { body: JSON.stringify(body) },
    signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
  })
  const raw = await response.text()
  let parsed: Record<string, unknown> = {}
  if (raw !== '') {
    try {
      parsed = record(JSON.parse(raw))
    } catch (error) {
      // A non-JSON body (an HTML error page) has no fields to read; the HTTP status still describes the outcome.
      void error
    }
  }
  if (response.ok) return parsed
  const message = text(record(parsed['error'])['message'])
  const hint = response.status === 401 ? ' Press Connect Google again.' : ''
  const detail = message === '' ? '' : `: ${message}`
  throw new GscApiError(`Search Console ${what} failed (HTTP ${String(response.status)})${detail}.${hint}`, response.status)
}

/**
 * The Search Console properties the token can see.
 * @param fetcher - HTTP.
 * @param accessToken - OAuth token with a `webmasters` scope.
 * @param signal - cancels the call.
 * @returns each property and the token's permission on it.
 */
export async function listSites(fetcher: typeof fetch, accessToken: string, signal: AbortSignal): Promise<GscSite[]> {
  const body = await call(fetcher, accessToken, 'site list', `${API}/sites`, 'GET', undefined, signal)
  return list(body['siteEntry']).map(record).flatMap((entry) => {
    const siteUrl = text(entry['siteUrl'])
    return siteUrl === '' ? [] : [{ siteUrl, permissionLevel: text(entry['permissionLevel']) }]
  })
}

/**
 * One page of Search Analytics rows.
 * @param fetcher - HTTP.
 * @param accessToken - OAuth token with a `webmasters` scope.
 * @param property - `sc-domain:example.com` or a URL-prefix property such as `https://example.com/`.
 * @param query - dates, dimensions, paging, and filters.
 * @param signal - cancels the call.
 * @returns rows with one key field per requested dimension.
 */
export async function querySearchAnalytics(
  fetcher: typeof fetch, accessToken: string, property: string, query: GscQuery, signal: AbortSignal,
): Promise<GscRow[]> {
  const rowLimit = Math.min(Math.max(query.rowLimit ?? 1000, 1), MAX_ROW_LIMIT)
  const url = `${API}/sites/${encodeURIComponent(property)}/searchAnalytics/query`
  const body = await call(fetcher, accessToken, 'search analytics query', url, 'POST', {
    startDate: query.startDate,
    endDate: query.endDate,
    dimensions: query.dimensions,
    type: query.searchType ?? 'web',
    rowLimit,
    startRow: query.startRow ?? 0,
    ...query.dimensionFilterGroups === undefined ? {} : { dimensionFilterGroups: query.dimensionFilterGroups },
  }, signal)
  return list(body['rows']).map(record).map((row) => {
    const keys = list(row['keys'])
    const dims: Partial<Record<GscDimension, string>> = {}
    query.dimensions.forEach((dimension, index) => {
      const key = keys[index]
      if (typeof key === 'string') dims[dimension] = key
    })
    return {
      ...dims, clicks: num(row['clicks']), impressions: num(row['impressions']), ctr: num(row['ctr']), position: num(row['position']),
    }
  })
}

/**
 * Every Search Analytics row up to `maxRows`, paging by `startRow`.
 * @param fetcher - HTTP.
 * @param accessToken - OAuth token with a `webmasters` scope.
 * @param property - the Search Console property.
 * @param query - dates, dimensions, and filters; `rowLimit` sets the page size and `startRow` the first offset.
 * @param maxRows - stop after this many rows.
 * @param signal - cancels the calls.
 * @returns at most `maxRows` rows.
 */
export async function queryAll(
  fetcher: typeof fetch, accessToken: string, property: string, query: GscQuery, maxRows: number, signal: AbortSignal,
): Promise<GscRow[]> {
  const pageSize = Math.min(Math.max(query.rowLimit ?? MAX_ROW_LIMIT, 1), MAX_ROW_LIMIT)
  const rows: GscRow[] = []
  let startRow = query.startRow ?? 0
  while (rows.length < maxRows) {
    const limit = Math.min(pageSize, maxRows - rows.length)
    const page = await querySearchAnalytics(fetcher, accessToken, property, { ...query, rowLimit: limit, startRow }, signal)
    rows.push(...page)
    if (page.length < limit) break
    startRow += page.length
  }
  return rows
}

/**
 * Reduce query-and-page rows to one row per query: the site's best-ranking
 * page for it (lowest position; ties go to more impressions), kept only when
 * that page sits inside the position band. A query where any page already
 * ranks above the band is dropped, since improving a secondary page will not
 * move its traffic.
 * @param rows - rows with `query` and `page`; others are ignored.
 * @param options - position band and impression floor; defaults 5–20 and 50.
 * @returns the rows, most impressions first.
 */
export function strikingDistance(
  rows: GscRow[], options: { minPosition?: number; maxPosition?: number; minImpressions?: number } = {},
): StrikingDistanceRow[] {
  const { minPosition = 5, maxPosition = 20, minImpressions = 50 } = options
  const best = new Map<string, StrikingDistanceRow>()
  for (const row of rows) {
    if (row.query === undefined || row.query === '' || row.page === undefined || row.page === '') continue
    const current = best.get(row.query)
    const better = current === undefined || row.position < current.position
      || (row.position === current.position && row.impressions > current.impressions)
    if (!better) continue
    best.set(row.query, { query: row.query, page: row.page, clicks: row.clicks, impressions: row.impressions, position: row.position })
  }
  return [...best.values()]
    .filter(row => row.position >= minPosition && row.position <= maxPosition && row.impressions >= minImpressions)
    .sort((a, b) => b.impressions - a.impressions)
}

/**
 * Queries whose impressions split across two or more pages that each hold at
 * least 20% of them. Rows repeating a query and page (for example per date)
 * are summed, with position weighted by impressions.
 * @param rows - rows with `query` and `page`; others are ignored.
 * @returns the queries, most total impressions first.
 */
export function cannibalization(rows: GscRow[]): Cannibalization[] {
  const byQuery = new Map<string, Map<string, { impressions: number; weighted: number }>>()
  for (const row of rows) {
    if (row.query === undefined || row.query === '' || row.page === undefined || row.page === '') continue
    const pages = byQuery.get(row.query) ?? new Map<string, { impressions: number; weighted: number }>()
    byQuery.set(row.query, pages)
    const entry = pages.get(row.page) ?? { impressions: 0, weighted: 0 }
    entry.impressions += row.impressions
    entry.weighted += row.position * row.impressions
    pages.set(row.page, entry)
  }
  const result: (Cannibalization & { total: number })[] = []
  for (const [query, pages] of byQuery) {
    const total = [...pages.values()].reduce((sum, p) => sum + p.impressions, 0)
    if (total === 0) continue
    const split = [...pages]
      .filter(([, p]) => p.impressions / total >= 0.2)
      .map(([page, p]) => ({ page, impressions: p.impressions, position: p.weighted / p.impressions }))
      .sort((a, b) => b.impressions - a.impressions)
    if (split.length >= 2) result.push({ query, pages: split, total })
  }
  return result.sort((a, b) => b.total - a.total).map(({ query, pages }) => ({ query, pages }))
}

/**
 * Submit (or resubmit) a sitemap to a property.
 * @param fetcher - HTTP.
 * @param accessToken - OAuth token with the full `webmasters` scope.
 * @param property - the Search Console property.
 * @param sitemapUrl - absolute sitemap URL inside the property.
 * @param signal - cancels the call.
 * @returns resolves once Google accepts the submission.
 */
export async function submitSitemap(
  fetcher: typeof fetch, accessToken: string, property: string, sitemapUrl: string, signal: AbortSignal,
): Promise<void> {
  const url = `${API}/sites/${encodeURIComponent(property)}/sitemaps/${encodeURIComponent(sitemapUrl)}`
  await call(fetcher, accessToken, 'sitemap submission', url, 'PUT', undefined, signal)
}

/**
 * Google's index status for one page.
 * @param fetcher - HTTP.
 * @param accessToken - OAuth token with a `webmasters` scope.
 * @param property - the Search Console property the page belongs to.
 * @param url - the page.
 * @param signal - cancels the call.
 * @returns verdict, coverage, and, when Google has them, the last crawl time and Google's chosen canonical.
 */
export async function inspectUrl(
  fetcher: typeof fetch, accessToken: string, property: string, url: string, signal: AbortSignal,
): Promise<UrlInspection> {
  const body = await call(fetcher, accessToken, 'URL inspection', INSPECT, 'POST', { inspectionUrl: url, siteUrl: property }, signal)
  const status = record(record(body['inspectionResult'])['indexStatusResult'])
  const lastCrawlTime = text(status['lastCrawlTime'])
  const googleCanonical = text(status['googleCanonical'])
  return {
    verdict: text(status['verdict']) || 'VERDICT_UNSPECIFIED',
    coverageState: text(status['coverageState']),
    ...lastCrawlTime === '' ? {} : { lastCrawlTime },
    ...googleCanonical === '' ? {} : { googleCanonical },
  }
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/**
 * The most recent `days`-day window Search Console has data for, in UTC.
 * @param now - the current time.
 * @param days - window length in days, at least 1.
 * @returns `endDate` three days before `now`, and `startDate` so the window spans `days` days inclusive.
 */
export function gscWindow(now: Date, days: number): { startDate: string; endDate: string } {
  const end = now.getTime() - DATA_LAG_DAYS * DAY_MS
  return { startDate: isoDate(end - (Math.max(days, 1) - 1) * DAY_MS), endDate: isoDate(end) }
}
