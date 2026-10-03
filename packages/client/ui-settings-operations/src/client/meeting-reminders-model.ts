/**
 * The meeting reminders form's editing rules, free of React: the saved rules
 * array read into editable meetings, the id a new meeting gets from its name,
 * and the plain-language problems that keep a meeting from saving. The stored
 * value stays the plugin's rules array; the form stages it as JSON text.
 */

/** Weekday keys in the order the dropdown lists them. */
export const MEETING_WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const
/** Which weekday of the month, in the order the dropdown lists them. */
export const MEETING_NTHS = [1, 2, 3, 4, 5, 'last'] as const
/** Template keys the message chips insert as `{key}`. */
export const MEETING_TEMPLATE_KEYS = ['hijriDate', 'date', 'weekday', 'when', 'time', 'venue', 'label'] as const
/** Largest "days before" the dropdown offers. */
export const MAX_DAYS_BEFORE = 7

/** One weekday key. */
export type MeetingWeekday = typeof MEETING_WEEKDAYS[number]
/** One nth choice. */
export type MeetingNth = typeof MEETING_NTHS[number]

/** One reminder row. */
export interface MeetingReminderDraft {
  daysBefore: number
  at: string
}

/** One meeting as the form edits it; the fields the plugin stores. */
export interface MeetingDraft {
  id: string
  label: string
  chat: string
  meeting: { nth: MeetingNth; weekday: MeetingWeekday }
  time: string
  venue: string
  reminders: MeetingReminderDraft[]
  template?: string
  enabled: boolean
  override?: { month?: string; skip?: boolean; time?: string; venue?: string }
}

/** A problem the form shows under a meeting, as a locale key and its values. */
export interface MeetingIssue {
  key: 'mrIssue.label' | 'mrIssue.chat' | 'mrIssue.reminders' | 'mrIssue.at' | 'mrIssue.month' | 'mrIssue.duplicate'
  params?: Record<string, string | number>
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/**
 * Read one stored rule into the form's meeting, filling what is missing.
 * @param value - a rule from the saved array.
 * @returns the meeting.
 */
export function meetingFrom(value: unknown): MeetingDraft {
  const rule = record(value)
  const meeting = record(rule['meeting'])
  const nth = meeting['nth']
  const weekday = text(meeting['weekday'])
  const reminders = Array.isArray(rule['reminders']) ? rule['reminders'].map(record) : []
  const override = rule['override'] === undefined ? undefined : record(rule['override'])
  return {
    id: text(rule['id']),
    label: text(rule['label']),
    chat: text(rule['chat']),
    meeting: {
      nth: (MEETING_NTHS as readonly unknown[]).includes(nth) ? nth as MeetingNth : 1,
      weekday: (MEETING_WEEKDAYS as readonly string[]).includes(weekday) ? weekday as MeetingWeekday : 'sat',
    },
    time: text(rule['time']),
    venue: text(rule['venue']),
    reminders: reminders.map(r => ({ daysBefore: typeof r['daysBefore'] === 'number' ? r['daysBefore'] : 0, at: text(r['at']) })),
    ...typeof rule['template'] === 'string' && rule['template'] !== '' ? { template: rule['template'] } : {},
    enabled: rule['enabled'] !== false,
    ...override === undefined ? {} : {
      override: {
        ...typeof override['month'] === 'string' ? { month: override['month'] } : {},
        ...override['skip'] === true ? { skip: true } : {},
        ...typeof override['time'] === 'string' ? { time: override['time'] } : {},
        ...typeof override['venue'] === 'string' ? { venue: override['venue'] } : {},
      },
    },
  }
}

/**
 * Read the rules field's draft text into meetings.
 * @param draft - the staged JSON text.
 * @returns the meetings; text that is not a JSON array reads as none.
 */
export function readMeetings(draft: string): MeetingDraft[] {
  try {
    const value: unknown = JSON.parse(draft)
    return Array.isArray(value) ? value.map(meetingFrom) : []
  } catch {
    // The field is only ever staged by this form, so unreadable text means nothing has been saved yet.
    return []
  }
}

/**
 * The stored value of one meeting: an override with nothing in it is left out.
 * @param meeting - the form's meeting.
 * @returns the rule to store.
 */
export function ruleOf(meeting: MeetingDraft): MeetingDraft {
  const { override, template, ...rest } = meeting
  const keep = override !== undefined && (override.skip === true || (override.month ?? '') !== ''
    || (override.time ?? '').trim() !== '' || (override.venue ?? '').trim() !== '')
  return {
    ...rest,
    ...template === undefined || template.trim() === '' ? {} : { template },
    ...keep ? { override } : {},
  }
}

/**
 * The text the rules field stages for these meetings.
 * @param meetings - the form's meetings.
 * @returns pretty-printed JSON.
 */
export function writeMeetings(meetings: readonly MeetingDraft[]): string {
  return JSON.stringify(meetings.map(ruleOf), null, 2)
}

/**
 * A lowercase id made of the name's letters and digits.
 * @param label - the meeting's name.
 * @returns such as `amya-exco-meeting`; `meeting` when the name has no letters or digits.
 */
export function slug(label: string): string {
  return label.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 40) || 'meeting'
}

