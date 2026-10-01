/**
 * An employee shift's fallback model. When the shift's model fails for a
 * provider reason, the employee's requests move to the fallback model and the
 * shift's model is benched: until its quota resets, when the provider said
 * when that is, or for a cooldown otherwise. While it is benched every turn of
 * the employee's Sessions goes straight to
 * the fallback; the first turn after the bench ends tries the shift's model
 * again, and a new failure benches it again.
 *
 * A spent quota moves at once: retrying it only repeats the refusal. Other
 * provider failures (a server error, a broken stream) first get the harness's
 * own retries. A run the bridge's watchdog stopped is not a provider failure:
 * it means the page it was driving hung, which another model would hit too.
 *
 * An employee may hold outward-facing tools while a turn runs on the fallback
 * (`onFallback`), so what goes out under the owner's name is written by the
 * model the owner chose.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, RequestErrorAction } from '@deepseek-ai/dsh-agent'
import type { LlmCallConfig, LlmFailure } from '@deepseek-ai/dsh-llm'

/** A provider and model pair. */
export interface Route {
  provider: string
  model: string
}

/** The fields of a failure the router reads. */
export type RouteFailure = Pick<LlmFailure, 'code' | 'message' | 'providerRetryAfterMs'>

/** Failures another model would not fix: the request, the context, or a cancel. */
const NOT_PROVIDER_FAILURES = new Set([
  'ABORTED', 'CONTEXT_LENGTH', 'CONTEXT_WINDOW_EXCEEDED', 'IMAGE_OFFLOAD_REQUIRED', 'INVALID_REQUEST', 'INVALID_PREPARED_CALL',
  'INVALID_REPLAY_STATE', 'UNSUPPORTED_CONTENT', 'UNSUPPORTED_OPTION', 'UNSUPPORTED_REASONING_EFFORT', 'INVARIANT',
])

/** A quota that is spent until a reset, as providers word it. */
const QUOTA_WORDS = /RESOURCE_EXHAUSTED|quota|resets? in|usage limit|insufficient_quota|credit balance/iu

/** Longest bench a stated reset may set, so a misread reset cannot bench the model for days. */
const MAX_BENCH_MS = 24 * 60 * 60_000

/**
 * Whether a failed request is the provider's fault, so another model may succeed.
 * @param failure - the failure.
 * @returns true for quota, rate-limit, server, transport and stream failures.
 */
export function providerFailure(failure: Pick<LlmFailure, 'code' | 'message'>): boolean {
  if (NOT_PROVIDER_FAILURES.has(failure.code)) return false
  // The bridge watchdog's stop: the run hung on what it was doing, not on the model.
  return !/made no progress for|ran longer than the/u.test(failure.message)
}

/**
 * Whether a failure is a spent quota, which no immediate retry fixes.
 * @param failure - the failure.
 * @returns true for a quota refusal.
 */
export function quotaFailure(failure: Pick<LlmFailure, 'code' | 'message'>): boolean {
  return failure.code === 'QUOTA' || QUOTA_WORDS.test(failure.message)
}

/**
 * When a failure says the provider is usable again, as milliseconds from now:
 * the provider's retry-after, else a "Resets in 1h56m58s" in the message.
 * @param failure - the failure.
 * @returns the wait, or undefined when the failure does not say.
 */
export function resetAfterMs(failure: RouteFailure): number | undefined {
  if (failure.providerRetryAfterMs !== undefined && failure.providerRetryAfterMs > 0) return failure.providerRetryAfterMs
  const match = /resets? in\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m(?!s))?\s*(?:(\d+)\s*s)?/iu.exec(failure.message)
  if (match === null) return undefined
  const [hours, minutes, seconds] = [match[1], match[2], match[3]].map(part => Number(part ?? '0'))
  const ms = (((hours ?? 0) * 60 + (minutes ?? 0)) * 60 + (seconds ?? 0)) * 1000
  return ms > 0 ? ms : undefined
}

function same(a: Route, b: Route): boolean {
  return a.provider === b.provider && a.model === b.model
}

function key(route: Route): string {
  return `${route.provider}/${route.model}`
}

/** Per-Session fallback state. */
interface SessionRoute {
  /** The route the shift asked for, restored once it is off the bench. */
  primary?: LlmCallConfig
  /** The turn now running on the fallback, if any. */
  fallbackTurn?: number
  /** The route of the latest request. */
  last?: Route
}

/** What the router reports when it benches the shift's model. */
export interface FallbackSwitch {
  sessionId: string
  turn: number
  from: Route
  to: Route
  failure: RouteFailure
  /** When the shift's model is tried again. */
  until: Date
  /** Whether the provider said when (a quota reset), rather than the cooldown applying. */
  stated: boolean
}

/** Tunables of the router. */
export interface FallbackOptions {
  /** The configured fallback, or undefined when none is set. */
  fallback: () => Route | undefined
  /** The configured shift model, restored when a Session's own choice is not known (after a restart). */
  shift: () => Route | undefined
  /** How long a failed model is benched when the failure does not say. */
  cooldownMs: () => number
  /** Told once each time a model is benched. */
  onSwitch: (change: FallbackSwitch) => void
  now?: () => number
}

/** Decides each employee request's route and when a failure benches the shift's model. */
export class FallbackRouter {
  private readonly sessions = new Map<string, SessionRoute>()
  /** Benched routes and when each may be tried again, shared by every Session of the employee. */
  private readonly benched = new Map<string, number>()
  private readonly now: () => number

