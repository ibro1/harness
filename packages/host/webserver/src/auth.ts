/**
 * Password gate for the web surface.
 *
 * This is the whole security boundary for a publicly reachable deployment: the
 * harness runs shell tools as the container user, so a bypass here is remote
 * code execution. Every rule below exists for that reason.
 *
 * Configuration is environment-only — nothing credential-shaped is ever written
 * to disk. Set `DSH_AUTH_PASSWORD_HASH` (preferred, see `deploy/hash-password.mjs`)
 * or `DSH_AUTH_PASSWORD`. With neither set, a random password is generated per
 * boot and printed once to stderr, so an unconfigured deployment is unreachable
 * rather than open on a known default.
 */

import { randomBytes, scryptSync, createHash, timingSafeEqual } from 'node:crypto'
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import type { TotpEnrollment } from './totp.ts'
import {
  backupCodesRemaining,
  beginEnrollment,
  confirmEnrollment,
  disableTotp,
  totpEnrolled,
  verifyTotp,
} from './totp.ts'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

/** scrypt parameters for password verification. Cost is per login attempt only. */
const SCRYPT_KEYLEN = 32
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 } as const

/** Maximum accepted login body. Anything larger is a probe, not a form post. */
const MAX_LOGIN_BODY_BYTES = 8 * 1024

/** Failed logins allowed from one client address inside {@link LOCKOUT_WINDOW_MS}. */
const MAX_FAILED_ATTEMPTS = 10
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000

/** Upper bound on tracked client addresses, so the limiter cannot be grown without bound. */
const MAX_TRACKED_CLIENTS = 4096

interface PasswordHash {
  salt: Buffer
  hash: Buffer
}

/** One account able to sign in. */
export interface AuthUser {
  /** Login name, unique and compared in constant time. */
  name: string
  /** Verifier for this account's password. */
  password: PasswordHash
  /** Optional address recorded for display. */
  email: string | undefined
}

interface AuthConfig {
  users: readonly AuthUser[]
  /** Optional long-lived bearer token for programmatic clients. Never the password. */
  apiToken: string | undefined
  /** Session lifetime in milliseconds. */
  sessionTtlMs: number
  /** Whether `X-Forwarded-For` / `X-Forwarded-Proto` may be believed. */
  trustProxy: boolean
  /** `auto` derives the cookie `Secure` flag from the forwarded protocol. */
  cookieSecure: 'auto' | boolean
}

let authConfig: AuthConfig | undefined

/** Hash a password with a fresh or supplied salt. */
function hashPassword(password: string, salt: Buffer = randomBytes(16)): PasswordHash {
  return { salt, hash: scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS) }
}

/**
 * Parse a `scrypt.<saltHex>.<hashHex>` digest.
 *
 * `$` is also accepted as the separator, but never emitted: Compose expands
 * `$name` inside a `.env` value, so a dollar-separated digest pasted into a
 * deployment panel arrives with both halves eaten.
 * @returns the parsed hash, or undefined when the value is not in that form.
 */
function parsePasswordHash(value: string): PasswordHash | undefined {
  const parts = value.split(value.includes('.') ? '.' : '$')
  if (parts.length !== 3 || parts[0] !== 'scrypt') return undefined
  try {
    const salt = Buffer.from(parts[1] ?? '', 'hex')
    const hash = Buffer.from(parts[2] ?? '', 'hex')
    if (salt.length === 0 || hash.length !== SCRYPT_KEYLEN) return undefined
    return { salt, hash }
  } catch {
    return undefined
  }
}

/**
 * Compare two secrets without leaking their relationship through timing. Both
 * sides are digested first so unequal lengths cannot throw or short-circuit.
 */
function secretEquals(a: string, b: string): boolean {
  const left = createHash('sha256').update(a).digest()
  const right = createHash('sha256').update(b).digest()
  return timingSafeEqual(left, right)
}

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function readBoolEnv(name: string): boolean {
  const raw = process.env[name]?.trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes'
}

/** Resolve the auth configuration once per process. */
export function getAuthConfig(): AuthConfig {
  if (authConfig !== undefined) return authConfig

  const username = process.env.DSH_AUTH_USER?.trim() || 'admin'

  let password: PasswordHash | undefined
  const configuredHash = process.env.DSH_AUTH_PASSWORD_HASH?.trim()
  if (configuredHash !== undefined && configuredHash !== '') {
    password = parsePasswordHash(configuredHash)
    if (password === undefined) {
      throw new Error(
        'webserver/auth: DSH_AUTH_PASSWORD_HASH is not a valid scrypt.<saltHex>.<hashHex> digest.'
        + ' Generate one with `node deploy/hash-password.mjs`.'
        + ' A digest that arrives truncated to "scrypt" was eaten by .env variable expansion.',
      )
    }
  } else {
    const plain = process.env.DSH_AUTH_PASSWORD
    if (plain !== undefined && plain !== '') {
      password = hashPassword(plain)
    } else {
      // Fail closed, not open: an unconfigured instance gets a password nobody
      // knows but the operator reading this line in the logs.
      const generated = randomBytes(18).toString('base64url')
      password = hashPassword(generated)
      process.stderr.write(
        '\n[dsh auth] No DSH_AUTH_PASSWORD or DSH_AUTH_PASSWORD_HASH set.\n'
        + `[dsh auth] Generated a one-time password for this process: ${generated}\n`
        + '[dsh auth] It changes on every restart. Set DSH_AUTH_PASSWORD_HASH for a real deployment.\n\n',
      )
    }
  }

  const apiTokenRaw = process.env.DSH_AUTH_API_TOKEN?.trim()
  const apiToken = apiTokenRaw !== undefined && apiTokenRaw.length >= 16 ? apiTokenRaw : undefined
  if (apiTokenRaw !== undefined && apiTokenRaw !== '' && apiToken === undefined) {
    throw new Error('webserver/auth: DSH_AUTH_API_TOKEN must be at least 16 characters')
  }

  const cookieSecureRaw = process.env.DSH_AUTH_COOKIE_SECURE?.trim().toLowerCase()
  const cookieSecure = cookieSecureRaw === undefined || cookieSecureRaw === '' || cookieSecureRaw === 'auto'
    ? 'auto' as const
    : cookieSecureRaw === '1' || cookieSecureRaw === 'true'

  authConfig = {
    users: resolveUsers(username, password),
    apiToken,
    sessionTtlMs: readIntEnv('DSH_SESSION_TTL_HOURS', 168) * 60 * 60 * 1000,
    trustProxy: readBoolEnv('DSH_TRUST_PROXY'),
    cookieSecure,
  }
  return authConfig
}

