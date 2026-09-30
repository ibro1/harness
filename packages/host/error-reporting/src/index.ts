/**
 * Production error reporting to a Sentry-compatible server (GlitchTip). The
 * deployment inserts this plugin only when `SENTRY_DSN` is set, and the Sentry
 * SDK is imported only inside `apply`, so an unset DSN loads nothing.
 *
 * Reported, each through the privacy scrubber (`scrub.ts`):
 * - error-level log lines, tagged with the logger (a crashed plugin logs under
 *   its own name), rate-limited per logger and overall;
 * - uncaught exceptions and unhandled rejections, flushed while the harness
 *   shuts down after its own fatal diagnostic;
 * - route handler failures (`webserver/request-error`);
 * - failed agent turns, as the error message with provider, model, Session id
 *   and owning plugin, and nothing of the conversation;
 * - Klipara Scout failures (`klipara-scout/failure`), tagged with the stage
 *   and the lead or sample id, with the lead's own strings redacted;
 * - Web UI errors, through a same-origin tunnel.
 *
 * Expected failures are not reported: 401/403/404, aborts and cancellations,
 * spent quotas and rate limits, and browser network drops.
 */

import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context, Fiber, FiberState } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-host-klipara-scout'
import { expectedError, scrubEvent } from './scrub.ts'
import { createTunnel, parseDsn } from './tunnel.ts'

export { expectedError, scrubEvent, scrubString, scrubTag, scrubValue } from './scrub.ts'
export { createTunnel, envelopeUrl, parseDsn, type Dsn, type TunnelOptions } from './tunnel.ts'

/** Cordis's const enum has no runtime object to import; this mirrors its FAILED member. */
const FIBER_FAILED = 3 as FiberState.FAILED

export const name = 'error-reporting'
export const inject = ['webServer']

/** Composition config; the deployment fills it from `SENTRY_*` variables. */
export interface Config {
  /** Where server reports go. Empty: nothing is reported and the SDK is not loaded. */
  dsn: string
  /** The DSN handed to the Web UI; empty uses `dsn`. */
  publicDsn: string
  environment: string
  release: string
  /** Share of transactions traced; 0 (the default) turns tracing off. */
  tracesSampleRate: number
  /** Same-origin path of the browser tunnel; `<path>/sdk.js` serves the browser reporter and `<path>/test` sends a test event. */
  tunnelPath: string
  /** Largest browser envelope forwarded, in bytes. */
  tunnelMaxBytes: number
  /** Envelopes one address may send through the tunnel per minute. */
  tunnelPerMinute: number
  /** Upstream timeout of a forwarded envelope. */
  tunnelTimeoutMs: number
  /** Minutes between two reports from the same logger. */
  logEveryMinutes: number
  /** Log-line reports allowed per minute across all loggers. */
  logPerMinute: number
  /** Whether the tunnel reads the caller's address from X-Forwarded-For. */
  trustProxy: boolean
  /** The signed-in account, hashed into the only user field a report carries. */
  account: string
}

export const Config = z.object({
  dsn: z.string().default(''),
  publicDsn: z.string().default(''),
  environment: z.string().default('production'),
  release: z.string().default(''),
  tracesSampleRate: z.number().min(0).max(1).default(0),
  tunnelPath: z.string().default('/api/monitor'),
  tunnelMaxBytes: z.natural().default(1024 * 1024),
  tunnelPerMinute: z.natural().default(60),
  tunnelTimeoutMs: z.natural().default(5000),
  logEveryMinutes: z.natural().default(5),
  logPerMinute: z.natural().default(30),
  trustProxy: z.boolean().default(false),
  account: z.string().default('admin'),
})

/** The plugin a Session belongs to, from its id prefix. */
function sessionPlugin(sessionId: string): string {
  if (sessionId.startsWith('scout-')) return 'klipara-scout'
  if (sessionId.startsWith('webhook-')) return 'webhook'
  return 'session'
}

/** Word the harness's own error log lines use for a failure a retry will handle. */
const WILL_RETRY = /\bwill retry\b|\bretrying\b|\bretry(?:ing)? in\b|\btimed? ?out\b.*\bretr/iu

/**
 * Admits log-line reports: at most one per logger per window, and a total per minute.
 */
export class LogRateLimit {
  private readonly lastByName = new Map<string, number>()
  private minuteStart = 0
  private minuteCount = 0

  /**
   * @param everyMs - the per-logger window.
   * @param perMinute - the total per minute.
   * @param now - the clock.
   */
  constructor(private readonly everyMs: number, private readonly perMinute: number, private readonly now: () => number = Date.now) {}

