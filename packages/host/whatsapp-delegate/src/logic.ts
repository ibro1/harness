/**
 * The delegate's decisions that hold whatever the model does, free of I/O:
 * which configured contacts are valid, when a contact's burst of messages is
 * ready to hand to its Session, when the owner has taken the conversation
 * over, what the owner's approval replies mean, how many replies a contact may
 * get, and whether outgoing text carries a secret.
 */

/** One person the delegate answers for the owner, as the Plugins page stores it. */
export interface Contact {
  /** Stable key: state, cursors and the Session are filed under it. */
  id: string
  name: string
  /** Phone numbers (any formatting) or WhatsApp JIDs the person writes from. */
  numbers: string[]
  /** The project checkout the Session works in; empty uses the delegate's own folder for this contact. */
  workspacePath: string
  repoUrl: string
  deployBranch: string
  liveUrl: string
  /** Who they are: relationship, tone, language. */
  notes: string
  enabled: boolean
  /** Ignore this contact's messages completely; nothing is read or queued. */
  paused: boolean
}

/** One stored WhatsApp message, as the WhatsApp service lists it. */
export interface WaRow {
  /** The service's row id; cursors count in it. */
  id: number
  /** WhatsApp's own message id; empty on rows stored before the service recorded it. */
  waId: string
  chat: string
  sender: string
  senderName: string
  fromMe: boolean
  /** Sent through the WhatsApp service (by an employee), not typed on a phone. */
  viaApi: boolean
  /** Unix seconds. */
  ts: number
  /** `text`, `audio`, `image`, `video`, `document` or `sticker`. */
  kind: string
  body: string
  /** WhatsApp id of the message this one replies to, if any. */
  replyTo: string
  /** Whether the media can be downloaded. */
  hasMedia: boolean
}

/** A row waiting in a contact's queue, with when the delegate first saw it. */
export interface QueuedRow extends WaRow {
  /** Epoch milliseconds. */
  seenAt: number
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * Read one configured contact, filling what is missing.
 * @param value - an entry of the plugin's `contacts` array.
 * @returns the contact, or undefined when it has no id or no number.
 */
export function contactFrom(value: unknown): Contact | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const entry = value as Record<string, unknown>
  const numbers = (Array.isArray(entry['numbers']) ? entry['numbers'] : []).map(text).map(n => n.trim()).filter(n => chatJid(n) !== undefined)
  const id = text(entry['id']).trim()
  if (id === '' || numbers.length === 0) return undefined
  return {
    id,
    name: text(entry['name']).trim() || id,
    numbers,
    workspacePath: text(entry['workspacePath']).trim(),
    repoUrl: text(entry['repoUrl']).trim(),
    deployBranch: text(entry['deployBranch']).trim(),
    liveUrl: text(entry['liveUrl']).trim(),
    notes: text(entry['notes']).trim(),
    enabled: entry['enabled'] !== false,
    paused: entry['paused'] === true,
  }
}

/**
 * The WhatsApp chat id of a number as written by a person, or a JID as given.
 * @param number - `+234 803 123 4567`, `2348031234567` or `2348031234567@s.whatsapp.net`.
 * @returns the JID, or undefined when it is neither.
 */
export function chatJid(number: string): string | undefined {
  const value = number.trim()
  if (value.includes('@')) return /^[\w.:-]+@[\w.]+$/u.test(value) ? value.toLowerCase() : undefined
  const digits = value.replace(/[\s()+.-]/gu, '')
  return /^\d{7,15}$/u.test(digits) ? `${digits}@s.whatsapp.net` : undefined
}

/**
 * Whether a row is the owner typing on his own phone rather than the contact or an employee.
 * @param row - the row.
 * @param ownSends - WhatsApp ids of the messages the delegate sent.
 * @returns true for the owner's own messages.
 */
export function ownerTyped(row: WaRow, ownSends: ReadonlySet<string>): boolean {
  return row.fromMe && !row.viaApi && !(row.waId !== '' && ownSends.has(row.waId))
}

/** How long the delegate waits, all in milliseconds. */
export interface BatchTiming {
  /** Quiet after the contact's last message before a batch is handled. */
  quietMs: number
  /** Longest wait after the first message of a batch, however the contact keeps typing. */
  maxWaitMs: number
  /** After the owner typed in the chat, how long the delegate leaves the conversation to him. */
  ownerActiveMs: number
}

/** What to do with a contact's queue now. */
export type BatchPlan =
  | { action: 'idle' }
  | { action: 'wait'; dueAt: number }
  | { action: 'handoff'; reason: string }
  | { action: 'process'; messages: QueuedRow[] }

