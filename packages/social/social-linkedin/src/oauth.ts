/**
 * The three-legged OAuth leg of the LinkedIn provider: the authorization URL a
 * human opens, the code that comes back from it, and the token exchange that
 * turns that code into the grant this package stores.
 *
 * LinkedIn's self-serve tier issues an access token with a ~60-day lifetime and
 * **no refresh token**, so this module has no refresh path: when the grant
 * lapses the human signs in again. That is why {@link exchangeCode} returns an
 * absolute `expiresAt` — the stored fact has to answer "how long is left" long
 * after the `expires_in` seconds count was received.
 *
 * @module @deepseek-ai/dsh-social-linkedin/oauth
 */

/** Scopes the self-serve tier grants without review: sign-in plus member posting. */
export const MEMBER_SCOPES = ['openid', 'profile', 'w_member_social'] as const

/** The scope organization-page posting needs; LinkedIn grants it only after Community Management approval. */
export const ORGANIZATION_SCOPE = 'w_organization_social'

/** What a completed token exchange produced. */
export interface ExchangedToken {
  /** The bearer token. */
  accessToken: string
  /** Epoch milliseconds at which the token stops working. */
  expiresAt: number
  /** The scopes LinkedIn granted, which can be narrower than the ones asked for. */
  scopes: readonly string[]
}

/** Who the token belongs to, from the OpenID userinfo endpoint. */
export interface MemberIdentity {
  /** The `sub` claim: the id that forms `urn:li:person:<sub>`. */
  id: string
  /** The member's display name, when userinfo supplied one. */
  name?: string
}

/** Everything the OAuth leg needs from configuration and the credential seam. */
export interface OAuthSettings {
  /** The LinkedIn application's client id. */
  clientId: string
  /** The LinkedIn application's client secret. */
  clientSecret: string
  /** The redirect URI registered on the application, sent byte-for-byte identically in both legs. */
  redirectUri: string
  /** Origin of `www.linkedin.com`, overridable so a test or a proxy can stand in. */
  authBaseUrl: string
  /** Origin of `api.linkedin.com`, overridable on the same terms. */
  apiBaseUrl: string
  /** How long one HTTP call may take before it is abandoned. */
  timeoutMs: number
}

/**
 * Build the page the human opens to approve this application.
 * @param settings - client id, redirect URI, and the authorization origin.
 * @param scopes - the scopes to request, space-joined into the query.
 * @param state - opaque value LinkedIn echoes back, checked against the redirect.
 * @returns the absolute authorization URL.
 */
export function authorizeUrl(settings: OAuthSettings, scopes: readonly string[], state: string): string {
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: settings.clientId,
    redirect_uri: settings.redirectUri,
    scope: scopes.join(' '),
    state,
  })
  return `${settings.authBaseUrl}/oauth/v2/authorization?${query.toString()}`
}

/**
 * Read the authorization code out of whatever the human pasted back.
 *
 * A human copying from a browser address bar pastes the whole redirect URL far
 * more often than the bare code, so both are accepted. A pasted URL is also the
 * only form that can carry LinkedIn's `error` and `state` parameters, so those
 * are checked exactly when they are present.
 *
 * @param pasted - the code, or the full redirect URL containing it.
 * @param state - the value {@link authorizeUrl} sent, required to match when the paste carries one.
 * @returns the authorization code.
 * @throws when LinkedIn reported an error, the state does not match, or no code is present.
 */
export function extractCode(pasted: string, state: string): string {
  const trimmed = pasted.trim()
  if (trimmed === '') throw new Error('no authorization code was pasted')
  if (!/^https?:\/\//iu.test(trimmed)) return trimmed
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error('the pasted redirect URL could not be read; paste the code itself instead')
  }
  const error = url.searchParams.get('error')
  if (error !== null) {
    const description = url.searchParams.get('error_description') ?? ''
    throw new Error(`LinkedIn refused the sign-in: ${error}${description === '' ? '' : ` (${description})`}`)
  }
  const echoed = url.searchParams.get('state')
  if (echoed !== null && echoed !== state) {
    throw new Error('the redirect URL came from a different sign-in attempt; start again')
  }
  const code = url.searchParams.get('code')
  if (code === null || code === '') {
    throw new Error('the pasted redirect URL carries no code parameter')
  }
  return code
}

