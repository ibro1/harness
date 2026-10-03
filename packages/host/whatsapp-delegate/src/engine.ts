/**
 * The delegate's work loop without the harness around it: read each contact's
 * chats after a cursor, queue what arrived, hand a quiet burst to the
 * contact's Session, carry out the Session's decisions (send, queue for the
 * owner, stay quiet, tell the owner), read the owner's approval replies, and
 * send the owner one digest per batch. Everything that must hold whatever the
 * model does is enforced here: only listed contacts, the hand-off to the owner,
 * the rate limit, no double replies, and no secrets in outgoing text.
 */

import { randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  chatJid, contactNamed, findSecrets, localStamp, messageLine, ownerTyped, parseOwnerCommand, planBatch, splitReply,
  withinRateLimit, type BatchTiming, type Contact, type OwnerCommand, type WaRow,
} from './logic.ts'
import { contactState, log, type Approval, type BatchAction, type BatchRecord, type DelegateState, type DelegateStore } from './store.ts'
import type { WhatsAppClient } from './whatsapp.ts'

/** Settings read on every use, so a change on the Plugins page applies at once. */
export interface EngineSettings {
  enabled: boolean
  /** The owner's chat (a number or JID) for approvals, digests and his commands; empty turns them off. */
  notifyTo: string
  timeZone: string
  timing: BatchTiming
  /** Earlier messages of the chat given as context with each batch. */
  contextMessages: number
  /** Most messages to one contact in `rateWindowMs`. */
  maxReplies: number
  rateWindowMs: number
  /** Longest single WhatsApp message; longer replies are split. */
  maxReplyChars: number
  /** Send the owner a digest after each batch the delegate acted on. */
  digest: boolean
  /** The skill file the first message of a Session points to. */
  skillPath: string
}

/** How a batch reaches the contact's Session. */
export interface SessionDriver {
  /**
   * Hand a prompt to the contact's Session: follow up an idle one, steer a busy one, resume an unloaded one, or start a
   * new one when there is none or it cannot be resumed.
   * @returns the Session id and a promise that settles when the Session goes idle.
   */
  deliver: (contact: Contact, sessionId: string | undefined, prompt: string) => Promise<{ sessionId: string; idle: Promise<void> }>
}

/** What the engine needs. */
export interface EngineDeps {
  store: DelegateStore
  whatsapp: WhatsAppClient
  contacts: () => Contact[]
  settings: () => EngineSettings
  driver: SessionDriver
  /** Transcribe a voice note; rejects when it cannot. */
  transcribe: (audio: { mime: string; data: Buffer }) => Promise<string>
  /** Where pictures and files from contacts are saved for the Session to look at. */
  mediaDir: string
  /** Secret values that must never be sent. */
  secrets: () => readonly string[]
  now: () => number
  warn: (message: string) => void
}

/** A row with what the delegate learned from its media. */
type EnrichedRow = WaRow & { transcript?: string; file?: string; mediaError?: string }

const IMAGE_EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' }
/** A text sent to the same contact within this long is a duplicate. */
const DUPLICATE_WINDOW_MS = 6 * 3600_000

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

function quoteText(value: string, max = 160): string {
  const flat = value.replace(/\s+/gu, ' ').trim()
  return `"${flat.length > max ? `${flat.slice(0, max - 1)}…` : flat}"`
}

/** The delegate. */
export class DelegateEngine {
  private polling = false

  /** @param deps - store, WhatsApp, contacts, settings, the Session driver and helpers. */
  constructor(private readonly deps: EngineDeps) {}

  private contact(contactId: string): Contact {
    const contact = this.deps.contacts().find(c => c.id === contactId)
    if (contact === undefined) throw new Error(`No contact "${contactId}" is on the delegate's list.`)
    return contact
  }

  private active(contact: Contact, state: DelegateState): boolean {
    return this.deps.settings().enabled && state.paused === null && contact.enabled && !contact.paused
  }

  /** The chats a contact may be answered in. */
  private chats(contact: Contact): string[] {
    return contact.numbers.map(chatJid).filter((jid): jid is string => jid !== undefined)
  }

  private ownSends(state: DelegateState): Set<string> {
    return new Set(state.sent.map(s => s.waId).filter((id): id is string => id !== undefined))
  }

