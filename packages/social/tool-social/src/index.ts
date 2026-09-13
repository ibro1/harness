/**
 * Model-facing social posting: the target catalog the model reads, and the one
 * tool that publishes.
 *
 * This package owns a Consumer role of the social capability seam. It injects
 * `ctx.social`, names no platform, and adds exactly one thing the seam does not
 * have: a human in front of every publication.
 *
 * Every other tool in this harness either reads data or acts on the operator's
 * own infrastructure. `social_post` speaks publicly under their name, and a
 * wrong post cannot be recalled, so it asks for approval through the
 * `interaction` approval seam before it publishes, and shows the approving
 * person the whole thing being approved: the target's label, the post text
 * verbatim, and every attachment by filename, kind and size. The ask lives
 * inside the executing operation — the only code path that reaches
 * `ctx.social.post()` — so no other caller and no listener order can arrive at
 * a publication that skipped it.
 *
 * The same seam has a second consumer here, for a human rather than a model:
 * the two HTTP routes in `./routes.ts` that the Settings → Plugins card reads.
 * They surface the seam's *state* — what can be posted to, what is about to
 * stop working, and which targets skip the approval gate — plus the one write
 * a person needs that is not a sign-in: disconnecting a stored credential. They
 * live in this package because they consume exactly what the tools consume,
 * `ctx.social.targets()` and the composition's `postWithoutApproval`; a third
 * package would only be able to re-derive both from here.
 *
 * @module @deepseek-ai/dsh-tool-social
 */

import { realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolRunContext, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { SocialMedia, SocialTarget } from '@deepseek-ai/dsh-social'
import type {} from '@deepseek-ai/dsh-user-approval'
// Type-only merge: declares `Context.settings`, resolved optionally below.
import type {} from '@deepseek-ai/dsh-settings'
import { parseDeclaredKeys, registerSocialRoutes } from './routes.ts'

/** The plugin name, for the Loader. */
export const name = 'tool-social'

/**
 * The services this package reads. `webServer` is required because the human
 * surface is half of what this package is for, and a composition that mounts it
 * without a web server would silently ship a card nobody can reach.
 *
 * `approval`, `credentials`, and `settings` are deliberately absent, so a
 * composition missing one loses that one thing rather than the whole plugin —
 * including the harmless catalog. `approval` and `credentials` are resolved
 * where they are used with `ctx.get(...)`, which fails that operation closed
 * with a legible refusal. `settings` is instead awaited in a scope with
 * `ctx.inject` in {@link apply}: it is file-backed and not yet resolved when
 * this plugin applies, so sampling it with `ctx.get` there reads undefined on
 * every boot and loses the settings card without saying so.
 */
export const inject = ['tools', 'social', 'webServer']

/** Composition config. */
export interface Config {
  /**
   * Target ids that may be posted to without asking a human — an id at a time,
   * never a global switch, so turning approval off for a staging channel cannot
   * turn it off for a real account. Empty by default: everything asks.
   */
  postWithoutApproval?: string[]
  /**
   * Social provider name to the address (`<scope>/<id>`) of the credential
   * record holding its grant, for `POST /social/disconnect`.
   *
   * Needed only where the address cannot be derived: the seam publishes no
   * provider-to-record lookup, so the route otherwise looks for a stored record
   * whose scope is the provider's own name or `social-<provider>`, which is how
   * the providers shipped beside this package are packaged. One plugin serving
   * two providers — `social-meta` serves `facebook` and `instagram` — derives
   * neither and must be named here.
   */
  credentialKeys?: Record<string, string>
}

/** Validate and default the composition config. */
export const Config: z<Config> = z.object({
  postWithoutApproval: z.array(z.string()).default([]).description('Social target ids that may be posted to without a human approval prompt, by exact id (for example a staging channel). Every other target asks. Leave empty so every post asks.'),
  credentialKeys: z.dict(z.string()).default({}).description('Social provider name to the credential record address (<scope>/<id>) holding its grant, for the Disconnect button. Only needed where the address cannot be derived from the provider name, such as social-meta, whose one record backs both facebook and instagram.'),
})

/** The canonical output of `social_targets`: text for the model to read. */
const TARGETS_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: {
      type: 'string',
      required: true,
      description: 'The available social targets, as text.',
    },
  },
} as const satisfies ValueSchemaSpec

/** The canonical output of `social_post`: the created post, plus text for the model. */
const POST_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true, description: "The platform's own id for the created post." },
    url: { type: 'string', description: 'Where a human can go and look at the post, when the platform gives one.' },
    text: { type: 'string', required: true, description: 'What was published and where, as text.' },
  },
} as const satisfies ValueSchemaSpec

