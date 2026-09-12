/**
 * The two social providers this package registers, `facebook` and `instagram`,
 * over one Meta account.
 *
 * They are two registrations rather than one because they answer differently:
 * a Page takes a text-only post and an Instagram account does not, they are
 * gated by different App Review permissions, and only Instagram carries the
 * public-URL constraint. One mixed provider would have to average those into a
 * single row. What they share — the sign-in, the credential record, the Page
 * discovery, the Graph client — is shared here in {@link createMetaProviders},
 * which computes every target once and hands each provider its own.
 *
 * Readiness is computed in `collect`, and both `targets()` and `post()` read it
 * from there. A target that cannot publish therefore says so in the listing,
 * and a post to it is refused with the same sentence — rather than being
 * discovered by a Graph call failing halfway through an upload.
 *
 * @module @deepseek-ai/dsh-social-meta/provider
 */

import type { CredentialKey, CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { GraphEndpoint } from './graph.ts'
import {
  FACEBOOK_PUBLISH_PERMISSION, INSTAGRAM_PUBLISH_PERMISSION, fetchGrantedScopes, fetchPages,
} from './graph.ts'
import { grantLifetime, readGrant } from './grant.ts'
import { postToPage } from './facebook.ts'
import { postToInstagram, publicMediaUrl } from './instagram.ts'
import type {
  MetaPage, SocialMedia, SocialPostRequest, SocialPostResult, SocialProvider, SocialTarget,
} from './types.ts'

/**
 * The name the Page provider registers under. The social registry requires
 * every target id to begin with its provider's name, which is what makes
 * `facebook:page:<id>` and `instagram:<ig-user-id>` addressable at all.
 */
export const FACEBOOK_PROVIDER_NAME = 'facebook'

/** The name the Instagram provider registers under; see {@link FACEBOOK_PROVIDER_NAME}. */
export const INSTAGRAM_PROVIDER_NAME = 'instagram'

/** Which of the two networks a target is on. */
export type MetaNetwork = typeof FACEBOOK_PROVIDER_NAME | typeof INSTAGRAM_PROVIDER_NAME

/** What these providers need to answer for one authorized Meta account. */
export interface MetaProviderOptions {
  /** Where the Graph API lives and how long a call may take. */
  endpoint: GraphEndpoint
  /** The credential seam holding this account's grant. */
  credentials: CredentialProvider
  /** This plugin's credential record key. */
  key: CredentialKey
  /** Whether the Instagram provider is offered at all. */
  instagram: boolean
  /** Base URL local media is served under, for Instagram; empty when there is none. */
  publicMediaBaseUrl: string
  /** Milliseconds between Instagram container status checks. */
  pollIntervalMs: number
  /** Milliseconds to wait for an Instagram container in total. */
  pollTimeoutMs: number
  /** How many days before a user token expires a ready target starts saying so. */
  expiryWarningDays: number
  /**
   * The Meta app id, resolved per operation because it comes from the
   * credential seam and may be edited between posts.
   */
  appId: () => Promise<string>
}

/** One listed target and the Page it publishes through. */
interface TargetEntry {
  /** The target as a caller sees it. */
  target: SocialTarget
  /** The Page carrying the access token this target publishes with. */
  page: MetaPage
  /** Which network, and so which provider, this target belongs to. */
  network: MetaNetwork
}

/** Join the reasons a target carries into the one sentence it reports. */
function reasonOf(reasons: readonly string[]): { reason?: string } {
  return reasons.length === 0 ? {} : { reason: reasons.join('; ') }
}

/** The App Review sentence for one missing publishing permission. */
function appReviewReason(permission: string): string {
  return `the Meta app has not been granted ${permission}, which requires Meta App Review; until it is approved, publishing works only for people with a role on the app`
}

/** The single attachment a request carries, refusing the carousel Meta would need for more. */
function singleMedia(request: SocialPostRequest): SocialMedia | undefined {
  const media = request.media ?? []
  if (media.length > 1) {
    throw new Error(`the meta providers post one attachment at a time; ${String(media.length)} were given`)
  }
  return media[0]
}

/**
 * Build the `facebook` and `instagram` providers for one authorized account.
 * @param options - the endpoint, the credential record, and the publishing limits.
 * @returns the providers to register on the social seam; Instagram is absent while `instagram` is off.
 */
export function createMetaProviders(options: MetaProviderOptions): SocialProvider[] {
  /**
   * Every target this account currently holds, on both networks, with its
   * readiness decided.
   * @returns the entries, in the order Meta listed the Pages.
   * @throws when nothing is authorized, or when the stored user token has already expired.
   */
  const collect = async (): Promise<TargetEntry[]> => {
    const grant = await readGrant(options.credentials, options.key)
    if (grant === undefined) {
      throw new Error(`no Meta account is authorized for "${options.key}"; run its authorization flow first`)
    }
    const lifetime = grantLifetime(grant, Date.now(), options.expiryWarningDays)
    // Checked against the stored expiry rather than by making a call: a lapsed
    // token fails every Graph call with the same opaque OAuth error, and the
    // date the human needs is only in the record.
    if (lifetime.expired) throw new Error(`${lifetime.notice ?? 'the Meta user token has expired'} ("${options.key}")`)
    const [scopes, pages] = await Promise.all([
      fetchGrantedScopes(options.endpoint, grant.userToken),
      fetchPages(options.endpoint, grant.userToken),
    ])
    const entries: TargetEntry[] = []
    for (const page of pages) {
      const reasons: string[] = []
      if (!scopes.includes(FACEBOOK_PUBLISH_PERMISSION)) reasons.push(appReviewReason(FACEBOOK_PUBLISH_PERMISSION))
      const ready = reasons.length === 0
      if (ready && lifetime.notice !== undefined) reasons.push(lifetime.notice)
      entries.push({
        page,
        network: FACEBOOK_PROVIDER_NAME,
        target: {
          id: `facebook:page:${page.id}`,
          provider: FACEBOOK_PROVIDER_NAME,
          label: page.name,
          accepts: { text: true, image: true, video: true },
          ready,
          ...reasonOf(reasons),
        },
      })
      const linked = page.instagram
      if (!options.instagram || linked === undefined) continue
      const igReasons: string[] = []
      if (!scopes.includes(INSTAGRAM_PUBLISH_PERMISSION)) igReasons.push(appReviewReason(INSTAGRAM_PUBLISH_PERMISSION))
      const igReady = igReasons.length === 0
      if (igReady && lifetime.notice !== undefined) igReasons.push(lifetime.notice)
      if (igReady && options.publicMediaBaseUrl === '') {
        igReasons.push('Instagram fetches media from a public URL, so only media given as an https URL can be posted; set publicMediaBaseUrl to post local files')
      }
      entries.push({
        page,
        network: INSTAGRAM_PROVIDER_NAME,
        target: {
          id: `instagram:${linked.id}`,
          provider: INSTAGRAM_PROVIDER_NAME,
          label: linked.username === undefined ? `${page.name} (Instagram)` : `${page.name} (Instagram @${linked.username})`,
          // Instagram has no text-only post: a caption travels with media or not at all.
          accepts: { text: false, image: true, video: true },
          ready: igReady,
          ...reasonOf(igReasons),
        },
      })
    }
    return entries
  }

  /** Publish to one Instagram account, resolving the public URL Meta will fetch. */
  const publishInstagram = async (
    entry: TargetEntry,
    request: SocialPostRequest,
    media: SocialMedia | undefined,
  ): Promise<SocialPostResult> => {
    if (media === undefined) {
      throw new Error(`${entry.target.id} needs an image or a video: Instagram has no text-only post`)
    }
    const mediaUrl = publicMediaUrl(media, options.publicMediaBaseUrl)
    if (mediaUrl === undefined) {
      throw new Error(`Instagram fetches media from a public URL and ${media.path} is a local file; set publicMediaBaseUrl to the base URL that directory is served under, or pass an https URL`)
    }
    return postToInstagram({
      endpoint: options.endpoint,
      igUserId: entry.target.id.slice('instagram:'.length),
      pageToken: entry.page.accessToken,
      text: request.text,
      media,
      mediaUrl,
      pollIntervalMs: options.pollIntervalMs,
      pollTimeoutMs: options.pollTimeoutMs,
    })
  }

  /** One provider over the targets of a single network. */
  const providerFor = (network: MetaNetwork): SocialProvider => ({
    name: network,

    async targets(): Promise<readonly SocialTarget[]> {
      return (await collect()).filter(entry => entry.network === network).map(entry => entry.target)
    },

    async post(request: SocialPostRequest): Promise<SocialPostResult> {
      const media = singleMedia(request)
      const entries = (await collect()).filter(entry => entry.network === network)
      const entry = entries.find(candidate => candidate.target.id === request.target)
      if (entry === undefined) {
        const known = entries.map(candidate => candidate.target.id).join(', ')
        throw new Error(`no ${network} target "${request.target}"; this account has ${known === '' ? 'none' : known}`)
      }
      if (!entry.target.ready) {
        throw new Error(`${entry.target.id} cannot publish: ${entry.target.reason ?? 'it is not ready'}`)
      }
      if (network === INSTAGRAM_PROVIDER_NAME) return publishInstagram(entry, request, media)
      return postToPage({
        endpoint: options.endpoint,
        page: entry.page,
        text: request.text,
        ...media === undefined ? {} : { media },
        appId: options.appId,
      })
    },
  })

  return options.instagram
    ? [providerFor(FACEBOOK_PROVIDER_NAME), providerFor(INSTAGRAM_PROVIDER_NAME)]
    : [providerFor(FACEBOOK_PROVIDER_NAME)]
}
