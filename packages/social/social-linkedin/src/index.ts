/**
 * LinkedIn provider for the social seam: posting to the signed-in member's own
 * feed, with text, one image, or one video.
 *
 * The credential is obtained through an authorization flow (`ctx.authorization`)
 * and stored as a grant record through the credential seam
 * (`ctx.credentials`), keyed `social-linkedin/member`. This package owns no
 * token store and no callback route of its own.
 *
 * **The 60-day problem.** LinkedIn's self-serve tier issues an access token
 * that lasts about 60 days and grants no refresh token, so the credential
 * expires and a human must sign in again. The expiry is stored absolutely
 * alongside the token and checked locally, and `targets()` reports a target as
 * not ready — naming the date — while the token is still working but close to
 * lapsing. That early warning is the point: the failure worth avoiding is a
 * post failing at the moment someone wanted it to go out.
 *
 * @module @deepseek-ai/dsh-social-linkedin
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { AuthorizationSession } from '@deepseek-ai/dsh-authorization'
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import {
  createPost, listAdministeredOrganizations, uploadImage, uploadVideo,
} from './api.ts'
import type { ApiSettings, MediaAttachment } from './api.ts'
import {
  MEMBER_SCOPES, ORGANIZATION_SCOPE, authorizeUrl, exchangeCode, extractCode, readMember,
} from './oauth.ts'
import type { OAuthSettings } from './oauth.ts'
import type {
  LinkedInGrant, SocialPostRequest, SocialPostResult, SocialProvider, SocialTarget,
} from './types.ts'

export type {
  LinkedInGrant, LinkedInOrganization, SocialMedia, SocialPostRequest, SocialPostResult, SocialProvider,
  SocialTarget,
} from './types.ts'
// The seam declares `Context.social`; `inject` above makes it present by `apply`.
import type {} from '@deepseek-ai/dsh-social'

/** The plugin name, for the Loader. It is also the credential key's scope. */
export const name = 'social-linkedin'

/** The services this plugin contributes to and reads through. */
export const inject = ['social', 'credentials', 'authorization']

/** Composition config. */
export interface Config {
  /** Environment-variable name holding the LinkedIn application's client id. */
  clientIdRef: string
  /** Environment-variable name holding the LinkedIn application's client secret. */
  clientSecretRef: string
  /** Redirect URI registered on the LinkedIn application; sign-in cannot start without it. */
  redirectUri: string
  /** The `LinkedIn-Version` every versioned REST call carries, in `YYYYMM` form. */
  apiVersion: string
  /** How many days before the token lapses a target starts reporting itself unready. */
  reauthWarningDays: number
  /** Origin of the LinkedIn API. */
  apiBaseUrl: string
  /** Origin of the LinkedIn sign-in pages and the token endpoint. */
  authBaseUrl: string
  /** Milliseconds one HTTP call may take before it is abandoned. */
  timeoutMs: number
}

/**
 * Composition config. The client id and secret are named, not carried: a
 * secret in settings would be a secret in a configuration UI, so this package
 * stores the reference and resolves it through the credential seam per call.
 */
export const Config: z<Config> = z.object({
  clientIdRef: z.string().default('LINKEDIN_CLIENT_ID')
    .description('Name of the environment variable holding the LinkedIn application client id.'),
  clientSecretRef: z.string().default('LINKEDIN_CLIENT_SECRET')
    .description('Name of the environment variable holding the LinkedIn application client secret.'),
  redirectUri: z.string().default('')
    .description('The redirect URI registered on the LinkedIn application. LinkedIn compares it byte-for-byte, so it must match the registration exactly. Sign-in refuses to start while this is empty.'),
  apiVersion: z.string().default('202608')
    .description('The LinkedIn-Version header value, YYYYMM. LinkedIn supports each version for about a year, so this needs raising before the configured one lapses.'),
  reauthWarningDays: z.natural().default(7)
    .description('How many days before the 60-day token expires that LinkedIn targets start reporting themselves not ready, so a re-sign-in happens before a post fails.'),
  apiBaseUrl: z.string().default('https://api.linkedin.com')
    .description('Origin of the LinkedIn API. Change it only to route through a proxy or a stand-in.'),
  authBaseUrl: z.string().default('https://www.linkedin.com')
    .description('Origin of the LinkedIn sign-in pages and token endpoint. Change it only to route through a proxy or a stand-in.'),
  timeoutMs: z.natural().min(1000).default(30_000)
    .description('How long one LinkedIn HTTP call may take before it is abandoned. Video parts go through this same budget.'),
})

