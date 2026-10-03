/** The meeting reminders card: each rule's next meeting with Preview and Send now, recent sends, and the settings. */

import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { Button, SettingsForm, SettingsValueField } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { formLabels } from './locales.ts'
import type { MeetingRemindersCardFace, MeetingRemindersLiveState, MeetingRuleStatus } from './meeting-reminders-card-controller.ts'
import css from './scout.module.css'

/** Props the renderer binds for the card. */
export type MeetingRemindersCardProps =
  PropsRuntime<'plugins.item'>
  & PropsLocale<'settings.operations'>
  & InjectFace<MeetingRemindersCardFace>

type Translate = MeetingRemindersCardProps['t']

/**
 * One rule: its next meeting, its reminders' times and states, and the buttons.
 * @returns the block.
 */
function RuleBlock(props: {
  t: Translate
  rule: MeetingRuleStatus
  live: MeetingRemindersLiveState
  onPreview: () => void
  onSend: () => void
}) {
  const { t, rule, live } = props
  const busy = live.busy.includes(rule.id)
  return (
    <li>
      <strong>{rule.label}</strong>{rule.enabled ? '' : ` (${t('mrDisabled')})`}
      {rule.problems.length > 0 ? <p className={css.pickerUnknown}>{t('mrProblems', { problems: rule.problems.join('; ') })}</p> : null}
      {rule.next === null
        ? (rule.problems.length > 0 ? null : <p className={css.pickerHint}>{t('mrNoMeeting')}</p>)
        : <p className={css.pickerValue}>{t('mrNext', { ...rule.next })}</p>}
      {rule.reminders.length === 0
        ? null
        : (
          <ul>
            {rule.reminders.map(r => (
              <li key={`${String(r.daysBefore)}-${r.sendAt}`}>
                {t('mrReminder', { days: r.daysBefore, date: r.sendDate, at: r.sendAt, state: t(`mrState.${r.state}`) })}
              </li>
            ))}
          </ul>
        )}
      <div className={css.pickerCurrent}>
        <Button variant="ghost" size="sm" disabled={busy || rule.next === null} onClick={props.onPreview}>{t('mrPreview')}</Button>
        <Button variant="outline" size="sm" disabled={busy || rule.next === null || rule.problems.length > 0} onClick={props.onSend}>{t('mrSendNow')}</Button>
      </div>
      {live.previews[rule.id] === undefined ? null : <pre style={{ whiteSpace: 'pre-wrap' }}>{live.previews[rule.id]}</pre>}
      {live.results[rule.id] === undefined ? null : <p className={css.pickerHint} role="status">{live.results[rule.id]}</p>}
    </li>
  )
}

/**
 * The rules' next meetings and the recent sends.
 * @returns the block.
 */
function StatusBlock(props: {
  t: Translate
  live: MeetingRemindersLiveState
  face: Pick<MeetingRemindersCardFace, 'preview' | 'sendNow' | 'refreshStatus'>
}) {
  const { t, live, face } = props
  const status = live.status
  if (status === undefined) return <p className={css.pickerHint} role="status">{live.failed ? t('mrStatusUnknown') : t('mrStatusLoading')}</p>
  const send = async (rule: MeetingRuleStatus): Promise<void> => {
    if (!window.confirm(t('mrConfirmSend', { label: rule.label }))) return
    if (await face.sendNow(rule.id, false) === 'already-sent' && window.confirm(t('mrConfirmResend'))) await face.sendNow(rule.id, true)
  }
  return (
    <div className={css.picker}>
      <span className={css.pickerLabel}>{t('mrStatusTitle')}</span>
      {status.today === null || status.now === null
        ? (status.error === undefined ? null : <p className={css.pickerUnknown}>{status.error}</p>)
        : <p className={css.pickerHint}>{t('mrToday', { ...status.today, now: status.now, zone: status.timeZone })}</p>}
      {status.rules.length === 0
        ? <p className={css.pickerHint}>{t('mrNoRules')}</p>
        : (
          <ul>
            {status.rules.map(rule => (
              <RuleBlock
                key={rule.id}
                t={t}
                rule={rule}
                live={live}
                onPreview={() => { face.preview(rule.id) }}
                onSend={() => { void send(rule) }}
              />
            ))}
          </ul>
        )}
      <div className={css.pickerCurrent}>
        <Button variant="ghost" size="sm" onClick={face.refreshStatus}>{t('mrRefresh')}</Button>
      </div>
      <span className={css.pickerLabel}>{t('mrRecent')}</span>
      {status.sent.length === 0
        ? <p className={css.pickerHint}>{t('mrNoSends')}</p>
        : (
          <ul>
            {status.sent.slice(0, 10).map(s => (
              <li key={`${s.key}-${s.at}`}>{`${s.at.slice(0, 16).replace('T', ' ')} · ${s.label} · ${s.outcome}${s.manual === true ? ` · ${t('mrManual')}` : ''}`}</li>
            ))}
          </ul>
        )}
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
  const field = (name: 'rules' | 'timeZone' | 'hijriOffset' | 'notifyTo' | 'template', extra: { multiline?: boolean; numeric?: boolean } = {}) => (
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
      <StatusBlock t={t} live={live} face={{ preview: props.preview, sendNow: props.sendNow, refreshStatus: props.refreshStatus }} />
      {field('rules', { multiline: true })}
      <p className={css.pickerHint}>{t('mrRulesExample')}</p>
      {field('timeZone')}
      {field('hijriOffset', { numeric: true })}
      {field('notifyTo')}
      {field('template', { multiline: true })}
    </SettingsForm>
  )
}