  /**
   * One round: read every active contact's chats and the owner's chat, then hand ready batches to their Sessions. A
   * round already running makes this one a no-op.
   */
  async poll(): Promise<void> {
    if (this.polling || !this.deps.whatsapp.configured) return
    this.polling = true
    try {
      const state = await this.deps.store.read()
      for (const contact of this.deps.contacts()) {
        try {
          if (this.active(contact, state)) await this.readContact(contact)
          else if (state.contacts[contact.id] !== undefined && Object.keys(state.contacts[contact.id]?.cursors ?? {}).length > 0) {
            // Paused or switched off: forget the place, so switching back on starts from new messages, not a backlog.
            await this.deps.store.update((s) => { const cs = contactState(s, contact.id); cs.cursors = {}; cs.queue = [] })
          }
        } catch (error) {
          this.deps.warn(`reading ${contact.name}'s chats failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      if (!this.deps.settings().enabled) {
        if (state.ownerCursor !== undefined) await this.deps.store.update((s) => { delete s.ownerCursor })
      } else {
        await this.readOwner().catch((error: unknown) => {
          this.deps.warn(`reading the owner's chat failed: ${error instanceof Error ? error.message : String(error)}`)
        })
      }
      for (const contact of this.deps.contacts()) {
        const fresh = await this.deps.store.read()
        if (!this.active(contact, fresh)) continue
        await this.dispatch(contact).catch((error: unknown) => {
          this.deps.warn(`handling ${contact.name}'s messages failed: ${error instanceof Error ? error.message : String(error)}`)
        })
      }
    } finally {
      this.polling = false
    }
  }

  private async readContact(contact: Contact): Promise<void> {
    const state = await this.deps.store.read()
    const known = state.contacts[contact.id]?.cursors ?? {}
    const found: Record<string, WaRow[]> = {}
    const starts: Record<string, number> = {}
    for (const chat of this.chats(contact)) {
      const after = known[chat]
      if (after === undefined) {
        // First look at this chat: start after its latest message, so history is never answered.
        const latest = await this.deps.whatsapp.read(chat, { limit: 1 })
        starts[chat] = latest[0]?.id ?? 0
        continue
      }
      const rows = await this.deps.whatsapp.read(chat, { after, limit: 200 })
      if (rows.length > 0) found[chat] = rows
    }
    if (Object.keys(found).length === 0 && Object.keys(starts).length === 0) return
    const now = this.deps.now()
    await this.deps.store.update((s) => {
      const cs = contactState(s, contact.id)
      Object.assign(cs.cursors, starts)
      const own = this.ownSends(s)
      for (const [chat, rows] of Object.entries(found)) {
        for (const row of rows) {
          cs.cursors[chat] = Math.max(cs.cursors[chat] ?? 0, row.id)
          if (cs.queue.some(q => q.id === row.id) || cs.answered.includes(row.id)) continue
          if (row.fromMe && !ownerTyped(row, own)) continue
          cs.queue.push({ ...row, seenAt: now })
          if (!row.fromMe) {
            cs.lastChat = chat
            log(s, { contactId: contact.id, kind: 'inbound', text: `${contact.name}: ${row.kind === 'text' ? row.body : `[${row.kind}] ${row.body}`}` })
          }
        }
      }
    })
  }