/** Where multi-account credentials live when the deployment has more than one. */
const USERS_PATH = join(dshHome(), 'users.json')

/** The Harness home this process reads its auth state from. */
function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/**
 * Accounts able to sign in.
 *
 * A `users.json` in the Harness home wins when it declares any account, so
 * multi-user deployments are managed with `deploy/user.mjs` rather than by
 * encoding several digests into one environment variable. With no such file the
 * single environment-configured account stands, which is every deployment that
 * has never asked for a second person.
 * @param envName - the environment-configured login name.
 * @param envPassword - its verifier.
 * @returns the accounts, never empty.
 */
function resolveUsers(envName: string, envPassword: PasswordHash): readonly AuthUser[] {
  let raw: string
  try {
    raw = readFileSync(USERS_PATH, 'utf8')
  } catch {
    return [{ name: envName, password: envPassword, email: undefined }]
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`webserver/auth: ${USERS_PATH} is not valid JSON; fix or remove it`)
  }
  const rows = (parsed as { users?: unknown }).users
  if (!Array.isArray(rows)) {
    throw new Error(`webserver/auth: ${USERS_PATH} has no "users" array`)
  }
  const users: AuthUser[] = []
  for (const row of rows as readonly Record<string, unknown>[]) {
    const name = typeof row['name'] === 'string' ? row['name'].trim() : ''
    const digest = typeof row['password'] === 'string' ? row['password'] : ''
    if (name === '') continue
    const password = parsePasswordHash(digest)
    if (password === undefined) {
      throw new Error(`webserver/auth: user ${JSON.stringify(name)} in ${USERS_PATH} has no valid password digest`)
    }
    users.push({ name, password, email: typeof row['email'] === 'string' ? row['email'] : undefined })
  }
  if (users.length === 0) return [{ name: envName, password: envPassword, email: undefined }]
  return users
}

/** One signed-in browser. */
export interface SessionRecord {
  /** Account that signed in. */
  user: string
  /** Epoch milliseconds the session was minted. */
  issuedAt: number
  /** Epoch milliseconds the session stops being accepted. */
  expiresAt: number
}

/** Upper bound on retained sessions, oldest evicted first. */
const MAX_SESSIONS = 500

/**
 * Sessions outlive the process: they live in the Harness home so a redeploy
 * does not sign everyone out, which on a push-to-deploy setup is every few
 * minutes. Held in memory and mirrored to disk on every change, because reads
 * happen on every request and writes only on sign-in and sign-out.
 */
const activeSessions = new Map<string, SessionRecord>()
let sessionsLoaded = false

/** Where the session mirror lives. */
function sessionsPath(): string {
  return join(dshHome(), '.sessions.json')
}

/** Read the mirror once per process, discarding anything already expired. */
function loadSessions(): void {
  if (sessionsLoaded) return
  sessionsLoaded = true
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(sessionsPath(), 'utf8'))
  } catch {
    // No mirror yet, or one this build cannot read: start empty rather than
    // refuse to serve. The cost is that everyone signs in again.
    return
  }
  const rows = (parsed as { sessions?: unknown }).sessions
  if (typeof rows !== 'object' || rows === null) return
  const now = Date.now()
  for (const [token, value] of Object.entries(rows as Record<string, unknown>)) {
    const record = value as Record<string, unknown>
    const user = typeof record['user'] === 'string' ? record['user'] : undefined
    const issuedAt = typeof record['issuedAt'] === 'number' ? record['issuedAt'] : undefined
    const expiresAt = typeof record['expiresAt'] === 'number' ? record['expiresAt'] : undefined
    if (user === undefined || issuedAt === undefined || expiresAt === undefined) continue
    if (expiresAt <= now) continue
    activeSessions.set(token, { user, issuedAt, expiresAt })
  }
}

/**
 * Mirror the live sessions to disk, replacing the file atomically so a crash
 * mid-write cannot leave a half-written mirror that reads as no sessions.
 */
function persistSessions(): void {
  const path = sessionsPath()
  const temporary = `${path}.tmp`
  const payload = JSON.stringify({ version: 1, sessions: Object.fromEntries(activeSessions) })
  try {
    mkdirSync(dshHome(), { recursive: true })
    writeFileSync(temporary, payload, { mode: 0o600 })
    renameSync(temporary, path)
  } catch {
    // A read-only or full Harness home costs persistence across restarts, not
    // the ability to sign in; the in-memory map still serves this process.
  }
}

/** Drop expired sessions, and the oldest beyond the retention cap. */
function sweepSessions(now: number): void {
  for (const [token, record] of activeSessions) {
    if (record.expiresAt <= now) activeSessions.delete(token)
  }
  if (activeSessions.size <= MAX_SESSIONS) return
  const ordered = [...activeSessions.entries()].sort((a, b) => a[1].issuedAt - b[1].issuedAt)
  for (const [token] of ordered.slice(0, activeSessions.size - MAX_SESSIONS)) {
    activeSessions.delete(token)
  }
}

/**
 * Mint a session for one account, valid for the configured TTL.
 * @param user - the account that signed in.
 * @returns the opaque session token.
 */
/** How long a proven password waits for its second factor before lapsing. */
const TOTP_PENDING_TTL_MS = 5 * 60 * 1000

/** One password proven, its second factor still owed. */
interface PendingFactor {
  user: string
  expiresAt: number
}

/** Opaque pending-factor token → the account that proved its password. */
const pendingFactors = new Map<string, PendingFactor>()

/** Drop lapsed pending-factor tokens. */
function sweepPending(now: number): void {
  for (const [token, pending] of pendingFactors) {
    if (pending.expiresAt <= now) pendingFactors.delete(token)
  }
}

/**
 * Record that an account proved its password and now owes a second factor.
 * @param user - the account name.
 * @returns an opaque token naming the pending state, carried in a cookie.
 */
function beginPendingFactor(user: string): string {
  const now = Date.now()
  sweepPending(now)
  const token = randomBytes(32).toString('hex')
  pendingFactors.set(token, { user, expiresAt: now + TOTP_PENDING_TTL_MS })
  return token
}

/**
 * Resolve a pending-factor token to its account, if still live.
 * @param token - the token from the pending-factor cookie.
 * @returns the account name, or undefined when unknown or lapsed.
 */
