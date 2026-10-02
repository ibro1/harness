/**
 * On/off switches and status for the deployment's plugins that have no
 * settings form: PSD tools, page capture, session outputs and the CLI routes.
 *
 * Those plugins are layered over the Web composition with `--patch`, after the
 * profile that holds Plugins-page edits, so a settings form could never take a
 * saved value for them. Their switch state lives in its own file instead,
 * `<DSH home>/plugin-switches.json`, written by the Plugins page through the
 * routes {@link mountSwitch} registers and read by the plugin at the moment it
 * acts: when it gives a new agent its tools, and when a tool or route is
 * called. A plugin switched off therefore stops at once for new calls; an
 * agent created while it was on keeps the tool in its list (its request prefix
 * stays fixed), and the call is refused.
 *
 * Routes, behind the harness's sign-in:
 * - `GET /plugin-switch/<id>`: the status the card shows.
 * - `POST /plugin-switch/<id>` with `{"enabled": true|false}`: switch it.
 * - `POST /plugin-switch/<id>/test`: run the plugin's own check, when it has one.
 *
 * @module @deepseek-ai/dsh-host-plugin-switch
 */

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'

/** One fact the card lists: a fixed key the Plugins page names, and a value. */
export type SwitchFact =
  | { key: string; value: string }
  | { key: string; flag: boolean }

/** What a plugin reports about itself, beside the switch. */
export interface SwitchHealth {
  /** False when the plugin cannot work as configured (no browser, no token). */
  healthy: boolean
  /** Facts in the order the card lists them. */
  facts: SwitchFact[]
  /** Why it cannot work, when `healthy` is false. */
  problem?: string
}

/** The answer to `GET /plugin-switch/<id>`. */
export interface SwitchStatus extends SwitchHealth {
  id: string
  enabled: boolean
  /** Whether `POST /plugin-switch/<id>/test` runs a check. */
  canTest: boolean
}

/** The outcome of a plugin's own check. */
export interface SwitchTestResult {
  ok: boolean
  message: string
}

/** What a plugin hands {@link mountSwitch}. */
export interface SwitchSpec {
  /** The plugin's id, also its route segment and the key in the switch file. */
  id: string
  /** Its state before anyone has switched it. */
  defaultEnabled: boolean
  /** Its health and facts, read each time the card asks. */
  health: () => SwitchHealth | Promise<SwitchHealth>
  /** Its own check, such as starting the browser it needs. */
  test?: () => Promise<SwitchTestResult>
}

/** A mounted switch. */
export interface PluginSwitch {
  /** Whether the plugin is on now. */
  isOn(): boolean
}

/** Pattern a switch id must match: it becomes a URL segment and a JSON key. */
const ID = /^[a-z][a-z0-9-]{1,40}$/u

/** How long a read of the switch file is reused, in milliseconds; tool calls read it on every call. */
const READ_CACHE_MS = 1000

/**
 * The switch file. Every plugin that reads a switch reads this one path.
 * @returns `<DSH home>/plugin-switches.json`.
 */
export function switchFile(): string {
  return join(process.env['DSH_HOME'] ?? join(homedir(), '.dsh'), 'plugin-switches.json')
}

let cache: { path: string; at: number; mtimeMs: number; values: Record<string, boolean> } | undefined

/** Read every saved switch, reusing a read younger than {@link READ_CACHE_MS}. */
function readAll(path: string): Record<string, boolean> {
  const now = Date.now()
  if (cache !== undefined && cache.path === path && now - cache.at < READ_CACHE_MS) return cache.values
  let mtimeMs = -1
  try {
    mtimeMs = statSync(path).mtimeMs
  } catch (error) {
    // No file yet: nothing has been switched, so every plugin has its default.
    void error
  }
  if (cache !== undefined && cache.path === path && cache.mtimeMs === mtimeMs) {
    cache.at = now
    return cache.values
  }
  const values: Record<string, boolean> = {}
  if (mtimeMs >= 0) {
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'))
    } catch (error) {
      // A damaged file must not break every tool call: each plugin falls back
      // to its default, and the next switch from the page rewrites the file.
      process.stderr.write(`plugin-switch: ${path} is unreadable (${error instanceof Error ? error.message : String(error)}); using defaults\n`)
    }
    if (typeof parsed === 'object' && parsed !== null) {
      for (const [key, value] of Object.entries(parsed)) if (typeof value === 'boolean') values[key] = value
    }
  }
  cache = { path, at: now, mtimeMs, values }
  return values
}

