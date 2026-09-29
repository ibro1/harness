/**
 * Sample hosting. Klipara's export link expires within the hour, which is
 * shorter than a creator takes to open a pitch, so each exported clip is
 * copied into the scout's directory at once and served from the harness under
 * an unguessable id: `/scout/s/<id>` is a page that plays it, `/scout/s/<id>.mp4`
 * the file. The id is 128 random bits and the only thing that grants access.
 */

import { randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, rename, stat, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'

/** Largest sample accepted, so one bad link cannot fill the volume. */
const MAX_SAMPLE_BYTES = 200 * 1024 * 1024

/** An id: 32 lower-case hex characters. */
const SAMPLE_ID = /^[0-9a-f]{32}$/u

/**
 * Download one exported clip into the samples directory.
 * @param dir - the samples directory.
 * @param url - Klipara's signed download link.
 * @param signal - cancels the download.
 * @returns the new sample's id.
 */
export async function storeSample(dir: string, url: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error(`Downloading the exported clip failed with HTTP ${String(response.status)}.`)
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (declared > MAX_SAMPLE_BYTES) throw new Error(`The exported clip is ${String(declared)} bytes, over the ${String(MAX_SAMPLE_BYTES)}-byte limit.`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length > MAX_SAMPLE_BYTES) throw new Error(`The exported clip is over the ${String(MAX_SAMPLE_BYTES)}-byte limit.`)
  const id = randomBytes(16).toString('hex')
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const partial = join(dir, `${id}.mp4.part`)
  await writeFile(partial, bytes, { mode: 0o600 })
  await rename(partial, join(dir, `${id}.mp4`))
  return id
}

/** Escape text for HTML. */
function html(value: string): string {
  return value.replace(/[&<>"']/gu, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[c] ?? c)
}

/**
 * The page a creator opens: the clip, and one line saying what it is.
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
<video src="${id}.mp4" controls playsinline preload="metadata"></video>
<p>${html(note)}</p></main></body></html>
`
}

/**
 * Serve one request under the samples prefix: the page or the file.
 * @param req - the request.
 * @param res - the response.
 * @param dir - the samples directory.
 * @param prefix - the route prefix, for example `/scout/s`.
 * @param headline - the page's headline.
 * @param note - the page's note.
 */
export async function serveSample(
  req: IncomingMessage, res: ServerResponse, dir: string, prefix: string, headline: string, note: string,
): Promise<void> {
  const rest = new URL(req.url ?? '/', 'http://x').pathname.slice(prefix.length).replace(/^\/+/u, '')
  const isFile = rest.endsWith('.mp4')
  const id = isFile ? rest.slice(0, -'.mp4'.length) : rest
  if (!SAMPLE_ID.test(id) || (req.method !== 'GET' && req.method !== 'HEAD')) {
    res.writeHead(404)
    res.end()
    return
  }
  const path = join(dir, `${id}.mp4`)
  let size: number
  try {
    size = (await stat(path)).size
  } catch {
    // An unknown id reads exactly like a removed sample.
    res.writeHead(404)
    res.end()
    return
  }
  if (!isFile) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' })
    res.end(req.method === 'HEAD' ? undefined : samplePage(id, headline, note))
    return
  }
  const range = /^bytes=(\d*)-(\d*)$/u.exec(req.headers.range ?? '')
  const start = range?.[1] ? Number(range[1]) : 0
  const end = range?.[2] ? Math.min(Number(range[2]), size - 1) : size - 1
  if (range !== null && (start > end || start >= size)) {
    res.writeHead(416, { 'Content-Range': `bytes */${String(size)}` })
    res.end()
    return
  }
  res.writeHead(range === null ? 200 : 206, {
    'Content-Type': 'video/mp4',
    'Content-Length': String(end - start + 1),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=3600',
    ...range === null ? {} : { 'Content-Range': `bytes ${String(start)}-${String(end)}/${String(size)}` },
  })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  createReadStream(path, { start, end }).pipe(res)
}
