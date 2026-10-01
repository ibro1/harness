import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { authorizationUrl, exchangeCode, GoogleAuthError, GoogleTokens, pkcePair, randomState } from '../src/google/oauth.ts'
import {
  AdsApiError, AdsQuotaError, ENGLISH, generateKeywordHistoricalMetrics, generateKeywordIdeas, isPlannableKeyword,
  KeywordPlanQueue, MARKETS, type AdsAuth,
} from '../src/google/ads.ts'
import {
  cannibalization, gscWindow, inspectUrl, queryAll, querySearchAnalytics, strikingDistance, submitSitemap,
} from '../src/google/gsc.ts'
import type { GscRow } from '../src/types.ts'

const signal = new AbortController().signal
const exchange = { clientId: 'c', clientSecret: 'cs', redirectUri: 'r', codeVerifier: 'v' }

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body: string
}

/** A fetcher that records each call and answers from a queue of responses. */
function scripted(responses: (() => Response)[]): { fetcher: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const fetcher: typeof fetch = (input, init) => {
    const headers = new Headers(init?.headers)
    calls.push({
      url: input instanceof Request ? input.url : input.toString(),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(headers.entries()),
      body: typeof init?.body === 'string' ? init.body : '',
    })
    const next = responses.shift()
    return Promise.resolve(next === undefined ? new Response('unexpected', { status: 500 }) : next())
  }
  return { fetcher, calls }
}

/** A clock that only moves when the queue sleeps. */
function fakeTime(): { queue: KeywordPlanQueue; sleeps: number[]; now: () => number } {
  let now = 1_000_000
  const sleeps: number[] = []
  const queue = new KeywordPlanQueue(() => now, (ms) => {
    sleeps.push(ms)
    now += ms
    return Promise.resolve()
  })
  return { queue, sleeps, now: () => now }
}

function adsAuth(queue: KeywordPlanQueue, extra: Partial<AdsAuth> = {}): AdsAuth {
  return { accessToken: () => Promise.resolve('ya29.SECRET-ACCESS'), developerToken: 'DEV-SECRET', queue, ...extra }
}

function jsonBody(call: Call | undefined): Record<string, unknown> {
  const parsed: unknown = JSON.parse(call?.body ?? '{}')
  return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {}
}

