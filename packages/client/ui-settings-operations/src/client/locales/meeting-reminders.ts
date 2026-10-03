/** Locale bundles for the meeting reminders card. The Chinese bundle keeps the English copy: the card serves one English-speaking owner. */

/** The fields that carry a label and a hint. */
export type MeetingRemindersFieldKey = 'rules' | 'timeZone' | 'hijriOffset' | 'notifyTo' | 'template'

/** Locale keys the card renders. */
export type MeetingRemindersLocaleKey =
  | 'mrTitle' | 'mrDescription' | 'mrInvalid'
  | 'mrStatusTitle' | 'mrStatusLoading' | 'mrStatusUnknown' | 'mrToday' | 'mrNoRules' | 'mrDisabled' | 'mrNoMeeting'
  | 'mrNext' | 'mrReminder' | 'mrProblems' | 'mrPreview' | 'mrSendNow' | 'mrRefresh' | 'mrConfirmSend' | 'mrConfirmResend'
  | 'mrRecent' | 'mrNoSends' | 'mrManual' | 'mrRulesExample'
  | 'mrState.upcoming' | 'mrState.due' | 'mrState.missed' | 'mrState.sending' | 'mrState.sent' | 'mrState.gave-up'
  | `mr.${MeetingRemindersFieldKey}` | `mr.${MeetingRemindersFieldKey}.hint`

/** English dictionary. */
export const meetingRemindersEn: Record<MeetingRemindersLocaleKey, string> = {
  'mrTitle': 'Meeting reminders',
  'mrDescription': 'Posts reminders of monthly meetings to WhatsApp groups on a schedule, with the Islamic date first.',
  'mrInvalid': 'This value is not valid.',
  'mrStatusTitle': 'Next meetings',
  'mrStatusLoading': 'Loading…',
  'mrStatusUnknown': 'Could not read the reminders\' status.',
  'mrToday': 'Today is {hijri} ({english}), {now} in {zone}.',
  'mrNoRules': 'No rules yet. Add them below as JSON and save.',
  'mrDisabled': 'off',
  'mrNoMeeting': 'No upcoming meeting.',
  'mrNext': 'Next: {weekday}, {hijri} ({english}) · {time} · {venue}',
  'mrReminder': '{days} days before, {date} at {at}: {state}',
  'mrProblems': 'Not sending: {problems}',
  'mrPreview': 'Preview',
  'mrSendNow': 'Send now',
  'mrRefresh': 'Refresh',
  'mrConfirmSend': 'Post the "{label}" reminder to its WhatsApp group now?',
  'mrConfirmResend': 'This reminder was already sent. Post it again?',
  'mrRecent': 'Recent sends',
  'mrNoSends': 'Nothing sent yet.',
  'mrManual': 'by hand',
  'mrRulesExample': 'Example: [{"id":"exco","label":"Exco meeting","chat":"1203…@g.us","meeting":{"nth":1,"weekday":"sat"},"time":"8:15 PM","venue":"Central Masjid","reminders":[{"daysBefore":2,"at":"09:00"},{"daysBefore":0,"at":"09:00"}],"enabled":true}]',
  'mrState.upcoming': 'upcoming',
  'mrState.due': 'due now',
  'mrState.missed': 'missed',
  'mrState.sending': 'sending (or interrupted)',
  'mrState.sent': 'sent',
  'mrState.gave-up': 'failed, gave up',
  'mr.rules': 'Rules',
  'mr.rules.hint': 'A JSON array, one object per meeting: id, label, chat (group JID ending @g.us), meeting {nth: 1–5 or "last", weekday: sun…sat}, time, venue, reminders [{daysBefore, at "HH:MM"}], template (optional), enabled, and optionally override {month "YYYY-MM", skip, time, venue} for one month.',
  'mr.timeZone': 'Time zone',
  'mr.timeZone.hint': 'IANA time zone the reminder times are in, such as Africa/Lagos.',
  'mr.hijriOffset': 'Hijri day adjustment',
  'mr.hijriOffset.hint': 'Whole days added to the Umm al-Qura date: use 1 or -1 when the local moon sighting puts the month a day apart.',
  'mr.notifyTo': 'Alert recipient',
  'mr.notifyTo.hint': 'WhatsApp name or number told when a reminder could not be posted after its retries.',
  'mr.template': 'Default message',
  'mr.template.hint': 'Used by rules with no template. Placeholders: {hijriDate} {date} {weekday} {when} {time} {venue} {label}.',
}

/** Chinese dictionary; English copy. */
export const meetingRemindersZh: Record<MeetingRemindersLocaleKey, string> = { ...meetingRemindersEn }
