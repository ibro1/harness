import { describe, expect, it } from 'vitest'
import type { ArticleDraft, Site } from '../src/types.ts'
import {
  createPublisher, kliparaIdempotencyKey, kliparaPublisher, markdownToHtml, markdownToText, probeWordPress, PublisherError,
  wordpressPublisher,
} from '../src/publishers/index.ts'

const signal = new AbortController().signal
const author = { name: 'Dave Bukar', url: 'https://linkfa.de/about', bio: 'Builds things.' }
const KEY = 'klp_sk_test_fixturevalue'
const WP_USER = 'editor-bot'
const WP_PASS = 'abcd EFGH ijkl MNOP qrst UVWX'

/** One request the fake server saw. */
interface Seen {
  method: string
  url: URL
  headers: Headers
  body: string
  bytes: number
}

type Route = (req: Seen) => Response | Promise<Response>

/** The fields these tests read from a WordPress post request body. */
interface WpPostBody { status?: string; tags?: unknown; meta?: Record<string, string>; content?: string }

/** A fake HTTP server as a `fetch`: routes by `METHOD //host/path` or `METHOD /path`, records every request. */
function fakeServer(routes: Record<string, Route>): { fetcher: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = []
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const method = init?.method ?? 'GET'
    const raw = init?.body
    const buffer = raw instanceof Blob ? new Uint8Array(await raw.arrayBuffer()) : undefined
    const req: Seen = {
      method, url, headers: new Headers(init?.headers),
      body: typeof raw === 'string' ? raw : '',
      bytes: buffer?.byteLength ?? 0,
    }
    seen.push(req)
    const route = routes[`${method} //${url.host}${url.pathname}`] ?? routes[`${method} ${url.pathname}`]
    if (route === undefined) return json({ code: 'rest_no_route', message: 'No route' }, 404)
    return route(req)
  }
  return { fetcher, seen }
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
}

function draft(overrides: Partial<ArticleDraft> = {}): ArticleDraft {
  return {
    slug: 'clip-podcasts', title: 'How to clip podcasts', metaTitle: 'Clip podcasts fast',
    metaDescription: 'A guide to clipping podcasts for shorts.',
    dek: 'Turn long episodes into shorts.', bodyMarkdown: '## Why\n\nShort clips **travel**.\n\n::clip[abc123]\n',
    tags: ['Podcasts', 'Video'], faq: [{ q: 'Is it free?', a: 'The first *clip* is.' }],
    sources: [{ title: 'YouTube Shorts', url: 'https://youtube.com/shorts' }],
    ...overrides,
  }
}

/** Assert a promise rejects with a PublisherError and return it. */
async function failure(promise: Promise<unknown>): Promise<PublisherError> {
  const error: unknown = await promise.then(() => undefined, (e: unknown) => e)
  expect(error).toBeInstanceOf(PublisherError)
  if (!(error instanceof PublisherError)) throw new Error('unreachable')
  return error
}