  private async dispatch(contact: Contact): Promise<void> {
    const settings = this.deps.settings()
    const state = await this.deps.store.read()
    const cs = state.contacts[contact.id]
    if (cs === undefined || cs.queue.length === 0) return
    const plan = planBatch(cs.queue, this.ownSends(state), cs.lastOwnerTs, this.deps.now(), settings.timing)
    if (plan.action === 'wait') return
    const ownerTs = Math.max(cs.lastOwnerTs, ...cs.queue.filter(r => r.fromMe).map(r => r.ts))
    if (plan.action === 'idle' || plan.action === 'handoff') {
      await this.deps.store.update((s) => {
        const c = contactState(s, contact.id)
        const ids = new Set(cs.queue.map(r => r.id))
        c.queue = c.queue.filter(r => !ids.has(r.id))
        c.lastOwnerTs = Math.max(c.lastOwnerTs, ownerTs)
        if (plan.action === 'handoff') {
          c.answered.push(...cs.queue.filter(r => !r.fromMe).map(r => r.id))
          log(s, { contactId: contact.id, kind: 'handoff', text: `${contact.name}: left to the owner (${plan.reason})` })
        }
      })
      return
    }
    const messages = plan.messages
    const ids = new Set(cs.queue.map(r => r.id))
    const batchId = `${this.deps.now().toString(36)}-${randomBytes(3).toString('hex')}`
    await this.deps.store.update((s) => {
      const c = contactState(s, contact.id)
      c.queue = c.queue.filter(r => !ids.has(r.id))
      c.lastOwnerTs = Math.max(c.lastOwnerTs, ownerTs)
      s.batches.push({
        id: batchId, contactId: contact.id, startedAt: iso(this.deps.now()), status: 'running',
        messages: messages.map(({ seenAt: _seenAt, ...row }) => row), actions: [],
      })
      log(s, { contactId: contact.id, kind: 'batch', text: `${contact.name}: ${String(messages.length)} message${messages.length === 1 ? '' : 's'} handed to the Session` })
    })
    const enriched = await Promise.all(messages.map(row => this.enrich(contact, row)))
    await this.deliver(contact, batchId, await this.prompt(contact, enriched))
  }

  /** Transcribe a voice note, or save a picture or file where the Session can open it. */
  private async enrich(contact: Contact, row: WaRow): Promise<EnrichedRow> {
    if (!row.hasMedia || row.kind === 'text' || row.kind === 'sticker') return row
    try {
      const media = await this.deps.whatsapp.media(row.id)
      if (row.kind === 'audio') return { ...row, transcript: await this.deps.transcribe(media) }
      const type = media.mime.split(';')[0]?.trim() ?? ''
      const ext = IMAGE_EXT[type] ?? (type.split('/')[1]?.replace(/[^\w]/gu, '') || 'bin')
      const dir = join(this.deps.mediaDir, contact.id)
      await mkdir(dir, { recursive: true })
      const file = join(dir, `${String(row.id)}.${ext}`)
      await writeFile(file, media.data)
      return { ...row, file }
    } catch (error) {
      return { ...row, mediaError: error instanceof Error ? error.message : String(error) }
    }
  }

  private async prompt(contact: Contact, messages: readonly EnrichedRow[], instruction?: string): Promise<string> {
    const settings = this.deps.settings()
    const state = await this.deps.store.read()
    const cs = contactState(state, contact.id)
    const newIds = new Set(messages.map(m => m.id))
    let context: WaRow[] = []
    if (settings.contextMessages > 0) {
      for (const chat of this.chats(contact)) {
        const rows = await this.deps.whatsapp.read(chat, { limit: settings.contextMessages + messages.length }).catch(() => [])
        context.push(...rows)
      }
      context = context.filter(r => !newIds.has(r.id)).sort((a, b) => a.ts - b.ts || a.id - b.id).slice(-settings.contextMessages)
    }
    const pending = state.approvals.filter(a => a.contactId === contact.id && a.status === 'pending')
    const project = [
      contact.workspacePath === '' ? undefined : `workspace ${contact.workspacePath}`,
      contact.repoUrl === '' ? undefined : `repository ${contact.repoUrl}`,
      contact.deployBranch === '' ? undefined : `deploy branch ${contact.deployBranch}`,
      contact.liveUrl === '' ? undefined : `live at ${contact.liveUrl}`,
    ].filter(Boolean).join('; ')
    const first = cs.sessionId === undefined
    return [
      instruction === undefined
        ? `New WhatsApp message${messages.length === 1 ? '' : 's'} from ${contact.name}. Now: ${localStamp(new Date(this.deps.now()), settings.timeZone)}.`
        : `The owner has an instruction about ${contact.name}. Now: ${localStamp(new Date(this.deps.now()), settings.timeZone)}.`,
      first
        ? `You answer ${contact.name}'s WhatsApp messages as the owner, in his name. Your instructions are the whatsapp-delegate skill at ${settings.skillPath}: read that file now and follow it exactly.`
        : `Follow the whatsapp-delegate skill (${settings.skillPath}) as before.`,
      '',
      `About ${contact.name}: ${contact.notes === '' ? 'no notes.' : contact.notes}`,
      `Their numbers: ${contact.numbers.join(', ')}.`,
      `Project: ${project === '' ? 'none set; this contact is conversation only.' : `${project}.`}`,
      ...instruction === undefined ? [] : ['', `The owner says: ${instruction}`],
      ...messages.length === 0 ? [] : ['', 'New messages (decide on these):', ...messages.map(m => messageLine(m, contact.name, settings.timeZone))],
      ...context.length === 0 ? [] : ['', 'Earlier in the chat, oldest first (context only; already handled):', ...context.map(m => messageLine(m, contact.name, settings.timeZone))],
      ...pending.length === 0 ? [] : ['', 'Your drafts waiting for the owner\'s approval (do not send them another way):', ...pending.map(a => `- #${String(a.code)} ${quoteText(a.text)}`)],
      ...cs.notes.length === 0 ? [] : ['', 'From the owner since the last batch:', ...cs.notes.map(n => `- ${n}`)],
      '',
      'End the batch with delegate_reply (once for each message you send) or delegate_no_reply. Tell the owner what he must know with delegate_tell_owner.',
    ].join('\n')
  }

