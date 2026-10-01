/**
 * Search campaign management through the Google Ads API REST interface:
 * account and conversion reads, one atomic `GoogleAdsService.Mutate` that
 * builds a paused Search campaign, status, budget and negative-keyword edits,
 * and campaign and search-term reports. Every refusal becomes an
 * `AdsRequestError` (an `AdsApiError`) naming Google's first error code and
 * request id, or an `AdsQuotaError`; neither ever carries the access token.
 */

import { AdsApiError, AdsQuotaError, type AdsAuth } from '../google/ads.ts'

const REQUEST_TIMEOUT_MS = 60_000
/** Most `googleAds:search` pages one report follows. */
const MAX_SEARCH_PAGES = 10
/** `DURING` ranges GAQL accepts for a trailing window that excludes today. */
const DURING_RANGES = new Set([7, 14, 30])

const HEADLINES = { min: 3, max: 15, chars: 30 } as const
const DESCRIPTIONS = { min: 2, max: 4, chars: 90 } as const
const PATH_CHARS = 15
const KEYWORDS = { min: 1, max: 50, chars: 80, words: 10 } as const
/** Code points Google counts as two characters in ad text: CJK, Hangul, kana, full-width forms. */
const DOUBLE_WIDTH = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{20000}-\u{3FFFD}]/u

/** The account behind a customer id. */
export interface AdsAccountDetails {
  /** Digits only. */
  customerId: string
  name: string
  /** ISO 4217 code, for example `NGN`. */
  currencyCode: string
  /** IANA zone, for example `Africa/Lagos`. */
  timeZone: string
  testAccount: boolean
  /** Google's `CustomerStatus`: `ENABLED`, `CANCELED`, `SUSPENDED`, `CLOSED`. */
  status: string
  manager: boolean
}

/** A conversion action that is not removed. */
export interface AdsConversionAction {
  name: string
  /** `ENABLED` or `HIDDEN`. */
  status: string
  /** Google's `ConversionActionCategory`, for example `PURCHASE`. */
  category: string
  primaryForGoal: boolean
}

/** A keyword the new ad group bids on. */
export interface SearchKeyword {
  text: string
  match: 'EXACT' | 'PHRASE'
}

/** The responsive search ad the new ad group serves. */
export interface ResponsiveSearchAdSpec {
  /** `https://` landing page. */
  finalUrl: string
  /** 3–15 headlines of at most 30 characters. */
  headlines: string[]
  /** 2–4 descriptions of at most 90 characters. */
  descriptions: string[]
  /** Display path segments of at most 15 characters; `path2` needs `path1`. */
  path1?: string
  path2?: string
}

/** Everything one Search campaign needs. */
export interface SearchCampaignSpec {
  name: string
  /** Daily budget in micros of the account currency. */
  dailyBudgetMicros: number
  /** Maximize-clicks CPC ceiling in micros. */
  cpcCeilingMicros: number
  /** Geo target constant ids; at least one. */
  geoIds: string[]
  /** Language constant id; absent targets all languages. */
  languageId?: string
  /** 1–50 keywords of at most 80 characters and 10 words. */
  keywords: SearchKeyword[]
  /** Campaign-level negative keywords, phrase match. */
  negatives: string[]
  ad: ResponsiveSearchAdSpec
}

/** Resource names of what `createSearchCampaign` made. */
export interface CreatedSearchCampaign {
  campaign: string
  budget: string
  adGroup: string
}

/** One Search campaign's totals over a report window. */
export interface CampaignReportRow {
  resourceName: string
  /** int64 id as Google returns it. */
  id: string
  name: string
  status: string
  budgetResourceName: string
  dailyBudgetMicros: number
  costMicros: number
  clicks: number
  impressions: number
  conversions: number
}

/** One search term's totals across the campaign's ad groups. */
export interface SearchTermRow {
  term: string
  costMicros: number
  clicks: number
  impressions: number
  conversions: number
}

/** Google Ads refused a call; carries Google's error codes as `<errorCodeField>: <ENUM>`. */
export class AdsRequestError extends AdsApiError {
  /** Every error code in Google's failure, for example `campaignError: DUPLICATE_CAMPAIGN_NAME`. */
  readonly errorCodes: string[]

