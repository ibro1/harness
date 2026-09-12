/**
 * The YouTube provider for the social seam: one channel to post to, and a post
 * that is a video upload.
 *
 * Two things about YouTube are facts a caller has to be told rather than left
 * to discover. Uploads are capped per day — Google's current quota table gives
 * `videos.insert` its own bucket of 100 calls a day, and a project on the older
 * shared 10,000-unit day spends about 1600 units an upload, about six a day —
 * and no setting here raises either. And `youtube.upload` is a sensitive scope,
 * so an unverified API project's uploads are restricted to private whatever
 * privacy was asked for. Both are stated on every target's `reason`, in the
 * README, and in the error or notes of the upload they affect.
 *
 * The credential is the one in this group that can renew itself: the sign-in
 * asks for offline access, the refresh token is what the credential seam
 * stores, and access tokens are minted from it per hour and held in memory
 * only.
 *
 * @module @deepseek-ai/dsh-social-youtube
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialKey, credentialRef, isCredentialRefName } from '@deepseek-ai/dsh-credentials'
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import type { AuthorizationSession } from '@deepseek-ai/dsh-authorization'
import { MAPPING_MESSAGE, QUOTA_NOTICE, VERIFICATION_MESSAGE } from './errors.ts'
import { describeOutcome, splitPost } from './mapping.ts'
import {
  authorizationUrl, exchangeCode, readAuthorizationCode, refreshAccessToken, SCOPES, tokenUsable,
} from './oauth.ts'
import type { OAuthSettings } from './oauth.ts'
import { CHUNK_GRANULARITY, describeVideoFile, initiateUpload, listChannels, sendVideo } from './upload.ts'
import type { ApiSettings, VideoMetadata } from './upload.ts'
import type {
  MintedToken, SocialPostRequest, SocialPostResult, SocialProvider, SocialTarget, YouTubeChannel,
  YouTubeGrant,
} from './types.ts'

export type {
  SocialMedia, SocialPostRequest, SocialPostResult, SocialProvider, SocialTarget, YouTubeGrant,
} from './types.ts'
// The seam declares `Context.social`; `inject` above makes it present by `apply`.
import type {} from '@deepseek-ai/dsh-social'

/** The plugin name, for the Loader, and the scope half of this plugin's credential key. */
export const name = 'social-youtube'

/** The services this plugin registers on and reads through. */
export const inject = ['social', 'credentials', 'authorization']

/** The provider name every target id of this package is prefixed with. */
const PROVIDER = 'youtube'

/** Prefix of every target this provider owns: `youtube:channel:<id>`. */
const TARGET_PREFIX = `${PROVIDER}:channel:`

/**
 * The target id standing for "the channel this grant belongs to", before a
 * sign-in has named it. It is also accepted by `post`, so a caller that read
 * the unready listing and then authorized does not have to list again.
 */
const MINE = `${TARGET_PREFIX}me`

/** Composition config: which Google client to sign in with, and what to upload as. */
export interface Config {
  /** The Google Cloud OAuth client id, when it is given here rather than through the credential seam. */
  clientId: string
  /** That client's secret, on the same terms. */
  clientSecret: string
  /** Environment variable holding the client id, resolved through the credential seam when `clientId` is empty. */
  clientIdRef: string
  /** Environment variable holding the client secret, on the same terms. */
  clientSecretRef: string
  /** A redirect URI registered on the OAuth client; the human copies the address they land on back into the sign-in. */
  redirectUri: string
  /** What every upload asks for. `private` is the default because a model can invoke this. */
  privacyStatus: 'private' | 'unlisted' | 'public'
  /** The `videoCategories` id every upload is filed under; `22` is People & Blogs. */
  categoryId: string
  /** What every upload declares for `selfDeclaredMadeForKids`. */
  madeForKids: boolean
  /** Whether an upload notifies the channel's subscribers; `videos.insert` itself defaults this to true. */
  notifySubscribers: boolean
  /** Bytes per upload chunk; must be a multiple of 262144. */
  chunkBytes: number
  /** How many times an interrupted chunk is re-sent after asking the session where it got to. */
  uploadRetries: number
  /** How long one metadata or token call may take. */
  timeoutMs: number
  /** How long one chunk upload may take. */
  chunkTimeoutMs: number
  /** Origin of Google's consent page. */
  authBaseUrl: string
  /** Origin of Google's token endpoint. */
  tokenBaseUrl: string
  /** Origin serving the YouTube Data API. */
  apiBaseUrl: string
  /** Origin serving the resumable upload endpoint. */
  uploadBaseUrl: string
}