/** Read a response body without letting a broken stream mask the status. */
async function bodyText(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return ''
  }
}

/** Run one form-encoded or bearer call under a timeout, so a hung LinkedIn does not hang the flow. */
async function withTimeout<T>(
  timeoutMs: number,
  signal: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort(new Error(`LinkedIn did not answer within ${String(timeoutMs)}ms`)) }, timeoutMs)
  const withdraw = (): void => { controller.abort(signal?.reason) }
  if (signal?.aborted === true) withdraw()
  else signal?.addEventListener('abort', withdraw, { once: true })
  try {
    return await run(controller.signal)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', withdraw)
  }
}

/**
 * Exchange an authorization code for an access token.
 * @param settings - client credentials, the redirect URI, and the authorization origin.
 * @param code - the code {@link extractCode} produced.
 * @param signal - withdraws the exchange when the attempt is cancelled.
 * @returns the token, its absolute expiry, and the granted scopes.
 * @throws when LinkedIn rejects the exchange or returns no token.
 */
export async function exchangeCode(settings: OAuthSettings, code: string, signal?: AbortSignal): Promise<ExchangedToken> {
  const response = await withTimeout(settings.timeoutMs, signal, abort => fetch(`${settings.authBaseUrl}/oauth/v2/accessToken`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: settings.clientId,
      client_secret: settings.clientSecret,
      redirect_uri: settings.redirectUri,
    }).toString(),
    signal: abort,
  }))
  const text = await bodyText(response)
  if (!response.ok) {
    throw new Error(`LinkedIn refused the token exchange (${String(response.status)}): ${text.slice(0, 500)}`)
  }
  let payload: { access_token?: unknown; expires_in?: unknown; scope?: unknown }
  try {
    payload = JSON.parse(text) as typeof payload
  } catch {
    throw new Error('the LinkedIn token exchange did not answer with JSON')
  }
  const accessToken = typeof payload.access_token === 'string' ? payload.access_token : ''
  if (accessToken === '') throw new Error('the LinkedIn token exchange returned no access_token')
  // A response without expires_in would leave the expiry unknown, and an
  // unknown expiry is the failure this provider exists to avoid; treat it as
  // already lapsed so the next `targets()` asks for a fresh sign-in rather than
  // reporting a credential nobody can vouch for.
  const lifetimeSeconds = typeof payload.expires_in === 'number' ? payload.expires_in : 0
  const scopes = typeof payload.scope === 'string'
    ? payload.scope.split(/[\s,]+/u).filter(scope => scope !== '')
    : [...MEMBER_SCOPES]
  return {
    accessToken,
    expiresAt: Date.now() + lifetimeSeconds * 1000,
    scopes,
  }
}

/**
 * Read who a token belongs to.
 * @param settings - the API origin and the call timeout.
 * @param accessToken - the token to identify.
 * @param signal - withdraws the call when the attempt is cancelled.
 * @returns the member's `sub` id and display name.
 * @throws when the call fails or carries no `sub`.
 */
export async function readMember(settings: OAuthSettings, accessToken: string, signal?: AbortSignal): Promise<MemberIdentity> {
  const response = await withTimeout(settings.timeoutMs, signal, abort => fetch(`${settings.apiBaseUrl}/v2/userinfo`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: abort,
  }))
  const text = await bodyText(response)
  if (!response.ok) {
    throw new Error(`LinkedIn would not identify the signed-in member (${String(response.status)}): ${text.slice(0, 300)}`)
  }
  let payload: { sub?: unknown; name?: unknown }
  try {
    payload = JSON.parse(text) as typeof payload
  } catch {
    throw new Error('the LinkedIn userinfo endpoint did not answer with JSON')
  }
  const id = typeof payload.sub === 'string' ? payload.sub : ''
  if (id === '') throw new Error('the LinkedIn userinfo endpoint returned no sub claim')
  return typeof payload.name === 'string' && payload.name !== ''
    ? { id, name: payload.name }
    : { id }
}
