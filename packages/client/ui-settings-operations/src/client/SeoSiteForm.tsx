/** The SEO sites page's add and edit form for one site. */

import { useId, useState } from 'react'
import { Button, Checkbox, SettingsSecretField, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { OperationsSettingsLocaleKey } from './locales.ts'
import type { SeoSiteFieldKey } from './locales/seo.ts'
import {
  buildSaveSiteBody, postSeoAction, SEO_MARKETS, siteFormFrom, emptySiteForm,
  type SeoPublisherKind, type SeoRequest, type SeoSite, type SeoSiteForm,
} from './seo-sites-model.ts'
import css from './seo.module.css'

/** The page's translator. */
export type SeoTranslate = (key: OperationsSettingsLocaleKey, params?: Record<string, unknown>) => string

/** Fields the form renders as text controls. */
type FormTextKey = Exclude<keyof SeoSiteForm, 'id' | 'kind' | 'enabled' | 'markets' | 'otherMarkets' | 'apiKey' | 'wpUser' | 'wpAppPassword' | 'googleAccess'>

/** A transient message under the form's buttons. */
type Notice = { tone: 'ok' | 'error'; message: string } | undefined

/** Props of {@link SeoSiteForm}. */
export interface SeoSiteFormProps {
  t: SeoTranslate
  /** The site being edited, or undefined for a new one. */
  site: SeoSite | undefined
  request: SeoRequest
  /** Called after a save or delete lands, so the page reads the status again. */
  onChanged: () => void
  onClose: () => void
}

/**
 * Render the form for one site: what the business is, where it is researched,
 * who signs the articles, and the publisher's write-only credentials.
 * @param props - copy, the site, HTTP, and the page callbacks.
 * @returns the form.
 */
export function SeoSiteForm(props: SeoSiteFormProps) {
  const { t, site } = props
  const base = useId()
  const [form, setForm] = useState<SeoSiteForm>(() => site === undefined ? emptySiteForm() : siteFormFrom(site))
  const [secretsSet, setSecretsSet] = useState(site?.secretsSet ?? { apiKey: false, wpUser: false, wpAppPassword: false })
  const [busy, setBusy] = useState<'save' | 'test' | 'delete' | 'gsc' | undefined>(undefined)
  const [notice, setNotice] = useState<Notice>(undefined)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [gscSites, setGscSites] = useState<{ siteUrl: string; permissionLevel: string }[] | undefined>(undefined)
  const [gscError, setGscError] = useState<string | undefined>(undefined)
  const [linkCopied, setLinkCopied] = useState(false)
  const set = <K extends keyof SeoSiteForm>(key: K, value: SeoSiteForm[K]): void => { setForm(previous => ({ ...previous, [key]: value })) }

  const field = (key: FormTextKey, labelKey: SeoSiteFieldKey, options: { multiline?: boolean; placeholder?: string } = {}) => {
    const id = `${base}-${key}`
    return (
      <div className={css.field}>
        <label className={css.label} htmlFor={id}>{t(`seoSite.${labelKey}`)}</label>
        {options.multiline === true
          ? <textarea id={id} className={`${css.input} ${css.textarea}`} rows={3} value={form[key]} onChange={(event) => { set(key, event.target.value) }} />
          : <input id={id} className={css.input} type="text" value={form[key]} placeholder={options.placeholder ?? ''} onChange={(event) => { set(key, event.target.value) }} />}
        <p className={css.hint}>{t(`seoSite.${labelKey}.hint`)}</p>
      </div>
    )
  }
  const secret = (key: 'apiKey' | 'wpUser' | 'wpAppPassword') => (
    <SettingsSecretField
      id={`${base}-${key}`}
      label={t(`seoSite.${key}`)}
      hint={t(`seoSite.${key}.hint`)}
      disabled={busy !== undefined}
      text={form[key]}
      configured={secretsSet[key]}
      stateLabel={secretsSet[key] ? t('seoSecretSaved') : t('seoSecretUnset')}
      onEdit={(text) => { set(key, text) }}
    />
  )

  const save = async (): Promise<void> => {
    const body = buildSaveSiteBody(form)
    if (body === undefined) { setNotice({ tone: 'error', message: t('seoPerWeekInvalid') }); return }
    setBusy('save')
    setNotice(undefined)
    const result = await postSeoAction(props.request, { ...body })
    setBusy(undefined)
    if (!result.ok) { setNotice({ tone: 'error', message: t('seoFailed', { error: result.error }) }); return }
    const saved = result.body['site'] as { id?: unknown } | undefined
    const savedId = typeof saved?.id === 'string' ? saved.id : form.id
    setSecretsSet(previous => ({
      apiKey: previous.apiKey || body.secrets.apiKey !== undefined,
      wpUser: previous.wpUser || body.secrets.wpUser !== undefined,
      wpAppPassword: previous.wpAppPassword || body.secrets.wpAppPassword !== undefined,
    }))
    setForm(previous => ({ ...previous, id: savedId, apiKey: '', wpUser: '', wpAppPassword: '' }))
    setNotice({ tone: 'ok', message: t('seoSaved') })
    props.onChanged()
  }

  const test = async (): Promise<void> => {
    setBusy('test')
    setNotice(undefined)
    const result = await postSeoAction(props.request, { action: 'probe-site', id: form.id, kind: form.kind, baseUrl: form.baseUrl.trim() })
    setBusy(undefined)
    if (!result.ok) { setNotice({ tone: 'error', message: t('seoFailed', { error: result.error }) }); return }
    const answer = result.body
    if (form.kind === 'wordpress') {
      const vars = {
        name: typeof answer['name'] === 'string' ? answer['name'] : '',
        plugin: typeof answer['seoPlugin'] === 'string' ? answer['seoPlugin'] : '',
        count: typeof answer['articles'] === 'number' ? answer['articles'] : 0,
      }
      setNotice(answer['isWordPress'] !== true
        ? { tone: 'error', message: t('seoTestNotWordPress') }
        : { tone: 'ok', message: answer['ok'] === true ? t('seoTestWordPressSignedIn', vars) : t('seoTestWordPress', vars) })
      return
    }
    setNotice({ tone: 'ok', message: t('seoTestKlipara', { count: typeof answer['articles'] === 'number' ? answer['articles'] : 0 }) })
  }

  const remove = async (): Promise<void> => {
    setBusy('delete')
    const result = await postSeoAction(props.request, { action: 'delete-site', id: form.id })
    setBusy(undefined)
    setConfirmDelete(false)
    if (!result.ok) { setNotice({ tone: 'error', message: t('seoFailed', { error: result.error }) }); return }
    props.onChanged()
    props.onClose()
  }

  const loadGsc = async (): Promise<void> => {
    setBusy('gsc')
    setNotice(undefined)
    // The properties this site's Google access can see: its owner's sign-in, or the shared access.
    const result = await postSeoAction(props.request, { action: 'gsc-sites', id: form.id, site: buildSaveSiteBody(form)?.site ?? {} })
    setBusy(undefined)
    if (!result.ok) { setGscError(t('seoFailed', { error: result.error })); return }
    setGscError(undefined)
    const sites = Array.isArray(result.body['sites']) ? result.body['sites'] as { siteUrl: string; permissionLevel: string }[] : []
    setGscSites(sites.filter(entry => typeof entry.siteUrl === 'string'))
  }

  const kinds: SeoPublisherKind[] = ['klipara', 'wordpress']
  const gscId = `${base}-gscProperty`
  const perWeekId = `${base}-articlesPerWeek`
  return (
    <form className={css.form} onSubmit={(event) => { event.preventDefault(); void save() }}>
      <div className={css.formHead}>
        <h4 className={css.subtitle}>{form.id === '' ? t('seoSiteFormNew') : t('seoSiteFormEdit', { name: form.name })}</h4>
        <Button variant="ghost" size="sm" onClick={props.onClose}>{t('seoClose')}</Button>
      </div>
      {field('name', 'name')}
      {field('baseUrl', 'baseUrl')}
      <div className={css.field}>
        <span className={css.label} id={`${base}-kind`}>{t('seoSite.kind')}</span>
        <div className={css.row} role="radiogroup" aria-labelledby={`${base}-kind`}>
          {kinds.map(kind => (
            <Button key={kind} variant={form.kind === kind ? 'primary' : 'outline'} size="sm" role="radio" aria-checked={form.kind === kind}
              onClick={() => { set('kind', kind) }}>{t(`seoKind.${kind}`)}</Button>
          ))}
        </div>
        <p className={css.hint}>{t('seoSite.kind.hint')}</p>
      </div>
      <div className={css.field}>
        <div className={css.row}>
          <Switch label={t('seoSite.enabled')} checked={form.enabled} onChange={(next) => { set('enabled', next) }} />
          <span className={css.label}>{t('seoSite.enabled')}</span>
        </div>
        <p className={css.hint}>{t('seoSite.enabled.hint')}</p>
      </div>

      <h4 className={css.subtitle}>{t('seoSiteProfile')}</h4>
      {field('business', 'business', { multiline: true })}
      {field('audience', 'audience', { multiline: true })}
      {field('offer', 'offer', { multiline: true })}
      {field('voice', 'voice', { multiline: true })}
      {field('ctaText', 'ctaText')}
      {field('ctaUrl', 'ctaUrl')}

      <h4 className={css.subtitle}>{t('seoSiteResearch')}</h4>
      <fieldset className={css.fieldset}>
        <legend className={css.label}>{t('seoSite.markets')}</legend>
        <div className={css.markets}>
          {SEO_MARKETS.map(market => (
            <Checkbox key={market.key} label={t(`seoMarket.${market.key}`)} checked={form.markets.includes(market.key)}
              onChange={(next) => { set('markets', next ? [...form.markets, market.key] : form.markets.filter(key => key !== market.key)) }} />
          ))}
        </div>
        <p className={css.hint}>{t('seoSite.markets.hint')}</p>
      </fieldset>
      {field('seeds', 'seeds', { multiline: true })}
      <div className={css.field}>
        <label className={css.label} htmlFor={gscId}>{t('seoSite.gscProperty')}</label>
        <div className={css.row}>
          <input id={gscId} className={`${css.input} ${css.grow}`} type="text" value={form.gscProperty} onChange={(event) => { set('gscProperty', event.target.value) }} />
          <Button variant="outline" size="sm" disabled={busy !== undefined} onClick={() => { void loadGsc() }}>
            {busy === 'gsc' ? t('seoGscLoading') : t('seoGscLoad')}
          </Button>
        </div>
        {gscError === undefined ? null : <p className={css.error} role="status">{gscError}</p>}
        {gscSites === undefined
          ? null
          : gscSites.length === 0
            ? <p className={css.hint} role="status">{t('seoGscEmpty')}</p>
            : (
              <select className={css.input} aria-label={t('seoGscChoose')} value={gscSites.some(entry => entry.siteUrl === form.gscProperty) ? form.gscProperty : ''}
                onChange={(event) => { if (event.target.value !== '') set('gscProperty', event.target.value) }}>
                <option value="">{t('seoGscChoose')}</option>
                {gscSites.map(entry => <option key={entry.siteUrl} value={entry.siteUrl}>{`${entry.siteUrl} (${entry.permissionLevel})`}</option>)}
              </select>
            )}
        <p className={css.hint}>{t('seoSite.gscProperty.hint')}</p>
      </div>
      <div className={css.field}>
        <label className={css.label} htmlFor={perWeekId}>{t('seoSite.articlesPerWeek')}</label>
        <input id={perWeekId} className={`${css.input} ${css.narrow}`} type="number" min={0} max={7} step={1} inputMode="numeric"
          value={form.articlesPerWeek} onChange={(event) => { set('articlesPerWeek', event.target.value) }} />
        <p className={css.hint}>{t('seoSite.articlesPerWeek.hint')}</p>
      </div>

      <h4 className={css.subtitle}>{t('seoSiteGoogle')}</h4>
      <fieldset className={css.field}>
        <legend className={css.label}>{t('seoSite.googleAccess')}</legend>
        {(['shared', 'own'] as const).map(access => (
          <label key={access} className={css.choice}>
            <input type="radio" name={`${base}-googleAccess`} checked={form.googleAccess === access} onChange={() => { set('googleAccess', access) }} />
            <span>{t(`seoGoogleAccess.${access}`)}</span>
          </label>
        ))}
        <p className={css.hint}>{t(`seoGoogleAccess.${form.googleAccess}.hint`)}</p>
      </fieldset>
      {form.googleAccess === 'own'
        ? (
          <div className={css.field}>
            {props.site?.googleConnection === null || props.site?.googleConnection === undefined || props.site.google.access !== 'own'
              ? <p className={css.hint} role="status">{t('seoSiteGoogleSaveFirst')}</p>
              : (
                <>
                  <p className={props.site.googleConnection.connected ? css.ok : css.error} role="status">
                    {props.site.googleConnection.connected
                      ? t('seoSiteGoogleConnected', { date: (props.site.googleConnection.connectedAt ?? '').slice(0, 16).replace('T', ' ') })
                      : t('seoSiteGoogleNotConnected')}
                  </p>
                  <p className={css.hint}>{t('seoSiteGoogleLink')}</p>
                  <div className={css.row}>
                    <code className={`${css.grow} ${css.link}`}>{props.site.googleConnection.connectLink}</code>
                    <Button variant="outline" size="sm" onClick={() => {
                      const link = props.site?.googleConnection?.connectLink ?? ''
                      void navigator.clipboard.writeText(link).then(() => { setLinkCopied(true) }, () => undefined)
                    }}>{linkCopied ? t('seoCopied') : t('seoCopy')}</Button>
                  </div>
                  <div className={css.row}>
                    <Button variant="outline" size="sm" onClick={() => {
                      window.open(`/seo/oauth/start?site=${encodeURIComponent(form.id)}`, 'seo-google-connect', 'popup,width=560,height=720')
                    }}>{t('seoSiteGoogleConnectHere')}</Button>
                    {props.site.googleConnection.connected
                      ? (
                        <Button variant="ghost" size="sm" disabled={busy !== undefined} onClick={() => {
                          void postSeoAction(props.request, { action: 'disconnect-site-google', id: form.id }).then(() => { props.onChanged() })
                        }}>{t('seoGoogleDisconnect')}</Button>
                      )
                      : null}
                  </div>
                </>
              )}
          </div>
        )
        : null}
      {field('adsCustomerId', 'adsCustomerId', { placeholder: '1234567890' })}
      {field('adsLoginCustomerId', 'adsLoginCustomerId', { placeholder: '8152070364' })}

      <h4 className={css.subtitle}>{t('seoSiteAuthor')}</h4>
      {field('authorName', 'authorName')}
      {field('authorUrl', 'authorUrl')}
      {field('authorBio', 'authorBio', { multiline: true })}

      <h4 className={css.subtitle}>{t('seoSiteCredentials')}</h4>
      {form.kind === 'klipara' ? secret('apiKey') : <>{secret('wpUser')}{secret('wpAppPassword')}</>}

      <div className={css.row}>
        <Button type="submit" variant="primary" size="sm" disabled={busy !== undefined}>{busy === 'save' ? t('seoSaving') : t('seoSave')}</Button>
        <Button variant="outline" size="sm" disabled={busy !== undefined || (form.kind === 'klipara' && form.id === '')} onClick={() => { void test() }}>
          {busy === 'test' ? t('seoTesting') : t('seoTest')}
        </Button>
        {form.id === '' || confirmDelete
          ? null
          : <Button variant="ghost" size="sm" disabled={busy !== undefined} onClick={() => { setConfirmDelete(true) }}>{t('seoDelete')}</Button>}
      </div>
      {confirmDelete
        ? (
          <div className={css.confirm} role="alert">
            <p className={css.hint}>{t('seoDeleteConfirm')}</p>
            <div className={css.row}>
              <Button variant="primary" size="sm" disabled={busy !== undefined} onClick={() => { void remove() }}>{t('seoDeleteYes')}</Button>
              <Button variant="ghost" size="sm" onClick={() => { setConfirmDelete(false) }}>{t('seoCancel')}</Button>
            </div>
          </div>
        )
        : null}
      {notice === undefined ? null : <p className={notice.tone === 'ok' ? css.ok : css.error} role="status">{notice.message}</p>}
    </form>
  )
}
