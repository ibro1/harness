/**
 * The OAuth 2.0 leg of the YouTube provider: the consent page a human opens,
 * the code that comes back from it, and the two token grants — one exchange
 * that yields the durable refresh token, one refresh that mints the hour-long
 * access token every API call carries.
 *
 * Google's web-server flow only issues a refresh token when the consent page is
 * asked for one: `access_type=offline` requests offline access, and
 * `prompt=consent` re-shows the consent screen so a second sign-in for an
 * account that already approved this application still comes back with one.
 * Without both, the exchange returns an access token alone and the credential
 * cannot renew itself.
 *
 * @module @deepseek-ai/dsh-social-youtube/oauth
 */

import { googleFailure } from './errors.ts'
import type { MintedToken } from './types.ts'

/** Upload scope: the only one `videos.insert` accepts, and a sensitive scope Google verifies. */
export const UPLOAD_SCOPE = 'https://www.googleapis.com/auth/youtube.upload'

/** Read scope, for `channels.list?mine=true` — the upload scope alone cannot name the channel. */
export const READONLY_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly'

/** The scopes this provider requests, in the order they are sent. */
export const SCOPES = [UPLOAD_SCOPE, READONLY_SCOPE] as const

/** Seconds of an access token's life kept in hand, so a call never starts on a token about to lapse. */
const EXPIRY_MARGIN_MS = 60_000

/** Everything the OAuth leg needs from configuration and the credential seam. */
export interface OAuthSettings {
  /** The Google Cloud OAuth client id (a Web application client). */
  clientId: string
  /** That client's secret. */
  clientSecret: string
  /** A redirect URI registered on the client, sent byte-for-byte identically in both legs. */
  redirectUri: string
  /** Origin of `accounts.google.com`, overridable so a test or a proxy can stand in. */
  authBaseUrl: string
  /** Origin of `oauth2.googleapis.com`, overridable on the same terms. */
  tokenBaseUrl: string
  /** How long one HTTP call may take before it is abandoned. */
  timeoutMs: number
}

/** What a completed authorization-code exchange produced. */
export interface ExchangedGrant {
  /** The durable token this provider stores; absent when Google issued none. */
  refreshToken?: string
  /** The access token that came with it, usable at once. */
  access: MintedToken
  /** The scopes Google actually granted. */
  scopes: readonly string[]
}

/** Google's token responses, as far as this module reads them. */
interface TokenResponse {
  access_token?: string
  expires_in?: number
  refresh_token?: string
  scope?: string
  token_type?: string
}

/**
 * Build the consent page a human opens to authorize this application.
 * @param settings - client id, redirect URI, and the authorization origin.
 * @param state - opaque value Google echoes back on the redirect, checked against the pasted result.
 * @returns the absolute authorization URL.
 */
export function authorizationUrl(settings: OAuthSettings, state: string): string {
  const url = new URL('/o/oauth2/v2/auth', settings.authBaseUrl)
  url.search = new URLSearchParams({
    client_id: settings.clientId,
    redirect_uri: settings.redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    // Both are what make a refresh token appear: offline access asks for one,
    // and forcing the consent screen keeps a re-authorization from coming back
    // without it because the account approved this client once before.
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  }).toString()
  return url.toString()
}

/**
 * Read the authorization code out of whatever the human pasted.
 *
 * The redirect lands on a page that may not exist, so the human copies either
 * the whole address bar or the `code` out of it; both are accepted. A pasted
 * URL is also the only form carrying `state` and `error`, so it is checked when
 * it is there.
 * @param pasted - the text the human pasted.
 * @param state - the value {@link authorizationUrl} sent.
 * @returns the authorization code.
 * @throws when the redirect reports an error, the state does not match, or no code is present.
 */