describe('kliparaPublisher', () => {
  const base = 'https://klipara.test'
  const row = {
    id: 'a1', slug: 'one', title: 'One', url: 'https://klipara.test/blog/one', status: 'published', tags: ['x'],
    publishedAt: '2026-09-01T00:00:00Z',
  }

  it('lists articles across numbered pages until the total is reached', async () => {
    const server = fakeServer({
      'GET /api/v1/content/articles': req => req.url.searchParams.get('page') === '2'
        ? json({ articles: [{ ...row, id: 'a2', slug: 'two', status: 'draft' }], page: 2, page_size: 100, total: 2 })
        : json({ articles: [row], page: 1, page_size: 100, total: 2 }),
    })
    const list = await kliparaPublisher(server.fetcher, { baseUrl: `${base}/`, apiKey: () => KEY }, 5000).list(signal)
    expect(list.map(a => [a.id, a.status])).toEqual([['a1', 'published'], ['a2', 'draft']])
    expect(list[0]?.publishedAt).toBe('2026-09-01T00:00:00Z')
    expect(server.seen.map(r => r.url.searchParams.get('page_size'))).toEqual(['100', '100'])
    expect(server.seen.every(r => r.headers.get('authorization') === `Bearer ${KEY}`)).toBe(true)
  })

  it('creates with the full body and an Idempotency-Key stable across retries', async () => {
    const server = fakeServer({ 'POST /api/v1/content/articles': () => json({ data: { ...row, slug: 'clip-podcasts' } }, 201) })
    const publisher = kliparaPublisher(server.fetcher, { baseUrl: base, apiKey: () => KEY }, 5000)
    const created = await publisher.create(draft(), 'published', author, signal)
    await publisher.create(draft(), 'published', author, signal)
    await publisher.create(draft({ title: 'Changed' }), 'published', author, signal)
    expect(created.slug).toBe('clip-podcasts')
    const [first, retry, changed] = server.seen
    const body: unknown = JSON.parse(first?.body ?? '')
    expect(body).toEqual({
      slug: 'clip-podcasts', title: 'How to clip podcasts', meta_title: 'Clip podcasts fast',
      meta_description: 'A guide to clipping podcasts for shorts.', dek: 'Turn long episodes into shorts.',
      body_markdown: '## Why\n\nShort clips **travel**.\n\n::clip[abc123]\n', tags: ['Podcasts', 'Video'],
      faq: [{ q: 'Is it free?', a: 'The first *clip* is.' }], sources: [{ title: 'YouTube Shorts', url: 'https://youtube.com/shorts' }],
      author, status: 'published',
    })
    const key = first?.headers.get('idempotency-key')
    expect(key).toBe(kliparaIdempotencyKey('clip-podcasts', first?.body ?? ''))
    expect(key).toMatch(/^[0-9a-f]{64}$/u)
    expect(retry?.headers.get('idempotency-key')).toBe(key)
    expect(changed?.headers.get('idempotency-key')).not.toBe(key)
  })

  it('updates, unpublishes, reads one, and copies media', async () => {
    const server = fakeServer({
      'PUT /api/v1/content/articles/a%2F1': () => json(row),
      'POST /api/v1/content/articles/a1/unpublish': () => json({ article: { ...row, status: 'draft' } }),
      'GET /api/v1/content/articles/a1': () => json(row),
      'POST /api/v1/content/media': req => json({ url: `https://cdn.klipara.test/m/${String((JSON.parse(req.body) as { alt?: string }).alt)}.jpg` }),
    })
    const publisher = kliparaPublisher(server.fetcher, { baseUrl: base, apiKey: () => KEY }, 5000)
    await publisher.update('a/1', draft(), 'draft', author, signal)
    expect((await publisher.unpublish('a1', signal)).status).toBe('draft')
    expect((await publisher.get('a1', signal)).title).toBe('One')
    expect(await publisher.uploadMedia('https://img.test/a.jpg', 'cover', signal)).toBe('https://cdn.klipara.test/m/cover.jpg')
    expect(JSON.parse(server.seen[3]?.body ?? '')).toEqual({ url: 'https://img.test/a.jpg', alt: 'cover' })
    expect(server.seen[0]?.headers.get('idempotency-key')).toBeNull()
  })

  it('maps 422 reasons, auth refusals and server failures without leaking the key', async () => {
    let status = 422
    const server = fakeServer({
      'POST /api/v1/content/articles': () => status === 422
        ? json({ error: { code: 'invalid', details: [{ field: 'metaTitle', message: 'too long' }, 'slug taken'] } }, 422)
        : json({ error: { message: `bad token ${KEY}` } }, status),
    })
    const publisher = kliparaPublisher(server.fetcher, { baseUrl: base, apiKey: () => KEY }, 5000)
    const invalid = await failure(publisher.create(draft(), 'draft', author, signal))
    expect([invalid.code, invalid.retryable]).toEqual(['validation', false])
    expect(invalid.message).toContain('metaTitle: too long; slug taken')
    status = 401
    const auth = await failure(publisher.create(draft(), 'draft', author, signal))
    expect([auth.code, auth.retryable]).toEqual(['auth', false])
    expect(auth.message).toContain('content:write')
    status = 503
    const down = await failure(publisher.create(draft(), 'draft', author, signal))
    expect([down.code, down.retryable]).toEqual(['server', true])
    for (const e of [invalid, auth, down]) expect(e.message).not.toContain(KEY)
  })

  it('reports a timeout as retryable and rethrows a cancellation', async () => {
    const hang: typeof fetch = (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { const reason: unknown = init.signal?.reason; reject(reason instanceof Error ? reason : new Error(String(reason))) })
    })
    const timedOut = await failure(kliparaPublisher(hang, { baseUrl: base, apiKey: () => KEY }, 20).list(signal))
    expect([timedOut.code, timedOut.retryable]).toEqual(['timeout', true])
    const controller = new AbortController()
    const pending = kliparaPublisher(hang, { baseUrl: base, apiKey: () => KEY }, 5000).list(controller.signal)
    controller.abort(new Error('stopped'))
    await expect(pending).rejects.toThrow('stopped')
  })

  it('sends a null author so Klipara uses the site default when the profile has no author name', async () => {
    const server = fakeServer({ 'POST /api/v1/content/articles': () => json({ ...row, slug: 'clip-podcasts' }, 201) })
    await kliparaPublisher(server.fetcher, { baseUrl: base, apiKey: () => KEY }, 5000).create(draft(), 'draft', { name: '', url: '', bio: '' }, signal)
    expect((JSON.parse(server.seen[0]?.body ?? '{}') as { author?: unknown }).author).toBeNull()
  })
})

