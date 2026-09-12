/**
 * Social-posting provider registry.
 *
 * This package owns the Service Definition role of the social capability seam.
 * Concrete providers such as a LinkedIn or a Meta plugin decide what a target
 * is and how a post is published; this service only keeps the provider roster,
 * merges their target lists into one addressable namespace, and routes a post
 * to the provider owning the requested target id.
 *
 * It knows no platform. There is no provider-specific field and no per-platform
 * branch anywhere in this package: a target id, the `accepts` flags, and the
 * `ready`/`reason` pair are the whole vocabulary a provider speaks through.
 *
 * The routing rule is what keeps that namespace unambiguous: a provider name
 * carries no `:` and is unique in the registry, and every target id a provider
 * lists must start with `<name>:`. Two providers therefore cannot claim one id,
 * and the registry enforces the rule on every listing rather than trusting it.
 * The registry refuses rather than guesses — an unknown id lists what exists, an
 * unready target refuses with the provider's own reason, and an attachment a
 * target does not accept fails here, naming the target, before any provider is
 * called.
 *
 * @module @deepseek-ai/dsh-social
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Social, SocialPostRequest, SocialPostResult, SocialProvider, SocialTarget } from './types.ts'

export type {
  Social,
  SocialMedia,
  SocialPostRequest,
  SocialPostResult,
  SocialProvider,
  SocialTarget,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    social: SocialRegistry
  }
}

/**
 * A registrable provider name: non-empty, and free of `:` and whitespace. The
 * colon is the target-id separator, so a name carrying one would make
 * `<name>:<rest>` ambiguous between two registrations.
 */
const PROVIDER_NAME = /^[^\s:]+$/

/** One addressable target plus the provider that must publish to it. */
interface SocialEntry {
  /** The target as the model and the approving human see it. */
  readonly target: SocialTarget
  /** The owning provider, absent on a registry-authored diagnostic entry. */
  readonly provider?: SocialProvider
}

/**
 * The listing a provider produced, or the failure it produced instead. A
 * failure is one provider's problem; the other providers' targets still list.
 */
type Observation =
  | { readonly provider: SocialProvider; readonly targets: readonly SocialTarget[] }
  | { readonly provider: SocialProvider; readonly failure: string }

/**
 * A registry-authored stand-in for a provider that could not be listed, or
 * whose listing this registry cannot address. It is a target so the fault is
 * visible in the catalog next to the working targets instead of vanishing from
 * it, and it is never ready, so posting to it refuses with the same reason.
 * Its id is the bare provider name, which no valid target id can be: a valid
 * one carries `:` and something after it.
 * @param name - the provider whose listing failed.
 * @param reason - what went wrong, as the model and the operator read it.
 * @returns the unready stand-in target.
 */
function unavailableTarget(name: string, reason: string): SocialTarget {
  return {
    id: name,
    provider: name,
    label: `${name} (unavailable)`,
    accepts: { text: false, image: false, video: false },
    ready: false,
    reason,
  }
}

/**
 * Registry of social-posting providers and the router in front of them.
 *
 * `register()` files each provider into the calling context's fiber, so a
 * disposed provider plugin removes its targets from every later listing.
 * Reads re-ask every provider: `ready` is a live fact about a credential, and a
 * cached "ready" would publish under someone's name on the strength of a stale
 * observation.
 */
export class SocialRegistry extends Service implements Social {
  private readonly providers = new Map<string, SocialProvider>()

  constructor(ctx: Context) {
    super(ctx, 'social')
  }

  /**
   * Register one borrowed same-process provider. The name must be unique and
   * free of `:` and whitespace, because it is the prefix that makes every
   * target id this provider lists resolve to exactly this registration.
   * @param provider - the platform implementation to register.
   * @returns the exact Cordis effect disposer that unregisters it; disposing
   *   the registering fiber does the same.
   */
  register(provider: SocialProvider): () => void {
    const name = provider.name
    if (!PROVIDER_NAME.test(name)) {
      throw new Error(`invalid social provider name ${JSON.stringify(name)}: a name must be non-empty and contain no ":" or whitespace`)
    }
    if (this.providers.has(name)) {
      throw new Error(`a social provider named ${JSON.stringify(name)} is already registered`)
    }
    // oxlint-disable-next-line typescript/no-misused-promises -- exact synchronous disposer preserves Cordis effect identity
    return this.ctx.effect(() => {
      this.providers.set(name, provider)
      return () => {
        if (this.providers.get(name) === provider) this.providers.delete(name)
      }
    }, `social.register(${name})`)
  }

