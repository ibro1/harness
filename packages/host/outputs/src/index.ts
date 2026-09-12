/**
 * Session outputs: one directory per session that a skill or a plugin copies a
 * finished file into, so the person who asked for that file can actually get
 * it.
 *
 * The composer's "Session outputs" drawer lists exactly one hardcoded
 * directory, `<cwd>/edit/`, which was the convention of the first skill that
 * happened to need one. When a second skill landed, its graphics rendered
 * correctly, sat on disk, and were invisible: the drawer showed a stale file
 * from an earlier session and none of the work just produced, and the answer to
 * "where are the files?" was a path inside a container. Every skill that
 * renders anything reaches this, and the workaround so far — tell each new
 * skill to copy into another skill's directory — makes `edit/` mean "delivered"
 * for one skill and "scratch" for the next.
 *
 * This package establishes `<cwd>/.outputs` as the one delivery directory and
 * registers {@link SessionOutputs} on `ctx.outputs`, so a producer publishes by
 * calling a service rather than by knowing a path. A consumer — the composer
 * drawer, a download route, a transcript card — then reads one convention
 * instead of maintaining an allowlist of every skill's own output directory.
 *
 * @module @deepseek-ai/dsh-host-outputs
 */

import { constants } from 'node:fs'
import type { Dirent, Stats } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolRunContext, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-session'

/**
 * Directory name, inside the session cwd, that holds published outputs.
 *
 * Deliberately not a `Config` field: the whole value of this package is that
 * one name means "delivered" everywhere, and a consumer that must ask which
 * name a deployment chose is back to keeping an allowlist.
 */
const OUTPUTS_DIR = '.outputs'

/**
 * Sidecar holding publisher-supplied labels, keyed by the file name actually
 * used. A dotfile, so {@link SessionOutputs.list} skips it with every other
 * dotfile rather than special-casing it.
 */
const LABELS_FILE = '.labels.json'

/** Per-file ceiling when the deployment does not set one: 512 MiB. */
const DEFAULT_MAX_FILE_BYTES = 512 * 1024 * 1024

/** Per-session ceiling when the deployment does not set one: 2 GiB. */
const DEFAULT_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024

/** Longest label retained; a label is free model text, so it is bounded. */
const MAX_LABEL_CHARS = 200

/** Longest published file name, short enough to survive any filesystem. */
const MAX_NAME_CHARS = 120

/** Collision suffixes tried before publishing gives up on a name. */
const MAX_COLLISION_ATTEMPTS = 1000

/** One file that has been published for a session. */
export interface PublishedOutput {
  /** File name inside the outputs directory. */
  name: string
  /** Path relative to the session cwd, e.g. `.outputs/report.png`. */
  rel: string
  /** Size on disk of the published copy. */
  bytes: number
  /** Modification time of the published copy, in Unix epoch milliseconds. */
  mtime: number
  /** Optional human label the publisher supplied. */
  label?: string
}

/**
 * The session-outputs capability registered on `ctx.outputs`.
 *
 * Every method takes the session's working directory explicitly: the service
 * has no ambient notion of "the current session", so the caller stays
 * responsible for reading an authoritative cwd (the session store) rather than
 * one a model supplied.
 */
export interface SessionOutputs {
  /**
   * Where a session's published outputs live: `<cwd>/.outputs`.
   * @param cwd - the session's working directory.
   * @returns the absolute outputs directory path, whether or not it exists yet.
   */
  dir(cwd: string): string

  /**
   * Copy a finished file into the session's outputs directory.
   *
   * The source is copied, never moved and never symlinked: the producer may
   * still be writing beside it, and a link into a temp directory is a dead link
   * an hour later. An existing name is suffixed rather than overwritten.
   * @param cwd - the session's working directory; the outputs directory is created under it.
   * @param absPath - the finished file, absolute or resolved against `cwd`.
   * @param label - optional free-text label from the publisher; it never influences the file name.
   * @returns the published copy, including the name actually used.
   * @throws when the cwd does not exist, the source is missing or is not a
   * regular file, the source resolves outside the cwd and `allowOutsideCwd` is
   * false, the source is already inside the outputs directory, or either byte
   * cap would be exceeded. Nothing is copied when a publish is refused.
   */
  publish(cwd: string, absPath: string, label?: string): Promise<PublishedOutput>

  /**
   * What has been published for this session, newest first.
   * @param cwd - the session's working directory.
   * @returns the published files, or an empty list when nothing has been published.
   */
  list(cwd: string): Promise<PublishedOutput[]>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    outputs: SessionOutputs
  }
}

/** The plugin name, for the Loader. */
export const name = 'outputs'

/** The services this plugin reads. */
export const inject = ['agents', 'sessions']