  private async deliver(contact: Contact, batchId: string, prompt: string): Promise<void> {
    const state = await this.deps.store.read()
    try {
      const { sessionId, idle } = await this.deps.driver.deliver(contact, state.contacts[contact.id]?.sessionId, prompt)
      await this.deps.store.update((s) => {
        const cs = contactState(s, contact.id)
        cs.sessionId = sessionId
        cs.notes = []
        const batch = s.batches.find(b => b.id === batchId)
        if (batch !== undefined) batch.sessionId = sessionId
      })
      void idle.then(() => this.finish(contact.id), (error: unknown) => this.finish(contact.id, error))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.deps.store.update((s) => {
        const batch = s.batches.find(b => b.id === batchId)
        if (batch !== undefined) Object.assign(batch, { status: 'failed', error: message, endedAt: iso(this.deps.now()) })
        log(s, { contactId: contact.id, kind: 'error', text: `${contact.name}: the Session could not take the batch: ${message}` })
      })
      await this.notifyOwner(`WhatsApp delegate could not start work on ${contact.name}'s messages: ${message.slice(0, 300)}. Please look at the chat yourself.`)
    }
  }

  /**
   * Close a contact's running batches once its Session is idle, and send the owner the digest.
   * @param contactId - the contact.
   * @param error - why the Session stopped, when it failed.
   */
  async finish(contactId: string, error?: unknown): Promise<void> {
    const ended = await this.deps.store.update((s) => {
      const running = s.batches.filter(b => b.contactId === contactId && b.status === 'running')
      for (const batch of running) {
        batch.status = error === undefined ? 'done' : 'failed'
        batch.endedAt = iso(this.deps.now())
        if (error !== undefined) batch.error = error instanceof Error ? error.message : JSON.stringify(error)
      }
      return running.map(b => structuredClone(b))
    })
    if (ended.length === 0) return
    const contact = this.deps.contacts().find(c => c.id === contactId)
    const text = digestText(contact?.name ?? contactId, ended)
    if (text !== undefined && this.deps.settings().digest) await this.notifyOwner(text)
  }

  /** On start: batches a restart cut short go back to the queue once, unless they were already answered. */
  async recover(): Promise<void> {
    await this.deps.store.update((s) => {
      for (const batch of s.batches.filter(b => b.status === 'running')) {
        batch.status = 'interrupted'
        batch.endedAt = iso(this.deps.now())
        const acted = batch.actions.some(a => a.kind === 'reply' || a.kind === 'queued' || a.kind === 'no-reply')
        if (acted || batch.requeued === true) continue
        batch.requeued = true
        const cs = contactState(s, batch.contactId)
        const seenAt = this.deps.now() - 60 * 60_000
        for (const row of batch.messages) {
          if (!cs.answered.includes(row.id) && !cs.queue.some(q => q.id === row.id)) cs.queue.push({ ...row, seenAt })
        }
        log(s, { contactId: batch.contactId, kind: 'batch', text: 'a restart interrupted this batch; it goes to the Session again' })
      }
    })
  }

  // ----- the owner's chat -----

  private notifyChat(): string | undefined {
    const to = this.deps.settings().notifyTo.trim()
    return to === '' ? undefined : chatJid(to)
  }

