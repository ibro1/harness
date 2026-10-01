/**
 * The Ads proposals page body: the ads employee's pause state, the proposals
 * waiting for the owner with the full ad each would run, the campaigns it
 * runs, and decided proposals, read from `/seo/status` and refreshed while the
 * page is open. Approving asks for a confirmation that names the daily spend.
 */

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SeoTranslate } from './SeoSiteForm.tsx'
import {
  formatAdsMoney, proposalDailyMicros, type AdsCampaign, type AdsCampaignSpec, type AdsProposal,
} from './ads-model.ts'
import { fetchSeoStatus, postSeoAction, SEO_MARKETS, type SeoRequest, type SeoStatus } from './seo-sites-model.ts'
import css from './seo.module.css'

/** How often the open page re-reads the status. */
const REFRESH_MS = 30_000

const minute = (iso: string): string => iso.slice(0, 16).replace('T', ' ')

const defaultRequest: SeoRequest = (url, init) => fetch(url, init)

/** A notice from the last decision, shown above the waiting proposals. */
type Notice = { kind: 'ok' | 'error'; text: string }

/**
 * A geo target id as a market name when the site form offers it.
 * @param t - copy.
 * @param geoId - the Google Ads geo target id.
 * @returns the name with the id, or the id alone.
 */
function marketName(t: SeoTranslate, geoId: string): string {
  const known = SEO_MARKETS.find(m => m.geoId === geoId && m.languageId === '1000')
  return known === undefined ? geoId : `${t(`seoMarket.${known.key}`)} (${geoId})`
}

/**
 * Everything a new campaign would run, so the owner reads the actual ad before approving it.
 * @param props - copy and the proposed campaign.
 * @returns the campaign's details.
 */
function CampaignDetails(props: { t: SeoTranslate; spec: AdsCampaignSpec }) {
  const { t, spec } = props
  const path = [spec.ad.path1, spec.ad.path2].filter(part => part !== '').join('/')
  return (
    <>
      <p className={css.state}><strong>{t('adsCampaignName')}</strong>{`: ${spec.name}`}</p>
      <p className={css.state}>
        <strong>{t('adsDailyBudget')}</strong>{`: ${formatAdsMoney(spec.dailyBudgetMicros)} · `}
        <strong>{t('adsCpcCeiling')}</strong>{`: ${formatAdsMoney(spec.cpcCeilingMicros)}`}
      </p>
      <p className={css.state}>
        <strong>{t('adsMarkets')}</strong>
        {`: ${spec.geoIds.length === 0 ? t('adsWorldwide') : spec.geoIds.map(id => marketName(t, id)).join(', ')}`}
        {spec.languageId === undefined || spec.languageId === '' ? null : ` · ${t('adsLanguage', { id: spec.languageId })}`}
      </p>
      <p className={css.subtitle}>{t('adsKeywords')}</p>
      {spec.keywords.length === 0
        ? <p className={css.hint}>{t('adsNone')}</p>
        : <ul className={css.list}>{spec.keywords.map((k, index) => <li key={index}>{k.text} <span className={css.tag}>{t(`adsMatch.${k.match}`)}</span></li>)}</ul>}
      <p className={css.subtitle}>{t('adsNegatives')}</p>
      <p className={spec.negatives.length === 0 ? css.hint : css.state}>{spec.negatives.length === 0 ? t('adsNone') : spec.negatives.join(', ')}</p>
      <p className={css.state}>
        <strong>{t('adsFinalUrl')}</strong>{': '}
        <a href={spec.ad.finalUrl} target="_blank" rel="noreferrer">{spec.ad.finalUrl}</a>
      </p>
      {path === '' ? null : <p className={css.state}><strong>{t('adsDisplayPath')}</strong>{`: ${path}`}</p>}
      <p className={css.subtitle}>{t('adsHeadlines', { count: spec.ad.headlines.length })}</p>
      <ol className={css.questions}>{spec.ad.headlines.map((h, index) => <li key={index}>{h}</li>)}</ol>
      <p className={css.subtitle}>{t('adsDescriptions', { count: spec.ad.descriptions.length })}</p>
      <ol className={css.questions}>{spec.ad.descriptions.map((d, index) => <li key={index}>{d}</li>)}</ol>
    </>
  )
}

/**
 * What a budget change or resume acts on, in one line.
 * @param t - copy.
 * @param proposal - the proposal.
 * @param campaigns - the campaigns the employee runs.
 * @returns the line, or undefined for a new campaign.
 */
function changeLine(t: SeoTranslate, proposal: AdsProposal, campaigns: readonly AdsCampaign[]): string | undefined {
  const campaign = campaigns.find(c => c.resource === proposal.campaignResource)
  const name = campaign?.name ?? t('adsUnknownCampaign')
  const unknown = t('adsUnknownAmount')
  switch (proposal.kind) {
    case 'campaign': return undefined
    case 'budget': return t('adsBudgetChange', {
      campaign: name,
      from: campaign === undefined ? unknown : formatAdsMoney(campaign.dailyBudgetMicros),
      to: proposal.newDailyBudgetMicros === undefined ? unknown : formatAdsMoney(proposal.newDailyBudgetMicros),
    })
    case 'resume': return t('adsResumeCampaign', { campaign: name, amount: campaign === undefined ? unknown : formatAdsMoney(campaign.dailyBudgetMicros) })
  }
}

