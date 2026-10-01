/**
 * The Klipara connector: articles go to Klipara's content API at
 * `<baseUrl>/api/v1/content` with a Bearer API key that has the `content:write`
 * scope. Klipara renders the Markdown itself, so `::clip[<id>]` lines pass
 * through unchanged.
 */

import { createHash } from 'node:crypto'
import type { ArticleDraft, ArticleStatus, Publisher, RemoteArticle, Site } from '../types.ts'
import { badResponse, callSignal, parseJson, PublisherError, record, redact, statusFailure, text, transportFailure } from './errors.ts'

/** Where the Klipara connector writes and with which key. */
export interface KliparaPublisherOptions {
  /** Klipara's public origin, for example `https://klipara.linkfa.de`. */
  baseUrl: string
  /** Reads the API key at call time, so a key saved in settings applies at once. */
  apiKey: () => string
}

/** The Klipara connector: the {@link Publisher} calls plus a read of one article. */
export interface KliparaPublisher extends Publisher {
  /** Read one article by id. */
  get(id: string, signal: AbortSignal): Promise<RemoteArticle>
}

/** Stop following list pages after this many, so a server that repeats a cursor cannot loop forever. */
const MAX_LIST_PAGES = 200

/** The request body for a create or update. */
function articleBody(draft: ArticleDraft, status: ArticleStatus, author: Site['author']): Record<string, unknown> {
  return {
    slug: draft.slug,
    title: draft.title,
    metaTitle: draft.metaTitle,
    metaDescription: draft.metaDescription,
    dek: draft.dek,
    bodyMarkdown: draft.bodyMarkdown,
    tags: draft.tags,
    faq: draft.faq,
    sources: draft.sources,
    ...draft.coverImageUrl === undefined ? {} : { coverImageUrl: draft.coverImageUrl },
    ...draft.coverAlt === undefined ? {} : { coverAlt: draft.coverAlt },
    author: { name: author.name, url: author.url, bio: author.bio },
    status,
  }
}

/**
 * The Idempotency-Key for creating an article: the SHA-256 of its slug and the
 * request body, so a retry of the same create carries the same key and a
 * changed draft carries a new one.
 * @param slug - the article slug.
 * @param body - the JSON request body.
 * @returns the hex digest.
 */
export function kliparaIdempotencyKey(slug: string, body: string): string {
  return createHash('sha256').update(slug).update('\n').update(body).digest('hex')
}

/** Read Klipara's refusal reasons from an error body: `reasons`, `errors`, or `error.details`. */
function reasons(body: unknown): string[] {
  const top = record(body)
  const error = record(top['error'])
  const lists = [top['reasons'], top['errors'], top['details'], error['reasons'], error['details'], error['errors']]
  const out: string[] = []
  for (const value of lists) {
    if (!Array.isArray(value)) continue
    for (const item of value) {
      if (typeof item === 'string') {
        out.push(item)
        continue
      }
      const row = record(item)
      const message = text(row['message']) || text(row['reason'])
      const field = text(row['field']) || (Array.isArray(row['path']) ? row['path'].map(text).join('.') : text(row['path']))
      if (message !== '') out.push(field === '' ? message : `${field}: ${message}`)
    }
  }
  return out
}

/** Map a list row or response body to an article; undefined when it has no id. */
function article(value: unknown): RemoteArticle | undefined {
  const row = record(value)
  const id = text(row['id'])
  if (id === '') return undefined
  const publishedAt = text(row['publishedAt']) || text(row['published_at'])
  const updatedAt = text(row['updatedAt']) || text(row['updated_at'])
  return {
    id,
    slug: text(row['slug']),
    title: text(row['title']),
    url: text(row['url']),
    status: text(row['status']) === 'published' ? 'published' : 'draft',
    tags: Array.isArray(row['tags']) ? row['tags'].map(text).filter(t => t !== '') : [],
    ...publishedAt === '' ? {} : { publishedAt },
    ...updatedAt === '' ? {} : { updatedAt },
  }
}

/** Unwrap `{data: …}` or `{article: …}` around a single object. */
function unwrap(body: unknown): unknown {
  const top = record(body)
  if (typeof top['data'] === 'object' && top['data'] !== null && !Array.isArray(top['data'])) return top['data']
  if (typeof top['article'] === 'object' && top['article'] !== null) return top['article']
  return body
}

/**
 * The Klipara content API connector.
 * @param fetcher - the HTTP client.
 * @param options - Klipara's origin and the API key reader.
 * @param timeoutMs - abandon one HTTP call after this long.
 * @returns the connector; its calls throw {@link PublisherError}.
 */
