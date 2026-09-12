/**
 * The Meta Graph API calls this package makes, and the error that carries what
 * Meta said back to the caller.
 *
 * Every call goes through {@link graphRequest}, so one place owns the timeout,
 * the JSON parse, and the rule that a non-2xx answer surfaces Meta's own
 * response body rather than a status code the caller then has to guess about.
 *
 * @module @deepseek-ai/dsh-social-meta/graph
 */

import type { MetaPage } from './types.ts'

/** Permissions a Facebook Page target needs; the last one is what App Review gates. */
export const FACEBOOK_SCOPES = ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts'] as const

/** Permissions an Instagram target needs on top of the Facebook ones. */
export const INSTAGRAM_SCOPES = ['instagram_basic', 'instagram_content_publish'] as const

/** The permission Facebook publishing needs, and App Review grants. */
export const FACEBOOK_PUBLISH_PERMISSION = 'pages_manage_posts'

/** The permission Instagram publishing needs, and App Review grants. */
export const INSTAGRAM_PUBLISH_PERMISSION = 'instagram_content_publish'

/** Where the Graph API lives, which version is spoken, and how long one call may take. */
export interface GraphEndpoint {
  /** Origin of the Graph API, normally `https://graph.facebook.com`. */
  base: string
  /** Origin of the video host, normally `https://graph-video.facebook.com`. */
  videoBase: string
  /** Pinned Graph API version, such as `v25.0`. */
  version: string
  /** Milliseconds one call may take before it is abandoned. */
  timeoutMs: number
}

/**
 * A Graph call that did not succeed, carrying Meta's response body verbatim.
 *
 * The body is the useful part and it is not ours to summarize: Meta's `error`
 * object names the permission that is missing, the media that could not be
 * fetched, or the rate limit that was hit, and a caller that only sees "400"
 * has to reproduce the call to learn any of it.
 */
export class MetaGraphError extends Error {
  /** HTTP status Meta answered with. */
  readonly status: number
  /** The Graph path that was called, without the access token. */
  readonly path: string
  /** Meta's response body, as received. */
  readonly body: string

  /**
   * @param status - HTTP status Meta answered with.
   * @param path - the Graph path that was called.
   * @param body - Meta's response body, passed through unchanged.
   */
  constructor(status: number, path: string, body: string) {
    super(`Meta Graph API ${String(status)} on ${path}: ${body}`)
    this.name = 'MetaGraphError'
    this.status = status
    this.path = path
    this.body = body
  }
}

/** One Graph call's method, parameters, and body. */
export interface GraphRequestInit {
  /** HTTP method; `GET` when omitted. */
  method?: 'GET' | 'POST'
  /** Query parameters, including `access_token` where the call takes one there. */
  params?: Record<string, string>
  /** Request body for a POST that does not carry form parameters. */
  body?: BodyInit
  /** Extra request headers, such as the resumable upload's `file_offset`. */
  headers?: Record<string, string>
  /** Which host to call; the video host is only used to publish an uploaded video. */
  host?: 'graph' | 'video'
}

/**
 * Call one Graph endpoint.
 * @param endpoint - where the Graph API lives and how long a call may take.
 * @param path - the versioned path's tail, such as `me/accounts` or `123/feed`.
 * @param init - method, parameters, body, and headers.
 * @returns the parsed JSON object Meta answered with.
 * @throws {MetaGraphError} when Meta answers with a non-2xx status, carrying its body verbatim.
 * @throws {Error} when the call times out or the answer is not JSON.
 */
