/**
 * Production error reporting to a Sentry-compatible server (GlitchTip), as a
 * plugin with its own settings page. The DSN is set on **Plugins → Error
 * reporting** or through `SENTRY_DSN` in the deployment's environment, which
 * wins when set. Until a DSN exists the plugin is idle and the Sentry SDK is
 * not loaded; saving, changing or clearing the DSN starts, restarts or stops
 * reporting within a few seconds, without a redeploy.
 *
 * Reported, each through the privacy scrubber (`scrub.ts`):
 * - a plugin that failed to start or crashed, tagged with its name;
 * - error-level log lines, tagged with the logger, rate-limited;
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
import type { Context, Fiber, FiberState, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-host-klipara-scout'
import { expectedError, scrubEvent } from './scrub.ts'
import { createTunnel, parseDsn, type Dsn } from './tunnel.ts'

export { expectedError, scrubEvent, scrubString, scrubTag, scrubValue } from './scrub.ts'
export { createTunnel, envelopeUrl, parseDsn, type Dsn, type TunnelOptions } from './tunnel.ts'

/** Cordis's const enum has no runtime object to import; this mirrors its FAILED member. */
const FIBER_FAILED = 3 as FiberState.FAILED

export const name = 'error-reporting'
export const inject = ['webServer']

/**
 * Composition config. The `Volatile` fields are edited on the Plugins page;
 * the `env*` fields carry the deployment's `SENTRY_*` variables, which win when set.
 */
export interface Config {
  /** Where reports go (`https://<key>@<host>/<project>`). Write-only on the page. Empty with no `SENTRY_DSN`: nothing is reported and the SDK is not loaded. */
  dsn: Volatile<string>
  /** The DSN handed to the Web UI; empty uses the DSN. */
  publicDsn: Volatile<string>
  environment: Volatile<string>
  release: Volatile<string>
  /** Share of transactions traced; 0 (the default) turns tracing off. */
  tracesSampleRate: Volatile<number>
  envDsn: string
  envPublicDsn: string
  envEnvironment: string
  envRelease: string
  /** `SENTRY_TRACES_SAMPLE_RATE` as written; empty defers to the page. */
  envTracesSampleRate: string
  /** How often the settings are re-read, so a saved DSN applies without a restart. */
  checkEveryMs: number
  /** Same-origin path of the browser tunnel; `<path>/sdk.js`, `<path>/status` and `<path>/test` sit under it. */
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
  dsn: z.string().role('secret').default('').volatile(),
  publicDsn: z.string().default('').volatile(),
  environment: z.string().default('production').volatile(),
  release: z.string().default('').volatile(),
  tracesSampleRate: z.number().min(0).max(1).default(0).volatile(),
  envDsn: z.string().default(''),
  envPublicDsn: z.string().default(''),
  envEnvironment: z.string().default(''),
  envRelease: z.string().default(''),
  envTracesSampleRate: z.string().default(''),
  checkEveryMs: z.natural().min(1000).default(5000),
  tunnelPath: z.string().default('/api/monitor'),
  tunnelMaxBytes: z.natural().default(1024 * 1024),
  tunnelPerMinute: z.natural().default(60),
  tunnelTimeoutMs: z.natural().default(5000),
  logEveryMinutes: z.natural().default(5),
  logPerMinute: z.natural().default(30),
  trustProxy: z.boolean().default(false),
  account: z.string().default('admin'),
})

/** The settings in force: each field from the environment when set there, else from the page. */
export interface EffectiveSettings {
  dsn: string
  publicDsn: string
  environment: string
  release: string
  tracesSampleRate: number
  /** Where the DSN came from. */
  source: 'environment' | 'settings' | 'none'
}

/**
 * Resolve the settings in force.
 * @param config - the plugin config.
 * @returns the effective settings.
 */
export function effectiveSettings(config: Config): EffectiveSettings {
  const pick = (env: string, page: string | undefined): string => env.trim() !== '' ? env.trim() : (page ?? '').trim()
  const dsn = pick(config.envDsn, config.dsn.get())
  const rate = config.envTracesSampleRate.trim() !== '' ? Number(config.envTracesSampleRate) : config.tracesSampleRate.get()
  return {
    dsn,
    publicDsn: pick(config.envPublicDsn, config.publicDsn.get()),
    environment: pick(config.envEnvironment, config.environment.get()) || 'production',
    release: pick(config.envRelease, config.release.get()),
    tracesSampleRate: Number.isFinite(rate) && rate >= 0 && rate <= 1 ? rate : 0,
    source: config.envDsn.trim() !== '' ? 'environment' : dsn !== '' ? 'settings' : 'none',
  }
}

/** What the settings page shows: where reports go, never the key. */
export interface ReportingStatus {
  enabled: boolean
  source: EffectiveSettings['source']
  /** The GlitchTip server and project, from the DSN. */
  host?: string
  projectId?: string
  environment?: string
  release?: string
  /** Why a configured DSN is not in use, e.g. it does not parse. */
  error?: string
}

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

/** One started SDK and what it was started with. */
interface Active {
  key: string
  dsn: Dsn
  browserDsn: Dsn
  settings: EffectiveSettings
  tunnel: (req: IncomingMessage, res: ServerResponse) => Promise<void>
}

