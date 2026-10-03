/**
 * The calendar arithmetic behind the reminders, free of clocks and I/O: which
 * local day a monthly meeting falls on, the Hijri and English dates printed in
 * the message, the template's placeholders, and which reminders are due at a
 * given local minute.
 *
 * Every date here is a local calendar date in the configured time zone,
 * written `YYYY-MM-DD`; arithmetic on dates is done at UTC noon so no zone
 * rule can move a day.
 */

/** Weekday keys, Sunday first, as `Date#getUTCDay` numbers them. */
export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const
/** One weekday key. */
export type Weekday = typeof WEEKDAYS[number]

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const
/** Hijri month names, Muharram first, in the spelling the messages use. */
export const HIJRI_MONTHS = [
  'Muharram', 'Safar', 'Rabi\' al-Awwal', 'Rabi\' al-Thani', 'Jumada al-Ula', 'Jumada al-Thaniyah',
  'Rajab', 'Sha\'ban', 'Ramadan', 'Shawwal', 'Dhul Qa\'dah', 'Dhul Hijjah',
] as const

/** How late a missed reminder may still go out by default, in minutes after its time. */
export const LATE_WINDOW_MINUTES = 6 * 60

/** One reminder of a meeting: how many days before it, and at what local time. */
export interface Reminder {
  daysBefore: number
  /** `HH:MM`, 24-hour, local. */
  at: string
}

/** A change to one month's meeting. */
export interface Override {
  /** `YYYY-MM`: the month whose meeting this changes; other months are untouched. Required when anything is overridden. */
  month?: string
  /** No meeting that month: no reminders, and the next occurrence is the following month's. */
  skip?: boolean
  time?: string
  venue?: string
}

/** One recurring meeting and its reminders, as configured. */
export interface Rule {
  id: string
  label: string
  /** WhatsApp chat JID the reminders post to, a group's ending in `@g.us`. */
  chat: string
  /** The nth weekday of each month: `nth` 1–5 or `last`. */
  meeting: { nth: number | 'last'; weekday: Weekday }
  /** Meeting time as the message prints it, such as "8:15 PM (shortly after Isha prayer)". */
  time: string
  venue: string
  reminders: readonly Reminder[]
  /** Message text with placeholders; empty uses the plugin's default template. */
  template?: string
  enabled: boolean
  override?: Override
}

/** One meeting day of a rule, with that month's override applied. */
export interface Occurrence {
  date: string
  time: string
  venue: string
}

/** A local reading of the clock. */
export interface LocalTime {
  /** `YYYY-MM-DD`. */
  date: string
  /** Minutes since local midnight. */
  minutes: number
}

/**
 * Read the clock in a time zone.
 * @param now - the instant.
 * @param timeZone - IANA zone, such as `Africa/Lagos`; an unknown zone throws.
 * @returns the local date and minute.
 */
export function localTime(now: Date, timeZone: string): LocalTime {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map(part => [part.type, part.value]))
  return {
    date: `${parts['year'] ?? ''}-${parts['month'] ?? ''}-${parts['day'] ?? ''}`,
    minutes: Number(parts['hour'] ?? 0) * 60 + Number(parts['minute'] ?? 0),
  }
}

/**
 * Parse `HH:MM` into minutes since midnight.
 * @param value - the configured time.
 * @returns the minutes, or undefined when the value is not a time of day.
 */
export function parseClock(value: string): number | undefined {
  const match = /^(\d{1,2}):(\d{2})$/u.exec(value.trim())
  if (match === null) return undefined
  const hours = Number(match[1])
  const minutes = Number(match[2])
  return hours < 24 && minutes < 60 ? hours * 60 + minutes : undefined
}

/** UTC noon of a `YYYY-MM-DD` date. */
function noon(date: string): Date {
  const [y = 0, m = 1, d = 1] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d, 12))
}

function iso(at: Date): string {
  return at.toISOString().slice(0, 10)
}

/**
 * Move a date by whole days.
 * @param date - `YYYY-MM-DD`.
 * @param days - negative goes back.
 * @returns the new date.
 */
export function addDays(date: string, days: number): string {
  const at = noon(date)
  at.setUTCDate(at.getUTCDate() + days)
  return iso(at)
}

/**
 * Whole days from one date to another.
 * @param from - `YYYY-MM-DD`.
 * @param to - `YYYY-MM-DD`.
 * @returns `to - from` in days.
 */
export function daysBetween(from: string, to: string): number {
  return Math.round((noon(to).getTime() - noon(from).getTime()) / 86_400_000)
}

/**
 * The weekday of a date.
 * @param date - `YYYY-MM-DD`.
 * @returns 0 for Sunday to 6 for Saturday.
 */
export function weekdayOf(date: string): number {
  return noon(date).getUTCDay()
}