/** Composition config: the delivery limits, which vary by deployment. */
export interface Config {
  /** Largest single file that may be published, in bytes. */
  maxFileBytes: number
  /** Largest total size of one session's outputs directory, in bytes. */
  maxTotalBytes: number
  /**
   * Whether a file outside the session cwd may be published. False refuses it,
   * so a `../../` in a model-supplied path cannot land `/etc/passwd` in a
   * directory the composer offers for download.
   */
  allowOutsideCwd: boolean
}

/** Composition config: the delivery limits, which vary by deployment. */
export const Config: z<Config> = z.object({
  maxFileBytes: z.natural().min(1).default(DEFAULT_MAX_FILE_BYTES),
  maxTotalBytes: z.natural().min(1).default(DEFAULT_MAX_TOTAL_BYTES),
  allowOutsideCwd: z.boolean().default(false),
})

/**
 * Whether `root` is `candidate` or contains it, compared after both paths are
 * resolved. A string prefix would accept `/srv/work-2` as inside `/srv/work`
 * and would accept any path a `..` segment walked out of.
 * @param root - the containing directory, already resolved.
 * @param candidate - the path under test, already resolved.
 * @returns whether `candidate` is at or below `root`.
 */
function contains(root: string, candidate: string): boolean {
  const relation = relative(root, candidate)
  return relation === '' || (!isAbsolute(relation) && relation !== '..' && !relation.startsWith(`..${sep}`))
}

/**
 * Reduce a source path to a file name safe to create: the basename only, with
 * anything outside `[A-Za-z0-9._-]` folded to `-`, no leading dot or dash, and
 * a bounded length. A `..` cannot survive this, so the name can never redirect
 * the copy out of the outputs directory.
 * @param source - the source path whose basename is being adopted.
 * @returns the sanitised file name, never empty.
 */
function sanitiseName(source: string): string {
  const cleaned = basename(source)
    .replace(/[\u0000-\u001f\u007f]+/gu, '')
    .replace(/[^A-Za-z0-9._-]+/gu, '-')
    .replace(/^[.\-]+/u, '')
    .replace(/-{2,}/gu, '-')
  if (cleaned === '') return 'output'
  if (cleaned.length <= MAX_NAME_CHARS) return cleaned
  // Keep the extension: it is what a viewer and the download route read.
  const ext = extname(cleaned).slice(0, 16)
  return cleaned.slice(0, MAX_NAME_CHARS - ext.length) + ext
}

/**
 * Reduce a model-supplied label to storable data: no control characters, no
 * surrounding whitespace, bounded length.
 * @param label - the raw label, when the publisher supplied one.
 * @returns the sanitised label, or undefined when nothing survives.
 */
function sanitiseLabel(label: string | undefined): string | undefined {
  if (label === undefined) return undefined
  const cleaned = label.replace(/[\u0000-\u001f\u007f]+/gu, ' ').trim().slice(0, MAX_LABEL_CHARS)
  return cleaned === '' ? undefined : cleaned
}

/**
 * The candidate name for one collision attempt: `report.png`, `report-2.png`,
 * `report-3.png`.
 * @param name - the sanitised base name.
 * @param attempt - 1 for the first try, then upwards.
 * @returns the name to try.
 */
function suffixed(name: string, attempt: number): string {
  if (attempt === 1) return name
  const ext = extname(name)
  const stem = ext === '' ? name : name.slice(0, -ext.length)
  return `${stem}-${String(attempt)}${ext}`
}

/**
 * Read the label sidecar, tolerating its absence and rejecting anything in it
 * that is not a name-to-string mapping — it is a durable file, so it is
 * validated rather than trusted.
 * @param dir - the outputs directory.
 * @returns the labels by file name; empty when the sidecar is missing or unreadable.
 */
async function readLabels(dir: string): Promise<Map<string, string>> {
  let text: string
  try {
    text = await readFile(join(dir, LABELS_FILE), 'utf8')
  } catch {
    // No sidecar yet, or it is unreadable: labels are decoration, and losing
    // them must never hide a published file.
    return new Map()
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // A truncated or hand-edited sidecar; the files themselves are the record.
    return new Map()
  }
  const labels = new Map<string, string>()
  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string' && value !== '') labels.set(key, value)
    }
  }
  return labels
}

/**
 * Record one label in the sidecar. Concurrent publishes into one session race
 * here and the last writer wins the whole map, so a label can be lost; a lost
 * label costs a caption, never a file.
 * @param dir - the outputs directory, which already exists.
 * @param fileName - the name the file was published under.
 * @param label - the sanitised label.
 */
async function writeLabel(dir: string, fileName: string, label: string): Promise<void> {
  const labels = await readLabels(dir)
  labels.set(fileName, label)
  const body = JSON.stringify(Object.fromEntries(labels), undefined, 2)
  try {
    await writeFile(join(dir, LABELS_FILE), `${body}\n`, 'utf8')
  } catch {
    // The file is already delivered; failing the publish now would be a lie.
  }
}

