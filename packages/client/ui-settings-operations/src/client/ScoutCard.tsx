/** The Klipara Scout plugin's card: the daily shift's switch, caps, targets and credentials. */

import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { Button, SettingsForm, SettingsValueField, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { formLabels } from './locales.ts'
import { SCOUT_NUMBER_FIELDS, SCOUT_SWITCH_FIELDS, SCOUT_TEXT_FIELDS, type ScoutCardFace } from './scout-card-controller.ts'

/** Props the renderer binds for the Klipara Scout card. */
export type ScoutCardProps =
  PropsRuntime<'plugins.item'>
  & PropsLocale<'settings.operations'>
  & InjectFace<ScoutCardFace>

/**
 * Render the Klipara Scout card: the on/off switch, then the shift, caps,
 * targets and credentials, with a link to the leads page.
 * @param props - locale copy, the card snapshot, and its form actions.
 * @returns the card.
 */
export function ScoutCard(props: ScoutCardProps) {
  const { t } = props
  const state = props.useScoutCard(snapshot => snapshot)
  if (props.view === 'summary') return t('scoutDescription')
  const disabled = !state.writable
  const common = (field: string) => ({
    overriddenLabel: t('overridden'),
    resetLabel: t('reset'),
    invalidLabel: t('scoutInvalid'),
    disabled,
    onReset: () => { props.resetField(field) },
    onEdit: (text: string) => { props.edit(field, text) },
  })
  return (
    <SettingsForm labels={formLabels(t)} state={state} onSave={props.save} onDiscard={props.discard}>
      <p><Button variant="outline" size="sm" onClick={props.openLeads}>{t('scoutViewLeads')}</Button></p>
      {SCOUT_SWITCH_FIELDS.map(field => (
        <div key={field}>
          <p><strong>{t(`scout.${field}`)}</strong></p>
          <Switch
            label={t(`scout.${field}`)}
            title={t(`scout.${field}.hint`)}
            checked={state.switches[field].text === 'true'}
            disabled={disabled}
            onChange={(next) => { props.edit(field, next ? 'true' : 'false') }}
          />
          <p>{t(`scout.${field}.hint`)}</p>
        </div>
      ))}
      {SCOUT_NUMBER_FIELDS.map(field => (
        <SettingsValueField key={field} id={`plugin-config-scout-${field}`} label={t(`scout.${field}`)} hint={t(`scout.${field}.hint`)} numeric {...state.numbers[field]} {...common(field)} />
      ))}
      <SettingsValueField id="plugin-config-scout-topics" label={t('scout.topics')} hint={t('scout.topics.hint')} multiline {...state.topics} {...common('topics')} />
      {SCOUT_TEXT_FIELDS.map(field => (
        <SettingsValueField key={field} id={`plugin-config-scout-${field}`} label={t(`scout.${field}`)} hint={t(`scout.${field}.hint`)} {...state.text[field]} {...common(field)} />
      ))}
    </SettingsForm>
  )
}
