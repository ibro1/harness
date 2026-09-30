/**
 * The shift's fallback model. When the shift's model fails for a provider
 * reason (quota, rate limit, server error, a broken stream) after the
 * harness's own retries, the failed request is retried once on the fallback
 * model and the rest of that turn runs there. The next turn tries the shift's
 * model again. A run the bridge's watchdog stopped is not a provider failure:
 * it means the page it was driving hung, which another model would hit too.
 *
 * While a turn runs on the fallback, pitching is held unless the owner allows
 * it, so what goes out under the outreach account's name is written by the
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

/** Failures another model would not fix: the request, the context, or a cancel. */
const NOT_PROVIDER_FAILURES = new Set([
  'ABORTED', 'CONTEXT_LENGTH', 'CONTEXT_WINDOW_EXCEEDED', 'IMAGE_OFFLOAD_REQUIRED', 'INVALID_REQUEST', 'INVALID_PREPARED_CALL',
  'INVALID_REPLAY_STATE', 'UNSUPPORTED_CONTENT', 'UNSUPPORTED_OPTION', 'UNSUPPORTED_REASONING_EFFORT', 'INVARIANT',
])

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

function same(a: Route, b: Route): boolean {
  return a.provider === b.provider && a.model === b.model
}

/** Per-Session fallback state. */
interface SessionRoute {
  /** The route the shift asked for, restored after a fallback turn. */
  primary?: LlmCallConfig
  /** The turn now running on the fallback, if any. */
  fallbackTurn?: number
  /** The route of the latest request. */
  last?: Route
}

/** What the router reports when it switches a turn to the fallback. */
export interface FallbackSwitch {
  sessionId: string
  turn: number
  from: Route
  to: Route
  failure: Pick<LlmFailure, 'code' | 'message'>
}

/** Decides each scout request's route and when a failure moves a turn to the fallback. */
export class FallbackRouter {
  private readonly sessions = new Map<string, SessionRoute>()

  /**
   * @param fallback - the configured fallback, or undefined when none is set.
   * @param onSwitch - told once per turn that moves to the fallback.
   */
  constructor(
    private readonly fallback: () => Route | undefined,
    private readonly onSwitch: (change: FallbackSwitch) => void,
  ) {}

  private state(sessionId: string): SessionRoute {
    let state = this.sessions.get(sessionId)
    if (state === undefined) {
      state = {}
      this.sessions.set(sessionId, state)
    }
    return state
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
    if (state.fallbackTurn !== undefined && turn > state.fallbackTurn) delete state.fallbackTurn
    const fallback = this.fallback()
    let route = resolved
    if (state.fallbackTurn !== undefined && fallback !== undefined) {
      const { reasoningEffort: _effort, ...rest } = resolved
      route = { ...rest, provider: fallback.provider, model: fallback.model }
    } else if (state.primary !== undefined && fallback !== undefined && same(resolved, fallback) && !same(state.primary, fallback)) {
      // A new turn after a fallback turn: the logged header still names the
      // fallback, so the shift's own model is put back.
      route = { ...resolved, ...state.primary }
    } else {
      state.primary = resolved
    }
    state.last = { provider: route.provider, model: route.model }
    return route
  }

  /**
   * Decide whether a failed request moves its turn to the fallback.
   * @param sessionId - the Session.
   * @param turn - the turn whose request failed.
   * @param failure - the failure, after the harness's own retries gave up.
   * @returns true when the request should be retried on the fallback.
   */
  failed(sessionId: string, turn: number, failure: Pick<LlmFailure, 'code' | 'message'>): boolean {
    const fallback = this.fallback()
    if (fallback === undefined || !providerFailure(failure)) return false
    const state = this.state(sessionId)
    const from = state.last
    if (from === undefined || same(from, fallback) || state.fallbackTurn === turn) return false
    state.fallbackTurn = turn
    this.onSwitch({ sessionId, turn, from, to: fallback, failure })
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
 * the request uses, and a failure reaches them only after the harness's own
 * retries have given up.
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
    const decision = await next()
    if (decision?.kind === 'retry' || signal.aborted || !applies(agent)) return decision
    return router.failed(String(agent.session.id), turn, failure) ? { kind: 'retry' } : decision
  }, { prepend: true })
  ctx.on('agent/disposed', ({ agent }) => { router.forget(String(agent.session.id)) })
}
