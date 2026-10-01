/** The ads employee's card: its daily shift and the spending limits every proposal and the hourly watcher are held to. */

import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { Button, SettingsForm, SettingsValueField, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { formLabels } from './locales.ts'
import { ADS_NUMBER_FIELDS, type AdsAccountState, type AdsCardFace, type AdsCardState } from './ads-card-controller.ts'
import css from './scout.module.css'
import seoCss from './seo.module.css'

/** Props the renderer binds for the ads employee card. */
export type AdsCardProps =
  PropsRuntime<'plugins.item'>
  & PropsLocale<'settings.operations'>
  & InjectFace<AdsCardFace>

type Translate = AdsCardProps['t']

/**
 * Which Ads account the campaigns run in, and how it was chosen.
 * @param t - locale copy.
 * @param state - the Host's report, or why it is missing.
 * @returns the status line.
 */
function accountLine(t: Translate, state: AdsAccountState): string {
  const account = state.account
  if (account === undefined) return state.failed ? t('adsAccountUnknown') : t('adsAccountLoading')
  switch (account.source) {
    case 'configured': return t('adsAccountConfigured', { id: account.id ?? '' })
    case 'found': return account.name === '' || account.name === account.id
      ? t('adsAccountFoundUnnamed', { id: account.id ?? '' })
      : t('adsAccountFound', { id: account.id ?? '', name: account.name })
    case 'error': return t('adsAccountLookupFailed', { error: account.error ?? '' })
    case 'none': return t('adsAccountNone')
  }
}

/**
 * Render the ads employee card.
 * @param props - locale copy, the card and Ads account snapshots, and the actions.
 * @returns the card.
 */
export function AdsCard(props: AdsCardProps) {
  const { t } = props
  const state: AdsCardState = props.useAdsCard(snapshot => snapshot)
  const account = props.useAdsAccount(snapshot => snapshot)
  if (props.view === 'summary') return t('adsDescription')
  const disabled = !state.writable
  const common = (field: string) => ({
    overriddenLabel: t('overridden'),
    resetLabel: t('reset'),
    invalidLabel: t('adsInvalid'),
    disabled,
    onReset: () => { props.resetField(field) },
    onEdit: (text: string) => { props.edit(field, text) },
  })
  const switchField = (field: 'adsEnabled' | 'adsRequireConversionTracking') => (
    <div>
      <p><strong>{t(`ads.${field}`)}</strong></p>
      <Switch
        label={t(`ads.${field}`)}
        title={t(`ads.${field}.hint`)}
        checked={state.switches[field].text === 'true'}
        disabled={disabled}
        onChange={(next) => { props.edit(field, next ? 'true' : 'false') }}
      />
      <p>{t(`ads.${field}.hint`)}</p>
    </div>
  )
  const known = account.account !== undefined && account.account.source !== 'none' && account.account.source !== 'error'
  return (
    <SettingsForm labels={formLabels(t)} state={state} onSave={props.save} onDiscard={props.discard}>
      <p><Button variant="outline" size="sm" onClick={props.openProposals}>{t('adsOpenProposals')}</Button></p>
      <div className={css.picker}>
        <span className={css.pickerLabel}>{t('adsAccountTitle')}</span>
        <p className={known ? css.pickerValue : css.pickerUnknown} role="status">{accountLine(t, account)}</p>
        <p className={css.pickerHint}>{t('adsCurrencyNote')}</p>
        <p className={css.pickerHint}>{t('adsAccountWhere')}</p>
        <div className={seoCss.row}>
          <Button variant="ghost" size="sm" onClick={props.refreshStatus}>{t('adsRefresh')}</Button>
        </div>
      </div>
      {switchField('adsEnabled')}
      <SettingsValueField id="plugin-config-ads-adsShiftTime" label={t('ads.adsShiftTime')} hint={t('ads.adsShiftTime.hint')}
        {...state.shiftTime} {...common('adsShiftTime')} />
      {ADS_NUMBER_FIELDS.map(field => (
        <SettingsValueField key={field} id={`plugin-config-ads-${field}`} label={t(`ads.${field}`)} hint={t(`ads.${field}.hint`)} numeric
          {...state.numbers[field]} {...common(field)} />
      ))}
      {switchField('adsRequireConversionTracking')}
    </SettingsForm>
  )
}
