/**
 * Keyword Planner through the Google Ads API REST interface:
 * `KeywordPlanIdeaService.GenerateKeywordIdeas` and
 * `GenerateKeywordHistoricalMetrics`. Calls for one customer are spaced at
 * least 1.1 s apart, quota refusals are retried with Google's suggested delay,
 * and every other refusal becomes an `AdsApiError` carrying Google's message
 * and request id but never a token.
 */

import type { AdsCompetition, KeywordIdea } from '../types.ts'

/** Google Ads geo target constant ids for the markets the employee serves. */
export const MARKETS = {
  Nigeria: '2566',
  Ghana: '2288',
  Kenya: '2404',
  'South Africa': '2710',
  'United States': '2840',
  'United Kingdom': '2826',
} as const

/** Google Ads language constant id for English. */
export const ENGLISH = '1000'

/** Minimum spacing between keyword-planning calls for one customer. */
const KEYWORD_PLAN_SPACING_MS = 1100
/** Delays before the first and second retry of a quota refusal that names no delay. */
const QUOTA_BACKOFF_MS = [2000, 8000] as const
/** A suggested delay longer than this means a daily quota; waiting inside a request is pointless. */
const MAX_QUOTA_WAIT_MS = 60_000
const REQUEST_TIMEOUT_MS = 60_000
/** Google's limit on keywords in a `keywordSeed` or `keywordAndUrlSeed`. */
const MAX_SEED_KEYWORDS = 20
const MONTHS = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER']
const COMPETITION: readonly AdsCompetition[] = ['UNSPECIFIED', 'UNKNOWN', 'LOW', 'MEDIUM', 'HIGH']
/** Symbols Keyword Planner rejects in a keyword. */
const UNPLANNABLE_SYMBOLS = /[!@%,*;^=(){}~`<>?\\|]/u

/** Sleeps for a duration; rejects with the signal's reason when aborted. */
export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>

/** The signal's abort reason as an Error; a non-Error reason is wrapped. */
function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  return reason instanceof Error ? reason : new Error(String(reason))
}

/**
 * Sleep that wakes early when `signal` aborts.
 * @param ms - milliseconds.
 * @param signal - cancels the wait.
 * @returns resolves after `ms`.
 */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortReason(signal))
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(abortReason(signal))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Serializes keyword-planning calls per customer id, starting each at least
 * 1.1 s after the previous one for the same customer finished.
 */
export class KeywordPlanQueue {
  private readonly tails = new Map<string, Promise<void>>()
  private readonly lastEnd = new Map<string, number>()

  /**
   * @param now - clock in epoch milliseconds.
   * @param sleep - waits; also used for quota retry delays.
   */
  constructor(readonly now: () => number = Date.now, readonly sleep: Sleep = abortableSleep) {}

  /**
   * Run `task` once earlier calls for `customerId` finished and the spacing elapsed.
   * @param customerId - Google Ads customer id, digits only.
   * @param task - the HTTP call.
   * @param signal - cancels the wait.
   * @returns what `task` returns.
   */
  async run<T>(customerId: string, task: () => Promise<T>, signal: AbortSignal): Promise<T> {
    const previous = this.tails.get(customerId) ?? Promise.resolve()
    let release = (): void => {}
    const tail = new Promise<void>((resolve) => {
      release = resolve
    })
    this.tails.set(customerId, tail)
    try {
      await previous
      const last = this.lastEnd.get(customerId)
      const wait = last === undefined ? 0 : last + KEYWORD_PLAN_SPACING_MS - this.now()
      if (wait > 0) await this.sleep(wait, signal)
      return await task()
    } finally {
      this.lastEnd.set(customerId, this.now())
      if (this.tails.get(customerId) === tail) this.tails.delete(customerId)
      release()
    }
  }
}

/** Queue shared by calls that pass none. */
const sharedQueue = new KeywordPlanQueue()

/** Google refused for quota (`RESOURCE_EXHAUSTED`) and the retries ran out. */
export class AdsQuotaError extends Error {
  /** Google's suggested wait, when it gave one. */
  readonly retryAfterMs: number | undefined
  /** Google's `request-id` response header. */
  readonly requestId: string | undefined

  /**
   * @param message - Google's message.
   * @param retryAfterMs - Google's suggested wait.
   * @param requestId - Google's request id.
   */
  constructor(message: string, retryAfterMs: number | undefined, requestId: string | undefined) {
    super(message)
    this.name = 'AdsQuotaError'
    this.retryAfterMs = retryAfterMs
    this.requestId = requestId
  }
}

/** Google Ads refused a call for a reason other than quota. */
export class AdsApiError extends Error {
  /** HTTP status. */
  readonly status: number
  /** Google's `error.status`, for example `PERMISSION_DENIED`. */
  readonly googleStatus: string
  /** Google's `request-id` response header. */
  readonly requestId: string | undefined

  /**
   * @param message - what failed, with Google's message.
   * @param status - HTTP status.
   * @param googleStatus - Google's `error.status`.
   * @param requestId - Google's request id.
   */
  constructor(message: string, status: number, googleStatus: string, requestId: string | undefined) {
    super(message)
    this.name = 'AdsApiError'
    this.status = status
    this.googleStatus = googleStatus
    this.requestId = requestId
  }
}

/** How calls authenticate to the Google Ads API. */
export interface AdsAuth {
  /** A valid OAuth access token with the `adwords` scope. */
  accessToken: (signal: AbortSignal) => Promise<string>
  /**
   * A legacy developer token. Since Google sunset developer tokens (2026-09-09) the access level comes from the Cloud
   * project behind the OAuth client or service account, and the header is optional and ignored; it is sent only when set.
   */
  developerToken?: string
  /** Manager account the call goes through; dashes allowed. */
  loginCustomerId?: string
  /** Spacing queue; defaults to one shared by the process. */
  queue?: KeywordPlanQueue
}

/** Where Keyword Planner ideas come from. */
export interface KeywordIdeasRequest {
  /** Customer id; dashes allowed. */
  customerId: string
  /** Seed keywords; unplannable ones are dropped. */
  keywords?: string[]
  /** Seed page. Combined with `keywords` it makes a keyword-and-URL seed. */
  url?: string
  /** Seed domain; cannot be combined with `keywords` or `url`. */
  site?: string
  /** Geo target constant ids; empty means worldwide. */
  geoIds: string[]
  /** Language constant id; empty or absent means all languages. */
  languageId?: string
  /** Defaults to `GOOGLE_SEARCH`. */
  network?: 'GOOGLE_SEARCH' | 'GOOGLE_SEARCH_AND_PARTNERS'
  /** Ideas per page; defaults to 200. */
  pageSize?: number
  /** Stop after this many ideas; absent follows every page. */
  maxResults?: number
}

/** Exact keywords to read metrics for. */
export interface KeywordMetricsRequest {
  /** Customer id; dashes allowed. */
  customerId: string
  /** Keywords; unplannable ones are dropped. */
  keywords: string[]
  geoIds: string[]
  languageId?: string
  network?: 'GOOGLE_SEARCH' | 'GOOGLE_SEARCH_AND_PARTNERS'
}

/**
 * Whether Keyword Planner accepts a keyword: at most 80 characters, at most
 * 10 words, and none of the symbols it rejects.
 * @param text - the keyword.
 * @returns true when it can be sent as a seed or a metrics keyword.
 */
export function isPlannableKeyword(text: string): boolean {
  const trimmed = text.trim()
  return trimmed !== '' && trimmed.length <= 80 && trimmed.split(/\s+/u).length <= 10 && !UNPLANNABLE_SYMBOLS.test(trimmed)
}

function customerDigits(id: string, label: string): string {
  const digits = id.replace(/-/gu, '').trim()
  if (!/^\d+$/u.test(digits)) {
    throw new Error(`The Google Ads ${label} "${id}" is not a customer id; use the 10 digits shown in Google Ads.`)
  }
  return digits
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

/** Parse an int64 (JSON string) or number; undefined when absent or not numeric. */
function int64(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string' || value === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** Parse a protobuf Duration string such as `30s` or `1.5s`. */
function durationMs(value: unknown): number | undefined {
  const match = /^(\d+(?:\.\d+)?)s$/u.exec(text(value))
  return match?.[1] === undefined ? undefined : Math.round(Number(match[1]) * 1000)
}

/** Read Keyword Planner metrics (`keywordIdeaMetrics` or `keywordMetrics`) into a `KeywordIdea`. */
function toIdea(keyword: string, metricsValue: unknown): KeywordIdea {
  const metrics = record(metricsValue)
  const competitionText = text(metrics['competition'])
  const competition = COMPETITION.find(value => value === competitionText) ?? 'UNSPECIFIED'
  const avg = int64(metrics['avgMonthlySearches'])
  const index = int64(metrics['competitionIndex'])
  const low = int64(metrics['lowTopOfPageBidMicros'])
  const high = int64(metrics['highTopOfPageBidMicros'])
  const monthly = list(metrics['monthlySearchVolumes']).map(record).flatMap((row) => {
    const year = int64(row['year'])
    const month = MONTHS.indexOf(text(row['month'])) + 1
    if (year === undefined || month === 0) return []
    return [{ year, month, searches: int64(row['monthlySearches']) ?? 0 }]
  })
  return {
    text: keyword,
    ...avg === undefined ? {} : { avgMonthlySearches: avg },
    monthly,
    competition,
    ...index === undefined ? {} : { competitionIndex: index },
    ...low === undefined ? {} : { lowTopOfPageBidMicros: low },
    ...high === undefined ? {} : { highTopOfPageBidMicros: high },
  }
}

/** Google's error JSON, read leniently: top-level message/status plus any quota retry delay in the Ads failure details. */
function parseError(body: string): { message: string; status: string; retryAfterMs: number | undefined } {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch (error) {
    // A non-JSON body (a proxy's HTML page) has no Google error fields; the HTTP status describes the failure.
    void error
    return { message: '', status: '', retryAfterMs: undefined }
  }
  const error = record(record(parsed)['error'])
  let retryAfterMs: number | undefined
  const messages: string[] = []
  for (const detail of list(error['details']).map(record)) {
    for (const failure of list(detail['errors']).map(record)) {
      const message = text(failure['message'])
      if (message !== '') messages.push(message)
      retryAfterMs ??= durationMs(record(record(failure['details'])['quotaErrorDetails'])['retryDelay'])
    }
    retryAfterMs ??= durationMs(detail['retryDelay'])
  }
  const top = text(error['message'])
  const message = [top, ...messages.filter(m => m !== top)].filter(Boolean).join(' ')
  return { message, status: text(error['status']), retryAfterMs }
}

/** POST one Keyword Planner call through the queue, retrying quota refusals up to twice. */
async function post(
  fetcher: typeof fetch, auth: AdsAuth, customerId: string, method: string, body: object, signal: AbortSignal, apiVersion: string,
): Promise<Record<string, unknown>> {
  const queue = auth.queue ?? sharedQueue
  const url = `https://googleads.googleapis.com/${apiVersion}/customers/${customerId}:${method}`
  const login = auth.loginCustomerId === undefined || auth.loginCustomerId === ''
    ? undefined : customerDigits(auth.loginCustomerId, 'login customer id')
  for (let attempt = 0; ; attempt++) {
    const outcome = await queue.run(customerId, async () => {
      const token = await auth.accessToken(signal)
      const response = await fetcher(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          ...auth.developerToken === undefined || auth.developerToken === '' ? {} : { 'developer-token': auth.developerToken },
          'Content-Type': 'application/json',
          ...login === undefined ? {} : { 'login-customer-id': login },
        },
        body: JSON.stringify(body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      })
      return { response, text: await response.text() }
    }, signal)
    const { response } = outcome
    if (response.ok) return record(JSON.parse(outcome.text))
    const requestId = response.headers.get('request-id') ?? undefined
    const error = parseError(outcome.text)
    const message = error.message === '' ? `HTTP ${String(response.status)}` : error.message
    if (response.status === 429 || error.status === 'RESOURCE_EXHAUSTED') {
      const delay = error.retryAfterMs ?? QUOTA_BACKOFF_MS[attempt]
      if (attempt >= QUOTA_BACKOFF_MS.length || delay === undefined || delay > MAX_QUOTA_WAIT_MS) {
        throw new AdsQuotaError(`Google Ads quota exhausted for ${method}: ${message}`, error.retryAfterMs, requestId)
      }
      await queue.sleep(delay, signal)
      continue
    }
    const statusText = `HTTP ${String(response.status)}${error.status === '' ? '' : ` ${error.status}`}`
    const idText = requestId === undefined ? '' : ` [request-id ${requestId}]`
    throw new AdsApiError(`Google Ads ${method} failed (${statusText}): ${message}${idText}`, response.status, error.status, requestId)
  }
}

