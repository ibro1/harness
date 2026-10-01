/**
 * The WordPress connector: posts go through the REST API v2 at
 * `<baseUrl>/wp-json/wp/v2` with Basic authentication by an application
 * password. Drafts are converted to HTML here; the FAQ and sources become
 * "Questions" and "Sources" sections, and `::clip[<id>]` lines become links to
 * the clip's Klipara page. Meta title and description are written to Yoast or
 * Rank Math fields when the site's REST index lists that plugin's namespace.
 */

import type { ArticleDraft, ArticleStatus, Publisher, RemoteArticle } from '../types.ts'
import { escapeHtml, markdownToHtml } from './markdown.ts'
import {
  badResponse, callSignal, invalidInput, parseJson, PublisherError, record, redact, statusFailure, text, transportFailure,
} from './errors.ts'

/** Where the WordPress connector writes and as whom. */
export interface WordPressPublisherOptions {
  /** The site origin, for example `https://linkfa.de`. */
  baseUrl: string
  /** Reads the WordPress user name at call time. */
  user: () => string
  /** Reads the application password at call time. */
  appPassword: () => string
}

/** The SEO plugin whose meta fields the connector writes. */
export type WordPressSeoPlugin = 'yoast' | 'rankmath' | 'none'

/** What a site's public REST index says about it. */
export interface WordPressProbe {
  /** Whether `/wp-json/` answered with a WordPress index listing `wp/v2`. */
  isWordPress: boolean
  /** The site title, empty when unknown. */
  name: string
  /** The site tagline, empty when unknown. */
  description: string
  seoPlugin: WordPressSeoPlugin
}

/** Klipara's public clip page; `::clip[<id>]` links to `<this><id>`. */
export const KLIPARA_CLIP_PAGE = 'https://klipara.linkfa.de/s/'
/** Largest cover image the connector copies to a site. */
export const MAX_MEDIA_BYTES = 10 * 1024 * 1024
/** Stop following post pages after this many. */
const MAX_LIST_PAGES = 100
/** WordPress caps `per_page` and `include` at 100. */
const PAGE_SIZE = 100

const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif', 'image/svg+xml': 'svg',
}

/** An image body for `POST /wp/v2/media`. */
interface Upload {
  bytes: Uint8Array<ArrayBuffer>
  type: string
  fileName: string
}

/** Read the SEO plugin from a REST index's `namespaces`. */
function seoPluginOf(index: Record<string, unknown>): WordPressSeoPlugin {
  const namespaces = Array.isArray(index['namespaces']) ? index['namespaces'].map(text) : []
  if (namespaces.includes('yoast/v1')) return 'yoast'
  if (namespaces.includes('rankmath/v1')) return 'rankmath'
  return 'none'
}

/**
 * Read a site's public REST index (`/wp-json/`, no credentials). Any failure
 * other than the caller's cancellation reads as "not WordPress".
 * @param fetcher - the HTTP client.
 * @param baseUrl - the site origin.
 * @param signal - cancels the read.
 * @returns whether the site is WordPress, its title and tagline, and its SEO plugin.
 */
export async function probeWordPress(fetcher: typeof fetch, baseUrl: string, signal: AbortSignal): Promise<WordPressProbe> {
  const none: WordPressProbe = { isWordPress: false, name: '', description: '', seoPlugin: 'none' }
  let raw: string
  try {
    const response = await fetcher(`${baseUrl.replace(/\/+$/u, '')}/wp-json/`, { headers: { Accept: 'application/json' }, signal })
    if (!response.ok) return none
    raw = await response.text()
  } catch {
    // TypeError from fetch: an unreachable site is reported as not WordPress; a cancellation is rethrown.
    if (signal.aborted) throw signal.reason
    return none
  }
  const index = record(parseJson(raw))
  const namespaces = Array.isArray(index['namespaces']) ? index['namespaces'].map(text) : []
  if (!namespaces.includes('wp/v2')) return none
  const name = decodeEntities(text(index['name']))
  return { isWordPress: true, name, description: decodeEntities(text(index['description'])), seoPlugin: seoPluginOf(index) }
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ', hellip: '…',
  ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
}