function pendingFactorUser(token: string | undefined): string | undefined {
  if (token === undefined) return undefined
  sweepPending(Date.now())
  return pendingFactors.get(token)?.user
}

/** Read the pending-factor cookie. */
function pendingFactorCookie(req: IncomingMessage): string | undefined {
  return parseCookies(req.headers['cookie'])['dsh_totp_pending']
}

/** Cookie carrying (or clearing, at maxAge 0) the pending-factor token. */
function pendingCookieValue(req: IncomingMessage, token: string, maxAgeSeconds: number): string {
  const attributes = [
    `dsh_totp_pending=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${String(maxAgeSeconds)}`,
  ]
  if (useSecureCookie(req)) attributes.push('Secure')
  return attributes.join('; ')
}

export function createSessionToken(user: string): string {
  loadSessions()
  const now = Date.now()
  sweepSessions(now)
  const token = randomBytes(32).toString('hex')
  activeSessions.set(token, { user, issuedAt: now, expiresAt: now + getAuthConfig().sessionTtlMs })
  persistSessions()
  return token
}

/**
 * Invalidate one session server-side, so a signed-out cookie is dead everywhere.
 * @param token - the session to drop.
 */
export function revokeSessionToken(token: string): void {
  loadSessions()
  if (activeSessions.delete(token)) persistSessions()
}

/**
 * Invalidate every session belonging to one account.
 * @param user - the account to sign out everywhere.
 * @param except - a session to keep, usually the caller's own.
 * @returns how many sessions were dropped.
 */
export function revokeUserSessions(user: string, except?: string): number {
  loadSessions()
  let dropped = 0
  for (const [token, record] of activeSessions) {
    if (record.user !== user || token === except) continue
    activeSessions.delete(token)
    dropped += 1
  }
  if (dropped > 0) persistSessions()
  return dropped
}

/**
 * Sessions currently held by one account, newest first.
 * @param user - the account to list.
 * @returns the sessions and their tokens.
 */
export function listUserSessions(user: string): readonly (SessionRecord & { token: string })[] {
  loadSessions()
  sweepSessions(Date.now())
  return [...activeSessions.entries()]
    .filter(([, record]) => record.user === user)
    .map(([token, record]) => ({ token, ...record }))
    .sort((a, b) => b.issuedAt - a.issuedAt)
}

/**
 * The account a bearer or cookie token authenticates, if any.
 *
 * A session token or the dedicated API token qualifies. The account password
 * deliberately does not: a password that doubles as a bearer token leaks login
 * through every proxy log and client history that records headers.
 * @param token - the presented token.
 * @returns the account name, or undefined when the token is not valid.
 */
export function sessionUser(token: string): string | undefined {
  if (token === '') return undefined
  loadSessions()
  const now = Date.now()
  const record = activeSessions.get(token)
  if (record !== undefined) {
    if (record.expiresAt > now) return record.user
    activeSessions.delete(token)
    persistSessions()
  }
  const { apiToken } = getAuthConfig()
  if (apiToken !== undefined && secretEquals(token, apiToken)) return API_TOKEN_USER
  return undefined
}

/** Name recorded for requests authenticated by the deployment's API token. */
const API_TOKEN_USER = 'api-token'

/**
 * Whether a bearer or cookie token is currently valid.
 * @param token - the presented token.
 * @returns true when it authenticates an account.
 */
export function isValidSessionToken(token: string): boolean {
  return sessionUser(token) !== undefined
}

/**
 * The host this request was addressed to, as the browser sees it. Behind a
 * trusted proxy the forwarded host is the real domain; the direct Host header
 * is the fallback.
 * @param req - the incoming request.
 * @returns the lower-cased host, or undefined when none is present.
 */
function requestHost(req: IncomingMessage): string | undefined {
  if (getAuthConfig().trustProxy) {
    const forwarded = req.headers['x-forwarded-host']
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim()
    if (first !== undefined && first !== '') return first.toLowerCase()
  }
  return req.headers.host?.trim().toLowerCase()
}

/**
 * Reject a state-changing POST whose `Origin` names a different site, as
 * defence in depth beside the session cookie's `SameSite=Lax`. A cross-site
 * form POST carries the attacker's Origin and is refused; a same-origin POST
 * matches and passes. A missing Origin is allowed: browsers send one on every
 * cross-origin POST, so its absence is a non-browser caller (which the session
 * cookie or API token already gates), not a forged request.
 * @param req - the incoming request.
 * @param res - the response, written with 403 when the origin is refused.
 * @returns true when the request was refused and the response is complete.
 */
function crossOriginRejected(req: IncomingMessage, res: ServerResponse): boolean {
  const origin = req.headers.origin
  if (origin === undefined || origin === '') return false
  const host = requestHost(req)
  let sameOrigin = false
  try {
    sameOrigin = host !== undefined && new URL(origin).host.toLowerCase() === host
  } catch {
    // An Origin that will not parse is attacker-controlled input, not a same
    // site request; fall through to the refusal.
  }
  if (sameOrigin) return false
  res.writeHead(403, { ...AUTH_PAGE_HEADERS, 'Connection': 'close' })
  res.end(renderLoginPage(true))
  res.on('finish', () => { req.socket.end() })
  return true
}

/**
 * Verify a username and password against the configured accounts.
 *
 * Every account's verifier is exercised regardless of whether the name matched,
 * so the response time does not reveal which names exist.
 * @param username - the presented login name.
 * @param password - the presented password.
 * @returns the matched account, or undefined.
 */
function verifyCredentials(username: string, password: string): AuthUser | undefined {
  let matched: AuthUser | undefined
  for (const user of getAuthConfig().users) {
    const candidate = scryptSync(password, user.password.salt, SCRYPT_KEYLEN, SCRYPT_PARAMS)
    const passwordOk = timingSafeEqual(candidate, user.password.hash)
    if (passwordOk && secretEquals(username, user.name)) matched = user
  }
  return matched
}

interface AttemptRecord {
  failures: number
  resetAt: number
}

const failedAttempts = new Map<string, AttemptRecord>()

/** Client address for rate limiting; the forwarded chain is read only when trusted. */
function clientAddress(req: IncomingMessage): string {
  if (getAuthConfig().trustProxy) {
    const forwarded = req.headers['x-forwarded-for']
    const chain = Array.isArray(forwarded) ? forwarded[0] : forwarded
    const first = chain?.split(',')[0]?.trim()
    if (first !== undefined && first !== '') return first
  }
  return req.socket.remoteAddress ?? 'unknown'
}