/** Composition config: which Google client to sign in with, and what to upload as. */
export const Config: z<Config> = z.object({
  clientId: z.string().default('').description('Google Cloud OAuth client id. Leave empty to read it from the environment variable named by clientIdRef.'),
  clientSecret: z.string().default('').description('That client\'s secret. Leave empty to read it from the environment variable named by clientSecretRef.'),
  clientIdRef: z.string().default('GOOGLE_CLIENT_ID').description('Environment variable holding the OAuth client id.'),
  clientSecretRef: z.string().default('GOOGLE_CLIENT_SECRET').description('Environment variable holding the OAuth client secret.'),
  redirectUri: z.string().default('http://localhost').description('A redirect URI registered on the OAuth client. The sign-in sends the human here and asks them to paste the address they land on, so a page that does not exist is fine.'),
  privacyStatus: z.union([z.const('private'), z.const('unlisted'), z.const('public')]).default('private').description('Privacy every upload asks for. YouTube can still hold it at private while the OAuth client is unverified.'),
  categoryId: z.string().default('22').description('YouTube videoCategories id every upload is filed under; 22 is People & Blogs.'),
  madeForKids: z.boolean().default(false).description('What every upload declares for selfDeclaredMadeForKids.'),
  notifySubscribers: z.boolean().default(false).description('Whether an upload notifies the channel\'s subscribers. YouTube defaults this to true; it is false here because a model can invoke the upload.'),
  chunkBytes: z.natural().min(CHUNK_GRANULARITY).default(8 * 1024 * 1024).description('Bytes per upload chunk; must be a multiple of 262144.'),
  uploadRetries: z.natural().default(3).description('How many times an interrupted chunk is re-sent after asking the upload session how much it holds.'),
  timeoutMs: z.natural().min(1000).default(30_000).description('How long one metadata or token call may take.'),
  chunkTimeoutMs: z.natural().min(1000).default(120_000).description('How long one chunk upload may take.'),
  authBaseUrl: z.string().default('https://accounts.google.com').description('Origin of the Google consent page.'),
  tokenBaseUrl: z.string().default('https://oauth2.googleapis.com').description('Origin of the Google token endpoint.'),
  apiBaseUrl: z.string().default('https://www.googleapis.com').description('Origin serving the YouTube Data API.'),
  uploadBaseUrl: z.string().default('https://www.googleapis.com').description('Origin serving the resumable upload endpoint.'),
})

/**
 * The YouTube implementation of the social seam.
 *
 * One instance holds the minted access token, which is the only state: the
 * refresh token lives in the credential seam, and a re-authorization drops the
 * cached token so the next call mints from the record that was just written.
 */
class YouTubeProvider implements SocialProvider {
  readonly name = PROVIDER

