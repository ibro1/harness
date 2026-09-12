/**
 * The LinkedIn versioned REST calls this provider makes: the image upload, the
 * multi-part video upload, post creation, and the organization roster.
 *
 * Every `/rest/*` call carries `LinkedIn-Version` and
 * `X-Restli-Protocol-Version: 2.0.0`; a call without them is refused with 426.
 * The byte PUTs are the exception — they go to pre-signed upload URLs that take
 * the bytes and nothing else, and adding the versioned headers to them gets the
 * bytes rejected.
 *
 * Field names come from LinkedIn's current documentation, read 2026-09:
 * [Videos API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api),
 * [Images API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/images-api),
 * and the [Posts API schema](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/post-api-schema).
 *
 * @module @deepseek-ai/dsh-social-linkedin/api
 */

import { open, stat } from 'node:fs/promises'
import type { LinkedInOrganization } from './types.ts'

/**
 * A LinkedIn response that was not a success, carrying what LinkedIn said.
 *
 * The body is kept rather than summarized because LinkedIn's own `message` and
 * `serviceErrorCode` are the only thing that distinguishes a lapsed version
 * header from a missing scope from a file it would not accept, and a caller
 * reading "LinkedIn said no" learns nothing.
 */
export class LinkedInApiError extends Error {
  /** HTTP status LinkedIn answered with. */
  readonly status: number
  /** The response body, truncated to keep one bad response from filling a log. */
  readonly body: string

  /**
   * @param step - what was being attempted, in the caller's words.
   * @param status - the HTTP status.
   * @param body - the response body as text.
   */
  constructor(step: string, status: number, body: string) {
    const trimmed = body.slice(0, 600)
    super(`LinkedIn refused ${step} (${String(status)})${trimmed === '' ? '' : `: ${trimmed}`}`)
    this.name = 'LinkedInApiError'
    this.status = status
    this.body = trimmed
  }
}

/** What the client needs to reach LinkedIn. */
export interface ApiSettings {
  /** Origin of `api.linkedin.com`, overridable so a test or a proxy can stand in. */
  apiBaseUrl: string
  /** The `LinkedIn-Version` value, in `YYYYMM` form. */
  version: string
  /** How long one HTTP call may take before it is abandoned. */
  timeoutMs: number
}

/** One attachment, already resolved to a URN and its post-side description. */
export interface MediaAttachment {
  /** The `urn:li:image:` or `urn:li:video:` the post references. */
  id: string
  /** Accessibility text, sent when the caller supplied it. */
  altText?: string
  /** Human title; LinkedIn's video sample carries one where an image carries alt text. */
  title?: string
}

/** Read a response body without letting a broken stream mask the status. */
async function bodyText(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return ''
  }
}

/**
 * `AbortSignal.timeout` composed with the caller's own signal.
 *
 * Written out rather than using `AbortSignal.any` so the timeout's reason names
 * the elapsed budget; a caller looking at "the operation was aborted" cannot
 * tell a slow LinkedIn from its own cancellation.
 */
function deadline(timeoutMs: number, signal: AbortSignal | undefined): { signal: AbortSignal; release: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort(new Error(`LinkedIn did not answer within ${String(timeoutMs)}ms`))
  }, timeoutMs)
  const withdraw = (): void => { controller.abort(signal?.reason) }
  if (signal?.aborted === true) withdraw()
  else signal?.addEventListener('abort', withdraw, { once: true })
  return {
    signal: controller.signal,
    release: () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', withdraw)
    },
  }
}

