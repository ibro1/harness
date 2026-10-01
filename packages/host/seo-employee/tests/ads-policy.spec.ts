import { describe, expect, it } from 'vitest'
import { approvalBlock, campaignLimitProblems, campaignsToPause, MICROS, projectedMonthly, type AdsLimits } from '../src/ads/policy.ts'
import type { AdsCampaign, AdsCampaignSpec, AdsProposal } from '../src/store.ts'

const LIMITS: AdsLimits = { monthlyCeiling: 60_000, maxDailyBudget: 2000, maxCpc: 100, requireConversionTracking: true }
const SPEC: AdsCampaignSpec = {
  name: 'Sermon clips NG', dailyBudgetMicros: 1000 * MICROS, cpcCeilingMicros: 50 * MICROS, geoIds: ['2566'],
  keywords: [{ text: 'sermon clips', match: 'PHRASE' }], negatives: [],
  ad: { finalUrl: 'https://klipara.linkfa.de/free-clip', headlines: ['a', 'b', 'c'], descriptions: ['d', 'e'] },
}
const ENABLED = { status: 'ENABLED', conversionActions: 1 }
const live = (daily: number, extra: Partial<AdsCampaign> = {}): AdsCampaign => ({
  resource: `customers/1/campaigns/${String(daily)}`, budget: 'b', adGroup: 'g', siteId: 'klipara', customerId: '1', name: `c${String(daily)}`,
  dailyBudgetMicros: daily * MICROS, createdAt: 'x', enabledAt: 'x', ...extra,
})
const proposal = (extra: Partial<AdsProposal>): AdsProposal => ({ id: 'p1', siteId: 'klipara', kind: 'campaign', status: 'proposed', reason: '', createdAt: 'x', ...extra })

describe('the owner\'s limits', () => {
  it('refuses a campaign over the daily budget or click ceiling, and any campaign when the ceiling is 0', () => {
    expect(campaignLimitProblems(SPEC, LIMITS)).toEqual([])
    expect(campaignLimitProblems({ ...SPEC, dailyBudgetMicros: 2500 * MICROS }, LIMITS).join()).toContain('per-campaign limit')
    expect(campaignLimitProblems({ ...SPEC, cpcCeilingMicros: 150 * MICROS }, LIMITS).join()).toContain('bid ceiling')
    expect(campaignLimitProblems(SPEC, { ...LIMITS, monthlyCeiling: 0 }).join()).toContain('not allowed any spend')
  })

  it('projects only live, unpaused campaigns, at 30.4 days a month', () => {
    const { enabledAt: _never, ...notEnabled } = live(700)
    expect(projectedMonthly([live(1000), live(500, { paused: { reason: 'x', at: 'x' } }), notEnabled])).toBeCloseTo(30_400)
  })
})

describe('approving a proposal', () => {
  it('goes ahead within every limit', () => {
    expect(approvalBlock(proposal({ campaign: SPEC }), [], LIMITS, ENABLED)).toBeUndefined()
  })

  it('stops on a suspended account, missing conversion tracking, or a ceiling the new spend would pass', () => {
    expect(approvalBlock(proposal({ campaign: SPEC }), [], LIMITS, { status: 'SUSPENDED', conversionActions: 1 })).toContain('suspended')
    expect(approvalBlock(proposal({ campaign: SPEC }), [], LIMITS, { status: 'ENABLED', conversionActions: 0 })).toContain('conversion tracking')
    expect(approvalBlock(proposal({ campaign: SPEC }), [], { ...LIMITS, requireConversionTracking: false }, { status: 'ENABLED', conversionActions: 0 }))
      .toBeUndefined()
    expect(approvalBlock(proposal({ campaign: SPEC }), [live(1500)], LIMITS, ENABLED)).toContain('over the ceiling')
  })

  it('counts a budget raise by its difference and checks resume against the ceiling', () => {
    const c = live(1000)
    expect(approvalBlock(proposal({ kind: 'budget', campaignResource: c.resource, newDailyBudgetMicros: 1900 * MICROS }), [c], LIMITS, ENABLED)).toBeUndefined()
    expect(approvalBlock(proposal({ kind: 'budget', campaignResource: c.resource, newDailyBudgetMicros: 2100 * MICROS }), [c], LIMITS, ENABLED))
      .toContain('per-campaign limit')
    const paused = live(1000, { paused: { reason: 'x', at: 'x' } })
    expect(approvalBlock(proposal({ kind: 'resume', campaignResource: paused.resource }), [paused, live(1500)], LIMITS, ENABLED)).toContain('over the ceiling')
    expect(approvalBlock(proposal({ kind: 'resume', campaignResource: 'nope' }), [], LIMITS, ENABLED)).toContain('not one the ads employee runs')
  })
})

describe('the spend watcher', () => {
  it('pauses spend with no conversions past the limit, and costly conversions past 1.5 times it', () => {
    expect(campaignsToPause([
      { resource: 'a', costMicros: 6000 * MICROS, conversions: 0 },
      { resource: 'b', costMicros: 4000 * MICROS, conversions: 0 },
      { resource: 'c', costMicros: 20_000 * MICROS, conversions: 2 },
      { resource: 'd', costMicros: 10_000 * MICROS, conversions: 2 },
    ], 5000).map(p => p.resource)).toEqual(['a', 'c'])
    expect(campaignsToPause([{ resource: 'a', costMicros: 9e12, conversions: 0 }], 0)).toEqual([])
  })
})