  /**
   * @param message - what failed, with Google's message.
   * @param status - HTTP status.
   * @param googleStatus - Google's `error.status`.
   * @param requestId - Google's request id.
   * @param errorCodes - Google's error codes.
   */
  constructor(message: string, status: number, googleStatus: string, requestId: string | undefined, errorCodes: string[]) {
    super(message, status, googleStatus, requestId)
    this.name = 'AdsRequestError'
    this.errorCodes = errorCodes
  }

  /** The first error code, which names the main reason. */
  get errorCode(): string | undefined {
    return this.errorCodes[0]
  }
}

/**
 * Whether Google refused because the account is not enabled (suspended,
 * cancelled, or not yet set up): `authorizationError: CUSTOMER_NOT_ENABLED`.
 * @param error - anything thrown by a Google Ads call.
 * @returns true for that refusal.
 */
export function isAccountNotEnabled(error: unknown): boolean {
  if (error instanceof AdsRequestError) return error.errorCodes.includes('authorizationError: CUSTOMER_NOT_ENABLED')
  return error instanceof AdsApiError && error.message.includes('CUSTOMER_NOT_ENABLED')
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

/** An int64 (JSON string) or double; 0 when absent, since proto3 JSON omits zero values. */
function num(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (typeof value !== 'string' || value === '') return 0
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/** An int64 rendered as Google returns it; a number becomes its decimal string. */
function int64Text(value: unknown): string {
  return typeof value === 'number' ? String(value) : text(value)
}

/** Google's error JSON: message, status, error codes, and the request id in the Ads failure details. */
function parseError(body: string): { message: string; status: string; codes: string[]; requestId: string | undefined } {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch (error) {
    // A non-JSON body (a proxy's HTML page) has no Google error fields; the HTTP status describes the failure.
    void error
    return { message: '', status: '', codes: [], requestId: undefined }
  }
  const error = record(record(parsed)['error'])
  const messages: string[] = []
  const codes: string[] = []
  let requestId: string | undefined
  for (const detail of list(error['details']).map(record)) {
    const id = text(detail['requestId'])
    if (id !== '') requestId ??= id
    for (const failure of list(detail['errors']).map(record)) {
      const message = text(failure['message'])
      if (message !== '') messages.push(message)
      for (const [field, code] of Object.entries(record(failure['errorCode']))) {
        if (typeof code === 'string') codes.push(`${field}: ${code}`)
      }
    }
  }
  const top = text(error['message'])
  const message = [top, ...messages.filter(m => m !== top)].filter(Boolean).join(' ')
  return { message, status: text(error['status']), codes, requestId }
}

/** POST one call under `customers/{id}/`; maps refusals to `AdsQuotaError` or `AdsRequestError`. */
async function adsPost(
  fetcher: typeof fetch, auth: AdsAuth, customerId: string, method: string, body: object, signal: AbortSignal, apiVersion: string,
): Promise<Record<string, unknown>> {
  const url = `https://googleads.googleapis.com/${apiVersion}/customers/${customerId}/${method}`
  const login = auth.loginCustomerId === undefined || auth.loginCustomerId === ''
    ? undefined : customerDigits(auth.loginCustomerId, 'login customer id')
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
  const responseText = await response.text()
  if (response.ok) return record(JSON.parse(responseText))
  const error = parseError(responseText)
  const requestId = response.headers.get('request-id') ?? error.requestId
  const detail = [error.codes[0], error.message].filter(Boolean).join(' — ') || 'no detail'
  const safe = token === '' ? detail : detail.split(token).join('[redacted]')
  const idText = requestId === undefined ? '' : ` [request-id ${requestId}]`
  if (response.status === 429 || error.status === 'RESOURCE_EXHAUSTED') {
    throw new AdsQuotaError(`Google Ads quota exhausted for ${method}: ${safe}${idText}`, undefined, requestId)
  }
  const statusText = `HTTP ${String(response.status)}${error.status === '' ? '' : ` ${error.status}`}`
  throw new AdsRequestError(`Google Ads ${method} failed (${statusText}): ${safe}${idText}`,
    response.status, error.status, requestId, error.codes)
}

/** Run a GAQL query, following `nextPageToken` for at most ten pages. */
async function search(
  fetcher: typeof fetch, auth: AdsAuth, customerId: string, query: string, signal: AbortSignal, apiVersion: string,
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = []
  let pageToken = ''
  for (let page = 0; page < MAX_SEARCH_PAGES; page++) {
    const body = await adsPost(fetcher, auth, customerId, 'googleAds:search', {
      query, ...pageToken === '' ? {} : { pageToken },
    }, signal, apiVersion)
    rows.push(...list(body['results']).map(record))
    pageToken = text(body['nextPageToken'])
    if (pageToken === '') break
  }
  return rows
}

/** Characters as Google counts them in ad text: double-width scripts count twice. */
function adLength(value: string): number {
  let length = 0
  for (const char of value) length += DOUBLE_WIDTH.test(char) ? 2 : 1
  return length
}

function keywordProblems(label: string, value: string): string[] {
  const trimmed = value.trim()
  if (trimmed === '') return [`${label} is empty.`]
  const problems: string[] = []
  if (trimmed.length > KEYWORDS.chars) problems.push(`${label} "${trimmed}" is longer than ${String(KEYWORDS.chars)} characters.`)
  if (trimmed.split(/\s+/u).length > KEYWORDS.words) problems.push(`${label} "${trimmed}" has more than ${String(KEYWORDS.words)} words.`)
  return problems
}

function textProblems(label: string, values: string[], limits: { min: number; max: number; chars: number }): string[] {
  const problems: string[] = []
  if (values.length < limits.min || values.length > limits.max) {
    problems.push(`${label}: need ${String(limits.min)}–${String(limits.max)}, got ${String(values.length)}.`)
  }
  values.forEach((value, index) => {
    if (value.trim() === '') problems.push(`${label} ${String(index + 1)} is empty.`)
    else if (adLength(value) > limits.chars) {
      problems.push(`${label} ${String(index + 1)} "${value}" is longer than ${String(limits.chars)} characters.`)
    }
  })
  return problems
}

function isHttps(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:'
  } catch (error) {
    void error
    return false
  }
}

function positiveMicros(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

/**
 * Every reason Google Ads would refuse a Search campaign spec, checked before anything is sent.
 * @param spec - the campaign.
 * @returns one sentence per problem; empty when the spec is sendable.
 */
export function validateSearchCampaign(spec: SearchCampaignSpec): string[] {
  const problems: string[] = []
  if (spec.name.trim() === '') problems.push('Campaign name is empty.')
  if (!positiveMicros(spec.dailyBudgetMicros)) problems.push('Daily budget must be a whole number of micros above 0.')
  if (!positiveMicros(spec.cpcCeilingMicros)) problems.push('CPC ceiling must be a whole number of micros above 0.')
  if (spec.geoIds.length === 0) problems.push('At least one location (geo target id) is required.')
  for (const id of spec.geoIds) if (!/^\d+$/u.test(id)) problems.push(`Geo target id "${id}" is not numeric.`)
  if (spec.languageId !== undefined && spec.languageId !== '' && !/^\d+$/u.test(spec.languageId)) {
    problems.push(`Language id "${spec.languageId}" is not numeric.`)
  }
  if (spec.keywords.length < KEYWORDS.min || spec.keywords.length > KEYWORDS.max) {
    problems.push(`Keywords: need ${String(KEYWORDS.min)}–${String(KEYWORDS.max)}, got ${String(spec.keywords.length)}.`)
  }
  for (const keyword of spec.keywords) problems.push(...keywordProblems('Keyword', keyword.text))
  for (const negative of spec.negatives) problems.push(...keywordProblems('Negative keyword', negative))
  problems.push(...textProblems('Headlines', spec.ad.headlines, HEADLINES))
  problems.push(...textProblems('Descriptions', spec.ad.descriptions, DESCRIPTIONS))
  if (!isHttps(spec.ad.finalUrl)) problems.push(`Final URL "${spec.ad.finalUrl}" must be an https:// address.`)
  const path1 = spec.ad.path1 ?? ''
  const path2 = spec.ad.path2 ?? ''
  if (adLength(path1) > PATH_CHARS) problems.push(`Path 1 "${path1}" is longer than ${String(PATH_CHARS)} characters.`)
  if (adLength(path2) > PATH_CHARS) problems.push(`Path 2 "${path2}" is longer than ${String(PATH_CHARS)} characters.`)
  if (path2 !== '' && path1 === '') problems.push('Path 2 needs path 1.')
  return problems
}

/** A campaign resource name under `customerId`, refusing anything that could not be one. */
function campaignName(customerId: string, resourceName: string): string {
  if (!new RegExp(`^customers/${customerId}/campaigns/\\d+$`, 'u').test(resourceName)) {
    throw new Error(`"${resourceName}" is not a campaign of customer ${customerId}.`)
  }
  return resourceName
}

/** The GAQL date condition for the trailing `days` days before today. */
function dateCondition(days: number, now: () => Date): string {
  if (!Number.isSafeInteger(days) || days < 1 || days > 365) throw new Error(`Report window must be 1–365 days; got ${String(days)}.`)
  if (DURING_RANGES.has(days)) return `segments.date DURING LAST_${String(days)}_DAYS`
  const day = (offset: number): string => new Date(now().getTime() - offset * 86_400_000).toISOString().slice(0, 10)
  return `segments.date BETWEEN '${day(days)}' AND '${day(1)}'`
}

/**
 * Describe the account behind a customer id.
 * @param fetcher - HTTP.
 * @param auth - access token source, optional manager account.
 * @param customerId - customer id; dashes allowed.
 * @param signal - cancels the call.
 * @param apiVersion - Google Ads API version path segment.
 * @returns the account's name, currency, zone, and status.
 * @throws AdsRequestError when Google refuses; `isAccountNotEnabled` spots a suspended or cancelled account.
 */
export async function getAccount(
  fetcher: typeof fetch, auth: AdsAuth, customerId: string, signal: AbortSignal, apiVersion = 'v25',
): Promise<AdsAccountDetails> {
  const id = customerDigits(customerId, 'customer id')
  const rows = await search(fetcher, auth, id, 'SELECT customer.id, customer.descriptive_name, customer.currency_code, '
    + 'customer.time_zone, customer.test_account, customer.status, customer.manager FROM customer LIMIT 1', signal, apiVersion)
  const customer = record(rows[0]?.['customer'])
  return {
    customerId: int64Text(customer['id']) || id,
    name: text(customer['descriptiveName']),
    currencyCode: text(customer['currencyCode']),
    timeZone: text(customer['timeZone']),
    testAccount: customer['testAccount'] === true,
    status: text(customer['status']) || 'UNKNOWN',
    manager: customer['manager'] === true,
  }
}

/**
 * The account's conversion actions that are not removed.
 * @param fetcher - HTTP.
 * @param auth - access token source, optional manager account.
 * @param customerId - customer id; dashes allowed.
 * @param signal - cancels the calls.
 * @param apiVersion - Google Ads API version path segment.
 * @returns name, status, category, and whether each counts toward the goal.
 * @throws AdsRequestError or AdsQuotaError when Google refuses.
 */
export async function listConversionActions(
  fetcher: typeof fetch, auth: AdsAuth, customerId: string, signal: AbortSignal, apiVersion = 'v25',
): Promise<AdsConversionAction[]> {
  const id = customerDigits(customerId, 'customer id')
  const rows = await search(fetcher, auth, id, 'SELECT conversion_action.name, conversion_action.status, conversion_action.category, '
    + "conversion_action.primary_for_goal FROM conversion_action WHERE conversion_action.status != 'REMOVED'", signal, apiVersion)
  return rows.map((row) => {
    const action = record(row['conversionAction'])
    return {
      name: text(action['name']),
      status: text(action['status']),
      category: text(action['category']),
      primaryForGoal: action['primaryForGoal'] === true,
    }
  })
}

/** The `mutateOperations` that build the campaign, with budget -1, campaign -2, ad group -3. */
function campaignOperations(customerId: string, spec: SearchCampaignSpec): object[] {
  const budget = `customers/${customerId}/campaignBudgets/-1`
  const campaign = `customers/${customerId}/campaigns/-2`
  const adGroup = `customers/${customerId}/adGroups/-3`
  const name = spec.name.trim()
  const criterion = (fields: object): object => ({ campaignCriterionOperation: { create: { campaign, ...fields } } })
  const languageId = spec.languageId ?? ''
  return [
    { campaignBudgetOperation: { create: {
      resourceName: budget, name: `${name} budget`, deliveryMethod: 'STANDARD',
      amountMicros: String(spec.dailyBudgetMicros), explicitlyShared: false,
    } } },
    { campaignOperation: { create: {
      resourceName: campaign,
      name,
      status: 'PAUSED',
      advertisingChannelType: 'SEARCH',
      campaignBudget: budget,
      networkSettings: {
        targetGoogleSearch: true, targetSearchNetwork: false, targetContentNetwork: false, targetPartnerSearchNetwork: false,
      },
      // Only people in the target countries, not people elsewhere who search about them.
      geoTargetTypeSetting: { positiveGeoTargetType: 'PRESENCE', negativeGeoTargetType: 'PRESENCE' },
      targetSpend: { cpcBidCeilingMicros: String(spec.cpcCeilingMicros) },
      containsEuPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
    } } },
    ...spec.geoIds.map(id => criterion({ location: { geoTargetConstant: `geoTargetConstants/${id}` } })),
    ...languageId === '' ? [] : [criterion({ language: { languageConstant: `languageConstants/${languageId}` } })],
    ...spec.negatives.map(negative => criterion({ negative: true, keyword: { text: negative.trim(), matchType: 'PHRASE' } })),
    { adGroupOperation: { create: {
      resourceName: adGroup, campaign, name: `${name} ad group`, status: 'ENABLED', type: 'SEARCH_STANDARD',
    } } },
    ...spec.keywords.map(keyword => ({ adGroupCriterionOperation: { create: {
      adGroup, status: 'ENABLED', keyword: { text: keyword.text.trim(), matchType: keyword.match },
    } } })),
    { adGroupAdOperation: { create: {
      adGroup,
      status: 'ENABLED',
      ad: {
        finalUrls: [spec.ad.finalUrl],
        responsiveSearchAd: {
          headlines: spec.ad.headlines.map(headline => ({ text: headline })),
          descriptions: spec.ad.descriptions.map(description => ({ text: description })),
          ...spec.ad.path1 === undefined || spec.ad.path1 === '' ? {} : { path1: spec.ad.path1 },
          ...spec.ad.path2 === undefined || spec.ad.path2 === '' ? {} : { path2: spec.ad.path2 },
        },
      },
    } } },
  ]
}

/**
 * Create a paused Search campaign — budget, campaign, targeting, negatives,
 * ad group, keywords, and one responsive search ad — in a single atomic
 * mutate, so either all of it exists afterwards or none of it does. The
 * campaign is always created `PAUSED`; enable it with `setCampaignStatus`
 * once the owner approves.
 * @param fetcher - HTTP.
 * @param auth - access token source, optional manager account.
 * @param customerId - customer id; dashes allowed.
 * @param spec - the campaign.
 * @param signal - cancels the call.
 * @param apiVersion - Google Ads API version path segment.
 * @returns the real resource names of the campaign, budget, and ad group.
 * @throws Error listing every problem when the spec is invalid; AdsRequestError or AdsQuotaError when Google refuses.
 */
export async function createSearchCampaign(
  fetcher: typeof fetch, auth: AdsAuth, customerId: string, spec: SearchCampaignSpec, signal: AbortSignal, apiVersion = 'v25',
): Promise<CreatedSearchCampaign> {
  const id = customerDigits(customerId, 'customer id')
  const problems = validateSearchCampaign(spec)
  if (problems.length > 0) throw new Error(`The Search campaign was not sent to Google Ads:\n- ${problems.join('\n- ')}`)
  const body = await adsPost(fetcher, auth, id, 'googleAds:mutate', { mutateOperations: campaignOperations(id, spec) }, signal, apiVersion)
  const responses = list(body['mutateOperationResponses']).map(record)
  const created = (key: string): string => {
    const name = responses.map(response => text(record(response[key])['resourceName'])).find(value => value !== '')
    if (name === undefined) throw new Error(`Google Ads accepted the campaign but returned no ${key} resource name.`)
    return name
  }
  return { campaign: created('campaignResult'), budget: created('campaignBudgetResult'), adGroup: created('adGroupResult') }
}

/**
 * Enable or pause a campaign.
 * @param fetcher - HTTP.
 * @param auth - access token source, optional manager account.
 * @param customerId - customer id; dashes allowed.
 * @param campaignResourceName - `customers/{id}/campaigns/{campaignId}` of this customer.
 * @param status - the new status.
 * @param signal - cancels the call.
 * @param apiVersion - Google Ads API version path segment.
 * @returns the updated campaign's resource name.
 * @throws AdsRequestError or AdsQuotaError when Google refuses.
 */
export async function setCampaignStatus(
  fetcher: typeof fetch, auth: AdsAuth, customerId: string, campaignResourceName: string, status: 'ENABLED' | 'PAUSED',
  signal: AbortSignal, apiVersion = 'v25',
): Promise<string> {
  const id = customerDigits(customerId, 'customer id')
  const resourceName = campaignName(id, campaignResourceName)
  const body = await adsPost(fetcher, auth, id, 'campaigns:mutate', {
    operations: [{ update: { resourceName, status }, updateMask: 'status' }],
  }, signal, apiVersion)
  return text(record(list(body['results'])[0])['resourceName']) || resourceName
}

/**
 * Change a campaign budget's daily amount.
 * @param fetcher - HTTP.
 * @param auth - access token source, optional manager account.
 * @param customerId - customer id; dashes allowed.
 * @param budgetResourceName - `customers/{id}/campaignBudgets/{budgetId}` of this customer.
 * @param amountMicros - new daily amount in micros; a whole number above 0.
 * @param signal - cancels the call.
 * @param apiVersion - Google Ads API version path segment.
 * @returns the updated budget's resource name.
 * @throws Error for a non-positive amount; AdsRequestError or AdsQuotaError when Google refuses.
 */
export async function setDailyBudget(
  fetcher: typeof fetch, auth: AdsAuth, customerId: string, budgetResourceName: string, amountMicros: number,
  signal: AbortSignal, apiVersion = 'v25',
): Promise<string> {
  const id = customerDigits(customerId, 'customer id')
  if (!new RegExp(`^customers/${id}/campaignBudgets/\\d+$`, 'u').test(budgetResourceName)) {
    throw new Error(`"${budgetResourceName}" is not a campaign budget of customer ${id}.`)
  }
  if (!positiveMicros(amountMicros)) throw new Error('Daily budget must be a whole number of micros above 0.')
  const body = await adsPost(fetcher, auth, id, 'campaignBudgets:mutate', {
    operations: [{ update: { resourceName: budgetResourceName, amountMicros: String(amountMicros) }, updateMask: 'amountMicros' }],
  }, signal, apiVersion)
  return text(record(list(body['results'])[0])['resourceName']) || budgetResourceName
}

/**
 * Add phrase-match negative keywords to a campaign.
 * @param fetcher - HTTP.
 * @param auth - access token source, optional manager account.
 * @param customerId - customer id; dashes allowed.
 * @param campaignResourceName - `customers/{id}/campaigns/{campaignId}` of this customer.
 * @param texts - negative keywords; blanks and duplicates are dropped.
 * @param signal - cancels the call.
 * @param apiVersion - Google Ads API version path segment.
 * @returns the created campaign criteria resource names; empty when nothing was sent.
 * @throws Error listing invalid keywords; AdsRequestError or AdsQuotaError when Google refuses.
 */
export async function addNegativeKeywords(
  fetcher: typeof fetch, auth: AdsAuth, customerId: string, campaignResourceName: string, texts: string[],
  signal: AbortSignal, apiVersion = 'v25',
): Promise<string[]> {
  const id = customerDigits(customerId, 'customer id')
  const campaign = campaignName(id, campaignResourceName)
  const keywords = [...new Set(texts.map(value => value.trim()).filter(value => value !== ''))]
  const problems = keywords.flatMap(keyword => keywordProblems('Negative keyword', keyword))
  if (problems.length > 0) throw new Error(`The negative keywords were not sent to Google Ads:\n- ${problems.join('\n- ')}`)
  if (keywords.length === 0) return []
  const body = await adsPost(fetcher, auth, id, 'campaignCriteria:mutate', {
    operations: keywords.map(keyword => ({ create: { campaign, negative: true, keyword: { text: keyword, matchType: 'PHRASE' } } })),
  }, signal, apiVersion)
  return list(body['results']).map(result => text(record(result)['resourceName'])).filter(name => name !== '')
}

/**
 * Totals for every Search campaign that is not removed, over the `days` days before today.
 * @param fetcher - HTTP.
 * @param auth - access token source, optional manager account.
 * @param customerId - customer id; dashes allowed.
 * @param days - window length, 1–365; 7, 14, and 30 use Google's own ranges in the account's time zone.
 * @param signal - cancels the calls.
 * @param apiVersion - Google Ads API version path segment.
 * @param now - clock for windows Google has no named range for (dates are UTC).
 * @returns one row per campaign.
 * @throws AdsRequestError or AdsQuotaError when Google refuses.
 */
export async function campaignReport(
  fetcher: typeof fetch, auth: AdsAuth, customerId: string, days: number, signal: AbortSignal, apiVersion = 'v25',
  now: () => Date = () => new Date(),
): Promise<CampaignReportRow[]> {
  const id = customerDigits(customerId, 'customer id')
  const query = 'SELECT campaign.resource_name, campaign.id, campaign.name, campaign.status, campaign_budget.resource_name, '
    + 'campaign_budget.amount_micros, metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions FROM campaign '
    + `WHERE campaign.status != 'REMOVED' AND campaign.advertising_channel_type = 'SEARCH' AND ${dateCondition(days, now)} `
    + 'ORDER BY campaign.id'
  const rows = await search(fetcher, auth, id, query, signal, apiVersion)
  return rows.map((row) => {
    const campaign = record(row['campaign'])
    const budget = record(row['campaignBudget'])
    const metrics = record(row['metrics'])
    return {
      resourceName: text(campaign['resourceName']),
      id: int64Text(campaign['id']),
      name: text(campaign['name']),
      status: text(campaign['status']),
      budgetResourceName: text(budget['resourceName']),
      dailyBudgetMicros: num(budget['amountMicros']),
      costMicros: num(metrics['costMicros']),
      clicks: num(metrics['clicks']),
      impressions: num(metrics['impressions']),
      conversions: num(metrics['conversions']),
    }
  })
}

/**
 * What people searched before seeing a campaign's ads, summed across its ad groups, costliest first.
 * @param fetcher - HTTP.
 * @param auth - access token source, optional manager account.
 * @param customerId - customer id; dashes allowed.
 * @param campaignResourceName - `customers/{id}/campaigns/{campaignId}` of this customer.
 * @param days - window length, 1–365.
 * @param signal - cancels the calls.
 * @param apiVersion - Google Ads API version path segment.
 * @param now - clock for windows Google has no named range for (dates are UTC).
 * @returns one row per search term.
 * @throws AdsRequestError or AdsQuotaError when Google refuses.
 */
export async function searchTermReport(
  fetcher: typeof fetch, auth: AdsAuth, customerId: string, campaignResourceName: string, days: number, signal: AbortSignal,
  apiVersion = 'v25', now: () => Date = () => new Date(),
): Promise<SearchTermRow[]> {
  const id = customerDigits(customerId, 'customer id')
  const campaign = campaignName(id, campaignResourceName)
  const query = 'SELECT search_term_view.search_term, metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions '
    + `FROM search_term_view WHERE campaign.resource_name = '${campaign}' AND ${dateCondition(days, now)} ORDER BY metrics.cost_micros DESC`
  const terms = new Map<string, SearchTermRow>()
  for (const row of await search(fetcher, auth, id, query, signal, apiVersion)) {
    const term = text(record(row['searchTermView'])['searchTerm'])
    if (term === '') continue
    const metrics = record(row['metrics'])
    const total = terms.get(term) ?? { term, costMicros: 0, clicks: 0, impressions: 0, conversions: 0 }
    total.costMicros += num(metrics['costMicros'])
    total.clicks += num(metrics['clicks'])
    total.impressions += num(metrics['impressions'])
    total.conversions += num(metrics['conversions'])
    terms.set(term, total)
  }
  return [...terms.values()].sort((a, b) => b.costMicros - a.costMicros)
}