  private token: MintedToken | undefined

  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
    private readonly key: CredentialKey,
  ) {}

  /** Drop the cached access token, so the next call mints one from the stored record. */
  forgetToken(): void {
    this.token = undefined
  }

  /**
   * The channels this grant can upload to.
   * @returns one target per owned channel, or one unready target explaining
   *   what is missing — a listing that throws would tell a caller nothing about
   *   how to fix it.
   */
  async targets(): Promise<readonly SocialTarget[]> {
    const controller = new AbortController()
    try {
      const settings = await this.settings()
      const channels = await listChannels(settings, await this.accessToken(settings, controller.signal), controller.signal)
      if (channels.length === 0) {
        return [unready('The signed-in Google account owns no YouTube channel, so there is nowhere to upload to. '
          + 'Create a channel on youtube.com with that account.')]
      }
      return channels.map(channel => ready(channel))
    } catch (error) {
      return [unready(error instanceof Error ? error.message : String(error))]
    }
  }

  /**
   * Upload one video.
   *
   * The seam's request is a text post with attachments, and this is where it
   * becomes a video: the attachment with `kind: 'video'` is the file, the first
   * line of `text` is the title, and the rest is the description. Everything
   * that can be refused without touching Google — a post with no video, a first
   * line too long to be a title — is refused before the first HTTP call.
   * @param request - the target, the text, and the video to upload.
   * @returns the video id, its watch URL, and what YouTube actually did with it.
   * @throws when the request is not a video post, or when Google refuses it.
   */
  async post(request: SocialPostRequest): Promise<SocialPostResult> {
    if (!request.target.startsWith(TARGET_PREFIX)) {
      throw new Error(`"${request.target}" is not a YouTube target; they are named ${TARGET_PREFIX}<channel id>.`)
    }
    const media = request.media ?? []
    const videos = media.filter(item => item.kind === 'video')
    const attachment = videos[0]
    if (attachment === undefined) {
      throw new Error(`A YouTube post must carry the video to upload, and this one carries ${media.length === 0
        ? 'no attachment'
        : `only ${String(media.length)} non-video attachment(s)`}. ${MAPPING_MESSAGE}`)
    }
    if (videos.length > 1) {
      throw new Error(`A YouTube upload is one video, and this post carries ${String(videos.length)}. ${MAPPING_MESSAGE}`)
    }
    const { title, description } = splitPost(request.text)
    const file = await describeVideoFile(attachment.path)

    const controller = new AbortController()
    const settings = await this.settings()
    const token = await this.accessToken(settings, controller.signal)
    const channel = await this.resolveChannel(settings, token, request.target, controller.signal)
    const metadata: VideoMetadata = {
      snippet: { title, description, categoryId: this.config.categoryId },
      status: { privacyStatus: this.config.privacyStatus, selfDeclaredMadeForKids: this.config.madeForKids },
    }
    const session = await initiateUpload(settings, token, metadata, file, controller.signal)
    const video = await sendVideo(settings, token, session, file, controller.signal)
    return {
      id: video.id,
      url: `https://www.youtube.com/watch?v=${video.id}`,
      notes: [`Uploaded to ${channel.title}.`, ...describeOutcome(video, this.config.privacyStatus)],
    }
  }

  /**
   * Obtain and store the refresh token, as the authorization seam's flow.
   * @param session - the attempt's method, signal, notices, and prompts.
   * @throws when the human declines, the exchange fails, or Google issues no
   *   refresh token — a grant that cannot renew itself is not one this provider
   *   will store.
   */
  async authorize(session: AuthorizationSession): Promise<void> {
    const settings = await this.settings()
    const state = randomUUID()
    session.notify({
      message: 'Open this page, approve YouTube upload and read access, then copy the whole address you are sent to '
        + `afterwards — ${settings.redirectUri} will probably not load, and that is fine.`,
      url: authorizationUrl(settings, state),
    })
    const pasted = await session.prompt({
      kind: 'text',
      message: 'Paste the address you were redirected to (or just its code parameter).',
      placeholder: `${settings.redirectUri}/?code=...`,
    })
    const grant = await exchangeCode(settings, readAuthorizationCode(pasted, state), session.signal)
    if (grant.refreshToken === undefined) {
      throw new Error('Google returned no refresh token, so this credential could not renew itself. '
        + 'Remove this application under myaccount.google.com/permissions and sign in again, so the consent screen '
        + 'issues a new one.')
    }
    const missing = SCOPES.filter(scope => !grant.scopes.includes(scope))
    if (missing.length > 0) {
      throw new Error(`The sign-in granted ${grant.scopes.join(', ') || 'no scopes'}, and this provider needs `
        + `${missing.join(' and ')}. Approve every permission on the consent screen.`)
    }
    this.token = grant.access
    const channel = (await listChannels(settings, grant.access.accessToken, session.signal))[0]
    const payload: YouTubeGrant = {
      version: 1,
      refreshToken: grant.refreshToken,
      scopes: grant.scopes,
      obtainedAt: Date.now(),
      ...channel === undefined ? {} : { channelId: channel.id, channelTitle: channel.title },
    }
    const record: CredentialRecord = { kind: 'grant', payload }
    await this.ctx.credentials.modifyRecord(this.key, () => Promise.resolve(record))
  }

  /** The stored grant, or what to do about there not being one. */
  private async grant(): Promise<YouTubeGrant> {
    const record = await this.ctx.credentials.readRecord(this.key)
    if (record === undefined) {
      throw new Error(`No YouTube account is authorized. Authorize the credential "${this.key}" — the sign-in asks `
        + `for offline access, so it only has to happen once. ${VERIFICATION_MESSAGE}`)
    }
    if (record.kind !== 'grant') {
      throw new Error(`The credential "${this.key}" holds a ${record.kind} record, and this provider stores an OAuth `
        + 'grant. Delete it and authorize again.')
    }
    const payload = record.payload as Partial<YouTubeGrant> | null
    if (payload?.refreshToken === undefined || payload.refreshToken === '') {
      throw new Error(`The stored YouTube grant carries no refresh token. Authorize the credential "${this.key}" again.`)
    }
    return payload as YouTubeGrant
  }

  /**
   * The access token every call carries, minted from the refresh token and kept
   * until it is near its expiry — one sign-in's worth of uploads costs one
   * refresh, not one per call.
   */
  private async accessToken(settings: OAuthSettings, signal: AbortSignal): Promise<string> {
    const cached = this.token
    if (tokenUsable(cached, Date.now())) return cached.accessToken
    const grant = await this.grant()
    const minted = await refreshAccessToken(settings, grant.refreshToken, signal)
    this.token = minted
    return minted.accessToken
  }

  /** Which channel a target id names, refusing one this account does not own. */
  private async resolveChannel(
    settings: ApiSettings,
    token: string,
    target: string,
    signal: AbortSignal,
  ): Promise<YouTubeChannel> {
    const channels = await listChannels(settings, token, signal)
    const first = channels[0]
    if (first === undefined) {
      throw new Error('The signed-in Google account owns no YouTube channel, so there is nowhere to upload to.')
    }
    if (target === MINE) return first
    const wanted = target.slice(TARGET_PREFIX.length)
    const match = channels.find(channel => channel.id === wanted)
    if (match === undefined) {
      throw new Error(`The authorized account does not own channel ${wanted}; it owns `
        + `${channels.map(channel => `${TARGET_PREFIX}${channel.id}`).join(', ')}.`)
    }
    return match
  }

  /** Where Google is and who this harness signs in as, resolved per call so a changed secret takes effect at once. */
  private async settings(): Promise<OAuthSettings & ApiSettings> {
    const clientId = await this.clientCredential(this.config.clientId, this.config.clientIdRef, 'client id')
    const clientSecret = await this.clientCredential(this.config.clientSecret, this.config.clientSecretRef, 'client secret')
    return {
      clientId,
      clientSecret,
      redirectUri: this.config.redirectUri,
      authBaseUrl: this.config.authBaseUrl,
      tokenBaseUrl: this.config.tokenBaseUrl,
      apiBaseUrl: this.config.apiBaseUrl,
      uploadBaseUrl: this.config.uploadBaseUrl,
      timeoutMs: this.config.timeoutMs,
      chunkBytes: this.config.chunkBytes,
      chunkTimeoutMs: this.config.chunkTimeoutMs,
      uploadRetries: this.config.uploadRetries,
      notifySubscribers: this.config.notifySubscribers,
    }
  }

  /** One half of the OAuth client, taken from config or resolved through the credential seam. */
  private async clientCredential(inline: string, ref: string, what: string): Promise<string> {
    if (inline !== '') return inline
    const resolved = isCredentialRefName(ref) ? await this.ctx.credentials.resolve(credentialRef(ref)) : undefined
    if (resolved === undefined || resolved.value === '') {
      throw new Error(`No Google OAuth ${what} is configured: set the ${ref} environment variable, or give this `
        + 'plugin the value directly in its config.')
    }
    return resolved.value
  }
}