/**
 * Canonicalise a path that must exist, so a symlink cannot present a target
 * outside the cwd as a path inside it.
 * @param path - the path to canonicalise.
 * @param what - what the path is, for the failure message.
 * @returns the real path.
 * @throws when the path does not exist or cannot be resolved.
 */
async function canonical(path: string, what: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    throw new Error(`${what} does not exist: ${path}`)
  }
}

/** Bytes as a short human string, for messages a model and a person both read. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${String(units[unit])}`
}

/**
 * Build the session-outputs service.
 *
 * Exported so the service can be driven directly in tests and by a composition
 * that wants the capability without this package's agent tool.
 * @param config - validated composition config carrying the limits.
 * @returns the service registered on `ctx.outputs`.
 */
export function createSessionOutputs(config: Config): SessionOutputs {
  const outputsDir = (cwd: string): string => join(resolve(cwd), OUTPUTS_DIR)

  /** Everything currently in one outputs directory, newest first, labels attached. */
  const listIn = async (dir: string): Promise<PublishedOutput[]> => {
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      // Nothing published yet: the directory is created on first publish.
      return []
    }
    const labels = await readLabels(dir)
    const files: PublishedOutput[] = []
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.startsWith('.')) continue
      let info: Stats
      try {
        info = await stat(join(dir, entry.name))
      } catch {
        // Removed between readdir and stat; it is not published any more.
        continue
      }
      const label = labels.get(entry.name)
      files.push({
        name: entry.name,
        rel: `${OUTPUTS_DIR}/${entry.name}`,
        bytes: info.size,
        mtime: info.mtimeMs,
        ...(label === undefined ? {} : { label }),
      })
    }
    files.sort((a, b) => b.mtime - a.mtime)
    return files
  }

  return {
    dir(cwd: string): string {
      return outputsDir(cwd)
    },

    async publish(cwd: string, absPath: string, label?: string): Promise<PublishedOutput> {
      const realCwd = await canonical(cwd, 'the session working directory')
      // `resolve` accepts an already-absolute path unchanged and anchors a
      // relative one to the session cwd, which is the only base a caller
      // without a path of its own could mean.
      const requested = resolve(realCwd, absPath)

      let source: Stats
      try {
        source = await stat(requested)
      } catch {
        throw new Error(`There is no file at ${requested}, so there is nothing to publish.`)
      }
      if (!source.isFile()) {
        throw new Error(`${requested} is not a regular file; publish the finished file itself.`)
      }

      const realSource = await canonical(requested, 'the file to publish')
      const dir = join(realCwd, OUTPUTS_DIR)
      if (contains(dir, realSource)) {
        throw new Error(`${basename(realSource)} is already published at ${OUTPUTS_DIR}/${basename(realSource)}.`)
      }
      if (!config.allowOutsideCwd && !contains(realCwd, realSource)) {
        throw new Error(`Refusing to publish ${realSource}: it is outside this session's working directory (${realCwd}). Only files produced in the workspace can be delivered.`)
      }

      if (source.size > config.maxFileBytes) {
        throw new Error(`Refusing to publish ${basename(realSource)}: it is ${formatBytes(source.size)}, over the ${formatBytes(config.maxFileBytes)} per-file limit. Nothing was copied.`)
      }

      const existing = await listIn(dir)
      const used = existing.reduce((total, file) => total + file.bytes, 0)
      if (used + source.size > config.maxTotalBytes) {
        throw new Error(`Refusing to publish ${basename(realSource)}: this session has already published ${formatBytes(used)} and the total limit is ${formatBytes(config.maxTotalBytes)}. Nothing was copied.`)
      }

      await mkdir(dir, { recursive: true })

      // COPYFILE_EXCL makes the collision check and the copy one operation, so
      // two publishes racing on the same name cannot overwrite each other.
      const base = sanitiseName(realSource)
      let published = ''
      for (let attempt = 1; attempt <= MAX_COLLISION_ATTEMPTS; attempt += 1) {
        const candidate = suffixed(base, attempt)
        try {
          await copyFile(realSource, join(dir, candidate), constants.COPYFILE_EXCL)
          published = candidate
          break
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        }
      }
      if (published === '') {
        throw new Error(`Refusing to publish ${base}: ${String(MAX_COLLISION_ATTEMPTS)} files of that name are already published.`)
      }

      const clean = sanitiseLabel(label)
      if (clean !== undefined) await writeLabel(dir, published, clean)

      const copied = await stat(join(dir, published))
      return {
        name: published,
        rel: `${OUTPUTS_DIR}/${published}`,
        bytes: copied.size,
        mtime: copied.mtimeMs,
        ...(clean === undefined ? {} : { label: clean }),
      }
    },

    async list(cwd: string): Promise<PublishedOutput[]> {
      const root = resolve(cwd)
      return listIn(join(root, OUTPUTS_DIR))
    },
  }
}

