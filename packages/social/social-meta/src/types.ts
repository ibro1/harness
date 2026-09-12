/**
 * Types for the Meta social provider: the social seam's publishing contract,
 * restated structurally, and the records this package stores for itself.
 *
 * The `Social*` members are declared here rather than imported from the social
 * seam on purpose. Both packages are being written at once, and a provider that
 * imported the seam's declarations could not compile until the seam did; a
 * structural restatement keeps the two builds independent while a mismatch
 * still fails at the one place they meet — `ctx.social.register()`.
 *
 * @module @deepseek-ai/dsh-social-meta/types
 */

/** What one target accepts in a post; `text` means a post carrying no media at all. */
export interface SocialAccepts {
  /** Whether a text-only post is accepted. */
  text: boolean
  /** Whether an image may be attached. */
  image: boolean
  /** Whether a video may be attached. */
  video: boolean
}

/** One place a post can go, and whether it can go there right now. */
export interface SocialTarget {
  /**
   * Stable address of the destination. The registry requires every id to begin
   * with its provider's name and carry something after it, so these are
   * `facebook:page:<page-id>` and `instagram:<ig-user-id>`.
   */
  id: string
  /** The provider that listed this target; the registry rejects a target naming another. */
  provider: string
  /** Human-facing name of the destination. */
  label: string
  /** What this destination accepts. */
  accepts: SocialAccepts
  /** Whether a post to this target would be attempted at all. */
  ready: boolean
  /**
   * Why the target is not ready, or — on a ready target — what is about to stop
   * being true, such as a user token within days of expiring.
   */
  reason?: string
}

/** One local or remote file attached to a post. */
export interface SocialMedia {
  /** Filesystem path, or an `http(s)` URL when the file is already published. */
  path: string
  /** Which Graph edge the file is published through. */
  kind: 'image' | 'video'
  /** Accessibility text, sent as the Instagram container's `alt_text`. */
  alt?: string
}

/** One request to publish. */
export interface SocialPostRequest {
  /** The {@link SocialTarget.id} to publish to. */
  target: string
  /** The message body: a Page post's message, or an Instagram caption. */
  text: string
  /** The files to attach; Instagram requires exactly one. */
  media?: readonly SocialMedia[]
}

/** What one published post is addressed by afterwards. */
export interface SocialPostResult {
  /** The network's own id for the post. */
  id: string
  /** A page a human can open, when the network's response gives one. */
  url?: string
}

/** The publishing contract the social seam collects from every provider. */
export interface SocialProvider {
  /** Provider name, unique across registered providers and free of `:`; every target id begins with it. */
  readonly name: string
  /**
   * Every destination this provider currently holds credentials for.
   * @returns the targets, each carrying whether it can publish right now.
   */
  targets(): Promise<readonly SocialTarget[]>
  /**
   * Publish one post.
   * @param request - the target, the text, and any media.
   * @returns the published post's id, and its URL when the network returns one.
   */
  post(request: SocialPostRequest): Promise<SocialPostResult>
}

/** The half of `ctx.social` this package uses: registration returns the disposer. */
export interface SocialRegistry {
  /**
   * Contribute one provider.
   * @param provider - the provider to register.
   * @returns Disposer that withdraws it.
   */
  register(provider: SocialProvider): () => void
}

/** One Facebook Page the authorized user manages, as `/me/accounts` reports it. */
export interface MetaPage {
  /** Page id. */
  id: string
  /** Page name, used as the target label. */
  name: string
  /** The Page access token derived from the user token; this is what publishes. */
  accessToken: string
  /** The Instagram professional account linked to this Page, when there is one. */
  instagram?: {
    /** Instagram user id, the `ig-user-id` the publishing edges take. */
    id: string
    /** Instagram handle, when the Graph API returned it. */
    username?: string
  }
}

/**
 * What this package stores in its credential record, as a `GrantRecord`
 * payload. Page access tokens are deliberately absent: they are derived from
 * the user token on every operation, so a Page added, removed, or renamed
 * between posts is seen without a re-authorization.
 */
export interface MetaGrant {
  /** Payload format version; a record written by an older format is refused, not guessed at. */
  version: 1
  /** The long-lived user access token every call is made with. */
  userToken: string
  /**
   * Epoch milliseconds at which {@link userToken} stops working, from the
   * exchange's `expires_in`. Absent when Meta returned no expiry, which is the
   * documented answer for a token that does not expire on its own.
   */
  expiresAt?: number
  /** Epoch milliseconds at which the token was obtained. */
  obtainedAt: number
  /** The permissions Meta reported as granted at authorization time. */
  grantedScopes: string[]
}