/**
 * Whether a plugin is switched on.
 * @param id - the plugin's switch id.
 * @param defaultEnabled - its state when nothing is saved.
 * @param path - the switch file; tests pass their own.
 * @returns the saved state, or the default.
 */
export function isSwitchedOn(id: string, defaultEnabled: boolean, path = switchFile()): boolean {
  return readAll(path)[id] ?? defaultEnabled
}

/**
 * Save one plugin's state, replacing the file atomically.
 * @param id - the plugin's switch id.
 * @param enabled - the new state.
 * @param path - the switch file; tests pass their own.
 */
export function saveSwitch(id: string, enabled: boolean, path = switchFile()): void {
  const values = { ...readAll(path), [id]: enabled }
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${String(process.pid)}.tmp`
  writeFileSync(temporary, `${JSON.stringify(values, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, path)
  cache = undefined
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage, limit: number): Promise<string | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += buffer.length
    if (size > limit) return undefined
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * The status the card shows.
 * @param spec - the plugin's switch.
 * @param path - the switch file.
 * @returns the status; a health check that throws is reported as unhealthy.
 */
export async function switchStatus(spec: SwitchSpec, path = switchFile()): Promise<SwitchStatus> {
  let health: SwitchHealth
  try {
    health = await spec.health()
  } catch (error) {
    health = { healthy: false, facts: [], problem: error instanceof Error ? error.message : String(error) }
  }
  return { id: spec.id, enabled: isSwitchedOn(spec.id, spec.defaultEnabled, path), canTest: spec.test !== undefined, ...health }
}

/**
 * Register a plugin's switch routes on the harness web server.
 * @param ctx - the plugin's context; the routes are its effects and go when it is disposed.
 * @param spec - the plugin's id, default, health and check.
 * @returns the switch the plugin reads before acting.
 * @throws when the id is not a lower-case slug.
 */
export function mountSwitch(ctx: Context, spec: SwitchSpec): PluginSwitch {
  if (!ID.test(spec.id)) throw new Error(`plugin-switch: "${spec.id}" is not a lower-case id`)
  const base = `/plugin-switch/${spec.id}`
  ctx.inject(['webServer'], (scope) => {
    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: base,
      handler: async (req, res) => {
        if (req.method === 'GET') { json(res, 200, await switchStatus(spec)); return }
        if (req.method !== 'POST') { json(res, 405, { error: 'GET or POST' }); return }
        const raw = await readBody(req, 4096)
        let enabled: unknown
        try {
          enabled = raw === undefined ? undefined : (JSON.parse(raw) as { enabled?: unknown }).enabled
        } catch (error) {
          void error
        }
        if (typeof enabled !== 'boolean') { json(res, 400, { error: 'send {"enabled": true} or {"enabled": false}' }); return }
        saveSwitch(spec.id, enabled)
        process.stderr.write(`plugin-switch: ${spec.id} switched ${enabled ? 'on' : 'off'}\n`)
        json(res, 200, await switchStatus(spec))
      },
    }), `plugin-switch: ${base}`)
    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: `${base}/test`,
      handler: async (req, res) => {
        if (req.method !== 'POST') { json(res, 405, { error: 'POST only' }); return }
        if (spec.test === undefined) { json(res, 404, { error: 'this plugin has no check' }); return }
        try {
          json(res, 200, await spec.test())
        } catch (error) {
          json(res, 200, { ok: false, message: error instanceof Error ? error.message : String(error) } satisfies SwitchTestResult)
        }
      },
    }), `plugin-switch: ${base}/test`)
  })
  return { isOn: () => isSwitchedOn(spec.id, spec.defaultEnabled) }
}

/** The part of a tool definition {@link gateTools} wraps. */
interface ExecutableTool {
  name: string
  execute: (...args: never[]) => Promise<unknown>
}

/**
 * Make tools refuse while their plugin is switched off. Each call reads the
 * switch, so switching off takes effect for agents that already list the tool.
 * @param tools - the plugin's tool definitions.
 * @param isOn - the plugin's switch.
 * @param title - the plugin's name on the Plugins page, for the refusal.
 * @returns the same definitions with `execute` guarded.
 */
export function gateTools<T extends ExecutableTool>(tools: readonly T[], isOn: () => boolean, title: string): T[] {
  return tools.map((tool) => {
    const execute = tool.execute
    const guarded = (...args: never[]): Promise<unknown> => {
      if (!isOn()) return Promise.reject(new Error(`${title} is switched off on the Plugins page; ask the owner to switch it on.`))
      return execute(...args)
    }
    return { ...tool, execute: guarded }
  })
}
