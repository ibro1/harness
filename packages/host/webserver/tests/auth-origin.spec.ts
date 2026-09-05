/**
 * The Origin guard on state-changing auth POSTs, defence in depth beside the
 * session cookie's SameSite=Lax. A cross-site form POST carries the attacker's
 * Origin and must be refused before the request does anything; a same-origin
 * POST must pass through to normal handling.
 */

import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { handleAuthRoutes } from '../src/auth.ts'

/** A request just complete enough for the guard: headers, a socket, no body. */
function fakeRequest(headers: Record<string, string>, method = 'POST'): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage & { socket: { end: () => void } }
  req.method = method
  req.url = '/auth/login'
  req.headers = headers
  req.socket = { end: () => {} } as unknown as IncomingMessage['socket']
  return req
}

interface CapturedResponse {
  status?: number
  writableEnded: boolean
  writeHead: (status: number) => CapturedResponse
  end: () => CapturedResponse
  on: EventEmitter['on']
  emit: EventEmitter['emit']
}

/** A response capturing the status and whether it completed. */
function fakeResponse(): CapturedResponse {
  const emitter = new EventEmitter()
  const res: CapturedResponse = {
    writableEnded: false,
    writeHead(status: number) { res.status = status; return res },
    end() { res.writableEnded = true; emitter.emit('finish'); return res },
    on: emitter.on.bind(emitter),
    emit: emitter.emit.bind(emitter),
  }
  return res
}

describe('auth Origin guard', () => {
  beforeEach(() => {
    process.env.DSH_AUTH_PASSWORD = 'a-password-for-tests'
    process.env.DSH_TRUST_PROXY = '1'
  })
  afterEach(() => {
    delete process.env.DSH_AUTH_PASSWORD
    delete process.env.DSH_TRUST_PROXY
  })

  it('refuses a login POST from a foreign Origin', () => {
    const req = fakeRequest({ host: 'harness.example', 'x-forwarded-host': 'harness.example', origin: 'https://evil.test' })
    const res = fakeResponse()
    const handled = handleAuthRoutes(req, res as unknown as ServerResponse, '/auth/login', () => '/')
    expect(handled).toBe(true)
    expect(res.status).toBe(403)
  })

  it('refuses a login POST whose Origin will not parse', () => {
    const req = fakeRequest({ host: 'harness.example', origin: 'not a url' })
    const res = fakeResponse()
    handleAuthRoutes(req, res as unknown as ServerResponse, '/auth/login', () => '/')
    expect(res.status).toBe(403)
  })

  it('passes a same-origin login POST through to normal handling', () => {
    // Same Origin as the forwarded host: the guard does not fire, so the
    // handler reads the body and the status is not the guard's 403.
    const req = fakeRequest({ host: 'harness.example', 'x-forwarded-host': 'harness.example', origin: 'https://harness.example' })
    const res = fakeResponse()
    handleAuthRoutes(req, res as unknown as ServerResponse, '/auth/login', () => '/')
    expect(res.status).not.toBe(403)
  })

  it('allows a POST with no Origin, since browsers always send one cross-site', () => {
    const req = fakeRequest({ host: 'harness.example' })
    const res = fakeResponse()
    handleAuthRoutes(req, res as unknown as ServerResponse, '/auth/login', () => '/')
    expect(res.status).not.toBe(403)
  })
})
