/** The Cloudflare plugin's card: the zones the agent may purge and edit DNS on. */

import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { ValueField } from './fields.tsx'
import { PluginCard } from './PluginCard.tsx'
import type { CloudflareCardFace } from './cloudflare-card-controller.ts'
import type {} from './slot-contract.ts'

/** Props the renderer binds for the Cloudflare card. */
export type CloudflareCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.plugins'>
  & InjectFace<CloudflareCardFace>

/**
 * Render the Cloudflare card: one JSON block listing the zones, each a name, a
 * zone id, and either the environment variable holding its API token or the
 * token itself — and a second, optional block holding the account credential
 * that creating a zone needs.
 * @param props - locale copy, the card snapshot, and its form actions.
 * @returns the card.
 */
export function CloudflareCard(props: CloudflareCardProps) {
  const { t } = props
  const state = props.useCloudflareCard(snapshot => snapshot)
  const disabled = !state.writable
  return (
    <PluginCard
      t={t}
      titleKey="cloudflareTitle"
      descriptionKey="cloudflareDescription"
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
    >
      <ValueField
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
      <ValueField
        id="plugin-config-cloudflare-account"
        label={t('cloudflareAccount')}
        hint={t('cloudflareAccountHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('cloudflareAccountInvalid')}
        multiline
        placeholder={t('cloudflareAccountPlaceholder')}
        disabled={disabled}
        {...state.account}
        onEdit={(text) => { props.edit('account', text) }}
        onReset={() => { props.resetField('account') }}
      />
    </PluginCard>
  )
}
