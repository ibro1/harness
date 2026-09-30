/**
 * The DSN reader and the browser report tunnel. Ad blockers drop requests to a
 * Sentry-shaped `/api/<id>/envelope/` URL, so the browser SDK posts its
 * envelopes to a neutral same-origin path and this handler forwards them.
 *
 * It forwards only an envelope whose header names exactly the public DSN the
 * page was given, to that DSN's project, with `sentry_key` on the query string
 * (GlitchTip answers 403 without it). The body is capped, callers are
 * rate-limited per address, the upstream call times out, no cookie or header
 * of the caller is forwarded, and nothing of the body is logged.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

/** The parts of a DSN the reporter needs. */
export interface Dsn {
  /** The DSN as the Sentry SDKs write it in an envelope header; the only form the tunnel accepts. */
  canonical: string
  /** `https://bug.example.com`, with any path prefix the server sits under. */
  origin: string
  projectId: string
  publicKey: string
}

/**
 * Read a DSN (`https://<publicKey>@<host>[/<prefix>]/<projectId>`).
 * @param raw - the DSN.
 * @returns its parts.
 * @throws when it is not a DSN, naming what is wrong but never echoing the key.
 */
export function parseDsn(raw: string): Dsn {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    // The value itself is not echoed: it holds the key.
    throw new Error('SENTRY_DSN is not a URL')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('SENTRY_DSN must be an http(s) URL')
  if (url.username === '') throw new Error('SENTRY_DSN has no public key before the @')
  const segments = url.pathname.split('/').filter(segment => segment !== '')
  const projectId = segments.pop()
  if (projectId === undefined || !/^\d+$/u.test(projectId)) throw new Error('SENTRY_DSN does not end in a numeric project id')
  const prefix = segments.length === 0 ? '' : `/${segments.join('/')}`
  const publicKey = decodeURIComponent(url.username)
  return {
    canonical: `${url.protocol}//${publicKey}@${url.host}${prefix}/${projectId}`,
    origin: `${url.protocol}//${url.host}${prefix}`,
    projectId,
    publicKey,
  }
}

/**
 * The envelope endpoint a report for this DSN goes to, with the key on the query string.
 * @param dsn - the DSN.
 * @returns the URL.
 */
export function envelopeUrl(dsn: Dsn): string {
  return `${dsn.origin}/api/${dsn.projectId}/envelope/?sentry_key=${encodeURIComponent(dsn.publicKey)}&sentry_version=7`
}

/** Limits and target of the tunnel. */
export interface TunnelOptions {
  /** The only DSN an envelope may name. */
  dsn: Dsn
  /** Largest envelope accepted, in bytes. */
  maxBytes: number
  /** Envelopes one address may send per minute. */
  perMinute: number
  /** Upstream call timeout. */
  timeoutMs: number
  /** Whether to take the caller's address from X-Forwarded-For (behind a trusted proxy). */
  trustProxy: boolean
  fetch?: typeof fetch
  now?: () => number
}

/** The caller's address: the first X-Forwarded-For hop behind a trusted proxy, else the socket's. */
function callerAddress(req: IncomingMessage, trustProxy: boolean): string {
  const forwarded = req.headers['x-forwarded-for']
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim()
  return trustProxy && first !== undefined && first !== '' ? first : req.socket.remoteAddress ?? 'unknown'
}

/** Read at most `max` bytes of a body; undefined when it is longer. */
async function readCapped(req: IncomingMessage, max: number): Promise<Buffer | undefined> {
  const declared = Number(req.headers['content-length'] ?? '0')
  if (declared > max) return undefined
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += buffer.length
    if (size > max) return undefined
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

/**
 * Build the tunnel's request handler.
 * @param options - the DSN, limits and clock.
 * @returns the handler for POST requests to the tunnel path.
 */
export function createTunnel(options: TunnelOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const send = options.fetch ?? fetch
  const now = options.now ?? Date.now
  const windows = new Map<string, { start: number; count: number }>()
  const answer = (res: ServerResponse, status: number, body = ''): void => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(body)
  }
  return async (req, res) => {
    if (req.method !== 'POST') { answer(res, 405); return }
    const address = callerAddress(req, options.trustProxy)
    const at = now()
    const window = windows.get(address)
    if (window === undefined || at - window.start >= 60_000) {
      windows.set(address, { start: at, count: 1 })
      if (windows.size > 10_000) windows.clear()
    } else if (++window.count > options.perMinute) {
      answer(res, 429)
      return
    }
    const body = await readCapped(req, options.maxBytes)
    if (body === undefined) { answer(res, 413); return }
    const newline = body.indexOf(0x0A)
    let header: { dsn?: unknown }
    try {
      header = JSON.parse(body.subarray(0, newline === -1 ? body.length : newline).toString('utf8')) as { dsn?: unknown }
    } catch {
      // Not an envelope: nothing of it is echoed or logged.
      answer(res, 400)
      return
    }
    if (typeof header.dsn !== 'string' || header.dsn !== options.dsn.canonical) { answer(res, 403); return }
    try {
      const upstream = await send(envelopeUrl(options.dsn), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-sentry-envelope' },
        body: new Uint8Array(body),
        signal: AbortSignal.timeout(options.timeoutMs),
      })
      answer(res, upstream.status)
    } catch {
      // The upstream is down or slow; the page's SDK drops the report.
      answer(res, 502)
    }
  }
}