/**
 * One proposal waiting for the owner, with Approve behind a confirmation and Reject.
 * @param props - copy, the proposal, its site name, the campaigns, and the decision actions.
 * @returns the card.
 */
function WaitingProposal(props: {
  t: SeoTranslate
  proposal: AdsProposal
  siteName: string
  campaigns: readonly AdsCampaign[]
  onApprove: () => Promise<void>
  onReject: () => Promise<void>
}) {
  const { t, proposal } = props
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState<'approve' | 'reject' | undefined>(undefined)
  const daily = proposalDailyMicros(proposal, props.campaigns)
  const change = changeLine(t, proposal, props.campaigns)
  const run = (which: 'approve' | 'reject', action: () => Promise<void>): void => {
    setBusy(which)
    void action().finally(() => { setBusy(undefined); setConfirming(false) })
  }
  return (
    <div className={css.card}>
      <p className={css.cardTitle}><strong>{t(`adsKind.${proposal.kind}`)}</strong> <span className={css.tag}>{proposal.id}</span></p>
      <p className={css.hint}>{t('adsProposalMeta', { site: props.siteName, time: minute(proposal.createdAt) })}</p>
      <p className={css.answer}>{proposal.reason}</p>
      {change === undefined ? null : <p className={css.state}>{change}</p>}
      {proposal.kind === 'campaign' && proposal.campaign !== undefined ? <CampaignDetails t={t} spec={proposal.campaign} /> : null}
      {confirming
        ? (
          <div className={css.confirm} role="alertdialog" aria-label={t('adsApprove')}>
            <p className={css.state}>{daily === undefined ? t('adsConfirmUnknown') : t('adsConfirm', { amount: formatAdsMoney(daily) })}</p>
            <div className={css.row}>
              <Button variant="primary" size="sm" disabled={busy !== undefined} onClick={() => { run('approve', props.onApprove) }}>
                {busy === 'approve' ? t('adsApproving') : t('adsConfirmYes')}
              </Button>
              <Button variant="ghost" size="sm" disabled={busy !== undefined} onClick={() => { setConfirming(false) }}>{t('adsCancel')}</Button>
            </div>
          </div>
        )
        : (
          <div className={css.row}>
            <Button variant="primary" size="sm" disabled={busy !== undefined} onClick={() => { setConfirming(true) }}>{t('adsApprove')}</Button>
            <Button variant="outline" size="sm" disabled={busy !== undefined} onClick={() => { run('reject', props.onReject) }}>
              {busy === 'reject' ? t('adsRejecting') : t('adsReject')}
            </Button>
          </div>
        )}
    </div>
  )
}

/**
 * A campaign's state as the table shows it.
 * @param t - copy.
 * @param campaign - the campaign.
 * @returns live, paused with why, or not enabled.
 */
function campaignState(t: SeoTranslate, campaign: AdsCampaign): string {
  if (campaign.paused !== undefined) return t('adsStateCampaignPaused', { reason: campaign.paused.reason })
  return campaign.enabledAt === undefined ? t('adsStateNotEnabled') : t('adsStateLive')
}

/**
 * Render the Ads proposals page body.
 * @param props.t - the page's translator.
 * @param props.request - same-origin HTTP; `fetch` unless a test injects one.
 * @returns the page.
 */