/** @returns milliseconds the caller must wait, or 0 when an attempt is allowed. */
function loginRetryAfterMs(req: IncomingMessage): number {
  const now = Date.now()
  const record = failedAttempts.get(clientAddress(req))
  if (record === undefined) return 0
  if (record.resetAt <= now) return 0
  return record.failures >= MAX_FAILED_ATTEMPTS ? record.resetAt - now : 0
}

function recordFailure(req: IncomingMessage): void {
  const now = Date.now()
  const key = clientAddress(req)
  for (const [address, record] of failedAttempts) {
    if (record.resetAt <= now) failedAttempts.delete(address)
  }
  if (failedAttempts.size >= MAX_TRACKED_CLIENTS && !failedAttempts.has(key)) return
  const record = failedAttempts.get(key)
  if (record === undefined || record.resetAt <= now) {
    failedAttempts.set(key, { failures: 1, resetAt: now + LOCKOUT_WINDOW_MS })
    return
  }
  record.failures += 1
}

function clearFailures(req: IncomingMessage): void {
  failedAttempts.delete(clientAddress(req))
}

function parseCookies(cookieHeader?: string): Record<string, string> {
  const list: Record<string, string> = {}
  if (cookieHeader === undefined) return list

  for (const cookie of cookieHeader.split(';')) {
    const [rawName, ...rest] = cookie.split('=')
    const name = rawName?.trim()
    if (name === undefined || name === '') continue
    list[name] = decodeURIComponent(rest.join('=').trim())
  }

  return list
}

/** The session token this request carries in its cookie, if any. */
function sessionCookie(req: IncomingMessage): string | undefined {
  return parseCookies(req.headers['cookie'])['dsh_session']
}

/**
 * The account a request authenticates as, by session cookie, bearer token, or
 * Basic credentials.
 * @param req - the incoming request.
 * @returns the account name, or undefined when unauthenticated.
 */
export function authenticatedUser(req: IncomingMessage): string | undefined {
  const authHeader = req.headers['authorization']
  if (authHeader !== undefined) {
    if (authHeader.startsWith('Bearer ')) {
      const user = sessionUser(authHeader.slice(7).trim())
      if (user !== undefined) return user
    } else if (authHeader.startsWith('Basic ')) {
      try {
        const decoded = Buffer.from(authHeader.slice(6).trim(), 'base64').toString('utf-8')
        const separator = decoded.indexOf(':')
        if (separator > 0) {
          const matched = verifyCredentials(decoded.slice(0, separator), decoded.slice(separator + 1))
          if (matched !== undefined) return matched.name
        }
      } catch {
        // malformed header: fall through to the cookie check
      }
    }
  }

  const token = sessionCookie(req)
  return token === undefined ? undefined : sessionUser(token)
}

/**
 * Whether a request is authenticated at all.
 * @param req - the incoming request.
 * @returns true when it carries valid credentials.
 */
export function isAuthenticated(req: IncomingMessage): boolean {
  return authenticatedUser(req) !== undefined
}

/** Whether the session cookie should carry `Secure` for this request. */
function useSecureCookie(req: IncomingMessage): boolean {
  const config = getAuthConfig()
  if (config.cookieSecure !== 'auto') return config.cookieSecure
  if (!config.trustProxy) return false
  const proto = req.headers['x-forwarded-proto']
  const first = (Array.isArray(proto) ? proto[0] : proto)?.split(',')[0]?.trim().toLowerCase()
  return first === 'https'
}

function sessionCookieValue(req: IncomingMessage, token: string, maxAgeSeconds: number): string {
  const attributes = [
    `dsh_session=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${String(maxAgeSeconds)}`,
  ]
  if (useSecureCookie(req)) attributes.push('Secure')
  return attributes.join('; ')
}

