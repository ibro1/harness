/**
 * The scout's durable state: every lead with its stage and history, the
 * per-day counters the caps are enforced against, the pause switch, and the
 * date of the last shift. One JSON file, replaced atomically, with writes
 * serialized so two tool calls cannot interleave a read-modify-write.
 */

import { readFile } from 'node:fs/promises'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

/** Where a lead is in the pipeline. */
export type LeadStage = 'found' | 'sampling' | 'sampled' | 'pitched' | 'replied' | 'won' | 'lost' | 'skipped'

/** Every stage, in pipeline order. */
export const LEAD_STAGES: readonly LeadStage[] = ['found', 'sampling', 'sampled', 'pitched', 'replied', 'won', 'lost', 'skipped']

/** How a pitch reached the creator. */
export type PitchVia = 'email' | 'comment'

/** One creator the scout is working. Keyed by YouTube channel id. */
export interface Lead {
  channelId: string
  channelName: string
  channelUrl: string
  subscribers?: number
  shortsCount?: number
  /** A public contact address found on the channel, when there is one. */
  email?: string
  videoId?: string
  videoUrl?: string
  videoTitle?: string
  durationMinutes?: number
  stage: LeadStage
  /** Who brought the lead in, for splitting what it earns. */
  source: string
  /** Klipara analysis job for the sample. */
  jobId?: string
  /** The hosted sample's id and public page. */
  sampleId?: string
  samplePageUrl?: string
  pitch?: { via: PitchVia; to: string; text: string; at: string }
  replies: { at: string; where: string; text: string }[]
  history: { at: string; stage: LeadStage; note?: string }[]
  createdAt: string
  updatedAt: string
}

/** Samples and pitches spent on one local calendar day. */
export interface DayCount {
  samples: number
  pitches: number
}

/** The whole file. */
export interface ScoutState {
  version: 1
  leads: Lead[]
  /** Keyed by local date, `YYYY-MM-DD`. */
  days: Record<string, DayCount>
  paused: { reason: string; at: string } | null
  lastShiftDate: string | null
  /** Session id of the latest shift, woken when its samples finish. */
  lastShiftSession?: string
}

/** A state with nothing in it. */
export function emptyState(): ScoutState {
  return { version: 1, leads: [], days: {}, paused: null, lastShiftDate: null }
}

/** The file-backed store. */
export class ScoutStore {
  private queue: Promise<unknown> = Promise.resolve()

  /** @param path - absolute path of the JSON file; its directory is created on first write. */
  constructor(private readonly path: string) {}

  /**
   * Read the current state; a missing file reads as empty.
   * @returns the state.
   */
  async read(): Promise<ScoutState> {
    let text: string
    try {
      text = await readFile(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState()
      throw error
    }
    const parsed = JSON.parse(text) as Partial<ScoutState>
    return { ...emptyState(), ...parsed, version: 1 }
  }

  /**
   * Apply one change and persist it. Changes run one at a time, in call order.
   * @param change - mutates the state and returns the caller's result.
   * @returns what `change` returned.
   */
  update<T>(change: (state: ScoutState) => T): Promise<T> {
    const run = this.queue.then(async () => {
      const state = await this.read()
      const result = change(state)
      await writeFileAtomic(this.path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
      return result
    })
    this.queue = run.catch(() => undefined)
    return run
  }
}

/**
 * Move a lead to a stage and record why.
 * @param lead - the lead, mutated in place.
 * @param stage - the new stage.
 * @param at - ISO timestamp.
 * @param note - what happened, for the history.
 */
export function advance(lead: Lead, stage: LeadStage, at: string, note?: string): void {
  lead.stage = stage
  lead.updatedAt = at
  lead.history.push({ at, stage, ...note === undefined ? {} : { note } })
}

/**
 * The counters for one day, created when absent.
 * @param state - the state, mutated when the day is new.
 * @param date - local date, `YYYY-MM-DD`.
 * @returns that day's counters.
 */
export function dayCount(state: ScoutState, date: string): DayCount {
  state.days[date] ??= { samples: 0, pitches: 0 }
  return state.days[date]
}
