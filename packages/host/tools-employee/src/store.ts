/**
 * The tools employee's durable state in one JSON file, replaced atomically
 * with writes serialized: runs, researched keyword candidates with their
 * evidence and gate decision, the shortlists sent to the owner and what was
 * approved, the tools on the site with their test and publish history, the
 * Google results-page and autocomplete caches, the log of live results-page
 * reads that the daily cap counts, and the key that signs review links.
 */

import { readFile } from 'node:fs/promises'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { GateResult, Niche } from './gate.ts'
import type { SerpExtract, SerpVerdict } from './serp.ts'

/** One researched keyword and the tool it would get. */
export interface Candidate {
  id: string
  keyword: string
  /** The tool's name as a reader would say it, such as "Zakat calculator for business stock". */
  tool: string
  slug: string
  niche: Niche
  markets: string[]
  suggestions: string[]
  volume?: number
  serpVerdict: SerpVerdict
  serpAt: string
  /** People also ask questions, for the FAQs. */
  questions: string[]
  /** The first page's hosts, best first. */
  hosts: string[]
  evergreen: { lasting: boolean; why: string }
  differentiator: string
  gate: GateResult
  savedAt: string
  runId: string
}

/** One proposed tool on a shortlist. */
export interface ShortlistItem {
  n: number
  candidateId: string
  slug: string
  tool: string
  keyword: string
  verdict: string
  demand: string
  market: string
  rpm: string
  difficulty: number
  score: number
  differentiator: string
  /** Null until the owner decides. */
  approved: boolean | null
  builtAt?: string
  publishedAt?: string
}

/** A shortlist sent to the owner. */
export interface Shortlist {
  id: string
  /** Prefix the owner may put on a WhatsApp reply, such as `#t1a2b`. */
  tag: string
  createdAt: string
  /** What the WhatsApp send reported. */
  sent: string
  status: 'pending' | 'decided'
  decidedAt?: string
  decidedVia?: 'page' | 'whatsapp'
  note: string
  items: ShortlistItem[]
}

/** A tool's latest test run. */
export interface TestRecord {
  status: 'passed' | 'failed'
  at: string
  /** Hash of the tool's files the tests ran against; a later edit needs a new run. */
  hash: string
  output: string
}

/** A tool on the site. */
export interface ToolRecord {
  slug: string
  title: string
  keyword: string
  /** Shipped with the site's first release rather than built by a run. */
  seed: boolean
  shortlistId?: string
  firstPublishedAt?: string
  lastPublishedAt?: string
  tests?: TestRecord
  gsc?: { at: string; clicks: number; impressions: number; ctr: number; position: number }
  /** What the latest Search Console review says to do with it. */
  flag?: string
}

/** One run, scheduled, asked for, or started by an approval. */
export interface RunRecord {
  id: string
  kind: 'research' | 'build'
  trigger: 'schedule' | 'owner' | 'approval'
  startedAt: string
  sessionId?: string
  finishedAt?: string
  abandoned?: boolean
}

/** A cached results-page read. */
export interface SerpCacheEntry {
  at: string
  extract: SerpExtract
  verdict: SerpVerdict
}

/** What the last publish did. */
export interface PublishRecord {
  at: string
  version: string
  commit: string
  pushed: string
  deploy: string
}

/** What the last look at the live site found. */
export interface SiteCheck {
  at: string
  state: 'live' | 'outdated' | 'not-deployed' | 'unreachable'
  detail: string
  liveVersion: string | null
}

/** The latest Search Console review. */
export interface GscReview {
  at: string
  property: string
  striking: { query: string; page: string; impressions: number; position: number }[]
  lowCtr: { query: string; page: string; impressions: number; ctr: number; position: number }[]
  prune: string[]
  totals: { clicks: number; impressions: number }
}

/** The whole file. */
export interface ToolsState {
  version: 1
  runs: RunRecord[]
  candidates: Candidate[]
  shortlists: Shortlist[]
  tools: Record<string, ToolRecord>
  serpCache: Record<string, SerpCacheEntry>
  /** ISO times of live results-page reads, for the daily cap. */
  serpLog: string[]
  suggestions: Record<string, { at: string; list: string[] }>
  volumes: Record<string, { at: string; volume: number | null }>
  lastShiftDate: string | null
  publish?: PublishRecord
  siteCheck?: SiteCheck
  gsc?: GscReview
  /** The standing pages on the live site and whether each answered. */
  pages?: Record<string, boolean>
  /** When the owner was told the site is ready for AdSense. */
  adsenseToldAt?: string
  /** Signs the review links sent to the owner. */
  linkKey?: string
}

/**
 * A state with nothing in it.
 * @returns the empty state.
 */
export function emptyState(): ToolsState {
  return {
    version: 1, runs: [], candidates: [], shortlists: [], tools: {}, serpCache: {}, serpLog: [], suggestions: {}, volumes: {},
    lastShiftDate: null,
  }
}

const KEEP_RUNS = 40
const KEEP_CANDIDATES = 200
const KEEP_SHORTLISTS = 30

/**
 * Drop expired caches and old bookkeeping so the file stays small.
 * @param state - the state, changed in place.
 * @param now - the instant.
 * @param cacheMs - how long cache entries live.
 */
export function prune(state: ToolsState, now: Date, cacheMs: number): void {
  const fresh = (at: string): boolean => now.getTime() - Date.parse(at) < cacheMs
  for (const map of [state.serpCache, state.suggestions, state.volumes] as Record<string, { at: string }>[]) {
    for (const [key, entry] of Object.entries(map)) if (!fresh(entry.at)) Reflect.deleteProperty(map, key)
  }
  state.serpLog = state.serpLog.filter(at => now.getTime() - Date.parse(at) < 2 * 86_400_000)
  if (state.runs.length > KEEP_RUNS) state.runs = state.runs.slice(-KEEP_RUNS)
  if (state.candidates.length > KEEP_CANDIDATES) state.candidates = state.candidates.slice(-KEEP_CANDIDATES)
  if (state.shortlists.length > KEEP_SHORTLISTS) state.shortlists = state.shortlists.slice(-KEEP_SHORTLISTS)
}

/** The file-backed store. */
export class ToolsStore {
  private queue: Promise<unknown> = Promise.resolve()

  /** @param path - absolute path of the JSON file; its directory is created on first write. */
  constructor(private readonly path: string) {}

  /**
   * Read the current state; a missing file reads as empty.
   * @returns the state.
   */
  async read(): Promise<ToolsState> {
    let raw: string
    try {
      raw = await readFile(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState()
      throw error
    }
    return { ...emptyState(), ...JSON.parse(raw) as Partial<ToolsState>, version: 1 }
  }

  /**
   * Apply one change and persist it; changes run one at a time.
   * @param change - mutates the state and returns the caller's result.
   * @returns what `change` returned.
   */
  update<T>(change: (state: ToolsState) => T): Promise<T> {
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
