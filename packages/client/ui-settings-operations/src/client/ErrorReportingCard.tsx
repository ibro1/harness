/** The Error reporting plugin's card: where reports go, the DSN, and a test button. */

import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { Button, SettingsForm, SettingsSecretField, SettingsValueField } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { formLabels } from './locales.ts'
import { ERROR_REPORTING_TEXT_FIELDS, type ErrorReportingCardFace, type ErrorReportingLive } from './error-reporting-card-controller.ts'
import css from './scout.module.css'

/** Props the renderer binds for the Error reporting card. */
export type ErrorReportingCardProps =
  PropsRuntime<'plugins.item'>
  & PropsLocale<'settings.operations'>
  & InjectFace<ErrorReportingCardFace>

/**
 * The status line: whether reporting is on, to which server and project, and
 * where the DSN comes from.
 * @param props - locale copy and the Host's status.
 * @returns the line.
 */
function StatusLine(props: { t: ErrorReportingCardProps['t']; live: ErrorReportingLive }) {
  const { t, live } = props
  const status = live.status
  if (status === undefined) return <p className={css.pickerHint}>{live.statusFailed ? t('errorsStatusUnknown') : t('errorsStatusLoading')}</p>
  if (!status.enabled) {
    return <p className={css.pickerHint} role="status">{status.error === undefined ? t('errorsStatusOff') : `${t('errorsStatusInvalid')} ${status.error}`}</p>
  }
  const where = `${status.host ?? ''} · ${t('errorsProject')} ${status.projectId ?? ''} · ${status.environment ?? ''}`
  return (
    <p className={css.pickerValue} role="status">
      {t('errorsStatusOn')} {where}
      {status.source === 'environment' ? ` (${t('errorsFromEnvironment')})` : ''}
    </p>
  )
}

/**
 * Render the Error reporting card.
 * @param props - locale copy, the form and live snapshots, and the actions.
 * @returns the card.
 */
export function ErrorReportingCard(props: ErrorReportingCardProps) {
  const { t } = props
  const state = props.useErrorReportingCard(snapshot => snapshot)
  const live = props.useErrorReportingLive(snapshot => snapshot)
  if (props.view === 'summary') return t('errorsDescription')
  const disabled = !state.writable
  const common = (field: string) => ({
    overriddenLabel: t('overridden'),
    resetLabel: t('reset'),
    invalidLabel: t('errorsInvalid'),
    disabled,
    onReset: () => { props.resetField(field) },
    onEdit: (text: string) => { props.edit(field, text) },
  })
  const configured = live.status !== undefined && live.status.source !== 'none'
  const fromEnvironment = live.status?.source === 'environment'
  return (
    <SettingsForm labels={formLabels(t)} state={state} onSave={props.save} onDiscard={props.discard}>
      <div className={css.picker}>
        <span className={css.pickerLabel}>{t('errorsStatusTitle')}</span>
        <StatusLine t={t} live={live} />
        <div className={css.pickerCurrent}>
          <Button variant="outline" size="sm" disabled={live.test.state === 'sending' || live.status?.enabled !== true} onClick={props.sendTest}>
            {live.test.state === 'sending' ? t('errorsTestSending') : t('errorsTest')}
          </Button>
          <Button variant="ghost" size="sm" onClick={props.refreshStatus}>{t('errorsRefresh')}</Button>
        </div>
        {live.test.state === 'sent' ? <p className={css.pickerHint} role="status">{t('errorsTestSent')} {live.test.eventId}</p> : null}
        {live.test.state === 'failed' ? <p className={css.pickerUnknown} role="status">{t('errorsTestFailed')} {live.test.message}</p> : null}
      </div>
      <SettingsSecretField
        id="plugin-config-errors-dsn"
        label={t('errors.dsn')}
        hint={fromEnvironment ? t('errors.dsn.env') : t('errors.dsn.hint')}
        disabled={disabled || fromEnvironment}
        text={state.dsn.text}
        configured={configured}
        stateLabel={configured ? t('errorsDsnSet') : t('errorsDsnUnset')}
        onEdit={(text) => { props.edit('dsn', text) }}
      />
      {live.status?.source === 'settings'
        ? <p><Button variant="ghost" size="sm" disabled={disabled} onClick={props.removeDsn}>{t('errorsRemoveDsn')}</Button></p>
        : null}
      {ERROR_REPORTING_TEXT_FIELDS.map(field => (
        <SettingsValueField key={field} id={`plugin-config-errors-${field}`} label={t(`errors.${field}`)} hint={t(`errors.${field}.hint`)} {...state.text[field]} {...common(field)} />
      ))}
      <SettingsValueField id="plugin-config-errors-tracesSampleRate" label={t('errors.tracesSampleRate')} hint={t('errors.tracesSampleRate.hint')} numeric
        {...state.tracesSampleRate} {...common('tracesSampleRate')} />
    </SettingsForm>
  )
}
