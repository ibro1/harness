/**
 * Human-facing HTTP routes for the social capability: what this harness can
 * post to right now, and disconnecting one provider's stored credential.
 *
 * These routes exist because **state is not configuration**. A LinkedIn token
 * that lapses in four days is a fact somebody should be able to see, and before
 * these routes the only way to learn it was to ask the agent to list targets.
 * Nothing here edits a credential into place: an account is still connected by
 * asking the agent, which walks the provider's authorization flow and stores
 * the grant through the credential seam. The only write here is a removal.
 *
 * No secret crosses these routes. `GET /social/status` builds every target view
 * field by field from {@link SocialTarget}, so a provider that one day adds a
 * field to its listing cannot leak it here, and the credential seam's read half
 * is never called — not `resolve`, not `readRecord`. The disconnect route names
 * a credential *address* (`<scope>/<id>`), which is the record's key and not its
 * value.
 *
 * @module @deepseek-ai/dsh-tool-social/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { credentialKeyScope, parseCredentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialKey, CredentialRecordEntry } from '@deepseek-ai/dsh-credentials'
import type { SocialTarget } from '@deepseek-ai/dsh-social'
// Type-only merge: declares `Context.webServer`, which `inject` makes present.
import type {} from '@deepseek-ai/dsh-host-webserver'

/** Pathname of the read route. */
export const STATUS_PATH = '/social/status'

/** Pathname of the credential-removal route. */
export const DISCONNECT_PATH = '/social/disconnect'

/**
 * Largest `POST /social/disconnect` body that is read. The only field is one
 * provider name, so anything larger is not a request this route can serve.
 */
const MAX_BODY_BYTES = 4096

/**
 * How a provider name maps to the credential scope of the plugin that owns its
 * grant when the composition declares no mapping: the three providers shipped
 * in this group live in plugins named `social-<provider>`, and the credential
 * scope is the owning plugin's registered name.
 */
const DERIVED_SCOPE_PREFIX = 'social-'

/**
 * One target as a person reads it. Built field by field from
 * {@link SocialTarget} — never spread — so the wire carries exactly these
 * fields whatever a provider adds to its listing.
 */
export interface SocialTargetView {
  /** Stable id the agent names, e.g. `linkedin:member`. */
  id: string
  /** The provider that owns it, e.g. `linkedin`. */
  provider: string
  /** What a human calls it. */
  label: string
  /** What this target will accept. */
  accepts: { text: boolean; image: boolean; video: boolean }
  /** The provider's own readiness verdict. */
  ready: boolean
  /**
   * How this target should read to a person. `warning` is the case worth having
   * a name for: the provider says `ready: true` and still explains itself,
   * which is how a credential that works today but lapses shortly is reported.
   */
  state: 'ready' | 'warning' | 'blocked'
  /**
   * The provider's sentence, verbatim, whenever it gave one. Present on a
   * `ready: true` target too — see {@link SocialTargetView.state} — because a
   * warning with its reason dropped is indistinguishable from being fine.
   */
  reason?: string
}

/** One provider as the card offers it, including whether Disconnect can work. */
export interface SocialProviderView {
  /** Registry-unique provider name, the prefix of every target id it lists. */
  name: string
  /** How many targets it currently lists, ready or not. */
  targets: number
  /** Whether `POST /social/disconnect` would find a credential record to remove. */
  disconnectable: boolean
  /** Address (`<scope>/<id>`) of the record disconnecting would remove; never its value. */
  credentialKey?: string
  /** Other providers backed by that same record, which one disconnect also disconnects. */
  sharedWith: string[]
}

/** The `GET /social/status` body. */
export interface SocialStatusBody {
  /** Every target across every registered provider, ready or not, ordered by id. */
  targets: SocialTargetView[]
  /** One entry per provider currently listing targets, ordered by name. */
  providers: SocialProviderView[]
  /**
   * Target ids the composition exempts from the approval prompt. A target that
   * publishes without asking is the one thing on this surface a person might
   * not expect, so it is reported rather than left in a YAML file.
   */
  postWithoutApproval: string[]
}