/** One ready channel, carrying the mapping and the two limits a caller has to know. */
function ready(channel: YouTubeChannel): SocialTarget {
  return {
    id: `${TARGET_PREFIX}${channel.id}`,
    provider: PROVIDER,
    label: `${channel.title} (YouTube channel)`,
    accepts: { text: false, image: false, video: true },
    ready: true,
    reason: `${MAPPING_MESSAGE} ${QUOTA_NOTICE} ${VERIFICATION_MESSAGE}`,
  }
}

/** The one target a provider that cannot list channels still offers, so the reason is visible. */
function unready(reason: string): SocialTarget {
  return {
    id: MINE,
    provider: PROVIDER,
    label: 'YouTube (not authorized)',
    accepts: { text: false, image: false, video: true },
    ready: false,
    reason,
  }
}

/**
 * Register the YouTube provider and the sign-in that gives it a credential.
 * @param ctx - the plugin context, injecting `social`, `credentials`, and `authorization`.
 * @param config - validated composition config.
 * @throws when the chunk size is not a multiple of the 262144 bytes Google
 *   requires, which is a misconfiguration nothing later can recover from.
 */
export function apply(ctx: Context, config: Config): void {
  if (config.chunkBytes % CHUNK_GRANULARITY !== 0) {
    throw new Error(`social-youtube chunkBytes must be a multiple of ${String(CHUNK_GRANULARITY)} bytes; `
      + `${String(config.chunkBytes)} is not.`)
  }
  const key = credentialKey(name, 'oauth')
  const provider = new YouTubeProvider(ctx, config, key)

  ctx.effect(() => ctx.authorization.registerFlow({
    key,
    label: 'YouTube (upload)',
    methods: [{ id: 'google', label: 'Sign in with Google' }],
    run: session => provider.authorize(session),
  }), 'social-youtube: authorization flow')

  ctx.effect(() => ctx.social.register(provider), 'social-youtube: provider')

  // A re-authorization replaces the refresh token; the access token minted from
  // the old one is no longer the credential this provider was given.
  ctx.on('credentials/record-updated', (updated) => {
    if (updated === key) provider.forgetToken()
  })
}
