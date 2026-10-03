/** Locale bundles for the meeting reminders card. The Chinese bundle keeps the English copy: the card serves one English-speaking owner. */

/** The settings fields that carry a label and a hint. */
export type MeetingRemindersFieldKey = 'timeZone' | 'hijriOffset' | 'notifyTo' | 'template'

/** Locale keys the card renders. */
export type MeetingRemindersLocaleKey =
  | 'mrTitle' | 'mrDescription' | 'mrInvalid'
  | 'mrStatusLoading' | 'mrStatusUnknown' | 'mrToday' | 'mrNoRules' | 'mrNoMeeting'
  | 'mrNext' | 'mrReminder' | 'mrProblems' | 'mrPreview' | 'mrSendNow' | 'mrRefresh' | 'mrConfirmSend' | 'mrConfirmResend'
  | 'mrRecent' | 'mrNoSends' | 'mrManual' | 'mrSaveFirst' | 'mrSettings'
  | 'mrMeetings' | 'mrAddMeeting' | 'mrRemoveMeeting' | 'mrConfirmRemove' | 'mrNewMeeting'
  | 'mrField.label' | 'mrField.chat' | 'mrField.repeats' | 'mrField.time' | 'mrField.time.placeholder' | 'mrField.venue'
  | 'mrField.reminders' | 'mrField.message' | 'mrField.message.hint' | 'mrField.override' | 'mrField.override.hint' | 'mrField.enabled'
  | 'mrEvery' | 'mrOfMonth' | 'mrNth.1' | 'mrNth.2' | 'mrNth.3' | 'mrNth.4' | 'mrNth.5' | 'mrNth.last'
  | 'mrWeekday.sun' | 'mrWeekday.mon' | 'mrWeekday.tue' | 'mrWeekday.wed' | 'mrWeekday.thu' | 'mrWeekday.fri' | 'mrWeekday.sat'
  | 'mrDays.0' | 'mrDays.1' | 'mrDays.n' | 'mrAt' | 'mrAddReminder' | 'mrRemoveReminder'
  | 'mrOverrideMonth' | 'mrOverrideSkip' | 'mrOverrideTime' | 'mrOverrideVenue'
  | 'mrChooseGroup' | 'mrGroupsLoading' | 'mrGroupsFailed' | 'mrGroupsEmpty' | 'mrGroupCurrent' | 'mrGroupJidPlaceholder' | 'mrRetryGroups'
  | 'mrIssue.label' | 'mrIssue.chat' | 'mrIssue.reminders' | 'mrIssue.at' | 'mrIssue.month' | 'mrIssue.duplicate'
  | 'mrState.upcoming' | 'mrState.due' | 'mrState.missed' | 'mrState.sending' | 'mrState.sent' | 'mrState.gave-up'
  | `mr.${MeetingRemindersFieldKey}` | `mr.${MeetingRemindersFieldKey}.hint`

