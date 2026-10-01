import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { WhatsAppMessage } from '@deepseek-ai/dsh-host-employee-kit'
import { parseSite } from '../src/index.ts'
import { SeoStore } from '../src/store.ts'
import { buildSeoTools, type SeoDeps } from '../src/tools.ts'
import type { ArticleDraft, Publisher, RemoteArticle, Site } from '../src/types.ts'
import { BASE, baseDraft } from './fixtures.ts'

const exec = { signal: new AbortController().signal } as ToolRunContext

const SITE: Site = {
  id: 'klipara', name: 'Klipara', baseUrl: BASE, kind: 'klipara', enabled: true,
  profile: { business: 'Clips from long videos', audience: 'Podcasters in Nigeria', offer: 'Clipping plans', voice: 'Plain', cta: { text: 'Try it', url: `${BASE}/free-clip` } },
  markets: [{ label: 'Nigeria', geoId: '2566', languageId: '1000' }],
  seeds: ['podcast clips'], gscProperty: '', articlesPerWeek: 1,
  author: { name: 'Dave', url: '', bio: '' }, createdAt: '2026-10-01T00:00:00Z',
}

const GOOD = JSON.stringify({ scores: { directness: 8, specificity: 8, voice: 8, accuracy: 8, usefulness: 8 }, mustFix: [], verdict: 'publish' })
const WEAK = JSON.stringify({ scores: { directness: 5, specificity: 4, voice: 6, accuracy: 7, usefulness: 5 }, mustFix: ['Add a real example'], verdict: 'revise' })

function args(draft: ArticleDraft, topicId: string): Record<string, unknown> {
  return {
    topic_id: topicId, slug: draft.slug, title: draft.title, meta_title: draft.metaTitle, meta_description: draft.metaDescription,
    dek: draft.dek, body_markdown: draft.bodyMarkdown, tags: draft.tags, faq: draft.faq, sources: draft.sources,
    cover_image_url: draft.coverImageUrl, cover_alt: draft.coverAlt,
  }
}

function setup(now = new Date('2026-10-05T09:00:00Z')) {
  const store = new SeoStore(join(mkdtempSync(join(tmpdir(), 'seo-tools-')), 'state.json'))
  const notes: string[] = []
  const created: ArticleDraft[] = []
  const inbox: WhatsAppMessage[] = []
  let editorReply = GOOD
  const remote: RemoteArticle[] = [{ id: 'a1', slug: 'podcast-clipping-guide', title: 'Guide', url: `${BASE}/blog/podcast-clipping-guide`, status: 'published', tags: [] }]
  const publisher: Publisher = {
    list: () => Promise.resolve(remote),
    create: (draft) => {
      created.push(draft)
      return Promise.resolve({ id: `r${String(created.length)}`, slug: draft.slug, title: draft.title, url: `${BASE}/blog/${draft.slug}`, status: 'published', tags: draft.tags })
    },
    update: (id, draft) => Promise.resolve({ id, slug: draft.slug, title: draft.title, url: `${BASE}/blog/${draft.slug}`, status: 'published', tags: draft.tags }),
    unpublish: id => Promise.resolve({ id, slug: '', title: '', url: '', status: 'draft', tags: [] }),
    uploadMedia: url => Promise.resolve(url),
  }
  let adsCalls = 0
  const fetcher: typeof fetch = (input) => {
    const url = input instanceof Request ? input.url : input.toString()
    if (url.endsWith('/sitemap.xml')) return Promise.resolve(new Response(`<urlset><url><loc>${BASE}/pricing/</loc></url></urlset>`))
    if (url.includes('googleads.googleapis.com')) {
      adsCalls++
      return Promise.resolve(Response.json({ results: [{ text: 'podcast clips nigeria', keywordIdeaMetrics: { avgMonthlySearches: '320', competition: 'LOW', monthlySearchVolumes: [] } }] }))
    }
    return Promise.resolve(new Response('', { status: 404 }))
  }
  const deps: SeoDeps = {
    store,
    settings: { adsApiVersion: () => 'v25', researchCacheDays: () => 30, answerWaitHours: () => 48 },
    fetch: fetcher,
    now: () => now,
    googleToken: () => Promise.resolve('token'),
    adsAuth: () => Promise.resolve({ customerId: '1234567890', accessToken: () => Promise.resolve('token'), developerToken: 'dev' }),
    publisher: () => Promise.resolve(publisher),
    editor: () => Promise.resolve({ text: editorReply, provider: 'p', model: 'editor-model' }),
    notify: (text) => { notes.push(text); return Promise.resolve('sent to Owner') },
    readWhatsApp: () => Promise.resolve(inbox),
    unpublishLink: id => `https://h.test/seo/unpublish/${id}?sig=x`,
    makeImage: () => Promise.resolve({ sourceUrl: 'https://h.test/seo/media/a.png', width: 1200, height: 630, description: 'a cover graphic' }),
  }
  const tools = new Map(buildSeoTools(deps).map((t: ToolDefinition) => [t.name, t]))
  const run = async (name: string, a: Record<string, unknown> = {}): Promise<string> =>
    ((await tools.get(name)!.execute(a, exec)) as { text: string }).text
  return {
    store, notes, created, inbox, run, setEditor: (r: string) => { editorReply = r }, adsCalls: () => adsCalls,
    seed: () => store.update((s) => { s.sites = [SITE] }),
  }
}