describe('wordpressPublisher', () => {
  const base = 'https://wp.test'
  const post = (id: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    id, slug: `p${String(id)}`, title: { raw: `Post &amp; ${String(id)}`, rendered: 'x' }, link: `${base}/p${String(id)}/`,
    status: 'publish', tags: [7], date: '2026-09-01T10:00:00', date_gmt: '2026-09-01T09:00:00',
    modified_gmt: '2026-09-02T09:00:00', ...extra,
  })

  /** A WordPress site with one existing tag (`Podcasts` = 7) and the given REST namespaces. */
  function site(namespaces: string[], overrides: Record<string, Route> = {}): ReturnType<typeof fakeServer> {
    let nextTag = 50
    return fakeServer({
      'GET /wp-json/': () => json({ name: 'WP &amp; Co', description: 'Tagline', namespaces: ['wp/v2', ...namespaces] }),
      'GET /wp-json/wp/v2/tags': (req) => {
        const search = req.url.searchParams.get('search')
        if (search !== null) return json(search === 'Podcasts' ? [{ id: 7, name: 'Podcasts' }, { id: 8, name: 'Podcasts Weekly' }] : [])
        const ids = (req.url.searchParams.get('include') ?? '').split(',')
        return json(ids.map(id => ({ id: Number(id), name: id === '7' ? 'Podcasts' : `t${id}` })))
      },
      'POST /wp-json/wp/v2/tags': req => json({ id: nextTag++, name: String((JSON.parse(req.body) as { name?: string }).name) }, 201),
      'POST /wp-json/wp/v2/posts': req => json(post(99, { status: (JSON.parse(req.body) as WpPostBody).status, tags: (JSON.parse(req.body) as WpPostBody).tags }), 201),
      'POST /wp-json/wp/v2/posts/99': req => json(post(99, { status: (JSON.parse(req.body) as WpPostBody).status })),
      'GET //img.test/a.png': () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/png' } }),
      'POST /wp-json/wp/v2/media': () => json({ id: 300, source_url: `${base}/wp-content/uploads/a.png` }, 201),
      'POST /wp-json/wp/v2/media/300': () => json({ id: 300 }),
      ...overrides,
    })
  }
  const options = { baseUrl: base, user: () => WP_USER, appPassword: () => WP_PASS }

  it('lists posts across X-WP-TotalPages with Basic auth and tag names', async () => {
    const server = site([], {
      'GET /wp-json/wp/v2/posts': req => req.url.searchParams.get('page') === '2'
        ? json([post(2, { status: 'draft', tags: [9] })], 200, { 'X-WP-TotalPages': '2' })
        : json([post(1)], 200, { 'X-WP-TotalPages': '2' }),
    })
    const list = await wordpressPublisher(server.fetcher, options, 5000).list(signal)
    expect(list).toEqual([
      {
        id: '1', slug: 'p1', title: 'Post & 1', url: `${base}/p1/`, status: 'published', tags: ['Podcasts'],
        publishedAt: '2026-09-01T09:00:00Z', updatedAt: '2026-09-02T09:00:00Z',
      },
      { id: '2', slug: 'p2', title: 'Post & 2', url: `${base}/p2/`, status: 'draft', tags: ['t9'], updatedAt: '2026-09-02T09:00:00Z' },
    ])
    const first = server.seen[0]
    expect(first?.url.searchParams.get('status')).toBe('publish,draft')
    expect(first?.url.searchParams.get('context')).toBe('edit')
    expect(first?.url.searchParams.get('per_page')).toBe('100')
    expect(first?.headers.get('authorization')).toBe(`Basic ${Buffer.from(`${WP_USER}:${WP_PASS}`).toString('base64')}`)
  })

  it('creates a post with HTML content, resolved and created tags, cover, and no SEO meta without a plugin', async () => {
    const server = site([])
    const created = await wordpressPublisher(server.fetcher, options, 5000).create(
      draft({ coverImageUrl: 'https://img.test/a.png', coverAlt: 'A cover' }), 'published', author, signal,
    )
    expect(created).toMatchObject({ id: '99', status: 'published', tags: ['Podcasts', 'Video'] })
    const postReq = server.seen.find(r => r.method === 'POST' && r.url.pathname === '/wp-json/wp/v2/posts')
    const body = JSON.parse(postReq?.body ?? '{}') as WpPostBody
    expect(body).toMatchObject({
      title: 'How to clip podcasts', slug: 'clip-podcasts', excerpt: 'Turn long episodes into shorts.', status: 'publish',
      tags: [7, 50], featured_media: 300,
    })
    expect(body.meta).toBeUndefined()
    expect(body.content).toContain('<h2>Why</h2>')
    expect(body.content).toContain('<p><a href="https://klipara.linkfa.de/s/abc123">Watch the clip</a></p>')
    expect(body.content).toContain('<h2>Questions</h2>\n<h3>Is it free?</h3>\n<p>The first <em>clip</em> is.</p>')
    expect(body.content).toContain('<h2>Sources</h2>\n<ul><li><a href="https://youtube.com/shorts" rel="noopener">YouTube Shorts</a></li>')
    expect(body.content).not.toContain('<script')
    const upload = server.seen.find(r => r.url.pathname === '/wp-json/wp/v2/media')
    expect(upload?.headers.get('content-disposition')).toBe('attachment; filename="a.png"')
    expect(upload?.headers.get('content-type')).toBe('image/png')
    expect(upload?.bytes).toBe(3)
    expect(JSON.parse(server.seen.find(r => r.url.pathname === '/wp-json/wp/v2/media/300')?.body ?? '')).toEqual({ alt_text: 'A cover' })
    expect(server.seen.find(r => r.url.host === 'img.test')?.headers.get('authorization')).toBeNull()
    const tagCreate = server.seen.find(r => r.method === 'POST' && r.url.pathname === '/wp-json/wp/v2/tags')
    expect(JSON.parse(tagCreate?.body ?? '')).toEqual({ name: 'Video' })
  })

  it('writes Yoast meta when probed, Rank Math meta when probed, and probes once', async () => {
    const yoast = site(['yoast/v1'])
    const publisher = wordpressPublisher(yoast.fetcher, options, 5000)
    await publisher.create(draft({ tags: [] }), 'draft', author, signal)
    await publisher.update('99', draft({ tags: [] }), 'published', author, signal)
    const bodies = yoast.seen.filter(r => r.url.pathname.startsWith('/wp-json/wp/v2/posts')).map(r => JSON.parse(r.body) as WpPostBody)
    expect(bodies.map(b => [b.status, b.meta])).toEqual([
      ['draft', { _yoast_wpseo_title: 'Clip podcasts fast', _yoast_wpseo_metadesc: 'A guide to clipping podcasts for shorts.' }],
      ['publish', { _yoast_wpseo_title: 'Clip podcasts fast', _yoast_wpseo_metadesc: 'A guide to clipping podcasts for shorts.' }],
    ])
    expect(yoast.seen.filter(r => r.url.pathname === '/wp-json/')).toHaveLength(1)
    const rank = site(['rankmath/v1'])
    await wordpressPublisher(rank.fetcher, options, 5000).create(draft({ tags: [] }), 'draft', author, signal)
    const rankBody = JSON.parse(rank.seen.find(r => r.url.pathname === '/wp-json/wp/v2/posts')?.body ?? '{}') as WpPostBody
    expect(rankBody.meta).toEqual({
      rank_math_title: 'Clip podcasts fast', rank_math_description: 'A guide to clipping podcasts for shorts.',
    })
  })

  it('unpublishes by setting the post to draft', async () => {
    const server = site([])
    const result = await wordpressPublisher(server.fetcher, options, 5000).unpublish('99', signal)
    expect(result.status).toBe('draft')
    expect(JSON.parse(server.seen[0]?.body ?? '')).toEqual({ status: 'draft' })
  })

  it('maps rest_cannot_create to an auth error naming application passwords, without credentials', async () => {
    const server = site([], {
      'POST /wp-json/wp/v2/posts': () => json({ code: 'rest_cannot_create', message: `Sorry ${WP_USER}`, data: { status: 401 } }, 401),
      'POST /wp-json/wp/v2/posts/5': () => json(
        { code: 'rest_invalid_param', message: 'Invalid', data: { params: { slug: `bad for ${WP_USER}` } } }, 400,
      ),
    })
    const publisher = wordpressPublisher(server.fetcher, options, 5000)
    const auth = await failure(publisher.create(draft({ tags: [] }), 'draft', author, signal))
    expect([auth.code, auth.retryable, auth.status]).toEqual(['auth', false, 401])
    expect(auth.message).toContain('create an application password for a user who can publish posts')
    const invalid = await failure(publisher.update('5', draft({ tags: [] }), 'draft', author, signal))
    expect([invalid.code, invalid.retryable]).toEqual(['validation', false])
    expect(invalid.message).toContain('slug: bad for [redacted]')
    for (const e of [auth, invalid]) {
      expect(e.message).not.toContain(WP_USER)
      expect(e.message).not.toContain(WP_PASS)
    }
  })

  it('refuses a non-image or oversized cover', async () => {
    const server = site([], {
      'GET //img.test/page.html': () => new Response('<html>', { headers: { 'Content-Type': 'text/html' } }),
      'GET //img.test/huge.png': () => new Response(new Uint8Array(8), {
        headers: { 'Content-Type': 'image/png', 'Content-Length': String(11 * 1024 * 1024) },
      }),
    })
    const publisher = wordpressPublisher(server.fetcher, options, 5000)
    expect((await failure(publisher.uploadMedia('https://img.test/page.html', '', signal))).code).toBe('validation')
    expect((await failure(publisher.uploadMedia('https://img.test/huge.png', '', signal))).message).toContain('larger than 10 MB')
    expect(server.seen.some(r => r.url.pathname === '/wp-json/wp/v2/media')).toBe(false)
  })
})