/**
 * The nth given weekday of a month. The first Saturday is the Saturday among days 1–7, the second among 8–14, and so
 * on; `last` is the one in the month's final seven days.
 * @param year - full year.
 * @param month - 1–12.
 * @param nth - 1–5, or `last`.
 * @param weekday - which weekday.
 * @returns the date, or undefined when the month has no such day (a fifth Monday, say).
 */
export function nthWeekday(year: number, month: number, nth: number | 'last', weekday: Weekday): string | undefined {
  const target = WEEKDAYS.indexOf(weekday)
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
  let day: number
  if (nth === 'last') {
    const lastDow = new Date(Date.UTC(year, month - 1, daysInMonth, 12)).getUTCDay()
    day = daysInMonth - ((lastDow - target + 7) % 7)
  } else {
    const firstDow = new Date(Date.UTC(year, month - 1, 1, 12)).getUTCDay()
    day = 1 + ((target - firstDow + 7) % 7) + 7 * (nth - 1)
  }
  if (day < 1 || day > daysInMonth) return undefined
  return `${String(year)}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/**
 * A rule's meetings from a date on, with month overrides applied and skipped months left out.
 * @param rule - the rule.
 * @param from - first date that may count, `YYYY-MM-DD`; a meeting on this day is included.
 * @param count - how many to return; at most two years are searched.
 * @returns the occurrences, earliest first.
 */
export function occurrences(rule: Rule, from: string, count: number): Occurrence[] {
  const out: Occurrence[] = []
  let [year = 0, month = 1] = from.split('-').map(Number)
  for (let i = 0; i < 24 && out.length < count; i++) {
    const date = nthWeekday(year, month, rule.meeting.nth, rule.meeting.weekday)
    if (date !== undefined && date >= from) {
      const override = rule.override?.month === date.slice(0, 7) ? rule.override : undefined
      if (override?.skip !== true) {
        out.push({
          date,
          time: override?.time !== undefined && override.time.trim() !== '' ? override.time : rule.time,
          venue: override?.venue !== undefined && override.venue.trim() !== '' ? override.venue : rule.venue,
        })
      }
    }
    month += 1
    if (month > 12) { month = 1; year += 1 }
  }
  return out
}

/**
 * The day with its ordinal suffix.
 * @param day - day of month.
 * @returns `1st`, `2nd`, `3rd`, `11th`, `22nd`….
 */
export function ordinal(day: number): string {
  const tens = day % 100
  if (tens >= 11 && tens <= 13) return `${String(day)}th`
  return `${String(day)}${['th', 'st', 'nd', 'rd'][day % 10] ?? 'th'}`
}

/**
 * The English date the message prints next to the Hijri one.
 * @param date - `YYYY-MM-DD`.
 * @returns such as `3rd October 2026`.
 */
export function englishDate(date: string): string {
  const at = noon(date)
  return `${ordinal(at.getUTCDate())} ${MONTH_NAMES[at.getUTCMonth()] ?? ''} ${String(at.getUTCFullYear())}`
}

/**
 * The weekday's English name.
 * @param date - `YYYY-MM-DD`.
 * @returns such as `Saturday`.
 */
export function weekdayName(date: string): string {
  return WEEKDAY_NAMES[weekdayOf(date)] ?? ''
}

/**
 * The Hijri date of a civil day by the Umm al-Qura calendar, moved by the local adjustment.
 * @param date - `YYYY-MM-DD`.
 * @param offset - whole days added before converting; Nigeria's moon sighting can put the month a day off Umm al-Qura.
 * @returns such as `22 Rabi' al-Thani 1448 AH`.
 */
export function hijriDate(date: string, offset = 0): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-u-ca-islamic-umalqura', {
    timeZone: 'UTC', day: 'numeric', month: 'numeric', year: 'numeric',
  }).formatToParts(noon(addDays(date, Math.trunc(offset)))).map(part => [part.type, part.value]))
  const month = HIJRI_MONTHS[Number(parts['month']) - 1] ?? ''
  return `${parts['day'] ?? ''} ${month} ${parts['year'] ?? ''} AH`
}

/**
 * How the message names the meeting day, seen from the day it is sent.
 * @param today - the sending day.
 * @param meeting - the meeting day.
 * @returns `today`, `tomorrow` or `on Saturday`.
 */
export function whenText(today: string, meeting: string): string {
  const days = daysBetween(today, meeting)
  if (days === 0) return 'today'
  if (days === 1) return 'tomorrow'
  return `on ${weekdayName(meeting)}`
}

/** The template's placeholders. */
export interface MessageValues {
  hijriDate: string
  date: string
  weekday: string
  when: string
  time: string
  venue: string
  label: string
}

/**
 * Fill a template's `{name}` placeholders; unknown ones are left as written.
 * @param template - the message text.
 * @param values - what each placeholder becomes.
 * @returns the message.
 */
export function renderTemplate(template: string, values: MessageValues): string {
  return template.replace(/\{(\w+)\}/gu, (whole, key: string) => Object.hasOwn(values, key) ? values[key as keyof MessageValues] : whole)
}

