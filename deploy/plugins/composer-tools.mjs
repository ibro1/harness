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

import { createWriteStream } from 'node:fs'
import { rename, rm, mkdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import z from '@deepseek-ai/schemastery'

export const name = 'composer-tools'
export const inject = ['webServer', 'sessions']

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024 // 2 GiB

export const Config = z.object({
  /** Absolute route path the composer uploads to. */
  path: z.string().default('/workspace-upload'),
  /** Largest single upload accepted, in bytes. */
  maxBytes: z.natural().min(1).default(DEFAULT_MAX_BYTES),
})

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
}