function targeting(geoIds: string[], languageId: string | undefined, network: string | undefined): Record<string, unknown> {
  const geos = geoIds.filter(id => id !== '')
  return {
    ...geos.length === 0 ? {} : { geoTargetConstants: geos.map(id => `geoTargetConstants/${id}`) },
    ...languageId === undefined || languageId === '' ? {} : { language: `languageConstants/${languageId}` },
    includeAdultKeywords: false,
    keywordPlanNetwork: network ?? 'GOOGLE_SEARCH',
  }
}

function seed(request: KeywordIdeasRequest): Record<string, unknown> {
  const keywords = (request.keywords ?? []).map(k => k.trim()).filter(isPlannableKeyword)
  const url = request.url ?? ''
  const site = request.site ?? ''
  if (keywords.length > MAX_SEED_KEYWORDS) {
    throw new Error(`Keyword Planner takes at most ${String(MAX_SEED_KEYWORDS)} seed keywords; got ${String(keywords.length)}.`)
  }
  if (site !== '') {
    if (keywords.length > 0 || url !== '') throw new Error('A site seed cannot be combined with seed keywords or a seed URL.')
    return { siteSeed: { site } }
  }
  if (keywords.length > 0 && url !== '') return { keywordAndUrlSeed: { url, keywords } }
  if (keywords.length > 0) return { keywordSeed: { keywords } }
  if (url !== '') return { urlSeed: { url } }
  throw new Error('Keyword Planner needs a seed: at least one plannable keyword, a URL, or a site.')
}