/** One `/rest/*` or `/v2/*` call under the API's headers and the call timeout. */
async function call(
  settings: ApiSettings,
  token: string,
  step: string,
  path: string,
  init: { method?: string; body?: unknown } | undefined,
  signal: AbortSignal | undefined,
): Promise<{ json: unknown; headers: Headers }> {
  const { signal: abort, release } = deadline(settings.timeoutMs, signal)
  try {
    const response = await fetch(`${settings.apiBaseUrl}${path}`, {
      method: init?.method ?? 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'LinkedIn-Version': settings.version,
        'X-Restli-Protocol-Version': '2.0.0',
        'Accept': 'application/json',
        ...(init?.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: abort,
    })
    const text = await bodyText(response)
    if (!response.ok) throw new LinkedInApiError(step, response.status, text)
    let json: unknown
    try {
      json = text === '' ? {} : JSON.parse(text)
    } catch {
      json = {}
    }
    return { json, headers: response.headers }
  } finally {
    release()
  }
}

/** Read a nested `value` object without trusting anything about its contents. */
function valueOf(json: unknown): Record<string, unknown> {
  const value = (json as { value?: unknown } | null)?.value
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

/** Best-effort string field. */
function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * Upload one image and return the URN a post attaches.
 *
 * Two steps in a fixed order: `POST /rest/images?action=initializeUpload` with
 * `{initializeUploadRequest:{owner}}` answers `{value:{uploadUrl, image}}`, and
 * the raw bytes are PUT to that `uploadUrl`. The PUT carries no headers of its
 * own — the URL is pre-signed, and the versioned-API headers get the bytes
 * rejected.
 *
 * @param settings - the API origin, version, and timeout.
 * @param token - the bearer token.
 * @param owner - the author URN the image belongs to.
 * @param path - absolute path of the file to upload.
 * @param signal - withdraws the upload.
 * @returns the `urn:li:image:…` the post references.
 * @throws {LinkedInApiError} naming the step that failed and LinkedIn's response.
 */
export async function uploadImage(
  settings: ApiSettings,
  token: string,
  owner: string,
  path: string,
  signal?: AbortSignal,
): Promise<string> {
  const { json } = await call(settings, token, 'the image upload registration', '/rest/images?action=initializeUpload', {
    method: 'POST',
    body: { initializeUploadRequest: { owner } },
  }, signal)
  const value = valueOf(json)
  const uploadUrl = str(value['uploadUrl'])
  const urn = str(value['image'])
  if (uploadUrl === '' || urn === '') {
    throw new Error('the LinkedIn image upload registration returned no uploadUrl or image urn')
  }
  const handle = await open(path, 'r')
  let bytes: Buffer
  try {
    bytes = await handle.readFile()
  } finally {
    await handle.close()
  }
  const { signal: abort, release } = deadline(settings.timeoutMs, signal)
  try {
    // An untyped Blob sends no Content-Type, keeping the request to the
    // pre-signed URL's own terms.
    // `new Uint8Array(bytes)` rather than the Buffer itself: a Buffer's backing
    // store is typed ArrayBufferLike, which admits SharedArrayBuffer and so is
    // not a BlobPart. The view is over the same memory; nothing is copied.
    const put = await fetch(uploadUrl, { method: 'PUT', body: new Blob([new Uint8Array(bytes)]), signal: abort })
    if (!put.ok) throw new LinkedInApiError('the image bytes', put.status, await bodyText(put))
  } finally {
    release()
  }
  return urn
}

/** One part of a multi-part video upload, as LinkedIn hands it over. */
interface UploadInstruction {
  /** Pre-signed URL this part's bytes are PUT to. */
  uploadUrl: string
  /** First byte of the file this part covers. */
  firstByte: number
  /** Last byte of the file this part covers, inclusive. */
  lastByte: number
}

/** Read the upload instructions out of an initializeUpload response, in the order LinkedIn gave them. */
function readInstructions(value: Record<string, unknown>): UploadInstruction[] {
  const raw = value['uploadInstructions']
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry): UploadInstruction[] => {
    if (typeof entry !== 'object' || entry === null) return []
    const part = entry as Record<string, unknown>
    const uploadUrl = str(part['uploadUrl'])
    const firstByte = typeof part['firstByte'] === 'number' ? part['firstByte'] : 0
    const lastByte = typeof part['lastByte'] === 'number' ? part['lastByte'] : -1
    return uploadUrl === '' || lastByte < firstByte ? [] : [{ uploadUrl, firstByte, lastByte }]
  })
}

/**
 * Upload one video and return the URN a post attaches.
 *
 * Three steps in a fixed order, which is the whole of what makes this work:
 *
 *  1. `POST /rest/videos?action=initializeUpload` with
 *     `{initializeUploadRequest:{owner, fileSizeBytes}}`. The declared size is
 *     what decides how many parts LinkedIn splits the upload into, so it must
 *     be the file's real size. The answer is `{value:{video, uploadToken,
 *     uploadInstructions:[{uploadUrl, firstByte, lastByte}]}}`.
 *  2. Each part's byte range is PUT to that part's `uploadUrl`, in the order
 *     the instructions came in, as `application/octet-stream`. Every part's
 *     response carries an `etag` header which must be kept — finalize is
 *     rejected without them, and their order has to match the parts'.
 *  3. `POST /rest/videos?action=finalizeUpload` with
 *     `{finalizeUploadRequest:{video, uploadToken, uploadedPartIds}}`. The
 *     `uploadToken` is echoed back exactly as received; LinkedIn's own samples
 *     show it empty, and inventing a value there fails the call.
 *
 * The file is read one part at a time rather than whole: LinkedIn accepts
 * videos up to 5GB, and buffering one would cost more memory than the process
 * has.
 *
 * @param settings - the API origin, version, and timeout.
 * @param token - the bearer token.
 * @param owner - the author URN the video belongs to.
 * @param path - absolute path of the file to upload.
 * @param signal - withdraws the upload.
 * @returns the `urn:li:video:…` the post references.
 * @throws {LinkedInApiError} naming the step that failed and LinkedIn's response.
 */
