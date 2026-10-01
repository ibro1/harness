/** The SEO employee plugin's card: the daily shift, its models, and the Google and Keyword Planner credentials. */

import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { Button, SettingsForm, SettingsSecretField, SettingsValueField, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { useEffect, useState } from 'react'
import { formLabels } from './locales.ts'
import { ScoutModelPicker } from './ScoutModelPicker.tsx'
import { SEO_MODEL_PAIRS, SEO_NUMBER_FIELDS, type SeoCardFace, type SeoCardState, type SeoGoogleState } from './seo-card-controller.ts'
import type { SeoGoogleStatus } from './seo-sites-model.ts'
import css from './scout.module.css'
import seoCss from './seo.module.css'

/** Props the renderer binds for the SEO employee card. */
export type SeoCardProps =
  PropsRuntime<'plugins.item'>
  & PropsLocale<'settings.operations'>
  & InjectFace<SeoCardFace>

type Translate = SeoCardProps['t']

/**
 * The Google block's status line and the redirect address to register.
 * @param props - locale copy, the Host's status, and the connect actions.
 * @returns the block.
 */
function GoogleStatus(props: {
  t: Translate
  google: SeoGoogleState
  disabled: boolean
  onConnect: () => void
  onDisconnect: () => void
  onRefresh: () => void
}) {
  const { t, google } = props
  const [copied, setCopied] = useState(false)
  const status = google.status
  return (
    <div className={css.picker}>
      <span className={css.pickerLabel}>{t('seoGoogleTitle')}</span>
      {status === undefined
        ? <p className={css.pickerHint} role="status">{google.failed ? t('seoGoogleUnknown') : t('seoGoogleLoading')}</p>
        : (
          <>
            {status.serviceAccount === null
              ? (
                <p className={status.connected ? css.pickerValue : css.pickerUnknown} role="status">
                  {status.connected
                    ? t('seoGoogleConnected', { date: (status.connectedAt ?? '').slice(0, 16).replace('T', ' ') })
                    : status.clientSet ? t('seoGoogleNotConnected') : t('seoGoogleNotSetUp')}
                </p>
              )
              : (
                <p className={status.serviceAccount.email === null ? css.pickerUnknown : css.pickerValue} role="status">
                  {status.serviceAccount.email === null
                    ? t('seoGoogleServiceAccountBad', { error: status.serviceAccount.error ?? '' })
                    : t('seoGoogleServiceAccount', { email: status.serviceAccount.email })}
                </p>
              )}
            {status.redirectUri === ''
              ? null
              : (
                <>
                  <p className={css.pickerHint}>{t('seoGoogleRedirect')}</p>
                  <div className={css.pickerCurrent}>
                    <code className={css.pickerValue}>{status.redirectUri}</code>
                    <Button variant="outline" size="sm" onClick={() => {
                      void navigator.clipboard.writeText(status.redirectUri).then(() => { setCopied(true) }, () => undefined)
                    }}>{copied ? t('seoCopied') : t('seoCopy')}</Button>
                  </div>
                </>
              )}
          </>
        )}
      <div className={seoCss.row}>
        <Button variant="outline" size="sm" disabled={props.disabled || status?.clientSet !== true} onClick={props.onConnect}>
          {status?.connected === true ? t('seoGoogleReconnect') : t('seoGoogleConnect')}
        </Button>
        {status?.connected === true
          ? <Button variant="ghost" size="sm" disabled={props.disabled} onClick={props.onDisconnect}>{t('seoGoogleDisconnect')}</Button>
          : null}
        <Button variant="ghost" size="sm" onClick={props.onRefresh}>{t('seoRefresh')}</Button>
      </div>
      <p className={css.pickerHint}>{t('seoGoogleConnectHint')}</p>
      {google.actionError === undefined ? null : <p className={css.pickerUnknown} role="status">{t('seoGoogleDisconnectFailed', { error: google.actionError })}</p>}
    </div>
  )
}

/**
 * The configured badge of a write-only field, from the Host's report of whether it is saved.
 * @param t - locale copy.
 * @param saved - whether the Host reports the secret saved; undefined until the status is read.
 * @returns whether the field counts as configured, and the badge copy.
 */
function secretBadge(t: Translate, saved: boolean | undefined): { configured: boolean; stateLabel: string } {
  return saved === true ? { configured: true, stateLabel: t('seoSecretSaved') } : { configured: false, stateLabel: t('seoSecretUnset') }
}

/**
 * Which Ads account Keyword Planner runs in, and how it was chosen.
 * @param t - locale copy.
 * @param ads - the Host's report.
 * @returns the status line.
 */
function adsLine(t: Translate, ads: SeoGoogleStatus['adsAccount']): string {
  switch (ads.source) {
    case 'configured': return t('seoAdsConfigured', { id: ads.id ?? '' })
    case 'found': return ads.name === '' || ads.name === ads.id
      ? t('seoAdsFoundUnnamed', { id: ads.id ?? '' })
      : t('seoAdsFound', { id: ads.id ?? '', name: ads.name })
    case 'error': return t('seoAdsLookupFailed', { error: ads.error ?? '' })
    case 'none': return t('seoAdsNoneFound', { seen: ads.seen === '' || ads.seen === 'none' ? t('seoAdsNoAccounts') : ads.seen })
  }
}

/**
 * Render the SEO employee card.
 * @param props - locale copy, the card, model and Google snapshots, and the actions.
 * @returns the card.
 */
export function SeoCard(props: SeoCardProps) {
  const { t } = props
  const state: SeoCardState = props.useSeoCard(snapshot => snapshot)
  const models = props.useSeoModels(snapshot => snapshot)
  const google = props.useSeoGoogle(snapshot => snapshot)
  const { refreshStatus } = props
  // Coming back from Google's consent window: read the connection again.
  useEffect(() => {
    const onFocus = (): void => { refreshStatus() }
    window.addEventListener('focus', onFocus)
    return () => { window.removeEventListener('focus', onFocus) }
  }, [refreshStatus])
  if (props.view === 'summary') return t('seoDescription')
  const disabled = !state.writable
  const common = (field: string) => ({
    overriddenLabel: t('overridden'),
    resetLabel: t('reset'),
    invalidLabel: t('seoInvalid'),
    disabled,
    onReset: () => { props.resetField(field) },
    onEdit: (text: string) => { props.edit(field, text) },
  })
  const stringField = (field: 'shiftTime' | 'timeZone' | 'notifyTo' | 'googleClientId' | 'adsLoginCustomerId' | 'adsCustomerId' | 'adsApiVersion') => (
    <SettingsValueField id={`plugin-config-seo-${field}`} label={t(`seo.${field}`)} hint={t(`seo.${field}.hint`)} {...state.strings[field]} {...common(field)} />
  )
  const clientSecret = secretBadge(t, google.status?.clientSecretSet)
  const adsToken = secretBadge(t, google.status?.developerTokenSet)
  return (
    <SettingsForm labels={formLabels(t)} state={state} onSave={props.save} onDiscard={props.discard}>
      <p><Button variant="outline" size="sm" onClick={props.openSites}>{t('seoOpenSites')}</Button></p>
      <div>
        <p><strong>{t('seo.enabled')}</strong></p>
        <Switch
          label={t('seo.enabled')}
          title={t('seo.enabled.hint')}
          checked={state.enabled.text === 'true'}
          disabled={disabled}
          onChange={(next) => { props.edit('enabled', next ? 'true' : 'false') }}
        />
        <p>{t('seo.enabled.hint')}</p>
      </div>
      {stringField('shiftTime')}
      {stringField('timeZone')}
      {stringField('notifyTo')}
      {SEO_MODEL_PAIRS.map(pair => (
        <ScoutModelPicker
          key={pair.key}
          labels={{
            label: t(`seo.${pair.key}`),
            hint: t(`seo.${pair.key}.hint`),
            search: t('scoutModelSearch'),
            none: t(`seo.${pair.key}.none`),
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
      {SEO_NUMBER_FIELDS.map(field => (
        <SettingsValueField key={field} id={`plugin-config-seo-${field}`} label={t(`seo.${field}`)} hint={t(`seo.${field}.hint`)} numeric {...state.numbers[field]} {...common(field)} />
      ))}
      <GoogleStatus t={t} google={google} disabled={disabled}
        onConnect={props.connectGoogle} onDisconnect={props.disconnectGoogle} onRefresh={props.refreshStatus} />
      <SettingsSecretField
        id="plugin-config-seo-googleServiceAccountKey"
        label={t('seo.googleServiceAccountKey')}
        hint={t('seo.googleServiceAccountKey.hint')}
        disabled={disabled}
        text={state.secrets.googleServiceAccountKey.text}
        {...secretBadge(t, google.status === undefined ? undefined : google.status.serviceAccount !== null)}
        onEdit={(text) => { props.edit('googleServiceAccountKey', text) }}
      />
      {google.status?.serviceAccount === null || google.status?.serviceAccount === undefined
        ? null
        : <p><Button variant="ghost" size="sm" disabled={disabled} onClick={props.removeServiceAccount}>{t('seoRemoveServiceAccount')}</Button></p>}
      {stringField('googleClientId')}
      <SettingsSecretField
        id="plugin-config-seo-googleClientSecret"
        label={t('seo.googleClientSecret')}
        hint={t('seo.googleClientSecret.hint')}
        disabled={disabled}
        text={state.secrets.googleClientSecret.text}
        {...clientSecret}
        onEdit={(text) => { props.edit('googleClientSecret', text) }}
      />
      <div className={css.picker}>
        <span className={css.pickerLabel}>{t('seoAdsTitle')}</span>
        {google.status === undefined
          ? null
          : <p className={google.status.adsSet ? css.pickerValue : css.pickerUnknown} role="status">{adsLine(t, google.status.adsAccount)}</p>}
        {google.status === undefined || google.status.adsAccount.source === 'configured'
          ? null
          : (
            <p>
              <Button variant="outline" size="sm" disabled={google.adsChecking} onClick={props.recheckAds}>
                {google.adsChecking ? t('seoAdsChecking') : t('seoAdsRecheck')}
              </Button>
              {google.adsCheckedAt === undefined || google.adsChecking
                ? null
                : <span className={css.pickerHint}>{` ${t('seoAdsCheckedAt', { time: new Date(google.adsCheckedAt).toLocaleTimeString() })}`}</span>}
            </p>
          )}
      </div>
      <SettingsSecretField
        id="plugin-config-seo-adsDeveloperToken"
        label={t('seo.adsDeveloperToken')}
        hint={t('seo.adsDeveloperToken.hint')}
        disabled={disabled}
        text={state.secrets.adsDeveloperToken.text}
        {...adsToken}
        onEdit={(text) => { props.edit('adsDeveloperToken', text) }}
      />
      {stringField('adsLoginCustomerId')}
      {stringField('adsCustomerId')}
      {stringField('adsApiVersion')}
    </SettingsForm>
  )
}
