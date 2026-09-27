/** The Cloudflare plugin's card: the zones the agent may purge and edit DNS on. */

import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { SettingsForm, SettingsValueField } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { formLabels } from './locales.ts'
import type { CloudflareCardFace } from './cloudflare-card-controller.ts'

/** Props the renderer binds for the Cloudflare card. */
export type CloudflareCardProps =
  PropsRuntime<'plugins.item'>
  & PropsLocale<'settings.operations'>
  & InjectFace<CloudflareCardFace>

/**
 * Render the Cloudflare card: one JSON block listing the zones, each a name, a
 * zone id, and either the environment variable holding its API token or the
 * token itself — and a second, optional block listing the account credentials
 * that creating a zone needs.
 * @param props - locale copy, the card snapshot, and its form actions.
 * @returns the card.
 */
export function CloudflareCard(props: CloudflareCardProps) {
  const { t } = props
  const state = props.useCloudflareCard(snapshot => snapshot)
  if (props.view === 'summary') return t('cloudflareDescription')
  const disabled = !state.writable
  return (
    <SettingsForm labels={formLabels(t)} state={state} onSave={props.save} onDiscard={props.discard}>
      <SettingsValueField
        id="plugin-config-cloudflare-zones"
        label={t('cloudflareZones')}
        hint={t('cloudflareZonesHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('cloudflareInvalid')}
        multiline
        placeholder={t('cloudflareZonesPlaceholder')}
        disabled={disabled}
        {...state.zones}
        onEdit={(text) => { props.edit('zones', text) }}
        onReset={() => { props.resetField('zones') }}
      />
      <SettingsValueField
        id="plugin-config-cloudflare-accounts"
        label={t('cloudflareAccounts')}
        hint={t('cloudflareAccountsHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('cloudflareAccountsInvalid')}
        multiline
        placeholder={t('cloudflareAccountsPlaceholder')}
        disabled={disabled}
        {...state.accounts}
        onEdit={(text) => { props.edit('accounts', text) }}
        onReset={() => { props.resetField('accounts') }}
      />
    </SettingsForm>
  )
}
