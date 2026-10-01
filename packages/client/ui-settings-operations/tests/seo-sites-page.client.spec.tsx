// @vitest-environment jsdom
/** The SEO sites page: the add-site form posts save-site, and open questions post their answer. */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SeoSites } from '../src/client/SeoSites.tsx'

afterEach(cleanup)

/** Echo the key, so queries name the dictionary entry. */
const t = (key: string) => key

const status = {
  redirectUri: '', google: { clientSet: false, adsSet: false, connected: false, connectedAt: null }, paused: null, lastShiftDate: '2026-09-30',
  sites: [], topics: [], drafts: [], articles: [],
  questions: [{ tag: '#q7k2', siteId: 'shop', topicId: 't1', questions: ['How long does delivery take?'], askedAt: '2026-09-30T10:00:00.000Z', keyword: 'delivery lagos' }],
}

function host() {
  return vi.fn((url: string, _init?: RequestInit) => Promise.resolve(new Response(
    JSON.stringify(url === '/seo/action' ? { ok: true, site: { id: 'shop' } } : status), { status: 200 },
  )))
}

/** The parsed bodies posted to the action route. */
function posted(request: ReturnType<typeof host>): Record<string, unknown>[] {
  return request.mock.calls.filter(call => call[0] === '/seo/action').map(call => JSON.parse(call[1]?.body as string) as Record<string, unknown>)
}

describe('the SEO sites page', () => {
  it('posts save-site with the typed site, the checked markets and the WordPress credentials', async () => {
    const request = host()
    render(<SeoSites t={t} request={request} />)
    fireEvent.click(await screen.findByText('seoAddSite'))
    const type = (label: string, value: string) => { fireEvent.change(screen.getByLabelText(label), { target: { value } }) }
    type('seoSite.name', 'Shop')
    type('seoSite.baseUrl', 'https://shop.example')
    fireEvent.click(screen.getByRole('radio', { name: 'seoKind.wordpress' }))
    type('seoSite.business', 'Sells shoes')
    type('seoSite.audience', 'Lagos buyers')
    type('seoSite.offer', 'Shoes')
    fireEvent.click(screen.getByLabelText('seoMarket.ng'))
    type('seoSite.seeds', 'shoes\n\nsneakers ')
    type('seoSite.authorName', 'Ada')
    type('seoSite.wpUser', 'editor')
    type('seoSite.wpAppPassword', 'abcd efgh')
    fireEvent.click(screen.getByText('seoSave'))

    await vi.waitFor(() => { expect(posted(request)).toHaveLength(1) })
    const body = posted(request)[0]!
    expect(body['action']).toBe('save-site')
    expect(body['site']).toMatchObject({
      name: 'Shop', baseUrl: 'https://shop.example', kind: 'wordpress', enabled: true,
      profile: { business: 'Sells shoes', audience: 'Lagos buyers', offer: 'Shoes' },
      markets: [{ label: 'Nigeria', geoId: '2566', languageId: '1000' }],
      seeds: ['shoes', 'sneakers'], articlesPerWeek: 2, author: { name: 'Ada' },
    })
    expect(body['secrets']).toEqual({ wpUser: 'editor', wpAppPassword: 'abcd efgh' })
    expect(await screen.findByText('seoSaved')).toBeTruthy()
  })

  it('sends an answer to an open question by its tag', async () => {
    const request = host()
    render(<SeoSites t={t} request={request} />)
    fireEvent.change(await screen.findByLabelText('seoAnswerLabel'), { target: { value: 'Two days inside Lagos.' } })
    fireEvent.click(screen.getByText('seoAnswerSend'))
    await vi.waitFor(() => { expect(posted(request)).toEqual([{ action: 'answer', tag: '#q7k2', answer: 'Two days inside Lagos.' }]) })
  })
})