/** English dictionary. */
export const meetingRemindersEn: Record<MeetingRemindersLocaleKey, string> = {
  'mrTitle': 'Meeting reminders',
  'mrDescription': 'Posts reminders of monthly meetings to WhatsApp groups on a schedule, with the Islamic date first.',
  'mrInvalid': 'This value is not valid.',
  'mrStatusLoading': 'Loading…',
  'mrStatusUnknown': 'Could not read the reminders\' status.',
  'mrToday': 'Today is {hijri} ({english}), {now} in {zone}.',
  'mrNoRules': 'No meetings yet. Add one to start sending reminders.',
  'mrNoMeeting': 'No upcoming meeting.',
  'mrNext': 'Next: {weekday}, {hijri} ({english}) · {time} · {venue}',
  'mrReminder': '{when}, {date} at {at}: {state}',
  'mrProblems': 'Not sending: {problems}',
  'mrPreview': 'Preview',
  'mrSendNow': 'Send now',
  'mrRefresh': 'Refresh',
  'mrConfirmSend': 'Post the "{label}" reminder to its WhatsApp group now?',
  'mrConfirmResend': 'This reminder was already sent. Post it again?',
  'mrRecent': 'Recent sends',
  'mrNoSends': 'Nothing sent yet.',
  'mrManual': 'by hand',
  'mrSaveFirst': 'Save to see the next meeting and to preview or send.',
  'mrSettings': 'Settings',
  'mrMeetings': 'Meetings',
  'mrAddMeeting': 'Add meeting',
  'mrRemoveMeeting': 'Remove',
  'mrConfirmRemove': 'Remove "{label}"? Its reminders stop once you save.',
  'mrNewMeeting': 'New meeting',
  'mrField.label': 'Name',
  'mrField.chat': 'WhatsApp group',
  'mrField.repeats': 'Repeats',
  'mrField.time': 'Time',
  'mrField.time.placeholder': '8:15 PM (shortly after Isha prayer)',
  'mrField.venue': 'Venue',
  'mrField.reminders': 'Reminders',
  'mrField.message': 'Message',
  'mrField.message.hint': 'Leave empty to use the default message. Tap a placeholder to insert it:',
  'mrField.override': 'Skip or change one month',
  'mrField.override.hint': 'Pick the month, then skip its meeting or give that meeting a different time or venue. Other months are unchanged.',
  'mrField.enabled': 'Reminders on',
  'mrEvery': 'Every',
  'mrOfMonth': 'of the month',
  'mrNth.1': 'First',
  'mrNth.2': 'Second',
  'mrNth.3': 'Third',
  'mrNth.4': 'Fourth',
  'mrNth.5': 'Fifth',
  'mrNth.last': 'Last',
  'mrWeekday.sun': 'Sunday',
  'mrWeekday.mon': 'Monday',
  'mrWeekday.tue': 'Tuesday',
  'mrWeekday.wed': 'Wednesday',
  'mrWeekday.thu': 'Thursday',
  'mrWeekday.fri': 'Friday',
  'mrWeekday.sat': 'Saturday',
  'mrDays.0': 'On the day',
  'mrDays.1': 'The day before',
  'mrDays.n': '{n} days before',
  'mrAt': 'at',
  'mrAddReminder': 'Add reminder',
  'mrRemoveReminder': 'Remove reminder',
  'mrOverrideMonth': 'Month',
  'mrOverrideSkip': 'Skip this month',
  'mrOverrideTime': 'Time that month',
  'mrOverrideVenue': 'Venue that month',
  'mrChooseGroup': 'Choose a group…',
  'mrGroupsLoading': 'Loading your WhatsApp groups…',
  'mrGroupsFailed': 'Could not list your WhatsApp groups ({error}). Paste the group id instead.',
  'mrGroupsEmpty': 'No WhatsApp groups were found. Paste the group id instead.',
  'mrGroupCurrent': 'Current group ({jid})',
  'mrGroupJidPlaceholder': '1203…@g.us',
  'mrRetryGroups': 'Try again',
  'mrIssue.label': 'Give the meeting a name.',
  'mrIssue.chat': 'Choose the WhatsApp group the reminders go to.',
  'mrIssue.reminders': 'Add at least one reminder.',
  'mrIssue.at': 'Reminder {n} needs a time.',
  'mrIssue.month': 'Pick the month to skip or change.',
  'mrIssue.duplicate': 'Another meeting has the same name; rename one of them.',
  'mrState.upcoming': 'upcoming',
  'mrState.due': 'due now',
  'mrState.missed': 'missed',
  'mrState.sending': 'sending (or interrupted)',
  'mrState.sent': 'sent',
  'mrState.gave-up': 'failed, gave up',
  'mr.timeZone': 'Time zone',
  'mr.timeZone.hint': 'IANA time zone the reminder times are in, such as Africa/Lagos.',
  'mr.hijriOffset': 'Hijri day adjustment',
  'mr.hijriOffset.hint': 'Whole days added to the Umm al-Qura date: use 1 or -1 when the local moon sighting puts the month a day apart.',
  'mr.notifyTo': 'Alert recipient',
  'mr.notifyTo.hint': 'WhatsApp name or number told when a reminder could not be posted after its retries.',
  'mr.template': 'Default message',
  'mr.template.hint': 'Used by meetings with no message of their own. Placeholders: {hijriDate} {date} {weekday} {when} {time} {venue} {label}.',
}

/** Chinese dictionary; English copy. */
export const meetingRemindersZh: Record<MeetingRemindersLocaleKey, string> = { ...meetingRemindersEn }
