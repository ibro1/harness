/**
 * Sample hosting. Klipara's export link expires within the hour, shorter than
 * a creator takes to open a pitch, so each exported clip is copied into the
 * scout's directory at once with a poster and a small metadata record, and
 * served from the harness under an unguessable id. The poster is Klipara's
 * designed cover for the clip when it has one (its link expires as fast, so it
 * is copied too), else a frame cut one second in:
 *
 * - `<prefix>/<id>`       an HTML page that plays the clip
 * - `<prefix>/<id>.mp4`   the clip, with range requests
 * - `<prefix>/<id>.jpg`   the poster
 * - `<prefix>/<id>.json`  public, read-only metadata for the page Klipara serves
 *
 * An id is 11 base64url characters, 64 random bits, and is the only thing that
 * grants access. Ids from before the short form (32 hex characters) still
 * resolve. A sample older than the retention period answers 404 like an
 * unknown one.
 */

import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'

/** Largest sample accepted, so one bad link cannot fill the volume. */
const MAX_SAMPLE_BYTES = 200 * 1024 * 1024
/** Largest cover accepted. */
const MAX_COVER_BYTES = 10 * 1024 * 1024

/** A short id (11 base64url characters) or a legacy one (32 hex characters). */
const SAMPLE_ID = /^(?:[A-Za-z0-9_-]{11}|[0-9a-f]{32})$/u

/** What a sample's public record says about it. */
export interface SampleMeta {
  title: string
  creatorName: string
  sourceVideoUrl: string
}

/** The stored record: the public fields plus when the sample was made. */
interface StoredMeta extends SampleMeta {
  id: string
  createdAt: string
  /** The Klipara clip the sample was exported from; not served. */
  clipId?: string
  /** Where the poster came from: Klipara's designed cover, or a frame of the clip; not served. */
  poster?: 'cover' | 'frame'
}

/** What `storeSample` is told beyond the public record. */
export interface StoreOptions {
  /** The Klipara clip, kept in the record so a later cover can be found for it. */
  clipId?: string
  /** Signed link to the clip's designed cover, or null when it has none. */
  coverUrl?: string | null
  /** The creation time. */
  now?: Date
}

/** How sample requests are answered. */
export interface SampleServing {
  /** Absolute origin plus prefix the file URLs in the JSON are built on, for example `https://harness.example.com/scout/s`. */
  fileBase: string
  /** Origin allowed to read the JSON and files from a browser. */
  corsOrigin: string
  /** Days a sample stays served; 0 keeps it for good. */
  ttlDays: number
  /** The HTML page's headline and note. */
  headline: string
  note: string
}

/**
 * A new sample id: 8 random bytes as base64url, 11 characters, 64 bits.
 * @returns the id.
 */
export function newSampleId(): string {
  return randomBytes(8).toString('base64url')
}

/**
 * Cut the poster frame one second in, or the first frame of a shorter clip.
 * A failure leaves the sample without a poster rather than failing it.
 * @param video - the clip.
 * @param poster - where the JPEG goes.
 * @returns whether a poster was written.
 */
function cutPoster(video: string, poster: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('ffmpeg', ['-y', '-loglevel', 'error', '-ss', '1', '-i', video, '-frames:v', '1', '-q:v', '3', poster], { timeout: 60_000 }, (error) => {
      if (error === null) { resolve(true); return }
      execFile('ffmpeg', ['-y', '-loglevel', 'error', '-i', video, '-frames:v', '1', '-q:v', '3', poster], { timeout: 60_000 }, (second) => { resolve(second === null) })
    })
  })
}

/**
 * Copy Klipara's designed cover to the sample's poster, replacing what is
 * there only once the whole image is in. A cover that is not JPEG is re-encoded.
 * @param url - the signed cover link.
 * @param poster - where the JPEG goes.
 * @param signal - cancels the download.
 * @returns whether the poster is now the cover; a failure leaves the old poster in place.
 */
export async function fetchCover(url: string, poster: string, signal: AbortSignal): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]) })
    if (!response.ok) return false
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length === 0 || bytes.length > MAX_COVER_BYTES) return false
    const partial = `${poster}.part`
    if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
      await writeFile(partial, bytes, { mode: 0o600 })
    } else {
      const source = `${poster}.src`
      await writeFile(source, bytes, { mode: 0o600 })
      const converted = await new Promise<boolean>((resolve) => {
        execFile('ffmpeg', ['-y', '-loglevel', 'error', '-i', source, '-frames:v', '1', '-q:v', '2', '-f', 'mjpeg', partial], { timeout: 60_000 }, (error) => { resolve(error === null) })
      })
      await rm(source, { force: true })
      if (!converted) { await rm(partial, { force: true }); return false }
    }
    await rename(partial, poster)
    return true
  } catch {
    // An expired link, a network failure or a cancelled shift: the frame stays.
    return false
  }
}

