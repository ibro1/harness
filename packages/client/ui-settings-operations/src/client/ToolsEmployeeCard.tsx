/**
 * The tools employee's card: status and actions, the site's deploy state, the shortlist awaiting approval, the
 * published tools, AdSense readiness and Search Console, then the settings as a form — the weekly day and time, seed
 * topics and markets edited row by row, the weekly limits, the Google and site settings and the models.
 */

import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { Button, SettingsForm, SettingsSecretField, SettingsValueField, Switch, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { formLabels } from './locales.ts'
import { ScoutModelPicker } from './ScoutModelPicker.tsx'
import {
  TOOLS_LIST_FIELDS, TOOLS_MODEL_PAIRS, TOOLS_WEEKDAYS, type ToolsCardFace, type ToolsLiveState, type ToolsStatus,
} from './tools-card-controller.ts'
import { ListEditor } from './YouTubeNicheScoutCard.tsx'
import picker from './scout.module.css'
import css from './seo.module.css'

/** Props the renderer binds for the card. */
export type ToolsEmployeeCardProps =
  PropsRuntime<'plugins.item'>
  & PropsLocale<'settings.operations'>
  & InjectFace<ToolsCardFace>

type Translate = ToolsEmployeeCardProps['t']

/**
 * The site's deploy state, its live link and whether the employee can push to it.
 * @returns the block.
 */
function ToolsSiteBlock(props: { t: Translate; site: ToolsStatus['site'] }) {
  const { t, site } = props
  const none = t('toolsSiteNoVersion')
  return (
    <div className={css.card}>
      <p className={css.cardTitle}><strong>{t('toolsSiteTitle')}</strong></p>
      <p className={site.state === 'live' ? css.ok : css.state}>{t(`toolsSiteState.${site.state}`)}</p>
      {site.detail === '' ? null : <p className={css.hint}>{site.detail}</p>}
      <p className={css.link}><a href={site.url} target="_blank" rel="noreferrer">{site.url}</a></p>
      {site.liveVersion === null && site.localVersion === null
        ? null
        : <p className={css.hint}>{t('toolsSiteVersions', { live: site.liveVersion ?? none, local: site.localVersion ?? none })}</p>}
      {site.checkedAt === null
        ? null
        : <p className={css.hint}>{t('toolsSiteChecked', { date: site.checkedAt.slice(0, 16).replace('T', ' ') })}</p>}
      {site.pushReady
        ? <p className={css.ok}>{t('toolsPushReady', { repo: site.repo })}</p>
        : <p className={css.error}>{site.repo === '' ? t('toolsPushNoRepo') : t('toolsPushNotReady', { detail: site.pushDetail })}</p>}
      <p className={css.hint}>{site.deployHookSet ? t('toolsDeployHookSet') : t('toolsDeployHookUnset')}</p>
    </div>
  )
}

/**
 * The shortlist: numbered ideas with the review link while it awaits approval, or each idea's outcome once decided.
 * @returns the block.
 */
function ToolsShortlistBlock(props: { t: Translate; shortlist: NonNullable<ToolsStatus['shortlist']> }) {
  const { t, shortlist } = props
  const pending = shortlist.status === 'pending'
  return (
    <div className={css.card}>
      <p className={css.cardTitle}>
        <strong>{pending ? t('toolsShortlistPending') : t('toolsShortlistDecided', { date: shortlist.createdAt.slice(0, 10) })}</strong>
      </p>
      <ol className={css.list}>
        {shortlist.items.map(item => (
          <li key={item.slug} value={item.n}>
            <span>{t('toolsShortlistItem', { tool: item.tool, keyword: item.keyword })}</span>
            <p className={css.hint}>
              {t('toolsShortlistFacts', {
                verdict: item.verdict, demand: item.demand, market: item.market, rpm: item.rpm, difficulty: item.difficulty,
              })}
            </p>
            {pending
              ? null
              : (
                <span className={css.row}>
                  <Tag tone={item.approved === true ? 'success' : item.approved === false ? 'quiet' : 'outline'}>
                    {t(item.approved === true
                      ? 'toolsMark.approved'
                      : item.approved === false ? 'toolsMark.rejected' : 'toolsMark.undecided')}
                  </Tag>
                  {item.built ? <Tag tone="info">{t('toolsMark.built')}</Tag> : null}
                  {item.published ? <Tag tone="success">{t('toolsMark.published')}</Tag> : null}
                </span>
              )}
          </li>
        ))}
      </ol>
      {pending ? <p className={css.hint}>{t('toolsShortlistPendingHint')}</p> : null}
      <p>
        <a href={shortlist.link} target="_blank" rel="noreferrer">{pending ? t('toolsShortlistReview') : t('toolsShortlistOpen')}</a>
      </p>
    </div>
  )
}

/**
 * Search Console's figures for one tool, leaving out the ones not read yet.
 * @returns the line, or a dash.
 */
function gscLine(t: Translate, tool: ToolsStatus['tools'][number]): string {
  const parts = [
    tool.clicks === null ? '' : t('toolsGsc.clicks', { value: tool.clicks }),
    tool.impressions === null ? '' : t('toolsGsc.impressions', { value: tool.impressions }),
    tool.position === null ? '' : t('toolsGsc.position', { value: Math.round(tool.position * 10) / 10 }),
  ].filter(part => part !== '')
  return parts.length === 0 ? '—' : parts.join(' · ')
}

/**
 * The published tools: each one's link, its last test result, whether it is live, and how it does in search.
 * @returns the block.
 */
export function ToolsPublishedBlock(props: { t: Translate; tools: ToolsStatus['tools'] }) {
  const { t, tools } = props
  return (
    <div className={css.card}>
      <p className={css.cardTitle}><strong>{t('toolsPublishedTitle')}</strong></p>
      {tools.length === 0
        ? <p className={css.hint}>{t('toolsNoTools')}</p>
        : (
          <div className={css.scroll}>
            <table className={css.table}>
              <thead>
                <tr>
                  <th>{t('toolsCol.tool')}</th>
                  <th>{t('toolsCol.tests')}</th>
                  <th>{t('toolsCol.live')}</th>
                  <th>{t('toolsCol.search')}</th>
                  <th>{t('toolsCol.flag')}</th>
                </tr>
              </thead>
              <tbody>
                {tools.map(tool => (
                  <tr key={tool.slug}>
                    <td>
                      <a href={tool.url} target="_blank" rel="noreferrer">{tool.title}</a>
                      <br />
                      <span className={css.tag}>{tool.keyword}</span>
                      {tool.seed ? <>{' '}<Tag tone="neutral">{t('toolsSeedTag')}</Tag></> : null}
                    </td>
                    <td className={css.nowrap}>
                      <Tag tone={tool.tests === 'passed' ? 'success' : tool.tests === 'failed' ? 'danger' : 'quiet'}>
                        {t(`toolsTests.${tool.tests}`)}
                      </Tag>
                      {tool.testsAt === null ? null : ` ${tool.testsAt.slice(0, 10)}`}
                    </td>
                    <td>{tool.live ? t('toolsLive.yes') : t('toolsLive.no')}</td>
                    <td>{gscLine(t, tool)}</td>
                    <td className={tool.flag === null ? undefined : css.reason}>{tool.flag ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </div>
  )
}

/**
 * AdSense readiness: the verdict and each check with its detail.
 * @returns the block.
 */
export function ToolsAdsenseBlock(props: { t: Translate; adsense: ToolsStatus['adsense'] }) {
  const { t, adsense } = props
  return (
    <div className={css.card}>
      <p className={css.cardTitle}><strong>{t('toolsAdsenseTitle')}</strong></p>
      <p className={adsense.ready ? css.ok : css.state}>
        {adsense.ready ? t('toolsAdsenseReady', { verdict: adsense.verdict }) : t('toolsAdsenseNotReady', { verdict: adsense.verdict })}
      </p>
      <ul className={css.list}>
        {adsense.checks.map(check => (
          <li key={check.label}>
            <span className={check.ok ? css.ok : css.error}>{`${check.ok ? '✓' : '✗'} ${check.label}`}</span>
            {check.detail === '' ? null : <span className={css.hint}>{` — ${check.detail}`}</span>}
          </li>
        ))}
      </ul>
      <p className={css.hint}>{adsense.clientSet ? t('toolsAdsenseClientSet') : t('toolsAdsenseClientUnset')}</p>
    </div>
  )
}

/**
 * Everything the Host reports: schedule, run, actions, site, shortlist, published tools, AdSense, Google access and
 * the weekly and daily budgets.
 * @returns the block.
 */
export function ToolsStatusBlock(props: {
  t: Translate
  live: ToolsLiveState
  onRun: () => void
  onPublish: () => void
  onCheck: () => void
  onRefresh: () => void
}) {
  const { t, live } = props
  const status = live.status
  if (status === undefined) {
    return <p className={picker.pickerHint} role="status">{live.failed ? t('toolsStatusUnknown') : t('toolsStatusLoading')}</p>
  }
  const run = status.run
  const day = TOOLS_WEEKDAYS.find(d => status.schedule.weekday.trim().toLowerCase().startsWith(d.slice(0, 3)))
  return (
    <div className={picker.picker}>
      <span className={picker.pickerLabel}>{t('toolsStatusTitle')}</span>
      <p className={status.enabled ? picker.pickerValue : picker.pickerUnknown} role="status">
        {status.enabled
          ? t('toolsScheduled', {
            weekday: day === undefined ? status.schedule.weekday : t(`toolsWeekday.${day}`),
            time: status.schedule.time,
            timeZone: status.schedule.timeZone,
          })
          : t('toolsOff')}
        {status.lastShiftDate === null ? '' : ` · ${t('toolsLastRun', { date: status.lastShiftDate })}`}
      </p>
      {run === null || run.finished
        ? null
        : (
          <p className={picker.pickerHint}>
            {run.abandoned
              ? t('toolsRunAbandoned', { kind: t(`toolsRunKind.${run.kind}`) })
              : t('toolsRunProgress', {
                kind: t(`toolsRunKind.${run.kind}`), time: run.startedAt.slice(0, 16).replace('T', ' '), trigger: run.trigger,
              })}
          </p>
        )}
      <div className={picker.pickerCurrent}>
        <Button variant="outline" size="sm" disabled={live.started} onClick={props.onRun}>{t('toolsRunNow')}</Button>
        <Button variant="outline" size="sm" onClick={props.onPublish}>{t('toolsPublishSite')}</Button>
        <Button variant="ghost" size="sm" onClick={props.onCheck}>{t('toolsCheckSite')}</Button>
        <Button variant="ghost" size="sm" onClick={props.onRefresh}>{t('toolsRefresh')}</Button>
      </div>
      {live.action !== undefined && live.actionError === undefined
        ? <p className={picker.pickerHint} role="status">{live.actionMessage ?? t(`toolsActionOk.${live.action}`)}</p>
        : null}
      {live.action === undefined || live.actionError === undefined
        ? null
        : <p className={css.error} role="alert">{t(`toolsRefused.${live.action}`, { error: live.actionError })}</p>}
      <p className={picker.pickerHint}>{t('toolsPace', { thisWeek: status.pace.thisWeek, max: status.pace.max })}</p>
      <p className={picker.pickerHint}>{t('toolsSerp', { today: status.serp.today, max: status.serp.max })}</p>
      <ToolsSiteBlock t={t} site={status.site} />
      {status.shortlist === null ? null : <ToolsShortlistBlock t={t} shortlist={status.shortlist} />}
      <ToolsPublishedBlock t={t} tools={status.tools} />
      <ToolsAdsenseBlock t={t} adsense={status.adsense} />
      <p className={status.gsc.connected ? css.ok : css.state}>
        {status.gsc.connected
          ? t('toolsGscConnected', { property: status.gsc.property })
            + (status.gsc.lastReviewAt === null ? '' : ` · ${t('toolsGscLastReview', { date: status.gsc.lastReviewAt.slice(0, 10) })}`)
          : t('toolsGscNotConnected', { detail: status.gsc.detail })}
      </p>
      <p className={status.keywordPlanner.available ? css.ok : css.state}>
        {status.keywordPlanner.available
          ? t('toolsKpAvailable', { detail: status.keywordPlanner.detail })
          : t('toolsKpUnavailable', { detail: status.keywordPlanner.detail })}
      </p>
    </div>
  )
}

/**
 * Render the card.
 * @param props - locale copy, the form, the status and the actions.
 * @returns the summary line or the card.
 */
export function ToolsEmployeeCard(props: ToolsEmployeeCardProps) {
  const { t } = props
  const state = props.useToolsCard(snapshot => snapshot)
  const models = props.useToolsModels(snapshot => snapshot)
  const live = props.useToolsLive(snapshot => snapshot)
  if (props.view === 'summary') return t('toolsDescription')
  const disabled = !state.writable
  const common = (field: string) => ({
    overriddenLabel: t('overridden'),
    resetLabel: t('reset'),
    invalidLabel: t('toolsInvalid'),
    disabled,
    onReset: () => { props.resetField(field) },
    onEdit: (text: string) => { props.edit(field, text) },
  })
  const text = (field: 'shiftTime' | 'timeZone' | 'notifyTo' | 'seoSiteId') => (
    <SettingsValueField
      id={`plugin-config-tools-${field}`}
      label={t(`tools.${field}`)}
      hint={t(`tools.${field}.hint`)}
      {...state.strings[field]}
      {...common(field)}
    />
  )
  const placeheld = (field: 'adsenseClient' | 'gscProperty' | 'siteRepo') => (
    <SettingsValueField
      id={`plugin-config-tools-${field}`}
      label={t(`tools.${field}`)}
      hint={t(`tools.${field}.hint`)}
      placeholder={t(`tools.${field}.placeholder`)}
      {...state.strings[field]}
      {...common(field)}
    />
  )
  const number = (field: 'maxToolsPerWeek' | 'serpPerDay' | 'fallbackCooldownMinutes') => (
    <SettingsValueField
      id={`plugin-config-tools-${field}`}
      label={t(`tools.${field}`)}
      hint={t(`tools.${field}.hint`)}
      numeric
      {...state.numbers[field]}
      {...common(field)}
    />
  )
  const secret = (field: 'googleServiceAccountKey' | 'deployHook', set: boolean) => (
    <SettingsSecretField
      id={`plugin-config-tools-${field}`}
      label={t(`tools.${field}`)}
      hint={t(`tools.${field}.hint`)}
      disabled={disabled}
      text={state.secrets[field].text}
      configured={set}
      stateLabel={set ? t('scoutSecretSet') : t('scoutSecretUnset')}
      onEdit={(value) => { props.edit(field, value) }}
    />
  )
  const weekday = state.strings.weekday.text.trim().toLowerCase()
  return (
    <SettingsForm labels={formLabels(t)} state={state} onSave={props.save} onDiscard={props.discard}>
      <ToolsStatusBlock
        t={t}
        live={live}
        onRun={props.runNow}
        onPublish={props.publishSite}
        onCheck={props.checkSite}
        onRefresh={props.refreshStatus}
      />
      <div>
        <p><strong>{t('tools.enabled')}</strong></p>
        <Switch
          label={t('tools.enabled')}
          title={t('tools.enabled.hint')}
          checked={state.enabled.text === 'true'}
          disabled={disabled}
          onChange={(next) => { props.edit('enabled', next ? 'true' : 'false') }}
        />
        <p>{t('tools.enabled.hint')}</p>
      </div>
      <div className={css.field}>
        <label className={css.label} htmlFor="plugin-config-tools-weekday">{t('tools.weekday')}</label>
        <select
          id="plugin-config-tools-weekday"
          className={css.input}
          value={(TOOLS_WEEKDAYS as readonly string[]).includes(weekday) ? weekday : 'monday'}
          disabled={disabled}
          onChange={(event) => { props.edit('weekday', event.target.value) }}
        >
          {TOOLS_WEEKDAYS.map(day => <option key={day} value={day}>{t(`toolsWeekday.${day}`)}</option>)}
        </select>
        <p className={css.hint}>{t('tools.weekday.hint')}</p>
      </div>
      {text('shiftTime')}
      {text('timeZone')}
      {text('notifyTo')}
      {TOOLS_LIST_FIELDS.map(field => (
        <ListEditor
          key={field}
          id={`plugin-config-tools-${field}`}
          label={t(`tools.${field}`)}
          hint={t(`tools.${field}.hint`)}
          text={state.lists[field].text}
          placeholder={t(`tools.${field}.placeholder`)}
          addLabel={t(`toolsAdd.${field}`)}
          removeLabel={t('toolsRemove')}
          disabled={disabled}
          onEdit={(value) => { props.edit(field, value) }}
        />
      ))}
      {number('maxToolsPerWeek')}
      {number('serpPerDay')}
      {placeheld('adsenseClient')}
      {placeheld('gscProperty')}
      {secret('googleServiceAccountKey', live.status?.gsc.keySet === true)}
      {text('seoSiteId')}
      {placeheld('siteRepo')}
      {secret('deployHook', live.status?.site.deployHookSet === true)}
      {TOOLS_MODEL_PAIRS.map(pair => (
        <ScoutModelPicker
          key={pair.key}
          labels={{
            label: t(`tools.${pair.key}`),
            hint: t(`tools.${pair.key}.hint`),
            search: t('scoutModelSearch'),
            none: t(`tools.${pair.key}.none`),
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
      {number('fallbackCooldownMinutes')}
    </SettingsForm>
  )
}