describe('probeWordPress', () => {
  it('reads the name, tagline and SEO plugin from the public index without credentials', async () => {
    const index = { name: 'Linkfa &amp; Co', description: 'Cloud', namespaces: ['wp/v2', 'yoast/v1'] }
    const server = fakeServer({ 'GET /wp-json/': () => json(index) })
    expect(await probeWordPress(server.fetcher, 'https://wp.test/', signal))
      .toEqual({ isWordPress: true, name: 'Linkfa & Co', description: 'Cloud', seoPlugin: 'yoast' })
    expect(server.seen[0]?.headers.get('authorization')).toBeNull()
  })

  it('reports a non-WordPress or unreachable site as not WordPress', async () => {
    const notWp = fakeServer({ 'GET /wp-json/': () => new Response('<html>', { status: 200 }) })
    expect((await probeWordPress(notWp.fetcher, 'https://x.test', signal)).isWordPress).toBe(false)
    const down: typeof fetch = () => Promise.reject(new TypeError('fetch failed'))
    expect(await probeWordPress(down, 'https://x.test', signal))
      .toEqual({ isWordPress: false, name: '', description: '', seoPlugin: 'none' })
  })
})

describe('createPublisher', () => {
  const siteOf = (kind: Site['kind']): Site => ({
    id: 's1', name: 'Linkfa', baseUrl: 'https://linkfa.de', kind, enabled: true,
    profile: { business: '', audience: '', offer: '', voice: '', cta: { text: '', url: '' } },
    markets: [], seeds: [], gscProperty: '', articlesPerWeek: 1, author, createdAt: '2026-10-01T00:00:00Z',
  })
  const noFetch: typeof fetch = () => Promise.reject(new Error('no network'))

  it('names the missing credential', () => {
    expect(() => createPublisher(noFetch, siteOf('klipara'), () => ({}), 1000)).toThrow(/Klipara API key \(apiKey\)/u)
    expect(() => createPublisher(noFetch, siteOf('wordpress'), () => ({ wpUser: 'u' }), 1000))
      .toThrow(/application password \(wpAppPassword\)/u)
    expect(() => createPublisher(noFetch, siteOf('wordpress'), () => ({ wpAppPassword: 'p' }), 1000)).toThrow(/WordPress user \(wpUser\)/u)
  })

  it('builds the connector for the site kind', async () => {
    const server = fakeServer({ 'GET /api/v1/content/articles': () => json({ articles: [], page: 1, page_size: 100, total: 0 }) })
    const publisher = createPublisher(server.fetcher, siteOf('klipara'), () => ({ apiKey: KEY }), 1000)
    expect(await publisher.list(signal)).toEqual([])
    expect(server.seen[0]?.url.href).toBe('https://linkfa.de/api/v1/content/articles?page=1&page_size=100')
  })
})

