/** The Postgres plugin's card: the databases the agent may read, and which of them it may write. */

import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { SettingsForm, SettingsValueField } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { formLabels } from './locales.ts'
import type { PostgresCardFace } from './postgres-card-controller.ts'

/** Props the renderer binds for the Postgres card. */
export type PostgresCardProps =
  PropsRuntime<'plugins.item'>
  & PropsLocale<'settings.operations'>
  & InjectFace<PostgresCardFace>

/**
 * Render the Postgres card: one JSON block listing the databases, each a name
 * and either the environment variable holding its connection string or the
 * connection string itself.
 * @param props - locale copy, the card snapshot, and its form actions.
 * @returns the card.
 */
export function PostgresCard(props: PostgresCardProps) {
  const { t } = props
  const state = props.usePostgresCard(snapshot => snapshot)
  if (props.view === 'summary') return t('postgresDescription')
  const disabled = !state.writable
  return (
    <SettingsForm labels={formLabels(t)} state={state} onSave={props.save} onDiscard={props.discard}>
      <SettingsValueField
        id="plugin-config-postgres-databases"
        label={t('postgresDatabases')}
        hint={t('postgresDatabasesHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('postgresInvalid')}
        multiline
        placeholder={t('postgresDatabasesPlaceholder')}
        disabled={disabled}
        {...state.databases}
        onEdit={(text) => { props.edit('databases', text) }}
        onReset={() => { props.resetField('databases') }}
      />
    </SettingsForm>
  )
}
