import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only merge: the settings.plugin.item slot declaration.
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import { renderSVG } from 'uqr'
import css from './whatsapp.module.css'

/** Connection snapshot from the host /whatsapp/status route. */
interface WaStatus {
  loggedIn: boolean
  connected: boolean
  jid?: string
  name?: string
  qr?: string
  qrExpiresInSec?: number
}

/** One outbound message awaiting the operator's approval. */
interface PendingItem {
  id: string
  to: string
  name: string
  text: string
  createdAt: number
}

/** `t` from the locale; the section supplies no owner props. */
export type WhatsAppCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'whatsapp'>

/**
 * The WhatsApp plugin's card: link an account by scanning a QR, see the linked
 * state, disconnect, and approve or discard the messages the agent has queued
 * to send. All state comes from the host /whatsapp/* routes (same-origin, so
 * the browser session gates them); the card polls while open.
 * @param props - locale copy (`t`).
 */
export function WhatsAppCard({ t }: WhatsAppCardProps) {
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<WaStatus | null>(null)
  const [pending, setPending] = useState<PendingItem[]>([])
  const [error, setError] = useState(false)
  const [busy, setBusy] = useState(false)

  const qrRef = useRef<string | undefined>(undefined)

  const refresh = useCallback(async () => {
    try {
      const [s, p] = await Promise.all([
        fetch('/whatsapp/status').then(r => r.json() as Promise<WaStatus>),
        fetch('/whatsapp/pending').then(r => r.json() as Promise<{ pending?: PendingItem[] }>),
      ])
      setStatus(s)
      qrRef.current = s.qr
      setPending(p.pending ?? [])
      setError(false)
    } catch {
      setError(true)
    }
  }, [])

  // Poll while the card is open — every 2s while a QR is showing (it rotates),
  // every 4s otherwise. A self-rescheduling timer reads the latest QR state
  // through a ref so the cadence follows it without re-subscribing.
  useEffect(() => {
    if (!open) return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const loop = () => {
      void refresh().finally(() => {
        if (!alive) return
        timer = setTimeout(loop, qrRef.current !== undefined ? 2000 : 4000)
      })
    }
    loop()
    return () => { alive = false; clearTimeout(timer) }
  }, [open, refresh])

  const post = useCallback(async (path: string, body?: unknown) => {
    setBusy(true)
    try {
      await fetch(path, body === undefined
        ? { method: 'POST' }
        : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      await refresh()
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }, [refresh])

  const qrDataUrl = useMemo(() => {
    if (status?.qr === undefined) return null
    return `data:image/svg+xml;utf8,${encodeURIComponent(renderSVG(status.qr, { border: 2 }))}`
  }, [status?.qr])

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
  } else {
    body = (
      <div className={css.body}>
        {status.loggedIn
          ? (
            <div className={css.connected}>
              <span className={css.connectedName}>{t('connectedAs', { name: status.name ?? status.jid ?? '' })}</span>
              {status.jid !== undefined && <span className={css.jid}>{status.jid}</span>}
              <button
                type="button"
                className={`${css.action} ${css.danger}`}
                disabled={busy}
                onClick={() => { void post('/whatsapp/logout') }}
              >
                {busy ? t('disconnecting') : t('disconnect')}
              </button>
            </div>
          )
          : qrDataUrl !== null
            ? (
              <div className={css.qrWrap}>
                <img className={css.qr} src={qrDataUrl} alt={t('link')} />
                <p className={css.hint}>{t('scanHint')}</p>
                <p className={css.muted}>{t('qrRefresh')}</p>
              </div>
            )
            : (
              <button
                type="button"
                className={`${css.action} ${css.primary}`}
                disabled={busy}
                onClick={() => { void post('/whatsapp/login') }}
              >
                {busy ? t('linking') : t('link')}
              </button>
            )}

        <div className={css.pending}>
          <span className={css.pendingHead}>{t('pendingTitle')}</span>
          {pending.length === 0
            ? <p className={css.muted}>{t('pendingEmpty')}</p>
            : (
              <ul className={css.pendingList}>
                {pending.map(item => (
                  <li key={item.id} className={css.pendingRow}>
                    <span className={css.pendingTo}>{t('pendingTo', { name: item.name || item.to })}</span>
                    <span className={css.pendingText}>{item.text}</span>
                    <div className={css.pendingActions}>
                      <button
                        type="button"
                        className={`${css.action} ${css.primary}`}
                        disabled={busy}
                        onClick={() => { void post('/whatsapp/approve', { id: item.id }) }}
                      >
                        {t('approve')}
                      </button>
                      <button
                        type="button"
                        className={`${css.action} ${css.danger}`}
                        disabled={busy}
                        onClick={() => { void post('/whatsapp/discard', { id: item.id }) }}
                      >
                        {t('discard')}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
        </div>
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
