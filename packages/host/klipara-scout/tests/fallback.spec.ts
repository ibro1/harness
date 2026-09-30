import { describe, expect, it } from 'vitest'
import { FallbackRouter, providerFailure, type FallbackSwitch, type Route } from '../src/fallback.ts'

const agy = { provider: 'agy', model: 'gemini-3.8-flash-medium', reasoningEffort: 'medium' as const }
const pickle: Route = { provider: 'opencode', model: 'big-pickle' }
const quota = { code: 'QUOTA', message: 'Resource exhausted' }

function router(fallback: Route | null = pickle): { r: FallbackRouter; switches: FallbackSwitch[] } {
  const switches: FallbackSwitch[] = []
  return { r: new FallbackRouter(() => fallback ?? undefined, (change) => { switches.push(change) }), switches }
}

describe('scout fallback model', () => {
  it('moves a failed turn to the fallback, once, and back to the shift model on the next turn', () => {
    const { r, switches } = router()
    expect(r.request('s', 1, agy)).toEqual(agy)
    expect(r.failed('s', 1, quota)).toBe(true)
    expect(switches).toMatchObject([{ sessionId: 's', turn: 1, from: { provider: 'agy' }, to: pickle }])
    expect(r.onFallback('s')).toBe(true)
    const retried = r.request('s', 1, agy)
    expect(retried).toMatchObject(pickle)
    expect(retried.reasoningEffort).toBeUndefined()
    // The fallback failing too ends the turn: no second switch.
    expect(r.failed('s', 1, quota)).toBe(false)
    // Next turn: the logged header names the fallback, the shift's model is restored.
    expect(r.request('s', 2, { ...pickle })).toEqual(agy)
    expect(r.onFallback('s')).toBe(false)
    expect(switches).toHaveLength(1)
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

  it('does not switch when the shift already runs on the fallback model', () => {
    const { r } = router()
    r.request('s', 1, { ...pickle })
    expect(r.failed('s', 1, quota)).toBe(false)
    expect(r.request('s', 2, { ...pickle })).toEqual(pickle)
  })

  it('reads provider failures by code and message', () => {
    expect(providerFailure({ code: 'SERVER', message: 'Unexpected server error' })).toBe(true)
    expect(providerFailure({ code: 'RATE_LIMIT', message: '429' })).toBe(true)
    expect(providerFailure({ code: 'PI_AI_ERROR', message: 'agy ran longer than the 45 minutes limit' })).toBe(false)
  })
})