/**
 * Put Klipara's cover on an existing sample and note it in the record.
 * @param dir - the samples directory.
 * @param id - the sample id.
 * @param coverUrl - the signed cover link.
 * @param signal - cancels the download.
 * @returns whether the cover is now the poster.
 */
export async function setSampleCover(dir: string, id: string, coverUrl: string, signal: AbortSignal): Promise<boolean> {
  if (!SAMPLE_ID.test(id)) return false
  const recordPath = join(dir, `${id}.meta.json`)
  const record = JSON.parse(await readFile(recordPath, 'utf8')) as StoredMeta
  if (!await fetchCover(coverUrl, join(dir, `${id}.jpg`), signal)) return false
  record.poster = 'cover'
  await writeFile(`${recordPath}.part`, `${JSON.stringify(record)}\n`, { mode: 0o600 })
  await rename(`${recordPath}.part`, recordPath)
  return true
}

/**
 * Where a sample's poster came from, as its record says.
 * @param dir - the samples directory.
 * @param id - the sample id.
 * @returns `cover`, `frame`, or undefined for a sample stored before posters were noted, or none.
 */
export async function samplePosterSource(dir: string, id: string): Promise<'cover' | 'frame' | undefined> {
  if (!SAMPLE_ID.test(id)) return undefined
  try {
    return (JSON.parse(await readFile(join(dir, `${id}.meta.json`), 'utf8')) as StoredMeta).poster
  } catch {
    // No record: treat as not noted.
    return undefined
  }
}

/**
 * Download one exported clip into the samples directory, with its poster and record.
 * @param dir - the samples directory.
 * @param url - Klipara's signed download link.
 * @param meta - the public fields of the record.
 * @param signal - cancels the download.
 * @param options - the clip, its cover link and the creation time.
 * @returns the new sample's id.
 */
export async function storeSample(
  dir: string, url: string, meta: SampleMeta, signal: AbortSignal, options: StoreOptions = {},
): Promise<string> {
  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error(`Downloading the exported clip failed with HTTP ${String(response.status)}.`)
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (declared > MAX_SAMPLE_BYTES) throw new Error(`The exported clip is ${String(declared)} bytes, over the ${String(MAX_SAMPLE_BYTES)}-byte limit.`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length > MAX_SAMPLE_BYTES) throw new Error(`The exported clip is over the ${String(MAX_SAMPLE_BYTES)}-byte limit.`)
  const id = newSampleId()
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const partial = join(dir, `${id}.mp4.part`)
  await writeFile(partial, bytes, { mode: 0o600 })
  await rename(partial, join(dir, `${id}.mp4`))
  const poster = join(dir, `${id}.jpg`)
  const cover = options.coverUrl ? await fetchCover(options.coverUrl, poster, signal) : false
  if (!cover) await cutPoster(join(dir, `${id}.mp4`), poster)
  const record: StoredMeta = {
    id, ...meta, createdAt: (options.now ?? new Date()).toISOString(),
    ...options.clipId === undefined ? {} : { clipId: options.clipId },
    poster: cover ? 'cover' : 'frame',
  }
  await writeFile(join(dir, `${id}.meta.json`), `${JSON.stringify(record)}\n`, { mode: 0o600 })
  return id
}