export function kliparaPublisher(fetcher: typeof fetch, options: KliparaPublisherOptions, timeoutMs: number): KliparaPublisher {
  const root = `${options.baseUrl.replace(/\/+$/u, '')}/api/v1/content`
  const call = async (
    method: string, path: string, signal: AbortSignal, body?: Record<string, unknown>, idempotent?: string,
  ): Promise<unknown> => {
    const key = options.apiKey().trim()
    if (key === '') {
      const message = 'No Klipara API key is set; create one with the content:write scope and save it for this site.'
      throw new PublisherError(message, 0, 'config', false)
    }
    const what = `Klipara ${method} ${path.replace(/\?.*$/u, '')}`
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const { signal: combined, timeout } = callSignal(signal, timeoutMs)
    let status = 0
    let raw = ''
    try {
      const response = await fetcher(path.startsWith('http') ? path : `${root}${path}`, {
        method,
        headers: {
          'Authorization': `Bearer ${key}`,
          'Accept': 'application/json',
          ...payload === undefined ? {} : { 'Content-Type': 'application/json' },
          ...idempotent === undefined || payload === undefined ? {} : { 'Idempotency-Key': kliparaIdempotencyKey(idempotent, payload) },
        },
        ...payload === undefined ? {} : { body: payload },
        signal: combined,
      })
      status = response.status
      raw = await response.text()
    } catch (error) {
      transportFailure(error, signal, timeout, what, [key])
    }
    const parsed = parseJson(raw)
    if (status >= 200 && status < 300) {
      if (parsed === undefined) throw badResponse(`${what} answered ${String(status)} with a non-JSON body.`, status)
      return parsed
    }
    const error = record(record(parsed)['error'])
    const serverMessage = text(error['message']) || text(record(parsed)['message']) || text(record(parsed)['error'])
    if (status === 401 || status === 403) {
      throw new PublisherError(
        `Klipara rejected the API key for ${what} (HTTP ${String(status)}); the key needs the content:write scope.`, status, 'auth', false,
      )
    }
    if (status === 422) {
      const listed = reasons(parsed)
      const why = listed.length > 0 ? listed.join('; ') : serverMessage || 'no reason given'
      throw new PublisherError(redact(`Klipara refused the article (${what}, HTTP 422): ${why}`, [key]), status, 'validation', false)
    }
    const failure = statusFailure(status)
    const detail = serverMessage || raw.slice(0, 200).trim() || 'no detail'
    throw new PublisherError(redact(`${what} failed (HTTP ${String(status)}): ${detail}`, [key]), status, failure.code, failure.retryable)
  }
  const one = (body: unknown, what: string, status: number): RemoteArticle => {
    const found = article(unwrap(body))
    if (found === undefined) throw badResponse(`${what} answered without an article id.`, status)
    return found
  }
  return {
    async list(signal) {
      const out: RemoteArticle[] = []
      const seen = new Set<string>()
      let path = '/articles'
      for (let page = 0; page < MAX_LIST_PAGES; page++) {
        const body = await call('GET', path, signal)
        const top = record(body)
        const rows = [body, top['data'], top['articles']].find((v): v is unknown[] => Array.isArray(v)) ?? []
        for (const row of rows) {
          const found = article(row)
          if (found !== undefined) out.push(found)
        }
        const meta = record(top['meta'] ?? top['pagination'])
        const next = text(top['next']) || text(meta['next'])
        const cursor = text(top['cursor']) || text(top['nextCursor']) || text(meta['cursor']) || text(meta['nextCursor'])
        let following = ''
        const nextIsLink = /^https?:\/\//iu.test(next) || next.startsWith('/')
        if (next !== '') following = nextIsLink ? next : `/articles?cursor=${encodeURIComponent(next)}`
        else if (cursor !== '') following = `/articles?cursor=${encodeURIComponent(cursor)}`
        if (following === '' || rows.length === 0 || seen.has(following)) break
        seen.add(following)
        path = following.startsWith('/api/v1/content') ? following.slice('/api/v1/content'.length) : following
        if (/^https?:\/\//iu.test(path) && !path.startsWith(root)) {
          throw badResponse(`Klipara's article list pointed to another site (${new URL(path).origin}); refusing to send the key there.`, 0)
        }
      }
      return out
    },
    async get(id, signal) {
      return one(await call('GET', `/articles/${encodeURIComponent(id)}`, signal), 'Klipara GET /articles/{id}', 200)
    },
    async create(draft, status, author, signal) {
      return one(await call('POST', '/articles', signal, articleBody(draft, status, author), draft.slug), 'Klipara POST /articles', 201)
    },
    async update(id, draft, status, author, signal) {
      const body = await call('PUT', `/articles/${encodeURIComponent(id)}`, signal, articleBody(draft, status, author))
      return one(body, 'Klipara PUT /articles/{id}', 200)
    },
    async unpublish(id, signal) {
      const body = await call('POST', `/articles/${encodeURIComponent(id)}/unpublish`, signal, {})
      return one(body, 'Klipara POST /articles/{id}/unpublish', 200)
    },
    async uploadMedia(imageUrl, alt, signal) {
      const body = unwrap(await call('POST', '/media', signal, { url: imageUrl, alt }))
      const url = text(record(body)['url'])
      if (url === '') throw badResponse('Klipara POST /media answered without a url.', 200)
      return url
    },
  }
}
