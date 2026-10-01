/**
 * The SEO sites page body: the employee's state, the sites it writes for, its
 * open questions for the owner, drafts waiting, published articles and the
 * content map, read from `/seo/status` and refreshed while the page is open.
 */

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { SeoSiteForm, type SeoTranslate } from './SeoSiteForm.tsx'
import type { SeoTopicStatusKey } from './locales/seo.ts'
import {
  fetchSeoStatus, postSeoAction, type SeoArticle, type SeoClipPermission, type SeoQuestion, type SeoRequest, type SeoStatus,
} from './seo-sites-model.ts'
import css from './seo.module.css'

/** How often the open page re-reads the status. */
const REFRESH_MS = 30_000

const TOPIC_STATUSES = new Set<string>(['planned', 'asked', 'drafted', 'published', 'rejected'] satisfies SeoTopicStatusKey[])

/** Which site the form is open for: a new one, a saved one by id, or none. */
type Editing = { kind: 'new' } | { kind: 'site'; id: string } | undefined

const day = (iso: string): string => iso.slice(0, 10)

const defaultRequest: SeoRequest = (url, init) => fetch(url, init)

/**
 * The clips the owner allows in articles: add one with why it may be featured, or remove it.
 * @param props - copy, the list, and the add and remove actions.
 * @returns the section body.
 */
function ClipPermissions(props: {
  t: SeoTranslate
  permissions: SeoClipPermission[]
  act: (body: Record<string, unknown>) => Promise<string | undefined>
}) {
  const { t } = props
  const [sampleId, setSampleId] = useState('')
  const [basis, setBasis] = useState<SeoClipPermission['basis']>('permission')
  const [credit, setCredit] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const add = async (): Promise<void> => {
    setBusy(true)
    const failed = await props.act({ action: 'permit-clip', sampleId, basis, credit, note })
    setBusy(false)
    setError(failed)
    if (failed === undefined) { setSampleId(''); setCredit(''); setNote('') }
  }
  return (
    <>
      <p className={css.hint}>{t('seoClipsHint')}</p>
      {props.permissions.length === 0
        ? <p className={css.hint}>{t('seoClipsEmpty')}</p>
        : (
          <ul className={css.list}>
            {props.permissions.map(p => (
              <li key={p.sampleId}>
                <strong>{p.sampleId}</strong>
                <span className={css.hint}>{` · ${t(`seoClipBasis.${p.basis}`)}${p.credit === '' ? '' : ` · ${p.credit}`}${p.note === '' ? '' : ` · ${p.note}`}`}</span>
                {' '}
                <Button variant="ghost" size="sm" onClick={() => { void props.act({ action: 'revoke-clip', sampleId: p.sampleId }) }}>{t('seoClipRemove')}</Button>
              </li>
            ))}
          </ul>
        )}
      <div className={css.card}>
        <label className={css.label} htmlFor="seo-clip-id">{t('seoClipId')}</label>
        <input id="seo-clip-id" className={css.input} type="text" value={sampleId} onChange={(event) => { setSampleId(event.target.value) }} />
        <label className={css.label} htmlFor="seo-clip-basis">{t('seoClipBasis')}</label>
        <select id="seo-clip-basis" className={css.input} value={basis}
          onChange={(event) => { setBasis(event.target.value === 'own' || event.target.value === 'cc' ? event.target.value : 'permission') }}>
          {(['own', 'permission', 'cc'] as const).map(b => <option key={b} value={b}>{t(`seoClipBasis.${b}`)}</option>)}
        </select>
        {basis === 'own'
          ? null
          : (
            <>
              <label className={css.label} htmlFor="seo-clip-credit">{t('seoClipCredit')}</label>
              <input id="seo-clip-credit" className={css.input} type="text" value={credit} onChange={(event) => { setCredit(event.target.value) }} />
            </>
          )}
        <label className={css.label} htmlFor="seo-clip-note">{t('seoClipNote')}</label>
        <input id="seo-clip-note" className={css.input} type="text" value={note} onChange={(event) => { setNote(event.target.value) }} />
        <p><Button variant="outline" size="sm" disabled={busy || sampleId.trim() === ''} onClick={() => { void add() }}>{t('seoClipAdd')}</Button></p>
        {error === undefined ? null : <p className={css.error} role="status">{error}</p>}
      </div>
    </>
  )
}