/**
 * Decide whether a contact's queued messages are ready for the Session.
 * @param queue - rows seen since the last batch, both directions.
 * @param ownSends - WhatsApp ids of the delegate's own messages.
 * @param lastOwnerTs - Unix seconds of the owner's latest message in this contact's chats, including earlier batches.
 * @param now - epoch milliseconds.
 * @param timing - the waits.
 * @returns idle with nothing from the contact; handoff when the owner answered after the contact's latest message; wait
 *   while the contact may still be typing or the owner is in the conversation; otherwise process the contact's messages.
 */
export function planBatch(
  queue: readonly QueuedRow[], ownSends: ReadonlySet<string>, lastOwnerTs: number, now: number, timing: BatchTiming,
): BatchPlan {
  const incoming = queue.filter(row => !row.fromMe)
  if (incoming.length === 0) return { action: 'idle' }
  const ownerTs = Math.max(lastOwnerTs, ...queue.filter(row => ownerTyped(row, ownSends)).map(row => row.ts))
  const latestIn = Math.max(...incoming.map(row => row.ts))
  if (ownerTs >= latestIn) return { action: 'handoff', reason: 'the owner answered in the chat himself' }
  const ownerUntil = ownerTs > 0 ? ownerTs * 1000 + timing.ownerActiveMs : 0
  const firstSeen = Math.min(...incoming.map(row => row.seenAt))
  const lastSeen = Math.max(...incoming.map(row => row.seenAt))
  const dueAt = Math.max(Math.min(lastSeen + timing.quietMs, firstSeen + timing.maxWaitMs), ownerUntil)
  return now >= dueAt ? { action: 'process', messages: incoming } : { action: 'wait', dueAt }
}

/** A reply the owner typed in his notify chat. */
export type OwnerCommand =
  | { kind: 'approve'; code: number }
  | { kind: 'reject'; code: number }
  | { kind: 'edit'; code: number; text: string }
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'instruct'; name: string; text: string }

/**
 * Read the owner's reply to an approval request or a control word.
 * @param message - the owner's whole message.
 * @returns the command: `ok 7` / `yes 7` / `send 7`, `no 7` / `drop 7`, `edit 7: new text`, `pause delegate`,
 *   `resume delegate`, or `@Name instruction` for that contact's Session; undefined for anything else.
 */