  /**
   * Send the owner a message; never throws.
   * @param text - the message.
   * @returns what happened.
   */
  async notifyOwner(text: string): Promise<string> {
    const chat = this.notifyChat()
    if (chat === undefined) return 'not sent (no owner chat set)'
    const outcome = await this.deps.whatsapp.send(chat, text)
    if (!outcome.ok) {
      this.deps.warn(`message to the owner failed: ${outcome.error}`)
      return `failed: ${outcome.error}`
    }
    await this.deps.store.update((s) => {
      s.sent.push({ contactId: '', chat, text, at: iso(this.deps.now()), tier: 'owner', ...outcome.waId === undefined ? {} : { waId: outcome.waId } })
    })
    return 'sent'
  }

  private async readOwner(): Promise<void> {
    const chat = this.notifyChat()
    if (chat === undefined) return
    const state = await this.deps.store.read()
    if (state.ownerCursor === undefined) {
      const latest = await this.deps.whatsapp.read(chat, { limit: 1 })
      await this.deps.store.update((s) => { s.ownerCursor = latest[0]?.id ?? 0 })
      return
    }
    const rows = await this.deps.whatsapp.read(chat, { after: state.ownerCursor, limit: 100 })
    if (rows.length === 0) return
    const own = this.ownSends(state)
    await this.deps.store.update((s) => { s.ownerCursor = Math.max(s.ownerCursor ?? 0, ...rows.map(r => r.id)) })
    for (const row of rows) {
      if (row.fromMe && !ownerTyped(row, own)) continue
      const command = parseOwnerCommand(row.body)
      if (command !== undefined) await this.command(command)
    }
  }

  /**
   * Carry out one owner command, answering him in his chat.
   * @param command - the parsed command.
   * @returns what was done, as told to the owner.
   */
  async command(command: OwnerCommand): Promise<string> {
    let answer: string
    switch (command.kind) {
      case 'approve':
      case 'reject':
      case 'edit':
        answer = await this.decide(command.code, command.kind, command.kind === 'edit' ? command.text : undefined)
        break
      case 'pause':
        await this.deps.store.update((s) => {
          s.paused = { reason: 'paused by the owner on WhatsApp', at: iso(this.deps.now()) }
          log(s, { contactId: '', kind: 'owner', text: 'the owner paused the delegate' })
        })
        answer = 'WhatsApp delegate paused. Send "resume delegate" to switch it back on.'
        break
      case 'resume':
        await this.deps.store.update((s) => { s.paused = null; log(s, { contactId: '', kind: 'owner', text: 'the owner resumed the delegate' }) })
        answer = 'WhatsApp delegate is back on.'
        break
      case 'instruct': {
        const contact = contactNamed(this.deps.contacts(), command.name)
        if (contact === undefined) {
          answer = `No contact called "${command.name}" is on the delegate's list.`
          break
        }
        answer = await this.instruct(contact.id, command.text)
        break
      }
      default:
        answer = 'Not understood.'
    }
    await this.notifyOwner(answer)
    return answer
  }

  /**
   * Hand the owner's instruction about a contact to that contact's Session at once.
   * @param contactId - the contact.
   * @param instruction - what the owner said.
   * @returns the answer for the owner.
   */
  async instruct(contactId: string, instruction: string): Promise<string> {
    const contact = this.contact(contactId)
    const batchId = `${this.deps.now().toString(36)}-${randomBytes(3).toString('hex')}`
    await this.deps.store.update((s) => {
      s.batches.push({ id: batchId, contactId, startedAt: iso(this.deps.now()), status: 'running', messages: [], actions: [] })
      log(s, { contactId, kind: 'owner', text: `instruction for ${contact.name}: ${instruction}` })
    })
    await this.deliver(contact, batchId, await this.prompt(contact, [], instruction))
    return `Passed to ${contact.name}'s session.`
  }