  /**
   * Whether a report from this logger may go now; admitting it counts it.
   * @param name - the logger.
   * @returns true to report.
   */
  admit(name: string): boolean {
    const at = this.now()
    const last = this.lastByName.get(name)
    if (last !== undefined && at - last < this.everyMs) return false
    if (at - this.minuteStart >= 60_000) {
      this.minuteStart = at
      this.minuteCount = 0
    }
    if (this.minuteCount >= this.perMinute) return false
    this.minuteCount++
    this.lastByName.set(name, at)
    return true
  }
}

/**
 * The error a log line carries: its first Error argument, else its text.
 * @param args - the log call's arguments.
 * @returns the error.
 */
export function logLineError(args: readonly unknown[]): Error {
  const found = args.find((arg): arg is Error => arg instanceof Error)
  if (found !== undefined) return found
  const text = args.map(arg => typeof arg === 'string' ? arg : typeof arg === 'number' || typeof arg === 'boolean' ? String(arg) : '').filter(Boolean).join(' ')
  return new Error(text === '' ? 'error logged without a message' : text)
}

/**
 * Whether a logged error is one reporting skips: expected, or a failure the
 * harness says it will retry.
 * @param error - the logged error.
 * @returns true to skip it.
 */
export function skippedLogError(error: Error): boolean {
  return expectedError(error) || WILL_RETRY.test(error.message)
}

/**
 * A copy of an error that keeps its name, message and stack and drops every
 * other property, which may hold request or model data.
 * @param error - the error.
 * @returns the copy.
 */
export function messageOnly(error: unknown): Error {
  if (!(error instanceof Error)) return new Error(typeof error === 'string' ? error : 'non-Error failure')
  const copy = new Error(error.message)
  copy.name = error.name
  if (error.stack !== undefined) copy.stack = error.stack
  return copy
}