export function parseOwnerCommand(message: string): OwnerCommand | undefined {
  const value = message.trim()
  const edit = /^edit\s*#?(\d{1,6})(?![\d])([\s\S]*)$/iu.exec(value)
  if (edit !== null) {
    const replacement = (edit[2] ?? '').replace(/^[\s:\-–]+/u, '').trim()
    return replacement === '' ? undefined : { kind: 'edit', code: Number(edit[1]), text: replacement }
  }
  const approve = /^(?:ok|okay|yes|send|approve|approved|go)\s*#?(\d{1,6})\s*[.!👍]*$/iu.exec(value)
  if (approve !== null) return { kind: 'approve', code: Number(approve[1]) }
  const reject = /^(?:no|reject|drop|cancel|don'?t send)\s*#?(\d{1,6})\s*[.!]*$/iu.exec(value)
  if (reject !== null) return { kind: 'reject', code: Number(reject[1]) }
  if (/^pause\s+(?:the\s+)?delegate[.!]*$/iu.test(value)) return { kind: 'pause' }
  if (/^(?:resume|unpause)\s+(?:the\s+)?delegate[.!]*$/iu.test(value)) return { kind: 'resume' }
  const instruct = /^@([^\s:]+)[:,]?\s+([\s\S]+)$/u.exec(value)
  if (instruct !== null) return { kind: 'instruct', name: instruct[1] ?? '', text: (instruct[2] ?? '').trim() }
  return undefined
}

/**
 * Find the contact an `@Name` instruction means: an exact id, else the first word of a name, case-insensitive.
 * @param contacts - the configured contacts.
 * @param name - the word after `@`.
 * @returns the contact, or undefined when none or several match.
 */
export function contactNamed(contacts: readonly Contact[], name: string): Contact | undefined {
  const key = name.toLowerCase()
  const byId = contacts.find(c => c.id.toLowerCase() === key)
  if (byId !== undefined) return byId
  const matches = contacts.filter(c => c.name.toLowerCase() === key || c.name.toLowerCase().split(/\s+/u)[0] === key)
  return matches.length === 1 ? matches[0] : undefined
}

/**
 * Whether one more message to a contact stays within the limit.
 * @param sentAt - epoch milliseconds of the messages already sent to the contact.
 * @param now - epoch milliseconds.
 * @param max - most messages in the window.
 * @param windowMs - the window.
 * @param adding - how many messages would be added.
 * @returns true when they may go.
 */
export function withinRateLimit(sentAt: readonly number[], now: number, max: number, windowMs: number, adding = 1): boolean {
  return sentAt.filter(at => now - at < windowMs).length + adding <= max
}

/**
 * Split a long reply at paragraph, then sentence, boundaries into WhatsApp-sized messages.
 * @param reply - the text.
 * @param max - most characters in one message.
 * @returns the messages, in order; one when the text fits.
 */
export function splitReply(reply: string, max: number): string[] {
  const value = reply.trim()
  if (value.length <= max) return value === '' ? [] : [value]
  const parts: string[] = []
  let current = ''
  const pieces = value.split(/\n{2,}/u).flatMap(p => p.length <= max ? [p] : p.split(/(?<=[.!?])\s+/u))
  for (const piece of pieces) {
    const chunks = piece.length <= max ? [piece] : piece.match(new RegExp(`[\\s\\S]{1,${String(max)}}`, 'gu')) ?? []
    for (const chunk of chunks) {
      const joined = current === '' ? chunk : `${current}\n\n${chunk}`
      if (joined.length <= max) current = joined
      else {
        if (current !== '') parts.push(current.trim())
        current = chunk
      }
    }
  }
  if (current.trim() !== '') parts.push(current.trim())
  return parts
}

const SECRET_PATTERNS: readonly (readonly [string, RegExp])[] = [
  ['a private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/u],
  ['an AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u],
  ['a GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/u],
  ['an API key', /\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|gsk_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{35}|xox[abprs]-[A-Za-z0-9-]{10,})/u],
  ['a payment key', /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/u],
  ['a JSON Web Token', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/u],
  ['a password in a connection string', /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]{3,}@/iu],
  ['a secret in a link', /[?&](?:access_token|token|api_?key|key|secret|password|sig|signature)=[^&\s]{8,}/iu],
  ['a secret setting', /\b[A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*\s*[=:]\s*\S{6,}/u],
]

/** Long runs of mixed letters and digits, outside links, that read like generated keys. */
const KEY_LIKE = new RegExp([
  '(?<![\\w/.-])',
  '(?=[A-Za-z0-9+/_-]*[A-Z])(?=[A-Za-z0-9+/_-]*[a-z])(?=[A-Za-z0-9+/_-]*\\d)',
  '[A-Za-z0-9+/_-]{40,}={0,2}(?![\\w/.-])',
].join(''), 'u')

/**
 * Collect the values of environment variables whose names say they are secret, for {@link findSecrets}.
 * @param env - the environment.
 * @returns the values of eight characters or more.
 */
export function envSecrets(env: Readonly<Record<string, string | undefined>>): string[] {
  return Object.entries(env)
    .filter(([name, value]) => /(?:SECRET|TOKEN|PASSWORD|PASSWD|_KEY|APIKEY|CREDENTIAL|PRIVATE)/iu.test(name) && (value ?? '').length >= 8)
    .map(([, value]) => value ?? '')
}

/**
 * Say what kinds of secret a message would leak.
 * @param message - outgoing text.
 * @param known - secret values that must never be sent, such as the deployment's tokens.
 * @returns plain descriptions of what was found; empty when the text is clean.
 */
export function findSecrets(message: string, known: readonly string[] = []): string[] {
  const found = SECRET_PATTERNS.filter(([, pattern]) => pattern.test(message)).map(([what]) => what)
  if (KEY_LIKE.test(message.replace(/https?:\/\/\S+/gu, ''))) found.push('a long key-like string')
  if (known.some(value => message.includes(value))) found.push('a value from the server\'s secret settings')
  return [...new Set(found)]
}

/**
 * The local date and time as the Session reads it.
 * @param now - the instant.
 * @param timeZone - an IANA zone.
 * @returns for example `Saturday 3 October 2026, 14:05 (Africa/Lagos)`.
 */
export function localStamp(now: Date, timeZone: string): string {
  const formatted = new Intl.DateTimeFormat('en-GB', {
    timeZone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(now).replace(/ at /u, ', ')
  return `${formatted} (${timeZone})`
}

/**
 * One message as a line of the Session's prompt.
 * @param row - the row, with its transcript or saved picture when there is one.
 * @param contactName - the contact's name, for their messages.
 * @param timeZone - for the time.
 * @returns `[m123 14:05] Hellen: text`.
 */
export function messageLine(
  row: WaRow & { transcript?: string; file?: string; mediaError?: string }, contactName: string, timeZone: string,
): string {
  const time = new Intl.DateTimeFormat('en-GB', { timeZone, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(new Date(row.ts * 1000))
  const who = row.fromMe ? (row.viaApi ? 'You (sent by you, the delegate, or another employee)' : 'Owner (typed himself)') : contactName
  const media = [
    row.transcript === undefined ? '' : ` [voice note, transcribed: "${row.transcript}"]`,
    row.file === undefined ? '' : ` [${row.kind} saved at ${row.file}]`,
    row.mediaError === undefined ? '' : ` [${row.kind} could not be read: ${row.mediaError}]`,
  ].join('')
  const reply = row.replyTo === '' ? '' : ' (replying to an earlier message)'
  return `[m${String(row.id)} ${time}] ${who}${reply}: ${row.body}${media}`
}
