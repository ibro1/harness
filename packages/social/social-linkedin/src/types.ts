/**
 * Type surface of the LinkedIn social provider: the social-seam vocabulary this
 * package implements, and the grant payload it stores through the credential
 * seam.
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
 * @module @deepseek-ai/dsh-social-linkedin/types
 */

/** One place a post can go, as the social seam describes it. */
export interface SocialTarget {
  /** Stable id a post request names, such as `linkedin:member` or `linkedin:org:123`. */
  id: string
  /** The provider that owns this target; always `linkedin` here. */
  provider: string
  /** What a human calls this target. */
  label: string
  /** Which attachment kinds this target accepts. */
  accepts: { text: boolean; image: boolean; video: boolean }
  /** False when the credential is missing, expired, or lacks the scope this target needs. */
  ready: boolean
  /** Why the target is not ready, and what to do about it. */
  reason?: string
}

/** One local file attached to a post. */
export interface SocialMedia {
  /** Absolute path of the file to upload. */
  path: string
  /** Which upload path the file takes. */
  kind: 'image' | 'video'
  /** Accessibility description; required by LinkedIn for an image to be described at all. */
  alt?: string
}

/** One request to publish a post. */
export interface SocialPostRequest {
  /** The {@link SocialTarget.id} to post to. */
  target: string
  /** The post body. */
  text: string
  /** Files to attach; LinkedIn attaches at most one. */
  media?: readonly SocialMedia[]
}

/**
 * What a published post came back as.
 *
 * `notes` is additive: the seam's own result declares `id` and `url` only, and
 * a result carrying an extra optional field still satisfies it. It exists
 * because a post can succeed while something about it deserves saying — an
 * image went up with no alt text, or a second attachment was dropped — and a
 * thrown error would be wrong for a post that did publish.
 */
export interface SocialPostResult {
  /** The provider's id for the published post; the post URN here. */
  id: string
  /** Where a human can read the post. */
  url?: string
  /** Facts about this post a human should know, when there are any. */
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
   * @param request - the target, the text, and any attachments.
   * @returns the published post's id, its URL, and any notes about it.
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
 * The expiry is absolute rather than a lifetime, because the only question
 * asked of it later is "how long is left", and a `expires_in` seconds count
 * cannot answer that once the process that received it is gone.
 */
export interface LinkedInGrant {
  /** The bearer token every API call carries. */
  accessToken: string
  /** Epoch milliseconds at which the token stops working. */
  expiresAt: number
  /** Epoch milliseconds at which the sign-in happened, for the README's 60-day arithmetic. */
  obtainedAt: number
  /** The scopes LinkedIn actually granted, as returned by the token exchange. */
  scopes: readonly string[]
  /** The signed-in member's id — the OpenID `sub` claim, which is the `urn:li:person:` suffix. */
  memberId: string
  /** The signed-in member's display name, when userinfo supplied one. */
  memberName?: string
}

/** One organization page the signed-in member administers. */
export interface LinkedInOrganization {
  /** The numeric organization id, the `urn:li:organization:` suffix. */
  id: string
  /** The page's name, or the URN when the name could not be read. */
  name: string
}
