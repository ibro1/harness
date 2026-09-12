// Composer tools: an authenticated upload route that lands a file in the
// CURRENT session's workspace directory, so the operator can drop footage (or
// any file) into the folder the agent is editing in — reached from the web
// composer's upload button (ui-composer-tools).
//
// Layered over the shipped Web composition. The route sits BEHIND the password
// gate (authenticate defaults true): the caller is the logged-in operator, and
// the only thing they can do is write a file into their own session's cwd. The
// filename is reduced to a basename and rejected if it tries to escape, and the
// body streams straight to disk under a size cap rather than buffering — a
// video is gigabytes.

import { createWriteStream, createReadStream } from 'node:fs'
import { rename, rm, mkdir, readdir, stat } from 'node:fs/promises'
import { basename, join, resolve, relative, extname, isAbsolute } from 'node:path'
import z from '@deepseek-ai/schemastery'

export const name = 'composer-tools'
export const inject = ['webServer', 'sessions']

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024 // 2 GiB
const DEFAULT_VOICE_MAX_BYTES = 25 * 1024 * 1024 // 25 MiB (Groq's request cap)

export const Config = z.object({
  /** Absolute route path the composer uploads files to. */
  path: z.string().default('/workspace-upload'),
  /** Largest single file upload accepted, in bytes. */
  maxBytes: z.natural().min(1).default(DEFAULT_MAX_BYTES),
  /** Absolute route path the composer posts recorded audio to for transcription. */
  voicePath: z.string().default('/voice-transcribe'),
  /** Largest audio clip accepted for transcription, in bytes. */
  voiceMaxBytes: z.natural().min(1).default(DEFAULT_VOICE_MAX_BYTES),
  /** Absolute route path that lists the session's output files (its `edit/` dir). */
  filesPath: z.string().default('/workspace-files'),
  /** Absolute route path that streams one session file back for preview/download. */
  downloadPath: z.string().default('/workspace-download'),
})

/** Content type by extension for the download route; octet-stream otherwise. */
const CONTENT_TYPES = {
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.srt': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json',
}

/** Coarse media class for the preview the client renders. */
function kindOf(name) {
  const ext = extname(name).toLowerCase()
  if (['.mp4', '.webm', '.mov', '.mkv'].includes(ext)) return 'video'
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) return 'image'
  if (['.mp3', '.wav', '.m4a', '.ogg', '.flac'].includes(ext)) return 'audio'
  return 'other'
}

function contentType(name) {
  return CONTENT_TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * Where a session's finished files land.
 *
 * `edit/` was the convention of the first skill that needed one, and for a
 * while it was the only one. `.outputs/` is what the `outputs` capability
 * publishes into, and it is where new work should go: a skill that has to know
 * which directory the drawer happens to read is the problem that capability
 * exists to end. Both are listed while the older skills move over.
 */
const OUTPUT_DIRS = ['.outputs', 'edit']

/** Files under each of `OUTPUT_DIRS`, merged and newest first. */
async function listOutputs(cwd) {
  const files = []
  for (const rel of OUTPUT_DIRS) {
    const dir = join(cwd, rel)
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue // this directory does not exist in this session
    }
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.startsWith('.')) continue
      try {
        const s = await stat(join(dir, entry.name))
        files.push({ name: entry.name, rel: `${rel}/${entry.name}`, bytes: s.size, mtime: s.mtimeMs, kind: kindOf(entry.name) })
      } catch {
        // vanished between readdir and stat; skip it
      }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime)
  return files
}

/** Stream a file with Range support (so <video> can seek) and a disposition of
 *  the caller's choosing (inline preview vs. attachment download). */
function streamFile(req, res, abs, size, name, inline) {
  const type = contentType(name)
  const disposition = `${inline ? 'inline' : 'attachment'}; filename="${name.replace(/"/g, '')}"`
  const range = req.headers.range
  const match = typeof range === 'string' ? /^bytes=(\d*)-(\d*)$/.exec(range) : null
  if (match) {
    let start = match[1] === '' ? undefined : Number.parseInt(match[1], 10)
    let end = match[2] === '' ? undefined : Number.parseInt(match[2], 10)
    if (start === undefined) {
      // suffix range "bytes=-N": the last N bytes
      start = Math.max(0, size - (end ?? 0))
      end = size - 1
    } else if (end === undefined || end >= size) {
      end = size - 1
    }
    if (start > end || start >= size) {
      res.writeHead(416, { 'content-range': `bytes */${size}` })
      res.end()
      return
    }
    res.writeHead(206, {
      'content-type': type,
      'content-length': String(end - start + 1),
      'content-range': `bytes ${start}-${end}/${size}`,
      'accept-ranges': 'bytes',
      'content-disposition': disposition,
    })
    if (req.method === 'HEAD') { res.end(); return }
    createReadStream(abs, { start, end }).pipe(res)
    return
  }
  res.writeHead(200, {
    'content-type': type,
    'content-length': String(size),
    'accept-ranges': 'bytes',
    'content-disposition': disposition,
  })
  if (req.method === 'HEAD') { res.end(); return }
  createReadStream(abs).pipe(res)
}

