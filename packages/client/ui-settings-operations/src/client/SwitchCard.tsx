/**
 * The card of a deployment plugin that has only an on/off switch (PSD tools,
 * page capture, the CLI routes): whether it is on, whether it can work, the
 * facts it reports, and its own test. Everything comes from the Host's
 * `/plugin-switch/<id>` routes; the card keeps no state of its own.
 */

import { useCallback, useEffect, useState } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { Button, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { SWITCH_FACTS, type SwitchFactKey, type SwitchId } from './locales/switches.ts'
import css from './scout.module.css'

/** One fact as the Host reports it. */
type Fact = { key: string; value: string } | { key: string; flag: boolean }

/** The answer to `GET /plugin-switch/<id>`. */
export interface SwitchStatus {
  id: string
  enabled: boolean
  healthy: boolean
  facts: Fact[]
  problem?: string
  canTest: boolean
}

/** The face each card's slot entry injects: which plugin it shows. */
export interface SwitchCardFace {
  switchId: SwitchId
}

/** Props the renderer binds for a switch card. */
export type SwitchCardProps =
  PropsRuntime<'plugins.item'>
  & PropsLocale<'settings.operations'>
  & InjectFace<SwitchCardFace>

/**
 * Whether the Host composes a plugin: only a JSON answer from its status route counts, since a path no route
 * claims answers 404 or with the web app's HTML.
 * @param id - the plugin's switch id.
 * @returns true when `GET /plugin-switch/<id>` answers JSON.
 */
export async function hostServesSwitch(id: SwitchId): Promise<boolean> {
  try {
    const response = await fetch(`/plugin-switch/${id}`, { cache: 'no-store', credentials: 'same-origin' })
    return response.ok && (response.headers.get('content-type') ?? '').includes('application/json')
  } catch (_error) {
    // No answer reads as no plugin; its card is simply not listed.
    return false
  }
}

function isFactKey(key: string): key is SwitchFactKey {
  return (SWITCH_FACTS as readonly string[]).includes(key)
}

/**
 * Render a switch card.
 * @param props - locale copy and the plugin id.
 * @returns the summary line or the card body.
 */
export function SwitchCard(props: SwitchCardProps) {
  // The summary must not mount the page's requests, so the two views are separate components.
  return props.view === 'summary' ? props.t(`switch.${props.switchId}.description`) : <SwitchCardPage {...props} />
}

type TestState = { state: 'idle' | 'running' } | { state: 'done'; ok: boolean; message: string }

/**
 * The card body.
 * @param props - locale copy and the plugin id.
 * @returns the body.
 */
function SwitchCardPage({ t, switchId }: SwitchCardProps) {
  const [status, setStatus] = useState<SwitchStatus | undefined>(undefined)
  const [failed, setFailed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | undefined>(undefined)
  const [test, setTest] = useState<TestState>({ state: 'idle' })
  const path = `/plugin-switch/${switchId}`

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(path, { cache: 'no-store', credentials: 'same-origin' })
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
      setStatus(await response.json() as SwitchStatus)
      setFailed(false)
    } catch (_error) {
      // The plugin went away or the sign-in expired: the card says the status is unknown.
      setFailed(true)
    }
  }, [path])

  useEffect(() => { void refresh() }, [refresh])

  const toggle = async (enabled: boolean) => {
    setSaving(true)
    setSaveError(undefined)
    try {
      const response = await fetch(path, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }),
      })
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
      setStatus(await response.json() as SwitchStatus)
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  const runTest = async () => {
    setTest({ state: 'running' })
    try {
      const response = await fetch(`${path}/test`, { method: 'POST', credentials: 'same-origin' })
      const body = await response.json() as { ok?: boolean; message?: string; error?: string }
      setTest({ state: 'done', ok: response.ok && body.ok === true, message: body.message ?? body.error ?? `HTTP ${String(response.status)}` })
    } catch (error) {
      setTest({ state: 'done', ok: false, message: error instanceof Error ? error.message : String(error) })
    }
    void refresh()
  }

  if (status === undefined) {
    return <p className={css.pickerHint}>{failed ? t('switchUnknown') : t('switchLoading')}</p>
  }

  const factValue = (fact: Fact): string => {
    if ('flag' in fact) return fact.flag ? t('switchYes') : t('switchNo')
    if (fact.key === 'lastCall' && fact.value === '') return t('switchNever')
    return fact.value
  }

  return (
    <div className={css.picker}>
      <div className={css.pickerCurrent}>
        <Switch checked={status.enabled} disabled={saving} label={t('switchLabel')} onChange={(next) => { void toggle(next) }} />
        <span className={css.pickerValue} role="status">
          {status.enabled ? t('switchOn') : t('switchOff')}
          {' · '}
          {status.healthy ? t('switchHealthy') : `${t('switchProblem')} ${status.problem ?? ''}`}
        </span>
      </div>
      {saveError === undefined ? null : <p className={css.pickerUnknown} role="status">{t('switchSaveFailed')} {saveError}</p>}
      {status.enabled ? null : <p className={css.pickerHint}>{t(`switch.${switchId}.off`)}</p>}
      {status.facts.filter(fact => isFactKey(fact.key)).map(fact => (
        <p key={fact.key} className={css.pickerHint}>
          <span className={css.pickerLabel}>{isFactKey(fact.key) ? t(`switch.fact.${fact.key}`) : ''}</span>{' '}
          {factValue(fact)}
        </p>
      ))}
      <div className={css.pickerCurrent}>
        {status.canTest
          ? (
            <Button variant="outline" size="sm" disabled={test.state === 'running' || !status.enabled} onClick={() => { void runTest() }}>
              {test.state === 'running' ? t('switchTesting') : t('switchTest')}
            </Button>
          )
          : null}
        <Button variant="ghost" size="sm" onClick={() => { void refresh() }}>{t('switchRefresh')}</Button>
      </div>
      {test.state === 'done'
        ? <p className={test.ok ? css.pickerHint : css.pickerUnknown} role="status">{test.ok ? t('switchTestOk') : t('switchTestFailed')} {test.message}</p>
        : null}
    </div>
  )
}
