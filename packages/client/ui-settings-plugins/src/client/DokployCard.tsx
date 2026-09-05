/** The Dokploy plugin's card: the servers the agent may query and deploy through. */

import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { ValueField } from './fields.tsx'
import { PluginCard } from './PluginCard.tsx'
import type { DokployCardFace } from './dokploy-card-controller.ts'
import type {} from './slot-contract.ts'

/** Props the renderer binds for the Dokploy card. */
export type DokployCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.plugins'>
  & InjectFace<DokployCardFace>

/**
 * Render the Dokploy card: one JSON block listing the servers, each a name, a
 * URL, and the environment variable that holds its API key.
 * @param props - locale copy, the card snapshot, and its form actions.
 * @returns the card.
 */
export function DokployCard(props: DokployCardProps) {
  const { t } = props
  const state = props.useDokployCard(snapshot => snapshot)
  const disabled = !state.writable
  return (
    <PluginCard
      t={t}
      titleKey="dokployTitle"
      descriptionKey="dokployDescription"
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
    >
      <ValueField
        id="plugin-config-dokploy-servers"
        label={t('dokployServers')}
        hint={t('dokployServersHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('dokployInvalid')}
        multiline
        placeholder={t('dokployServersPlaceholder')}
        disabled={disabled}
        {...state.servers}
        onEdit={(text) => { props.edit('servers', text) }}
        onReset={() => { props.resetField('servers') }}
      />
    </PluginCard>
  )
}