/**
 * Give a meeting its name, and to a meeting not yet saved an id made from it. A saved meeting keeps its id: sent
 * reminders are recorded under it, so a new id would send them again.
 * @param meeting - the meeting.
 * @param label - the new name.
 * @param savedIds - ids of the meetings the plugin has saved.
 * @param otherIds - ids of the form's other meetings, which the new id must not repeat.
 * @returns the renamed meeting.
 */
export function renamed(meeting: MeetingDraft, label: string, savedIds: ReadonlySet<string>, otherIds: ReadonlySet<string>): MeetingDraft {
  if (savedIds.has(meeting.id) && meeting.id !== '') return { ...meeting, label }
  const base = slug(label)
  let id = base
  for (let n = 2; otherIds.has(id); n++) id = `${base}-${String(n)}`
  return { ...meeting, label, id }
}

/**
 * A new meeting with the usual reminders, for the "Add meeting" button.
 * @param otherIds - ids already in the form.
 * @returns the meeting.
 */
export function newMeeting(otherIds: ReadonlySet<string>): MeetingDraft {
  return renamed({
    id: '', label: '', chat: '', meeting: { nth: 1, weekday: 'sat' }, time: '', venue: '',
    reminders: [{ daysBefore: 1, at: '18:00' }, { daysBefore: 0, at: '08:00' }], enabled: true,
  }, '', new Set(), otherIds)
}

/**
 * What keeps a meeting from saving, in the words the form shows.
 * @param meeting - the meeting.
 * @param others - the form's other meetings, for duplicate ids.
 * @returns the problems; empty when it can be saved.
 */
export function meetingIssues(meeting: MeetingDraft, others: readonly MeetingDraft[] = []): MeetingIssue[] {
  const issues: MeetingIssue[] = []
  if (meeting.label.trim() === '') issues.push({ key: 'mrIssue.label' })
  if (!meeting.chat.trim().endsWith('@g.us')) issues.push({ key: 'mrIssue.chat' })
  if (meeting.reminders.length === 0) issues.push({ key: 'mrIssue.reminders' })
  meeting.reminders.forEach((reminder, index) => {
    if (!/^([01]?\d|2[0-3]):[0-5]\d$/u.test(reminder.at.trim())) issues.push({ key: 'mrIssue.at', params: { n: index + 1 } })
  })
  const override = meeting.override
  const overrides = override !== undefined && (override.skip === true || (override.time ?? '').trim() !== '' || (override.venue ?? '').trim() !== '')
  if (overrides && !/^\d{4}-\d{2}$/u.test(override.month ?? '')) issues.push({ key: 'mrIssue.month' })
  if (meeting.id !== '' && others.some(other => other.id === meeting.id)) issues.push({ key: 'mrIssue.duplicate' })
  return issues
}

/**
 * Insert a placeholder into the message at the cursor.
 * @param message - the message text.
 * @param placeholder - a placeholder name, without braces.
 * @param at - the cursor; the end when undefined.
 * @returns the new text and where the cursor goes after it.
 */
export function insertPlaceholder(message: string, placeholder: string, at?: number): { text: string; cursor: number } {
  const position = at === undefined ? message.length : Math.max(0, Math.min(at, message.length))
  const token = `{${placeholder}}`
  return { text: `${message.slice(0, position)}${token}${message.slice(position)}`, cursor: position + token.length }
}