/** The canonical output of the publish tool: text for the model to read. */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: {
      type: 'string',
      required: true,
      description: 'What was published, and where it landed.',
    },
  },
} as const satisfies ValueSchemaSpec

/** Resolves the calling session's authoritative working directory at call time. */
export type ResolveCwd = () => string

/**
 * Build the outputs tools without registering them, so one definition serves
 * both the per-agent registry and any command route a composition adds.
 * @param outputs - the session-outputs service the tools publish through.
 * @param resolveCwd - reads the session's authoritative cwd; throws when the session has none.
 * @returns the tool definitions.
 */
export function buildOutputTools(outputs: SessionOutputs, resolveCwd: ResolveCwd): ToolDefinition[] {
  return [
    defineTool({
      name: 'publish_output',
      description: [
        'Deliver a finished file to the person who asked for it.',
        'Writing a file somewhere in the workspace does not deliver it: only a published file can be opened or downloaded by the person you are working for, and telling them a path instead reaches nobody.',
        'Publish every finished deliverable — a rendered image, a cut video, an exported document — as soon as it is final.',
        'The file is copied, so the original stays where you wrote it and you may keep working on it.',
      ].join(' '),
      parameters: {
        path: {
          type: 'string',
          required: true,
          description: 'The finished file to deliver, absolute or relative to the session working directory. It must be a file inside the workspace.',
        },
        label: {
          type: 'string',
          description: 'Short description shown beside the file, for example "final cut, 1080p". It never changes the file name.',
        },
      },
      output: { schema: OUTPUT_SCHEMA, render: (_args, value) => [{ type: 'text', text: value.text }] },
      execute: async (args, exec: ToolRunContext) => {
        exec.signal.throwIfAborted()
        const cwd = resolveCwd()
        const published = await outputs.publish(cwd, args.path, args.label)
        const renamed = published.name === basename(args.path)
          ? ''
          : ` A file named ${basename(args.path)} was already published, so this one is ${published.name}.`
        return {
          text: `Published ${published.rel} (${formatBytes(published.bytes)}).${renamed} It is now in this session's outputs; the original at ${args.path} is untouched.`,
        }
      },
      presentCall: args => ({
        card: 'generic',
        title: `Publish ${basename(args.path)}`,
        kind: 'edit',
        rawInput: args.path,
      }),
    }),
  ]
}

/**
 * Register the outputs tools on one agent's context.
 * @param ctx - the agent's context, carrying its tool registry.
 * @param outputs - the session-outputs service.
 * @param resolveCwd - reads that agent's session cwd at call time.
 */
function registerOutputTools(ctx: Context, outputs: SessionOutputs, resolveCwd: ResolveCwd): void {
  for (const tool of buildOutputTools(outputs, resolveCwd)) {
    ctx.effect(() => ctx.tools.register(tool), `outputs: ${tool.name}`)
  }
}

/**
 * The session's working directory, read from the session store rather than
 * from any path the model or a client supplied — the store's header is the
 * only cwd the harness itself guarantees.
 * @param ctx - the plugin context, carrying the session store.
 * @param agent - the agent whose session is publishing.
 * @returns the absolute session working directory.
 * @throws when the session is gone or was created without a workspace directory.
 */
function sessionCwd(ctx: Context, agent: Agent): string {
  const cwd = ctx.sessions.get(agent.session.id)?.header.cwd
  if (cwd === undefined || cwd === '') {
    throw new Error('This session has no workspace directory, so there is nowhere to publish files to.')
  }
  return cwd
}

/**
 * Mount the session-outputs capability and its publish tool.
 * @param ctx - the plugin context, injecting `agents` and `sessions`.
 * @param config - validated composition config.
 */
export function apply(ctx: Context, config: Config): void {
  const outputs = createSessionOutputs(config)
  ctx.provide('outputs', outputs)

  const installed = new Map<Agent, { dispose: () => Promise<void> }>()
  const install = (agent: Agent): void => {
    if (installed.has(agent)) return
    installed.set(agent, agent.ctx.inject(['tools'], (scope) => {
      registerOutputTools(scope, outputs, () => sessionCwd(ctx, agent))
    }))
  }
  const remove = (agent: Agent): void => {
    const fiber = installed.get(agent)
    if (fiber === undefined) return
    installed.delete(agent)
    void fiber.dispose().catch(() => {
      // The agent is gone; its registry went with it.
    })
  }
  for (const agent of ctx.agents.list()) install(agent)
  ctx.on('agent/created', ({ agent }) => { install(agent) })
  ctx.on('agent/disposed', ({ agent }) => { remove(agent) })
}
