/** The SEO sites page's helpers: reading /seo/status, and the save-site body the form posts. */

import { describe, expect, it, vi } from 'vitest'
import {
  buildSaveSiteBody, emptySiteForm, parseArticlesPerWeek, parseSeoStatus, postSeoAction, siteFormFrom, type SeoSite,
} from '../src/client/seo-sites-model.ts'

const site: SeoSite = {
  id: 'klipara', name: 'Klipara blog', baseUrl: 'https://klipara.linkfa.de', kind: 'klipara', enabled: true,
  profile: { business: 'Clips long videos', audience: 'Podcasters', offer: 'Klips', voice: 'Plain.\nAvoid: unlock, game-changer', cta: { text: 'Try it', url: 'https://klipara.linkfa.de' } },
  markets: [
    { label: 'Nigeria', geoId: '2566', languageId: '1000' },
    { label: 'Hausa speakers in Nigeria', geoId: '2566', languageId: '' },
    { label: 'France', geoId: '2250', languageId: '1002' },
  ],
  seeds: ['podcast clips', 'youtube shorts'], gscProperty: 'sc-domain:linkfa.de', articlesPerWeek: 3,
  author: { name: 'Dave', url: '', bio: '' }, createdAt: '2026-09-01T00:00:00.000Z',
  secretsSet: { apiKey: true, wpUser: false, wpAppPassword: false }, thisWeek: 1,
}

describe('parseSeoStatus', () => {
  it('reads every section and fills what a partial answer leaves out', () => {
    const status = parseSeoStatus({
      redirectUri: 'https://h.example/seo/oauth/callback',
      google: { clientSet: true, adsSet: false, clientSecretSet: true, developerTokenSet: false, connected: true, connectedAt: '2026-09-30T08:00:00.000Z' },
      paused: { reason: 'paused by the owner', at: '2026-09-30T09:00:00.000Z' },
      sites: [{ ...site, secretsSet: { apiKey: true } }],
      questions: [{ tag: '#q7k2', siteId: 'klipara', topicId: 't1', questions: ['How long?'], askedAt: '2026-09-29T10:00:00.000Z', keyword: 'podcast clips' }],
      drafts: [{ id: 'd1', siteId: 'klipara', topicId: 't1', title: 'Draft', submittedAt: '2026-09-30T10:00:00.000Z', editor: null }],
      articles: [{ id: 'a1', siteId: 'klipara', title: 'A', url: 'https://x', publishedAt: '2026-09-30', editorTotal: 41, metrics: [{ at: 'x', days: 28, clicks: 3, impressions: 90, position: 12.4 }], unpublishUrl: 'https://h/u' }],
    })
    expect(status.google).toEqual({ clientSet: true, adsSet: false, clientSecretSet: true, developerTokenSet: false, connected: true, connectedAt: '2026-09-30T08:00:00.000Z' })
    expect(status.paused).toEqual({ reason: 'paused by the owner', at: '2026-09-30T09:00:00.000Z' })
    expect(status.lastShiftDate).toBeNull()
    expect(status.sites[0]!.secretsSet).toEqual({ apiKey: true, wpUser: false, wpAppPassword: false })
    expect(status.questions[0]!.answer).toBeUndefined()
    expect(status.topics).toEqual([])
    expect(status.drafts[0]!.editor).toBeNull()
    expect(status.articles[0]!.metrics[0]!.position).toBe(12.4)
  })

  it('reads an empty answer as nothing set up', () => {
    expect(parseSeoStatus({})).toMatchObject({ redirectUri: '', google: { clientSet: false, connected: false, connectedAt: null }, paused: null, sites: [] })
  })
})

describe('the save-site body', () => {
  it('round-trips a saved site, keeping markets the checkboxes do not offer', () => {
    const body = buildSaveSiteBody(siteFormFrom(site))!
    expect(body.action).toBe('save-site')
    expect(body.site).toEqual({
      id: 'klipara', name: 'Klipara blog', baseUrl: 'https://klipara.linkfa.de', kind: 'klipara', enabled: true,
      profile: site.profile,
      markets: [
        { label: 'Nigeria', geoId: '2566', languageId: '1000' },
        { label: 'Hausa speakers in Nigeria', geoId: '2566', languageId: '' },
        { label: 'France', geoId: '2250', languageId: '1002' },
      ],
      seeds: ['podcast clips', 'youtube shorts'], gscProperty: 'sc-domain:linkfa.de', articlesPerWeek: 3,
      author: { name: 'Dave', url: '', bio: '' },
    })
  })

  it('sends no secrets when the credential fields are blank, so the Host keeps the stored ones', () => {
    expect(buildSaveSiteBody(siteFormFrom(site))!.secrets).toEqual({})
  })

  it('sends only the credentials of the chosen publisher, trimmed', () => {
    const form = { ...emptySiteForm(), name: 'Shop', baseUrl: 'https://shop.example', kind: 'wordpress' as const, apiKey: 'klp_sk_live_x', wpUser: ' editor ', wpAppPassword: 'abcd efgh' }
    const body = buildSaveSiteBody(form)!
    expect(body.secrets).toEqual({ wpUser: 'editor', wpAppPassword: 'abcd efgh' })
    expect(body.site['id']).toBeUndefined()
    expect(body.site['articlesPerWeek']).toBe(2)
  })

  it('refuses articles per week outside 0 to 7', () => {
    expect(parseArticlesPerWeek('0')).toBe(0)
    expect(parseArticlesPerWeek('7')).toBe(7)
    expect(parseArticlesPerWeek('8')).toBeUndefined()
    expect(parseArticlesPerWeek('2.5')).toBeUndefined()
    expect(buildSaveSiteBody({ ...emptySiteForm(), articlesPerWeek: '' })).toBeUndefined()
  })

  it('posts the body as JSON to the action route and reports the Host\'s refusal', async () => {
    const request = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(new Response(JSON.stringify({ error: 'Give the site a name.' }), { status: 422 })))
    const body = buildSaveSiteBody(emptySiteForm())!
    const result = await postSeoAction(request, { ...body })
    expect(request).toHaveBeenCalledWith('/seo/action', expect.objectContaining({ method: 'POST', body: JSON.stringify(body) }))
    expect(result).toEqual({ ok: false, error: 'Give the site a name.' })
  })
})