async function plannedTopic(t: ReturnType<typeof setup>): Promise<string> {
  await t.seed()
  const saved = await t.run('seo_save_topic', { site_id: 'klipara', keyword: 'Podcast clips that travel', cluster: ['best podcast moments for shorts'], intent: 'informational', why: 'GSC position 11', serp_notes: 'thin listicles' })
  return /Topic (t_[0-9a-f]+)/u.exec(saved)?.[1] ?? ''
}

describe('the content map', () => {
  it('keeps one page per query: a second topic on a covered keyword is refused', async () => {
    const t = setup()
    await plannedTopic(t)
    await expect(t.run('seo_save_topic', { site_id: 'klipara', keyword: 'best podcast moments for shorts', intent: 'informational', why: 'x', serp_notes: 'y' }))
      .rejects.toThrow('already targets this query')
  })

  it('refuses work while paused', async () => {
    const t = setup()
    await t.seed()
    await t.run('seo_pause', { reason: 'spam warning' })
    expect(t.notes[0]).toContain('paused itself: spam warning')
    await expect(t.run('seo_save_topic', { site_id: 'klipara', keyword: 'x', intent: 'informational', why: 'x', serp_notes: 'y' })).rejects.toThrow('paused')
  })
})

describe('from question to published article', () => {
  it('waits for the owner, publishes only an editor-passed draft, tells the owner with an unpublish link, and holds the weekly cap', async () => {
    const t = setup()
    const topicId = await plannedTopic(t)

    await t.run('seo_ask_owner', { topic_id: topicId, questions: ['Which clip did a client share first?'] })
    const tag = /Reply starting with (#q[0-9a-f]{4})/u.exec(t.notes[0] ?? '')?.[1] ?? ''
    expect(tag).not.toBe('')
    await expect(t.run('seo_submit_draft', args(baseDraft(), topicId))).rejects.toThrow(`has not answered ${tag}`)

    t.inbox.push({ chat: 'owner', senderName: 'Dave', fromMe: false, ts: Date.parse('2026-10-05T10:00:00Z') / 1000, body: `${tag} The Lekki rent clip, it got 40k views.` })
    expect(await t.run('seo_check_answers')).toContain('The Lekki rent clip, it got 40k views.')

    const submitted = await t.run('seo_submit_draft', args(baseDraft(), topicId))
    const draftId = /Draft (d_[0-9a-f]+) passed/u.exec(submitted)?.[1] ?? ''
    expect(draftId).not.toBe('')

    await expect(t.run('seo_publish', { draft_id: draftId })).rejects.toThrow('has not been reviewed')
    t.setEditor(WEAK)
    expect(await t.run('seo_review_draft', { draft_id: draftId })).toContain('REVISE 27/50')
    await expect(t.run('seo_publish', { draft_id: draftId })).rejects.toThrow('did not pass')

    t.setEditor(GOOD)
    expect(await t.run('seo_review_draft', { draft_id: draftId })).toContain('PASS 40/50')
    expect(await t.run('seo_publish', { draft_id: draftId })).toContain(`Published ${BASE}/blog/podcast-clips-that-travel`)
    expect(t.created).toHaveLength(1)
    expect(t.notes.at(-1)).toContain('https://h.test/seo/unpublish/')
    const state = await t.store.read()
    expect(state.topics[0]?.status).toBe('published')
    expect(state.articles).toHaveLength(1)

    // The site's cap is one a week: the next new article waits.
    const second = await t.store.update((s) => {
      s.topics.push({ ...s.topics[0]!, id: 't_second', keyword: 'other topic', cluster: [], status: 'planned', target: 'new' })
      return 't_second'
    })
    const next = /Draft (d_[0-9a-f]+) passed/u.exec(await t.run('seo_submit_draft', args({ ...baseDraft(), slug: 'another-slug' }, second)))?.[1] ?? ''
    await t.run('seo_review_draft', { draft_id: next })
    await expect(t.run('seo_publish', { draft_id: next })).rejects.toThrow('had its 1 articles this week')
  })

  it('refuses a draft with problems, naming each', async () => {
    const t = setup()
    const topicId = await plannedTopic(t)
    const bad = { ...baseDraft(), metaDescription: 'Too short', bodyMarkdown: `${baseDraft().bodyMarkdown}\n\nLet's delve into it.` }
    await expect(t.run('seo_submit_draft', args(bad, topicId))).rejects.toThrow(/metaDescription[\s\S]*delve/u)
  })
})

describe('keyword research', () => {
  it('reads Keyword Planner once and serves the cached answer after', async () => {
    const t = setup()
    await t.seed()
    expect(await t.run('seo_keyword_ideas', { site_id: 'klipara' })).toContain('podcast clips nigeria: ~320/mo')
    expect(await t.run('seo_keyword_ideas', { site_id: 'klipara' })).toContain('cached')
    expect(t.adsCalls()).toBe(1)
  })
})

describe('a site from the SEO sites page', () => {
  it('needs https, a publisher kind, the business basics and an author', () => {
    const input = { name: 'Klipara', baseUrl: 'https://klipara.linkfa.de/x', kind: 'klipara', profile: { business: 'b', audience: 'a', offer: 'o' }, author: { name: 'Dave' } }
    expect(parseSite(input, undefined, 'now')).toMatchObject({ id: 'klipara', baseUrl: 'https://klipara.linkfa.de', articlesPerWeek: 2 })
    expect(parseSite({ ...input, baseUrl: 'http://x.test' }, undefined, 'now')).toContain('https://')
    expect(parseSite({ ...input, kind: 'ghost' }, undefined, 'now')).toContain('klipara or wordpress')
    expect(parseSite({ ...input, profile: {} }, undefined, 'now')).toContain('business, readers and offer')
  })
})

describe('per-site Google access', () => {
  it('reads the site\'s Ads account and access from the sites page, keeping old sites on the shared access', () => {
    const input = {
      name: 'Client', baseUrl: 'https://client.test', kind: 'wordpress', profile: { business: 'b', audience: 'a', offer: 'o' }, author: { name: 'A' },
      google: { access: 'own', adsCustomerId: '123-456-7890', adsLoginCustomerId: '815-207-0364' },
    }
    expect(parseSite(input, undefined, 'now')).toMatchObject({ google: { access: 'own', adsCustomerId: '1234567890', adsLoginCustomerId: '8152070364' } })
    expect(parseSite({ ...input, google: undefined }, undefined, 'now')).toMatchObject({ google: { access: 'shared', adsCustomerId: '' } })
  })

  it('runs Keyword Planner with the site\'s own access and account', async () => {
    const t = setup()
    await t.store.update((s) => {
      s.sites = [{ ...SITE, google: { access: 'own', adsCustomerId: '999', adsLoginCustomerId: '' } }]
    })
    const tokenSites: string[] = []
    const accounts: string[] = []
    const tools = new Map(buildSeoTools({
      store: t.store,
      settings: { adsApiVersion: () => 'v25', researchCacheDays: () => 30, answerWaitHours: () => 48 },
      fetch: (input) => {
        accounts.push(input instanceof Request ? input.url : input.toString())
        return Promise.resolve(Response.json({ results: [] }))
      },
      now: () => new Date(),
      googleToken: (_signal, site) => { tokenSites.push(site.id); return Promise.resolve('t') },
      adsAuth: site => Promise.resolve({ customerId: site.google?.adsCustomerId ?? '', accessToken: () => Promise.resolve('t') }),
      publisher: () => Promise.reject(new Error('unused')),
      editor: () => Promise.reject(new Error('unused')),
      notify: () => Promise.resolve(''),
      readWhatsApp: () => Promise.resolve([]),
      unpublishLink: () => '',
      makeImage: () => Promise.reject(new Error('unused')),
    }).map(x => [x.name, x]))
    await tools.get('seo_keyword_ideas')!.execute({ site_id: 'klipara' }, exec)
    expect(accounts[0]).toContain('/customers/999:generateKeywordIdeas')
    const status = ((await tools.get('seo_status')!.execute({}, exec)) as { text: string }).text
    expect(status).toContain('the site owner\'s own sign-in (NOT connected yet')
    void tokenSites
  })
})
