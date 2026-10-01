import { describe, expect, it } from 'vitest'
import {
  addNegativeKeywords, AdsRequestError, campaignReport, createSearchCampaign, getAccount, isAccountNotEnabled, listConversionActions,
  searchTermReport, setCampaignStatus, setDailyBudget, validateSearchCampaign, type SearchCampaignSpec,
} from '../src/ads/api.ts'
import { AdsApiError, AdsQuotaError, type AdsAuth } from '../src/google/ads.ts'

const signal = new AbortController().signal
const TOKEN = 'ya29.SECRET-ACCESS'
const CID = '1234567890'
const CAMPAIGN = `customers/${CID}/campaigns/555`

interface Call {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

/** A fetcher that records each call and answers from a queue of responses. */
function scripted(responses: (() => Response)[]): { fetcher: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const fetcher: typeof fetch = (input, init) => {
    const parsed: unknown = JSON.parse(typeof init?.body === 'string' ? init.body : '{}')
    calls.push({
      url: input instanceof Request ? input.url : input.toString(),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {},
    })
    const next = responses.shift()
    return Promise.resolve(next === undefined ? new Response('unexpected', { status: 500 }) : next())
  }
  return { fetcher, calls }
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => (): Response =>
  new Response(JSON.stringify(body), { status, headers })

function auth(extra: Partial<AdsAuth> = {}): AdsAuth {
  return { accessToken: () => Promise.resolve(TOKEN), ...extra }
}

function spec(overrides: Partial<SearchCampaignSpec> = {}): SearchCampaignSpec {
  return {
    name: 'Plumbing Lagos',
    dailyBudgetMicros: 5_000_000,
    cpcCeilingMicros: 400_000,
    geoIds: ['2566'],
    languageId: '1000',
    keywords: [{ text: 'emergency plumber lagos', match: 'PHRASE' }, { text: 'plumber ikeja', match: 'EXACT' }],
    negatives: ['jobs', 'course'],
    ad: {
      finalUrl: 'https://example.com/plumbing',
      headlines: ['Fast Plumbers In Lagos', '24/7 Emergency Repairs', 'Book A Plumber Today'],
      descriptions: ['Licensed plumbers across Lagos. Call now for same-day repairs.', 'Fixed prices, no call-out fee.'],
      path1: 'plumbing',
      path2: 'lagos',
    },
    ...overrides,
  }
}

function googleError(status: number, googleStatus: string, code: Record<string, string>, message: string): () => Response {
  return json({
    error: {
      code: status,
      message: 'Request contains an invalid argument.',
      status: googleStatus,
      details: [{
        '@type': 'type.googleapis.com/google.ads.googleads.v25.errors.GoogleAdsFailure',
        errors: [{ errorCode: code, message }],
        requestId: 'REQ-BODY',
      }],
    },
  }, status, { 'request-id': 'REQ-HEADER' })
}

describe('createSearchCampaign', () => {
  it('sends one atomic mutate that builds a paused campaign with temporary ids', async () => {
    const { fetcher, calls } = scripted([json({
      mutateOperationResponses: [
        { campaignBudgetResult: { resourceName: `customers/${CID}/campaignBudgets/11` } },
        { campaignResult: { resourceName: `customers/${CID}/campaigns/22` } },
        { campaignCriterionResult: { resourceName: `customers/${CID}/campaignCriteria/22~2566` } },
        { adGroupResult: { resourceName: `customers/${CID}/adGroups/33` } },
      ],
    })])
    const created = await createSearchCampaign(fetcher, auth(), '123-456-7890', spec(), signal)
    expect(created).toEqual({
      campaign: `customers/${CID}/campaigns/22`, budget: `customers/${CID}/campaignBudgets/11`, adGroup: `customers/${CID}/adGroups/33`,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(`https://googleads.googleapis.com/v25/customers/${CID}/googleAds:mutate`)
    const budget = `customers/${CID}/campaignBudgets/-1`
    const campaign = `customers/${CID}/campaigns/-2`
    const adGroup = `customers/${CID}/adGroups/-3`
    expect(calls[0]?.body).toEqual({ mutateOperations: [
      { campaignBudgetOperation: { create: {
        resourceName: budget, name: 'Plumbing Lagos budget', deliveryMethod: 'STANDARD', amountMicros: '5000000', explicitlyShared: false,
      } } },
      { campaignOperation: { create: {
        resourceName: campaign,
        name: 'Plumbing Lagos',
        status: 'PAUSED',
        advertisingChannelType: 'SEARCH',
        campaignBudget: budget,
        networkSettings: {
          targetGoogleSearch: true, targetSearchNetwork: false, targetContentNetwork: false, targetPartnerSearchNetwork: false,
        },
        geoTargetTypeSetting: { positiveGeoTargetType: 'PRESENCE', negativeGeoTargetType: 'PRESENCE' },
        targetSpend: { cpcBidCeilingMicros: '400000' },
        containsEuPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
      } } },
      { campaignCriterionOperation: { create: { campaign, location: { geoTargetConstant: 'geoTargetConstants/2566' } } } },
      { campaignCriterionOperation: { create: { campaign, language: { languageConstant: 'languageConstants/1000' } } } },
      { campaignCriterionOperation: { create: { campaign, negative: true, keyword: { text: 'jobs', matchType: 'PHRASE' } } } },
      { campaignCriterionOperation: { create: { campaign, negative: true, keyword: { text: 'course', matchType: 'PHRASE' } } } },
      { adGroupOperation: { create: {
        resourceName: adGroup, campaign, name: 'Plumbing Lagos ad group', status: 'ENABLED', type: 'SEARCH_STANDARD',
      } } },
      { adGroupCriterionOperation: { create: {
        adGroup, status: 'ENABLED', keyword: { text: 'emergency plumber lagos', matchType: 'PHRASE' },
      } } },
      { adGroupCriterionOperation: { create: { adGroup, status: 'ENABLED', keyword: { text: 'plumber ikeja', matchType: 'EXACT' } } } },
      { adGroupAdOperation: { create: {
        adGroup,
        status: 'ENABLED',
        ad: {
          finalUrls: ['https://example.com/plumbing'],
          responsiveSearchAd: {
            headlines: [{ text: 'Fast Plumbers In Lagos' }, { text: '24/7 Emergency Repairs' }, { text: 'Book A Plumber Today' }],
            descriptions: [
              { text: 'Licensed plumbers across Lagos. Call now for same-day repairs.' }, { text: 'Fixed prices, no call-out fee.' },
            ],
            path1: 'plumbing',
            path2: 'lagos',
          },
        },
      } } },
    ] })
  })

  it('omits language and paths when absent', async () => {
    const { fetcher, calls } = scripted([json({ mutateOperationResponses: [
      { campaignBudgetResult: { resourceName: 'b' } }, { campaignResult: { resourceName: 'c' } }, { adGroupResult: { resourceName: 'a' } },
    ] })])
    const { path1: _p1, path2: _p2, ...ad } = spec().ad
    const { languageId: _l, ...rest } = spec()
    await createSearchCampaign(fetcher, auth(), CID, { ...rest, ad }, signal)
    const body = JSON.stringify(calls[0]?.body)
    expect(body).not.toContain('languageConstant')
    expect(body).not.toContain('path1')
  })

  it('throws when Google returns no resource name for a created part', async () => {
    const { fetcher } = scripted([json({ mutateOperationResponses: [{ campaignResult: { resourceName: 'c' } }] })])
    await expect(createSearchCampaign(fetcher, auth(), CID, spec(), signal)).rejects.toThrow(/campaignBudgetResult/u)
  })

  it.each<[string, Partial<SearchCampaignSpec> | ((s: SearchCampaignSpec) => SearchCampaignSpec), RegExp]>([
    ['too few headlines', s => ({ ...s, ad: { ...s.ad, headlines: ['a', 'b'] } }), /Headlines: need 3–15, got 2/u],
    ['too many headlines', s => ({ ...s, ad: { ...s.ad, headlines: Array.from({ length: 16 }, (_, i) => `h${String(i)}`) } }),
      /Headlines: need 3–15, got 16/u],
    ['long headline', s => ({ ...s, ad: { ...s.ad, headlines: ['a', 'b', 'x'.repeat(31)] } }), /Headlines 3 .* longer than 30/u],
    ['double-width headline', s => ({ ...s, ad: { ...s.ad, headlines: ['a', 'b', '東'.repeat(16)] } }), /Headlines 3 .* longer than 30/u],
    ['too few descriptions', s => ({ ...s, ad: { ...s.ad, descriptions: ['one'] } }), /Descriptions: need 2–4, got 1/u],
    ['too many descriptions', s => ({ ...s, ad: { ...s.ad, descriptions: ['1', '2', '3', '4', '5'] } }), /Descriptions: need 2–4, got 5/u],
    ['long description', s => ({ ...s, ad: { ...s.ad, descriptions: ['ok', 'y'.repeat(91)] } }), /Descriptions 2 .* longer than 90/u],
    ['long path', s => ({ ...s, ad: { ...s.ad, path1: 'p'.repeat(16) } }), /Path 1 .* longer than 15/u],
    ['path2 without path1', s => ({ ...s, ad: { ...s.ad, path1: '' } }), /Path 2 needs path 1/u],
    ['http final URL', s => ({ ...s, ad: { ...s.ad, finalUrl: 'http://example.com' } }), /must be an https/u],
    ['unparsable final URL', s => ({ ...s, ad: { ...s.ad, finalUrl: 'example.com' } }), /must be an https/u],
    ['no keywords', { keywords: [] }, /Keywords: need 1–50, got 0/u],
    ['51 keywords', { keywords: Array.from({ length: 51 }, (_, i) => ({ text: `k${String(i)}`, match: 'EXACT' as const })) },
      /Keywords: need 1–50, got 51/u],
    ['long keyword', { keywords: [{ text: 'k'.repeat(81), match: 'EXACT' }] }, /longer than 80/u],
    ['eleven-word keyword', { keywords: [{ text: 'a b c d e f g h i j k', match: 'PHRASE' }] }, /more than 10 words/u],
    ['long negative', { negatives: ['n'.repeat(81)] }, /Negative keyword .* longer than 80/u],
    ['zero budget', { dailyBudgetMicros: 0 }, /Daily budget/u],
    ['fractional budget', { dailyBudgetMicros: 1.5 }, /Daily budget/u],
    ['zero ceiling', { cpcCeilingMicros: 0 }, /CPC ceiling/u],
    ['no geo', { geoIds: [] }, /At least one location/u],
    ['non-numeric geo', { geoIds: ['Lagos'] }, /Geo target id "Lagos"/u],
    ['empty name', { name: ' ' }, /Campaign name is empty/u],
  ])('refuses %s without calling Google', async (_label, change, pattern) => {
    const { fetcher, calls } = scripted([])
    const bad = typeof change === 'function' ? change(spec()) : spec(change)
    await expect(createSearchCampaign(fetcher, auth(), CID, bad, signal)).rejects.toThrow(pattern)
    expect(calls).toHaveLength(0)
  })

  it('lists every problem at once', () => {
    const problems = validateSearchCampaign(spec({ dailyBudgetMicros: 0, cpcCeilingMicros: -1, geoIds: [], keywords: [] }))
    expect(problems).toHaveLength(4)
    expect(validateSearchCampaign(spec())).toEqual([])
  })
})

describe('campaign edits', () => {
  it('updates status with updateMask status', async () => {
    const { fetcher, calls } = scripted([json({ results: [{ resourceName: CAMPAIGN }] })])
    expect(await setCampaignStatus(fetcher, auth(), CID, CAMPAIGN, 'ENABLED', signal)).toBe(CAMPAIGN)
    expect(calls[0]?.url).toBe(`https://googleads.googleapis.com/v25/customers/${CID}/campaigns:mutate`)
    expect(calls[0]?.body).toEqual({ operations: [{ update: { resourceName: CAMPAIGN, status: 'ENABLED' }, updateMask: 'status' }] })
  })

  it('refuses a campaign of another customer', async () => {
    const { fetcher, calls } = scripted([])
    await expect(setCampaignStatus(fetcher, auth(), CID, 'customers/999/campaigns/1', 'PAUSED', signal)).rejects.toThrow(/not a campaign/u)
    expect(calls).toHaveLength(0)
  })

  it('updates the daily budget with updateMask amountMicros', async () => {
    const budget = `customers/${CID}/campaignBudgets/77`
    const { fetcher, calls } = scripted([json({ results: [{ resourceName: budget }] })])
    expect(await setDailyBudget(fetcher, auth(), CID, budget, 7_500_000, signal, 'v24')).toBe(budget)
    expect(calls[0]?.url).toBe(`https://googleads.googleapis.com/v24/customers/${CID}/campaignBudgets:mutate`)
    expect(calls[0]?.body).toEqual({
      operations: [{ update: { resourceName: budget, amountMicros: '7500000' }, updateMask: 'amountMicros' }],
    })
    await expect(setDailyBudget(fetcher, auth(), CID, budget, 0, signal)).rejects.toThrow(/Daily budget/u)
  })

  it('adds deduplicated phrase negatives', async () => {
    const { fetcher, calls } = scripted([json({ results: [{ resourceName: 'n1' }, { resourceName: 'n2' }] })])
    expect(await addNegativeKeywords(fetcher, auth(), CID, CAMPAIGN, ['free', ' free ', 'diy', ''], signal)).toEqual(['n1', 'n2'])
    expect(calls[0]?.url).toBe(`https://googleads.googleapis.com/v25/customers/${CID}/campaignCriteria:mutate`)
    expect(calls[0]?.body).toEqual({ operations: [
      { create: { campaign: CAMPAIGN, negative: true, keyword: { text: 'free', matchType: 'PHRASE' } } },
      { create: { campaign: CAMPAIGN, negative: true, keyword: { text: 'diy', matchType: 'PHRASE' } } },
    ] })
    expect(await addNegativeKeywords(fetcher, auth(), CID, CAMPAIGN, [' '], signal)).toEqual([])
    expect(calls).toHaveLength(1)
  })
})

describe('reads and reports', () => {
  it('reads the account', async () => {
    const { fetcher, calls } = scripted([json({ results: [{ customer: {
      resourceName: `customers/${CID}`, id: CID, descriptiveName: 'Acme', currencyCode: 'NGN', timeZone: 'Africa/Lagos',
      testAccount: true, status: 'ENABLED',
    } }] })])
    expect(await getAccount(fetcher, auth(), CID, signal)).toEqual({
      customerId: CID, name: 'Acme', currencyCode: 'NGN', timeZone: 'Africa/Lagos', testAccount: true, status: 'ENABLED', manager: false,
    })
    expect(calls[0]?.url).toBe(`https://googleads.googleapis.com/v25/customers/${CID}/googleAds:search`)
    expect(String(calls[0]?.body['query'])).toMatch(/FROM customer LIMIT 1$/u)
    expect(calls[0]?.body).not.toHaveProperty('pageSize')
  })

  it('lists conversion actions excluding removed ones', async () => {
    const { fetcher, calls } = scripted([json({ results: [
      { conversionAction: { name: 'Lead form', status: 'ENABLED', category: 'SUBMIT_LEAD_FORM', primaryForGoal: true } },
      { conversionAction: { name: 'Calls', status: 'HIDDEN', category: 'PHONE_CALL_LEAD' } },
    ] })])
    expect(await listConversionActions(fetcher, auth(), CID, signal)).toEqual([
      { name: 'Lead form', status: 'ENABLED', category: 'SUBMIT_LEAD_FORM', primaryForGoal: true },
      { name: 'Calls', status: 'HIDDEN', category: 'PHONE_CALL_LEAD', primaryForGoal: false },
    ])
    expect(String(calls[0]?.body['query'])).toContain("conversion_action.status != 'REMOVED'")
  })

  it('parses int64 strings and follows pages', async () => {
    const row = (id: string, cost: string) => ({
      campaign: { resourceName: `customers/${CID}/campaigns/${id}`, id, name: `C${id}`, status: 'ENABLED' },
      campaignBudget: { resourceName: `customers/${CID}/campaignBudgets/${id}`, amountMicros: '5000000' },
      metrics: { costMicros: cost, clicks: '12', impressions: '3400', conversions: 1.5 },
    })
    const { fetcher, calls } = scripted([
      json({ results: [row('1', '1230000')], nextPageToken: 'P2' }),
      json({ results: [{ campaign: { resourceName: 'r', id: '2', name: 'Quiet', status: 'PAUSED' }, campaignBudget: {} }] }),
    ])
    const rows = await campaignReport(fetcher, auth(), CID, 30, signal)
    expect(rows).toEqual([
      {
        resourceName: `customers/${CID}/campaigns/1`, id: '1', name: 'C1', status: 'ENABLED',
        budgetResourceName: `customers/${CID}/campaignBudgets/1`,
        dailyBudgetMicros: 5_000_000, costMicros: 1_230_000, clicks: 12, impressions: 3400, conversions: 1.5,
      },
      {
        resourceName: 'r', id: '2', name: 'Quiet', status: 'PAUSED', budgetResourceName: '',
        dailyBudgetMicros: 0, costMicros: 0, clicks: 0, impressions: 0, conversions: 0,
      },
    ])
    const query = String(calls[0]?.body['query'])
    expect(query).toContain("campaign.status != 'REMOVED'")
    expect(query).toContain("campaign.advertising_channel_type = 'SEARCH'")
    expect(query).toContain('segments.date DURING LAST_30_DAYS')
    expect(calls[0]?.body).not.toHaveProperty('pageToken')
    expect(calls[1]?.body['pageToken']).toBe('P2')
  })

  it('stops after ten pages', async () => {
    const pages = Array.from({ length: 12 }, () => json({ results: [], nextPageToken: 'more' }))
    const { fetcher, calls } = scripted(pages)
    await campaignReport(fetcher, auth(), CID, 7, signal)
    expect(calls).toHaveLength(10)
  })

  it('uses explicit dates for windows Google has no range for', async () => {
    const { fetcher, calls } = scripted([json({ results: [] })])
    await campaignReport(fetcher, auth(), CID, 3, signal, 'v25', () => new Date('2026-10-01T12:00:00Z'))
    expect(String(calls[0]?.body['query'])).toContain("segments.date BETWEEN '2026-09-28' AND '2026-09-30'")
    await expect(campaignReport(fetcher, auth(), CID, 0, signal)).rejects.toThrow(/1–365/u)
  })

  it('sums search terms across ad groups, costliest first', async () => {
    const { fetcher, calls } = scripted([json({ results: [
      { searchTermView: { searchTerm: 'cheap plumber' }, metrics: { costMicros: '100000', clicks: '1', impressions: '10' } },
      { searchTermView: { searchTerm: 'plumber near me' },
        metrics: { costMicros: '900000', clicks: '4', impressions: '40', conversions: 1 } },
      { searchTermView: { searchTerm: 'cheap plumber' },
        metrics: { costMicros: '50000', clicks: '2', impressions: '5', conversions: 0.5 } },
    ] })])
    expect(await searchTermReport(fetcher, auth(), CID, CAMPAIGN, 14, signal)).toEqual([
      { term: 'plumber near me', costMicros: 900_000, clicks: 4, impressions: 40, conversions: 1 },
      { term: 'cheap plumber', costMicros: 150_000, clicks: 3, impressions: 15, conversions: 0.5 },
    ])
    const query = String(calls[0]?.body['query'])
    expect(query).toContain('FROM search_term_view')
    expect(query).toContain(`campaign.resource_name = '${CAMPAIGN}'`)
    expect(query).toContain('LAST_14_DAYS')
  })
})

describe('errors and headers', () => {
  it('names the first error code, the message, and the request id', async () => {
    const { fetcher } = scripted([googleError(400, 'INVALID_ARGUMENT', { campaignError: 'DUPLICATE_CAMPAIGN_NAME' }, 'Name already used.')])
    const error: unknown = await createSearchCampaign(fetcher, auth(), CID, spec(), signal).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AdsRequestError)
    expect(error).toBeInstanceOf(AdsApiError)
    if (!(error instanceof AdsRequestError)) return
    expect(error.message).toContain('campaignError: DUPLICATE_CAMPAIGN_NAME')
    expect(error.message).toContain('Name already used.')
    expect(error.message).toContain('[request-id REQ-HEADER]')
    expect(error.errorCode).toBe('campaignError: DUPLICATE_CAMPAIGN_NAME')
    expect(error.status).toBe(400)
    expect(error.googleStatus).toBe('INVALID_ARGUMENT')
    expect(error.requestId).toBe('REQ-HEADER')
    expect(error.message).not.toContain(TOKEN)
    expect(isAccountNotEnabled(error)).toBe(false)
  })

  it('falls back to the failure request id and recognises a disabled account', async () => {
    const failure = googleError(403, 'PERMISSION_DENIED', { authorizationError: 'CUSTOMER_NOT_ENABLED' }, 'Customer is not enabled.')
    const { fetcher } = scripted([() => {
      const response = failure()
      return new Response(response.body, { status: 403 })
    }])
    const error: unknown = await getAccount(fetcher, auth(), CID, signal).catch((e: unknown) => e)
    expect(isAccountNotEnabled(error)).toBe(true)
    expect(error instanceof AdsApiError ? error.requestId : '').toBe('REQ-BODY')
    expect(isAccountNotEnabled(new Error('CUSTOMER_NOT_ENABLED'))).toBe(false)
  })

  it('maps quota refusals to AdsQuotaError', async () => {
    const { fetcher } = scripted([
      googleError(429, 'RESOURCE_EXHAUSTED', { quotaError: 'RESOURCE_EXHAUSTED' }, 'Too many requests.'),
      json({ error: { status: 'RESOURCE_EXHAUSTED', message: 'quota' } }, 403),
    ])
    await expect(setCampaignStatus(fetcher, auth(), CID, CAMPAIGN, 'PAUSED', signal)).rejects.toBeInstanceOf(AdsQuotaError)
    await expect(setCampaignStatus(fetcher, auth(), CID, CAMPAIGN, 'PAUSED', signal)).rejects.toBeInstanceOf(AdsQuotaError)
  })

  it('never echoes the access token and survives a non-JSON body', async () => {
    const { fetcher } = scripted([
      googleError(401, 'UNAUTHENTICATED', { authenticationError: 'OAUTH_TOKEN_INVALID' }, `Bad token ${TOKEN}`),
      () => new Response('<html>bad gateway</html>', { status: 502 }),
    ])
    const first: unknown = await getAccount(fetcher, auth(), CID, signal).catch((e: unknown) => e)
    expect(first instanceof Error ? first.message : '').not.toContain(TOKEN)
    expect(first instanceof Error ? first.message : '').toContain('[redacted]')
    const second: unknown = await getAccount(fetcher, auth(), CID, signal).catch((e: unknown) => e)
    expect(second instanceof Error ? second.message : '').toContain('HTTP 502')
    expect(second instanceof Error ? second.message : '').not.toContain(TOKEN)
  })

  it('sends developer-token only when set and login-customer-id as digits', async () => {
    const { fetcher, calls } = scripted([json({ results: [] }), json({ results: [] }), json({ results: [] })])
    await listConversionActions(fetcher, auth(), CID, signal)
    await listConversionActions(fetcher, auth({ developerToken: '' }), CID, signal)
    await listConversionActions(fetcher, auth({ developerToken: 'DEV', loginCustomerId: '111-222-3333' }), CID, signal)
    expect(calls[0]?.headers).toEqual({ authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' })
    expect(calls[1]?.headers).not.toHaveProperty('developer-token')
    expect(calls[2]?.headers['developer-token']).toBe('DEV')
    expect(calls[2]?.headers['login-customer-id']).toBe('1112223333')
  })
})