/**
 * One open question set with its answer box.
 * @param props - copy, the question, the site name, and the send action.
 * @returns the block.
 */
function OpenQuestion(props: {
  t: SeoTranslate
  question: SeoQuestion
  siteName: string
  /** Resolves to the Host's error, or undefined once the answer is stored. */
  onSend: (answer: string) => Promise<string | undefined>
}) {
  const { t, question } = props
  const [answer, setAnswer] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const id = `seo-answer-${question.tag}`
  return (
    <div className={css.card}>
      <p className={css.cardTitle}><strong>{question.keyword}</strong> <span className={css.tag}>{question.tag}</span></p>
      <p className={css.hint}>{t('seoQuestionAsked', { site: props.siteName, date: day(question.askedAt) })}</p>
      <ol className={css.questions}>{question.questions.map((q, index) => <li key={index}>{q}</li>)}</ol>
      <label className={css.label} htmlFor={id}>{t('seoAnswerLabel')}</label>
      <textarea id={id} className={`${css.input} ${css.textarea}`} rows={4} value={answer} disabled={sending} onChange={(event) => { setAnswer(event.target.value) }} />
      <div className={css.row}>
        <Button variant="primary" size="sm" disabled={sending || answer.trim() === ''} onClick={() => {
          setSending(true)
          void props.onSend(answer).then((failure) => {
            setSending(false)
            setError(failure)
            if (failure === undefined) setAnswer('')
          })
        }}>{sending ? t('seoAnswerSending') : t('seoAnswerSend')}</Button>
      </div>
      {error === undefined ? null : <p className={css.error} role="status">{t('seoFailed', { error })}</p>}
    </div>
  )
}

/**
 * The latest Search Console reading of an article.
 * @param t - copy.
 * @param article - the article.
 * @returns the reading as one line.
 */
function latestMetrics(t: SeoTranslate, article: SeoArticle): string {
  const last = article.metrics[article.metrics.length - 1]
  if (last === undefined) return t('seoNoMetrics')
  return t('seoMetrics', { clicks: last.clicks, impressions: last.impressions, position: last.position.toFixed(1), days: last.days })
}

/**
 * Render the SEO sites page body.
 * @param props.t - the page's translator.
 * @param props.request - same-origin HTTP; `fetch` unless a test injects one.
 * @returns the page.
 */