describe('Google OAuth', () => {
  it('builds an offline, consent, PKCE S256 authorization URL', () => {
    const { verifier, challenge } = pkcePair()
    expect(verifier).toMatch(/^[\w-]{43,128}$/u)
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'))
    const state = randomState()
    expect(state).not.toBe(randomState())
    const url = new URL(authorizationUrl({ clientId: 'cid', redirectUri: 'https://h.test/cb', state, codeChallenge: challenge }))
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    const p = url.searchParams
    expect(p.get('access_type')).toBe('offline')
    expect(p.get('prompt')).toBe('consent')
    expect(p.get('include_granted_scopes')).toBe('true')
    expect(p.get('code_challenge_method')).toBe('S256')
    expect(p.get('code_challenge')).toBe(challenge)
    expect(p.get('state')).toBe(state)
    expect(p.get('response_type')).toBe('code')
    expect(p.get('scope')).toBe('https://www.googleapis.com/auth/adwords https://www.googleapis.com/auth/webmasters')
  })

  it('exchanges a code and refuses a grant without a refresh token', async () => {
    const ok = scripted([() => Response.json({ access_token: 'at', refresh_token: 'rt', expires_in: 3599, scope: 's' })])
    const grant = await exchangeCode(ok.fetcher, { ...exchange, code: 'code' }, signal, () => 0)
    expect(grant).toEqual({ refreshToken: 'rt', accessToken: 'at', expiresAt: 3_599_000, scope: 's' })
    const form = new URLSearchParams(ok.calls[0]?.body)
    expect(ok.calls[0]?.url).toBe('https://oauth2.googleapis.com/token')
    expect(form.get('grant_type')).toBe('authorization_code')
    expect(form.get('code_verifier')).toBe('v')

    const none = scripted([() => Response.json({ access_token: 'at', expires_in: 3599 })])
    const failure = exchangeCode(none.fetcher, { ...exchange, code: 'x' }, signal)
    await expect(failure).rejects.toMatchObject({ code: 'no-refresh-token' })
    await expect(failure).rejects.toThrow('myaccount.google.com/permissions')
  })

  it('caches the access token until a minute before expiry', async () => {
    let now = 0
    const { fetcher, calls } = scripted([
      () => Response.json({ access_token: 'one', expires_in: 3600 }),
      () => Response.json({ access_token: 'two', expires_in: 3600 }),
    ])
    const tokens = new GoogleTokens(fetcher, () => ({ clientId: 'c', clientSecret: 's', refreshToken: 'rt' }), () => now)
    const [a, b] = await Promise.all([tokens.accessToken(signal), tokens.accessToken(signal)])
    expect([a, b]).toEqual(['one', 'one'])
    now = 3_539_000
    expect(await tokens.accessToken(signal)).toBe('one')
    now = 3_540_000
    expect(await tokens.accessToken(signal)).toBe('two')
    expect(calls).toHaveLength(2)
    expect(new URLSearchParams(calls[0]?.body).get('grant_type')).toBe('refresh_token')
  })

  it('turns invalid_grant into a reconnect error', async () => {
    const refusal = { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }
    const { fetcher } = scripted([() => Response.json(refusal, { status: 400 })])
    const tokens = new GoogleTokens(fetcher, () => ({ clientId: 'c', clientSecret: 's', refreshToken: 'rt-secret' }))
    const error: unknown = await tokens.accessToken(signal).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(GoogleAuthError)
    expect(error).toMatchObject({ code: 'reconnect' })
    expect(String(error)).toContain('Connect Google again')
    expect(String(error)).toContain('7 days')
    expect(String(error)).not.toContain('rt-secret')
  })
})

const idea = (text: string, avg: string) => ({
  text,
  keywordIdeaMetrics: {
    competition: 'MEDIUM', competitionIndex: '42', avgMonthlySearches: avg,
    lowTopOfPageBidMicros: '120000', highTopOfPageBidMicros: '900000',
    monthlySearchVolumes: [{ year: '2026', month: 'AUGUST', monthlySearches: '1300' }],
  },
})

