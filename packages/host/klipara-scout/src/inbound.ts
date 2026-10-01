/**
 * Creators who asked Klipara for a free clip themselves, on its public
 * /free-clip page. Klipara posts each request here, signed, once the
 * request is confirmed and again once the clip is sent. Such a creator is
 * never cold-pitched: the lead moves to `replied`, which no shift tool
 * samples or pitches, and the owner hears about it to follow up in person.
 *
 * Signature: `X-Klipara-Signature: v1=<hex HMAC-SHA256(secret, "<ts>.<raw body>")>`
 * with `X-Klipara-Timestamp: <unix seconds>`; Klipara retries with the same
 * `X-Klipara-Event-Id`, which is recorded so a retry changes nothing.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import { advance, type Lead, type ScoutState } from './store.ts'

/** How far a signed timestamp may be from now. */
export const SIGNATURE_WINDOW_SECONDS = 300
/** Event ids remembered for de-duplication. */
const EVENTS_KEPT = 2000
const CHANNEL_ID = /^UC[\w-]{22}$/u
/** The shape of Klipara's event ids (`fce_…`). */
export const EVENT_ID = /^[\w-]{1,100}$/u

/** One request from the free-clip page. */
export interface FreeClipEvent {
  channelId: string
  channelUrl: string
  /** Absent when the requester did not agree to be contacted. */
  email?: string
  sourceUrl: string
  /** Set once the clip is sent. */
  sampleUrl?: string
  status: 'confirmed' | 'sent'
  occurredAt: string
}

/**
 * Check a request's signature and age.
 * @param secret - the shared secret.
 * @param timestamp - the X-Klipara-Timestamp header.
 * @param signature - the X-Klipara-Signature header.
 * @param rawBody - the body exactly as received.
 * @param nowSeconds - the current unix time.
 * @returns 'ok', or why the request is refused.
 */
export function verifySignature(secret: string, timestamp: string, signature: string, rawBody: string, nowSeconds: number): 'ok' | 'bad signature' | 'stale' {
  const expected = `v1=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  if (secret === '' || a.length !== b.length || !timingSafeEqual(a, b)) return 'bad signature'
  const ts = Number(timestamp)
  if (!/^\d+$/u.test(timestamp) || Math.abs(nowSeconds - ts) > SIGNATURE_WINDOW_SECONDS) return 'stale'
  return 'ok'
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * Read a verified body.
 * @param raw - the JSON body.
 * @returns the event, or why it is unusable.
 */
export function parseEvent(raw: string): FreeClipEvent | string {
  let body: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'the body is not a JSON object'
    body = parsed as Record<string, unknown>
  } catch {
    return 'the body is not JSON'
  }
  const channelId = text(body['channel_id'])
  if (channelId === undefined || !CHANNEL_ID.test(channelId)) return 'channel_id is not a YouTube channel id'
  const status = body['status']
  if (status !== 'confirmed' && status !== 'sent') return 'status is neither confirmed nor sent'
  const email = text(body['email'])?.toLowerCase()
  const sampleUrl = text(body['sample_url'])
  if (status === 'sent' && sampleUrl === undefined) return 'a sent request has no sample_url'
  const occurredAt = text(body['occurred_at'])
  return {
    channelId,
    channelUrl: text(body['channel_url']) ?? `https://www.youtube.com/channel/${channelId}`,
    ...email === undefined || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(email) ? {} : { email },
    sourceUrl: text(body['source_url']) ?? '',
    ...sampleUrl === undefined ? {} : { sampleUrl },
    status,
    occurredAt: occurredAt !== undefined && !Number.isNaN(Date.parse(occurredAt)) ? occurredAt : new Date().toISOString(),
  }
}

/** What recording an event did. */
export interface Recorded {
  duplicate: boolean
  /** True when the channel was not a lead before. */
  created: boolean
  /** The lead's stage before this event, when it existed. */
  before?: Lead['stage']
  lead: Lead
}

/**
 * Apply one event to the scout state.
 * @param state - mutated in place.
 * @param eventId - the X-Klipara-Event-Id header.
 * @param event - the request.
 * @param at - ISO time it arrived.
 * @returns what changed.
 */
export function recordEvent(state: ScoutState, eventId: string, event: FreeClipEvent, at: string): Recorded {
  const seen = state.inboundEvents ??= []
  const existing = state.leads.find(l => l.channelId === event.channelId)
  if (seen.includes(eventId) && existing !== undefined) return { duplicate: true, created: false, before: existing.stage, lead: existing }
  seen.push(eventId)
  if (seen.length > EVENTS_KEPT) seen.splice(0, seen.length - EVENTS_KEPT)

  const lead: Lead = existing ?? {
    channelId: event.channelId,
    channelName: event.channelId,
    channelUrl: event.channelUrl,
    stage: 'found',
    source: 'free-clip',
    replies: [],
    history: [],
    createdAt: at,
    updatedAt: at,
  }
  if (existing === undefined) state.leads.push(lead)
  const before = existing?.stage
  if (lead.email === undefined && event.email !== undefined) lead.email = event.email
  const sampleUrl = event.sampleUrl ?? lead.inbound?.sampleUrl
  lead.inbound = {
    status: lead.inbound?.status === 'sent' ? 'sent' : event.status,
    sourceUrl: event.sourceUrl || lead.inbound?.sourceUrl || '',
    ...sampleUrl === undefined ? {} : { sampleUrl },
    at: event.occurredAt,
  }
  const what = event.status === 'sent' ? `Free clip sent: ${event.sampleUrl ?? ''}` : `Asked for a free clip of ${event.sourceUrl}`
  lead.replies.push({ at: event.occurredAt, where: 'Klipara free-clip page', text: what })
  // Won and lost are the owner's verdicts; a request changes neither.
  if (lead.stage === 'won' || lead.stage === 'lost') {
    lead.updatedAt = at
    lead.history.push({ at, stage: lead.stage, note: what })
  } else if (lead.stage === 'replied') {
    lead.updatedAt = at
    lead.history.push({ at, stage: 'replied', note: what })
  } else {
    advance(lead, 'replied', at, `${what} (inbound; never pitch)`)
  }
  return { duplicate: false, created: existing === undefined, ...before === undefined ? {} : { before }, lead }
}

/**
 * The owner's WhatsApp note for an event, or nothing when it is not worth one.
 * Only a sent clip is: the confirmation comes minutes earlier and adds nothing.
 * @param recorded - the result of recording it.
 * @param event - the request.
 * @returns the note.
 */
export function ownerNote(recorded: Recorded, event: FreeClipEvent): string | undefined {
  if (recorded.duplicate || event.status !== 'sent') return undefined
  const { lead } = recorded
  const pitched = recorded.before === 'pitched' || lead.pitch !== undefined
  return [
    `Klipara free clip sent to ${lead.channelName === lead.channelId ? lead.channelUrl : lead.channelName}`,
    pitched ? ' (the scout pitched them earlier, so this answers the pitch)' : '',
    `. Clip: ${event.sampleUrl ?? ''}.`,
    lead.email === undefined ? ' They did not leave an address to follow up on.' : ` Follow up yourself: ${lead.email}.`,
    ' The scout will not pitch them.',
  ].join('')
}