/** The login page. `error` selects the failure banner; `locked` the rate-limit banner. */
export function renderLoginPage(error?: boolean, locked?: boolean): string {
  const banner = locked === true
    ? '<div class="error-banner">⏳ Too many attempts. Try again later.</div>'
    : error === true
      ? '<div class="error-banner">⚠️ Invalid username or password</div>'
      : ''
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="referrer" content="no-referrer">
  <title>DeepSeek Harness - Authentication</title>
  <style>
    :root {
      --bg: #0d1117;
      --card-bg: #161b22;
      --border: #30363d;
      --text: #c9d1d9;
      --text-heading: #f0f6fc;
      --primary: #238636;
      --primary-hover: #2ea043;
      --error-bg: rgba(248, 81, 73, 0.15);
      --error-border: #f85149;
      --error-text: #ff7b72;
    }
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    }
    body {
      background-color: var(--bg);
      color: var(--text);
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 20px;
    }
    .login-container {
      width: 100%;
      max-width: 380px;
      background-color: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 32px 28px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.5);
    }
    .header {
      text-align: center;
      margin-bottom: 28px;
    }
    .logo {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 48px;
      height: 48px;
      background: #1f242c;
      border-radius: 12px;
      margin-bottom: 12px;
      border: 1px solid var(--border);
    }
    .logo svg {
      width: 28px;
      height: 28px;
      fill: #58a6ff;
    }
    h1 {
      font-size: 20px;
      font-weight: 600;
      color: var(--text-heading);
      margin-bottom: 6px;
    }
    p.subtitle {
      font-size: 13px;
      color: #8b949e;
    }
    .error-banner {
      background-color: var(--error-bg);
      border: 1px solid var(--error-border);
      color: var(--error-text);
      padding: 10px 14px;
      border-radius: 6px;
      font-size: 13px;
      margin-bottom: 20px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .form-group {
      margin-bottom: 18px;
    }
    label {
      display: block;
      font-size: 13px;
      font-weight: 500;
      color: var(--text-heading);
      margin-bottom: 6px;
    }
    input {
      width: 100%;
      padding: 10px 12px;
      background-color: #0d1117;
      border: 1px solid var(--border);
      border-radius: 6px;
      color: var(--text-heading);
      font-size: 14px;
      outline: none;
      transition: border-color 0.2s, box-shadow 0.2s;
    }
    input:focus {
      border-color: #58a6ff;
      box-shadow: 0 0 0 3px rgba(88, 166, 255, 0.3);
    }
    button {
      width: 100%;
      padding: 11px;
      background-color: var(--primary);
      color: #ffffff;
      border: none;
      border-radius: 6px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      margin-top: 8px;
      transition: background-color 0.2s;
    }
    button:hover {
      background-color: var(--primary-hover);
    }
    .password-field {
      position: relative;
    }
    .password-field input {
      padding-right: 46px;
    }
    .password-field button {
      position: absolute;
      top: 50%;
      right: 4px;
      transform: translateY(-50%);
      display: flex;
      align-items: center;
      justify-content: center;
      width: 34px;
      height: 34px;
      margin: 0;
      padding: 0;
      background: transparent;
      border: none;
      border-radius: 6px;
      color: #8b949e;
    }
    .password-field button:hover {
      background: #1f242c;
      color: var(--text-heading);
    }
    .footer {
      text-align: center;
      margin-top: 24px;
      font-size: 12px;
      color: #8b949e;
    }
  </style>
</head>
<body>
  <div class="login-container">
    <div class="header">
      <div class="logo">
        <svg viewBox="0 0 24 24">
          <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
        </svg>
      </div>
      <h1>DeepSeek Harness</h1>
      <p class="subtitle">Enter your credentials to access the console</p>
    </div>

    ${banner}

    <form method="POST" action="/auth/login">
      <div class="form-group">
        <label for="username">Username</label>
        <input type="text" id="username" name="username" required autofocus autocomplete="username" placeholder="admin">
      </div>
      <div class="form-group">
        <label for="password">Password</label>
        <div class="password-field">
          <input type="password" id="password" name="password" required autocomplete="current-password" placeholder="••••••••">
          <button type="button" id="reveal" aria-label="Show password" aria-pressed="false">
            <svg id="eye-open" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
            <svg id="eye-off" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:none"><path d="M9.9 4.24A9.1 9.1 0 0 1 12 4c6.5 0 10 7 10 7a17.6 17.6 0 0 1-2.2 3.1M6.6 6.6A17.7 17.7 0 0 0 2 11s3.5 7 10 7a9 9 0 0 0 5.4-1.6"/><path d="m2 2 20 20"/><path d="M14.1 14.1a3 3 0 0 1-4.2-4.2"/></svg>
          </button>
        </div>
      </div>
      <button type="submit">Sign In</button>
    </form>

    <div class="footer">
      Protected instance • Antigravity Security
    </div>
  </div>
  <script>
    (function () {
      var input = document.getElementById('password')
      var toggle = document.getElementById('reveal')
      var open = document.getElementById('eye-open')
      var off = document.getElementById('eye-off')
      toggle.addEventListener('click', function () {
        var shown = input.type === 'text'
        input.type = shown ? 'password' : 'text'
        open.style.display = shown ? '' : 'none'
        off.style.display = shown ? 'none' : ''
        toggle.setAttribute('aria-label', shown ? 'Show password' : 'Hide password')
        toggle.setAttribute('aria-pressed', shown ? 'false' : 'true')
        input.focus()
      })
    })()
  </script>
</body>
</html>`
}

/** Headers for every auth response: never cached, never framed. */
const AUTH_PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store, private',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
} as const

/** Read a bounded request body, or undefined when the cap is exceeded. */
async function readBoundedBody(req: IncomingMessage): Promise<string | undefined> {
  return await new Promise((resolve) => {
    let body = ''
    let size = 0
    let aborted = false
    req.on('data', (chunk: Buffer | string) => {
      if (aborted) return
      size += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length
      if (size > MAX_LOGIN_BODY_BYTES) {
        // Stop reading but leave the socket alive, so the caller can answer
        // 413 instead of the client seeing a bare connection reset.
        aborted = true
        req.pause()
        resolve(undefined)
        return
      }
      body += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    })
    req.on('end', () => {
      if (!aborted) resolve(body)
    })
    req.on('error', () => {
      if (!aborted) resolve(undefined)
    })
  })
}

function parseLoginBody(bodyText: string, contentType: string): { username: string; password: string } {
  if (contentType.includes('application/json')) {
    try {
      const data: unknown = JSON.parse(bodyText)
      if (typeof data === 'object' && data !== null) {
        const record = data as Record<string, unknown>
        return {
          username: typeof record['username'] === 'string' ? record['username'] : '',
          password: typeof record['password'] === 'string' ? record['password'] : '',
        }
      }
    } catch {
      // fall through to an empty credential pair, which fails verification
    }
    return { username: '', password: '' }
  }
  const params = new URLSearchParams(bodyText)
  return { username: params.get('username') ?? '', password: params.get('password') ?? '' }
}

/**
 * Serve `/auth/login` and `/auth/logout`.
 * @param req - incoming request.
 * @param res - response owned when this returns true.
 * @param rawPath - request pathname.
 * @param resolveSignedInTarget - where a successful sign-in lands. Supplied by
 * the host so a second browser gate mounted in this process can be cleared in
 * the same redirect; defaults to `/`.
 * @returns true when the request was handled here and must not be routed further.
 */
export function handleAuthRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  rawPath: string,
  resolveSignedInTarget?: () => string,
): boolean {
  if (rawPath === '/auth/login') {
    if (req.method === 'GET') {
      const url = new URL(req.url ?? '/', 'http://x')
      res.writeHead(200, AUTH_PAGE_HEADERS)
      res.end(renderLoginPage(url.searchParams.get('error') === '1', url.searchParams.get('locked') === '1'))
      return true
    }

    if (req.method === 'POST') {
      if (crossOriginRejected(req, res)) return true
      const retryAfterMs = loginRetryAfterMs(req)
      if (retryAfterMs > 0) {
        res.writeHead(429, {
          ...AUTH_PAGE_HEADERS,
          'Retry-After': String(Math.ceil(retryAfterMs / 1000)),
        })
        res.end(renderLoginPage(false, true))
        return true
      }

      void readBoundedBody(req).then((bodyText) => {
        if (res.writableEnded) return
        if (bodyText === undefined) {
          recordFailure(req)
          res.writeHead(413, { ...AUTH_PAGE_HEADERS, 'Connection': 'close' })
          res.end(renderLoginPage(true))
          // The unread remainder of the body would otherwise be parsed as the
          // next pipelined request on this connection.
          res.on('finish', () => { req.socket.end() })
          return
        }

        const { username, password } = parseLoginBody(bodyText, req.headers['content-type'] ?? '')
        const matched = verifyCredentials(username, password)
        if (matched === undefined) {
          recordFailure(req)
          res.writeHead(302, { 'Location': '/auth/login?error=1', 'Cache-Control': 'no-store' })
          res.end()
          return
        }

        clearFailures(req)
        if (totpEnrolled(matched.name)) {
          // Password proven, but this account owes a second factor: hold a
          // short-lived pending state and ask for the code, minting no session
          // yet.
          const pending = beginPendingFactor(matched.name)
          res.writeHead(302, {
            'Set-Cookie': pendingCookieValue(req, pending, Math.ceil(TOTP_PENDING_TTL_MS / 1000)),
            'Location': '/auth/totp-verify',
            'Cache-Control': 'no-store',
          })
          res.end()
          return
        }
        const token = createSessionToken(matched.name)
        res.writeHead(302, {
          'Set-Cookie': sessionCookieValue(req, token, Math.floor(getAuthConfig().sessionTtlMs / 1000)),
          'Location': resolveSignedInTarget?.() ?? '/',
          'Cache-Control': 'no-store',
        })
        res.end()
      })
      return true
    }
  }

  if (rawPath === '/auth/sessions') {
    const viewer = authenticatedUser(req)
    if (viewer === undefined) {
      res.writeHead(302, { 'Location': '/auth/login', 'Cache-Control': 'no-store' })
      res.end()
      return true
    }
    const current = sessionCookie(req)
    if (req.method === 'POST') {
      if (crossOriginRejected(req, res)) return true
      void readBoundedBody(req).then((bodyText) => {
        if (res.writableEnded) return
        const params = new URLSearchParams(bodyText ?? '')
        // Only ever the viewer's own sessions: an account cannot reach another
        // account's, whatever token it names.
        const target = params.get('revoke')
        if (params.get('revokeOthers') === '1') {
          revokeUserSessions(viewer, current)
        } else if (target !== null && listUserSessions(viewer).some(row => row.token === target)) {
          revokeSessionToken(target)
        }
        res.writeHead(302, { 'Location': '/auth/sessions', 'Cache-Control': 'no-store' })
        res.end()
      })
      return true
    }
    res.writeHead(200, AUTH_PAGE_HEADERS)
    res.end(renderSessionsPage(viewer, listUserSessions(viewer), current))
    return true
  }

  if (rawPath === '/auth/git-key') {
    // Sits behind the gate like every other page: the public half is not a
    // secret, but which forge this instance can reach should not be.
    if (!isAuthenticated(req)) {
      res.writeHead(302, { 'Location': '/auth/login', 'Cache-Control': 'no-store' })
      res.end()
      return true
    }
    const keyPath = process.env.DSH_GIT_KEY_PATH
      ?? join(homedir(), '.dsh', 'ssh', 'id_ed25519.pub')
    let key: string | undefined
    try {
      key = readFileSync(keyPath, 'utf8').trim()
    } catch {
      // No identity generated yet; the page says so rather than 500ing.
    }
    res.writeHead(200, AUTH_PAGE_HEADERS)
    res.end(renderGitKeyPage(key))
    return true
  }

  // The second-factor code-entry step, reached only with a live pending-factor
  // cookie set when a password proved but its TOTP was still owed.
  if (rawPath === '/auth/totp-verify') {
    const pendingToken = pendingFactorCookie(req)
    const pendingUser = pendingFactorUser(pendingToken)
    if (pendingUser === undefined) {
      // No pending factor: nothing to verify, so start over at the password.
      res.writeHead(302, { 'Location': '/auth/login', 'Cache-Control': 'no-store' })
      res.end()
      return true
    }
    if (req.method === 'POST') {
      if (crossOriginRejected(req, res)) return true
      const retryAfterMs = loginRetryAfterMs(req)
      if (retryAfterMs > 0) {
        res.writeHead(429, { ...AUTH_PAGE_HEADERS, 'Retry-After': String(Math.ceil(retryAfterMs / 1000)) })
        res.end(renderTotpVerifyPage(true))
        return true
      }
      void readBoundedBody(req).then((bodyText) => {
        if (res.writableEnded) return
        const code = new URLSearchParams(bodyText ?? '').get('code') ?? ''
        if (!verifyTotp(pendingUser, code)) {
          recordFailure(req)
          res.writeHead(302, { 'Location': '/auth/totp-verify?error=1', 'Cache-Control': 'no-store' })
          res.end()
          return
        }
        clearFailures(req)
        pendingFactors.delete(pendingToken as string)
        const token = createSessionToken(pendingUser)
        res.writeHead(302, {
          'Set-Cookie': [
            sessionCookieValue(req, token, Math.floor(getAuthConfig().sessionTtlMs / 1000)),
            pendingCookieValue(req, '', 0),
          ],
          'Location': resolveSignedInTarget?.() ?? '/',
          'Cache-Control': 'no-store',
        })
        res.end()
      })
      return true
    }
    const url = new URL(req.url ?? '/', 'http://x')
    res.writeHead(200, AUTH_PAGE_HEADERS)
    res.end(renderTotpVerifyPage(url.searchParams.get('error') === '1'))
    return true
  }

  // Enrollment and management, behind the gate like every other account page.
  if (rawPath === '/auth/totp') {
    const viewer = authenticatedUser(req)
    if (viewer === undefined) {
      res.writeHead(302, { 'Location': '/auth/login', 'Cache-Control': 'no-store' })
      res.end()
      return true
    }
    if (req.method === 'POST') {
      if (crossOriginRejected(req, res)) return true
      void readBoundedBody(req).then((bodyText) => {
        if (res.writableEnded) return
        const params = new URLSearchParams(bodyText ?? '')
        const action = params.get('action')
        if (action === 'enroll') {
          // Confirm the candidate secret carried through the form by proving a
          // code from it, then show the backup codes once.
          const secret = params.get('secret') ?? ''
          const codes = confirmEnrollment(viewer, secret, params.get('code') ?? '')
          if (codes === undefined) {
            const again = beginEnrollment(viewer, totpIssuer(req))
            res.writeHead(200, AUTH_PAGE_HEADERS)
            res.end(renderTotpEnrollPage(again, true))
            return
          }
          res.writeHead(200, AUTH_PAGE_HEADERS)
          res.end(renderTotpBackupPage(codes))
          return
        }
        if (action === 'disable' && totpEnrolled(viewer)) {
          // Disabling a factor is sensitive: require a current code or backup
          // code to prove the operator, not just a live session.
          if (!verifyTotp(viewer, params.get('code') ?? '')) {
            res.writeHead(200, AUTH_PAGE_HEADERS)
            res.end(renderTotpManagePage(viewer, true))
            return
          }
          disableTotp(viewer)
        }
        res.writeHead(302, { 'Location': '/auth/totp', 'Cache-Control': 'no-store' })
        res.end()
      })
      return true
    }
    res.writeHead(200, AUTH_PAGE_HEADERS)
    if (totpEnrolled(viewer)) {
      res.end(renderTotpManagePage(viewer, false))
    } else {
      res.end(renderTotpEnrollPage(beginEnrollment(viewer, totpIssuer(req)), false))
    }
    return true
  }

  if (rawPath === '/auth/logout') {
    const token = sessionCookie(req)
    if (token !== undefined) revokeSessionToken(token)
    res.writeHead(302, {
      'Set-Cookie': sessionCookieValue(req, '', 0),
      'Location': '/auth/login',
      'Cache-Control': 'no-store',
    })
    res.end()
    return true
  }

  return false
}

/**
 * Page showing this instance's git SSH public key, for pasting into a forge as
 * a deploy key (one repository) or an account key (every repository).
 * @param key - the public key line, or undefined when none has been generated.
 * @returns the rendered HTML.
 */
/** Escape text for safe interpolation into HTML. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** The issuer label an authenticator shows, taken from the request host. */
function totpIssuer(req: IncomingMessage): string {
  return requestHost(req) ?? 'DeepSeek Harness'
}

/** Shared head + card styling for the second-factor pages. */
function totpPageShell(title: string, inner: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="referrer" content="no-referrer">
  <title>DeepSeek Harness - ${escapeHtml(title)}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
    body { background: #0d1117; color: #c9d1d9; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 20px; }
    .card { width: 100%; max-width: 440px; background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 32px 28px; box-shadow: 0 8px 24px rgba(0,0,0,0.5); }
    h1 { color: #f0f6fc; font-size: 20px; margin-bottom: 8px; }
    p { font-size: 14px; line-height: 1.5; margin-bottom: 16px; }
    label { display: block; font-size: 13px; color: #8b949e; margin: 16px 0 6px; }
    input[type=text] { width: 100%; padding: 10px 12px; background: #0d1117; border: 1px solid #30363d; border-radius: 8px; color: #c9d1d9; font-size: 18px; letter-spacing: 3px; text-align: center; }
    button { width: 100%; padding: 11px; margin-top: 20px; background: #238636; border: none; border-radius: 8px; color: #fff; font-size: 15px; cursor: pointer; }
    button:hover { background: #2ea043; }
    button.secondary { background: transparent; border: 1px solid #30363d; color: #c9d1d9; }
    .error { background: rgba(248,81,73,0.15); border: 1px solid #f85149; color: #ff7b72; padding: 10px 12px; border-radius: 8px; font-size: 13px; margin-bottom: 16px; }
    .secret { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #0d1117; border: 1px solid #30363d; border-radius: 8px; padding: 12px; word-break: break-all; font-size: 13px; color: #f0f6fc; }
    .codes { list-style: none; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #0d1117; border: 1px solid #30363d; border-radius: 8px; padding: 16px; columns: 2; }
    .codes li { padding: 4px 0; font-size: 14px; color: #f0f6fc; }
    a.link { color: #58a6ff; text-decoration: none; font-size: 13px; }
    .muted { color: #8b949e; font-size: 12px; }
  </style>
</head>
<body>
  <div class="card">
${inner}
  </div>
</body>
</html>`
}