export function readAuthorizationCode(pasted: string, state: string): string {
  const trimmed = pasted.trim()
  if (trimmed === '') throw new Error('No authorization code was pasted.')
  if (!/^https?:\/\//u.test(trimmed)) return trimmed
  let params: URLSearchParams
  try {
    params = new URL(trimmed).searchParams
  } catch {
    throw new Error(`That does not look like the redirected address: ${trimmed.slice(0, 120)}`)
  }
  const error = params.get('error')
  if (error !== null) {
    throw new Error(error === 'access_denied'
      ? 'Google reported that the sign-in was declined on the consent screen.'
      : `Google reported "${error}" on the redirect instead of an authorization code.`)
  }
  const returnedState = params.get('state')
  if (returnedState !== null && returnedState !== state) {
    throw new Error('The redirected address carries a different state than the one this sign-in sent; start the sign-in again.')
  }
  const code = params.get('code')
  if (code === null || code === '') {
    throw new Error('The redirected address carries no "code" parameter; paste the whole address you were sent to after approving.')
  }
  return code
}

/**
 * Trade the authorization code for a refresh token and a first access token.
 * @param settings - client credentials, the redirect URI, and the token origin.
 * @param code - the authorization code from the redirect.
 * @param signal - withdraws the exchange.
 * @returns the refresh token, the access token, and the granted scopes.
 * @throws when Google refuses the exchange or answers without an access token.
 */
export async function exchangeCode(settings: OAuthSettings, code: string, signal: AbortSignal): Promise<ExchangedGrant> {
  const body = new URLSearchParams({
    code,
    client_id: settings.clientId,
    client_secret: settings.clientSecret,
    redirect_uri: settings.redirectUri,
    grant_type: 'authorization_code',
  })
  const token = await postToken(settings, body, signal)
  const access = mintedFrom(token)
  return {
    ...token.refresh_token === undefined ? {} : { refreshToken: token.refresh_token },
    access,
    scopes: (token.scope ?? '').split(' ').filter(scope => scope !== ''),
  }
}

/**
 * Mint one access token from the stored refresh token.
 *
 * This is the whole reason the refresh token is the durable half: an access
 * token lasts an hour, and a credential that can renew itself never needs the
 * human again until the grant is revoked.
 * @param settings - client credentials and the token origin.
 * @param refreshToken - the stored token.
 * @param signal - withdraws the refresh.
 * @returns the access token and the moment it must be minted again.
 * @throws when Google refuses the refresh — `invalid_grant` means the grant was
 *   revoked or expired and the human must sign in again.
 */
export async function refreshAccessToken(
  settings: OAuthSettings,
  refreshToken: string,
  signal: AbortSignal,
): Promise<MintedToken> {
  const body = new URLSearchParams({
    client_id: settings.clientId,
    client_secret: settings.clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  })
  // A refresh response carries no refresh_token of its own: the stored one
  // stays in force until it is revoked, so nothing is written back here.
  return mintedFrom(await postToken(settings, body, signal))
}

/**
 * Whether a minted token is still usable, with a margin so a call never starts
 * on a token that lapses mid-upload.
 * @param token - the cached token, if any.
 * @param now - epoch milliseconds to judge against.
 * @returns true when the token can be reused, narrowing it for the caller.
 */
export function tokenUsable(token: MintedToken | undefined, now: number): token is MintedToken {
  return token !== undefined && token.expiresAt - EXPIRY_MARGIN_MS > now
}

/** Turn one token response into the cached form, or say what was missing. */
function mintedFrom(token: TokenResponse): MintedToken {
  if (token.access_token === undefined || token.access_token === '') {
    throw new Error('Google answered the token request without an access_token.')
  }
  // Google documents expires_in on every grant; an answer without one is
  // treated as the shortest life Google issues rather than as unlimited.
  const lifetimeSeconds = typeof token.expires_in === 'number' ? token.expires_in : 3600
  return { accessToken: token.access_token, expiresAt: Date.now() + lifetimeSeconds * 1000 }
}

/** POST one form-encoded grant to the token endpoint and read its JSON. */
async function postToken(settings: OAuthSettings, body: URLSearchParams, signal: AbortSignal): Promise<TokenResponse> {
  const controller = new AbortController()
  const abort = (): void => { controller.abort(signal.reason) }
  if (signal.aborted) abort()
  signal.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => { controller.abort(new Error('timeout')) }, settings.timeoutMs)
  try {
    const response = await fetch(new URL('/token', settings.tokenBaseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body: body.toString(),
      signal: controller.signal,
    })
    const text = await response.text()
    if (!response.ok) throw googleFailure('the Google token endpoint', response.status, text)
    return JSON.parse(text) as TokenResponse
  } catch (error) {
    if (controller.signal.aborted && !signal.aborted) {
      throw new Error(`The Google token endpoint did not answer within ${String(settings.timeoutMs)}ms.`)
    }
    throw error instanceof Error ? error : new Error(String(error))
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
  }
}