/** One attachment resolved against the session workspace, ready to show a human and to send. */
interface ResolvedMedia {
  /** The attachment as the provider receives it, carrying the canonical path. */
  readonly media: SocialMedia
  /** The file name a person recognizes in the approval prompt. */
  readonly name: string
  /** The file size in bytes, shown in the approval prompt. */
  readonly bytes: number
}

/**
 * Render a byte count the way a person reads one.
 * @param bytes - the file size.
 * @returns the size in the largest unit that leaves a number above one.
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  return `${(kb / 1024).toFixed(1)} MB`
}

/**
 * Say what a target will take, in the model's own vocabulary.
 * @param accepts - the target's three acceptance flags.
 * @returns a comma-separated list, or `nothing`.
 */
function describeAccepts(accepts: SocialTarget['accepts']): string {
  const kinds = [
    ...accepts.text ? ['text'] : [],
    ...accepts.image ? ['images'] : [],
    ...accepts.video ? ['video'] : [],
  ]
  return kinds.length === 0 ? 'nothing' : kinds.join(', ')
}

/**
 * Resolve one model-supplied attachment path against the session workspace and
 * refuse anything outside it. The check is on the canonical paths — `realpath`
 * on both sides, then `path.relative` — so a symlink pointing out of the
 * workspace, and a `..` walk that lands outside it, are both refused. A string
 * prefix would accept `/workspace-elsewhere` for a workspace `/workspace`.
 * @param item - the path and kind the model gave.
 * @param cwd - the session's working directory, the only tree a post may attach from.
 * @returns the attachment with its canonical path, plus the name and size a human is shown.
 * @throws when the file is missing, is not a regular file, or resolves outside the workspace.
 */
async function resolveMedia(item: { path: string; kind: SocialMedia['kind']; alt?: string }, cwd: string): Promise<ResolvedMedia> {
  const canonicalCwd = await realpath(cwd)
  const requested = resolve(canonicalCwd, item.path)
  let canonical: string
  try {
    canonical = await realpath(requested)
  } catch {
    // Swallows only the resolution failure: a path that does not resolve is not
    // attachable, and the model needs the path it gave, not an errno.
    throw new Error(`cannot attach ${JSON.stringify(item.path)}: no such file in the session workspace`)
  }
  const within = relative(canonicalCwd, canonical)
  if (within === '' || within.startsWith('..') || isAbsolute(within)) {
    throw new Error(`cannot attach ${JSON.stringify(item.path)}: it resolves to ${JSON.stringify(canonical)}, outside the session workspace ${JSON.stringify(canonicalCwd)}`)
  }
  const info = await stat(canonical)
  if (!info.isFile()) {
    throw new Error(`cannot attach ${JSON.stringify(item.path)}: it is not a file`)
  }
  return {
    media: { path: canonical, kind: item.kind, ...item.alt === undefined ? {} : { alt: item.alt } },
    name: basename(canonical),
    bytes: info.size,
  }
}

/**
 * The whole post, as the approving person reads it: where it goes, the text
 * verbatim, and every attachment by name, kind and size. Nothing here is
 * summarized or reflowed — the text IS the thing being approved, and a person
 * approving a post they cannot read has approved nothing.
 * @param target - the resolved target the post goes to.
 * @param text - the post body, exactly as it will be published.
 * @param media - the resolved attachments.
 * @returns the approval prompt body.
 */
function approvalReason(target: SocialTarget, text: string, media: readonly ResolvedMedia[]): string {
  const attachments = media.length === 0
    ? ['No attachments.']
    : [
      'Attachments:',
      ...media.map(item => `- ${item.name} — ${item.media.kind}, ${formatBytes(item.bytes)}${item.media.alt === undefined ? '' : ` — alt: ${item.media.alt}`}`),
    ]
  return [
    `Publish publicly to ${target.label} (${target.id}) on ${target.provider}.`,
    '',
    '--- the post, exactly as it will be published ---',
    text,
    '--- end of post ---',
    '',
    ...attachments,
  ].join('\n')
}

/**
 * Find the target the model named, refusing rather than guessing.
 * @param targets - every target the seam currently lists.
 * @param id - the id the model gave.
 * @returns the matching target.
 * @throws when no target carries that id, listing the ids that do exist, or
 *   when the matching target is not ready, carrying its own reason.
 */