/** The `POST /social/disconnect` body on success. */
export interface SocialDisconnectBody {
  /** The provider that was disconnected. */
  provider: string
  /** Address of the record that was removed. */
  credentialKey: string
  /** False when no record was stored, which is a no-op rather than a failure. */
  removed: boolean
  /** Other providers the removed record also backed. */
  alsoDisconnected: string[]
}

/** A refusal body. Every field but `error` is present only where it helps. */
export interface SocialErrorBody {
  /** What went wrong, in one sentence. */
  error: string
  /** Provider names the registry currently knows, on an unknown-provider refusal. */
  providers?: string[]
  /** Stored record addresses, on a refusal that needs the operator to pick one. */
  storedRecords?: string[]
}

/** What resolving a provider's credential address produced. */
type KeyResolution =
  | { readonly kind: 'resolved'; readonly key: CredentialKey }
  | { readonly kind: 'none' }
  | { readonly kind: 'ambiguous'; readonly candidates: readonly CredentialKey[] }

/** Write one JSON response and end it. */
function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(text)),
  })
  res.end(text)
}

/**
 * Read a small JSON request body.
 * @param req - the incoming request.
 * @returns the parsed value, or `undefined` when the body is unparseable,
 *   absent, or larger than {@link MAX_BODY_BYTES}.
 */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return await new Promise<unknown>((resolve) => {
    let text = ''
    let bytes = 0
    req.on('data', (chunk: Buffer | string) => {
      bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length
      if (bytes > MAX_BODY_BYTES) {
        req.destroy()
        resolve(undefined)
        return
      }
      text += String(chunk)
    })
    req.on('end', () => {
      if (text === '') {
        resolve(undefined)
        return
      }
      try {
        resolve(JSON.parse(text))
      } catch {
        // Swallows only the parse failure: an unparseable body is a bad request,
        // and the caller's refusal says so without an errno.
        resolve(undefined)
      }
    })
    req.on('error', () => { resolve(undefined) })
  })
}

/**
 * Project one target onto the wire view, whitelisting every field.
 * @param target - the target as the seam listed it.
 * @returns the view a person is shown.
 */
function targetView(target: SocialTarget): SocialTargetView {
  const reason = target.reason
  return {
    id: target.id,
    provider: target.provider,
    label: target.label,
    accepts: {
      text: target.accepts.text,
      image: target.accepts.image,
      video: target.accepts.video,
    },
    ready: target.ready,
    state: target.ready ? (reason === undefined ? 'ready' : 'warning') : 'blocked',
    ...reason === undefined ? {} : { reason },
  }
}

/**
 * The provider names currently listing targets, in a stable order.
 * @param targets - every target the seam listed.
 * @returns the distinct provider names, sorted.
 */
function providerNames(targets: readonly SocialTarget[]): string[] {
  return [...new Set(targets.map(target => target.provider))].sort()
}

/**
 * Validate every credential address the composition declared.
 *
 * A misconfigured address is a composition error, so it is refused at load
 * rather than at the moment somebody presses Disconnect.
 *
 * @param declared - the provider-name to credential-address map from config.
 * @returns the same map with each address branded as a {@link CredentialKey}.
 * @throws when an address is not a `<scope>/<id>` credential key.
 */