  /**
   * Approve, edit-and-send, or reject a queued reply.
   * @param code - the approval's number.
   * @param decision - what the owner decided.
   * @param replacement - the owner's own text, for `edit`.
   * @returns what happened, in a sentence for the owner.
   */
  async decide(code: number, decision: 'approve' | 'reject' | 'edit', replacement?: string): Promise<string> {
    const state = await this.deps.store.read()
    const approval = state.approvals.find(a => a.code === code)
    if (approval === undefined) return `No draft #${String(code)} exists.`
    if (approval.status !== 'pending') return `Draft #${String(code)} was already ${approval.status}.`
    const name = this.deps.contacts().find(c => c.id === approval.contactId)?.name ?? approval.contactId
    const at = iso(this.deps.now())
    if (decision === 'reject') {
      await this.deps.store.update((s) => {
        const a = s.approvals.find(x => x.code === code)
        if (a !== undefined) Object.assign(a, { status: 'rejected', decidedAt: at })
        contactState(s, approval.contactId).notes.push(`He rejected draft #${String(code)} ${quoteText(approval.text)}; it was not sent.`)
        log(s, { contactId: approval.contactId, kind: 'rejected', text: `#${String(code)} to ${name} rejected` })
      })
      return `Dropped #${String(code)}; nothing was sent to ${name}.`
    }
    const text = decision === 'edit' && replacement !== undefined ? replacement : approval.text
    // Claimed before sending, so a second "ok" cannot send it twice.
    const claimed = await this.deps.store.update((s) => {
      const a = s.approvals.find(x => x.code === code)
      if (a?.status !== 'pending') return false
      Object.assign(a, { status: 'sent', decidedAt: at, text })
      return true
    })
    if (!claimed) return `Draft #${String(code)} was already decided.`
    const sent = await this.sendParts(approval.contactId, approval.chat, splitReply(text, this.deps.settings().maxReplyChars), 'approved', approval.quote, approval.batchId)
    await this.deps.store.update((s) => {
      const a = s.approvals.find(x => x.code === code)
      if (a !== undefined && sent !== undefined) Object.assign(a, { status: 'failed', outcome: sent })
      const edited = decision === 'edit' ? ` after changing it to ${quoteText(text)}` : ''
      contactState(s, approval.contactId).notes.push(sent === undefined
        ? `He approved draft #${String(code)}${edited}; it was sent.`
        : `He approved draft #${String(code)} but it could not be sent: ${sent}.`)
      log(s, { contactId: approval.contactId, kind: 'approved', text: `#${String(code)} to ${name} ${sent === undefined ? 'sent' : `failed: ${sent}`}` })
    })
    return sent === undefined ? `Sent #${String(code)} to ${name}.` : `#${String(code)} could not be sent to ${name}: ${sent}`
  }

  /** Send messages to a contact's chat in order; the error of the first that fails, or undefined. */
  private async sendParts(contactId: string, chat: string, parts: readonly string[], tier: 'routine' | 'approved', quote?: string, batchId?: string): Promise<string | undefined> {
    for (const [index, part] of parts.entries()) {
      const outcome = await this.deps.whatsapp.send(chat, part, index === 0 ? quote : undefined)
      if (!outcome.ok) return outcome.error
      await this.deps.store.update((s) => {
        s.sent.push({
          contactId, chat, text: part, at: iso(this.deps.now()), tier,
          ...outcome.waId === undefined ? {} : { waId: outcome.waId }, ...batchId === undefined ? {} : { batchId },
        })
      })
    }
    return undefined
  }

  // ----- the Session's decisions -----

  private record(state: DelegateState, contactId: string, action: Omit<BatchAction, 'at'>, answered: boolean): BatchRecord | undefined {
    const batch = state.batches.filter(b => b.contactId === contactId && b.status === 'running').at(-1)
    batch?.actions.push({ ...action, at: iso(this.deps.now()) })
    if (answered && batch !== undefined) {
      const cs = contactState(state, contactId)
      for (const row of batch.messages) if (!cs.answered.includes(row.id)) cs.answered.push(row.id)
    }
    return batch
  }

  private async refuse(contactId: string, reason: string): Promise<never> {
    await this.deps.store.update((s) => {
      this.record(s, contactId, { kind: 'refused', text: reason }, false)
      log(s, { contactId, kind: 'refused', text: reason })
    })
    throw new Error(reason)
  }

