/**
 * The YouTube Data API calls this provider makes: naming the channel, and the
 * resumable upload of one video file.
 *
 * `videos.insert` is a media upload, so the bytes do not travel with the
 * metadata. The resumable protocol is two steps: a POST to
 * `/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status` carrying
 * the metadata JSON and the byte count in `X-Upload-Content-Length`, whose
 * `Location` header is a session URI, and then PUTs of the bytes to that
 * session URI under `Content-Range`. A PUT that does not finish the file is
 * answered `308`, whose `Range` header states how much the server actually
 * holds — which is what makes an interrupted upload resumable: ask the session
 * URI where it got to, and continue from there rather than starting again.
 *
 * @module @deepseek-ai/dsh-social-youtube/upload
 */

import { open, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { googleFailure } from './errors.ts'
import type { UploadedVideo, YouTubeChannel } from './types.ts'

/** Chunks must be a multiple of this; Google rejects a part-sized chunk that is not the last one. */
export const CHUNK_GRANULARITY = 256 * 1024

/** Where the API lives and how patiently it is called. */
export interface ApiSettings {
  /** Origin serving `/youtube/v3`, overridable so a test or a proxy can stand in. */
  apiBaseUrl: string
  /** Origin serving `/upload/youtube/v3`, overridable on the same terms. */
  uploadBaseUrl: string
  /** How long one metadata call may take before it is abandoned. */
  timeoutMs: number
  /** How many bytes one PUT carries. */
  chunkBytes: number
  /** How long one chunk PUT may take before it is abandoned. */
  chunkTimeoutMs: number
  /** How many times one interrupted chunk is re-sent, after asking the session where it got to. */
  uploadRetries: number
  /** Whether the upload tells the channel's subscribers; `videos.insert` defaults this to true when it is not sent. */
  notifySubscribers: boolean
}

/** The video resource sent with the upload, in the API's own field names. */
export interface VideoMetadata {
  snippet: {
    /** At most 100 characters, and no `<` or `>`. */
    title: string
    /** At most 5000 bytes of UTF-8, and no `<` or `>`. */
    description: string
    /** A `videoCategories` id; `22` is People & Blogs. */
    categoryId: string
  }
  status: {
    /** `private`, `unlisted`, or `public` — what is asked for, not necessarily what is set. */
    privacyStatus: string
    /** Required of every upload since 2020: whether the uploader declares it made for kids. */
    selfDeclaredMadeForKids: boolean
  }
}

/** What a video file on disk turned out to be. */
export interface VideoFile {
  /** Absolute path. */
  path: string
  /** Byte count, sent up front as `X-Upload-Content-Length`. */
  size: number
  /** Sent as `X-Upload-Content-Type`. */
  contentType: string
}

/** Extensions YouTube's own help page lists, mapped to the types it expects. */
const CONTENT_TYPES = new Map<string, string>([
  ['.mp4', 'video/mp4'],
  ['.m4v', 'video/x-m4v'],
  ['.mov', 'video/quicktime'],
  ['.webm', 'video/webm'],
  ['.mkv', 'video/x-matroska'],
  ['.avi', 'video/x-msvideo'],
  ['.mpeg', 'video/mpeg'],
  ['.mpg', 'video/mpeg'],
  ['.wmv', 'video/x-ms-wmv'],
  ['.flv', 'video/x-flv'],
  ['.3gp', 'video/3gpp'],
])

/**
 * Measure and type one video file before any of it is sent.
 * @param path - absolute path of the file to upload.
 * @returns its size and content type.
 * @throws when the path is not a readable, non-empty file.
 */
export async function describeVideoFile(path: string): Promise<VideoFile> {
  let size: number
  try {
    const stats = await stat(path)
    if (!stats.isFile()) throw new Error(`${path} is not a file.`)
    size = stats.size
  } catch (error) {
    throw new Error(`The video to upload could not be read at ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (size === 0) throw new Error(`The video at ${path} is empty, so there is nothing to upload.`)
  return { path, size, contentType: CONTENT_TYPES.get(extname(path).toLowerCase()) ?? 'video/*' }
}

/**
 * List the channels the signed-in account owns.
 * @param settings - where the API lives and how long a call may take.
 * @param accessToken - a minted bearer token carrying the read-only scope.
 * @param signal - withdraws the call.
 * @returns one entry per owned channel, usually exactly one.
 * @throws when Google refuses the call; quota refusals are restated as such.
 */
export async function listChannels(
  settings: ApiSettings,
  accessToken: string,
  signal: AbortSignal,
): Promise<readonly YouTubeChannel[]> {
  const url = new URL('/youtube/v3/channels', settings.apiBaseUrl)
  url.search = new URLSearchParams({ part: 'snippet', mine: 'true' }).toString()
  const response = await call(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  }, settings.timeoutMs, signal, 'channels.list')
  const text = await response.text()
  if (!response.ok) throw googleFailure('channels.list', response.status, text)
  const body = JSON.parse(text) as { items?: { id?: unknown; snippet?: { title?: unknown } }[] }
  return (body.items ?? [])
    .map((item) => {
      const id = typeof item.id === 'string' ? item.id : ''
      const title = typeof item.snippet?.title === 'string' ? item.snippet.title : id
      return { id, title }
    })
    .filter(channel => channel.id !== '')
}

/**
 * Open a resumable upload session for one video.
 * @param settings - where the upload endpoint lives and how long a call may take.
 * @param accessToken - a minted bearer token carrying the upload scope.
 * @param metadata - the snippet and status sent as the session's JSON body.
 * @param file - the file whose size and type the session is opened for.
 * @param signal - withdraws the call.
 * @returns the session URI the bytes are PUT to.
 * @throws when Google refuses to open the session; quota refusals are restated as such.
 */
export async function initiateUpload(
  settings: ApiSettings,
  accessToken: string,
  metadata: VideoMetadata,
  file: VideoFile,
  signal: AbortSignal,
): Promise<string> {
  const url = new URL('/upload/youtube/v3/videos', settings.uploadBaseUrl)
  url.search = new URLSearchParams({
    uploadType: 'resumable',
    part: 'snippet,status',
    notifySubscribers: settings.notifySubscribers ? 'true' : 'false',
  }).toString()
  const response = await call(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Length': String(file.size),
      'X-Upload-Content-Type': file.contentType,
    },
    body: JSON.stringify(metadata),
  }, settings.timeoutMs, signal, 'the upload session')
  if (!response.ok) throw googleFailure('the upload session', response.status, await response.text())
  const location = response.headers.get('location')
  if (location === null || location === '') {
    throw new Error('Google opened the upload session without a Location header, so there is nowhere to send the video to.')
  }
  return location
}

/**
 * Send the file to an open session, chunk by chunk, resuming where an
 * interrupted chunk left off.
 *
 * A failed chunk is not re-sent blindly: the session is asked how many bytes it
 * holds (`Content-Range: bytes *\/<total>`) and the next PUT starts there, so a
 * chunk the server did receive is not sent twice and a partly received one is
 * not skipped.
 * @param settings - chunk size, per-chunk timeout, and retry count.
 * @param sessionUri - the URI {@link initiateUpload} returned.
 * @param file - the file being uploaded.
 * @param signal - withdraws the upload.
 * @returns the video YouTube created, as YouTube describes it.
 * @throws when a chunk keeps failing, or when Google refuses the upload.
 */
export async function sendVideo(
  settings: ApiSettings,
  accessToken: string,
  sessionUri: string,
  file: VideoFile,
  signal: AbortSignal,
): Promise<UploadedVideo> {
  const handle = await open(file.path, 'r')
  try {
    let offset = 0
    let attemptsLeft = settings.uploadRetries
    while (offset < file.size) {
      const length = Math.min(settings.chunkBytes, file.size - offset)
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, offset)
      let response: Response
      try {
        response = await call(new URL(sessionUri), {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': file.contentType,
            'Content-Range': `bytes ${String(offset)}-${String(offset + length - 1)}/${String(file.size)}`,
          },
          body: new Uint8Array(buffer),
        }, settings.chunkTimeoutMs, signal, 'the video upload')
      } catch (error) {
        // The bytes stopped moving rather than being refused: ask the session
        // what it holds and carry on from there, which is the whole point of a
        // resumable upload.
        if (signal.aborted || attemptsLeft <= 0) throw error
        attemptsLeft -= 1
        offset = await committedBytes(settings, accessToken, sessionUri, file, signal)
        continue
      }
      if (response.status === 308) {
        offset = rangeEnd(response.headers.get('range')) ?? offset + length
        continue
      }
      if (response.status === 500 || response.status === 502 || response.status === 503 || response.status === 504) {
        if (attemptsLeft <= 0) throw googleFailure('the video upload', response.status, await response.text())
        attemptsLeft -= 1
        offset = await committedBytes(settings, accessToken, sessionUri, file, signal)
        continue
      }
      const text = await response.text()
      if (!response.ok) throw googleFailure('the video upload', response.status, text)
      return readVideo(text)
    }
    // Every byte was accepted without a final resource: the session still knows
    // the answer, and asking for it is how a resumed upload finishes.
    const status = await queryStatus(settings, accessToken, sessionUri, file, signal)
    if (status.video !== undefined) return status.video
    throw new Error('YouTube accepted every byte of the video but never answered with the video resource.')
  } finally {
    await handle.close()
  }
}

/** Ask the session how many bytes it holds, for the next PUT to start there. */
async function committedBytes(
  settings: ApiSettings,
  accessToken: string,
  sessionUri: string,
  file: VideoFile,
  signal: AbortSignal,
): Promise<number> {
  const status = await queryStatus(settings, accessToken, sessionUri, file, signal)
  return status.video === undefined ? status.received : file.size
}

/** One answer to the status query: either how much is held, or the finished video. */
interface SessionStatus {
  /** Bytes the session holds. */
  received: number
  /** The finished resource, when the session was already complete. */
  video?: UploadedVideo
}

/**
 * Ask an open session where it got to, the query the resumable protocol
 * defines: a PUT with an empty body and `Content-Range: bytes *\/<total>`.
 */
async function queryStatus(
  settings: ApiSettings,
  accessToken: string,
  sessionUri: string,
  file: VideoFile,
  signal: AbortSignal,
): Promise<SessionStatus> {
  const response = await call(new URL(sessionUri), {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Range': `bytes */${String(file.size)}` },
  }, settings.timeoutMs, signal, 'the video upload')
  if (response.status === 308) {
    return { received: rangeEnd(response.headers.get('range')) ?? 0 }
  }
  const text = await response.text()
  if (!response.ok) throw googleFailure('the video upload', response.status, text)
  return { received: file.size, video: readVideo(text) }
}

/**
 * Read `Range: bytes=0-<last>` as the count of bytes held. The header is absent
 * when the session holds nothing yet, which is not the same as holding one byte.
 */
function rangeEnd(header: string | null): number | undefined {
  if (header === null) return undefined
  const match = /bytes=0-(\d+)/u.exec(header)
  return match?.[1] === undefined ? undefined : Number(match[1]) + 1
}

/** Read the uploaded video resource, keeping YouTube's own status fields as facts. */
function readVideo(text: string): UploadedVideo {
  let body: { id?: unknown; status?: Record<string, unknown> }
  try {
    body = JSON.parse(text) as typeof body
  } catch {
    throw new Error(`YouTube finished the upload with an answer that is not JSON: ${text.slice(0, 200)}`)
  }
  const id = typeof body.id === 'string' ? body.id : ''
  if (id === '') throw new Error('YouTube finished the upload without naming the video id.')
  const status = body.status ?? {}
  const video: UploadedVideo = { id }
  const privacyStatus = status['privacyStatus']
  if (typeof privacyStatus === 'string') video.privacyStatus = privacyStatus
  const uploadStatus = status['uploadStatus']
  if (typeof uploadStatus === 'string') video.uploadStatus = uploadStatus
  const rejectionReason = status['rejectionReason']
  if (typeof rejectionReason === 'string') video.rejectionReason = rejectionReason
  const failureReason = status['failureReason']
  if (typeof failureReason === 'string') video.failureReason = failureReason
  return video
}

/** One HTTP call with a timeout that is told apart from the caller withdrawing. */
async function call(
  url: URL,
  init: RequestInit,
  timeoutMs: number,
  signal: AbortSignal,
  what: string,
): Promise<Response> {
  const controller = new AbortController()
  const abort = (): void => { controller.abort(signal.reason) }
  if (signal.aborted) abort()
  signal.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => { controller.abort(new Error('timeout')) }, timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } catch (error) {
    if (controller.signal.aborted && !signal.aborted) {
      throw new Error(`Google did not answer ${what} within ${String(timeoutMs)}ms.`)
    }
    throw error instanceof Error ? error : new Error(String(error))
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
  }
}