/** Escape text for HTML. */
function html(value: string): string {
  return value.replace(/[&<>"']/gu, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[c] ?? c)
}

/**
 * The page a creator opens on the harness: the clip, and one line saying what it is.
 * @param id - the sample id.
 * @param headline - the line above the video.
 * @param note - the line below it.
 * @returns the HTML document.
 */
export function samplePage(id: string, headline: string, note: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${html(headline)}</title><meta name="robots" content="noindex">
<style>
:root{color-scheme:dark light;--bg:#0f0f12;--fg:#f2f2f4;--muted:#a3a3ad}
@media (prefers-color-scheme:light){:root{--bg:#f6f6f8;--fg:#111114;--muted:#55555e}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif;display:flex;justify-content:center}
main{max-width:420px;width:100%;padding:24px 16px}
h1{font-size:20px;margin:0 0 16px}
video{width:100%;border-radius:12px;background:#000;aspect-ratio:9/16}
p{color:var(--muted);margin:16px 0 0}
</style></head>
<body><main><h1>${html(headline)}</h1>
<video src="${id}.mp4" poster="${id}.jpg" controls playsinline preload="metadata"></video>
<p>${html(note)}</p></main></body></html>
`
}

/** Whether a file exists; its size when it does. */
async function sizeOf(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).size
  } catch {
    // Absent is the answer; the caller turns it into a 404.
    return undefined
  }
}

/**
 * A sample's stored record, when the sample exists and has not expired.
 * @param dir - the samples directory.
 * @param id - the sample id.
 * @param ttlDays - retention in days; 0 keeps samples for good.
 * @param now - the current time.
 * @returns the record, or undefined for an unknown or expired id.
 */
export async function readSample(dir: string, id: string, ttlDays: number, now = new Date()): Promise<StoredMeta | undefined> {
  if (!SAMPLE_ID.test(id)) return undefined
  const video = join(dir, `${id}.mp4`)
  let created: Date
  let record: StoredMeta
  try {
    record = JSON.parse(await readFile(join(dir, `${id}.meta.json`), 'utf8')) as StoredMeta
    created = new Date(record.createdAt)
  } catch {
    // A sample stored before records existed: its file's time stands in.
    const info = await stat(video).catch(() => undefined)
    if (info === undefined) return undefined
    created = info.mtime
    record = { id, title: '', creatorName: '', sourceVideoUrl: '', createdAt: info.mtime.toISOString() }
  }
  if (await sizeOf(video) === undefined) return undefined
  if (ttlDays > 0 && now.getTime() - created.getTime() > ttlDays * 86_400_000) return undefined
  return record
}

/**
 * Serve one request under the samples prefix.
 * @param req - the request.
 * @param res - the response.
 * @param dir - the samples directory.
 * @param prefix - the route prefix, for example `/scout/s`.
 * @param serving - URLs, CORS origin, retention and page copy.
 */
export async function serveSample(
  req: IncomingMessage, res: ServerResponse, dir: string, prefix: string, serving: SampleServing,
): Promise<void> {
  const cors = { 'Access-Control-Allow-Origin': serving.corsOrigin, 'Vary': 'Origin' }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      ...cors, 'Access-Control-Allow-Methods': 'GET, HEAD', 'Access-Control-Allow-Headers': 'Range', 'Access-Control-Max-Age': '86400',
    })
    res.end()
    return
  }
  const rest = new URL(req.url ?? '/', 'http://x').pathname.slice(prefix.length).replace(/^\/+/u, '')
  const match = /^([^./]+)(?:\.(mp4|jpg|json))?$/u.exec(rest)
  const notFound = (): void => { res.writeHead(404, cors); res.end() }
  if (match === null || (req.method !== 'GET' && req.method !== 'HEAD')) { notFound(); return }
  const id = match[1] ?? ''
  const kind = match[2]
  const record = await readSample(dir, id, serving.ttlDays)
  if (record === undefined) { notFound(); return }

  if (kind === 'json') {
    const hasPoster = await sizeOf(join(dir, `${id}.jpg`)) !== undefined
    const base = serving.fileBase.replace(/\/+$/u, '')
    const body = JSON.stringify({
      id: record.id,
      title: record.title,
      creatorName: record.creatorName,
      sourceVideoUrl: record.sourceVideoUrl,
      videoUrl: `${base}/${id}.mp4`,
      posterUrl: hasPoster ? `${base}/${id}.jpg` : null,
      createdAt: record.createdAt,
    })
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=300', 'X-Robots-Tag': 'noindex' })
    res.end(req.method === 'HEAD' ? undefined : body)
    return
  }
  if (kind === undefined) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' })
    res.end(req.method === 'HEAD' ? undefined : samplePage(id, serving.headline, serving.note))
    return
  }
  const path = join(dir, `${id}.${kind}`)
  const size = await sizeOf(path)
  if (size === undefined) { notFound(); return }
  const type = kind === 'mp4' ? 'video/mp4' : 'image/jpeg'
  const range = /^bytes=(\d*)-(\d*)$/u.exec(req.headers.range ?? '')
  const start = range?.[1] ? Number(range[1]) : 0
  const end = range?.[2] ? Math.min(Number(range[2]), size - 1) : size - 1
  if (range !== null && (start > end || start >= size)) {
    res.writeHead(416, { ...cors, 'Content-Range': `bytes */${String(size)}` })
    res.end()
    return
  }
  res.writeHead(range === null ? 200 : 206, {
    ...cors,
    'Content-Type': type,
    'Content-Length': String(end - start + 1),
    'Accept-Ranges': 'bytes',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
    // A poster can change once, when a cover replaces the frame, so it is kept for less time than the clip.
    'Cache-Control': kind === 'jpg' ? 'public, max-age=300' : 'public, max-age=3600',
    ...range === null ? {} : { 'Content-Range': `bytes ${String(start)}-${String(end)}/${String(size)}` },
  })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  createReadStream(path, { start, end }).pipe(res)
}