/** Decode the entities WordPress puts in titles and term names, and drop tags. */
function decodeEntities(value: string): string {
  return value.replace(/<[^>]*>/gu, '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) return String.fromCodePoint(Number.parseInt(body.slice(2), 16))
    if (body.startsWith('#')) return String.fromCodePoint(Number.parseInt(body.slice(1), 10))
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole
  })
}

/**
 * Render a draft as the post's HTML: the body, then a "Questions" section with
 * one `<h3>` per question, then a "Sources" list.
 * @param draft - the article.
 * @param siteOrigin - the site origin, so links to the site carry no `rel`.
 * @returns the post content.
 */
export function wordpressContent(draft: ArticleDraft, siteOrigin: string): string {
  const options = { siteOrigin, clipUrl: (id: string) => `${KLIPARA_CLIP_PAGE}${id}` }
  const parts = [markdownToHtml(draft.bodyMarkdown, options)]
  if (draft.faq.length > 0) {
    const faq = draft.faq.map(f => `<h3>${escapeHtml(f.q)}</h3>\n${markdownToHtml(f.a, options)}`).join('\n')
    parts.push(`<section class="faq">\n<h2>Questions</h2>\n${faq}\n</section>`)
  }
  if (draft.sources.length > 0) {
    const items = draft.sources.map((s) => {
      const linked = markdownToHtml(`[${s.title.replace(/[[\]\\]/gu, '\\$&')}](${s.url})`, options)
      return `<li>${linked.replace(/^<p>|<\/p>$/gu, '')}</li>`
    })
    parts.push(`<h2>Sources</h2>\n<ul>${items.join('')}</ul>`)
  }
  return parts.join('\n')
}