  /**
   * Send a reply to the contact now, or queue it for the owner.
   * @param contactId - the contact.
   * @param input - the text, its tier, why, and optionally the message id (`m123` → 123) it answers.
   * @returns what happened, for the Session.
   */
  async reply(contactId: string, input: { text: string; tier: 'routine' | 'needs_approval'; why: string; quote?: number }): Promise<string> {
    const contact = this.contact(contactId)
    const settings = this.deps.settings()
    const state = await this.deps.store.read()
    if (!this.active(contact, state)) return this.refuse(contactId, 'The owner has paused the delegate for this contact; send nothing.')
    const parts = splitReply(input.text, settings.maxReplyChars)
    if (parts.length === 0) return this.refuse(contactId, 'The reply is empty.')
    const leaks = findSecrets(input.text, this.deps.secrets())
    if (leaks.length > 0) {
      return this.refuse(contactId, `Not sent: the text contains ${leaks.join(', ')}. Never send secrets, keys, passwords or setting values; rewrite it without them.`)
    }
    const flat = (value: string): string => value.replace(/\s+/gu, ' ').trim().toLowerCase()
    const now = this.deps.now()
    const duplicate = state.sent.some(s => s.contactId === contactId && now - Date.parse(s.at) < DUPLICATE_WINDOW_MS && flat(s.text) === flat(parts[0] ?? ''))
      || state.approvals.some(a => a.contactId === contactId && a.status === 'pending' && flat(a.text) === flat(input.text))
    if (duplicate) return this.refuse(contactId, 'This exact text was already sent to them (or is waiting for the owner); do not send it again.')
    const cs = contactState(state, contactId)
    const chat = cs.lastChat !== undefined && this.chats(contact).includes(cs.lastChat) ? cs.lastChat : this.chats(contact)[0]
    if (chat === undefined) return this.refuse(contactId, 'The contact has no WhatsApp number.')
    const quote = input.quote === undefined
      ? undefined
      : state.batches.filter(b => b.contactId === contactId).flatMap(b => b.messages).find(m => m.id === input.quote)?.waId || undefined

    if (input.tier === 'needs_approval') {
      const approval = await this.deps.store.update((s): Approval => {
        const a: Approval = {
          code: s.nextCode, contactId, chat, text: input.text.trim(), why: input.why, createdAt: iso(now), status: 'pending',
          ...quote === undefined ? {} : { quote },
        }
        s.nextCode++
        const batch = this.record(s, contactId, { kind: 'queued', text: input.text, code: a.code }, true)
        if (batch !== undefined) a.batchId = batch.id
        s.approvals.push(a)
        log(s, { contactId, kind: 'queued', text: `#${String(a.code)} for ${contact.name}: ${input.text} (why: ${input.why})` })
        return a
      })
      const told = await this.notifyOwner([
        `WhatsApp delegate · ${contact.name} — draft #${String(approval.code)} needs your OK:`,
        '',
        input.text.trim(),
        '',
        `Why it waits: ${input.why}`,
        `Reply "ok ${String(approval.code)}" to send it, "edit ${String(approval.code)}: your text" to send your version, or "no ${String(approval.code)}" to drop it.`,
      ].join('\n'))
      return `Queued as draft #${String(approval.code)} for the owner's approval (${told === 'sent' ? 'he has been asked on WhatsApp' : `he could not be told: ${told}; it shows on his Plugins page`}). Do not send it another way.`
    }

    const sentAt = state.sent.filter(s => s.contactId === contactId && s.tier !== 'owner').map(s => Date.parse(s.at))
    if (!withinRateLimit(sentAt, now, settings.maxReplies, settings.rateWindowMs, parts.length)) {
      return this.refuse(contactId, `Not sent: ${String(settings.maxReplies)} messages in ${String(Math.round(settings.rateWindowMs / 60_000))} minutes is the limit for one contact. Wait, or queue it with tier needs_approval.`)
    }
    const batch = state.batches.filter(b => b.contactId === contactId && b.status === 'running').at(-1)
    const failed = await this.sendParts(contactId, chat, parts, 'routine', quote, batch?.id)
    await this.deps.store.update((s) => {
      this.record(s, contactId, { kind: failed === undefined ? 'reply' : 'refused', text: failed === undefined ? input.text : `send failed: ${failed}` }, failed === undefined)
      log(s, { contactId, kind: failed === undefined ? 'reply' : 'error', text: `to ${contact.name}: ${input.text}${failed === undefined ? '' : ` — failed: ${failed}`}` })
    })
    if (failed !== undefined) throw new Error(`WhatsApp did not send it: ${failed}`)
    return parts.length === 1 ? 'Sent.' : `Sent as ${String(parts.length)} messages.`
  }