/**
 * The code-entry page shown after a password succeeds for an enrolled account.
 * @param error - true to show the wrong-code banner.
 * @returns the rendered HTML.
 */
export function renderTotpVerifyPage(error?: boolean): string {
  const banner = error === true ? '<div class="error">Incorrect code. Try again.</div>' : ''
  return totpPageShell('Two-factor', `    <h1>Two-factor authentication</h1>
    <p>Enter the current code from your authenticator app, or one of your backup codes.</p>
    ${banner}
    <form method="POST" action="/auth/totp-verify">
      <label for="code">Authentication code</label>
      <input type="text" id="code" name="code" inputmode="text" autocomplete="one-time-code" autofocus>
      <button type="submit">Verify</button>
    </form>`)
}

/**
 * The enrollment page: a candidate secret carried through the form, confirmed
 * by a code the operator proves from it.
 * @param enrollment - the candidate secret and its otpauth URI.
 * @param error - true to show the wrong-code banner.
 * @returns the rendered HTML.
 */
export function renderTotpEnrollPage(enrollment: TotpEnrollment, error?: boolean): string {
  const banner = error === true ? '<div class="error">That code did not match the secret. Re-scan and try again.</div>' : ''
  return totpPageShell('Enable two-factor', `    <h1>Enable two-factor authentication</h1>
    <p>Scan this secret into an authenticator app (Google Authenticator, Authy, 1Password), then enter the code it shows to confirm.</p>
    ${banner}
    <label>Secret</label>
    <div class="secret">${escapeHtml(enrollment.secret)}</div>
    <p class="muted" style="margin-top:8px">Or open this link on the device with your authenticator: <a class="link" href="${escapeHtml(enrollment.uri)}">otpauth://…</a></p>
    <form method="POST" action="/auth/totp">
      <input type="hidden" name="action" value="enroll">
      <input type="hidden" name="secret" value="${escapeHtml(enrollment.secret)}">
      <label for="code">Code from your app</label>
      <input type="text" id="code" name="code" inputmode="numeric" autocomplete="one-time-code" autofocus>
      <button type="submit">Confirm and enable</button>
    </form>
    <p style="margin-top:16px"><a class="link" href="/">Cancel</a></p>`)
}

