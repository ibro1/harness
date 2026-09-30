import { createServer, type IncomingMessage, type Server } from 'node:http'
import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { createTunnel, envelopeUrl, parseDsn } from '../src/tunnel.ts'
import { LogRateLimit, logLineError, messageOnly, skippedLogError } from '../src/index.ts'

const DSN = 'https://0123456789abcdef0123456789abcdef@bug.example.test/42'

let server: Server | undefined
afterEach(async () => {
  if (server !== undefined) {
    await new Promise<void>(resolve => server?.close(() => { resolve() }))
    server = undefined
  }
})

/** Serve the tunnel with a recording upstream; returns the tunnel URL and what reached the upstream. */
async function tunnel(perMinute = 60) {
  const forwarded: { url: string; headers: Record<string, string>; body: string }[] = []
  const handler = createTunnel({
    dsn: parseDsn(DSN), maxBytes: 1024, perMinute, timeoutMs: 5000, trustProxy: true,
    fetch: async (url: string | URL | Request, init?: RequestInit) => {
      const target = url instanceof Request ? url.url : url.toString()
      const body = new TextDecoder().decode(init?.body as Uint8Array)
      forwarded.push({ url: target, headers: init?.headers as Record<string, string>, body })
      return new Response('{}', { status: 200 })
    },
  })
  server = createServer((req: IncomingMessage, res) => { void handler(req, res) })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return { url: `http://127.0.0.1:${String(address.port)}/api/monitor`, forwarded }
}

function envelope(dsn: string, item = '{"type":"event"}\n{"message":"boom"}'): string {
  return `${JSON.stringify({ event_id: 'a'.repeat(32), dsn, sent_at: new Date().toISOString() })}\n${item}`
}

describe('the DSN reader', () => {
  it('reads the key, host and project, and builds the keyed envelope URL', () => {
    const dsn = parseDsn('https://abc123@bug.linkfa.de/7/')
    expect(dsn).toMatchObject({ publicKey: 'abc123', projectId: '7', origin: 'https://bug.linkfa.de', canonical: 'https://abc123@bug.linkfa.de/7' })
    expect(envelopeUrl(dsn)).toBe('https://bug.linkfa.de/api/7/envelope/?sentry_key=abc123&sentry_version=7')
  })

  it('refuses a malformed DSN without echoing it', () => {
    expect(() => parseDsn('not a dsn with secret-key')).toThrow('SENTRY_DSN is not a URL')
    expect(() => parseDsn('https://bug.linkfa.de/7')).toThrow('no public key')
    try {
      parseDsn('https://secretkey@bug.linkfa.de/project')
    } catch (error) {
      expect(String(error)).not.toContain('secretkey')
    }
  })
})

describe('the browser tunnel', () => {
  it('forwards an envelope for our DSN with sentry_key, and no caller cookie or header', async () => {
    const { url, forwarded } = await tunnel()
    const response = await fetch(url, { method: 'POST', headers: { Cookie: 'dsh_session=secret', 'X-Forwarded-For': '1.2.3.4' }, body: envelope(DSN) })
    expect(response.status).toBe(200)
    expect(forwarded).toHaveLength(1)
    expect(forwarded[0]!.url).toBe('https://bug.example.test/api/42/envelope/?sentry_key=0123456789abcdef0123456789abcdef&sentry_version=7')
    expect(forwarded[0]!.headers).toEqual({ 'Content-Type': 'application/x-sentry-envelope' })
  })

  it('refuses an envelope for another DSN with 403, and forwards nothing', async () => {
    const { url, forwarded } = await tunnel()
    const response = await fetch(url, { method: 'POST', body: envelope('https://someoneelse@bug.example.test/42') })
    expect(response.status).toBe(403)
    expect(forwarded).toHaveLength(0)
  })

  it('refuses bodies over the cap, non-envelopes, other methods, and callers over the rate', async () => {
    const { url, forwarded } = await tunnel(2)
    expect((await fetch(url, { method: 'POST', body: envelope(DSN, 'x'.repeat(2000)), headers: { 'X-Forwarded-For': '5.5.5.5' } })).status).toBe(413)
    expect((await fetch(url, { method: 'POST', body: 'not json', headers: { 'X-Forwarded-For': '6.6.6.6' } })).status).toBe(400)
    expect((await fetch(url, { method: 'GET', headers: { 'X-Forwarded-For': '7.7.7.7' } })).status).toBe(405)
    const from = { 'X-Forwarded-For': '9.9.9.9' }
    expect((await fetch(url, { method: 'POST', body: envelope(DSN), headers: from })).status).toBe(200)
    expect((await fetch(url, { method: 'POST', body: envelope(DSN), headers: from })).status).toBe(200)
    expect((await fetch(url, { method: 'POST', body: envelope(DSN), headers: from })).status).toBe(429)
    expect(forwarded).toHaveLength(2)
  })
})

describe('log-line reports', () => {
  it('admit one report per logger per window and a total per minute', () => {
    let clock = 0
    const limit = new LogRateLimit(5 * 60_000, 2, () => clock)
    expect(limit.admit('klipara-scout')).toBe(true)
    expect(limit.admit('klipara-scout')).toBe(false)
    expect(limit.admit('webserver')).toBe(true)
    expect(limit.admit('cloudflare')).toBe(false)
    clock += 61_000
    expect(limit.admit('cloudflare')).toBe(true)
    clock += 5 * 60_000
    expect(limit.admit('klipara-scout')).toBe(true)
  })

  it('skip expected and will-retry failures, and take the Error a line carries', () => {
    expect(skippedLogError(new Error('agy: RESOURCE_EXHAUSTED (code 429): Individual quota reached'))).toBe(true)
    expect(skippedLogError(new Error('provider timed out, retrying in 4s'))).toBe(true)
    expect(skippedLogError(new Error('Cannot read properties of undefined'))).toBe(false)
    const error = new TypeError('boom')
    expect(logLineError(['context', error])).toBe(error)
    expect(logLineError(['plain', 'text']).message).toBe('plain text')
  })

  it('keep only the message and stack of a session failure', () => {
    const original = Object.assign(new Error('opencode: Unexpected server error'), { request: { messages: [{ content: 'prompt text' }] }, response: 'model output' })
    const copy = messageOnly(original)
    expect(copy.message).toBe('opencode: Unexpected server error')
    expect(JSON.stringify(Object.entries(copy))).not.toContain('prompt text')
    expect(Object.keys(copy)).toEqual(['name'])
  })
})