export function parseDeclaredKeys(declared: Readonly<Record<string, string>>): ReadonlyMap<string, CredentialKey> {
  const keys = new Map<string, CredentialKey>()
  for (const [provider, address] of Object.entries(declared)) {
    try {
      keys.set(provider, parseCredentialKey(address))
    } catch (error) {
      throw new Error(`tool-social: credentialKeys[${JSON.stringify(provider)}] is not a credential address: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return keys
}

/**
 * Find the credential record one provider's grant lives in.
 *
 * A declared address wins outright. Otherwise the stored records are searched
 * for a scope that is the provider's own name or `social-<provider>`, which is
 * how the providers in this group are packaged. The search never invents an
 * address: it only ever selects one the seam already reports as stored, and it
 * reports `none` rather than guessing when no scope or more than one matches —
 * `social-meta` serves both `facebook` and `instagram`, so neither derives, and
 * that composition must declare the address to disconnect either one.
 *
 * @param provider - the social provider name being disconnected.
 * @param declared - validated `credentialKeys` from config.
 * @param stored - every record the credential seam currently holds.
 * @returns the address to remove, or why one could not be chosen.
 */
function resolveKey(
  provider: string,
  declared: ReadonlyMap<string, CredentialKey>,
  stored: readonly CredentialRecordEntry[],
): KeyResolution {
  const explicit = declared.get(provider)
  if (explicit !== undefined) return { kind: 'resolved', key: explicit }
  const candidates = stored
    .map(entry => entry.key)
    .filter((key) => {
      const scope = credentialKeyScope(key)
      return scope === provider || scope === `${DERIVED_SCOPE_PREFIX}${provider}`
    })
  const only = candidates[0]
  if (candidates.length === 1 && only !== undefined) return { kind: 'resolved', key: only }
  return candidates.length === 0 ? { kind: 'none' } : { kind: 'ambiguous', candidates }
}

/**
 * Resolve each provider's credential address at once, so the status route can
 * say which Disconnect buttons will work and which providers share one record.
 * @param names - the provider names currently listing targets.
 * @param declared - validated `credentialKeys` from config.
 * @param stored - every record the credential seam currently holds, or `undefined` with no seam composed.
 * @returns provider name to resolved address, omitting the unresolvable.
 */
function resolveAllKeys(
  names: readonly string[],
  declared: ReadonlyMap<string, CredentialKey>,
  stored: readonly CredentialRecordEntry[] | undefined,
): ReadonlyMap<string, CredentialKey> {
  const resolved = new Map<string, CredentialKey>()
  if (stored === undefined) return resolved
  for (const name of names) {
    const resolution = resolveKey(name, declared, stored)
    if (resolution.kind === 'resolved') resolved.set(name, resolution.key)
  }
  return resolved
}

/**
 * Build the `GET /social/status` body.
 * @param ctx - the plugin context, carrying `ctx.social` and the optional credential seam.
 * @param exempt - target ids the composition allows to publish without asking.
 * @param declared - validated `credentialKeys` from config.
 * @returns every target, every provider, and the approval exemptions.
 */
async function socialStatus(
  ctx: Context,
  exempt: ReadonlySet<string>,
  declared: ReadonlyMap<string, CredentialKey>,
): Promise<SocialStatusBody> {
  const targets = await ctx.social.targets()
  const names = providerNames(targets)
  const credentials = ctx.get('credentials')
  const stored = credentials === undefined ? undefined : await credentials.listRecords()
  const keys = resolveAllKeys(names, declared, stored)
  return {
    targets: targets.map(targetView),
    providers: names.map((name) => {
      const key = keys.get(name)
      return {
        name,
        targets: targets.filter(target => target.provider === name).length,
        disconnectable: key !== undefined,
        ...key === undefined ? {} : { credentialKey: key },
        sharedWith: key === undefined
          ? []
          : names.filter(other => other !== name && keys.get(other) === key),
      }
    }),
    postWithoutApproval: [...exempt].sort(),
  }
}

/** What the disconnect operation decided, and the status to answer with. */
interface DisconnectOutcome {
  /** HTTP status. */
  readonly status: number
  /** The response body. */
  readonly body: SocialDisconnectBody | SocialErrorBody
}

/**
 * Remove one provider's stored credential record through the credential seam.
 *
 * Every refusal happens before `deleteRecord`: a body without a provider name,
 * a name no registered provider carries (answered with the names that exist), a
 * composition with no credential seam, and a provider whose record address
 * cannot be chosen (answered with the addresses that are stored) each refuse
 * without touching storage. Removing a provider that has no record stored is a
 * no-op reported as `removed: false`, because "nothing is connected" is the
 * state the caller asked for.
 *
 * @param ctx - the plugin context, carrying `ctx.social` and the optional credential seam.
 * @param declared - validated `credentialKeys` from config.
 * @param body - the parsed request body.
 * @returns the status to answer with, and what was removed or why nothing was.
 */
async function socialDisconnect(
  ctx: Context,
  declared: ReadonlyMap<string, CredentialKey>,
  body: unknown,
): Promise<DisconnectOutcome> {
  const requested = (body as { provider?: unknown } | undefined)?.provider
  if (typeof requested !== 'string' || requested === '') {
    return { status: 400, body: { error: 'disconnect needs a JSON body {"provider": "<name>"}.' } }
  }
  const names = providerNames(await ctx.social.targets())
  if (!names.includes(requested)) {
    return {
      status: 400,
      body: {
        error: names.length === 0
          ? `no social provider named ${JSON.stringify(requested)}: no social provider is registered.`
          : `no social provider named ${JSON.stringify(requested)}; these are registered: ${names.join(', ')}.`,
        providers: names,
      },
    }
  }
  const credentials = ctx.get('credentials')
  if (credentials === undefined) {
    return { status: 503, body: { error: `cannot disconnect ${JSON.stringify(requested)}: no credential service is composed, so there is no stored record to remove.`, providers: names } }
  }
  const stored = await credentials.listRecords()
  const resolution = resolveKey(requested, declared, stored)
  if (resolution.kind !== 'resolved') {
    const addresses = stored.map(entry => entry.key).sort()
    return {
      status: 409,
      body: {
        error: resolution.kind === 'ambiguous'
          ? `cannot disconnect ${JSON.stringify(requested)}: ${resolution.candidates.length} stored records could be its credential (${resolution.candidates.join(', ')}). Name the right one in this plugin's credentialKeys config.`
          : `cannot disconnect ${JSON.stringify(requested)}: no stored credential record is addressed to it. Name its record in this plugin's credentialKeys config.`,
        providers: names,
        storedRecords: addresses,
      },
    }
  }
  const key = resolution.key
  const keys = resolveAllKeys(names, declared, stored)
  const alsoDisconnected = names.filter(other => other !== requested && keys.get(other) === key)
  const present = (await credentials.describeRecord(key)).configured
  if (present) await credentials.deleteRecord(key)
  return {
    status: 200,
    body: {
      provider: requested,
      credentialKey: key,
      removed: present,
      alsoDisconnected,
    },
  }
}

