/**
 * The second-factor core: code verification, replay defence, backup-code
 * consumption, and the enroll/disable lifecycle. Each test drives a private
 * DSH_HOME so the on-disk store never touches a real one.
 */

import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  backupCodesRemaining,
  beginEnrollment,
  confirmEnrollment,
  disableTotp,
  totpEnrolled,
  verifyTotp,
} from '../src/totp.ts'

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** Decode base32 the same way the module does, to compute a valid live code. */
function base32Decode(secret: string): Buffer {
  const clean = secret.replace(/=+$/u, '').toUpperCase().replace(/\s/gu, '')
  const bytes: number[] = []
  let bits = 0
  let value = 0
  for (const character of clean) {
    const index = BASE32.indexOf(character)
    if (index === -1) continue
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) { bits -= 8; bytes.push((value >> bits) & 0xff) }
  }
  return Buffer.from(bytes)
}

/** The current six-digit code for a secret, as an authenticator app would show. */
function liveCode(secret: string): string {
  const step = Math.floor(Date.now() / 1000 / 30)
  const counter = Buffer.alloc(8)
  counter.writeUInt32BE(step >>> 0, 4)
  const digest = createHmac('sha1', base32Decode(secret)).update(counter).digest()
  const offset = digest[digest.length - 1]! & 0x0f
  const binary = ((digest[offset]! & 0x7f) << 24) | ((digest[offset + 1]! & 0xff) << 16)
    | ((digest[offset + 2]! & 0xff) << 8) | (digest[offset + 3]! & 0xff)
  return (binary % 1_000_000).toString().padStart(6, '0')
}

let home: string | undefined

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-totp-'))
  process.env.DSH_HOME = home
})
afterEach(() => {
  delete process.env.DSH_HOME
  if (home !== undefined) rmSync(home, { recursive: true, force: true })
  home = undefined
})

describe('totp', () => {
  it('has no factor until one is enrolled', () => {
    expect(totpEnrolled('ada')).toBe(false)
  })

  it('confirms an enrollment only with a code proven from its secret', () => {
    const { secret } = beginEnrollment('u_confirm', 'harness.test')
    expect(confirmEnrollment('u_confirm', secret, '000000')).toBeUndefined()
    expect(totpEnrolled('u_confirm')).toBe(false)

    const codes = confirmEnrollment('u_confirm', secret, liveCode(secret))
    expect(codes).toHaveLength(10)
    expect(totpEnrolled('u_confirm')).toBe(true)
  })

  it('accepts a live code and rejects a wrong one', () => {
    const { secret } = beginEnrollment('u_live', 'harness.test')
    confirmEnrollment('u_live', secret, liveCode(secret))
    expect(verifyTotp('u_live', liveCode(secret))).toBe(true)
    expect(verifyTotp('u_live', '000000')).toBe(false)
  })

  it('refuses to replay a code already spent in its window', () => {
    const { secret } = beginEnrollment('u_replay', 'harness.test')
    confirmEnrollment('u_replay', secret, liveCode(secret))
    const code = liveCode(secret)
    expect(verifyTotp('u_replay', code)).toBe(true)
    // Same code, same step: a captured code cannot be used twice.
    expect(verifyTotp('u_replay', code)).toBe(false)
  })

  it('consumes a backup code once and no more', () => {
    const { secret } = beginEnrollment('u_backup', 'harness.test')
    const codes = confirmEnrollment('u_backup', secret, liveCode(secret))!
    const backup = codes[0]!
    expect(backupCodesRemaining('u_backup')).toBe(10)
    expect(verifyTotp('u_backup', backup)).toBe(true)
    expect(backupCodesRemaining('u_backup')).toBe(9)
    // The same backup code is now spent.
    expect(verifyTotp('u_backup', backup)).toBe(false)
  })

  it('accepts a backup code with or without its separating dash', () => {
    const { secret } = beginEnrollment('u_dash', 'harness.test')
    const codes = confirmEnrollment('u_dash', secret, liveCode(secret))!
    // A backup code reads as `xxxxx-xxxxx`; entering it without the dash works.
    expect(verifyTotp('u_dash', codes[0]!.replace('-', ''))).toBe(true)
  })

  it('drops the factor on disable', () => {
    const { secret } = beginEnrollment('u_disable', 'harness.test')
    confirmEnrollment('u_disable', secret, liveCode(secret))
    disableTotp('u_disable')
    expect(totpEnrolled('u_disable')).toBe(false)
    expect(verifyTotp('u_disable', liveCode(secret))).toBe(false)
  })

  it('keeps accounts independent', () => {
    const a = beginEnrollment('ada', 'harness.test')
    confirmEnrollment('ada', a.secret, liveCode(a.secret))
    expect(totpEnrolled('ada')).toBe(true)
    expect(totpEnrolled('grace')).toBe(false)
    expect(verifyTotp('grace', liveCode(a.secret))).toBe(false)
  })
})
