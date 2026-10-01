/**
 * Google OAuth 2.0 for one operator's server: the authorization-code flow with
 * PKCE, offline access, and a refresh-token-backed access token cache. Written
 * against Google's documented endpoints with plain `fetch`, without
 * google-auth-library.
 */

import { createHash, randomBytes } from 'node:crypto'

/** Scopes the employee asks for: Keyword Planner (Ads) and Search Console, including sitemap submission. */
export const GOOGLE_SCOPES = ['https://www.googleapis.com/auth/adwords', 'https://www.googleapis.com/auth/webmasters'] as const

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
/** Access tokens are refreshed this long before Google says they expire. */
const EXPIRY_MARGIN_MS = 60_000
const TOKEN_TIMEOUT_MS = 20_000

/** Why a Google call cannot proceed without the owner's action. */
export type GoogleAuthErrorCode = 'reconnect' | 'no-refresh-token' | 'token-endpoint'

/** A Google sign-in failure; `code` says what the owner has to do. */
export class GoogleAuthError extends Error {
  /** `reconnect`: press Connect Google again; `no-refresh-token`: revoke access, then connect; `token-endpoint`: Google refused. */
  readonly code: GoogleAuthErrorCode

  /**
   * @param code - what the owner has to do.
   * @param message - the owner-facing explanation.
   */
  constructor(code: GoogleAuthErrorCode, message: string) {
    super(message)
    this.name = 'GoogleAuthError'
    this.code = code
  }
}

/** The OAuth client the operator registered in Google Cloud. */
export interface GoogleClient {
  clientId: string
  clientSecret: string
}

/** What the code exchange returns. */
export interface GoogleGrant {
  refreshToken: string
  accessToken: string
  /** Epoch milliseconds when `accessToken` expires. */
  expiresAt: number
  /** Space-separated scopes Google granted. */
  scope: string
}

function base64url(bytes: Buffer): string {
  return bytes.toString('base64url')
}

/**
 * Make a PKCE verifier and its S256 challenge.
 * @returns the verifier to keep on the server and the challenge to put in the authorization URL.
 */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(48))
  return { verifier, challenge: base64url(createHash('sha256').update(verifier).digest()) }
}

/**
 * Make an unguessable OAuth `state` value.
 * @returns 32 random bytes, base64url-encoded.
 */
export function randomState(): string {
  return base64url(randomBytes(32))
}

/**
 * Build the consent URL the owner opens to connect Google.
 * @param params - the OAuth client id, the registered redirect URI, the `state` to check on return, and the PKCE challenge.
 * @returns the URL; offline access with a forced consent screen so Google returns a refresh token.
 */
export function authorizationUrl(params: { clientId: string; redirectUri: string; state: string; codeChallenge: string }): string {
  const url = new URL(AUTH_ENDPOINT)
  url.search = new URLSearchParams({
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state: params.state,
    code_challenge: params.codeChallenge,
    code_challenge_method: 'S256',
  }).toString()
  return url.toString()
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const body = await response.text()
  try {
    return record(JSON.parse(body))
  } catch (error) {
    // A non-JSON body (an HTML error page) carries no OAuth error fields; the status code still describes the failure.
    void error
    return {}
  }
}

/** Post a form to the token endpoint; refusals carry Google's `error` code and description, never the request's secrets. */
async function tokenRequest(fetcher: typeof fetch, form: Record<string, string>, signal: AbortSignal): Promise<Record<string, unknown>> {
  const response = await fetcher(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.any([signal, AbortSignal.timeout(TOKEN_TIMEOUT_MS)]),
  })
  const body = await readJson(response)
  if (response.ok) return body
  const error = text(body['error'])
  const description = text(body['error_description'])
  if (error === 'invalid_grant' && form['grant_type'] === 'refresh_token') {
    throw new GoogleAuthError('reconnect', 'Google no longer accepts the saved sign-in (invalid_grant). Press Connect Google again. '
      + 'If the OAuth consent screen is still in "Testing", Google expires its tokens after 7 days; publish the app to stop that.')
  }
  const detail = [error, description].filter(Boolean).join(': ')
  const suffix = detail === '' ? '' : ` (${detail})`
  throw new GoogleAuthError('token-endpoint', `Google's token endpoint answered HTTP ${String(response.status)}${suffix}.`)
}

function expiry(body: Record<string, unknown>, now: number): number {
  const seconds = typeof body['expires_in'] === 'number' ? body['expires_in'] : Number(text(body['expires_in']) || 3600)
  return now + seconds * 1000
}

/**
 * Exchange the authorization code from the redirect for tokens.
 * @param fetcher - HTTP.
 * @param params - the OAuth client, the `code` query parameter, the same redirect URI, and the PKCE verifier.
 * @param signal - cancels the call.
 * @param now - clock in epoch milliseconds.
 * @returns the refresh token to store and the first access token.
 * @throws GoogleAuthError with code `no-refresh-token` when Google returns no refresh token.
 */
export async function exchangeCode(
  fetcher: typeof fetch,
  params: GoogleClient & { code: string; redirectUri: string; codeVerifier: string },
  signal: AbortSignal,
  now: () => number = Date.now,
): Promise<GoogleGrant> {
  const body = await tokenRequest(fetcher, {
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: params.clientId,
    client_secret: params.clientSecret,
    code_verifier: params.codeVerifier,
  }, signal)
  const refreshToken = text(body['refresh_token'])
  if (refreshToken === '') {
    throw new GoogleAuthError('no-refresh-token', 'Google signed in but returned no refresh token, '
      + 'so the connection would stop working within the hour. '
      + 'Remove this app\'s access at https://myaccount.google.com/permissions, then press Connect Google again.')
  }
  return { refreshToken, accessToken: text(body['access_token']), expiresAt: expiry(body, now()), scope: text(body['scope']) }
}

/**
 * Hands out access tokens from a stored refresh token. A token is reused until
 * one minute before it expires; concurrent callers share one refresh.
 */
export class GoogleTokens {
  private cached: { token: string; expiresAt: number } | undefined
  private pending: Promise<string> | undefined

  /**
   * @param fetcher - HTTP.
   * @param credentials - reads the OAuth client and refresh token at refresh time, so a reconnect takes effect without a restart.
   * @param now - clock in epoch milliseconds.
   */
  constructor(
    private readonly fetcher: typeof fetch,
    private readonly credentials: () => GoogleClient & { refreshToken: string },
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * A valid access token.
   * @param signal - cancels a refresh this call starts.
   * @returns the bearer token.
   * @throws GoogleAuthError with code `reconnect` when Google rejects the refresh token.
   */
  async accessToken(signal: AbortSignal): Promise<string> {
    if (this.cached !== undefined && this.now() < this.cached.expiresAt - EXPIRY_MARGIN_MS) return this.cached.token
    this.pending ??= this.refresh(signal).finally(() => {
      this.pending = undefined
    })
    return this.pending
  }

  /** Drop the cached token, for example after a reconnect stored a new refresh token. */
  clear(): void {
    this.cached = undefined
  }

  private async refresh(signal: AbortSignal): Promise<string> {
    const { clientId, clientSecret, refreshToken } = this.credentials()
    if (refreshToken === '') throw new GoogleAuthError('reconnect', 'Google is not connected. Press Connect Google.')
    const body = await tokenRequest(this.fetcher, {
      grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret,
    }, signal)
    const token = text(body['access_token'])
    if (token === '') throw new GoogleAuthError('token-endpoint', 'Google\'s token endpoint returned no access token.')
    this.cached = { token, expiresAt: expiry(body, this.now()) }
    return token
  }
}
