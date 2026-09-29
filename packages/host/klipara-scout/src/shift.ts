/**
 * The daily shift: deciding in the operator's time zone whether today's shift
 * is due, and starting it as an ordinary root Session with the shift prompt,
 * the same way the webhook ingress starts one.
 */

import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-workspace'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** The prompt that opens a Klipara Scout shift. */
    'klipara-scout': {
      readonly kind: 'klipara-scout'
      readonly form: 'notice'
      readonly summary: string
    }
  }
}

/** A wall-clock reading in one time zone. */
export interface LocalTime {
  /** `YYYY-MM-DD`. */
  date: string
  /** Minutes since local midnight. */
  minutes: number
}

/**
 * Read the local date and time in a time zone.
 * @param now - the instant.
 * @param timeZone - an IANA zone, for example `Africa/Lagos`.
 * @returns the local date and minute of day.
 */
export function localTime(now: Date, timeZone: string): LocalTime {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map(part => [part.type, part.value]))
  return {
    date: `${parts['year'] ?? ''}-${parts['month'] ?? ''}-${parts['day'] ?? ''}`,
    minutes: Number(parts['hour'] ?? 0) * 60 + Number(parts['minute'] ?? 0),
  }
}

/**
 * Parse `HH:MM` into minutes since midnight.
 * @param value - the configured shift time.
 * @returns the minutes, or undefined when the value is not a time of day.
 */
export function parseShiftTime(value: string): number | undefined {
  const match = /^(\d{1,2}):(\d{2})$/u.exec(value.trim())
  if (match === null) return undefined
  const hours = Number(match[1])
  const minutes = Number(match[2])
  return hours < 24 && minutes < 60 ? hours * 60 + minutes : undefined
}

/**
 * Whether today's shift should start now.
 * @param now - the local reading.
 * @param shiftMinutes - the configured start, minutes since midnight.
 * @param lastShiftDate - the local date the last shift started, if any.
 * @returns true once the start time has passed on a day with no shift yet.
 */
export function shiftDue(now: LocalTime, shiftMinutes: number, lastShiftDate: string | null): boolean {
  return now.minutes >= shiftMinutes && lastShiftDate !== now.date
}

/** What one shift Session is started with. */
export interface ShiftRequest {
  workspacePath: string
  title: string
  prompt: string
  agentPreset: string
  permissionPreset: string
  /** Empty provider or model uses the harness default model. */
  provider: string
  model: string
}

/**
 * Start a shift as a new root Session and hand it the prompt.
 * @param ctx - a context injecting agents, agentDefaultModel, agentPresets, permissionPresets, sessionTitle and workspaceRegistry.
 * @param request - the shift.
 * @param signal - cancels startup.
 * @returns the new Session's id.
 */
export async function startShift(ctx: Context, request: ShiftRequest, signal: AbortSignal): Promise<string> {
  const selected = ctx.agentDefaultModel.currentSelection()
  const useDefault = request.provider.trim() === '' || request.model.trim() === ''
  const agentOptions = useDefault
    ? { provider: selected.provider, model: selected.model }
    : { provider: request.provider.trim(), model: request.model.trim() }
  ctx.permissionPresets.resolve(request.permissionPreset)
  const preset = await ctx.agentPresets.resolve(request.agentPreset)
  await using presetScope = await ctx.agentPresets.acquireScope(preset.id)
  void presetScope
  signal.throwIfAborted()
  const workspace = await ctx.workspaceRegistry.create(request.workspacePath)
  const sessionId = brandString<SessionId>(`scout-${randomUUID()}`)
  const handle = await ctx.agents.create({
    sessionId,
    signal,
    meta: { cwd: workspace.path, agentPreset: preset.id },
    agentOptions,
    setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, preset.id) },
  })
  let attached = false
  try {
    await workspace.attachSession(sessionId)
    attached = true
    ctx.permissionPresets.set(handle.agent.session, request.permissionPreset)
    ctx.sessionTitle.rename(handle.agent.session, request.title)
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: request.prompt }],
      source: { kind: 'klipara-scout', form: 'notice', summary: boundContextSummary(request.title) },
    }))
  } catch (error: unknown) {
    if (attached) await workspace.detachSession(sessionId).catch(() => undefined)
    await handle.dispose().catch(() => undefined)
    throw error
  }
  return sessionId
}
