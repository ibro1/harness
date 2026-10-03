/**
 * The YouTube niche scout's card: status, "Run research now" and the latest report, then the settings as a form —
 * the API key, the weekly day and time, seed topics, markets and languages edited row by row, the quota limits and the
 * models.
 */

import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { Button, SettingsForm, SettingsSecretField, SettingsValueField, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { formLabels } from './locales.ts'
import { ScoutModelPicker } from './ScoutModelPicker.tsx'
import {
  YNS_LIST_FIELDS, YNS_MODEL_PAIRS, YNS_NUMBER_FIELDS, YNS_WEEKDAYS, type YnsCardFace, type YnsLiveState,
} from './yns-card-controller.ts'
import picker from './scout.module.css'
import css from './seo.module.css'

/** Props the renderer binds for the card. */
export type YouTubeNicheScoutCardProps =
  PropsRuntime<'plugins.item'>
  & PropsLocale<'settings.operations'>
  & InjectFace<YnsCardFace>

type Translate = YouTubeNicheScoutCardProps['t']

function rpm(band: readonly [number, number]): string {
  return `$${String(band[0])}–${String(band[1])}`
}

/**
 * The run state, today's quota, "Run research now", and the latest report with its link.
 * @returns the block.
 */
export function YnsStatusBlock(props: { t: Translate; live: YnsLiveState; onRun: () => void; onRefresh: () => void }) {
  const { t, live } = props
  const status = live.status
  if (status === undefined) return <p className={picker.pickerHint} role="status">{live.failed ? t('ynsStatusUnknown') : t('ynsStatusLoading')}</p>
  const run = status.run
  const latest = status.latest
  const day = YNS_WEEKDAYS.find(d => status.schedule.weekday.trim().toLowerCase().startsWith(d.slice(0, 3)))
  return (
    <div className={picker.picker}>
      <span className={picker.pickerLabel}>{t('ynsStatusTitle')}</span>
      <p className={status.enabled ? picker.pickerValue : picker.pickerUnknown} role="status">
        {status.enabled
          ? t('ynsScheduled', { weekday: day === undefined ? status.schedule.weekday : t(`ynsWeekday.${day}`), time: status.schedule.time, timeZone: status.schedule.timeZone })
          : t('ynsOff')}
        {status.lastShiftDate === null ? '' : ` · ${t('ynsLastRun', { date: status.lastShiftDate })}`}
      </p>
      <p className={picker.pickerHint}>{t('ynsQuota', { used: status.quota.used, limit: status.quota.limit })}</p>
      {status.apiKey ? null : <p className={picker.pickerUnknown}>{t('ynsNoKey')}</p>}
      {status.apiKeySource === 'environment' ? <p className={picker.pickerHint}>{t('ynsKeyFromEnv')}</p> : null}
      <div className={picker.pickerCurrent}>
        <Button variant="outline" size="sm" disabled={live.started || !status.apiKey} onClick={props.onRun}>{t('ynsRunNow')}</Button>
        <Button variant="ghost" size="sm" onClick={props.onRefresh}>{t('ynsRefresh')}</Button>
      </div>
      {live.started ? <p className={picker.pickerHint} role="status">{t('ynsStarted')}</p> : null}
      {live.runError === undefined ? null : <p className={css.error} role="alert">{t('ynsRunRefused', { error: live.runError })}</p>}
      {run === null || run.finished
        ? null
        : (
          <p className={picker.pickerHint}>
            {t('ynsRunProgress', { searches: run.searches, cap: run.searchesPerRun, units: run.units, niches: run.niches.length })}
          </p>
        )}
      {latest === null
        ? <p className={picker.pickerHint}>{t('ynsNoReport')}</p>
        : (
          <div className={css.card}>
            <p className={css.state}>
              <strong>{t('ynsLatest', { date: latest.createdAt.slice(0, 10), niche: latest.recommendation })}</strong>
            </p>
            <p className={css.hint}>{latest.why}</p>
            <ol>
              {latest.niches.map(n => <li key={n.name}>{t('ynsNicheRow', { name: n.name, score: n.score, rpm: rpm(n.rpm) })}</li>)}
            </ol>
            <p><a href={latest.link} target="_blank" rel="noreferrer">{t('ynsOpenReport')}</a></p>
            {status.reports.length > 1
              ? (
                <ul>
                  {status.reports.slice(1, 8).map(r => (
                    <li key={r.id}><a href={r.link} target="_blank" rel="noreferrer">{r.createdAt.slice(0, 10)}</a>{` · ${r.recommendation}`}</li>
                  ))}
                </ul>
              )
              : null}
          </div>
        )}
    </div>
  )
}

/**
 * One list setting edited row by row: a text box per item, Remove beside each, and Add below. The rows are staged as
 * the field's lines; blank rows are dropped on save.
 * @returns the editor.
 */
export function ListEditor(props: {
  id: string
  label: string
  hint: string
  text: string
  placeholder: string
  addLabel: string
  removeLabel: string
  disabled: boolean
  onEdit: (text: string) => void
}) {
  const rows = props.text === '' ? [] : props.text.split('\n')
  const write = (next: string[]): void => { props.onEdit(next.join('\n')) }
  return (
    <fieldset className={css.fieldset}>
      <legend className={css.label}>{props.label}</legend>
      {rows.map((row, index) => (
        // Rows have no identity besides their place; an edit never reorders them.
        <div className={css.row} key={index}>
          <input
            id={index === 0 ? props.id : undefined}
            className={`${css.input} ${css.grow}`}
            type="text"
            value={row}
            placeholder={props.placeholder}
            aria-label={`${props.label} ${String(index + 1)}`}
            disabled={props.disabled}
            onChange={(event) => { write(rows.map((r, i) => (i === index ? event.target.value.replace(/\n/gu, ' ') : r))) }}
          />
          <Button variant="ghost" size="sm" disabled={props.disabled} onClick={() => { write(rows.filter((_, i) => i !== index)) }}>{props.removeLabel}</Button>
        </div>
      ))}
      <div className={css.row}>
        <Button variant="outline" size="sm" disabled={props.disabled} onClick={() => { write([...rows, '']) }}>{props.addLabel}</Button>
      </div>
      <p className={css.hint}>{props.hint}</p>
    </fieldset>
  )
}

/**
 * Render the card.
 * @param props - locale copy, the form, the status and the actions.
 * @returns the summary line or the card.
 */
export function YouTubeNicheScoutCard(props: YouTubeNicheScoutCardProps) {
  const { t } = props
  const state = props.useYnsCard(snapshot => snapshot)
  const models = props.useYnsModels(snapshot => snapshot)
  const live = props.useYnsLive(snapshot => snapshot)
  if (props.view === 'summary') return t('ynsDescription')
  const disabled = !state.writable
  const common = (field: string) => ({
    overriddenLabel: t('overridden'),
    resetLabel: t('reset'),
    invalidLabel: t('ynsInvalid'),
    disabled,
    onReset: () => { props.resetField(field) },
    onEdit: (text: string) => { props.edit(field, text) },
  })
  const text = (field: 'shiftTime' | 'timeZone' | 'notifyTo') => (
    <SettingsValueField id={`plugin-config-yns-${field}`} label={t(`yns.${field}`)} hint={t(`yns.${field}.hint`)} {...state.strings[field]} {...common(field)} />
  )
  const weekday = state.strings.weekday.text.trim().toLowerCase()
  return (
    <SettingsForm labels={formLabels(t)} state={state} onSave={props.save} onDiscard={props.discard}>
      <YnsStatusBlock t={t} live={live} onRun={props.runNow} onRefresh={props.refreshStatus} />
      <div>
        <p><strong>{t('yns.enabled')}</strong></p>
        <Switch
          label={t('yns.enabled')}
          title={t('yns.enabled.hint')}
          checked={state.enabled.text === 'true'}
          disabled={disabled}
          onChange={(next) => { props.edit('enabled', next ? 'true' : 'false') }}
        />
        <p>{t('yns.enabled.hint')}</p>
      </div>
      <SettingsSecretField
        id="plugin-config-yns-youtubeApiKey"
        label={t('yns.youtubeApiKey')}
        hint={t('yns.youtubeApiKey.hint')}
        disabled={disabled}
        text={state.secrets.youtubeApiKey.text}
        configured={live.status?.apiKey === true}
        stateLabel={live.status?.apiKey === true ? t('scoutSecretSet') : t('scoutSecretUnset')}
        onEdit={(value) => { props.edit('youtubeApiKey', value) }}
      />
      <div className={css.field}>
        <label className={css.label} htmlFor="plugin-config-yns-weekday">{t('yns.weekday')}</label>
        <select
          id="plugin-config-yns-weekday"
          className={css.input}
          value={(YNS_WEEKDAYS as readonly string[]).includes(weekday) ? weekday : 'monday'}
          disabled={disabled}
          onChange={(event) => { props.edit('weekday', event.target.value) }}
        >
          {YNS_WEEKDAYS.map(day => <option key={day} value={day}>{t(`ynsWeekday.${day}`)}</option>)}
        </select>
        <p className={css.hint}>{t('yns.weekday.hint')}</p>
      </div>
      {text('shiftTime')}
      {text('timeZone')}
      {text('notifyTo')}
      {YNS_LIST_FIELDS.map(field => (
        <ListEditor
          key={field}
          id={`plugin-config-yns-${field}`}
          label={t(`yns.${field}`)}
          hint={t(`yns.${field}.hint`)}
          text={state.lists[field].text}
          placeholder={t(`yns.${field}.placeholder`)}
          addLabel={t(`ynsAdd.${field}`)}
          removeLabel={t('ynsRemove')}
          disabled={disabled}
          onEdit={(value) => { props.edit(field, value) }}
        />
      ))}
      {YNS_NUMBER_FIELDS.map(field => (
        <SettingsValueField key={field} id={`plugin-config-yns-${field}`} label={t(`yns.${field}`)} hint={t(`yns.${field}.hint`)} numeric {...state.numbers[field]} {...common(field)} />
      ))}
      {YNS_MODEL_PAIRS.map(pair => (
        <ScoutModelPicker
          key={pair.key}
          labels={{
            label: t(`yns.${pair.key}`),
            hint: t(`yns.${pair.key}.hint`),
            search: t('scoutModelSearch'),
            none: t(`yns.${pair.key}.none`),
            change: t('scoutModelChange'),
            loading: t('scoutModelLoading'),
            failed: t('scoutModelFailed'),
            retry: t('scoutModelRetry'),
            noMatch: t('scoutModelNoMatch'),
            unknown: t('scoutModelUnknown'),
          }}
          catalog={models}
          provider={state.strings[pair.provider].text}
          model={state.strings[pair.model].text}
          disabled={disabled}
          onPick={(provider, model) => { props.edit(pair.provider, provider); props.edit(pair.model, model) }}
          onRetry={props.retryModels}
        />
      ))}
    </SettingsForm>
  )
}
