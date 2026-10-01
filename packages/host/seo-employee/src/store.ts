/**
 * The SEO employee's durable state: the sites and their credentials, the
 * Google connection, cached research, the content map (topics), owner
 * questions, drafts and published articles. One JSON file, mode 0600 because
 * it holds credentials, replaced atomically with writes serialized.
 */

import { readFile } from 'node:fs/promises'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { ArticleDraft, Site, SiteSecrets } from './types.ts'

/** Where a topic is in the pipeline. */
export type TopicStatus = 'planned' | 'asked' | 'drafted' | 'published' | 'rejected'

/** One topic on a site's content map: a query cluster one page targets. */
export interface Topic {
  id: string
  siteId: string
  /** The main query the page targets. */
  keyword: string
  /** Other queries the same page serves (same search intent and overlapping results). */
  cluster: string[]
  intent: 'informational' | 'commercial' | 'transactional' | 'navigational'
  /** Why this topic, in the employee's words, with the numbers it saw. */
  why: string
  /** What the top results are and what they miss. */
  serpNotes: string
  /** `new` for a new article, or the URL of the article it refreshes. */
  target: string
  status: TopicStatus
  reason?: string
  createdAt: string
  updatedAt: string
}

/** Questions for the owner whose answers give an article first-hand material. */
export interface OwnerQuestion {
  /** Short tag the owner starts a WhatsApp reply with, for example `#q7k2`. */
  tag: string
  siteId: string
  topicId: string
  questions: string[]
  askedAt: string
  answer?: string
  answeredAt?: string
}

/** The editor model's verdict on a draft, recorded by the plugin itself. */
export interface EditorVerdict {
  at: string
  provider: string
  model: string
  scores: Record<string, number>
  total: number
  mustFix: string[]
  pass: boolean
}

/** A draft waiting for review or publication. */
export interface Draft {
  id: string
  siteId: string
  topicId: string
  draft: ArticleDraft
  /** Set when the draft refreshes a published article. */
  articleId?: string
  submittedAt: string
  editor?: EditorVerdict
}

/** A published article and how it is doing. */
export interface Article {
  id: string
  siteId: string
  topicId: string
  keyword: string
  remoteId: string
  slug: string
  title: string
  url: string
  publishedAt: string
  updatedAt: string
  editorTotal: number
  /** Unpublished by the owner's link or a tool. */
  unpublishedAt?: string
  /** Search Console readings, oldest first. */
  metrics: { at: string; days: number; clicks: number; impressions: number; position: number }[]
}

/** One cached research answer. */
export interface ResearchEntry {
  /** Hash of the request. */
  key: string
  kind: 'ideas' | 'metrics' | 'gsc' | 'suggest'
  siteId: string
  /** What was asked, for the log. */
  summary: string
  at: string
  result: unknown
}

/** The Google connection. */
export interface GoogleConnection {
  refreshToken: string
  scope: string
  connectedAt: string
}

/** The whole file. */
export interface SeoState {
  version: 1
  sites: Site[]
  secrets: Record<string, SiteSecrets>
  google: GoogleConnection | null
  /** An OAuth flow in progress: its state and PKCE verifier. */
  oauth: { state: string; verifier: string; at: string } | null
  research: ResearchEntry[]
  topics: Topic[]
  questions: OwnerQuestion[]
  drafts: Draft[]
  articles: Article[]
  paused: { reason: string; at: string } | null
  lastShiftDate: string | null
  lastShiftSession?: string
  /** Signs the owner's unpublish links; made on first start and kept, so links outlive restarts. */
  linkKey?: string
}

/**
 * A state with nothing in it.
 * @returns the empty state.
 */
export function emptyState(): SeoState {
  return {
    version: 1, sites: [], secrets: {}, google: null, oauth: null, research: [], topics: [], questions: [], drafts: [], articles: [],
    paused: null, lastShiftDate: null,
  }
}

/** The file-backed store. */
export class SeoStore {
  private queue: Promise<unknown> = Promise.resolve()

  /** @param path - absolute path of the JSON file; its directory is created on first write. */
  constructor(private readonly path: string) {}

  /**
   * Read the current state; a missing file reads as empty.
   * @returns the state.
   */
  async read(): Promise<SeoState> {
    let text: string
    try {
      text = await readFile(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState()
      throw error
    }
    return { ...emptyState(), ...JSON.parse(text) as Partial<SeoState>, version: 1 }
  }

  /**
   * Apply one change and persist it. Changes run one at a time, in call order.
   * @param change - mutates the state and returns the caller's result.
   * @returns what `change` returned.
   */
  update<T>(change: (state: SeoState) => T): Promise<T> {
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

/** Research entries kept; the oldest go first. */
export const RESEARCH_KEPT = 500

/**
 * A cached answer no older than `maxAgeDays`.
 * @param state - the state.
 * @param key - the request hash.
 * @param maxAgeDays - how old an answer may be.
 * @param now - the current time.
 * @returns the entry, or undefined.
 */
export function freshResearch(state: SeoState, key: string, maxAgeDays: number, now: Date): ResearchEntry | undefined {
  const entry = state.research.findLast(r => r.key === key)
  if (entry === undefined) return undefined
  return now.getTime() - Date.parse(entry.at) <= maxAgeDays * 86_400_000 ? entry : undefined
}

/**
 * Record a research answer, replacing an older one with the same key.
 * @param state - mutated.
 * @param entry - the answer.
 */
export function recordResearch(state: SeoState, entry: ResearchEntry): void {
  state.research = state.research.filter(r => r.key !== entry.key)
  state.research.push(entry)
  if (state.research.length > RESEARCH_KEPT) state.research.splice(0, state.research.length - RESEARCH_KEPT)
}

/**
 * The ISO week a date falls in, `YYYY-Www`, for the weekly article cap.
 * @param date - the instant.
 * @returns the week label.
 */
export function isoWeek(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  const day = d.getUTCDay() === 0 ? 7 : d.getUTCDay()
  d.setUTCDate(d.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7)
  return `${String(d.getUTCFullYear())}-W${String(week).padStart(2, '0')}`
}

/**
 * Articles a site published in the week of `now`.
 * @param state - the state.
 * @param siteId - the site.
 * @param now - the current time.
 * @returns the count, unpublished ones included (the cap counts what went out).
 */
export function publishedThisWeek(state: SeoState, siteId: string, now: Date): number {
  const week = isoWeek(now)
  return state.articles.filter(a => a.siteId === siteId && isoWeek(new Date(a.publishedAt)) === week).length
}
