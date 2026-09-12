/**
 * Vocabulary of the social-posting capability seam: what a place to post is,
 * what may be attached, what one post request and its result carry, and the
 * two interfaces the seam's providers and consumers implement and call.
 *
 * The types are platform-neutral on purpose. Nothing here names LinkedIn,
 * Meta, or Google, and no field exists to carry a platform-specific payload;
 * a provider that needs one owns it privately behind {@link SocialProvider}.
 *
 * @module @deepseek-ai/dsh-social/types
 */

/** One place a post can go: an account, a Page, a channel. */
export interface SocialTarget {
  /** Stable id the model names, e.g. `linkedin:member` or `facebook:page:1234`. */
  id: string
  /** The provider that owns it, e.g. `linkedin`. */
  provider: string
  /** What a human calls it, e.g. `Ada Obi (personal)` or `FrontStaff (Page)`. */
  label: string
  /** What this target will accept. */
  accepts: { text: boolean; image: boolean; video: boolean }
  /** False when the credential is missing, expired, or lacks the scope. */
  ready: boolean
  /** Why it is not ready, and what to do about it. */
  reason?: string
}

/** A file to attach, already on disk. */
export interface SocialMedia {
  /** Absolute path, inside the session workspace. */
  path: string
  /** Which of a target's `accepts` flags this attachment needs. */
  kind: 'image' | 'video'
  /** Alt text. Providers that support it must send it. */
  alt?: string
}

/** One post a consumer asks the seam to publish. */
export interface SocialPostRequest {
  /** A `SocialTarget.id`. */
  target: string
  /** The post body, published byte for byte as the caller supplied it. */
  text: string
  /** Attachments, in the order they should appear. */
  media?: readonly SocialMedia[]
}

/** What the platform created, as the provider reports it back. */
export interface SocialPostResult {
  /** The provider's own id for the created post. */
  id: string
  /** Where a human can go and look at it. */
  url?: string
  /**
   * What the platform did that the request did not ask for, in the platform's
   * own terms: a video YouTube made private although public was requested, an
   * image posted without alt text, a caption the platform truncated.
   *
   * Two providers arrived at this field independently, which is the argument
   * for it being in the contract rather than in each of them. Without it the
   * only thing a caller can report is that the request was accepted — and
   * "published" said about a video nobody can see is worse than saying nothing.
   */
  notes?: readonly string[]
}

/** One platform's implementation of the seam: the targets it owns, and publishing to them. */
export interface SocialProvider {
  /**
   * Registry-unique platform name, and the mandatory prefix of every target id
   * this provider lists. It carries no `:`, so one id resolves to one provider.
   */
  readonly name: string
  /**
   * List every target this provider owns right now, ready or not.
   * @returns the provider's targets; an unusable one is reported `ready: false`
   *   with its `reason` rather than omitted.
   */
  targets(): Promise<readonly SocialTarget[]>
  /**
   * Publish one post to a target this provider owns.
   * @param request - the target id, the text to publish verbatim, and any attachments.
   * @returns the platform's id for the created post, and a human-visible URL when it has one.
   */
  post(request: SocialPostRequest): Promise<SocialPostResult>
}

/** Registered on `ctx.social`. */
export interface Social {
  /**
   * Add one provider to the registry.
   * @param provider - the platform implementation to register.
   * @returns the disposer that unregisters it.
   */
  register(provider: SocialProvider): () => void
  /**
   * Every target across every registered provider, ready or not.
   * @returns the merged, id-ordered target list.
   */
  targets(): Promise<readonly SocialTarget[]>
  /**
   * Route to the provider owning `request.target`.
   * @param request - the target id, the text, and any attachments.
   * @returns what the owning provider created.
   */
  post(request: SocialPostRequest): Promise<SocialPostResult>
}