function resolveTarget(targets: readonly SocialTarget[], id: string): SocialTarget {
  const match = targets.find(target => target.id === id)
  if (match === undefined) {
    throw new Error(targets.length === 0
      ? `no social target ${JSON.stringify(id)}: no social account is connected. Call social_targets to see what exists.`
      : `no social target ${JSON.stringify(id)}; these exist: ${targets.map(target => target.id).join(', ')}`)
  }
  if (!match.ready) {
    throw new Error(`social target ${JSON.stringify(id)} (${match.label}) is not ready: ${match.reason ?? 'the provider gave no reason'}`)
  }
  return match
}

/**
 * Ask a human to approve exactly this post, and let only an explicit grant
 * through. The ask sits in the operation that publishes, so every refusal
 * happens before `ctx.social.post()` is ever reached.
 * @param ctx - the plugin context, used to resolve the optional approval seam.
 * @param exec - the running tool call, carrying the agent, the call id, and cancellation.
 * @param reason - the complete post as the person will read it.
 * @param target - the target being posted to, for the refusal texts.
 * @throws when no approval channel is composed or reachable, when the call has
 *   no agent to route the question through, and on every outcome but a grant.
 */
async function requireApproval(ctx: Context, exec: ToolRunContext, reason: string, target: SocialTarget): Promise<void> {
  const approval = ctx.get('approval')
  if (approval === undefined) {
    throw new Error(`posting to ${JSON.stringify(target.id)} requires human approval, but no approval service is composed`)
  }
  const agent = exec.agent
  if (agent === undefined) {
    throw new Error(`posting to ${JSON.stringify(target.id)} requires human approval, but this call has no agent to route the question through`)
  }
  const outcome = await approval.request({
    agent,
    toolName: 'social_post',
    callId: exec.callId,
    reason,
    signal: exec.signal,
  })
  switch (outcome) {
    case 'allowed-once': return
    case 'rejected': throw new Error(`the user rejected this post to ${JSON.stringify(target.id)} (${target.label}); nothing was published`)
    case 'cancelled': throw new Error(`approval for this post to ${JSON.stringify(target.id)} was cancelled; nothing was published`)
    case 'unavailable': throw new Error(`posting to ${JSON.stringify(target.id)} requires human approval, but no approval channel is available; nothing was published`)
    default: return assertNever(outcome, 'ApprovalOutcome')
  }
}

/**
 * Build the two model-facing social tools.
 * @param ctx - the plugin context, carrying `ctx.social` and the optional approval seam.
 * @param exempt - target ids the composition allows to publish without asking.
 * @returns the tool definitions, ready to register.
 */