/**
 * The message for one meeting, as sent on a given day.
 * @param rule - the rule.
 * @param occurrence - the meeting.
 * @param today - the sending day, for `{when}`.
 * @param options - the fallback template and the Hijri adjustment.
 * @returns the text.
 */
export function messageFor(rule: Rule, occurrence: Occurrence, today: string, options: { template: string; hijriOffset: number }): string {
  const template = rule.template !== undefined && rule.template.trim() !== '' ? rule.template : options.template
  return renderTemplate(template, {
    hijriDate: hijriDate(occurrence.date, options.hijriOffset),
    date: englishDate(occurrence.date),
    weekday: weekdayName(occurrence.date),
    when: whenText(today, occurrence.date),
    time: occurrence.time,
    venue: occurrence.venue,
    label: rule.label,
  })
}

/**
 * What is wrong with a rule, so the settings page can say so instead of the rule going quiet.
 * @param rule - the rule.
 * @returns one line per problem; empty when the rule can run.
 */
export function ruleProblems(rule: Rule): string[] {
  const problems: string[] = []
  if (rule.id.trim() === '') problems.push('id is empty')
  if (!rule.chat.trim().endsWith('@g.us')) problems.push('chat must be a WhatsApp group JID ending in @g.us')
  const { nth, weekday } = rule.meeting
  if (!(nth === 'last' || (Number.isInteger(nth) && nth >= 1 && nth <= 5))) problems.push('meeting.nth must be 1–5 or "last"')
  if (!(WEEKDAYS as readonly string[]).includes(weekday)) problems.push('meeting.weekday must be one of sun, mon, tue, wed, thu, fri, sat')
  for (const reminder of rule.reminders) {
    if (parseClock(reminder.at) === undefined) problems.push(`reminder time "${reminder.at}" is not HH:MM`)
    if (!Number.isInteger(reminder.daysBefore) || reminder.daysBefore < 0) problems.push(`daysBefore ${String(reminder.daysBefore)} is not a whole number`)
  }
  const override = rule.override
  const overrides = override !== undefined && (override.skip === true || (override.time ?? '') !== '' || (override.venue ?? '') !== '')
  if (overrides && !/^\d{4}-\d{2}$/u.test(override.month ?? '')) problems.push('override.month must be YYYY-MM')
  return problems
}

/**
 * The key a reminder is sent under, at most once.
 * @param ruleId - the rule.
 * @param meetingDate - `YYYY-MM-DD`.
 * @param daysBefore - which of the rule's reminders.
 * @returns `ruleId|meetingDate|daysBefore`.
 */
export function reminderKey(ruleId: string, meetingDate: string, daysBefore: number): string {
  return `${ruleId}|${meetingDate}|${String(daysBefore)}`
}

/** A local date and minute as one number, for comparing and subtracting. */
function minuteIndex(date: string, minutes: number): number {
  return Math.round((noon(date).getTime() - 12 * 3_600_000) / 60_000) + minutes
}

/** One scheduled reminder of one meeting. */
export interface PlannedReminder {
  rule: Rule
  occurrence: Occurrence
  reminder: Reminder
  key: string
  /** Local send day, `YYYY-MM-DD`. */
  sendDate: string
  /** Local send time, `HH:MM`. */
  sendAt: string
  /** `due` may go now; `upcoming` has not reached its time; `missed` is past the late window or the meeting day. */
  state: 'upcoming' | 'due' | 'missed'
  /** Minutes past its time when due. */
  lateBy: number
}

/**
 * The reminders of a rule's next meetings, each placed against the clock.
 * @param rule - an enabled rule without problems.
 * @param now - the local clock.
 * @param meetings - how many upcoming meetings to plan.
 * @param lateWindow - minutes after its time a reminder stays due.
 * @returns every reminder of those meetings, soonest first.
 */
export function planReminders(rule: Rule, now: LocalTime, meetings = 2, lateWindow = LATE_WINDOW_MINUTES): PlannedReminder[] {
  const nowIndex = minuteIndex(now.date, now.minutes)
  const planned: PlannedReminder[] = []
  for (const occurrence of occurrences(rule, now.date, meetings)) {
    for (const reminder of rule.reminders) {
      const at = parseClock(reminder.at)
      if (at === undefined) continue
      const sendDate = addDays(occurrence.date, -reminder.daysBefore)
      const lateBy = nowIndex - minuteIndex(sendDate, at)
      // Late is allowed only while the meeting day lasts and within the window; `occurrences` already drops past days.
      const state = lateBy < 0 ? 'upcoming' : lateBy <= lateWindow ? 'due' : 'missed'
      planned.push({
        rule, occurrence, reminder, key: reminderKey(rule.id, occurrence.date, reminder.daysBefore),
        sendDate, sendAt: reminder.at.trim().padStart(5, '0'), state, lateBy: Math.max(0, lateBy),
      })
    }
  }
  return planned.sort((a, b) => `${a.sendDate} ${a.sendAt}`.localeCompare(`${b.sendDate} ${b.sendAt}`))
}