/**
 * Install reporting.
 * @param ctx - the plugin context.
 * @param config - the DSN and limits.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (config.dsn.trim() === '') {
    process.stderr.write('error-reporting: sentry_disabled\n')
    return
  }
  const dsn = parseDsn(config.dsn)
  const browserDsn = parseDsn(config.publicDsn.trim() === '' ? config.dsn : config.publicDsn)
  const Sentry = await import('@sentry/node')
  const userId = createHash('sha256').update(config.account).digest('hex').slice(0, 12)
  // Strings a report must not carry, keyed by the error they travel with.
  const redactions = new WeakMap<object, readonly string[]>()
  const tracing = config.tracesSampleRate > 0

  Sentry.init({
    dsn: dsn.canonical,
    environment: config.environment,
    ...config.release === '' ? {} : { release: config.release },
    // Only the integrations named here run: no sessions, no request or console
    // capture, no local variables, no automatic process handlers (the harness
    // owns its own fatal exit, and the listeners below only report).
    defaultIntegrations: false,
    integrations: [Sentry.linkedErrorsIntegration(), Sentry.dedupeIntegration(), Sentry.functionToStringIntegration()],
    skipOpenTelemetrySetup: !tracing,
    ...tracing ? { tracesSampleRate: config.tracesSampleRate } : {},
    sendClientReports: false,
    maxBreadcrumbs: 0,
    beforeBreadcrumb: () => null,
    initialScope: { user: { id: userId }, tags: { runtime: 'node' } },
    beforeSend: (event, hint) => {
      const original = hint.originalException
      if (expectedError(original)) return null
      const named = typeof original === 'object' && original !== null ? redactions.get(original) ?? [] : []
      return scrubEvent(event, named) as typeof event
    },
  })
  process.stderr.write(`error-reporting: sentry_enabled environment=${config.environment}${config.release === '' ? '' : ` release=${config.release}`} tunnel=${config.tunnelPath}\n`)

  const report = (error: unknown, tags: Record<string, string | undefined>, named: readonly string[] = []): void => {
    if (expectedError(error)) return
    const reported = error instanceof Error ? error : messageOnly(error)
    if (named.length > 0) redactions.set(reported, named)
    // Tags travel with this one event: the SDK runs without async context here,
    // so a scope set for one report would leak into the next.
    Sentry.captureException(reported, {
      tags: Object.fromEntries(Object.entries(tags).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== '')),
    })
  }

  // A plugin that failed to start or crashed: Cordis marks its fiber FAILED,
  // and awaiting it rejects with the error. Plugins that failed before this
  // one started are found by a scan; later ones by the status event.
  const reportedFibers = new WeakSet<Fiber>()
  const reportFiber = (fiber: Fiber): void => {
    if (fiber.state !== FIBER_FAILED || reportedFibers.has(fiber)) return
    reportedFibers.add(fiber)
    fiber.await().catch((error: unknown) => { report(error, { source: 'plugin', plugin: fiber.name }) })
  }
  for (const runtime of ctx.registry.values()) for (const fiber of runtime.fibers) reportFiber(fiber)
  ctx.on('internal/status', (fiber) => { reportFiber(fiber) })

  // Error-level log lines, including a plugin that crashed while starting or
  // disposing, which Cordis logs under the plugin's name.
  const limit = new LogRateLimit(config.logEveryMinutes * 60_000, config.logPerMinute)
  ctx.effect(() => ctx.logger.exporter({
    levels: { default: 0 },
    export: (message) => {
      if (message.type !== 'error' || message.name === name) return
      const error = logLineError(message.args)
      if (skippedLogError(error) || !limit.admit(message.name)) return
      report(error, { source: 'log', logger: message.name, plugin: message.name })
    },
  }), 'error-reporting: log exporter')

  // The harness exits on these after its own diagnostic, disposing plugins
  // first; this plugin's disposer flushes what these listeners captured.
  const onException = (error: unknown): void => { report(error, { source: 'process', mechanism: 'uncaughtException' }) }
  const onRejection = (error: unknown): void => { report(error, { source: 'process', mechanism: 'unhandledRejection' }) }
  ctx.effect(() => {
    process.on('uncaughtException', onException)
    process.on('unhandledRejection', onRejection)
    return () => {
      process.off('uncaughtException', onException)
      process.off('unhandledRejection', onRejection)
    }
  }, 'error-reporting: process listeners')

  ctx.on('webserver/request-error', ({ method, path, error }) => {
    report(error, { source: 'request', method, route: path })
  })

  ctx.on('agent/error', ({ agent, error }: { agent: Agent; error: unknown }) => {
    const header = agent.session.requestHeader()
    const sessionId = String(agent.session.id)
    report(messageOnly(error), {
      source: 'session',
      session_id: sessionId,
      plugin: sessionPlugin(sessionId),
      provider: header?.config.provider,
      model: header?.config.model,
    })
  })

  ctx.on('klipara-scout/failure', (failure) => {
    report(messageOnly(failure.error), {
      source: 'scout', plugin: 'klipara-scout', stage: failure.stage, lead_id: failure.leadId, sample_id: failure.sampleId,
    }, failure.redact)
  })

  // The Web UI: settings injected per request, the bundle served on demand.
  const tunnelPath = config.tunnelPath.replace(/\/+$/u, '')
  ctx.on('webserver/index-inject', (table) => {
    table.push({
      kind: 'global',
      name: '__DSH_SENTRY__',
      value: {
        dsn: browserDsn.canonical, tunnel: tunnelPath, environment: config.environment, userId,
        ...config.release === '' ? {} : { release: config.release },
      },
    })
    table.push({ kind: 'script-src', placement: 'head', src: `${tunnelPath}/sdk.js` })
  })

  const tunnel = createTunnel({
    dsn: browserDsn,
    maxBytes: config.tunnelMaxBytes,
    perMinute: config.tunnelPerMinute,
    timeoutMs: config.tunnelTimeoutMs,
    trustProxy: config.trustProxy,
  })
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: tunnelPath, handler: tunnel }), 'error-reporting: tunnel')

  let bundle: Promise<string> | undefined
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${tunnelPath}/sdk.js`,
    handler: async (_req: IncomingMessage, res: ServerResponse) => {
      bundle ??= buildBrowserBundle()
      try {
        const code = await bundle
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'private, max-age=3600' })
        res.end(code)
      } catch (error) {
        bundle = undefined
        process.stderr.write(`error-reporting: the browser reporter did not build: ${error instanceof Error ? error.message : String(error)}\n`)
        res.writeHead(503, { 'Content-Type': 'text/javascript; charset=utf-8' })
        res.end('/* error reporting unavailable */')
      }
    },
  }), 'error-reporting: browser reporter')

  // Admin check: signed-in POST sends one test event and waits for it to leave.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${tunnelPath}/test`,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
      const eventId = Sentry.captureException(new Error('Harness error-reporting test event'), { tags: { test: 'true', source: 'test' } })
      const sent = await Sentry.flush(5000)
      process.stderr.write(`error-reporting: test event ${eventId} ${sent ? 'sent' : 'not confirmed within 5s'}\n`)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ eventId, sent }))
    },
  }), 'error-reporting: test route')

  ctx.effect(() => async () => {
    await Sentry.close(2000)
  }, 'error-reporting: flush on shutdown')
}

/**
 * Bundle the browser reporter (Sentry's browser SDK and the shared scrubber)
 * into one script. Built on first request and kept in memory.
 * @returns the script.
 */
async function buildBrowserBundle(): Promise<string> {
  const { build } = await import('esbuild')
  const entry = fileURLToPath(new URL('../src/browser.ts', import.meta.url))
  const result = await build({
    entryPoints: [entry], bundle: true, format: 'iife', platform: 'browser', target: 'es2020',
    minify: true, write: false, legalComments: 'none', logLevel: 'silent',
  })
  const file = result.outputFiles[0]
  if (file === undefined) throw new Error('esbuild produced no output')
  return file.text
}
