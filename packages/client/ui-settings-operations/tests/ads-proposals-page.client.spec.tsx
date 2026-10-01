// @vitest-environment jsdom
/** The Ads proposals page: the owner reads the ad, approves behind a spend confirmation, rejects, and pauses everything. */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AdsProposals } from '../src/client/AdsProposals.tsx'

afterEach(cleanup)

/** Echo the key and its parameters, so queries name the dictionary entry and what it was given. */
const t = (key: string, params?: Record<string, unknown>) => params === undefined ? key : `${key} ${JSON.stringify(params)}`

const status = {
  redirectUri: '', google: { clientSet: true }, paused: null, lastShiftDate: null,
  sites: [{ id: 'shop', name: 'Shop' }], questions: [], topics: [], drafts: [], articles: [],
  ads: {
    paused: null, lastShiftDate: '2026-10-01',
    proposals: [
      {
        id: 'p_1a2b', siteId: 'shop', kind: 'campaign', status: 'proposed', reason: 'Searches for shoes in Lagos convert.',
        campaign: {
          name: 'Shoes Lagos', dailyBudgetMicros: 5_000_000_000, cpcCeilingMicros: 150_000_000, geoIds: ['2566'],
          keywords: [{ text: 'shoes lagos', match: 'EXACT' }], negatives: ['free'],
          ad: { finalUrl: 'https://shop.example/shoes', headlines: ['Shoes in Lagos', 'Fast delivery'], descriptions: ['Two-day delivery inside Lagos.'] },
        },
        createdAt: '2026-10-01T09:00:00.000Z',
      },
      { id: 'p_old', siteId: 'shop', kind: 'campaign', status: 'rejected', reason: 'r', createdAt: 'x', decidedAt: '2026-09-30T08:00:00.000Z' },
    ],
    campaigns: [
      { resource: 'c/1', siteId: 'shop', name: 'Sneakers', dailyBudgetMicros: 2_000_000_000, createdAt: '2026-09-20T08:00:00.000Z', enabledAt: 'e', paused: { reason: 'no conversions', at: 'a' } },
    ],
  },
}

function host(answer: object = { ok: true, outcome: 'Created Shoes Lagos and turned it on.' }) {
  return vi.fn((url: string, _init?: RequestInit) => Promise.resolve(new Response(
    JSON.stringify(url === '/seo/action' ? answer : status), { status: 200 },
  )))
}

/** The parsed bodies posted to the action route. */
function posted(request: ReturnType<typeof host>): Record<string, unknown>[] {
  return request.mock.calls.filter(call => call[0] === '/seo/action').map(call => JSON.parse(call[1]?.body as string) as Record<string, unknown>)
}

describe('the Ads proposals page', () => {
  it('shows the whole ad a proposal would run', async () => {
    render(<AdsProposals t={t} request={host()} />)
    expect(await screen.findByText('Searches for shoes in Lagos convert.')).toBeTruthy()
    expect(screen.getByText('Shoes in Lagos')).toBeTruthy()
    expect(screen.getByText('Fast delivery')).toBeTruthy()
    expect(screen.getByText('Two-day delivery inside Lagos.')).toBeTruthy()
    expect(screen.getByText('https://shop.example/shoes')).toBeTruthy()
    expect(screen.getByText(/shoes lagos/u)).toBeTruthy()
    expect(screen.getByText(/seoMarket\.ng \(2566\)/u)).toBeTruthy()
    expect(screen.getByText(/adsStateCampaignPaused.*no conversions/u)).toBeTruthy()
  })

  it('asks before approving, naming the daily spend, then posts approve-proposal and shows the outcome', async () => {
    const request = host()
    render(<AdsProposals t={t} request={request} />)
    fireEvent.click(await screen.findByText('adsApprove'))
    expect(posted(request)).toEqual([])
    expect(screen.getByText(`adsConfirm ${JSON.stringify({ amount: (5000).toLocaleString() })}`)).toBeTruthy()
    fireEvent.click(screen.getByText('adsConfirmYes'))
    await vi.waitFor(() => { expect(posted(request)).toEqual([{ action: 'approve-proposal', id: 'p_1a2b' }]) })
    expect(await screen.findByText(`adsOutcome ${JSON.stringify({ id: 'p_1a2b', outcome: 'Created Shoes Lagos and turned it on.' })}`)).toBeTruthy()
  })

  it('shows an outcome that says the approval was not carried out', async () => {
    const request = host({ ok: true, outcome: 'Not carried out: the monthly ceiling is 0.' })
    render(<AdsProposals t={t} request={request} />)
    fireEvent.click(await screen.findByText('adsApprove'))
    fireEvent.click(screen.getByText('adsConfirmYes'))
    expect(await screen.findByText(/Not carried out: the monthly ceiling is 0\./u)).toBeTruthy()
  })

  it('posts reject-proposal with the id', async () => {
    const request = host({ ok: true })
    render(<AdsProposals t={t} request={request} />)
    fireEvent.click(await screen.findByText('adsReject'))
    await vi.waitFor(() => { expect(posted(request)).toEqual([{ action: 'reject-proposal', id: 'p_1a2b' }]) })
  })

  it('pauses everything', async () => {
    const request = host({ ok: true })
    render(<AdsProposals t={t} request={request} />)
    fireEvent.click(await screen.findByText('adsPauseAll'))
    await vi.waitFor(() => { expect(posted(request)).toEqual([{ action: 'ads-pause' }]) })
  })
})
