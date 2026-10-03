/**
 * The reminders' durable state in one JSON file, replaced atomically, with
 * writes serialized: which reminders have gone out (each at most once), the
 * failed attempts of those still being retried, and the recent send history.
 */

import { readFile } from 'node:fs/promises'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

/** How many entries the send history keeps. */
export const HISTORY_LIMIT = 50

/**
 * What became of one reminder key. `sending` is written before the message goes, so a crash mid-send never sends it
 * twice; `gave-up` follows the last failed attempt.
 */
export interface Done {
  outcome: 'sending' | 'sent' | 'gave-up'
  at: string
}

/** One attempt, sent or not, as the settings page lists it. */
export interface SendRecord {
  key: string
  ruleId: string
  label: string
  meetingDate: string
  daysBefore: number
  at: string
  ok: boolean
  /** What the WhatsApp route answered. */
  outcome: string
  /** Sent from the settings page rather than on schedule. */
  manual?: boolean
}

/** The whole file. */
export interface ReminderState {
  version: 1
  /** By `ruleId|meetingDate|daysBefore`. */
  done: Record<string, Done>
  /** Failed attempts of keys not yet done. */
  attempts: Record<string, number>
  /** Newest last, at most `HISTORY_LIMIT`. */
  sent: SendRecord[]
}

/**
 * A state with nothing in it.
 * @returns the empty state.
 */
export function emptyState(): ReminderState {
  return { version: 1, done: {}, attempts: {}, sent: [] }
}

/**
 * Add one attempt to the history, dropping the oldest past the limit.
 * @param state - mutated.
 * @param record - the attempt.
 */
export function remember(state: ReminderState, record: SendRecord): void {
  state.sent.push(record)
  if (state.sent.length > HISTORY_LIMIT) state.sent.splice(0, state.sent.length - HISTORY_LIMIT)
}

/**
 * Forget keys of meetings long past, so the file stays small; a key can only come due before its meeting day ends.
 * @param state - mutated.
 * @param before - `YYYY-MM-DD`; keys of meetings before it go.
 */
export function prune(state: ReminderState, before: string): void {
  for (const table of [state.done, state.attempts]) {
    for (const key of Object.keys(table)) if ((key.split('|')[1] ?? '') < before) Reflect.deleteProperty(table, key)
  }
}

/** The file-backed store. */
export class ReminderStore {
  private queue: Promise<unknown> = Promise.resolve()

  /** @param path - absolute path of the JSON file; its directory is created on first write. */
  constructor(private readonly path: string) {}

  /**
   * Read the current state; a missing file reads as empty.
   * @returns the state.
   */
  async read(): Promise<ReminderState> {
    let raw: string
    try {
      raw = await readFile(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState()
      throw error
    }
    return { ...emptyState(), ...JSON.parse(raw) as Partial<ReminderState>, version: 1 }
  }

  /**
   * Apply one change and persist it; changes run one at a time.
   * @param change - mutates the state and returns the caller's result.
   * @returns what `change` returned.
   */
  update<T>(change: (state: ReminderState) => T): Promise<T> {
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