/** Container extension for a recorded-audio content type, for the Groq filename. */
const AUDIO_EXT = {
  'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'mp4',
  'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/flac': 'flac',
}

/** Read a request body into a Buffer, failing at the cap rather than buffering
 *  an unbounded upload. Resolves undefined once the cap fires (response owned). */
function readCappedBody(req, res, maxBytes) {
  return new Promise((resolve) => {
    const chunks = []
    let bytes = 0
    let done = false
    req.on('data', (chunk) => {
      if (done) return
      bytes += chunk.length
      if (bytes > maxBytes) {
        done = true
        json(res, 413, { error: `audio exceeds the ${maxBytes}-byte limit` })
        req.destroy()
        resolve(undefined)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)) } })
    req.on('error', () => { if (!done) { done = true; resolve(undefined) } })
  })
}

/**
 * Transcribe recorded audio with Groq Whisper. Node 22 globals only (fetch /
 * FormData / Blob) — no Python, no dependency.
 * @returns { ok, text } | { ok:false, status, message }
 */
async function transcribeWithGroq(buf, contentType, apiKey) {
  const type = (contentType || 'audio/webm').split(';')[0].trim()
  const ext = AUDIO_EXT[type] ?? 'webm'
  const form = new FormData()
  form.append('file', new Blob([buf], { type }), `audio.${ext}`)
  form.append('model', 'whisper-large-v3')
  form.append('response_format', 'json')
  const resp = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  })
  const body = await resp.text()
  if (!resp.ok) return { ok: false, status: resp.status, message: body.slice(0, 500) }
  try {
    return { ok: true, text: String(JSON.parse(body).text ?? '') }
  } catch {
    return { ok: false, status: 502, message: 'Groq returned a non-JSON body' }
  }
}

/** Boot diagnostics to stderr, matching the browser-bridge convention: the Web
 *  profile composes no logger, so a plugin that never starts leaves no trace. */
function announce(message) {
  process.stderr.write(`composer-tools: ${message}\n`)
}

/** JSON response helper. */
function json(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(payload)
}

/**
 * Reduce a client-supplied name to a safe basename inside the target dir.
 * Rejects separators and traversal rather than sanitizing silently, so a
 * surprising name fails loud instead of writing somewhere unexpected.
 * @returns the basename, or undefined when the name is unusable.
 */
function safeName(raw) {
  if (typeof raw !== 'string' || raw === '') return undefined
  if (raw.includes('/') || raw.includes('\\') || raw.includes('\0')) return undefined
  const base = basename(raw)
  if (base === '' || base === '.' || base === '..') return undefined
  return base
}