export function SeoSites(props: { t: SeoTranslate; request?: SeoRequest }) {
  const { t } = props
  const request = props.request ?? defaultRequest
  const [status, setStatus] = useState<SeoStatus | undefined>(undefined)
  const [failed, setFailed] = useState(false)
  const [editing, setEditing] = useState<Editing>(undefined)
  const [pauseBusy, setPauseBusy] = useState(false)
  const [actionError, setActionError] = useState<string | undefined>(undefined)
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

  const act = async (body: Record<string, unknown>): Promise<string | undefined> => {
    const result = await postSeoAction(request, body)
    if (result.ok) void load()
    return result.ok ? undefined : result.error
  }

  if (status === undefined) {
    return <p className={css.hint} role="status">{failed ? t('seoSitesFailed') : t('seoSitesLoading')}</p>
  }
  const siteName = (id: string): string => status.sites.find(site => site.id === id)?.name ?? id
  const open = status.questions.filter(q => q.answer === undefined)
  const answered = status.questions.filter(q => q.answer !== undefined)
  const editingSite = editing?.kind === 'site' ? status.sites.find(site => site.id === editing.id) : undefined

  return (
    <div className={css.page}>
      <section className={css.section}>
        <div className={css.head}>
          <p className={status.paused === null ? css.state : css.error} role="status">
            {status.paused === null ? t('seoStateRunning') : t('seoStatePaused', { reason: status.paused.reason })}
            {' '}
            {status.lastShiftDate === null ? t('seoNoShiftYet') : t('seoLastShift', { date: status.lastShiftDate })}
          </p>
          <div className={css.row}>
            <Button variant="outline" size="sm" disabled={pauseBusy} onClick={() => {
              setPauseBusy(true)
              void act({ action: status.paused === null ? 'pause' : 'resume' }).then((failure) => { setPauseBusy(false); setActionError(failure) })
            }}>{status.paused === null ? t('seoPause') : t('seoResume')}</Button>
            <Button variant="ghost" size="sm" onClick={() => { void load() }}>{t('seoRefresh')}</Button>
          </div>
        </div>
        {failed ? <p className={css.error} role="status">{t('seoSitesFailed')}</p> : null}
        {actionError === undefined ? null : <p className={css.error} role="status">{t('seoFailed', { error: actionError })}</p>}
      </section>

      <section className={css.section}>
        <div className={css.head}>
          <h3 className={css.title}>{t('seoSitesTitle')}</h3>
          <Button variant="outline" size="sm" onClick={() => { setEditing({ kind: 'new' }) }}>{t('seoAddSite')}</Button>
        </div>
        {status.sites.length === 0
          ? <p className={css.hint}>{t('seoSitesEmpty')}</p>
          : (
            <div className={css.scroll}>
              <table className={css.table}>
                <thead>
                  <tr>
                    <th>{t('seoColName')}</th>
                    <th>{t('seoColAddress')}</th>
                    <th>{t('seoColKind')}</th>
                    <th>{t('seoColThisWeek')}</th>
                    <th>{t('seoColEnabled')}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {status.sites.map(site => (
                    <tr key={site.id}>
                      <td>{site.name}</td>
                      <td><a href={site.baseUrl} target="_blank" rel="noreferrer">{site.baseUrl.replace(/^https:\/\//u, '')}</a></td>
                      <td>{t(`seoKind.${site.kind}`)}</td>
                      <td className={css.nowrap}>{t('seoWeekCount', { count: site.thisWeek, cap: site.articlesPerWeek })}</td>
                      <td>{site.enabled ? t('seoOn') : t('seoOff')}</td>
                      <td><Button variant="ghost" size="sm" onClick={() => { setEditing({ kind: 'site', id: site.id }) }}>{t('seoEdit')}</Button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        {editing === undefined || (editing.kind === 'site' && editingSite === undefined)
          ? null
          : (
            <SeoSiteForm
              key={editing.kind === 'site' ? editing.id : ''}
              t={t}
              site={editingSite}
              request={request}
              onChanged={() => { void load() }}
              onClose={() => { setEditing(undefined) }}
            />
          )}
      </section>

      <section className={css.section}>
        <h3 className={css.title}>{t('seoQuestionsTitle')}</h3>
        {open.length === 0 ? <p className={css.hint}>{t('seoQuestionsEmpty')}</p> : null}
        {open.map(question => (
          <OpenQuestion key={question.tag} t={t} question={question} siteName={siteName(question.siteId)}
            onSend={answer => act({ action: 'answer', tag: question.tag, answer })} />
        ))}
        {answered.length === 0
          ? null
          : (
            <details className={css.details}>
              <summary>{t('seoAnsweredTitle', { count: answered.length })}</summary>
              {answered.map(question => (
                <div key={question.tag} className={css.card}>
                  <p className={css.cardTitle}><strong>{question.keyword}</strong> <span className={css.tag}>{question.tag}</span></p>
                  <ol className={css.questions}>{question.questions.map((q, index) => <li key={index}>{q}</li>)}</ol>
                  <p className={css.answer}>{question.answer}</p>
                  <p className={css.hint}>{t('seoAnsweredOn', { date: day(question.answeredAt ?? '') })}</p>
                </div>
              ))}
            </details>
          )}
      </section>

      <section className={css.section}>
        <h3 className={css.title}>{t('seoClipsTitle')}</h3>
        <ClipPermissions t={t} permissions={status.clipPermissions} act={act} />
      </section>

      <section className={css.section}>
        <h3 className={css.title}>{t('seoDraftsTitle')}</h3>
        {status.drafts.length === 0
          ? <p className={css.hint}>{t('seoDraftsEmpty')}</p>
          : (
            <ul className={css.list}>
              {status.drafts.map(draft => (
                <li key={draft.id}>
                  <strong>{draft.title}</strong>
                  <span className={css.hint}>{` · ${siteName(draft.siteId)} · `}</span>
                  <span className={draft.editor === null ? css.hint : draft.editor.pass ? css.ok : css.error}>
                    {draft.editor === null
                      ? t('seoDraftUnreviewed')
                      : draft.editor.pass
                        ? t('seoDraftPass', { total: draft.editor.total })
                        : t('seoDraftFail', { total: draft.editor.total, mustFix: draft.editor.mustFix.join('; ') })}
                  </span>
                </li>
              ))}
            </ul>
          )}
      </section>

      <section className={css.section}>
        <h3 className={css.title}>{t('seoArticlesTitle')}</h3>
        {status.articles.length === 0
          ? <p className={css.hint}>{t('seoArticlesEmpty')}</p>
          : (
            <div className={css.scroll}>
              <table className={css.table}>
                <thead>
                  <tr>
                    <th>{t('seoColTitle')}</th>
                    <th>{t('seoColSite')}</th>
                    <th>{t('seoColPublished')}</th>
                    <th>{t('seoColScore')}</th>
                    <th>{t('seoColMetrics')}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {status.articles.map(article => (
                    <tr key={article.id}>
                      <td><a href={article.url} target="_blank" rel="noreferrer">{article.title}</a></td>
                      <td>{siteName(article.siteId)}</td>
                      <td className={css.nowrap}>{day(article.publishedAt)}</td>
                      <td>{article.editorTotal}</td>
                      <td>{latestMetrics(t, article)}</td>
                      <td className={css.nowrap}>
                        {article.unpublishedAt === undefined
                          ? <a href={article.unpublishUrl} target="_blank" rel="noreferrer">{t('seoUnpublish')}</a>
                          : <span className={css.hint}>{t('seoUnpublishedOn', { date: day(article.unpublishedAt) })}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </section>

      <section className={css.section}>
        <h3 className={css.title}>{t('seoTopicsTitle')}</h3>
        {status.topics.length === 0
          ? <p className={css.hint}>{t('seoTopicsEmpty')}</p>
          : (
            <div className={css.scroll}>
              <table className={css.table}>
                <thead>
                  <tr>
                    <th>{t('seoColKeyword')}</th>
                    <th>{t('seoColSite')}</th>
                    <th>{t('seoColStatus')}</th>
                    <th>{t('seoColTarget')}</th>
                    <th>{t('seoColReason')}</th>
                  </tr>
                </thead>
                <tbody>
                  {status.topics.map(topic => (
                    <tr key={topic.id}>
                      <td>{topic.keyword}</td>
                      <td>{siteName(topic.siteId)}</td>
                      <td className={css.nowrap}>{TOPIC_STATUSES.has(topic.status) ? t(`seoTopicStatus.${topic.status as SeoTopicStatusKey}`) : topic.status}</td>
                      <td>
                        {topic.target === 'new' || topic.target === ''
                          ? t('seoTargetNew')
                          : <a href={topic.target} target="_blank" rel="noreferrer">{topic.target.replace(/^https?:\/\//u, '')}</a>}
                      </td>
                      <td className={css.reason}>{topic.reason ?? topic.why}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </section>
    </div>
  )
}