/**
 * Show the one-time backup codes once, immediately after enrollment.
 * @param codes - the plaintext backup codes, shown here and never again.
 * @returns the rendered HTML.
 */
export function renderTotpBackupPage(codes: readonly string[]): string {
  const items = codes.map(code => `<li>${escapeHtml(code)}</li>`).join('')
  return totpPageShell('Backup codes', `    <h1>Two-factor is on. Save your backup codes.</h1>
    <p>Each code works once, if you lose your authenticator. They are shown only now — store them somewhere safe.</p>
    <ul class="codes">${items}</ul>
    <a href="/auth/totp"><button class="secondary">I have saved them</button></a>`)
}

/**
 * The management page for an account that already has a second factor.
 * @param viewer - the signed-in account.
 * @param error - true to show the wrong-code banner from a failed disable.
 * @returns the rendered HTML.
 */
export function renderTotpManagePage(viewer: string, error?: boolean): string {
  const banner = error === true ? '<div class="error">Incorrect code; two-factor is still enabled.</div>' : ''
  const remaining = backupCodesRemaining(viewer)
  return totpPageShell('Two-factor', `    <h1>Two-factor authentication is enabled</h1>
    <p>Signed in as <strong>${escapeHtml(viewer)}</strong>. ${remaining.toString()} backup code${remaining === 1 ? '' : 's'} remaining.</p>
    ${banner}
    <p class="muted">To turn it off, prove a current code or a backup code.</p>
    <form method="POST" action="/auth/totp">
      <input type="hidden" name="action" value="disable">
      <label for="code">Authentication code</label>
      <input type="text" id="code" name="code" inputmode="text" autocomplete="one-time-code">
      <button type="submit" class="secondary">Disable two-factor</button>
    </form>
    <p style="margin-top:16px"><a class="link" href="/">Back</a></p>`)
}

