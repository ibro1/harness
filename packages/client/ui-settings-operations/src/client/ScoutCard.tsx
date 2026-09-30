/** The Klipara Scout plugin's card: the daily shift's switch, caps, targets and credentials. */

import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { Button, SettingsForm, SettingsValueField, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { formLabels } from './locales.ts'
import { useState } from 'react'
import { ScoutModelPicker } from './ScoutModelPicker.tsx'
import {
  SCOUT_KEY_FIELD, SCOUT_MODEL_PAIRS, SCOUT_NUMBER_FIELDS, SCOUT_SWITCH_FIELDS, SCOUT_TEXT_FIELDS, type ScoutCardFace,
} from './scout-card-controller.ts'

/** Fields rendered by a picker or the masked key rather than as plain text. */
const SPECIAL_FIELDS = new Set<string>([SCOUT_KEY_FIELD, ...SCOUT_MODEL_PAIRS.flatMap(pair => [pair.provider, pair.model])])

/**
 * A key with all but its prefix and last four characters hidden.
 * @param key - the stored key.
 * @returns the masked text.
 */
export function maskKey(key: string): string {
  if (key.length <= 8) return '•'.repeat(key.length)
  const prefix = /^[a-z]+_[a-z]+_[a-z]+_/iu.exec(key)?.[0] ?? key.slice(0, 4)
  return `${prefix}${'•'.repeat(12)}${key.slice(-4)}`
}

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
  const models = props.useScoutModels(snapshot => snapshot)
  // Changing the key types into a fresh draft; the stored key is kept while it is blank.
  const [newKey, setNewKey] = useState<{ saved: string; text: string } | undefined>(undefined)
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
      {SCOUT_TEXT_FIELDS.filter(field => !SPECIAL_FIELDS.has(field)).map(field => (
        <SettingsValueField key={field} id={`plugin-config-scout-${field}`} label={t(`scout.${field}`)} hint={t(`scout.${field}.hint`)} {...state.text[field]} {...common(field)} />
      ))}
      {newKey !== undefined || state.text[SCOUT_KEY_FIELD].text === ''
        ? (
          <>
            <SettingsValueField id={`plugin-config-scout-${SCOUT_KEY_FIELD}`} label={t(`scout.${SCOUT_KEY_FIELD}`)} hint={t(`scout.${SCOUT_KEY_FIELD}.hint`)}
              placeholder={t('scoutKeyPlaceholder')} {...state.text[SCOUT_KEY_FIELD]} {...common(SCOUT_KEY_FIELD)}
              {...newKey === undefined ? {} : {
                text: newKey.text,
                onEdit: (text: string) => {
                  setNewKey({ ...newKey, text })
                  props.edit(SCOUT_KEY_FIELD, text.trim() === '' ? newKey.saved : text)
                },
              }} />
            {newKey === undefined
              ? null
              : (
                <p>
                  <Button variant="outline" size="sm" onClick={() => { props.edit(SCOUT_KEY_FIELD, newKey.saved); setNewKey(undefined) }}>{t('scoutKeepKey')}</Button>
                </p>
              )}
          </>
        )
        : (
          <>
            <SettingsValueField id={`plugin-config-scout-${SCOUT_KEY_FIELD}`} label={t(`scout.${SCOUT_KEY_FIELD}`)} hint={t(`scout.${SCOUT_KEY_FIELD}.hint`)}
              {...state.text[SCOUT_KEY_FIELD]} {...common(SCOUT_KEY_FIELD)} text={maskKey(state.text[SCOUT_KEY_FIELD].text)} disabled />
            <p>
              <Button variant="outline" size="sm" disabled={disabled}
                onClick={() => { setNewKey({ saved: state.text[SCOUT_KEY_FIELD].text, text: '' }) }}>{t('scoutChangeKey')}</Button>
            </p>
          </>
        )}
      {SCOUT_MODEL_PAIRS.map(pair => (
        <ScoutModelPicker
          key={pair.key}
          labels={{
            label: t(`scout.${pair.key}`),
            hint: t(`scout.${pair.key}.hint`),
            search: t('scoutModelSearch'),
            none: t(`scout.${pair.key}.none`),
            change: t('scoutModelChange'),
            loading: t('scoutModelLoading'),
            failed: t('scoutModelFailed'),
            retry: t('scoutModelRetry'),
            noMatch: t('scoutModelNoMatch'),
            unknown: t('scoutModelUnknown'),
          }}
          catalog={models}
          provider={state.text[pair.provider].text}
          model={state.text[pair.model].text}
          disabled={disabled}
          onPick={(provider, model) => { props.edit(pair.provider, provider); props.edit(pair.model, model) }}
          onRetry={props.retryModels}
        />
      ))}
    </SettingsForm>
  )
}
