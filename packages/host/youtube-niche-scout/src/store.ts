/**
 * The scout's durable state in one JSON file, replaced atomically, with
 * writes serialized: research runs and the niches scored in each, the
 * finished reports (kept as history), the API key's quota spent per Pacific
 * day, caches of searches, channels and autocomplete answers, and the key
 * that signs report links.
 */

import { readFile } from 'node:fs/promises'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { CategoryKey, Competition, ScoreParts } from './scoring.ts'
import type { ChannelInfo, VideoInfo } from './youtube.ts'

/** One piece of evidence the model gave for a score part. */
export interface Evidence {
  score: number
  why: string
}

/** A niche as scored in one run. */
export interface NicheRecord {
  name: string
  category: CategoryKey
  /** The search seeds and keywords that belong to it. */
  keywords: string[]
  /** The audience's countries the RPM band is adjusted for. */
  markets: string[]
  parts: ScoreParts
  /** The model's reasons, by part; RPM's is the table's note. */
  evidence: Record<keyof ScoreParts, string>
  /** RPM band in US dollars after the audience's countries. */
  rpm: [number, number]
  /** Out of 100. */
  score: number
  /** Channels the outlier score rests on, with what made each one count. */
  examples: { id: string; title: string; note: string }[]
  reliesOnOthersFootage: boolean
  /** Content gaps: questions in comments, outdated top videos. */
  gaps: string
  savedAt: string
}

/** One research run, scheduled or asked for. */
export interface RunRecord {
  id: string
  startedAt: string
  trigger: 'schedule' | 'owner' | 'tool'
  sessionId?: string
  finishedAt?: string
  /** Set when the run ended without a report: superseded by a newer run. */
  abandoned?: boolean
  reportId?: string
  /** Topic searches made (not cached), against the per-run cap. */
  searches: number
  /** Quota units spent. */
  units: number
  niches: NicheRecord[]
}

/** The report's ideas for one niche. */
export interface IdeaSet {
  niche: string
  titles: string[]
}

/** A finished weekly report. */
export interface ReportRecord {
  id: string
  runId: string
  createdAt: string
  summary: string
  recommendation: { niche: string; why: string; firstSteps: string[] }
  /** Ranked best first, at most eight. */
  niches: NicheRecord[]
  ideas: IdeaSet[]
  risks: string
  /** What the run used and could not use (autocomplete, trends, Keyword Planner). */
  method: string
  /** Rank changes against the previous report, written by the plugin. */
  changes: string[]
  searches: number
  units: number
}

/** A cached topic search. */
export interface SearchCacheEntry {
  at: string
  totalResults: number
  videos: VideoInfo[]
  competition: Competition
}

/** The whole file. */
export interface ScoutState {
  version: 1
  runs: RunRecord[]
  reports: ReportRecord[]
  /** Quota units by Pacific date. */
  quota: Record<string, number>
  searches: Record<string, SearchCacheEntry>
  channels: Record<string, { at: string; channel: ChannelInfo }>
  suggestions: Record<string, { at: string; list: string[] }>
  lastShiftDate: string | null
  /** Signs the report links sent to the owner. */
  linkKey?: string
}

/**
 * A state with nothing in it.
 * @returns the empty state.
 */
export function emptyState(): ScoutState {
  return { version: 1, runs: [], reports: [], quota: {}, searches: {}, channels: {}, suggestions: {}, lastShiftDate: null }
}

/** Runs kept besides those a report needs; reports are kept for good. */
const KEEP_RUNS = 30
/** Quota days kept. */
const KEEP_QUOTA_DAYS = 14

/**
 * Drop expired cache entries and old bookkeeping so the file stays small.
 * @param state - the state, changed in place.
 * @param now - the instant.
 * @param cacheMs - how long a cache entry lives.
 */
export function prune(state: ScoutState, now: Date, cacheMs: number): void {
  const fresh = (at: string): boolean => now.getTime() - Date.parse(at) < cacheMs
  for (const map of [state.searches, state.channels, state.suggestions] as Record<string, { at: string }>[]) {
    for (const [key, entry] of Object.entries(map)) if (!fresh(entry.at)) Reflect.deleteProperty(map, key)
  }
  const days = Object.keys(state.quota).sort()
  for (const day of days.slice(0, Math.max(0, days.length - KEEP_QUOTA_DAYS))) Reflect.deleteProperty(state.quota, day)
  if (state.runs.length > KEEP_RUNS) state.runs = state.runs.slice(-KEEP_RUNS)
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
    let raw: string
    try {
      raw = await readFile(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState()
      throw error
    }
    return { ...emptyState(), ...JSON.parse(raw) as Partial<ScoutState>, version: 1 }
  }

  /**
   * Apply one change and persist it; changes run one at a time.
   * @param change - mutates the state and returns the caller's result.
   * @returns what `change` returned.
   */
  update<T>(change: (state: ScoutState) => T): Promise<T> {
    const run = this.queue.then(async () => {
      const state = await this.read()
      const result = change(state)
      await writeFileAtomic(this.path, `${JSON.stringify(state)}\n`, { mode: 0o600, dirMode: 0o700 })
      return result
    })
    this.queue = run.catch(() => undefined)
    return run
  }
}
