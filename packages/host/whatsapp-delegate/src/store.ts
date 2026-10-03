/**
 * The delegate's durable state in one JSON file, replaced atomically, with
 * writes serialized: read cursors, each contact's queue and Session, the open
 * and recent batches, the delegate's own sends, approvals waiting for the
 * owner, notes for the next batch, and the activity log the Plugins page shows.
 */

import { readFile } from 'node:fs/promises'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { QueuedRow, WaRow } from './logic.ts'

/** Entries the activity log keeps. */
export const ACTIVITY_LIMIT = 300
/** Batches kept after they close. */
export const BATCH_LIMIT = 100
/** Sends kept, for the rate limit, the hand-off rule and the card. */
export const SENT_LIMIT = 500

/** A message the delegate sent, or asked the owner to approve. */
export interface SentRecord {
  contactId: string
  chat: string
  text: string
  at: string
  /** WhatsApp's id of the sent message, when the service returned one. */
  waId?: string
  tier: 'routine' | 'approved' | 'owner'
  batchId?: string
}

/** A reply waiting for the owner. */
export interface Approval {
  /** The short number the owner answers with. */
  code: number
  contactId: string
  chat: string
  text: string
  why: string
  quote?: string
  batchId?: string
  createdAt: string
  status: 'pending' | 'sent' | 'rejected' | 'failed'
  decidedAt?: string
  /** What the WhatsApp service answered, or why it was not sent. */
  outcome?: string
}

/** One thing the delegate did with a batch. */
export interface BatchAction {
  kind: 'reply' | 'queued' | 'no-reply' | 'tell-owner' | 'refused'
  text: string
  at: string
  code?: number
  /** For `no-reply`: the owner should hear about it. */
  mention?: boolean
}

/** One handful of a contact's messages handed to the Session. */
export interface BatchRecord {
  id: string
  contactId: string
  sessionId?: string
  startedAt: string
  endedAt?: string
  status: 'running' | 'done' | 'handed-off' | 'failed' | 'interrupted'
  messages: WaRow[]
  actions: BatchAction[]
  error?: string
  /** Put back in the queue once after a restart interrupted it. */
  requeued?: boolean
}

/** One line of the activity log. */
export interface ActivityEntry {
  at: string
  contactId: string
  kind: 'inbound' | 'batch' | 'reply' | 'queued' | 'approved' | 'rejected' | 'no-reply' | 'owner' | 'handoff' | 'error' | 'refused'
  text: string
}

/** Per contact. */
export interface ContactState {
  /** Last row id read, by chat JID. */
  cursors: Record<string, number>
  queue: QueuedRow[]
  sessionId?: string
  /** Unix seconds of the owner's latest message typed in this contact's chats. */
  lastOwnerTs: number
  /** The chat the contact last wrote from; replies go there. */
  lastChat?: string
  /** Row ids already answered; never answered twice. */
  answered: number[]
  /** For the next batch: the owner's decisions and instructions. */
  notes: string[]
}

/** The whole file. */
export interface DelegateState {
  version: 1
  paused: { reason: string; at: string } | null
  contacts: Record<string, ContactState>
  batches: BatchRecord[]
  sent: SentRecord[]
  approvals: Approval[]
  nextCode: number
  /** Last row id read in the owner's notify chat. */
  ownerCursor?: number
  activity: ActivityEntry[]
}

/**
 * A state with nothing in it.
 * @returns the empty state.
 */
export function emptyState(): DelegateState {
  return { version: 1, paused: null, contacts: {}, batches: [], sent: [], approvals: [], nextCode: 1, activity: [] }
}

/**
 * The state of one contact, created on first use.
 * @param state - mutated when the contact is new.
 * @param contactId - the contact.
 * @returns the contact's state.
 */
export function contactState(state: DelegateState, contactId: string): ContactState {
  state.contacts[contactId] ??= { cursors: {}, queue: [], lastOwnerTs: 0, answered: [], notes: [] }
  return state.contacts[contactId]
}

/**
 * Add one line to the activity log, dropping the oldest past the limit.
 * @param state - mutated.
 * @param entry - the line, without its time.
 * @param at - when; defaults to now.
 */
export function log(state: DelegateState, entry: Omit<ActivityEntry, 'at'>, at = new Date().toISOString()): void {
  state.activity.push({ at, ...entry, text: entry.text.slice(0, 1000) })
  if (state.activity.length > ACTIVITY_LIMIT) state.activity.splice(0, state.activity.length - ACTIVITY_LIMIT)
}

/**
 * Keep the closed batches, the sends and the decided approvals within their limits.
 * @param state - mutated.
 */
export function prune(state: DelegateState): void {
  const closed = state.batches.filter(b => b.status !== 'running')
  if (closed.length > BATCH_LIMIT) {
    const drop = new Set(closed.slice(0, closed.length - BATCH_LIMIT))
    state.batches = state.batches.filter(b => !drop.has(b))
  }
  if (state.sent.length > SENT_LIMIT) state.sent.splice(0, state.sent.length - SENT_LIMIT)
  const decided = state.approvals.filter(a => a.status !== 'pending')
  if (decided.length > BATCH_LIMIT) {
    const drop = new Set(decided.slice(0, decided.length - BATCH_LIMIT))
    state.approvals = state.approvals.filter(a => !drop.has(a))
  }
  for (const contact of Object.values(state.contacts)) {
    if (contact.answered.length > SENT_LIMIT) contact.answered.splice(0, contact.answered.length - SENT_LIMIT)
  }
}

/** The file-backed store. */
export class DelegateStore {
  private queue: Promise<unknown> = Promise.resolve()

  /** @param path - absolute path of the JSON file; its directory is created on first write. */
  constructor(private readonly path: string) {}

  /**
   * Read the current state; a missing file reads as empty.
   * @returns the state.
   */
  async read(): Promise<DelegateState> {
    let raw: string
    try {
      raw = await readFile(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState()
      throw error
    }
    return { ...emptyState(), ...JSON.parse(raw) as Partial<DelegateState>, version: 1 }
  }

  /**
   * Apply one change and persist it; changes run one at a time.
   * @param change - mutates the state and returns the caller's result.
   * @returns what `change` returned.
   */
  update<T>(change: (state: DelegateState) => T): Promise<T> {
    const run = this.queue.then(async () => {
      const state = await this.read()
      const result = change(state)
      prune(state)
      await writeFileAtomic(this.path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
      return result
    })
    this.queue = run.catch(() => undefined)
    return run
  }
}
