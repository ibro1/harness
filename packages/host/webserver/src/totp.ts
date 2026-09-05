/**
 * Time-based one-time passwords (RFC 6238) as an optional second factor for the
 * web gate. The account's shared secret and its single-use backup codes live in
 * `.totp.json` in the Harness home — apart from `users.json`, which the account
 * CLI owns, so enrolling a factor never rewrites a password store. The file is
 * mode 600 and written atomically, like the session store.
 *
 * The verifier is a standard 30-second, six-digit, HMAC-SHA1 code, with a
 * one-step window either side to tolerate clock skew, compared in constant time.
 * A used time step is remembered until it expires, so a code cannot be replayed
 * inside its own window.
 *
 * @module @deepseek-ai/dsh-host-webserver/totp
 */

import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Seconds per TOTP step. The RFC default, and what every authenticator assumes. */
const STEP_SECONDS = 30

/** Digits in a generated code. */
const CODE_DIGITS = 6

/** Steps checked either side of now, absorbing modest client clock skew. */
const WINDOW_STEPS = 1

/** Backup codes minted per enrollment. */
const BACKUP_CODE_COUNT = 10

/** scrypt parameters for hashing a backup code; matches the password store. */
const SCRYPT_KEYLEN = 32
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 } as const

/** RFC 4648 base32 alphabet, for the shared secret. */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** One account's stored second factor. */
interface TotpRecord {
  /** Base32 shared secret. */
  secret: string
  /** scrypt digests of the remaining single-use backup codes. */
  backupCodes: string[]
}

/** The on-disk document. */
interface TotpFile {
  version: 1
  accounts: Record<string, TotpRecord>
}

/** Harness home, matching the rest of the auth store. */
function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** Path to the second-factor store. */
function totpPath(): string {
  return join(dshHome(), '.totp.json')
}

/** Read the store, treating any absence or corruption as no factors enrolled. */
function loadFile(): TotpFile {
  let raw: string
  try {
    raw = readFileSync(totpPath(), 'utf8')
  } catch {
    return { version: 1, accounts: {} }
  }
  try {
    const parsed = JSON.parse(raw) as { accounts?: unknown }
    const accounts = parsed.accounts
    if (accounts === null || typeof accounts !== 'object' || Array.isArray(accounts)) {
      return { version: 1, accounts: {} }
    }
    return { version: 1, accounts: accounts as Record<string, TotpRecord> }
  } catch {
    return { version: 1, accounts: {} }
  }
}

/** Persist the store atomically at mode 600, since it grants a login factor. */
function saveFile(file: TotpFile): void {
  mkdirSync(dshHome(), { recursive: true })
  const target = totpPath()
  const temporary = `${target}.${process.pid.toString()}.tmp`
  writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
  try {
    chmodSync(temporary, 0o600)
  } catch {
    // A filesystem that cannot chmod (a bind mount, Windows) still holds the
    // data; the mode on writeFileSync above is the real guarantee elsewhere.
  }
  renameSync(temporary, target)
}

/** Decode a base32 secret to its bytes, ignoring padding and case. */
function base32Decode(secret: string): Buffer {
  const clean = secret.replace(/=+$/u, '').toUpperCase().replace(/\s/gu, '')
  const bytes: number[] = []
  let bits = 0
  let value = 0
  for (const character of clean) {
    const index = BASE32_ALPHABET.indexOf(character)
    if (index === -1) continue
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      bits -= 8
      bytes.push((value >> bits) & 0xff)
    }
  }
  return Buffer.from(bytes)
}

/** The six-digit code for one time step of one secret. */
function codeForStep(secret: string, step: number): string {
  const key = base32Decode(secret)
  const counter = Buffer.alloc(8)
  // The counter is 64-bit big-endian; step fits comfortably in the low 32 bits
  // for any time this century, so the high word stays zero.
  counter.writeUInt32BE(Math.floor(step / 2 ** 32), 0)
  counter.writeUInt32BE(step >>> 0, 4)
  const digest = createHmac('sha1', key).update(counter).digest()
  const view = new DataView(digest.buffer, digest.byteOffset, digest.byteLength)
  const offset = view.getUint8(digest.byteLength - 1) & 0x0f
  const binary = view.getUint32(offset) & 0x7fffffff
  return (binary % 10 ** CODE_DIGITS).toString().padStart(CODE_DIGITS, '0')
}

/** Whether two codes match, in length-safe constant time. */
function codesEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/** Time steps whose codes have been spent, so one cannot be replayed in-window. */
const usedSteps = new Map<string, number>()

/** Forget spent steps that have aged out of every acceptance window. */
function sweepUsedSteps(nowStep: number): void {
  for (const [key, step] of usedSteps) {
    if (step < nowStep - WINDOW_STEPS - 1) usedSteps.delete(key)
  }
}

/**
 * Whether an account has a second factor enrolled.
 * @param username - the account name.
 * @returns true when a TOTP secret is stored for it.
 */
export function totpEnrolled(username: string): boolean {
  return loadFile().accounts[username] !== undefined
}

/** Canonical form of a backup code, so display separators do not affect a match. */
function normaliseBackupCode(code: string): string {
  return code.toLowerCase().replace(/[^a-z0-9]/gu, '')
}

/** Hash a backup code for storage, in its canonical form. */
function hashBackupCode(code: string): string {
  const canonical = normaliseBackupCode(code)
  const salt = randomBytes(16)
  return `scrypt.${salt.toString('hex')}.${scryptSync(canonical, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS).toString('hex')}`
}

