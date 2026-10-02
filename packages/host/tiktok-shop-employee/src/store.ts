/**
 * The employee's durable state in one JSON file, replaced atomically, with
 * writes serialized: products found, videos made from them and what the owner
 * did with each, the daily counter the cap is enforced against, the pause
 * switch, and the key that signs the owner's review links.
 */

import { readFile } from 'node:fs/promises'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { ShopProduct } from './socialcrawl.ts'
import type { ScriptLine } from './render.ts'

/** A product the employee is working, with why it was picked. */
export interface TrackedProduct extends ShopProduct {
  foundAt: string
  /** The search that found it. */
  query: string
  /** Set when the owner or the employee rules it out. */
  rejected?: { why: string; at: string }
}

/** Where a video is between script and the owner's account. */
export type VideoStatus = 'rendering' | 'failed' | 'ready' | 'posted' | 'skipped'

/** One video. */
export interface VideoRecord {
  id: string
  productId: string
  /** The format the script follows, in the skill's words ("showcase", "problem-fix", "comparison", "countdown"). */
  format: string
  hook: string
  lines: ScriptLine[]
  endCard: string
  /** The caption to paste into TikTok, with `#ad` first. */
  caption: string
  status: VideoStatus
  createdAt: string
  /** Seconds, once rendered. */
  seconds?: number
  error?: string
  /** File name under the media directory, once rendered. */
  file?: string
  postedAt?: string
  skippedAt?: string
  /** The last prepare or post run in the owner's TikTok browser. */
  posting?: {
    mode: 'prepare' | 'post'
    state: 'running' | 'done' | 'failed'
    at: string
    steps: { step: string; ok: boolean; note?: string }[]
    error?: string
    /** File name of the upload page's screenshot, under the media directory. */
    shot?: string
  }
  /** What the owner reported after posting. */
  results?: { views?: number; sales?: number; at: string }
}

/** Videos rendered on one local day. */
export interface DayCount {
  videos: number
}

/** The whole file. */
export interface ShopState {
  version: 1
  products: TrackedProduct[]
  videos: VideoRecord[]
  days: Record<string, DayCount>
  paused: { reason: string; at: string } | null
  lastShiftDate: string | null
  lastShiftSession?: string
  /** Signs the review links sent to the owner. */
  linkKey?: string
}

/** A state with nothing in it. */
export function emptyState(): ShopState {
  return { version: 1, products: [], videos: [], days: {}, paused: null, lastShiftDate: null }
}

/** The file-backed store. */
export class ShopStore {
  private queue: Promise<unknown> = Promise.resolve()

  /** @param path - absolute path of the JSON file; its directory is created on first write. */
  constructor(private readonly path: string) {}

  /**
   * Read the current state; a missing file reads as empty.
   * @returns the state.
   */
  async read(): Promise<ShopState> {
    let raw: string
    try {
      raw = await readFile(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState()
      throw error
    }
    return { ...emptyState(), ...JSON.parse(raw) as Partial<ShopState>, version: 1 }
  }

  /**
   * Apply one change and persist it; changes run one at a time.
   * @param change - mutates the state and returns the caller's result.
   * @returns what `change` returned.
   */
  update<T>(change: (state: ShopState) => T): Promise<T> {
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