/** Milliseconds in a day, for the expiry arithmetic. */
const DAY_MS = 24 * 60 * 60 * 1000

/** The target every grant has: the signed-in person's own feed. */
const MEMBER_TARGET_ID = 'linkedin:member'

/** Prefix of an organization-page target id; the rest is the numeric organization id. */
const ORG_TARGET_PREFIX = 'linkedin:org:'

/** LinkedIn accepts one attachment per post, of any of these kinds. */
const ACCEPTS = { text: true, image: true, video: true } as const

/**
 * Read a stored grant, refusing anything that is not one.
 *
 * The record comes off durable storage, where a half-written or
 * previous-format payload is a real possibility, so every field is checked
 * rather than trusted. A payload that does not check out reads as "nothing
 * stored", which routes a human to the sign-in that will replace it.
 *
 * @param record - the credential record as the seam returned it.
 * @returns the grant, or undefined when none is usable.
 */
function readGrant(record: CredentialRecord | undefined): LinkedInGrant | undefined {
  if (record?.kind !== 'grant') return undefined
  const payload = record.payload
  if (typeof payload !== 'object' || payload === null) return undefined
  const grant = payload as Partial<LinkedInGrant>
  if (typeof grant.accessToken !== 'string' || grant.accessToken === '') return undefined
  if (typeof grant.expiresAt !== 'number' || !Number.isFinite(grant.expiresAt)) return undefined
  if (typeof grant.memberId !== 'string' || grant.memberId === '') return undefined
  return {
    accessToken: grant.accessToken,
    expiresAt: grant.expiresAt,
    obtainedAt: typeof grant.obtainedAt === 'number' ? grant.obtainedAt : 0,
    scopes: Array.isArray(grant.scopes) ? grant.scopes.filter((scope): scope is string => typeof scope === 'string') : [],
    memberId: grant.memberId,
    ...(typeof grant.memberName === 'string' && grant.memberName !== '' ? { memberName: grant.memberName } : {}),
  }
}

/** How the stored credential stands right now, decided from the stored expiry alone. */
interface Readiness {
  /** Whether a target backed by this credential should report itself ready. */
  ready: boolean
  /** Why not, and what to do about it. */
  reason?: string
}

/** A date a human can act on, without a locale's ambiguity about which number is the month. */
function isoDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10)
}

/**
 * Decide readiness from the stored expiry, never from an API call.
 *
 * Reporting unready inside the warning window is deliberate: a token that still
 * works but lapses in three days will lapse between now and the post somebody
 * is planning, and discovering that at post time is the failure this whole
 * expiry accounting exists to prevent.
 *
 * @param grant - the stored grant, or undefined while none is stored.
 * @param warningDays - how early to start asking for a fresh sign-in.
 * @param now - epoch milliseconds to judge against.
 * @returns readiness and the reason it is not ready.
 */
function readiness(grant: LinkedInGrant | undefined, warningDays: number, now: number): Readiness {
  if (grant === undefined) {
    return {
      ready: false,
      reason: 'No LinkedIn credential is stored. Authorize "social-linkedin/member" to sign in; LinkedIn will then keep you signed in for about 60 days.',
    }
  }
  const remaining = grant.expiresAt - now
  if (remaining <= 0) {
    return {
      ready: false,
      reason: `The LinkedIn token expired on ${isoDay(grant.expiresAt)}. LinkedIn's self-serve tier issues no refresh token, so authorize "social-linkedin/member" again to sign in.`,
    }
  }
  if (remaining <= warningDays * DAY_MS) {
    const days = Math.max(1, Math.ceil(remaining / DAY_MS))
    return {
      ready: false,
      reason: `The LinkedIn token expires on ${isoDay(grant.expiresAt)}, in ${String(days)} day${days === 1 ? '' : 's'}. It still works today, but there is no refresh token: authorize "social-linkedin/member" again before it lapses.`,
    }
  }
  return { ready: true }
}

/** What a target id resolved to. */
type ResolvedTarget =
  | { kind: 'member' }
  | { kind: 'organization'; id: string }

/**
 * Resolve one target id to what it addresses.
 * @param id - the id from a post request.
 * @returns the member feed or one organization page.
 * @throws when the id is not one this provider emits.
 */