function buildSocialTools(ctx: Context, exempt: ReadonlySet<string>): ToolDefinition[] {
  return [
    defineTool({
      name: 'social_targets',
      description: 'List the social accounts, Pages and channels this harness can post to: the id to name in social_post, what a human calls each one, what it accepts, and why any of them cannot be used right now.',
      parameters: {},
      output: { schema: TARGETS_OUTPUT, render: (_args, value) => [{ type: 'text', text: value.text }] },
      async execute(_args, exec: ToolRunContext) {
        exec.signal.throwIfAborted()
        const targets = await ctx.social.targets()
        if (targets.length === 0) {
          return { text: 'No social accounts are connected, so there is nothing to post to.' }
        }
        const lines = targets.map((target) => {
          const state = target.ready
            ? `accepts ${describeAccepts(target.accepts)}`
            : `NOT READY — ${target.reason ?? 'the provider gave no reason'}`
          return `- ${target.id} — ${target.label} [${target.provider}]: ${state}`
        })
        return { text: `Social targets:\n${lines.join('\n')}` }
      },
      presentCall: () => ({ card: 'generic', title: 'List social targets', kind: 'read' }),
    }),

    defineTool({
      name: 'social_post',
      description: 'Publish one post to one social target. This is public and permanent: it appears under the account holder\'s name and cannot be recalled. A human is shown the exact text and every attachment and must approve before anything is published. Call social_targets first and use an exact id from it. Write the post as it should appear — it is published byte for byte.',
      parameters: {
        target: { type: 'string', required: true, description: 'The exact target id from social_targets, for example linkedin:member.' },
        text: { type: 'string', required: true, description: 'The post body, published exactly as written. Pass an empty string only for a target that takes media without text.' },
        media: {
          type: 'array',
          description: 'Files to attach, in the order they should appear. Each file must already exist inside the session working directory.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              path: { type: 'string', required: true, description: 'Path to the file, inside the session working directory. Relative paths resolve against it.' },
              kind: { type: 'string', required: true, enum: ['image', 'video'], description: 'Whether the file is an image or a video.' },
              alt: { type: 'string', description: 'Alt text describing the file for people using a screen reader. Write one for every image.' },
            },
          },
        },
      },
      output: { schema: POST_OUTPUT, render: (_args, value) => [{ type: 'text', text: value.text }] },
      async execute(args, exec: ToolRunContext) {
        exec.signal.throwIfAborted()
        const agent = exec.agent
        if (agent === undefined) {
          throw new Error('social_post needs a session to resolve attachment paths against and a person to approve the post; this call has neither')
        }
        const target = resolveTarget(await ctx.social.targets(), args.target)
        exec.signal.throwIfAborted()
        // Attachments resolve BEFORE the ask: a person must not be asked to
        // approve a post that cannot be published, and the prompt names each
        // file by the size it actually has on disk.
        const media: ResolvedMedia[] = []
        if ((args.media ?? []).length > 0) {
          // Refused rather than defaulted: with no workspace there is no tree to
          // contain an attachment to, and resolving against the process's own
          // directory would make every containment check meaningless.
          const cwd = agent.session.header.cwd
          if (cwd === undefined || cwd === '') {
            throw new Error('This session has no workspace directory, so a post cannot attach a file. Post the text on its own, or start a session in a workspace.')
          }
          for (const item of args.media ?? []) {
            media.push(await resolveMedia(item, cwd))
          }
        }
        exec.signal.throwIfAborted()
        if (!exempt.has(target.id)) {
          await requireApproval(ctx, exec, approvalReason(target, args.text, media), target)
        }
        const result = await ctx.social.post({
          target: target.id,
          // Verbatim: the text a person approved is the text that goes out.
          text: args.text,
          ...media.length === 0 ? {} : { media: media.map(item => item.media) },
        })
        const where = result.url === undefined ? '' : ` It is at ${result.url}.`
        // What the platform did differently from what was asked. A provider
        // reports these because the request being accepted is not the same as
        // the post being what the person approved — a video YouTube forced to
        // private, an image that went out with no alt text. Dropping them here
        // would leave the caller saying "published" about work nobody can see.
        const notes = result.notes === undefined || result.notes.length === 0
          ? ''
          : `\n${result.notes.map(note => `- ${note}`).join('\n')}`
        return {
          id: result.id,
          ...result.url === undefined ? {} : { url: result.url },
          text: `Published to ${target.label} (${target.id}).${where}${notes}`,
        }
      },
      presentCall: args => ({ card: 'generic', title: `Post to ${args.target}`, kind: 'other', rawInput: args.text }),
    }),
  ]
}

/**
 * Register the social catalog and posting tools, the two human-facing HTTP
 * routes, and the `social` settings namespace that lists the card.
 * @param ctx - the plugin context, injecting `tools`, `social`, and `webServer`.
 * @param config - validated composition config.
 */
export function apply(ctx: Context, config: Config = {}): void {
  // The schema already defaulted an omitted list to empty; the `??` narrows the
  // optional-input TYPE, and never decides policy.
  const exempt = new Set(config.postWithoutApproval ?? [])
  // Throws on a malformed address, so a typo fails at load rather than when
  // somebody presses Disconnect.
  const credentialKeys = parseDeclaredKeys(config.credentialKeys ?? {})
  for (const tool of buildSocialTools(ctx, exempt)) {
    ctx.effect(() => ctx.tools.register(tool), `tool-social: ${tool.name}`)
  }
  registerSocialRoutes(ctx, exempt, credentialKeys)
  // The Settings → Plugins tab dispatches one card per settings namespace the
  // Host serves, so the card is listed only while `social` is a served
  // namespace. There is nothing to configure from a form — accounts are
  // connected by asking the agent, and `postWithoutApproval` is a composition
  // decision, not a user preference — so the schema is empty and its presence
  // is the whole contribution.
  //
  // Through `ctx.inject` rather than `ctx.get`, which is the difference between
  // a listed card and no card at all. The settings service is file-backed and
  // resolves its `Service.init` off disk, so it is reliably absent at the
  // moment this plugin applies; a `ctx.get('settings')?.` here read undefined
  // on every boot and registered nothing, silently, forever. Keeping it out of
  // `inject` is still right — a composition with no settings service should
  // lose the card, not the tools — and the scoped inject keeps that property
  // while waiting for the service instead of sampling for it once.
  //
  // Called directly inside the scope, NOT through `ctx.effect`:
  // `settings.register` returns a scope rather than a disposer (it files its
  // own effect), and wrapping it makes Cordis reject an invalid effect.
  ctx.inject(['settings'], (settingsCtx: Context) => {
    settingsCtx.settings.register('social', z.object({}).description('Social accounts are connected by asking the agent to sign in, and this card shows what they can post to. Nothing here is edited from a form.'), { base: {} })
  })
}
