import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { buildAdsTools, carryOut, type AdsDeps } from '../src/ads/tools.ts'
import { SeoStore } from '../src/store.ts'
import type { Site } from '../src/types.ts'

const exec = { signal: new AbortController().signal } as ToolRunContext
const SITE: Site = {
  id: 'klipara', name: 'Klipara', baseUrl: 'https://klipara.linkfa.de', kind: 'klipara', enabled: true,
  profile: { business: 'b', audience: 'a', offer: 'o', voice: 'Plain\nAvoid: game-changer', cta: { text: '', url: '' } },
  markets: [{ label: 'Nigeria', geoId: '2566', languageId: '1000' }], seeds: [], gscProperty: '', articlesPerWeek: 2,
  author: { name: 'A', url: '', bio: '' }, createdAt: 'x',
}

/** A Google Ads stand-in: the account, its conversion actions, and the mutates, recorded. */
function google(status: string, conversions: number) {
  const calls: { url: string; body: string }[] = []
  const fetcher: typeof fetch = (input, init) => {
    const url = input instanceof Request ? input.url : input.toString()
    const body = typeof init?.body === 'string' ? init.body : ''
    calls.push({ url, body })
    if (url.endsWith('/googleAds:search')) {
      if (body.includes('FROM customer')) {
        return Promise.resolve(Response.json({ results: [{ customer: { id: '3133505423', descriptiveName: '', currencyCode: 'NGN', timeZone: 'Africa/Lagos', status } }] }))
      }
      if (body.includes('FROM conversion_action')) {
        return Promise.resolve(Response.json({ results: Array.from({ length: conversions }, () => ({ conversionAction: { name: 'Sign-up', status: 'ENABLED', category: 'SIGNUP' } })) }))
      }
      return Promise.resolve(Response.json({ results: [] }))
    }
    if (url.endsWith('/googleAds:mutate')) {
      return Promise.resolve(Response.json({ mutateOperationResponses: [
        { campaignBudgetResult: { resourceName: 'customers/3133505423/campaignBudgets/1' } },
        { campaignResult: { resourceName: 'customers/3133505423/campaigns/2' } },
        { adGroupResult: { resourceName: 'customers/3133505423/adGroups/3' } },
      ] }))
    }
    return Promise.resolve(Response.json({ results: [{ resourceName: 'customers/3133505423/campaigns/2' }] }))
  }
  return { calls, fetcher }
}

async function setup(status = 'ENABLED', conversions = 1, ceiling = 60_000) {
  const store = new SeoStore(join(mkdtempSync(join(tmpdir(), 'seo-ads-')), 'state.json'))
  await store.update((s) => { s.sites = [SITE] })
  const g = google(status, conversions)
  const notes: string[] = []
  const deps: AdsDeps = {
    store, fetch: g.fetcher, now: () => new Date('2026-10-02T09:00:00Z'), apiVersion: () => 'v25',
    limits: () => ({ monthlyCeiling: ceiling, maxDailyBudget: 2000, maxCpc: 100, requireConversionTracking: true }),
    adsAuth: () => Promise.resolve({ customerId: '3133505423', accessToken: () => Promise.resolve('t') }),
    notify: (text) => { notes.push(text); return Promise.resolve('sent') },
    proposalsLink: () => 'https://h.test/',
  }
  const tools = new Map(buildAdsTools(deps).map((t: ToolDefinition) => [t.name, t]))
  const run = async (name: string, a: Record<string, unknown>): Promise<string> =>
    ((await tools.get(name)!.execute(a, exec)) as { text: string }).text
  return { store, deps, run, notes, calls: g.calls }
}

const CAMPAIGN = {
  site_id: 'klipara', name: 'Sermon clips NG', daily_budget: 1500, max_cpc: 80, market: 'Nigeria',
  keywords: [{ text: 'sermon clips', match: 'PHRASE' }, { text: 'church video clips', match: 'EXACT' }], negatives: ['free download'],
  final_url: 'https://klipara.linkfa.de/free-clip',
  headlines: ['Sermon clips from your service', 'Captioned for WhatsApp Status', 'Hausa and English captions'],
  descriptions: ['Paste your service link and get vertical clips with captions.', 'Try one free clip from your own video.'],
  reason: 'Autocomplete shows sermon clips demand in Nigeria.',
}

describe('the ads employee', () => {
  it('only proposes: nothing reaches Google until the owner approves, and the owner hears of it', async () => {
    const t = await setup()
    expect(await t.run('ads_propose_campaign', CAMPAIGN)).toContain('runs only after the owner approves')
    expect(t.calls.some(c => c.url.includes(':mutate'))).toBe(false)
    expect(t.notes[0]).toContain('Nothing runs until you approve it')
  })

  it('refuses a proposal over the owner\'s limits, with AI-writing tells, or landing off the site', async () => {
    const t = await setup()
    await expect(t.run('ads_propose_campaign', { ...CAMPAIGN, daily_budget: 5000 })).rejects.toThrow('per-campaign limit')
    await expect(t.run('ads_propose_campaign', { ...CAMPAIGN, headlines: ['A game-changer for sermons', 'b', 'c'] })).rejects.toThrow('game-changer')
    await expect(t.run('ads_propose_campaign', { ...CAMPAIGN, final_url: 'https://other.example/' })).rejects.toThrow('must land on Klipara')
  })

  it('on approval creates the campaign paused, then enables it, and records it', async () => {
    const t = await setup()
    await t.run('ads_propose_campaign', CAMPAIGN)
    const id = (await t.store.read()).adsProposals![0]!.id
    expect(await carryOut(t.deps, id, exec.signal)).toContain('is live at 1,500 NGN a day')
    const mutate = t.calls.find(c => c.url.endsWith('/googleAds:mutate'))!
    expect(mutate.body).toContain('"status":"PAUSED"')
    expect(t.calls.some(c => c.url.endsWith('/campaigns:mutate') && c.body.includes('ENABLED'))).toBe(true)
    const state = await t.store.read()
    expect(state.adsCampaigns).toHaveLength(1)
    expect(state.adsProposals![0]!.status).toBe('approved')
  })

  it('does not carry out an approval on a suspended account, without conversion tracking, or past the ceiling', async () => {
    for (const [status, conversions, ceiling, expected] of [
      ['SUSPENDED', 1, 60_000, 'suspended'], ['ENABLED', 0, 60_000, 'conversion tracking'], ['ENABLED', 1, 30_000, 'over the ceiling'],
    ] as const) {
      const t = await setup(status, conversions, ceiling)
      await t.run('ads_propose_campaign', CAMPAIGN)
      const id = (await t.store.read()).adsProposals![0]!.id
      expect(await carryOut(t.deps, id, exec.signal)).toContain(expected)
      expect(t.calls.some(c => c.url.endsWith('/googleAds:mutate'))).toBe(false)
      expect((await t.store.read()).adsProposals![0]!.status).toBe('failed')
    }
  })
})
