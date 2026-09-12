/**
 * Type surface of the YouTube social provider: the social-seam vocabulary this
 * package implements, the grant payload it stores through the credential seam,
 * and the pieces of YouTube's own JSON it reads back.
 *
 * The social types are declared structurally here rather than imported from
 * `@deepseek-ai/dsh-social`. Both packages are being written at once, so an
 * import would make this package fail to compile whenever the seam is mid-edit;
 * structural declaration keeps the two build-independent while still holding
 * this provider to the published member names. The seam accepts this provider
 * because the shapes match, not because a nominal type was shared.
 *
 * Types only — no runtime code.
 *
 * @module @deepseek-ai/dsh-social-youtube/types
 */

/** One place a post can go, as the social seam describes it. */
export interface SocialTarget {
  /** Stable id a post request names; always `youtube:channel:<id>` here. */
  id: string
  /** The provider that owns this target; always `youtube` here. */
  provider: string
  /** What a human calls this target. */
  label: string
  /** Which attachment kinds this target accepts. */
  accepts: { text: boolean; image: boolean; video: boolean }
  /** False when the credential is missing, rejected, or lacks the upload scope. */
  ready: boolean
  /** Why the target is not ready, or — on a ready target — how `text` and `media` are mapped onto a video. */
  reason?: string
}

/** One local file attached to a post. */
export interface SocialMedia {
  /** Absolute path of the file to upload. */
  path: string
  /** Which upload path the file takes; this provider uploads only `video`. */
  kind: 'image' | 'video'
  /** Accessibility description. YouTube has no field for it, so it is ignored here. */
  alt?: string
}

/** One request to publish a post. */
export interface SocialPostRequest {
  /** The {@link SocialTarget.id} to post to. */
  target: string
  /** The post body: the first line becomes the video title, the rest its description. */
  text: string
  /** Files to attach; exactly one `video` is required, and nothing else is accepted. */
  media?: readonly SocialMedia[]
}

/**
 * What a published post came back as.
 *
 * `notes` is additive: the seam's own result declares `id` and `url` only, and
 * a result carrying an extra optional field still satisfies it. It exists
 * because an upload can succeed while YouTube quietly did something other than
 * what was asked — an unverified application's video forced to `private`, or a
 * video still being processed — and a thrown error would be wrong for an upload
 * that did land. The provider reports what YouTube actually did, here.
 */
export interface SocialPostResult {
  /** The provider's id for the published post; the YouTube video id here. */
  id: string
  /** Where a human can watch the video. */
  url?: string
  /** Facts about this upload a human should know, when there are any. */
  notes?: readonly string[]
}

/** What the social seam registers: one provider per network. */
export interface SocialProvider {
  /** The provider name targets are keyed by. */
  readonly name: string
  /**
   * Every place this provider could post to right now.
   * @returns the targets, each carrying whether it is ready and why not.
   */
  targets(): Promise<readonly SocialTarget[]>
  /**
   * Publish one post.
   * @param request - the target, the text, and the video to upload.
   * @returns the uploaded video's id, its watch URL, and any notes about it.
   */
  post(request: SocialPostRequest): Promise<SocialPostResult>
}

/**
 * The registry half of `ctx.social`, as this package uses it.
 *
 * Declared structurally for the same reason as the types above, and reached
 * through a cast rather than a `declare module` augmentation: two packages
 * augmenting `Context` with their own `social` property would collide at
 * compile time, and the seam owns that declaration.
 */
export interface SocialRegistry {
  /**
   * Add one provider.
   * @param provider - the provider to register.
   * @returns Disposer that removes it.
   */
  register(provider: SocialProvider): () => void
}

/**
 * The credential record this plugin stores after a sign-in, kept verbatim by
 * the credential seam as a `grant` payload.
 *
 * Only the refresh token is durable. Google's access tokens live an hour, and
 * storing one would put a value that is stale within the hour into a record
 * whose whole purpose is to outlive the process; the access token is minted
 * from this refresh token on demand and cached in memory alone.
 */
export interface YouTubeGrant {
  /** Payload format, so a later change can tell an old record apart from a new one. */
  version: 1
  /** The long-lived refresh token Google issued for `access_type=offline`. */
  refreshToken: string
  /** The scopes Google actually granted, which can be narrower than the ones asked for. */
  scopes: readonly string[]
  /** Epoch milliseconds at which the sign-in happened. */
  obtainedAt: number
  /** The channel the sign-in was for, when `channels.list` answered during the flow. */
  channelId?: string
  /** That channel's title, for a label a human recognizes. */
  channelTitle?: string
}

/** One access token minted from the stored refresh token, held in memory only. */
export interface MintedToken {
  /** The bearer token every API call carries. */
  accessToken: string
  /** Epoch milliseconds after which the token must be minted again. */
  expiresAt: number
}

/** One channel the signed-in account owns, from `channels.list?mine=true`. */
export interface YouTubeChannel {
  /** The channel id — the `youtube:channel:<id>` suffix. */
  id: string
  /** The channel title, or the id when `snippet` was not asked for. */
  title: string
}

/**
 * The parts of an uploaded video resource this provider reads back.
 *
 * Field names are YouTube Data API v3's own (`videos.insert` response
 * resource); the provider reports `status.privacyStatus` and
 * `status.uploadStatus` as facts rather than assuming the request was honored.
 */
export interface UploadedVideo {
  /** The video id. */
  id: string
  /** What YouTube actually set, which is not necessarily what was requested. */
  privacyStatus?: string
  /** `uploaded`, `processed`, `failed`, `rejected`, or `deleted`. */
  uploadStatus?: string
  /** Why a `rejected` video was rejected, when YouTube said. */
  rejectionReason?: string
  /** Why a `failed` upload failed, when YouTube said. */
  failureReason?: string
}