/**
 * Install reporting. Listeners and routes are installed at once and do
 * nothing while no DSN is in force; the SDK is loaded with the first DSN.
 * @param ctx - the plugin context.
 * @param config - the DSN, limits and deployment overrides.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  type SentryModule = typeof import('@sentry/node')
  let Sentry: SentryModule | undefined
  let active: Active | undefined
  let status: ReportingStatus = { enabled: false, source: 'none' }
  const userId = createHash('sha256').update(config.account).digest('hex').slice(0, 12)
  // Strings a report must not carry, keyed by the error they travel with.
  const redactions = new WeakMap<object, readonly string[]>()
  const tunnelPath = config.tunnelPath.replace(/\/+$/u, '')

  const stop = async (): Promise<void> => {
    if (active === undefined || Sentry === undefined) return
    active = undefined
    await Sentry.close(2000)
  }

  const start = async (settings: EffectiveSettings, key: string): Promise<void> => {
    let dsn: Dsn
    let browserDsn: Dsn
    try {
      dsn = parseDsn(settings.dsn)
      browserDsn = parseDsn(settings.publicDsn === '' ? settings.dsn : settings.publicDsn)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      status = { enabled: false, source: settings.source, error: reason }
      process.stderr.write(`error-reporting: sentry_disabled (${reason})\n`)
      return
    }
    Sentry ??= await import('@sentry/node')
    const tracing = settings.tracesSampleRate > 0
    Sentry.init({
      dsn: dsn.canonical,
      environment: settings.environment,
      ...settings.release === '' ? {} : { release: settings.release },
      // Only the integrations named here run: no sessions, no request or console
      // capture, no local variables, no automatic process handlers (the harness
      // owns its own fatal exit, and the listeners below only report).
      defaultIntegrations: false,
      integrations: [Sentry.linkedErrorsIntegration(), Sentry.dedupeIntegration(), Sentry.functionToStringIntegration()],
      skipOpenTelemetrySetup: !tracing,
      ...tracing ? { tracesSampleRate: settings.tracesSampleRate } : {},
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
    active = {
      key, dsn, browserDsn, settings,
      tunnel: createTunnel({
        dsn: browserDsn,
        maxBytes: config.tunnelMaxBytes,
        perMinute: config.tunnelPerMinute,
        timeoutMs: config.tunnelTimeoutMs,
        trustProxy: config.trustProxy,
      }),
    }
    status = {
      enabled: true, source: settings.source, host: dsn.origin, projectId: dsn.projectId, environment: settings.environment,
      ...settings.release === '' ? {} : { release: settings.release },
    }
    process.stderr.write(`error-reporting: sentry_enabled source=${settings.source} host=${new URL(dsn.origin).host} project=${dsn.projectId} environment=${settings.environment}${settings.release === '' ? '' : ` release=${settings.release}`}\n`)
  }

  // Settings are re-read on a timer: a volatile field has no change signal,
  // and a DSN saved on the page must apply without a restart.
  let syncing: Promise<void> = Promise.resolve()
  let lastKey: string | undefined
  const sync = (): Promise<void> => {
    syncing = syncing.then(async () => {
      const settings = effectiveSettings(config)
      const key = JSON.stringify([settings.dsn, settings.publicDsn, settings.environment, settings.release, settings.tracesSampleRate])
      if (key === lastKey) return
      lastKey = key
      await stop()
      if (settings.dsn === '') {
        status = { enabled: false, source: 'none' }
        process.stderr.write('error-reporting: sentry_disabled (no DSN: set one on Plugins -> Error reporting or SENTRY_DSN)\n')
        return
      }
      await start(settings, key)
    }).catch((error: unknown) => {
      process.stderr.write(`error-reporting: could not apply the settings: ${error instanceof Error ? error.message : String(error)}\n`)
    })
    return syncing
  }
  await sync()
  const timer = setInterval(() => { void sync() }, config.checkEveryMs)
  timer.unref()
  ctx.effect(() => () => { clearInterval(timer) }, 'error-reporting: settings check')

  const report = (error: unknown, tags: Record<string, string | undefined>, named: readonly string[] = []): void => {
    if (active === undefined || Sentry === undefined || expectedError(error)) return
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
      if (active === undefined || message.type !== 'error' || message.name === name) return
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

  // The Web UI: settings injected per page render while reporting is on.
  ctx.on('webserver/index-inject', (table) => {
    if (active === undefined) return
    table.push({
      kind: 'global',
      name: '__DSH_SENTRY__',
      value: {
        dsn: active.browserDsn.canonical, tunnel: tunnelPath, environment: active.settings.environment, userId,
        ...active.settings.release === '' ? {} : { release: active.settings.release },
      },
    })
    table.push({ kind: 'script-src', placement: 'head', src: `${tunnelPath}/sdk.js` })
  })

  const json = (res: ServerResponse, code: number, body: unknown): void => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(body))
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: tunnelPath,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (active === undefined) { json(res, 404, { error: 'error reporting is off' }); return }
      await active.tunnel(req, res)
    },
  }), 'error-reporting: tunnel')

  let bundle: Promise<string> | undefined
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${tunnelPath}/sdk.js`,
    handler: async (_req: IncomingMessage, res: ServerResponse) => {
      if (active === undefined) { res.writeHead(404); res.end(); return }
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

  // The settings page's status line: where reports go, never the key.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${tunnelPath}/status`,
    handler: async (_req: IncomingMessage, res: ServerResponse) => {
      await sync()
      json(res, 200, status)
    },
  }), 'error-reporting: status route')

  // Admin check: a signed-in POST sends one test event and waits for it to leave.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${tunnelPath}/test`,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
      await sync()
      if (active === undefined || Sentry === undefined) {
        json(res, 409, { sent: false, error: status.error ?? 'Error reporting is off: save a DSN first.' })
        return
      }
      const eventId = Sentry.captureException(new Error('Harness error-reporting test event'), { tags: { test: 'true', source: 'test' } })
      const sent = await Sentry.flush(5000)
      process.stderr.write(`error-reporting: test event ${eventId} ${sent ? 'sent' : 'not confirmed within 5s'}\n`)
      json(res, 200, { eventId, sent })
    },
  }), 'error-reporting: test route')

  ctx.effect(() => async () => {
    await stop()
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
