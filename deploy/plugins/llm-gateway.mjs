// LLM gateway: lets another service on this box use the harness's models.
//
// The agy and opencode bridges already speak the OpenAI protocol, but they bind
// 127.0.0.1 with no authentication of their own — anything that can reach them
// spends the operator's Antigravity quota for free, which is why they must never
// be given a domain. This plugin is the one authenticated door to them.
//
// Auth is a DEDICATED token, not DSH_AUTH_API_TOKEN. That is the point: the
// harness API token grants the whole harness — sessions, shell, the workspace —
// and a marketing app that only needs chat completions should not hold it. A
// leaked gateway token costs model quota, not the box.
//
// Routes (each a thin proxy to one bridge, preserving the OpenAI shape):
//   POST /llm/agy/v1/chat/completions       -> 127.0.0.1:8001
//   GET  /llm/agy/v1/models
//   POST /llm/opencode/v1/chat/completions  -> 127.0.0.1:8002
//   GET  /llm/opencode/v1/models
//
// The upstream is chosen by path rather than by sniffing the model name: a
// caller says which CLI it wants, and a model that does not exist there fails
// loudly at the bridge instead of being silently routed elsewhere.
//
// Disabled (503) when DSH_LLM_GATEWAY_TOKEN is unset, so a deploy that never
// configured it cannot accidentally expose the bridges.

import { Readable } from 'node:stream'
import { timingSafeEqual } from 'node:crypto'

export const name = 'llm-gateway'
export const inject = ['webServer']

/**
 * Read an env var, treating blank as unset.
 *
 * Compose passes an unset variable through `${VAR:-}` as an EMPTY STRING, not
 * as absent, and `??` only catches null/undefined. Every default in this file
 * goes through here so a variable the operator never set cannot override one.
 */
function env(name) {
  const value = process.env[name]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

const TOKEN = env('DSH_LLM_GATEWAY_TOKEN') ?? ''

/** Upstream bridges, keyed by the path segment that selects them. */
const UPSTREAMS = {
  agy: (env('AGY_BRIDGE_URL') ?? 'http://127.0.0.1:8001').replace(/\/$/, ''),
  opencode: (env('OPENCODE_BRIDGE_URL') ?? 'http://127.0.0.1:8002').replace(/\/$/, ''),
}

/**
 * A bridge spawns a CLI per request, so a completion can legitimately take
 * minutes. Long, but not unbounded — a wedged CLI must not hold the socket
 * open forever.
 *
 * A non-numeric or non-positive override is ignored rather than honoured: a
 * zero here aborts every request the instant it is made, which reads at the
 * caller as the upstream being down.
 */
const UPSTREAM_TIMEOUT_MS = (() => {
  const configured = Number(env('DSH_LLM_GATEWAY_TIMEOUT_MS'))
  return Number.isFinite(configured) && configured > 0 ? configured : 600_000
})()

/** Largest request body accepted, so a bad caller cannot exhaust memory here. */
const MAX_BODY_BYTES = 2 * 1024 * 1024

function announce(message) { process.stderr.write(`llm-gateway: ${message}\n`) }

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** Constant-time bearer comparison, so the token cannot be recovered by timing. */
function presentedTokenIsValid(header) {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false
  const presented = Buffer.from(header.slice('Bearer '.length))
  const expected = Buffer.from(TOKEN)
  if (presented.length !== expected.length) return false
  return timingSafeEqual(presented, expected)
}

/** Read the request body with a hard cap. Resolves null when the cap is hit. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) { resolve(null); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/**
 * Proxy one request to a bridge and stream the answer back untouched.
 *
 * The body is buffered rather than piped: a chat completion is small, and
 * buffering avoids Node's duplex-stream request requirement. The RESPONSE is
 * streamed, so an SSE completion (`stream: true`) arrives token by token
 * instead of landing in one lump at the end.
 */
async function proxy(upstream, path, req, res) {
  const body = req.method === 'POST' ? await readBody(req) : undefined
  if (body === null) { json(res, 413, { error: 'request body too large' }); return }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS)
  const started = Date.now()
  try {
    const upstreamRes = await fetch(`${upstream}${path}`, {
      method: req.method,
      headers: {
        'content-type': 'application/json',
        // The bridges accept any key; they authenticate nothing themselves.
        authorization: 'Bearer harness-llm-gateway',
        accept: req.headers['accept'] ?? 'application/json',
      },
      ...(body !== undefined && body.length > 0 ? { body } : {}),
      signal: controller.signal,
    })

    res.writeHead(upstreamRes.status, {
      'content-type': upstreamRes.headers.get('content-type') ?? 'application/json',
      // Never let a proxy buffer an SSE stream.
      'cache-control': 'no-cache',
    })
    if (upstreamRes.body === null) { res.end(); return }
    await new Promise((resolve, reject) => {
      const stream = Readable.fromWeb(upstreamRes.body)
      stream.on('error', reject)
      res.on('close', resolve)
      stream.pipe(res).on('finish', resolve)
    })
    announce(`${req.method} ${path} -> ${upstreamRes.status} in ${Date.now() - started}ms`)
  } catch (error) {
    const aborted = controller.signal.aborted
    announce(`${req.method} ${path} FAILED after ${Date.now() - started}ms: ${String(error)}`)
    // A bridge that is down or wedged is a gateway problem, not the caller's.
    if (!res.headersSent) {
      json(res, aborted ? 504 : 502, {
        error: aborted
          ? `upstream did not answer within ${UPSTREAM_TIMEOUT_MS}ms`
          : `upstream unreachable: ${String(error)}`,
      })
    } else {
      res.end()
    }
  } finally {
    clearTimeout(timer)
  }
}

export function apply(ctx) {
  if (TOKEN === '') {
    announce('DSH_LLM_GATEWAY_TOKEN unset — gateway disabled')
  } else if (TOKEN.length < 16) {
    // Fail loudly rather than serve the bridges behind a guessable token.
    throw new Error('llm-gateway: DSH_LLM_GATEWAY_TOKEN must be at least 16 characters')
  } else {
    announce(`serving ${Object.entries(UPSTREAMS).map(([k, v]) => `${k}=${v}`).join(' ')}`)
  }

  for (const [cli, upstream] of Object.entries(UPSTREAMS)) {
    for (const [suffix, method] of [['/chat/completions', 'POST'], ['/models', 'GET']]) {
      const path = `/llm/${cli}/v1${suffix}`
      ctx.effect(() => ctx.webServer.register({
        kind: 'exact',
        path,
        // The gateway authenticates its own caller with a dedicated token: this
        // is a machine endpoint with no cookie, like the whatsapp command route.
        authenticate: false,
        handler: async (req, res) => {
          if (TOKEN === '') { json(res, 503, { error: 'LLM gateway not configured' }); return }
          if (!presentedTokenIsValid(req.headers['authorization'] ?? '')) {
            announce(`refused ${req.method} ${path}: bad or missing token`)
            json(res, 401, { error: 'unauthorized' })
            return
          }
          if (req.method !== method) { json(res, 405, { error: `${method} only` }); return }
          await proxy(upstream, `/v1${suffix}`, req, res)
        },
      }), `llm-gateway: ${path}`)
    }
  }
}
