/**
 * The authorization flow that obtains this package's credential: the Facebook
 * login dialog, the code exchange, the long-lived token exchange, and the
 * record commit that ends the attempt.
 *
 * The human copies the redirect URL back rather than the harness catching it,
 * because the redirect URI a Meta app is configured with is the operator's own
 * — a route invented here could not be one of them, and the authorization seam
 * already owns the conversation this needs.
 *
 * @module @deepseek-ai/dsh-social-meta/oauth
 */

import { randomUUID } from 'node:crypto'
import type { AuthorizationFlow, AuthorizationSession } from '@deepseek-ai/dsh-authorization'
import type { CredentialKey, CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { GraphEndpoint } from './graph.ts'
import {
  FACEBOOK_PUBLISH_PERMISSION, FACEBOOK_SCOPES, INSTAGRAM_PUBLISH_PERMISSION, INSTAGRAM_SCOPES,
  fetchGrantedScopes, fetchPages, graphRequest,
} from './graph.ts'
import { writeGrant } from './grant.ts'

/** What the flow needs to run one sign-in. */
export interface MetaFlowOptions {
  /** Where the Graph API lives. */
  endpoint: GraphEndpoint
  /** Origin of the login dialog, normally `https://www.facebook.com`. */
  loginBase: string
  /** The credential seam the resulting grant is committed through. */
  credentials: CredentialProvider
  /** This plugin's credential record key. */
  key: CredentialKey
  /** User-facing name of the account being authorized. */
  label: string
  /** Whether the Instagram permissions are asked for. */
  instagram: boolean
  /** A redirect URI registered on the Meta app; the human is redirected here and copies the URL back. */
  redirectUri: string
  /** The Meta app id. */
  appId: () => Promise<string>
  /** The Meta app secret. */
  appSecret: () => Promise<string>
}

/**
 * Pull the authorization code out of what the human pasted.
 * @param pasted - a full redirect URL, or the bare `code` value.
 * @param state - the value this attempt sent to the dialog.
 * @returns the authorization code.
 * @throws when the paste carries no code, or carries another attempt's state.
 */
export function extractCode(pasted: string, state: string): string {
  const text = pasted.trim()
  if (text === '') throw new Error('no authorization code was pasted')
  if (!/^https?:\/\//iu.test(text)) return text
  const url = new URL(text)
  const returned = url.searchParams.get('state')
  if (returned !== null && returned !== state) {
    throw new Error('the pasted URL belongs to a different sign-in attempt; start the authorization again')
  }
  const error = url.searchParams.get('error_description') ?? url.searchParams.get('error')
  if (error !== null) throw new Error(`Meta refused the sign-in: ${error}`)
  const code = url.searchParams.get('code')
  if (code === null || code === '') throw new Error(`the pasted URL carries no code parameter: ${text}`)
  return code
}

/** Read a non-empty string field from a token response. */
function tokenField(answer: Record<string, unknown>, field: string): string | undefined {
  const value = answer[field]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Exchange the authorization code for a short-lived user token, then that for a
 * long-lived one.
 * @param options - the app credentials and the redirect URI the code was issued against.
 * @param code - the authorization code.
 * @param appId - the Meta app id.
 * @param appSecret - the Meta app secret.
 * @returns the long-lived user token and the epoch milliseconds it expires at, when Meta named one.
 */
async function exchangeToken(
  options: MetaFlowOptions,
  code: string,
  appId: string,
  appSecret: string,
): Promise<{ userToken: string; expiresAt?: number }> {
  const short = await graphRequest(options.endpoint, 'oauth/access_token', {
    params: { client_id: appId, client_secret: appSecret, redirect_uri: options.redirectUri, code },
  })
  const shortToken = tokenField(short, 'access_token')
  if (shortToken === undefined) throw new Error('Meta returned no access_token for the authorization code')
  // The short-lived token lasts about an hour; everything afterwards is done
  // with the long-lived one, which is also the only one with a stated lifetime.
  const long = await graphRequest(options.endpoint, 'oauth/access_token', {
    params: {
      grant_type: 'fb_exchange_token',
      client_id: appId,
      client_secret: appSecret,
      fb_exchange_token: shortToken,
    },
  })
  const userToken = tokenField(long, 'access_token')
  if (userToken === undefined) throw new Error('Meta returned no long-lived access_token')
  const expiresIn = long['expires_in']
  return {
    userToken,
    ...typeof expiresIn === 'number' && expiresIn > 0 ? { expiresAt: Date.now() + expiresIn * 1000 } : {},
  }
}

/** What the human is told once the grant is stored: what was found, and what App Review still gates. */
function summary(options: MetaFlowOptions, pages: readonly { name: string; instagram?: unknown }[], scopes: readonly string[]): string {
  const missing = [
    ...scopes.includes(FACEBOOK_PUBLISH_PERMISSION) ? [] : [FACEBOOK_PUBLISH_PERMISSION],
    ...!options.instagram || scopes.includes(INSTAGRAM_PUBLISH_PERMISSION) ? [] : [INSTAGRAM_PUBLISH_PERMISSION],
  ]
  const found = pages.length === 0
    ? 'No Pages were found on this account'
    : `Pages: ${pages.map(page => page.name + (page.instagram === undefined ? '' : ' (+ Instagram)')).join(', ')}`
  return missing.length === 0
    ? `${found}. Publishing permissions are granted.`
    : `${found}. Not granted: ${missing.join(', ')} — these need Meta App Review, and until it is approved publishing works only for people with a role on the app.`
}

/**
 * Build this package's authorization flow.
 * @param options - the endpoint, the app credentials, and the record to commit.
 * @returns the flow to register on `ctx.authorization`.
 */
export function metaAuthorizationFlow(options: MetaFlowOptions): AuthorizationFlow {
  return {
    key: options.key,
    label: options.label,
    methods: [{ id: 'facebook-login', label: 'Sign in with Facebook' }],
    async run(session: AuthorizationSession): Promise<void> {
      if (options.redirectUri === '') {
        throw new Error('social-meta: redirectUri is not set; it must be one of the Valid OAuth Redirect URIs on the Meta app')
      }
      const [appId, appSecret] = await Promise.all([options.appId(), options.appSecret()])
      const state = randomUUID()
      const scope = [...FACEBOOK_SCOPES, ...options.instagram ? INSTAGRAM_SCOPES : []].join(',')
      const dialog = new URL(`${options.loginBase.replace(/\/+$/u, '')}/${options.endpoint.version}/dialog/oauth`)
      for (const [key, value] of Object.entries({
        client_id: appId,
        redirect_uri: options.redirectUri,
        state,
        scope,
        response_type: 'code',
      })) dialog.searchParams.set(key, value)
      session.notify({
        message: `Open this page, sign in as someone who manages the Pages you want to post to, and approve the permissions. Your browser then lands on ${options.redirectUri}; copy that whole URL.`,
        url: dialog.toString(),
      })
      const pasted = await session.prompt({
        kind: 'text',
        message: 'Paste the URL your browser was redirected to (or just the code it carries).',
        placeholder: `${options.redirectUri}?code=…`,
      })
      const { userToken, expiresAt } = await exchangeToken(options, extractCode(pasted, state), appId, appSecret)
      const [grantedScopes, pages] = await Promise.all([
        fetchGrantedScopes(options.endpoint, userToken),
        fetchPages(options.endpoint, userToken),
      ])
      await writeGrant(options.credentials, options.key, {
        version: 1,
        userToken,
        ...expiresAt === undefined ? {} : { expiresAt },
        obtainedAt: Date.now(),
        grantedScopes,
      })
      session.notify({ message: summary(options, pages, grantedScopes) })
    },
  }
}
