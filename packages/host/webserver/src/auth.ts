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

interface AuthConfig {
  username: string
  password: PasswordHash
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
    username,
    password,
    apiToken,
    sessionTtlMs: readIntEnv('DSH_SESSION_TTL_HOURS', 168) * 60 * 60 * 1000,
    trustProxy: readBoolEnv('DSH_TRUST_PROXY'),
    cookieSecure,
  }
  return authConfig
}

/** Live sessions, keyed by opaque token, with an absolute expiry. */
const activeSessions = new Map<string, number>()

/** Drop expired sessions. Called on every session read; the map stays small. */
function sweepSessions(now: number): void {
  for (const [token, expiresAt] of activeSessions) {
    if (expiresAt <= now) activeSessions.delete(token)
  }
}

/** Mint a session token valid for the configured TTL. */
export function createSessionToken(): string {
  const now = Date.now()
  sweepSessions(now)
  const token = randomBytes(32).toString('hex')
  activeSessions.set(token, now + getAuthConfig().sessionTtlMs)
  return token
}

/** Invalidate one session server-side, so a logged-out cookie is dead everywhere. */
export function revokeSessionToken(token: string): void {
  activeSessions.delete(token)
}

/**
 * Whether a bearer/cookie token is currently valid.
 *
 * A session token or the dedicated API token qualifies. The account password
 * deliberately does not: a password that doubles as a bearer token leaks login
 * through every proxy log and client history that records headers.
 */
export function isValidSessionToken(token: string): boolean {
  if (token === '') return false
  const now = Date.now()
  const expiresAt = activeSessions.get(token)
  if (expiresAt !== undefined) {
    if (expiresAt > now) return true
    activeSessions.delete(token)
  }
  const { apiToken } = getAuthConfig()
  return apiToken !== undefined && secretEquals(token, apiToken)
}

/** Verify a username/password pair in constant time with respect to the password. */
function verifyCredentials(username: string, password: string): boolean {
  const config = getAuthConfig()
  const candidate = scryptSync(password, config.password.salt, SCRYPT_KEYLEN, SCRYPT_PARAMS)
  const passwordOk = timingSafeEqual(candidate, config.password.hash)
  const userOk = secretEquals(username, config.username)
  return passwordOk && userOk
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

/** Whether a request is authenticated by session cookie, bearer token, or Basic credentials. */
export function isAuthenticated(req: IncomingMessage): boolean {
  const authHeader = req.headers['authorization']
  if (authHeader !== undefined) {
    if (authHeader.startsWith('Bearer ')) {
      if (isValidSessionToken(authHeader.slice(7).trim())) return true
    } else if (authHeader.startsWith('Basic ')) {
      try {
        const decoded = Buffer.from(authHeader.slice(6).trim(), 'base64').toString('utf-8')
        const separator = decoded.indexOf(':')
        if (separator > 0 && verifyCredentials(decoded.slice(0, separator), decoded.slice(separator + 1))) {
          return true
        }
      } catch {
        // malformed header: fall through to the cookie check
      }
    }
  }

  const token = sessionCookie(req)
  return token !== undefined && isValidSessionToken(token)
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
      padding-right: 68px;
    }
    .password-field button {
      position: absolute;
      top: 50%;
      right: 6px;
      transform: translateY(-50%);
      width: auto;
      margin: 0;
      padding: 5px 10px;
      background: transparent;
      border: 1px solid var(--border);
      border-radius: 5px;
      color: #8b949e;
      font-size: 12px;
      font-weight: 500;
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
          <button type="button" id="reveal" aria-label="Show password" aria-pressed="false">Show</button>
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
      toggle.addEventListener('click', function () {
        var shown = input.type === 'text'
        input.type = shown ? 'password' : 'text'
        toggle.textContent = shown ? 'Show' : 'Hide'
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
        if (!verifyCredentials(username, password)) {
          recordFailure(req)
          res.writeHead(302, { 'Location': '/auth/login?error=1', 'Cache-Control': 'no-store' })
          res.end()
          return
        }

        clearFailures(req)
        const token = createSessionToken()
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