export function renderGitKeyPage(key: string | undefined): string {
  const body = key === undefined
    ? '<p class="empty">No SSH identity has been generated yet. It is created on the next container start.</p>'
    : `<pre id="key">${key.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>`
      + '<button type="button" id="copy">Copy</button>'
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="referrer" content="no-referrer">
  <title>Git access key</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
    body { background: #0d1117; color: #c9d1d9; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 20px; }
    .card { width: 100%; max-width: 640px; background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 28px; }
    h1 { font-size: 18px; color: #f0f6fc; margin-bottom: 6px; }
    p.sub { font-size: 13px; color: #8b949e; margin-bottom: 20px; }
    pre { background: #0d1117; border: 1px solid #30363d; border-radius: 6px; padding: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: #f0f6fc; white-space: pre-wrap; word-break: break-all; }
    button { margin-top: 12px; padding: 8px 14px; background: #238636; color: #fff; border: none; border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer; }
    button:hover { background: #2ea043; }
    ol { margin: 22px 0 0 18px; font-size: 13px; color: #8b949e; line-height: 1.7; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: #c9d1d9; }
    .empty { font-size: 13px; color: #8b949e; }
    a.back { display: inline-block; margin-top: 22px; font-size: 13px; color: #58a6ff; text-decoration: none; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Git access key</h1>
    <p class="sub">This instance authenticates to your forge with this key. The private half never leaves the server.</p>
    ${body}
    <ol>
      <li><strong>One repository:</strong> its Settings &rarr; Deploy keys &rarr; Add, paste, and tick write access if agents should push.</li>
      <li><strong>Every repository:</strong> your account Settings &rarr; SSH and GPG keys &rarr; New SSH key.</li>
      <li>Clone with the SSH form, <code>git@github.com:owner/repo.git</code>, not <code>https://</code>.</li>
      <li>Revoke by deleting the key on the forge; nothing here needs changing.</li>
    </ol>
    <a class="back" href="/">&larr; Back to the harness</a>
  </div>
  <script>
    var button = document.getElementById('copy')
    if (button) button.addEventListener('click', function () {
      navigator.clipboard.writeText(document.getElementById('key').textContent).then(function () {
        button.textContent = 'Copied'
        setTimeout(function () { button.textContent = 'Copy' }, 1500)
      })
    })
  </script>
</body>
</html>`
}

/** Render one timestamp for the sessions table. */
function formatMoment(value: number): string {
  return new Date(value).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
}

/**
 * Page listing the signed-in account's own sessions, with revocation.
 * @param viewer - the signed-in account.
 * @param sessions - that account's live sessions, newest first.
 * @param current - the viewer's own session token, marked in the list.
 * @returns the rendered HTML.
 */
export function renderSessionsPage(
  viewer: string,
  sessions: readonly (SessionRecord & { token: string })[],
  current: string | undefined,
): string {
  const rows = sessions.map((row) => {
    const isCurrent = row.token === current
    return `<tr>
      <td>${formatMoment(row.issuedAt)}${isCurrent ? ' <span class="tag">this browser</span>' : ''}</td>
      <td>${formatMoment(row.expiresAt)}</td>
      <td class="right">${isCurrent
        ? '<span class="muted">—</span>'
        : `<form method="POST" action="/auth/sessions"><input type="hidden" name="revoke" value="${row.token}"><button type="submit" class="link">Revoke</button></form>`}</td>
    </tr>`
  }).join('')
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="referrer" content="no-referrer">
  <title>Sessions</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
    body { background: #0d1117; color: #c9d1d9; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 20px; }
    .card { width: 100%; max-width: 680px; background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 28px; }
    h1 { font-size: 18px; color: #f0f6fc; margin-bottom: 6px; }
    p.sub { font-size: 13px; color: #8b949e; margin-bottom: 20px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { text-align: left; font-weight: 500; color: #8b949e; padding: 8px 6px; border-bottom: 1px solid #30363d; }
    td { padding: 10px 6px; border-bottom: 1px solid #21262d; }
    td.right, th.right { text-align: right; }
    .tag { font-size: 11px; color: #3fb950; border: 1px solid #238636; border-radius: 999px; padding: 1px 7px; margin-left: 6px; }
    .muted { color: #6e7681; }
    button.link { background: none; border: none; color: #f85149; font-size: 13px; cursor: pointer; padding: 0; width: auto; }
    button.link:hover { text-decoration: underline; }
    form.all { margin-top: 20px; }
    form.all button { padding: 8px 14px; background: #21262d; color: #c9d1d9; border: 1px solid #30363d; border-radius: 6px; font-size: 13px; cursor: pointer; }
    form.all button:hover { border-color: #8b949e; color: #f0f6fc; }
    a.back { display: inline-block; margin-top: 20px; font-size: 13px; color: #58a6ff; text-decoration: none; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Sessions</h1>
    <p class="sub">Signed in as <strong>${viewer.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</strong>. Sessions survive a redeploy; revoking one ends it everywhere immediately.</p>
    <p class="sub"><a href="/auth/totp" style="color:#58a6ff;text-decoration:none">Two-factor authentication →</a></p>
    <table>
      <thead><tr><th>Signed in</th><th>Expires</th><th class="right">&nbsp;</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${sessions.length > 1
      ? '<form class="all" method="POST" action="/auth/sessions"><input type="hidden" name="revokeOthers" value="1"><button type="submit">Sign out every other browser</button></form>'
      : ''}
    <a class="back" href="/">&larr; Back to the harness</a>
  </div>
</body>
</html>`
}
