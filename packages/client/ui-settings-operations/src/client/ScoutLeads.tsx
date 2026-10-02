/** The Klipara Scout leads table, shown on the plugin's settings page and refreshed while it is open. */

import { useEffect, useState } from 'react'
import type { OperationsSettingsLocaleKey } from './locales.ts'
import css from './scout.module.css'

/** One lead, as the Host's `/scout/leads.json` reports it. */
interface LeadRow {
  channelId: string
  channelName: string
  channelUrl: string
  subscribers?: number
  videoUrl?: string
  videoTitle?: string
  stage: string
  samplePageUrl?: string
  pitch?: { via: string; to: string; visibility?: { state: string } }
  replies: { text: string }[]
  updatedAt: string
}

/** The whole `/scout/leads.json` answer. */
interface LeadsReport {
  date: string
  today: { samples: number; pitches: number }
  caps: { samples: number; pitches: number }
  paused: { reason: string } | null
  /** Absent from Hosts older than the outreach numbers. */
  commentsPaused?: { reason: string } | null
  commentChecks?: boolean
  stats?: {
    email: { sent: number; replied: number; followUps: number; repliedAfterFollowUp: number }
    comment: { sent: number; replied: number; visible: number; held: number }
  }
  leads: LeadRow[]
}

/** How often the open page re-reads the leads. */
const REFRESH_MS = 15_000

/**
 * Render today's counts and every lead, newest first.
 * @param props.t - the page's translator.
 * @returns the leads section.
 */
export function ScoutLeads(props: { t: (key: OperationsSettingsLocaleKey, vars?: Record<string, string | number>) => string }) {
  const { t } = props
  const [report, setReport] = useState<LeadsReport | undefined>(undefined)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let live = true
    const load = async (): Promise<void> => {
      try {
        const response = await fetch('/scout/leads.json', { cache: 'no-store' })
        if (!response.ok) throw new Error(String(response.status))
        const body = await response.json() as LeadsReport
        if (live) { setReport(body); setFailed(false) }
      } catch {
        // A failed read keeps the last table and says so; the next tick retries.
        if (live) setFailed(true)
      }
    }
    void load()
    const timer = setInterval(() => { void load() }, REFRESH_MS)
    return () => { live = false; clearInterval(timer) }
  }, [])
  return (
    <section className={css.leads}>
      <h3 className={css.title}>{t('scoutLeadsTitle')}</h3>
      {report === undefined ? null : (
        <p className={css.summary}>
          {t('scoutLeadsToday', {
            date: report.date,
            samples: report.today.samples, samplesCap: report.caps.samples,
            pitches: report.today.pitches, pitchesCap: report.caps.pitches,
          })}
          {report.paused === null ? null : ` ${t('scoutLeadsPaused', { reason: report.paused.reason })}`}
        </p>
      )}
      {report?.stats === undefined ? null : (
        <p className={css.summary}>
          {t('scoutStats', {
            emailSent: report.stats.email.sent, emailReplied: report.stats.email.replied,
            commentSent: report.stats.comment.sent, commentVisible: report.stats.comment.visible,
            commentHeld: report.stats.comment.held, commentReplied: report.stats.comment.replied,
          })}
          {report.stats.email.followUps === 0 ? null : ` ${t('scoutStatsFollowUps', { followUps: report.stats.email.followUps, afterFollowUp: report.stats.email.repliedAfterFollowUp })}`}
        </p>
      )}
      {report?.commentChecks === false ? <p className={css.summary}>{t('scoutStatsUnchecked')}</p> : null}
      {report?.commentsPaused === undefined || report.commentsPaused === null ? null : <p className={css.summary} role="status">{t('scoutCommentsStopped', { reason: report.commentsPaused.reason })}</p>}
      {failed ? <p className={css.empty} role="status">{t('scoutLeadsFailed')}</p> : null}
      {report !== undefined && report.leads.length === 0 ? <p className={css.empty}>{t('scoutLeadsEmpty')}</p> : null}
      {report !== undefined && report.leads.length > 0 ? (
        <div className={css.scroll}>
          <table className={css.table}>
            <thead>
              <tr>
                <th>{t('scoutColStage')}</th>
                <th>{t('scoutColChannel')}</th>
                <th>{t('scoutColVideo')}</th>
                <th>{t('scoutColSample')}</th>
                <th>{t('scoutColPitch')}</th>
                <th>{t('scoutColReplies')}</th>
                <th>{t('scoutColUpdated')}</th>
              </tr>
            </thead>
            <tbody>
              {report.leads.map(lead => (
                <tr key={lead.channelId}>
                  <td className={css.stage}>{lead.stage}</td>
                  <td>
                    <a href={lead.channelUrl} target="_blank" rel="noreferrer">{lead.channelName}</a>
                    {lead.subscribers === undefined ? null : <div className={css.summary}>{lead.subscribers.toLocaleString()}</div>}
                  </td>
                  <td>{lead.videoUrl === undefined ? null : <a href={lead.videoUrl} target="_blank" rel="noreferrer">{lead.videoTitle ?? lead.videoUrl}</a>}</td>
                  <td>{lead.samplePageUrl === undefined ? null : <a href={lead.samplePageUrl} target="_blank" rel="noreferrer">{t('scoutSampleLink')}</a>}</td>
                  <td>
                    {lead.pitch === undefined ? null : `${lead.pitch.via} → ${lead.pitch.to}`}
                    {lead.pitch?.visibility?.state === 'held' ? <><br /><strong>{t('scoutCommentHeld')}</strong></> : null}
                    {lead.pitch?.visibility?.state === 'visible' ? <><br />{t('scoutCommentVisible')}</> : null}
                  </td>
                  <td>{lead.replies.map(reply => reply.text.slice(0, 200)).join(' · ')}</td>
                  <td>{lead.updatedAt.slice(0, 16).replace('T', ' ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  )
}