describe('Keyword Planner', () => {
  it('sends a keyword seed with stripped customer ids, targeting, and auth headers', async () => {
    const { queue } = fakeTime()
    const { fetcher, calls } = scripted([() => Response.json({ results: [idea('rent in lagos', '1900')] })])
    const ideas = await generateKeywordIdeas(fetcher, adsAuth(queue, { loginCustomerId: '111-222-3333' }), {
      customerId: '123-456-7890', keywords: ['rent in lagos', 'wow!!', 'x'.repeat(81)], geoIds: [MARKETS.Nigeria], languageId: ENGLISH,
    }, signal)
    const call = calls[0]
    expect(call?.url).toBe('https://googleads.googleapis.com/v25/customers/1234567890:generateKeywordIdeas')
    expect(call?.method).toBe('POST')
    expect(call?.headers['authorization']).toBe('Bearer ya29.SECRET-ACCESS')
    expect(call?.headers['developer-token']).toBe('DEV-SECRET')
    expect(call?.headers['login-customer-id']).toBe('1112223333')
    expect(jsonBody(call)).toEqual({
      keywordSeed: { keywords: ['rent in lagos'] }, geoTargetConstants: ['geoTargetConstants/2566'], language: 'languageConstants/1000',
      includeAdultKeywords: false, keywordPlanNetwork: 'GOOGLE_SEARCH', pageSize: 200,
    })
    expect(ideas).toEqual([{
      text: 'rent in lagos', avgMonthlySearches: 1900, monthly: [{ year: 2026, month: 8, searches: 1300 }], competition: 'MEDIUM',
      competitionIndex: 42, lowTopOfPageBidMicros: 120_000, highTopOfPageBidMicros: 900_000,
    }])
  })

  it('picks the seed type and omits empty geo and language', async () => {
    const { queue } = fakeTime()
    const { fetcher, calls } = scripted([() => Response.json({}), () => Response.json({}), () => Response.json({})])
    const base = { customerId: '1', geoIds: [], languageId: '' }
    await generateKeywordIdeas(fetcher, adsAuth(queue), { ...base, url: 'https://x.test/a', keywords: ['a b'] }, signal, 'v99')
    await generateKeywordIdeas(fetcher, adsAuth(queue), { ...base, url: 'https://x.test/a' }, signal)
    await generateKeywordIdeas(fetcher, adsAuth(queue), { ...base, site: 'x.test', network: 'GOOGLE_SEARCH_AND_PARTNERS' }, signal)
    expect(calls[0]?.url).toContain('/v99/')
    expect(calls[0]?.headers['login-customer-id']).toBeUndefined()
    expect(jsonBody(calls[0])).toEqual({ keywordAndUrlSeed: { url: 'https://x.test/a', keywords: ['a b'] }, includeAdultKeywords: false,
      keywordPlanNetwork: 'GOOGLE_SEARCH', pageSize: 200 })
    expect(jsonBody(calls[1])['urlSeed']).toEqual({ url: 'https://x.test/a' })
    expect(jsonBody(calls[2])).toMatchObject({ siteSeed: { site: 'x.test' }, keywordPlanNetwork: 'GOOGLE_SEARCH_AND_PARTNERS' })
    await expect(generateKeywordIdeas(fetcher, adsAuth(queue), { ...base, keywords: ['bad!'] }, signal)).rejects.toThrow(/needs a seed/u)
  })

  it('follows nextPageToken until maxResults', async () => {
    const { queue } = fakeTime()
    const { fetcher, calls } = scripted([
      () => Response.json({ results: [idea('a', '10'), idea('b', '20')], nextPageToken: 'p2' }),
      () => Response.json({ results: [idea('c', '30'), idea('d', '40')], nextPageToken: 'p3' }),
    ])
    const request = { customerId: '1', keywords: ['a'], geoIds: [], pageSize: 2, maxResults: 3 }
    const ideas = await generateKeywordIdeas(fetcher, adsAuth(queue), request, signal)
    expect(ideas.map(i => i.text)).toEqual(['a', 'b', 'c'])
    expect(calls).toHaveLength(2)
    expect(jsonBody(calls[1])['pageToken']).toBe('p2')
  })

  it('retries a quota refusal after Google\'s retryDelay, then succeeds', async () => {
    const { queue, sleeps } = fakeTime()
    const quota = {
      error: {
        code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Resource has been exhausted (e.g. check quota).',
        details: [{ '@type': 'type.googleapis.com/google.ads.googleads.v25.errors.GoogleAdsFailure', errors: [{
          errorCode: { quotaError: 'RESOURCE_TEMPORARILY_EXHAUSTED' }, message: 'Too many requests.',
          details: { quotaErrorDetails: { rateScope: 'DEVELOPER', retryDelay: '5s' } },
        }] }],
      },
    }
    const { fetcher, calls } = scripted([() => Response.json(quota, { status: 429 }), () => Response.json({ results: [idea('a', '1')] })])
    const ideas = await generateKeywordIdeas(fetcher, adsAuth(queue), { customerId: '1', keywords: ['a'], geoIds: [] }, signal)
    expect(ideas).toHaveLength(1)
    expect(calls).toHaveLength(2)
    expect(sleeps[0]).toBe(5000)
  })

  it('gives up after two quota retries with exponential backoff', async () => {
    const { queue, sleeps } = fakeTime()
    const refuse = () => Response.json({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota' } }, { status: 429 })
    const { fetcher, calls } = scripted([refuse, refuse, refuse])
    const failure = generateKeywordIdeas(fetcher, adsAuth(queue), { customerId: '1', keywords: ['a'], geoIds: [] }, signal)
    await expect(failure).rejects.toBeInstanceOf(AdsQuotaError)
    expect(calls).toHaveLength(3)
    expect(sleeps.filter(ms => ms >= 2000)).toEqual([2000, 8000])
  })

  it('reports other refusals with Google\'s message and request id, never the tokens', async () => {
    const { queue } = fakeTime()
    const { fetcher } = scripted([() => Response.json(
      { error: { code: 403, status: 'PERMISSION_DENIED', message: 'The caller does not have permission' } },
      { status: 403, headers: { 'request-id': 'req-77' } },
    )])
    const error: unknown = await generateKeywordIdeas(fetcher, adsAuth(queue), { customerId: '1', keywords: ['a'], geoIds: [] }, signal)
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AdsApiError)
    expect(error).toMatchObject({ status: 403, googleStatus: 'PERMISSION_DENIED', requestId: 'req-77' })
    const message = String(error)
    expect(message).toContain('The caller does not have permission')
    expect(message).toContain('req-77')
    expect(message).not.toContain('SECRET')
  })

  it('reads historical metrics for exact keywords', async () => {
    const { queue } = fakeTime()
    const answer = { results: [{ text: 'a', keywordMetrics: { avgMonthlySearches: '70', competition: 'LOW' } }] }
    const { fetcher, calls } = scripted([() => Response.json(answer)])
    const request = { customerId: '1-2', keywords: ['a', 'a', 'no;'], geoIds: ['2566'] }
    const rows = await generateKeywordHistoricalMetrics(fetcher, adsAuth(queue), request, signal)
    expect(calls[0]?.url).toBe('https://googleads.googleapis.com/v25/customers/12:generateKeywordHistoricalMetrics')
    expect(jsonBody(calls[0])).toMatchObject({ keywords: ['a'], geoTargetConstants: ['geoTargetConstants/2566'] })
    expect(rows).toEqual([{ text: 'a', avgMonthlySearches: 70, monthly: [], competition: 'LOW' }])
  })

  it('spaces calls for one customer by at least 1100 ms and leaves other customers alone', async () => {
    const { queue, now } = fakeTime()
    const starts: [string, number][] = []
    const task = (id: string) => () => {
      starts.push([id, now()])
      return Promise.resolve(id)
    }
    await Promise.all([queue.run('1', task('a'), signal), queue.run('1', task('b'), signal), queue.run('2', task('c'), signal)])
    await queue.run('1', task('d'), signal)
    const one = starts.filter(([id]) => id !== 'c').map(([, t]) => t)
    for (let i = 1; i < one.length; i++) expect((one[i] ?? 0) - (one[i - 1] ?? 0)).toBeGreaterThanOrEqual(1100)
    expect(starts.find(([id]) => id === 'c')?.[1]).toBe(1_000_000)
  })

  it('accepts only keywords Keyword Planner can plan', () => {
    expect(isPlannableKeyword('how to rent a flat in lagos')).toBe(true)
    expect(isPlannableKeyword('one two three four five six seven eight nine ten eleven')).toBe(false)
    expect(isPlannableKeyword('a'.repeat(81))).toBe(false)
    for (const bad of ['50% off', 'hi@there', 'wow!', 'a, b', 'a*b', 'a;b', '   ']) expect(isPlannableKeyword(bad)).toBe(false)
  })
})

const row = (query: string, page: string, impressions: number, position: number): GscRow =>
  ({ query, page, clicks: 1, impressions, ctr: 0, position })

describe('Search Console', () => {
  it('keeps the best page per query only when it is in striking distance', () => {
    const rows = [
      row('rent lagos', '/a', 400, 8), row('rent lagos', '/b', 900, 12),
      row('top query', '/a', 5000, 2), row('top query', '/c', 3000, 9),
      row('small', '/a', 10, 7),
      row('far', '/d', 800, 30),
      row('tie', '/x', 100, 6), row('tie', '/y', 300, 6),
    ]
    expect(strikingDistance(rows)).toEqual([
      { query: 'rent lagos', page: '/a', clicks: 1, impressions: 400, position: 8 },
      { query: 'tie', page: '/y', clicks: 1, impressions: 300, position: 6 },
    ])
    expect(strikingDistance(rows, { minImpressions: 0 }).map(r => r.query)).toContain('small')
  })

  it('finds queries split across pages that each hold 20% of impressions', () => {
    const rows = [
      row('q1', '/a', 60, 5), row('q1', '/b', 30, 9), row('q1', '/c', 10, 20),
      row('q2', '/a', 95, 3), row('q2', '/b', 5, 8),
      row('q3', '/a', 300, 4), row('q3', '/a', 100, 8), row('q3', '/b', 400, 6),
    ]
    expect(cannibalization(rows)).toEqual([
      { query: 'q3', pages: [{ page: '/a', impressions: 400, position: 5 }, { page: '/b', impressions: 400, position: 6 }] },
      { query: 'q1', pages: [{ page: '/a', impressions: 60, position: 5 }, { page: '/b', impressions: 30, position: 9 }] },
    ])
  })

  it('URL-encodes the property and sitemap path', async () => {
    const { fetcher, calls } = scripted([() => new Response(null, { status: 204 })])
    await submitSitemap(fetcher, 'tok', 'sc-domain:linkfa.de', 'https://linkfa.de/sitemap.xml', signal)
    expect(calls[0]?.method).toBe('PUT')
    expect(calls[0]?.url)
      .toBe('https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Alinkfa.de/sitemaps/https%3A%2F%2Flinkfa.de%2Fsitemap.xml')
  })

  it('maps keys to dimensions and pages through all rows', async () => {
    const page = (n: number) => () => Response.json({
      rows: Array.from({ length: n }, (_v, i) => ({ keys: [`q${String(i)}`, '/p'], clicks: 1, impressions: 2, ctr: 0.5, position: 3 })),
    })
    const { fetcher, calls } = scripted([page(2), page(1)])
    const query = { startDate: '2026-09-01', endDate: '2026-09-28', dimensions: ['query', 'page'] as ('query' | 'page')[], rowLimit: 2 }
    const rows = await queryAll(fetcher, 'tok', 'https://x.test/', query, 10, signal)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toEqual({ query: 'q0', page: '/p', clicks: 1, impressions: 2, ctr: 0.5, position: 3 })
    expect(jsonBody(calls[1])).toMatchObject({ startRow: 2, rowLimit: 2, type: 'web' })
    expect(calls[0]?.url).toBe('https://www.googleapis.com/webmasters/v3/sites/https%3A%2F%2Fx.test%2F/searchAnalytics/query')

    const single = scripted([() => Response.json({})])
    expect(await querySearchAnalytics(single.fetcher, 't', 'p', { startDate: 'a', endDate: 'b', dimensions: ['date'] }, signal)).toEqual([])
  })

  it('reads URL inspection index status', async () => {
    const { fetcher, calls } = scripted([() => Response.json({ inspectionResult: { indexStatusResult: {
      verdict: 'PASS', coverageState: 'Submitted and indexed', lastCrawlTime: '2026-09-20T10:00:00Z' } } })])
    expect(await inspectUrl(fetcher, 'tok', 'sc-domain:x.test', 'https://x.test/a', signal))
      .toEqual({ verdict: 'PASS', coverageState: 'Submitted and indexed', lastCrawlTime: '2026-09-20T10:00:00Z' })
    expect(jsonBody(calls[0])).toEqual({ inspectionUrl: 'https://x.test/a', siteUrl: 'sc-domain:x.test' })
  })

  it('ends the window three days back', () => {
    expect(gscWindow(new Date('2026-10-01T12:00:00Z'), 28)).toEqual({ startDate: '2026-09-01', endDate: '2026-09-28' })
  })
})
