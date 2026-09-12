import { useCallback, useEffect, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only merge: the settings.plugin.item slot declaration.
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './social.module.css'

/** How often the card re-reads the status while it is open, in milliseconds. */
const POLL_MS = 30_000

/** One place the agent can post to, as `GET /social/status` reports it. */
interface TargetRow {
  id: string
  provider: string
  label: string
  accepts: { text: boolean; image: boolean; video: boolean }
  ready: boolean
  /**
   * How the row must read. `warning` is the case this card exists for: the
   * provider says the credential works and still explains itself, which is how
   * a token that lapses shortly is reported.
   */
  state: 'ready' | 'warning' | 'blocked'
  reason?: string
}

/** One provider, and whether disconnecting it can work from here. */
interface ProviderRow {
  name: string
  targets: number
  disconnectable: boolean
  credentialKey?: string
  sharedWith: string[]
}

/** The `GET /social/status` body. */
interface SocialStatus {
  targets: TargetRow[]
  providers: ProviderRow[]
  postWithoutApproval: string[]
}

/** The `POST /social/disconnect` body, either outcome. */
interface DisconnectResult {
  credentialKey?: string
  removed?: boolean
  error?: string
}

/** `t` from the locale; the section supplies no owner props. */
export type SocialCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'social'>

/**
 * The social plugin's card: every account, Page and channel the agent can post
 * to, how each one stands, which targets publish without asking, and a
 * Disconnect for one provider's stored credential.
 *
 * It answers two questions without a conversation — what can this post to, and
 * is any of it about to stop working — so readiness is the loudest thing on a
 * row and a provider's own sentence is shown verbatim. There is no field to
 * paste a token into: an account is connected by asking the agent, which walks
 * the provider's authorization flow. All state comes from the host /social/*
 * routes (same-origin, so the browser session gates them).
 *
 * @param props - locale copy (`t`).
 */
export function SocialCard({ t }: SocialCardProps) {
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<SocialStatus | null>(null)
  const [error, setError] = useState(false)
  const [confirming, setConfirming] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)

  const refresh = useCallback(async () => {
    try {
      const next = await fetch('/social/status').then(response => response.json() as Promise<SocialStatus>)
      setStatus(next)
      setError(false)
    } catch {
      setError(true)
    }
  }, [])

  // Poll while the card is open. Expiry is the fact worth re-reading, and it
  // moves in days, so this is slow on purpose.
  useEffect(() => {
    if (!open) return
    void refresh()
    const timer = setInterval(() => { void refresh() }, POLL_MS)
    return () => { clearInterval(timer) }
  }, [open, refresh])

  const disconnect = useCallback(async (provider: string) => {
    setConfirming(undefined)
    setNotice(undefined)
    setBusy(provider)
    try {
      const response = await fetch('/social/disconnect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider }),
      })
      const result = await response.json() as DisconnectResult
      setNotice(response.ok
        ? (result.removed === true
          ? t('disconnectDone', { provider, key: result.credentialKey ?? '' })
          : t('disconnectNothing', { provider }))
        // The host's refusal, as the host wrote it: it names what is stored or
        // what is registered, which is what makes it actionable.
        : t('disconnectFailed', { reason: result.error ?? String(response.status) }))
      await refresh()
    } catch {
      setNotice(t('disconnectFailed', { reason: t('statusError') }))
    } finally {
      setBusy(undefined)
    }
  }, [refresh, t])

  const title = t('title')

  let body: React.ReactNode
  if (status === null) {
    body = error
      ? (
        <div className={css.body}>
          <p className={css.muted}>{t('statusError')}</p>
          <button type="button" className={css.action} onClick={() => { void refresh() }}>{t('retry')}</button>
        </div>
      )
      : <div className={css.body}><p className={css.muted}>{t('loading')}</p></div>
  } else if (status.targets.length === 0) {
    body = (
      <div className={css.body}>
        <p className={css.emptyHead}>{t('emptyTitle')}</p>
        <p className={css.muted}>{t('emptyHow')}</p>
      </div>
    )
  } else {
    body = (
      <div className={css.body}>
        {notice !== undefined && <p className={css.notice}>{notice}</p>}

        <span className={css.sectionHead}>{t('targetsHeading')}</span>
        {status.providers.map((provider) => {
          const rows = status.targets.filter(row => row.provider === provider.name)
          return (
            <div key={provider.name} className={css.group}>
              <div className={css.groupHead}>
                <span className={css.provider}>{provider.name}</span>
                {provider.disconnectable
                  ? (
                    <button
                      type="button"
                      className={`${css.action} ${css.danger}`}
                      disabled={busy !== undefined}
                      onClick={() => { setConfirming(provider.name) }}
                    >
                      {busy === provider.name ? t('disconnecting') : t('disconnect')}
                    </button>
                  )
                  : <span className={css.muted}>{t('disconnectUnavailable')}</span>}
              </div>

              {confirming === provider.name && (
                <div className={css.confirm} role="group">
                  <p className={css.confirmText}>{t('disconnectAsk', { provider: provider.name })}</p>
                  {provider.sharedWith.length > 0 && (
                    <p className={css.confirmText}>
                      {t('disconnectShared', { providers: provider.sharedWith.join(', ') })}
                    </p>
                  )}
                  <div className={css.confirmActions}>
                    <button
                      type="button"
                      className={`${css.action} ${css.danger}`}
                      onClick={() => { void disconnect(provider.name) }}
                    >
                      {t('confirm')}
                    </button>
                    <button
                      type="button"
                      className={css.action}
                      onClick={() => { setConfirming(undefined) }}
                    >
                      {t('cancel')}
                    </button>
                  </div>
                </div>
              )}

              <ul className={css.rows}>
                {rows.map((row) => {
                  const kinds = [
                    ...row.accepts.text ? [t('acceptsText')] : [],
                    ...row.accepts.image ? [t('acceptsImage')] : [],
                    ...row.accepts.video ? [t('acceptsVideo')] : [],
                  ]
                  return (
                    <li key={row.id} className={`${css.row} ${css[row.state]}`}>
                      <span className={css.rowHead}>
                        <span className={css.name}>{row.label}</span>
                        <span className={`${css.badge} ${css[row.state]}`}>
                          {t(row.state === 'ready'
                            ? 'stateReady'
                            : row.state === 'warning' ? 'stateWarning' : 'stateBlocked')}
                        </span>
                      </span>
                      <code className={css.id}>{row.id}</code>
                      <span className={css.accepts}>
                        {t('acceptsLabel')}
                        {' '}
                        {kinds.length === 0 ? t('acceptsNothing') : kinds.join(', ')}
                      </span>
                      {/* Verbatim: these sentences were written to tell a
                          person what to do next. */}
                      {row.reason !== undefined && <p className={css.reason}>{row.reason}</p>}
                    </li>
                  )
                })}
              </ul>
            </div>
          )
        })}

        {status.postWithoutApproval.length > 0 && (
          <div className={css.exempt}>
            <span className={css.sectionHead}>{t('exemptHeading')}</span>
            <ul className={css.exemptList}>
              {status.postWithoutApproval.map(id => <li key={id}><code className={css.id}>{id}</code></li>)}
            </ul>
            <p className={css.muted}>{t('exemptHint')}</p>
          </div>
        )}
      </div>
    )
  }

  return (
    <li className={open ? `${css.card} ${css.cardOpen}` : css.card}>
      <button
        type="button"
        className={css.header}
        aria-expanded={open}
        aria-label={`${t(open ? 'collapse' : 'expand')}: ${title}`}
        onClick={() => { setOpen(!open) }}
      >
        <span className={css.headText}>
          <span className={css.name}>{title}</span>
          <span className={css.description}>{t('description')}</span>
        </span>
        <IconChevronDownOutline14 className={open ? `${css.chevron} ${css.chevronOpen}` : css.chevron} />
      </button>
      {open ? body : null}
    </li>
  )
}