/**
 * Mount the two human-facing routes on the composed web server.
 *
 * Neither route passes `authenticate`, so both take the web server's default:
 * they sit behind the deployment's password gate, like every other settings
 * surface. One of them reads the state of every connected account and the other
 * deletes a credential, so neither has any business answering an anonymous
 * caller.
 *
 * @param ctx - the plugin context, injecting `webServer` and `social`.
 * @param exempt - target ids the composition allows to publish without asking.
 * @param declared - validated `credentialKeys` from config.
 */
export function registerSocialRoutes(
  ctx: Context,
  exempt: ReadonlySet<string>,
  declared: ReadonlyMap<string, CredentialKey>,
): void {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: STATUS_PATH,
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        json(res, 405, { error: `${STATUS_PATH} answers GET.` } satisfies SocialErrorBody)
        return
      }
      json(res, 200, await socialStatus(ctx, exempt, declared))
    },
  }), `tool-social: ${STATUS_PATH}`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: DISCONNECT_PATH,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        json(res, 405, { error: `${DISCONNECT_PATH} answers POST.` } satisfies SocialErrorBody)
        return
      }
      const outcome = await socialDisconnect(ctx, declared, await readJsonBody(req))
      json(res, outcome.status, outcome.body)
    },
  }), `tool-social: ${DISCONNECT_PATH}`)
}
