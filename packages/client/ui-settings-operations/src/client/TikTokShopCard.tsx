/** The TikTok Shop employee's card: status and recent videos, the daily shift, its models, the voice, and the data key. */

import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { Button, SettingsForm, SettingsSecretField, SettingsValueField, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { formLabels } from './locales.ts'
import { ScoutModelPicker } from './ScoutModelPicker.tsx'
import { TTS_LIST_FIELDS, TTS_MODEL_PAIRS, TTS_NUMBER_FIELDS, type TtsCardFace, type TtsLiveState } from './tts-card-controller.ts'
import css from './scout.module.css'

/** Props the renderer binds for the card. */
export type TikTokShopCardProps =
  PropsRuntime<'plugins.item'>
  & PropsLocale<'settings.operations'>
  & InjectFace<TtsCardFace>

type Translate = TikTokShopCardProps['t']

/**
 * Today's count, the pause switch, the keys in force, and the recent videos with their review links.
 * @returns the block.
 */
function StatusBlock(props: {
  t: Translate
  live: TtsLiveState
  onRun: () => void
  onPause: () => void
  onResume: () => void
  onRefresh: () => void
}) {
  const { t, live } = props
  const status = live.status
  if (status === undefined) return <p className={css.pickerHint} role="status">{live.failed ? t('ttsStatusUnknown') : t('ttsStatusLoading')}</p>
  return (
    <div className={css.picker}>
      <span className={css.pickerLabel}>{t('ttsStatusTitle')}</span>
      <p className={status.paused === null ? css.pickerValue : css.pickerUnknown} role="status">
        {status.paused === null ? t('ttsRunning') : t('ttsPaused', { reason: status.paused.reason })}
        {' · '}{t('ttsToday', { made: status.today, cap: status.cap })}
        {status.lastShiftDate === null ? '' : ` · ${t('ttsLastShift', { date: status.lastShiftDate })}`}
      </p>
      {status.dataKey ? null : <p className={css.pickerUnknown}>{t('ttsNoDataKey')}</p>}
      <div className={css.pickerCurrent}>
        <Button variant="outline" size="sm" disabled={status.paused !== null || !status.dataKey} onClick={props.onRun}>{t('ttsRunNow')}</Button>
        {status.paused === null
          ? <Button variant="ghost" size="sm" onClick={props.onPause}>{t('ttsPause')}</Button>
          : <Button variant="ghost" size="sm" onClick={props.onResume}>{t('ttsResume')}</Button>}
        <Button variant="ghost" size="sm" onClick={props.onRefresh}>{t('ttsRefresh')}</Button>
      </div>
      {live.started ? <p className={css.pickerHint} role="status">{t('ttsStarted')}</p> : null}
      {status.videos.length === 0
        ? <p className={css.pickerHint}>{t('ttsNoVideos')}</p>
        : (
          <ul>
            {status.videos.slice(0, 12).map(v => (
              <li key={v.id}>
                <a href={v.review} target="_blank" rel="noreferrer">{v.product}</a>
                {` · ${t(`ttsVideo.${v.status}`)} · ${v.format} · “${v.hook}”`}
                {v.results === undefined ? '' : ` · ${t('ttsResults', { views: v.results.views ?? 0, sales: v.results.sales ?? 0 })}`}
                {v.error === undefined ? '' : ` · ${v.error}`}
              </li>
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
export function TikTokShopCard(props: TikTokShopCardProps) {
  const { t } = props
  const state = props.useTtsCard(snapshot => snapshot)
  const models = props.useTtsModels(snapshot => snapshot)
  const live = props.useTtsLive(snapshot => snapshot)
  if (props.view === 'summary') return t('ttsDescription')
  const disabled = !state.writable
  const common = (field: string) => ({
    overriddenLabel: t('overridden'),
    resetLabel: t('reset'),
    invalidLabel: t('ttsInvalid'),
    disabled,
    onReset: () => { props.resetField(field) },
    onEdit: (text: string) => { props.edit(field, text) },
  })
  const text = (field: 'shiftTime' | 'timeZone' | 'notifyTo' | 'region' | 'voiceProvider' | 'voice' | 'voiceStyle') => (
    <SettingsValueField id={`plugin-config-tts-${field}`} label={t(`tts.${field}`)} hint={t(`tts.${field}.hint`)} {...state.strings[field]} {...common(field)} />
  )
  const secret = (field: 'socialCrawlApiKey' | 'groqApiKey', saved: boolean | undefined) => (
    <SettingsSecretField
      id={`plugin-config-tts-${field}`}
      label={t(`tts.${field}`)}
      hint={t(`tts.${field}.hint`)}
      disabled={disabled}
      text={state.secrets[field].text}
      configured={saved === true}
      stateLabel={saved === true ? t('scoutSecretSet') : t('scoutSecretUnset')}
      onEdit={(value) => { props.edit(field, value) }}
    />
  )
  return (
    <SettingsForm labels={formLabels(t)} state={state} onSave={props.save} onDiscard={props.discard}>
      <StatusBlock t={t} live={live} onRun={props.runNow} onPause={props.pause} onResume={props.resume} onRefresh={props.refreshStatus} />
      <div>
        <p><strong>{t('tts.enabled')}</strong></p>
        <Switch
          label={t('tts.enabled')}
          title={t('tts.enabled.hint')}
          checked={state.enabled.text === 'true'}
          disabled={disabled}
          onChange={(next) => { props.edit('enabled', next ? 'true' : 'false') }}
        />
        <p>{t('tts.enabled.hint')}</p>
      </div>
      {secret('socialCrawlApiKey', live.status?.dataKey)}
      {text('shiftTime')}
      {text('timeZone')}
      {text('notifyTo')}
      {TTS_NUMBER_FIELDS.map(field => (
        <SettingsValueField key={field} id={`plugin-config-tts-${field}`} label={t(`tts.${field}`)} hint={t(`tts.${field}.hint`)} numeric {...state.numbers[field]} {...common(field)} />
      ))}
      {TTS_LIST_FIELDS.map(field => (
        <SettingsValueField key={field} id={`plugin-config-tts-${field}`} label={t(`tts.${field}`)} hint={t(`tts.${field}.hint`)} multiline {...state.lists[field]} {...common(field)} />
      ))}
      {text('region')}
      {text('voiceProvider')}
      {secret('groqApiKey', live.status?.groqKey)}
      {text('voice')}
      {text('voiceStyle')}
      {TTS_MODEL_PAIRS.map(pair => (
        <ScoutModelPicker
          key={pair.key}
          labels={{
            label: t(`tts.${pair.key}`),
            hint: t(`tts.${pair.key}.hint`),
            search: t('scoutModelSearch'),
            none: t(`tts.${pair.key}.none`),
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