  /**
   * Record that the batch needs no reply.
   * @param contactId - the contact.
   * @param why - the reason, for the log.
   * @param mention - the owner should hear about these messages in the digest.
   * @returns the acknowledgement.
   */
  async noReply(contactId: string, why: string, mention: boolean): Promise<string> {
    const contact = this.contact(contactId)
    await this.deps.store.update((s) => {
      this.record(s, contactId, { kind: 'no-reply', text: why, mention }, true)
      log(s, { contactId, kind: 'no-reply', text: `${contact.name}: ${why}` })
    })
    return mention ? 'Noted; the owner will see it in his digest.' : 'Noted.'
  }

  /**
   * Tell the owner something: at once when urgent or outside a batch, otherwise in the batch's digest.
   * @param contactId - the contact the Session is about.
   * @param text - the message.
   * @param urgent - send it now.
   * @returns what happened.
   */
  async tellOwner(contactId: string, text: string, urgent: boolean): Promise<string> {
    const contact = this.contact(contactId)
    const leaks = findSecrets(text, this.deps.secrets())
    if (leaks.length > 0) return this.refuse(contactId, `Not sent: the text contains ${leaks.join(', ')}. Describe it without the value.`)
    const batch = await this.deps.store.update((s) => {
      log(s, { contactId, kind: 'owner', text: `about ${contact.name}: ${text}` })
      return urgent ? undefined : this.record(s, contactId, { kind: 'tell-owner', text }, false)
    })
    if (batch !== undefined) return 'Noted; it goes to the owner in this batch\'s digest.'
    const outcome = await this.notifyOwner(`WhatsApp delegate · ${contact.name}: ${text}`)
    return outcome === 'sent' ? 'The owner has been told.' : `The owner could not be told (${outcome}); it is in the activity log.`
  }

  /**
   * The contact's recent messages, both directions, oldest first.
   * @param contactId - the contact.
   * @param limit - how many.
   * @returns one line per message.
   */
  async history(contactId: string, limit: number): Promise<string> {
    const contact = this.contact(contactId)
    const rows: WaRow[] = []
    for (const chat of this.chats(contact)) rows.push(...await this.deps.whatsapp.read(chat, { limit }))
    const zone = this.deps.settings().timeZone
    const lines = rows.sort((a, b) => a.ts - b.ts || a.id - b.id).slice(-limit).map(r => messageLine(r, contact.name, zone))
    return lines.length === 0 ? 'No messages are stored for this contact.' : lines.join('\n')
  }
}

/**
 * The owner's digest for the batches a Session just finished.
 * @param name - the contact's name.
 * @param batches - the finished batches.
 * @returns the message, or undefined when nothing in them is worth his attention.
 */
export function digestText(name: string, batches: readonly BatchRecord[]): string | undefined {
  const actions = batches.flatMap(b => b.actions)
  const messages = batches.flatMap(b => b.messages)
  const failed = batches.filter(b => b.status === 'failed')
  const decided = actions.some(a => a.kind === 'reply' || a.kind === 'queued' || a.kind === 'no-reply')
  const lines: string[] = []
  const first = messages[0]
  if (first !== undefined) {
    const more = messages.length > 1 ? ` (+${String(messages.length - 1)} more)` : ''
    lines.push(`They wrote: ${quoteText(first.body === '' ? `[${first.kind}]` : first.body, 120)}${more}`)
  }
  for (const a of actions) {
    if (a.kind === 'reply') lines.push(`Replied: ${quoteText(a.text)}`)
    else if (a.kind === 'queued') lines.push(`Waiting for your OK: #${String(a.code ?? 0)} ${quoteText(a.text, 80)}`)
    else if (a.kind === 'tell-owner') lines.push(`Note: ${a.text}`)
    else if (a.kind === 'no-reply' && a.mention === true) lines.push(`Not answered: ${a.text}`)
  }
  for (const b of failed) lines.push(`The session stopped with an error: ${(b.error ?? '').slice(0, 200)}. Please check the chat.`)
  if (!decided && failed.length === 0 && messages.length > 0) lines.push('The session finished without deciding on these messages. Please check the chat.')
  const worth = actions.some(a => a.kind === 'reply' || a.kind === 'queued' || a.kind === 'tell-owner' || (a.kind === 'no-reply' && a.mention === true))
    || failed.length > 0 || (!decided && messages.length > 0)
  return worth ? [`WhatsApp delegate · ${name}`, ...lines].join('\n') : undefined
}
