/**
 * The meeting reminders card: one form per meeting (name, WhatsApp group, which weekday of the month, time, venue,
 * reminders, message, a one-month change, on/off) with its next meeting and Preview and Send now, then the recent
 * sends and the plugin's settings. The form stages the plugin's rules array; the page's Save writes it.
 */

import { useId, useRef } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { Button, Checkbox, SettingsForm, SettingsValueField, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { formLabels } from './locales.ts'
import type {
  MeetingGroupsState, MeetingRemindersCardFace, MeetingRemindersLiveState, MeetingRuleStatus,
} from './meeting-reminders-card-controller.ts'
import {
  insertPlaceholder, MAX_DAYS_BEFORE, MEETING_NTHS, MEETING_TEMPLATE_KEYS, MEETING_WEEKDAYS, meetingIssues, newMeeting, readMeetings,
  renamed, writeMeetings, type MeetingDraft, type MeetingNth, type MeetingWeekday,
} from './meeting-reminders-model.ts'
import mr from './meeting-reminders.module.css'
import css from './seo.module.css'

/** Props the renderer binds for the card. */
export type MeetingRemindersCardProps =
  PropsRuntime<'plugins.item'>
  & PropsLocale<'settings.operations'>
  & InjectFace<MeetingRemindersCardFace>

type Translate = MeetingRemindersCardProps['t']

/** How a reminder's day reads: on the day, the day before, or N days before. */
function daysText(t: Translate, days: number): string {
  if (days === 0) return t('mrDays.0')
  if (days === 1) return t('mrDays.1')
  return t('mrDays.n', { n: days })
}

/**
 * The group dropdown, or a text field for the group id when the groups cannot be listed.
 * @returns the control.
 */
function GroupField(props: {
  t: Translate
  id: string
  chat: string
  groups: MeetingGroupsState
  disabled: boolean
  onChange: (jid: string) => void
  onRetry: () => void
}) {
  const { t, groups, chat } = props
  if (groups.state === 'ready' && groups.list.length > 0) {
    const known = groups.list.some(group => group.jid === chat)
    return (
      <select
        id={props.id}
        className={css.input}
        value={chat}
        disabled={props.disabled}
        onChange={(event) => { props.onChange(event.target.value) }}
      >
        <option value="">{t('mrChooseGroup')}</option>
        {known || chat === '' ? null : <option value={chat}>{t('mrGroupCurrent', { jid: chat })}</option>}
        {groups.list.map(group => <option key={group.jid} value={group.jid}>{group.name === '' ? group.jid : group.name}</option>)}
      </select>
    )
  }
  return (
    <>
      <input
        id={props.id}
        className={css.input}
        type="text"
        value={chat}
        placeholder={t('mrGroupJidPlaceholder')}
        disabled={props.disabled}
        onChange={(event) => { props.onChange(event.target.value.trim()) }}
      />
      {groups.state === 'loading'
        ? <p className={css.hint} role="status">{t('mrGroupsLoading')}</p>
        : (
          <div className={css.row}>
            <p className={css.hint}>{groups.state === 'failed' ? t('mrGroupsFailed', { error: groups.error ?? '' }) : t('mrGroupsEmpty')}</p>
            <Button variant="ghost" size="sm" onClick={props.onRetry}>{t('mrRetryGroups')}</Button>
          </div>
        )}
    </>
  )
}

/** Props of {@link MeetingForm}. */
export interface MeetingFormProps {
  t: Translate
  meeting: MeetingDraft
  others: readonly MeetingDraft[]
  savedIds: ReadonlySet<string>
  status: MeetingRuleStatus | undefined
  live: MeetingRemindersLiveState
  disabled: boolean
  onChange: (next: MeetingDraft) => void
  onRemove: () => void
  onPreview: () => void
  onSend: () => void
  onRetryGroups: () => void
}

/**
 * One meeting's form, with its next meeting and buttons.
 * @returns the card.
 */
export function MeetingForm(props: MeetingFormProps) {
  const { t, meeting, status, live, disabled } = props
  const base = useId()
  const message = useRef<HTMLTextAreaElement>(null)
  // Where the owner last left the cursor in the message; a chip clicked before that appends.
  const cursor = useRef<number | undefined>(undefined)
  const set = (change: Partial<MeetingDraft>): void => { props.onChange({ ...meeting, ...change }) }
  const setOverride = (change: NonNullable<MeetingDraft['override']>): void => { set({ override: { ...meeting.override, ...change } }) }
  const setReminder = (index: number, change: Partial<MeetingDraft['reminders'][number]>): void => {
    set({ reminders: meeting.reminders.map((reminder, i) => i === index ? { ...reminder, ...change } : reminder) })
  }
  const issues = meetingIssues(meeting, props.others)
  const otherIds = new Set(props.others.map(other => other.id))
  const saved = status !== undefined && props.savedIds.has(meeting.id)
  const busy = live.busy.includes(meeting.id)
  const insert = (placeholder: string): void => {
    const next = insertPlaceholder(meeting.template ?? '', placeholder, cursor.current)
    cursor.current = next.cursor
    set({ template: next.text })
    message.current?.focus()
  }
  const override = meeting.override ?? {}
  const dayChoices = Array.from({ length: Math.max(MAX_DAYS_BEFORE, ...meeting.reminders.map(r => r.daysBefore)) + 1 }, (_, n) => n)
  return (
    <div className={`${css.card} ${mr.meeting}`}>
      <div className={css.formHead}>
        <h4 className={css.cardTitle}><strong>{meeting.label.trim() === '' ? t('mrNewMeeting') : meeting.label}</strong></h4>
        <div className={css.row}>
          <span className={css.hint}>{t('mrField.enabled')}</span>
          <Switch
            label={t('mrField.enabled')}
            title={t('mrField.enabled')}
            checked={meeting.enabled}
            disabled={disabled}
            onChange={(next) => { set({ enabled: next }) }}
          />
        </div>
      </div>

      {saved && status.problems.length > 0 ? <p className={css.error}>{t('mrProblems', { problems: status.problems.join('; ') })}</p> : null}
      {!saved
        ? <p className={css.hint}>{t('mrSaveFirst')}</p>
        : status.next === null
          ? <p className={css.hint}>{t('mrNoMeeting')}</p>
          : (
            <>
              <p className={css.state}>{t('mrNext', { ...status.next })}</p>
              {status.reminders.map(r => (
                <p key={`${String(r.daysBefore)}-${r.sendAt}`} className={css.hint}>
                  {t('mrReminder', { when: daysText(t, r.daysBefore), date: r.sendDate, at: r.sendAt, state: t(`mrState.${r.state}`) })}
                </p>
              ))}
            </>
          )}

      <div className={css.field}>
        <label className={css.label} htmlFor={`${base}-label`}>{t('mrField.label')}</label>
        <input
          id={`${base}-label`}
          className={css.input}
          type="text"
          value={meeting.label}
          disabled={disabled}
          onChange={(event) => { props.onChange(renamed(meeting, event.target.value, props.savedIds, otherIds)) }}
        />
      </div>

      <div className={css.field}>
        <label className={css.label} htmlFor={`${base}-chat`}>{t('mrField.chat')}</label>
        <GroupField
          t={t}
          id={`${base}-chat`}
          chat={meeting.chat}
          groups={live.groups}
          disabled={disabled}
          onChange={(chat) => { set({ chat }) }}
          onRetry={props.onRetryGroups}
        />
      </div>

      <div className={css.field}>
        <span className={css.label} id={`${base}-repeats`}>{t('mrField.repeats')}</span>
        <div className={css.row} role="group" aria-labelledby={`${base}-repeats`}>
          <span className={css.state}>{t('mrEvery')}</span>
          <select
            className={`${css.input} ${mr.nth}`}
            aria-label={t('mrField.repeats')}
            value={String(meeting.meeting.nth)}
            disabled={disabled}
            onChange={(event) => {
              const nth: MeetingNth = event.target.value === 'last' ? 'last' : Number(event.target.value) as MeetingNth
              set({ meeting: { ...meeting.meeting, nth } })
            }}
          >
            {MEETING_NTHS.map(nth => <option key={nth} value={String(nth)}>{t(`mrNth.${nth}`)}</option>)}
          </select>
          <select
            className={`${css.input} ${mr.weekday}`}
            aria-label={t('mrField.repeats')}
            value={meeting.meeting.weekday}
            disabled={disabled}
            onChange={(event) => { set({ meeting: { ...meeting.meeting, weekday: event.target.value as MeetingWeekday } }) }}
          >
            {MEETING_WEEKDAYS.map(day => <option key={day} value={day}>{t(`mrWeekday.${day}`)}</option>)}
          </select>
          <span className={css.state}>{t('mrOfMonth')}</span>
        </div>
      </div>

      <div className={css.field}>
        <label className={css.label} htmlFor={`${base}-time`}>{t('mrField.time')}</label>
        <input
          id={`${base}-time`}
          className={css.input}
          type="text"
          value={meeting.time}
          placeholder={t('mrField.time.placeholder')}
          disabled={disabled}
          onChange={(event) => { set({ time: event.target.value }) }}
        />
      </div>
      <div className={css.field}>
        <label className={css.label} htmlFor={`${base}-venue`}>{t('mrField.venue')}</label>
        <input
          id={`${base}-venue`}
          className={css.input}
          type="text"
          value={meeting.venue}
          disabled={disabled}
          onChange={(event) => { set({ venue: event.target.value }) }}
        />
      </div>

      <fieldset className={css.fieldset}>
        <legend className={css.label}>{t('mrField.reminders')}</legend>
        {meeting.reminders.map((reminder, index) => (
          <div key={index} className={css.row}>
            <select
              className={`${css.input} ${mr.days}`}
              aria-label={t('mrField.reminders')}
              value={String(reminder.daysBefore)}
              disabled={disabled}
              onChange={(event) => { setReminder(index, { daysBefore: Number(event.target.value) }) }}
            >
              {dayChoices.map(n => <option key={n} value={String(n)}>{daysText(t, n)}</option>)}
            </select>
            <span className={css.state}>{t('mrAt')}</span>
            <input
              className={`${css.input} ${mr.clock}`}
              type="time"
              aria-label={t('mrAt')}
              value={reminder.at}
              disabled={disabled}
              onChange={(event) => { setReminder(index, { at: event.target.value }) }}
            />
            <Button variant="ghost" size="sm" disabled={disabled} onClick={() => { set({ reminders: meeting.reminders.filter((_, i) => i !== index) }) }}>
              {t('mrRemoveReminder')}
            </Button>
          </div>
        ))}
        <div className={css.row}>
          <Button variant="ghost" size="sm" disabled={disabled} onClick={() => { set({ reminders: [...meeting.reminders, { daysBefore: 0, at: '09:00' }] }) }}>
            {t('mrAddReminder')}
          </Button>
        </div>
      </fieldset>

      <div className={css.field}>
        <label className={css.label} htmlFor={`${base}-message`}>{t('mrField.message')}</label>
        <textarea
          id={`${base}-message`}
          ref={message}
          className={`${css.input} ${css.textarea}`}
          rows={6}
          value={meeting.template ?? ''}
          disabled={disabled}
          onChange={(event) => { set({ template: event.target.value }) }}
          onSelect={(event) => { cursor.current = event.currentTarget.selectionStart }}
        />
        <p className={css.hint}>{t('mrField.message.hint')}</p>
        <div className={css.row}>
          {MEETING_TEMPLATE_KEYS.map(name => (
            <Button key={name} variant="outline" size="sm" disabled={disabled} onClick={() => { insert(name) }}>{`{${name}}`}</Button>
          ))}
        </div>
      </div>

      <fieldset className={css.fieldset}>
        <legend className={css.label}>{t('mrField.override')}</legend>
        <div className={css.row}>
          <input
            className={`${css.input} ${css.grow}`}
            type="month"
            aria-label={t('mrOverrideMonth')}
            value={override.month ?? ''}
            disabled={disabled}
            onChange={(event) => { setOverride({ month: event.target.value }) }}
          />
          <Checkbox label={t('mrOverrideSkip')} checked={override.skip === true} disabled={disabled} onChange={(skip) => { setOverride({ skip }) }} />
        </div>
        {override.skip === true
          ? null
          : (
            <div className={css.row}>
              <input
                className={`${css.input} ${css.grow}`}
                type="text"
                aria-label={t('mrOverrideTime')}
                placeholder={t('mrOverrideTime')}
                value={override.time ?? ''}
                disabled={disabled}
                onChange={(event) => { setOverride({ time: event.target.value }) }}
              />
              <input
                className={`${css.input} ${css.grow}`}
                type="text"
                aria-label={t('mrOverrideVenue')}
                placeholder={t('mrOverrideVenue')}
                value={override.venue ?? ''}
                disabled={disabled}
                onChange={(event) => { setOverride({ venue: event.target.value }) }}
              />
            </div>
          )}
        <p className={css.hint}>{t('mrField.override.hint')}</p>
      </fieldset>

      {issues.map(issue => (
        <p key={`${issue.key}-${String(issue.params?.['n'] ?? '')}`} className={css.error} role="alert">{t(issue.key, issue.params)}</p>
      ))}

      <div className={css.row}>
        <Button variant="ghost" size="sm" disabled={!saved || busy || status.next === null} onClick={props.onPreview}>{t('mrPreview')}</Button>
        <Button variant="outline" size="sm" disabled={!saved || busy || status.next === null || status.problems.length > 0} onClick={props.onSend}>
          {t('mrSendNow')}
        </Button>
        <Button variant="ghost" size="sm" disabled={disabled} onClick={props.onRemove}>{t('mrRemoveMeeting')}</Button>
      </div>
      {live.previews[meeting.id] === undefined ? null : <p className={css.answer}>{live.previews[meeting.id]}</p>}
      {live.results[meeting.id] === undefined ? null : <p className={css.hint} role="status">{live.results[meeting.id]}</p>}
    </div>
  )
}

/**
 * Today's dates and the recent sends.
 * @returns the block.
 */
function StatusBlock(props: { t: Translate; live: MeetingRemindersLiveState; onRefresh: () => void }) {
  const { t, live } = props
  const status = live.status
  if (status === undefined) return <p className={css.hint} role="status">{live.failed ? t('mrStatusUnknown') : t('mrStatusLoading')}</p>
  return (
    <div className={css.field}>
      <div className={css.row}>
        {status.today === null || status.now === null
          ? (status.error === undefined ? null : <p className={css.error}>{status.error}</p>)
          : <p className={css.state}>{t('mrToday', { ...status.today, now: status.now, zone: status.timeZone })}</p>}
        <Button variant="ghost" size="sm" onClick={props.onRefresh}>{t('mrRefresh')}</Button>
      </div>
      <span className={css.label}>{t('mrRecent')}</span>
      {status.sent.length === 0
        ? <p className={css.hint}>{t('mrNoSends')}</p>
        : status.sent.slice(0, 10).map(s => (
          <p key={`${s.key}-${s.at}`} className={css.hint}>
            {`${s.at.slice(0, 16).replace('T', ' ')} · ${s.label} · ${s.outcome}${s.manual === true ? ` · ${t('mrManual')}` : ''}`}
          </p>
        ))}
    </div>
  )
}

/**
 * Render the card.
 * @param props - locale copy, the form, the status and the actions.
 * @returns the summary line or the card.
 */
export function MeetingRemindersCard(props: MeetingRemindersCardProps) {
  const { t } = props
  const state = props.useMeetingRemindersCard(snapshot => snapshot)
  const live = props.useMeetingRemindersLive(snapshot => snapshot)
  if (props.view === 'summary') return t('mrDescription')
  const disabled = !state.writable
  const meetings = readMeetings(state.rules.text)
  const savedIds = new Set(live.status?.rules.map(rule => rule.id) ?? [])
  const stage = (next: readonly MeetingDraft[]): void => { props.edit('rules', writeMeetings(next)) }
  const send = async (meeting: MeetingDraft): Promise<void> => {
    if (!window.confirm(t('mrConfirmSend', { label: meeting.label }))) return
    if (await props.sendNow(meeting.id, false) === 'already-sent' && window.confirm(t('mrConfirmResend'))) await props.sendNow(meeting.id, true)
  }
  const field = (name: 'timeZone' | 'hijriOffset' | 'notifyTo' | 'template', extra: { multiline?: boolean; numeric?: boolean } = {}) => (
    <SettingsValueField
      id={`plugin-config-mr-${name}`}
      label={t(`mr.${name}`)}
      hint={t(`mr.${name}.hint`)}
      {...state[name]}
      {...extra}
      overriddenLabel={t('overridden')}
      resetLabel={t('reset')}
      invalidLabel={t('mrInvalid')}
      disabled={disabled}
      onReset={() => { props.resetField(name) }}
      onEdit={(text: string) => { props.edit(name, text) }}
    />
  )
  return (
    <SettingsForm labels={formLabels(t)} state={state} onSave={props.save} onDiscard={props.discard}>
      <StatusBlock t={t} live={live} onRefresh={props.refreshStatus} />
      <h4 className={css.subtitle}>{t('mrMeetings')}</h4>
      {meetings.length === 0 ? <p className={css.hint}>{t('mrNoRules')}</p> : null}
      {meetings.map((meeting, index) => (
        <MeetingForm
          key={index}
          t={t}
          meeting={meeting}
          others={meetings.filter((_, i) => i !== index)}
          savedIds={savedIds}
          status={live.status?.rules.find(rule => rule.id === meeting.id)}
          live={live}
          disabled={disabled}
          onChange={(next) => { stage(meetings.map((m, i) => i === index ? next : m)) }}
          onRemove={() => {
            if (window.confirm(t('mrConfirmRemove', { label: meeting.label.trim() === '' ? t('mrNewMeeting') : meeting.label }))) {
              stage(meetings.filter((_, i) => i !== index))
            }
          }}
          onPreview={() => { props.preview(meeting.id) }}
          onSend={() => { void send(meeting) }}
          onRetryGroups={props.refreshGroups}
        />
      ))}
      <div className={css.row}>
        <Button variant="outline" size="sm" disabled={disabled} onClick={() => { stage([...meetings, newMeeting(new Set(meetings.map(m => m.id)))]) }}>
          {t('mrAddMeeting')}
        </Button>
      </div>
      <h4 className={css.subtitle}>{t('mrSettings')}</h4>
      {field('timeZone')}
      {field('hijriOffset', { numeric: true })}
      {field('notifyTo')}
      {field('template', { multiline: true })}
    </SettingsForm>
  )
}