export async function uploadVideo(
  settings: ApiSettings,
  token: string,
  owner: string,
  path: string,
  signal?: AbortSignal,
): Promise<string> {
  const fileSizeBytes = (await stat(path)).size
  const { json } = await call(settings, token, 'the video upload registration', '/rest/videos?action=initializeUpload', {
    method: 'POST',
    body: { initializeUploadRequest: { owner, fileSizeBytes } },
  }, signal)
  const value = valueOf(json)
  const urn = str(value['video'])
  const instructions = readInstructions(value)
  if (urn === '' || instructions.length === 0) {
    throw new Error('the LinkedIn video upload registration returned no video urn or upload instructions')
  }
  // Echoed back verbatim at finalize; the documented samples show it empty, so
  // absence is normal and an invented value is not.
  const uploadToken = str(value['uploadToken'])

  const uploadedPartIds: string[] = []
  const handle = await open(path, 'r')
  try {
    for (const [index, part] of instructions.entries()) {
      signal?.throwIfAborted()
      const length = part.lastByte - part.firstByte + 1
      const chunk = Buffer.allocUnsafe(length)
      const { bytesRead } = await handle.read(chunk, 0, length, part.firstByte)
      const { signal: abort, release } = deadline(settings.timeoutMs, signal)
      let etag: string
      try {
        const put = await fetch(part.uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: new Blob([chunk.subarray(0, bytesRead)]),
          signal: abort,
        })
        if (!put.ok) {
          throw new LinkedInApiError(`video part ${String(index + 1)} of ${String(instructions.length)}`, put.status, await bodyText(put))
        }
        etag = put.headers.get('etag') ?? ''
      } finally {
        release()
      }
      if (etag === '') {
        throw new Error(`LinkedIn returned no etag for video part ${String(index + 1)}; the upload cannot be finalized`)
      }
      // LinkedIn documents the quoted-hash form and strips the quotes itself
      // when matching; the signed-path form arrives unquoted.
      uploadedPartIds.push(etag.replace(/^"|"$/gu, ''))
    }
  } finally {
    await handle.close()
  }

  await call(settings, token, 'the video upload finalization', '/rest/videos?action=finalizeUpload', {
    method: 'POST',
    body: { finalizeUploadRequest: { video: urn, uploadToken, uploadedPartIds } },
  }, signal)
  return urn
}

/**
 * Publish one post.
 * @param settings - the API origin, version, and timeout.
 * @param token - the bearer token.
 * @param author - the author URN, `urn:li:person:` or `urn:li:organization:`.
 * @param text - the post body, sent as `commentary`.
 * @param media - the single attachment, when the post has one.
 * @param signal - withdraws the call.
 * @returns the post URN and the page a human can read it on.
 * @throws {LinkedInApiError} carrying LinkedIn's own refusal.
 */
export async function createPost(
  settings: ApiSettings,
  token: string,
  author: string,
  text: string,
  media: MediaAttachment | undefined,
  signal?: AbortSignal,
): Promise<{ id: string; url?: string }> {
  const { json, headers } = await call(settings, token, 'the post', '/rest/posts', {
    method: 'POST',
    body: {
      author,
      commentary: text,
      visibility: 'PUBLIC',
      distribution: {
        feedDistribution: 'MAIN_FEED',
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      ...(media === undefined ? {} : { content: { media } }),
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    },
  }, signal)
  // The created post's URN comes back on `x-restli-id`; some responses also
  // carry it in the body, so read both before giving up.
  const id = headers.get('x-restli-id') ?? str((json as { id?: unknown } | null)?.id)
  if (id === '') throw new Error('LinkedIn accepted the post but returned no post id')
  return { id, url: `https://www.linkedin.com/feed/update/${id}/` }
}

/**
 * List the organization pages the signed-in member administers.
 *
 * Only worth calling when the stored grant carries `w_organization_social`:
 * without it LinkedIn refuses the ACL listing, and a target built from a
 * refused listing would be a target that cannot be posted to.
 *
 * @param settings - the API origin, version, and timeout.
 * @param token - the bearer token.
 * @param signal - withdraws the call.
 * @returns one entry per administered page, named where the name could be read.
 * @throws {LinkedInApiError} carrying LinkedIn's own refusal.
 */
export async function listAdministeredOrganizations(
  settings: ApiSettings,
  token: string,
  signal?: AbortSignal,
): Promise<readonly LinkedInOrganization[]> {
  const { json } = await call(
    settings, token, 'the organization roster',
    '/rest/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED',
    undefined, signal,
  )
  const elements = (json as { elements?: unknown } | null)?.elements
  const ids = Array.isArray(elements)
    ? elements.flatMap((entry): string[] => {
      const target = str((entry as { organizationalTarget?: unknown } | null)?.organizationalTarget)
      const id = target.startsWith('urn:li:organization:') ? target.slice('urn:li:organization:'.length) : ''
      return id === '' ? [] : [id]
    })
    : []
  return Promise.all(ids.map(async (id): Promise<LinkedInOrganization> => {
    try {
      const { json: page } = await call(settings, token, 'an organization page', `/rest/organizations/${id}`, undefined, signal)
      const name = str((page as { localizedName?: unknown } | null)?.localizedName)
      return { id, name: name === '' ? `urn:li:organization:${id}` : name }
    } catch {
      // The roster is the fact that matters; a page whose name could not be
      // read is still a page the member can post to, so it keeps its URN as a
      // label rather than disappearing from the list.
      return { id, name: `urn:li:organization:${id}` }
    }
  }))
}