/** Verify a backup code against a stored digest in constant time. */
function backupMatches(code: string, digest: string): boolean {
  const [scheme, saltHex, hashHex] = digest.split('.')
  if (scheme !== 'scrypt' || saltHex === undefined || hashHex === undefined) return false
  const salt = Buffer.from(saltHex, 'hex')
  const expected = Buffer.from(hashHex, 'hex')
  const candidate = scryptSync(normaliseBackupCode(code), salt, SCRYPT_KEYLEN, SCRYPT_PARAMS)
  if (candidate.length !== expected.length) return false
  return timingSafeEqual(candidate, expected)
}

/**
 * Verify a presented factor for an account: a live TOTP code, or one of its
 * single-use backup codes. A matched backup code is consumed. A TOTP code is
 * accepted once per time step, so it cannot be replayed inside its window.
 * @param username - the account being verified.
 * @param presented - the code the operator entered.
 * @returns true when the factor is valid.
 */
export function verifyTotp(username: string, presented: string): boolean {
  const file = loadFile()
  const record = file.accounts[username]
  if (record === undefined) return false
  const trimmed = presented.trim().replace(/\s/gu, '')
  if (trimmed === '') return false

  const nowStep = Math.floor(Date.now() / 1000 / STEP_SECONDS)
  sweepUsedSteps(nowStep)
  for (let offset = -WINDOW_STEPS; offset <= WINDOW_STEPS; offset += 1) {
    const step = nowStep + offset
    if (codesEqual(trimmed, codeForStep(record.secret, step))) {
      const key = `${username}:${step.toString()}`
      if (usedSteps.has(key)) return false // Already spent this step.
      usedSteps.set(key, step)
      return true
    }
  }

  // Not a live code; try the single-use backup codes, consuming a match.
  const remaining = record.backupCodes.filter(digest => !backupMatches(trimmed, digest))
  if (remaining.length < record.backupCodes.length) {
    record.backupCodes = remaining
    saveFile(file)
    return true
  }
  return false
}

/** A freshly generated enrollment, not yet confirmed by the operator. */
export interface TotpEnrollment {
  /** Base32 shared secret to load into an authenticator app. */
  secret: string
  /** `otpauth://` URI carrying the same secret, for a QR or paste. */
  uri: string
}

/**
 * Generate a candidate secret for an account, without storing it. Enrollment is
 * only committed once the operator proves a code from it, so a generated-then-
 * abandoned secret never becomes a usable factor.
 * @param username - the account enrolling, named in the URI's label.
 * @param issuer - the label an authenticator shows beside the account.
 * @returns the secret and its otpauth URI.
 */
export function beginEnrollment(username: string, issuer: string): TotpEnrollment {
  // 20 random bytes → 32 base32 characters, the common secret length.
  const bytes = randomBytes(20)
  let bits = 0
  let value = 0
  const characters: string[] = []
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      characters.push(BASE32_ALPHABET.charAt((value >> bits) & 31))
    }
  }
  if (bits > 0) characters.push(BASE32_ALPHABET.charAt((value << (5 - bits)) & 31))
  const secret = characters.join('')

  const label = encodeURIComponent(`${issuer}:${username}`)
  const uri = `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}`
    + `&algorithm=SHA1&digits=${CODE_DIGITS.toString()}&period=${STEP_SECONDS.toString()}`
  return { secret, uri }
}

/**
 * Confirm and store an enrollment once the operator has proven a code from the
 * candidate secret, returning the one-time backup codes to show them once.
 * @param username - the account being enrolled.
 * @param secret - the candidate secret the code was proven against.
 * @param presented - the code the operator entered to confirm possession.
 * @returns the plaintext backup codes on success, or undefined when the code
 * did not match the secret.
 */
export function confirmEnrollment(username: string, secret: string, presented: string): string[] | undefined {
  const trimmed = presented.trim().replace(/\s/gu, '')
  const nowStep = Math.floor(Date.now() / 1000 / STEP_SECONDS)
  let proven = false
  for (let offset = -WINDOW_STEPS; offset <= WINDOW_STEPS; offset += 1) {
    if (codesEqual(trimmed, codeForStep(secret, nowStep + offset))) {
      proven = true
      break
    }
  }
  if (!proven) return undefined

  const backupCodes: string[] = []
  for (let index = 0; index < BACKUP_CODE_COUNT; index += 1) {
    // Ten hex characters, grouped, readable and easy to type from paper.
    const code = randomBytes(5).toString('hex')
    backupCodes.push(`${code.slice(0, 5)}-${code.slice(5)}`)
  }
  const file = loadFile()
  file.accounts[username] = {
    secret,
    backupCodes: backupCodes.map(code => hashBackupCode(code)),
  }
  saveFile(file)
  return backupCodes
}

/**
 * Remove an account's second factor.
 * @param username - the account to disable TOTP for.
 */
export function disableTotp(username: string): void {
  const file = loadFile()
  if (file.accounts[username] === undefined) return
  const accounts: Record<string, TotpRecord> = {}
  for (const [name, record] of Object.entries(file.accounts)) {
    if (name !== username) accounts[name] = record
  }
  saveFile({ version: 1, accounts })
}

/**
 * How many single-use backup codes an account has left.
 * @param username - the account.
 * @returns the count, or 0 when not enrolled.
 */
export function backupCodesRemaining(username: string): number {
  return loadFile().accounts[username]?.backupCodes.length ?? 0
}
