/** Reading the ads part of /seo/status, and the daily spend an approval allows. */

import { describe, expect, it } from 'vitest'
import { formatAdsMoney, parseAdsStatus, proposalDailyMicros } from '../src/client/ads-model.ts'
import { parseSeoStatus } from '../src/client/seo-sites-model.ts'

const campaignProposal = {
  id: 'p_1a2b', siteId: 'shop', kind: 'campaign', status: 'proposed', reason: 'Searches for "shoes lagos" convert on the site.',
  campaign: {
    name: 'Shoes Lagos', dailyBudgetMicros: 5_000_000_000, cpcCeilingMicros: 150_000_000, geoIds: ['2566'], languageId: '1000',
    keywords: [{ text: 'shoes lagos', match: 'EXACT' }, { text: 'buy shoes', match: 'PHRASE' }], negatives: ['free'],
    ad: { finalUrl: 'https://shop.example/shoes', headlines: ['Shoes in Lagos', 'Fast delivery'], descriptions: ['Two-day delivery inside Lagos.'] },
  },
  createdAt: '2026-10-01T09:00:00.000Z',
}

describe('parseAdsStatus', () => {
  it('reads proposals, campaigns, the pause and the last shift from /seo/status', () => {
    const status = parseSeoStatus({
      ads: {
        paused: { reason: 'monthly ceiling reached', at: '2026-10-01T10:00:00.000Z' },
        lastShiftDate: '2026-10-01',
        proposals: [
          campaignProposal,
          { id: 'p_9', siteId: 'shop', kind: 'budget', status: 'failed', reason: 'More', campaignResource: 'customers/1/campaigns/2', newDailyBudgetMicros: 8_000_000_000, createdAt: 'x', decidedAt: 'y', outcome: 'Not carried out: over the ceiling.' },
        ],
        campaigns: [{ resource: 'customers/1/campaigns/2', budget: 'b', adGroup: 'g', siteId: 'shop', customerId: '1', name: 'Shoes', dailyBudgetMicros: 5_000_000_000, createdAt: 'c', enabledAt: 'e' }],
      },
    })
    expect(status.ads.paused).toEqual({ reason: 'monthly ceiling reached', at: '2026-10-01T10:00:00.000Z' })
    expect(status.ads.lastShiftDate).toBe('2026-10-01')
    expect(status.ads.proposals[0]!.campaign).toEqual({
      name: 'Shoes Lagos', dailyBudgetMicros: 5_000_000_000, cpcCeilingMicros: 150_000_000, geoIds: ['2566'], languageId: '1000',
      keywords: [{ text: 'shoes lagos', match: 'EXACT' }, { text: 'buy shoes', match: 'PHRASE' }], negatives: ['free'],
      ad: { finalUrl: 'https://shop.example/shoes', headlines: ['Shoes in Lagos', 'Fast delivery'], descriptions: ['Two-day delivery inside Lagos.'], path1: '', path2: '' },
    })
    expect(status.ads.proposals[1]).toMatchObject({ kind: 'budget', status: 'failed', newDailyBudgetMicros: 8_000_000_000, outcome: 'Not carried out: over the ceiling.' })
    expect(status.ads.campaigns).toEqual([{
      resource: 'customers/1/campaigns/2', siteId: 'shop', customerId: '1', name: 'Shoes', dailyBudgetMicros: 5_000_000_000,
      createdAt: 'c', enabledAt: 'e', paused: undefined,
    }])
  })

  it('reads an older Host that sends no ads part as nothing proposed', () => {
    expect(parseSeoStatus({}).ads).toEqual({ paused: null, lastShiftDate: null, proposals: [], campaigns: [] })
  })

  it('drops entries without an id and reads unknown kinds and statuses as a waiting campaign', () => {
    const ads = parseAdsStatus({ proposals: [{ siteId: 'x' }, { id: 'p_2', kind: 'other', status: 'other' }], campaigns: [{ name: 'no resource' }] })
    expect(ads.proposals.map(p => [p.id, p.kind, p.status])).toEqual([['p_2', 'campaign', 'proposed']])
    expect(ads.campaigns).toEqual([])
  })
})

describe('the daily spend an approval allows', () => {
  it('is the campaign budget, the new budget, or the resumed campaign\'s budget, in currency units', () => {
    const ads = parseAdsStatus({
      proposals: [
        campaignProposal,
        { id: 'p_b', kind: 'budget', campaignResource: 'c/1', newDailyBudgetMicros: 7_500_000 },
        { id: 'p_r', kind: 'resume', campaignResource: 'c/1' },
        { id: 'p_gone', kind: 'resume', campaignResource: 'c/9' },
      ],
      campaigns: [{ resource: 'c/1', dailyBudgetMicros: 2_000_000 }],
    })
    expect(ads.proposals.map(p => proposalDailyMicros(p, ads.campaigns))).toEqual([5_000_000_000, 7_500_000, 2_000_000, undefined])
    expect(formatAdsMoney(5_000_000_000)).toBe((5000).toLocaleString())
  })
})
