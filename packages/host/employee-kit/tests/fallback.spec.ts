import { describe, expect, it } from 'vitest'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { FallbackRouter, providerFailure, quotaFailure, resetAfterMs, type FallbackSwitch, type Route } from '../src/fallback.ts'

const agy = { provider: 'agy', model: 'gemini-3.8-flash-medium', reasoningEffort: ReasoningEffortId('medium') }
const pickle: Route = { provider: 'opencode', model: 'big-pickle' }
const quota = {
  code: 'PI_AI_ERROR',
  message: 'agy: RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 1h56m58s.',
}
const server = { code: 'SERVER', message: 'Unexpected server error' }
const HOUR = 60 * 60_000

function router(fallback: Route | null = pickle) {
  const switches: FallbackSwitch[] = []
  let clock = 1_000_000
  const r = new FallbackRouter({
    fallback: () => fallback ?? undefined,
    shift: () => ({ provider: 'agy', model: 'gemini-3.8-flash-medium' }),
    cooldownMs: () => 15 * 60_000,
    onSwitch: (change) => { switches.push(change) },
    now: () => clock,
  })
  return { r, switches, advance: (ms: number) => { clock += ms } }
}

describe('an employee fallback model', () => {
  it('benches a spent quota until its stated reset, sending every turn meanwhile straight to the fallback', () => {
    const { r, switches, advance } = router()
    expect(r.request('s', 1, agy)).toEqual(agy)
    expect(r.skipsRetries(quota)).toBe(true)
    expect(r.failed('s', 1, quota)).toBe(true)
    expect(switches).toMatchObject([{ from: { provider: 'agy' }, to: pickle, stated: true }])
    expect(switches[0]!.until.getTime() - 1_000_000).toBe(HOUR + 56 * 60_000 + 58_000)
    const retried = r.request('s', 1, agy)
    expect(retried).toMatchObject(pickle)
    expect(retried.reasoningEffort).toBeUndefined()

    // Later turns, and other scout Sessions, skip agy while it is benched.
    advance(HOUR)
    expect(r.request('s', 2, { ...pickle })).toMatchObject(pickle)
    expect(r.onFallback('s')).toBe(true)
    expect(r.request('other', 1, agy)).toMatchObject(pickle)
    expect(switches).toHaveLength(1)

    // After the reset, the next turn tries agy again.
    advance(HOUR)
    expect(r.request('s', 3, { ...pickle })).toEqual(agy)
    expect(r.onFallback('s')).toBe(false)
  })

  it('leaves a transient failure to the harness retries, then benches for the cooldown', () => {
    const { r, switches, advance } = router()
    r.request('s', 1, agy)
    expect(r.skipsRetries(server)).toBe(false)
    expect(r.failed('s', 1, server)).toBe(true)
    expect(switches).toMatchObject([{ stated: false }])
    advance(14 * 60_000)
    expect(r.request('s', 2, { ...pickle })).toMatchObject(pickle)
    advance(2 * 60_000)
    expect(r.request('s', 3, { ...pickle })).toEqual(agy)
  })

  it('does not switch when the fallback itself fails, and reports each outage once', () => {
    const { r, switches } = router()
    r.request('s', 1, agy)
    r.failed('s', 1, quota)
    r.request('s', 1, agy)
    expect(r.failed('s', 1, quota)).toBe(false)
    expect(switches).toHaveLength(1)
  })

  it('restores the configured shift model for a Session it has not seen, as after a restart', () => {
    const { r } = router()
    expect(r.request('s', 7, { ...pickle })).toEqual({ provider: 'agy', model: 'gemini-3.8-flash-medium' })
  })

  it('does not switch for a watchdog stop, a context overflow, a cancel, or with no fallback set', () => {
    const { r } = router()
    r.request('s', 1, agy)
    expect(r.failed('s', 1, { code: 'PI_AI_ERROR', message: 'agy made no progress for 10 minutes (last action: browser_click). The run was stopped; ask again to retry.' })).toBe(false)
    expect(r.failed('s', 1, { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'too long' })).toBe(false)
    expect(r.failed('s', 1, { code: 'ABORTED', message: 'aborted' })).toBe(false)
    const none = router(null)
    none.r.request('s', 1, agy)
    expect(none.r.failed('s', 1, quota)).toBe(false)
  })

  it('reads quota failures and their reset times', () => {
    expect(quotaFailure(quota)).toBe(true)
    expect(quotaFailure(server)).toBe(false)
    expect(resetAfterMs(quota)).toBe(HOUR + 56 * 60_000 + 58_000)
    expect(resetAfterMs({ code: 'X', message: 'Resets in 45s' })).toBe(45_000)
    expect(resetAfterMs({ code: 'X', message: 'quota', providerRetryAfterMs: 3000 })).toBe(3000)
    expect(resetAfterMs(server)).toBeUndefined()
    expect(providerFailure({ code: 'PI_AI_ERROR', message: 'agy ran longer than the 45 minutes limit' })).toBe(false)
  })
})