/**
 * Keyword ideas from Keyword Planner, following pages until `maxResults`.
 * @param fetcher - HTTP.
 * @param auth - access token source, developer token, optional manager account.
 * @param request - seeds, targeting, and paging.
 * @param signal - cancels the calls.
 * @param apiVersion - Google Ads API version path segment.
 * @returns the ideas, at most `maxResults`.
 * @throws AdsQuotaError after quota retries run out; AdsApiError for other refusals.
 */
export async function generateKeywordIdeas(
  fetcher: typeof fetch, auth: AdsAuth, request: KeywordIdeasRequest, signal: AbortSignal, apiVersion = 'v25',
): Promise<KeywordIdea[]> {
  const customerId = customerDigits(request.customerId, 'customer id')
  const base = { ...seed(request), ...targeting(request.geoIds, request.languageId, request.network), pageSize: request.pageSize ?? 200 }
  const ideas: KeywordIdea[] = []
  let pageToken = ''
  do {
    const body = await post(fetcher, auth, customerId, 'generateKeywordIdeas', {
      ...base, ...pageToken === '' ? {} : { pageToken },
    }, signal, apiVersion)
    for (const row of list(body['results']).map(record)) {
      const keyword = text(row['text'])
      if (keyword !== '') ideas.push(toIdea(keyword, row['keywordIdeaMetrics']))
    }
    pageToken = text(body['nextPageToken'])
  } while (pageToken !== '' && (request.maxResults === undefined || ideas.length < request.maxResults))
  return request.maxResults === undefined ? ideas : ideas.slice(0, request.maxResults)
}