describe('markdownToHtml', () => {
  it('converts the supported subset', () => {
    const md = [
      '# Top', '### Third', '##### Deep', '', 'Some **bold**, *italic*, __b2__, _i2_ and `a<b>`.', 'Same paragraph.', '',
      '```ts', 'const x = "<y>"', '```', '', '- one', '  - nested', '- two', '', '3. three', '4. four', '',
      '> quoted *text*', '', '---', '',
      '![Alt](https://img.test/a.png) [rel](/about) [ext](https://other.test) [same](https://linkfa.de/x)',
    ].join('\n')
    expect(markdownToHtml(md, { siteOrigin: 'https://linkfa.de' })).toBe([
      '<h2>Top</h2>', '<h3>Third</h3>', '<h4>Deep</h4>',
      '<p>Some <strong>bold</strong>, <em>italic</em>, <strong>b2</strong>, <em>i2</em> and <code>a&lt;b&gt;</code>. Same paragraph.</p>',
      '<pre><code class="language-ts">const x = &quot;&lt;y&gt;&quot;</code></pre>',
      '<ul><li>one<ul><li>nested</li></ul></li><li>two</li></ul>',
      '<ol start="3"><li>three</li><li>four</li></ol>',
      '<blockquote><p>quoted <em>text</em></p></blockquote>',
      '<hr>',
      '<p><img src="https://img.test/a.png" alt="Alt" loading="lazy"> <a href="/about">rel</a> '
      + '<a href="https://other.test" rel="noopener">ext</a> <a href="https://linkfa.de/x">same</a></p>',
    ].join('\n'))
  })

  it('escapes raw HTML and drops unsafe link targets', () => {
    const html = markdownToHtml([
      '<script>alert(1)</script>', '', '[x](javascript:alert(1)) [y](JaVaScRiPt:alert(1)) [z](data:text/html,hi) [w](//evil.test)',
      '', '![i](javascript:alert(1)) <img src=x onerror=alert(1)> [q](https://ok.test/"onmouseover=x)',
    ].join('\n'))
    expect(html).not.toMatch(/<script|<img src=x|href="javascript|href="data|href="\/\/|src="javascript/iu)
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).toContain('<p>x y z w</p>')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).toContain('<p>i &lt;img src=x onerror=alert(1)&gt; q</p>')
  })

  it('renders clip lines only through the clip option', () => {
    expect(markdownToHtml('::clip[ab_1]')).toBe('<p>::clip[ab_1]</p>')
    expect(markdownToHtml('::clip[ab_1]', { clipUrl: id => `https://k.test/s/${id}` }))
      .toBe('<p><a href="https://k.test/s/ab_1">Watch the clip</a></p>')
  })

  it('reduces markdown to text for word counts', () => {
    const md = '## Head\n\nSome **bold** [link](https://x.test) &amp;\n\n```\ncode here\n```\n\n- a\n- b\n\n::clip[x]'
    expect(markdownToText(md)).toBe('Head\nSome bold link &amp;\na\nb')
  })
})