/** A file name for an uploaded image: the URL's last path segment, reduced to safe characters, with the type's extension. */
function mediaFileName(imageUrl: string, contentType: string): string {
  const extension = IMAGE_EXTENSIONS[contentType] ?? 'img'
  const last = new URL(imageUrl).pathname.split('/').at(-1) ?? ''
  const stem = last.replace(/\.[^.]*$/u, '').toLowerCase().replace(/[^a-z0-9_-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 80)
  return `${stem === '' ? 'cover' : stem}.${extension}`
}

/** Read a response body, refusing one larger than `limit` bytes. */
async function readCapped(response: Response, limit: number, imageUrl: string): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(response.headers.get('content-length') ?? '')
  const tooLarge = (): PublisherError => invalidInput(`The image at ${imageUrl} is larger than ${String(limit / 1024 / 1024)} MB.`, 0)
  if (Number.isFinite(declared) && declared > limit) throw tooLarge()
  if (response.body === null) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let total = 0
  const reader = response.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) {
      await reader.cancel()
      throw tooLarge()
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

/**
 * The WordPress REST API connector. Posts are written as the application
 * password's user; the site author settings do not change the post author.
 * @param fetcher - the HTTP client.
 * @param options - the site origin and the credential readers.
 * @param timeoutMs - abandon one HTTP call after this long.
 * @returns the connector; its calls throw {@link PublisherError}.
 */
export function wordpressPublisher(fetcher: typeof fetch, options: WordPressPublisherOptions, timeoutMs: number): Publisher {
  const origin = options.baseUrl.replace(/\/+$/u, '')
  const api = `${origin}/wp-json`
  const tagIds = new Map<string, number>()
  const tagNames = new Map<number, string>()
  /** Uploaded images by source URL and by their URL on the site. */
  const media = new Map<string, { id: number; url: string }>()
  let seoPlugin: Promise<WordPressSeoPlugin> | undefined

  const credentials = (): { header: string; secrets: string[] } => {
    const user = options.user().trim()
    const password = options.appPassword().trim()
    if (user === '') throw new PublisherError('No WordPress user is set for this site.', 0, 'config', false)
    if (password === '') throw new PublisherError('No WordPress application password is set for this site.', 0, 'config', false)
    const header = `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`
    return { header, secrets: [user, password, password.replace(/\s+/gu, '')] }
  }

  const fail = (status: number, parsed: unknown, raw: string, what: string, secrets: readonly string[]): PublisherError => {
    const body = record(parsed)
    const code = text(body['code'])
    const serverMessage = decodeEntities(text(body['message']))
    const params = record(record(body['data'])['params'])
    const details = Object.entries(params).map(([field, why]) => `${field}: ${decodeEntities(text(why))}`)
    if (status === 401 || status === 403) {
      return new PublisherError(
        `WordPress refused ${what} (HTTP ${String(status)}${code === '' ? '' : ` ${code}`}); `
        + 'create an application password for a user who can publish posts.',
        status, 'auth', false,
      )
    }
    const failure = statusFailure(status)
    const why = [serverMessage, ...details].filter(s => s !== '').join('; ') || raw.slice(0, 200).trim() || 'no detail'
    const message = redact(`WordPress ${what} failed (HTTP ${String(status)}${code === '' ? '' : ` ${code}`}): ${why}`, secrets)
    return new PublisherError(message, status, failure.code, failure.retryable)
  }

  /** Send one request; resolves with any HTTP status, throws only when no response arrived. */
  const request = async (
    method: string, path: string, signal: AbortSignal, body?: Record<string, unknown>, upload?: Upload,
  ): Promise<{ status: number; parsed: unknown; raw: string; headers: Headers; what: string; secrets: string[] }> => {
    const auth = credentials()
    const what = `${method} ${path.replace(/\?.*$/u, '')}`
    const { signal: combined, timeout } = callSignal(signal, timeoutMs)
    let status = 0
    let raw = ''
    let headers = new Headers()
    try {
      const response = await fetcher(`${api}${path}`, {
        method,
        headers: {
          'Authorization': auth.header,
          'Accept': 'application/json',
          ...upload !== undefined
            ? { 'Content-Type': upload.type, 'Content-Disposition': `attachment; filename="${upload.fileName}"` }
            : body === undefined ? {} : { 'Content-Type': 'application/json' },
        },
        ...upload !== undefined ? { body: new Blob([upload.bytes]) } : body === undefined ? {} : { body: JSON.stringify(body) },
        signal: combined,
      })
      status = response.status
      headers = response.headers
      raw = await response.text()
    } catch (error) {
      transportFailure(error, signal, timeout, `WordPress ${what}`, auth.secrets)
    }
    return { status, parsed: parseJson(raw), raw, headers, what, secrets: auth.secrets }
  }

  /** Send one request and require a 2xx JSON answer. */
  const call = async (
    method: string, path: string, signal: AbortSignal, body?: Record<string, unknown>, upload?: Upload,
  ): Promise<{ body: unknown; headers: Headers }> => {
    const { status, parsed, raw, headers, what, secrets } = await request(method, path, signal, body, upload)
    if (status < 200 || status >= 300) throw fail(status, parsed, raw, what, secrets)
    if (parsed === undefined) throw badResponse(`WordPress ${what} answered ${String(status)} with a non-JSON body.`, status)
    return { body: parsed, headers }
  }

  const probeSeo = (signal: AbortSignal): Promise<WordPressSeoPlugin> => {
    seoPlugin ??= probeWordPress(fetcher, origin, AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]))
      .then(p => p.seoPlugin)
      .catch((error: unknown) => {
        seoPlugin = undefined
        throw error
      })
    return seoPlugin
  }

  const resolveTag = async (name: string, signal: AbortSignal): Promise<number> => {
    const key = name.trim().toLowerCase()
    const known = tagIds.get(key)
    if (known !== undefined) return known
    const query = `/wp/v2/tags?search=${encodeURIComponent(name.trim())}&per_page=${String(PAGE_SIZE)}&_fields=id,name`
    const found = (await call('GET', query, signal)).body
    for (const row of Array.isArray(found) ? found.map(record) : []) {
      const id = Number(row['id'])
      const rowName = decodeEntities(text(row['name']))
      if (!Number.isInteger(id)) continue
      tagNames.set(id, rowName)
      if (rowName.trim().toLowerCase() === key) tagIds.set(key, id)
    }
    const matched = tagIds.get(key)
    if (matched !== undefined) return matched
    const created = await request('POST', '/wp/v2/tags', signal, { name: name.trim() })
    const answer = record(created.parsed)
    // A tag the search missed (for example one differing only in accents) is refused as `term_exists` with its id.
    const existing = text(answer['code']) === 'term_exists' ? Number(record(answer['data'])['term_id']) : Number.NaN
    if (!(created.status >= 200 && created.status < 300) && !Number.isInteger(existing)) {
      throw fail(created.status, created.parsed, created.raw, created.what, created.secrets)
    }
    const id = Number.isInteger(existing) ? existing : Number(answer['id'])
    if (!Number.isInteger(id)) throw badResponse(`WordPress created the tag "${name}" but returned no id.`, created.status)
    tagIds.set(key, id)
    tagNames.set(id, name.trim())
    return id
  }

  const namesOf = async (ids: readonly number[], signal: AbortSignal): Promise<void> => {
    const missing = [...new Set(ids)].filter(id => !tagNames.has(id))
    for (let i = 0; i < missing.length; i += PAGE_SIZE) {
      const chunk = missing.slice(i, i + PAGE_SIZE).join(',')
      const rows = (await call('GET', `/wp/v2/tags?include=${chunk}&per_page=${String(PAGE_SIZE)}&_fields=id,name`, signal)).body
      for (const row of Array.isArray(rows) ? rows.map(record) : []) tagNames.set(Number(row['id']), decodeEntities(text(row['name'])))
    }
  }

  const tagIdsOf = (row: Record<string, unknown>): number[] =>
    Array.isArray(row['tags']) ? row['tags'].map(Number).filter(n => Number.isInteger(n)) : []

  const article = (value: unknown): RemoteArticle => {
    const row = record(value)
    const title = record(row['title'])
    const published = text(row['status']) === 'publish'
    // `*_gmt` fields are UTC without a zone suffix; the plain fields are site-local time.
    const time = (field: string): string => text(row[`${field}_gmt`]) === '' ? text(row[field]) : `${text(row[`${field}_gmt`])}Z`
    const date = time('date')
    const modified = time('modified')
    return {
      id: text(row['id']),
      slug: text(row['slug']),
      title: decodeEntities(text(title['raw']) || text(title['rendered']) || text(row['title'])),
      url: text(row['link']),
      status: published ? 'published' : 'draft',
      tags: tagIdsOf(row).map(id => tagNames.get(id) ?? String(id)),
      ...published && date !== '' ? { publishedAt: date } : {},
      ...modified === '' ? {} : { updatedAt: modified },
    }
  }

  const uploadItem = async (imageUrl: string, alt: string, signal: AbortSignal): Promise<{ id: number; url: string }> => {
    const known = media.get(imageUrl)
    if (known !== undefined) return known
    if (!/^https?:\/\//iu.test(imageUrl)) throw invalidInput(`The image URL ${imageUrl} is not http or https.`, 0)
    const { signal: combined, timeout } = callSignal(signal, timeoutMs)
    let bytes: Uint8Array<ArrayBuffer>
    let type = ''
    try {
      const response = await fetcher(imageUrl, { headers: { Accept: 'image/*' }, signal: combined })
      if (!response.ok) {
        const failure = statusFailure(response.status)
        const code = failure.code === 'auth' ? 'refused' : failure.code
        const message = `Downloading the image at ${imageUrl} failed (HTTP ${String(response.status)}).`
        throw new PublisherError(message, response.status, code, failure.retryable)
      }
      type = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
      if (!type.startsWith('image/')) throw invalidInput(`The file at ${imageUrl} is ${type || 'untyped'}, not an image.`, response.status)
      bytes = await readCapped(response, MAX_MEDIA_BYTES, imageUrl)
    } catch (error) {
      transportFailure(error, signal, timeout, `Downloading the image at ${imageUrl}`, [])
    }
    const upload: Upload = { bytes, type, fileName: mediaFileName(imageUrl, type) }
    const created = record((await call('POST', '/wp/v2/media', signal, undefined, upload)).body)
    const id = Number(created['id'])
    const url = text(created['source_url'])
    if (!Number.isInteger(id) || url === '') throw badResponse('WordPress stored the image but returned no id or URL.', 201)
    if (alt.trim() !== '') await call('POST', `/wp/v2/media/${String(id)}`, signal, { alt_text: alt })
    media.set(imageUrl, { id, url })
    media.set(url, { id, url })
    return { id, url }
  }

  const postBody = async (draft: ArticleDraft, status: ArticleStatus, signal: AbortSignal): Promise<Record<string, unknown>> => {
    const tags: number[] = []
    for (const name of draft.tags) if (name.trim() !== '') tags.push(await resolveTag(name, signal))
    let featured: number | undefined
    if (draft.coverImageUrl !== undefined && draft.coverImageUrl !== '') {
      featured = media.get(draft.coverImageUrl)?.id
      const onSite = draft.coverImageUrl.startsWith(`${origin}/`)
      if (featured === undefined && !onSite) featured = (await uploadItem(draft.coverImageUrl, draft.coverAlt ?? '', signal)).id
    }
    const plugin = await probeSeo(signal)
    const meta = plugin === 'yoast'
      ? { _yoast_wpseo_title: draft.metaTitle, _yoast_wpseo_metadesc: draft.metaDescription }
      : plugin === 'rankmath' ? { rank_math_title: draft.metaTitle, rank_math_description: draft.metaDescription } : undefined
    return {
      title: draft.title,
      slug: draft.slug,
      content: wordpressContent(draft, origin),
      excerpt: draft.dek,
      status: status === 'published' ? 'publish' : 'draft',
      tags,
      ...featured === undefined ? {} : { featured_media: featured },
      ...meta === undefined ? {} : { meta },
    }
  }

  const written = async (body: unknown, signal: AbortSignal): Promise<RemoteArticle> => {
    await namesOf(tagIdsOf(record(body)), signal)
    const out = article(body)
    if (out.id === '') throw badResponse('WordPress answered without a post id.', 200)
    return out
  }

  return {
    async list(signal) {
      const rows: unknown[] = []
      const fields = 'id,slug,title,link,status,tags,date,date_gmt,modified,modified_gmt'
      let pages = 1
      for (let page = 1; page <= pages && page <= MAX_LIST_PAGES; page++) {
        const query = `/wp/v2/posts?per_page=${String(PAGE_SIZE)}&status=publish,draft&context=edit&_fields=${fields}&page=${String(page)}`
        const result = await call('GET', query, signal)
        const body: unknown = result.body
        if (Array.isArray(body)) for (const item of body) rows.push(item)
        const total = Number(result.headers.get('x-wp-totalpages') ?? '1')
        pages = Number.isInteger(total) && total > 0 ? total : 1
      }
      await namesOf(rows.flatMap(r => tagIdsOf(record(r))), signal)
      return rows.map(article).filter(a => a.id !== '')
    },
    async create(draft, status, _author, signal) {
      return written((await call('POST', '/wp/v2/posts', signal, await postBody(draft, status, signal))).body, signal)
    },
    async update(id, draft, status, _author, signal) {
      const body = await postBody(draft, status, signal)
      return written((await call('POST', `/wp/v2/posts/${encodeURIComponent(id)}`, signal, body)).body, signal)
    },
    async unpublish(id, signal) {
      return written((await call('POST', `/wp/v2/posts/${encodeURIComponent(id)}`, signal, { status: 'draft' })).body, signal)
    },
    async uploadMedia(imageUrl, alt, signal) {
      return (await uploadItem(imageUrl, alt, signal)).url
    },
  }
}