function resolveTarget(id: string): ResolvedTarget {
  if (id === MEMBER_TARGET_ID) return { kind: 'member' }
  if (id.startsWith(ORG_TARGET_PREFIX)) {
    const organization = id.slice(ORG_TARGET_PREFIX.length)
    if (organization !== '') return { kind: 'organization', id: organization }
  }
  throw new Error(`"${id}" is not a LinkedIn target; this provider posts to "${MEMBER_TARGET_ID}" and "${ORG_TARGET_PREFIX}<id>".`)
}

/**
 * Mount the LinkedIn sign-in flow and the social provider.
 * @param ctx - the plugin context, injecting `social`, `credentials`, and `authorization`.
 * @param config - validated composition config.
 */
export function apply(ctx: Context, config: Config): void {
  const key: CredentialKey = credentialKey(name, 'member')
  const api: ApiSettings = {
    apiBaseUrl: config.apiBaseUrl,
    version: config.apiVersion,
    timeoutMs: config.timeoutMs,
  }

  /** Read the stored grant. Per operation, never cached: a re-sign-in has to reach the next call. */
  const currentGrant = async (): Promise<LinkedInGrant | undefined> => readGrant(await ctx.credentials.readRecord(key))

  /**
   * Resolve the OAuth settings, failing loud about whichever half is missing.
   * Resolved per attempt so a client secret added after boot is picked up.
   */
  const oauthSettings = async (): Promise<OAuthSettings> => {
    if (config.redirectUri === '') {
      throw new Error('LinkedIn sign-in needs a redirectUri: set it on this plugin to the callback URL registered on your LinkedIn application.')
    }
    const clientId = await ctx.credentials.resolve(credentialRef(config.clientIdRef))
    const clientSecret = await ctx.credentials.resolve(credentialRef(config.clientSecretRef))
    const missing = [
      ...(clientId === undefined ? [config.clientIdRef] : []),
      ...(clientSecret === undefined ? [config.clientSecretRef] : []),
    ]
    if (clientId === undefined || clientSecret === undefined) {
      throw new Error(`LinkedIn sign-in needs the application credentials: set ${missing.join(' and ')}.`)
    }
    return {
      clientId: clientId.value,
      clientSecret: clientSecret.value,
      redirectUri: config.redirectUri,
      authBaseUrl: config.authBaseUrl,
      apiBaseUrl: config.apiBaseUrl,
      timeoutMs: config.timeoutMs,
    }
  }

  /**
   * One sign-in: send the human to LinkedIn, take the code back, exchange it,
   * and commit the grant. There is no callback route here — the authorization
   * seam's conversation is the whole transport, so the human pastes what their
   * browser landed on.
   */
  const runSignIn = async (session: AuthorizationSession): Promise<void> => {
    const settings = await oauthSettings()
    const state = randomUUID()
    session.notify({
      message: 'Open this page, approve the application, then copy the address bar of the page LinkedIn sends you to.',
      url: authorizeUrl(settings, [...MEMBER_SCOPES], state),
    })
    const pasted = await session.prompt({
      kind: 'text',
      message: 'Paste the address LinkedIn redirected you to (or just the code parameter from it).',
      placeholder: `${config.redirectUri}?code=…&state=…`,
    })
    const code = extractCode(pasted, state)
    const token = await exchangeCode(settings, code, session.signal)
    const member = await readMember(settings, token.accessToken, session.signal)
    const grant: LinkedInGrant = {
      accessToken: token.accessToken,
      expiresAt: token.expiresAt,
      obtainedAt: Date.now(),
      scopes: token.scopes,
      memberId: member.id,
      ...(member.name === undefined ? {} : { memberName: member.name }),
    }
    await ctx.credentials.modifyRecord(key, () => Promise.resolve({ kind: 'grant', payload: grant }))
    session.notify({
      message: `Signed in as ${member.name ?? member.id}. This credential expires on ${isoDay(token.expiresAt)}; LinkedIn issues no refresh token, so sign in again before then.`,
    })
  }

  /** The member target, ready or not, always listed: it is what this provider is for. */
  const memberTarget = (grant: LinkedInGrant | undefined, state: Readiness): SocialTarget => ({
    id: MEMBER_TARGET_ID,
    provider: 'linkedin',
    label: grant?.memberName === undefined ? 'LinkedIn (your feed)' : `LinkedIn — ${grant.memberName}`,
    accepts: { ...ACCEPTS },
    ...state,
  })

  /**
   * The organization-page targets, which exist only when the stored grant
   * actually carries `w_organization_social`. Inventing them from the member
   * grant would produce targets that refuse every post: the scope comes from
   * LinkedIn's Community Management approval, not from asking for it.
   */
  const organizationTargets = async (grant: LinkedInGrant, state: Readiness): Promise<readonly SocialTarget[]> => {
    if (!grant.scopes.includes(ORGANIZATION_SCOPE)) return []
    try {
      const organizations = await listAdministeredOrganizations(api, grant.accessToken)
      return organizations.map(organization => ({
        id: `${ORG_TARGET_PREFIX}${organization.id}`,
        provider: 'linkedin',
        label: `LinkedIn — ${organization.name}`,
        accepts: { ...ACCEPTS },
        ...state,
      }))
    } catch (error) {
      // The roster is an extra, not the provider: a member feed that still
      // works must not disappear because the page listing failed.
      ctx.logger.warn('social-linkedin: could not list the administered organization pages')
      ctx.logger.warn(error)
      return []
    }
  }

  /** Resolve the token to post with, refusing on a stored expiry rather than on LinkedIn's answer. */
  const postingGrant = async (): Promise<LinkedInGrant> => {
    const grant = await currentGrant()
    if (grant === undefined) {
      throw new Error(readiness(undefined, config.reauthWarningDays, Date.now()).reason ?? 'no LinkedIn credential is stored')
    }
    if (grant.expiresAt <= Date.now()) {
      throw new Error(`The LinkedIn token expired on ${isoDay(grant.expiresAt)}; authorize "${key}" again before posting.`)
    }
    return grant
  }

  const provider: SocialProvider = {
    name: 'linkedin',

    async targets(): Promise<readonly SocialTarget[]> {
      const grant = await currentGrant()
      const state = readiness(grant, config.reauthWarningDays, Date.now())
      const member = memberTarget(grant, state)
      if (grant === undefined) return [member]
      return [member, ...await organizationTargets(grant, state)]
    },

    async post(request: SocialPostRequest): Promise<SocialPostResult> {
      const target = resolveTarget(request.target)
      const text = request.text.trim()
      if (text === '') throw new Error('a LinkedIn post needs text; LinkedIn rejects an empty commentary')
      const grant = await postingGrant()
      if (target.kind === 'organization' && !grant.scopes.includes(ORGANIZATION_SCOPE)) {
        throw new Error(`Posting to a LinkedIn organization page needs the ${ORGANIZATION_SCOPE} scope, which this credential does not carry; it comes from LinkedIn's Community Management approval.`)
      }
      const author = target.kind === 'member'
        ? `urn:li:person:${grant.memberId}`
        : `urn:li:organization:${target.id}`

      const notes: string[] = []
      const attachments = request.media ?? []
      const [first] = attachments
      if (attachments.length > 1) {
        notes.push(`LinkedIn takes one attachment per post; only ${first?.path ?? 'the first file'} was attached.`)
      }
      let media: MediaAttachment | undefined
      if (first !== undefined) {
        if (first.kind === 'image') {
          if (first.alt === undefined || first.alt.trim() === '') {
            // Said out loud rather than silently: an image with no alt text is
            // unreadable to anyone using a screen reader, and the post is
            // already going out.
            const missing = `The image ${first.path} was posted without alt text, so it is undescribed for screen readers.`
            notes.push(missing)
            ctx.logger.warn('social-linkedin: %s', missing)
          }
          const id = await uploadImage(api, grant.accessToken, author, first.path)
          media = first.alt === undefined || first.alt.trim() === '' ? { id } : { id, altText: first.alt }
        } else {
          const id = await uploadVideo(api, grant.accessToken, author, first.path)
          // LinkedIn's video attachment carries a `title` where an image
          // carries alt text; the caller's description is the best title there
          // is, and the post reads worse with an empty one.
          media = first.alt === undefined || first.alt.trim() === '' ? { id } : { id, title: first.alt }
        }
      }

      const created = await createPost(api, grant.accessToken, author, text, media)
      return notes.length === 0 ? created : { ...created, notes }
    },
  }

  ctx.effect(() => ctx.authorization.registerFlow({
    key,
    label: 'LinkedIn (post as yourself)',
    methods: [{ id: 'oauth', label: 'Sign in with LinkedIn' }],
    run: runSignIn,
  }), `social-linkedin: authorization flow ${key}`)

  ctx.effect(() => ctx.social.register(provider), 'social-linkedin: social provider')
}