  /**
   * Every target across every registered provider, ready or not.
   * @returns the merged targets, ordered by id so the catalog is stable.
   */
  async targets(): Promise<readonly SocialTarget[]> {
    return [...(await this.collect()).values()].map(entry => entry.target)
  }

  /**
   * Publish one post through the provider owning `request.target`.
   *
   * Every refusal happens here, before the provider is called: an unknown id
   * lists the ids that exist, an unready target carries the provider's own
   * reason, and an attachment or a body the target does not accept fails
   * naming the target rather than surfacing a platform error from inside a
   * provider.
   * @param request - the target id, the text to publish verbatim, and any attachments.
   * @returns what the owning provider created.
   * @throws when the target is unknown, unready, or does not accept what the
   *   request carries.
   */
  async post(request: SocialPostRequest): Promise<SocialPostResult> {
    const entries = await this.collect()
    const entry = entries.get(request.target)
    if (entry === undefined) {
      const known = [...entries.keys()]
      throw new Error(known.length === 0
        ? `no social target ${JSON.stringify(request.target)}: no social provider is registered`
        : `no social target ${JSON.stringify(request.target)}; these exist: ${known.join(', ')}`)
    }
    const { target, provider } = entry
    if (provider === undefined || !target.ready) {
      throw new Error(`social target ${JSON.stringify(target.id)} (${target.label}) is not ready: ${target.reason ?? 'the provider gave no reason'}`)
    }
    const media = request.media ?? []
    if (request.text === '' && media.length === 0) {
      throw new Error(`nothing to post to ${JSON.stringify(target.id)} (${target.label}): the request carries neither text nor media`)
    }
    if (request.text !== '' && !target.accepts.text) {
      throw new Error(`social target ${JSON.stringify(target.id)} (${target.label}) does not accept text`)
    }
    for (const item of media) {
      if (!target.accepts[item.kind]) {
        throw new Error(`social target ${JSON.stringify(target.id)} (${target.label}) does not accept ${item.kind}: ${item.path}`)
      }
    }
    return await provider.post(request)
  }

  /**
   * Ask every provider for its targets at once and merge the answers into one
   * id-keyed namespace. A provider that throws, and a provider that lists a
   * target this registry cannot address, each contribute one unready
   * diagnostic entry instead of removing the other providers from the result.
   * @returns the merged entries, ordered by target id.
   */
  private async collect(): Promise<Map<string, SocialEntry>> {
    const observations = await Promise.all([...this.providers.values()].map(
      async (provider): Promise<Observation> => {
        try {
          return { provider, targets: await provider.targets() }
        } catch (error) {
          return { provider, failure: error instanceof Error ? error.message : String(error) }
        }
      },
    ))
    const entries: SocialEntry[] = []
    const claimed = new Set<string>()
    for (const observation of observations) {
      const name = observation.provider.name
      if ('failure' in observation) {
        entries.push({ target: unavailableTarget(name, `listing this provider's targets failed: ${observation.failure}`) })
        continue
      }
      const prefix = `${name}:`
      const defects: string[] = []
      for (const target of observation.targets) {
        if (!target.id.startsWith(prefix) || target.id.length === prefix.length) {
          defects.push(`${JSON.stringify(target.id)} does not start with ${JSON.stringify(prefix)}`)
          continue
        }
        if (target.provider !== name) {
          defects.push(`${JSON.stringify(target.id)} names provider ${JSON.stringify(target.provider)}`)
          continue
        }
        if (claimed.has(target.id)) {
          defects.push(`${JSON.stringify(target.id)} was listed more than once`)
          continue
        }
        claimed.add(target.id)
        entries.push({ target, provider: observation.provider })
      }
      if (defects.length > 0) {
        entries.push({ target: unavailableTarget(name, `this provider listed targets the registry cannot address: ${defects.join('; ')}`) })
      }
    }
    entries.sort((left, right) => left.target.id < right.target.id ? -1 : left.target.id > right.target.id ? 1 : 0)
    return new Map(entries.map(entry => [entry.target.id, entry]))
  }
}

export default SocialRegistry