export async function graphRequest(
  endpoint: GraphEndpoint,
  path: string,
  init: GraphRequestInit = {},
): Promise<Record<string, unknown>> {
  const origin = init.host === 'video' ? endpoint.videoBase : endpoint.base
  const url = new URL(`${origin.replace(/\/+$/u, '')}/${endpoint.version}/${path}`)
  for (const [key, value] of Object.entries(init.params ?? {})) url.searchParams.set(key, value)
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, endpoint.timeoutMs)
  let text: string
  let status: number
  try {
    const response = await fetch(url, {
      method: init.method ?? 'GET',
      ...init.headers === undefined ? {} : { headers: init.headers },
      ...init.body === undefined ? {} : { body: init.body },
      signal: controller.signal,
    })
    status = response.status
    text = await response.text()
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Meta Graph API did not answer ${path} within ${String(endpoint.timeoutMs)}ms`)
    }
    throw error instanceof Error ? error : new Error(String(error))
  } finally {
    clearTimeout(timer)
  }
  if (status < 200 || status >= 300) throw new MetaGraphError(status, path, text)
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    throw new Error(`Meta Graph API answered ${path} with a body that is not JSON: ${text}`)
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`Meta Graph API answered ${path} with ${text}, not an object`)
  }
  return parsed as Record<string, unknown>
}

/**
 * POST one Graph endpoint with form parameters, the way every publishing edge takes them.
 * @param endpoint - where the Graph API lives.
 * @param path - the versioned path's tail.
 * @param form - the form fields, including `access_token`.
 * @param host - which host to call; the graph host when omitted.
 * @returns the parsed JSON object Meta answered with.
 */
export function graphPostForm(
  endpoint: GraphEndpoint,
  path: string,
  form: Record<string, string>,
  host: 'graph' | 'video' = 'graph',
): Promise<Record<string, unknown>> {
  return graphRequest(endpoint, path, {
    method: 'POST',
    body: new URLSearchParams(form),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    host,
  })
}

/** Read a string field from a Graph response, or `undefined` when it is absent or not a string. */
function readString(source: Record<string, unknown>, field: string): string | undefined {
  const value = source[field]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * The permissions currently granted on one user token.
 *
 * This is the only honest source for what the token may do: the scopes asked
 * for at the dialog are a request, and a human can decline any of them one by
 * one on the permissions screen.
 * @param endpoint - where the Graph API lives.
 * @param userToken - the long-lived user access token.
 * @returns the granted permission names.
 */
export async function fetchGrantedScopes(endpoint: GraphEndpoint, userToken: string): Promise<string[]> {
  const answer = await graphRequest(endpoint, 'me/permissions', { params: { access_token: userToken } })
  const rows = Array.isArray(answer['data']) ? answer['data'] : []
  const granted: string[] = []
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue
    const record = row as Record<string, unknown>
    const permission = readString(record, 'permission')
    if (permission !== undefined && record['status'] === 'granted') granted.push(permission)
  }
  return granted
}

/**
 * The Pages this user manages, each with its own Page access token and any
 * linked Instagram professional account.
 *
 * Pages are read on every operation rather than stored at authorization time,
 * so a Page added, removed, or renamed since then is seen without asking the
 * human to sign in again.
 * @param endpoint - where the Graph API lives.
 * @param userToken - the long-lived user access token.
 * @returns one entry per Page, in the order Meta returned them.
 */
export async function fetchPages(endpoint: GraphEndpoint, userToken: string): Promise<MetaPage[]> {
  const answer = await graphRequest(endpoint, 'me/accounts', {
    params: {
      fields: 'id,name,access_token,instagram_business_account{id,username}',
      access_token: userToken,
    },
  })
  const rows = Array.isArray(answer['data']) ? answer['data'] : []
  const pages: MetaPage[] = []
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue
    const record = row as Record<string, unknown>
    const id = readString(record, 'id')
    const accessToken = readString(record, 'access_token')
    // A Page the token cannot act as is a Page this provider cannot publish to;
    // listing it as a target would promise something no call could keep.
    if (id === undefined || accessToken === undefined) continue
    const linked = record['instagram_business_account']
    const instagram = typeof linked === 'object' && linked !== null
      ? (linked as Record<string, unknown>)
      : undefined
    const instagramId = instagram === undefined ? undefined : readString(instagram, 'id')
    const username = instagram === undefined ? undefined : readString(instagram, 'username')
    pages.push({
      id,
      name: readString(record, 'name') ?? id,
      accessToken,
      ...instagramId === undefined
        ? {}
        : { instagram: { id: instagramId, ...username === undefined ? {} : { username } } },
    })
  }
  return pages
}
