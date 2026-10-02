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

/**
 * Whether a comment pitch can be seen by anyone but its author, read signed out
 * through the YouTube Data API. `unseen` is a first check that did not find it
 * (YouTube can take a while); `held` is a later check that still did not, which
 * means YouTube is holding it for review. `unknown` is a check that could not
 * run (comments off on the video, the API refused).
 */
export type CommentVisibility = 'pending' | 'visible' | 'unseen' | 'held' | 'unknown'

/** What one pitch-time search for a lead's address tried and found. */
export interface ContactSearch {
  at: string
  /** Each place looked, with what it gave: `about page: 3 links`, `lexfridman.com/contact: no address`. */
  tried: string[]
  /** The address it found, when it found one. */
  found?: string
}

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
  /** The podcast the lead was found through, when it came from a podcast feed. */
  podcast?: { title: string; feedUrl: string; directoryUrl: string }
  /** Set when the creator asked for a free clip on Klipara's own page: never pitched. */
  inbound?: { status: 'confirmed' | 'sent'; sourceUrl: string; sampleUrl?: string; at: string }
  /** Klipara analysis job for the sample. */
  jobId?: string
  /** The hosted sample's id and public page. */
  sampleId?: string
  samplePageUrl?: string
  pitch?: {
    via: PitchVia
    to: string
    text: string
    at: string
    /** Comment pitches only: whether it is publicly visible, and when that was last checked. */
    visibility?: { state: CommentVisibility; checkedAt?: string; detail?: string }
  }
  /** The one follow-up email sent after an email pitch went unanswered. */
  followUp?: { text: string; at: string }
  /** The last search for an address, run before a lead may be pitched by comment. */
  contactSearch?: ContactSearch
  /** Social profiles found on the channel, for the owner to message by hand. */
  socials?: string[]
  replies: { at: string; where: string; text: string }[]
  history: { at: string; stage: LeadStage; note?: string }[]
  createdAt: string
  updatedAt: string
}

/** Samples and pitches spent on one local calendar day. */
export interface DayCount {
  samples: number
  /** Emails, comments and follow-ups together. */
  pitches: number
  /** Comment pitches alone, held under their own lower cap. */
  comments?: number
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
  /** Podcast feeds already read, so no later search reads one again. Newest last, capped. */
  podcastsSeen?: string[]
  /** Free-clip event ids already recorded, so Klipara's retries change nothing. Newest last, capped. */
  inboundEvents?: string[]
  /** Set when comment pitches are stopped because YouTube held several in a row; email pitches go on. */
  commentsPaused?: { reason: string; at: string } | null
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