  /** @param options - the fallback, the cooldown, the switch report, and a clock. */
  constructor(private readonly options: FallbackOptions) {
    this.now = options.now ?? Date.now
  }

  private state(sessionId: string): SessionRoute {
    let state = this.sessions.get(sessionId)
    if (state === undefined) {
      state = {}
      this.sessions.set(sessionId, state)
    }
    return state
  }

  /**
   * When a route may be tried again, if it is benched now.
   * @param route - the route.
   * @returns the time, or undefined when it is not benched.
   */
  benchedUntil(route: Route): Date | undefined {
    const until = this.benched.get(key(route))
    if (until === undefined) return undefined
    if (until <= this.now()) {
      this.benched.delete(key(route))
      return undefined
    }
    return new Date(until)
  }

  /**
   * The route for one request.
   * @param sessionId - the Session.
   * @param turn - the open turn.
   * @param resolved - the route the harness would use.
   * @returns the route to use.
   */
  request(sessionId: string, turn: number, resolved: LlmCallConfig): LlmCallConfig {
    const state = this.state(sessionId)
    const fallback = this.options.fallback()
    if (state.fallbackTurn !== undefined && turn > state.fallbackTurn) delete state.fallbackTurn
    // After a fallback turn the logged header names the fallback; the shift asked for its own model.
    const own = state.primary ?? this.options.shift()
    const restoring = own !== undefined && fallback !== undefined && same(resolved, fallback) && !same(own, fallback)
    const wanted = restoring ? { ...resolved, ...own } : resolved
    state.primary = wanted
    let route = wanted
    const away = state.fallbackTurn !== undefined || this.benchedUntil(wanted) !== undefined
    if (fallback !== undefined && !same(wanted, fallback) && away) {
      state.fallbackTurn ??= turn
      const { reasoningEffort: _effort, ...rest } = wanted
      route = { ...rest, provider: fallback.provider, model: fallback.model }
    }
    state.last = { provider: route.provider, model: route.model }
    return route
  }

  /**
   * Whether a failed request should move to the fallback at once, before the
   * harness's own retries: only a spent quota, which retrying cannot fix.
   * @param failure - the failure.
   * @returns true to skip the retries.
   */
  skipsRetries(failure: RouteFailure): boolean {
    return providerFailure(failure) && quotaFailure(failure)
  }

  /**
   * Decide whether a failed request moves its turn to the fallback, and bench
   * the model that failed.
   * @param sessionId - the Session.
   * @param turn - the turn whose request failed.
   * @param failure - the failure.
   * @returns true when the request should be retried on the fallback.
   */
  failed(sessionId: string, turn: number, failure: RouteFailure): boolean {
    const fallback = this.options.fallback()
    if (fallback === undefined || !providerFailure(failure)) return false
    const state = this.state(sessionId)
    const from = state.last
    if (from === undefined || same(from, fallback) || state.fallbackTurn === turn) return false
    const stated = resetAfterMs(failure)
    const until = this.now() + Math.min(stated ?? this.options.cooldownMs(), MAX_BENCH_MS)
    const already = this.benchedUntil(from) !== undefined
    this.benched.set(key(from), until)
    state.fallbackTurn = turn
    if (!already) {
      this.options.onSwitch({ sessionId, turn, from, to: fallback, failure, until: new Date(until), stated: stated !== undefined })
    }
    return true
  }

  /**
   * Whether a Session's current turn runs on the fallback.
   * @param sessionId - the Session.
   * @returns true while it does.
   */
  onFallback(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.fallbackTurn !== undefined
  }

  /**
   * Forget a Session that is gone.
   * @param sessionId - the Session.
   */
  forget(sessionId: string): void {
    this.sessions.delete(sessionId)
  }
}

/**
 * Route the chosen Sessions' requests through a fallback router. Both listeners
 * are prepended so they wrap every other one: the route they return is the one
 * the request uses. A spent quota is decided before the harness's own retries,
 * which would only repeat the refusal; any other failure reaches the router
 * after those retries have given up.
 * @param ctx - the plugin context.
 * @param router - the router.
 * @param applies - whether an agent's requests go through the router.
 */
export function installFallback(ctx: Context, router: FallbackRouter, applies: (agent: Agent) => boolean): void {
  ctx.on('agent/request', async ({ agent, turn }, next): Promise<LlmCallConfig> => {
    const resolved = await next()
    return applies(agent) ? router.request(String(agent.session.id), turn, resolved) : resolved
  }, { prepend: true })
  ctx.on('agent/request-error', async ({ agent, turn, failure, signal }, next): Promise<RequestErrorAction> => {
    // A spent quota owns its recovery here: the harness's retries would only repeat the refusal.
    const sessionId = String(agent.session.id)
    if (applies(agent) && !signal.aborted && router.skipsRetries(failure) && router.failed(sessionId, turn, failure)) {
      return { kind: 'retry' }
    }
    const decision = await next()
    if (decision?.kind === 'retry' || signal.aborted || !applies(agent)) return decision
    return router.failed(sessionId, turn, failure) ? { kind: 'retry' } : decision
  }, { prepend: true })
  ctx.on('agent/disposed', ({ agent }) => { router.forget(String(agent.session.id)) })
}