export function AdsProposals(props: { t: SeoTranslate; request?: SeoRequest }) {
  const { t } = props
  const request = props.request ?? defaultRequest
  const [status, setStatus] = useState<SeoStatus | undefined>(undefined)
  const [failed, setFailed] = useState(false)
  const [pauseBusy, setPauseBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | undefined>(undefined)
  const load = useCallback(async (): Promise<void> => {
    try {
      const next = await fetchSeoStatus(request)
      setStatus(next)
      setFailed(false)
    } catch {
      // A failed read keeps the last view and says so; the next tick retries.
      setFailed(true)
    }
  }, [request])
  useEffect(() => {
    let live = true
    const tick = (): void => { if (live) void load() }
    tick()
    const timer = setInterval(tick, REFRESH_MS)
    return () => { live = false; clearInterval(timer) }
  }, [load])

  /**
   * Post one owner action, then read the status again.
   * @param body - the action and its fields.
   * @param done - the notice for an accepted action, from its answer.
   */
  const act = async (body: Record<string, unknown>, done?: (answer: Record<string, unknown>) => string): Promise<void> => {
    const result = await postSeoAction(request, body)
    if (result.ok) {
      setNotice(done === undefined ? undefined : { kind: 'ok', text: done(result.body) })
      void load()
    } else {
      setNotice({ kind: 'error', text: t('adsFailed', { error: result.error }) })
    }
  }

  if (status === undefined) {
    return <p className={css.hint} role="status">{failed ? t('adsUnreachable') : t('adsLoading')}</p>
  }
  const ads = status.ads
  const siteName = (id: string): string => status.sites.find(site => site.id === id)?.name ?? id
  const waiting = ads.proposals.filter(p => p.status === 'proposed')
  const decided = ads.proposals.filter(p => p.status !== 'proposed')

  return (
    <div className={css.page}>
      <section className={css.section}>
        <div className={css.head}>
          <p className={ads.paused === null ? css.state : css.error} role="status">
            {ads.paused === null ? t('adsStateRunning') : t('adsStatePaused', { reason: ads.paused.reason, time: minute(ads.paused.at) })}
            {' '}
            {ads.lastShiftDate === null ? t('adsNoShiftYet') : t('adsLastShift', { date: ads.lastShiftDate })}
          </p>
          <div className={css.row}>
            <Button variant="outline" size="sm" disabled={pauseBusy} onClick={() => {
              setPauseBusy(true)
              void act({ action: ads.paused === null ? 'ads-pause' : 'ads-resume' }).finally(() => { setPauseBusy(false) })
            }}>{ads.paused === null ? t('adsPauseAll') : t('adsResume')}</Button>
            <Button variant="ghost" size="sm" onClick={() => { void load() }}>{t('adsRefresh')}</Button>
          </div>
        </div>
        <p className={css.hint}>{t('adsAmountsNote')}</p>
        {failed ? <p className={css.error} role="status">{t('adsUnreachable')}</p> : null}
      </section>

      <section className={css.section}>
        <h3 className={css.title}>{t('adsWaitingTitle')}</h3>
        {notice === undefined ? null : <p className={notice.kind === 'ok' ? css.ok : css.error} role="status">{notice.text}</p>}
        {waiting.length === 0 ? <p className={css.hint}>{t('adsWaitingEmpty')}</p> : null}
        {waiting.map(proposal => (
          <WaitingProposal
            key={proposal.id}
            t={t}
            proposal={proposal}
            siteName={siteName(proposal.siteId)}
            campaigns={ads.campaigns}
            onApprove={() => act({ action: 'approve-proposal', id: proposal.id }, answer => t('adsOutcome', {
              id: proposal.id, outcome: typeof answer['outcome'] === 'string' ? answer['outcome'] : t('adsNoOutcome'),
            }))}
            onReject={() => act({ action: 'reject-proposal', id: proposal.id }, () => t('adsRejected', { id: proposal.id }))}
          />
        ))}
      </section>

      <section className={css.section}>
        <h3 className={css.title}>{t('adsCampaignsTitle')}</h3>
        {ads.campaigns.length === 0
          ? <p className={css.hint}>{t('adsCampaignsEmpty')}</p>
          : (
            <div className={css.scroll}>
              <table className={css.table}>
                <thead>
                  <tr>
                    <th>{t('adsColName')}</th>
                    <th>{t('adsColSite')}</th>
                    <th>{t('adsColBudget')}</th>
                    <th>{t('adsColState')}</th>
                    <th>{t('adsColCreated')}</th>
                  </tr>
                </thead>
                <tbody>
                  {ads.campaigns.map(campaign => (
                    <tr key={campaign.resource}>
                      <td>{campaign.name}</td>
                      <td>{siteName(campaign.siteId)}</td>
                      <td className={css.nowrap}>{formatAdsMoney(campaign.dailyBudgetMicros)}</td>
                      <td className={css.reason}>{campaignState(t, campaign)}</td>
                      <td className={css.nowrap}>{minute(campaign.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </section>

      <section className={css.section}>
        {decided.length === 0
          ? (
            <>
              <h3 className={css.title}>{t('adsHistoryTitle', { count: 0 })}</h3>
              <p className={css.hint}>{t('adsHistoryEmpty')}</p>
            </>
          )
          : (
            <details className={css.details}>
              <summary>{t('adsHistoryTitle', { count: decided.length })}</summary>
              {decided.map(proposal => (
                <div key={proposal.id} className={css.card}>
                  <p className={css.cardTitle}>
                    <strong>{t(`adsKind.${proposal.kind}`)}</strong>
                    {proposal.campaign === undefined ? null : ` ${proposal.campaign.name}`}
                    {' '}
                    <span className={css.tag}>{proposal.id}</span>
                  </p>
                  <p className={proposal.status === 'failed' ? css.error : css.hint}>
                    {`${t(`adsStatus.${proposal.status}`)} · ${siteName(proposal.siteId)}`}
                    {proposal.decidedAt === undefined ? '' : ` · ${t('adsDecidedOn', { time: minute(proposal.decidedAt) })}`}
                  </p>
                  <p className={css.answer}>{proposal.outcome ?? t('adsNoOutcome')}</p>
                </div>
              ))}
            </details>
          )}
      </section>
    </div>
  )
}