/**
 * Search volume and competition for exact keywords.
 * @param fetcher - HTTP.
 * @param auth - access token source, developer token, optional manager account.
 * @param request - keywords and targeting.
 * @param signal - cancels the call.
 * @param apiVersion - Google Ads API version path segment.
 * @returns one entry per keyword Google reports on; empty when no keyword is plannable.
 * @throws AdsQuotaError after quota retries run out; AdsApiError for other refusals.
 */
export async function generateKeywordHistoricalMetrics(
  fetcher: typeof fetch, auth: AdsAuth, request: KeywordMetricsRequest, signal: AbortSignal, apiVersion = 'v25',
): Promise<KeywordIdea[]> {
  const customerId = customerDigits(request.customerId, 'customer id')
  const keywords = [...new Set(request.keywords.map(k => k.trim()).filter(isPlannableKeyword))]
  if (keywords.length === 0) return []
  const body = await post(fetcher, auth, customerId, 'generateKeywordHistoricalMetrics', {
    keywords, ...targeting(request.geoIds, request.languageId, request.network),
  }, signal, apiVersion)
  return list(body['results']).map(record).flatMap((row) => {
    const keyword = text(row['text'])
    return keyword === '' ? [] : [toIdea(keyword, row['keywordMetrics'])]
  })
}