export function apply(ctx, config) {
  announce(`upload route ${config.path} (max ${config.maxBytes} bytes)`)
  announce(`voice route ${config.voicePath} (max ${config.voiceMaxBytes} bytes, Groq Whisper)`)
  announce(`files route ${config.filesPath}; download route ${config.downloadPath}`)

  /** The session's authoritative workspace directory, or undefined with the
   *  response already written. */
  const resolveCwd = (res, sessionId) => {
    if (sessionId === '') {
      json(res, 400, { error: 'missing ?session=<id>' })
      return undefined
    }
    const cwd = ctx.sessions.get(sessionId)?.header?.cwd
    if (typeof cwd !== 'string' || cwd === '') {
      json(res, 409, { error: `session "${sessionId}" is not active or has no workspace directory` })
      return undefined
    }
    return cwd
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: config.path,
    // authenticate defaults true — the operator's password/session gates it.
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        json(res, 405, { error: 'method not allowed; use POST' })
        return
      }

      const url = new URL(req.url ?? '/', 'http://x')
      const sessionId = url.searchParams.get('session') ?? ''
      const name = safeName(url.searchParams.get('name'))
      if (sessionId === '') {
        json(res, 400, { error: 'missing ?session=<id>' })
        return
      }
      if (name === undefined) {
        json(res, 400, { error: 'missing or unsafe ?name=<filename>' })
        return
      }

      // Authoritative cwd from the session store — never a client-supplied path.
      const record = ctx.sessions.get(sessionId)
      const cwd = record?.header?.cwd
      if (typeof cwd !== 'string' || cwd === '') {
        json(res, 409, {
          error: `session "${sessionId}" is not active or has no workspace directory; `
            + 'open the session and try again',
        })
        return
      }

      const finalPath = join(cwd, name)
      const partPath = `${finalPath}.part`
      let bytes = 0
      let aborted = false

      try {
        await mkdir(cwd, { recursive: true })
      } catch (error) {
        json(res, 500, { error: `cannot prepare workspace: ${String(error)}` })
        return
      }

      const out = createWriteStream(partPath)
      const fail = async (status, message) => {
        if (aborted) return
        aborted = true
        out.destroy()
        await rm(partPath, { force: true }).catch(() => {})
        if (!res.headersSent) json(res, status, { error: message })
        else res.destroy()
      }

      req.on('data', (chunk) => {
        bytes += chunk.length
        if (bytes > config.maxBytes) {
          void fail(413, `file exceeds the ${config.maxBytes}-byte limit`)
        }
      })
      req.on('aborted', () => { void fail(400, 'upload aborted') })
      out.on('error', (error) => { void fail(500, `write failed: ${String(error)}`) })

      req.pipe(out)

      out.on('finish', async () => {
        if (aborted) return
        try {
          await rename(partPath, finalPath)
        } catch (error) {
          await rm(partPath, { force: true }).catch(() => {})
          json(res, 500, { error: `could not finalize file: ${String(error)}` })
          return
        }
        announce(`wrote ${finalPath} (${bytes} bytes)`)
        json(res, 200, { path: finalPath, name, bytes })
      })
    },
  }), 'composer-tools: workspace upload route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: config.voicePath,
    // authenticate defaults true — behind the password gate. Relays recorded
    // audio to Groq Whisper so the browser never holds the API key.
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        json(res, 405, { error: 'method not allowed; use POST' })
        return
      }
      const apiKey = (process.env.GROQ_API_KEY ?? '').trim()
      if (apiKey === '') {
        json(res, 503, { error: 'voice transcription unavailable: set GROQ_API_KEY on the harness' })
        return
      }
      const buf = await readCappedBody(req, res, config.voiceMaxBytes)
      if (buf === undefined) return // response already sent (413 or aborted)
      if (buf.length === 0) {
        json(res, 400, { error: 'empty audio' })
        return
      }
      try {
        const result = await transcribeWithGroq(buf, req.headers['content-type'], apiKey)
        if (!result.ok) {
          json(res, 502, { error: `groq ${result.status}: ${result.message}` })
          return
        }
        announce(`transcribed ${buf.length} bytes -> ${result.text.length} chars`)
        json(res, 200, { text: result.text })
      } catch (error) {
        json(res, 500, { error: `transcription failed: ${String(error)}` })
      }
    },
  }), 'composer-tools: voice transcription route')

  // List the current session's outputs (its edit/ directory) so the composer
  // can show a download/preview panel. Behind the password gate like the rest.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: config.filesPath,
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        json(res, 405, { error: 'method not allowed; use GET' })
        return
      }
      const url = new URL(req.url ?? '/', 'http://x')
      const cwd = resolveCwd(res, url.searchParams.get('session') ?? '')
      if (cwd === undefined) return
      json(res, 200, { files: await listOutputs(cwd) })
    },
  }), 'composer-tools: workspace files list route')

  // Stream one file from the session's workspace back to the browser — inline
  // for a preview, or as an attachment for download. The path is confined to
  // the session cwd; traversal outside it is rejected.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: config.downloadPath,
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        json(res, 405, { error: 'method not allowed; use GET' })
        return
      }
      const url = new URL(req.url ?? '/', 'http://x')
      const cwd = resolveCwd(res, url.searchParams.get('session') ?? '')
      if (cwd === undefined) return

      const rel = url.searchParams.get('path') ?? ''
      const abs = resolve(cwd, rel)
      const within = relative(cwd, abs)
      if (rel === '' || within === '' || within.startsWith('..') || isAbsolute(within)) {
        json(res, 400, { error: 'missing or unsafe ?path=<relative path within the workspace>' })
        return
      }
      let info
      try {
        info = await stat(abs)
      } catch {
        json(res, 404, { error: `not found: ${rel}` })
        return
      }
      if (!info.isFile()) {
        json(res, 404, { error: `not a file: ${rel}` })
        return
      }
      streamFile(req, res, abs, info.size, basename(abs), url.searchParams.get('inline') === '1')
    },
  }), 'composer-tools: workspace download route')
}
