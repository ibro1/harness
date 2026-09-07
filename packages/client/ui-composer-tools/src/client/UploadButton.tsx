import { useRef, useState, type ChangeEvent } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only merges: composer.dock SlotMap entry and the session-scope sessionId.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import css from './UploadButton.module.css'

/** The framework supplies `t` (namespace-scoped) and, on a session-scoped slot,
 *  the current `sessionId`. */
export type UploadButtonProps = PropsRuntime<'conversation.composer.dock'> & PropsLocale<'composer-tools'>

/** The host route the composer posts to; matches composer-tools.mjs's default. */
const UPLOAD_PATH = '/workspace-upload'

type Status =
  | { kind: 'idle' }
  | { kind: 'uploading'; name: string; pct: number }
  | { kind: 'done'; name: string; path: string }
  | { kind: 'error'; serverError?: string; httpStatus?: number }

/**
 * Compose-dock control: pick a file and stream it to the current session's
 * workspace. Progress and result are local component state; the landed path is
 * shown so the user (and the agent, once told) can reference it.
 * @param props - framework-supplied `sessionId` and `t`.
 */
export function UploadButton({ sessionId, t }: UploadButtonProps) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })

  const onPick = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file === undefined || sessionId === undefined) return

    const xhr = new XMLHttpRequest()
    xhr.open(
      'POST',
      `${UPLOAD_PATH}?session=${encodeURIComponent(sessionId)}&name=${encodeURIComponent(file.name)}`,
    )
    xhr.upload.onprogress = (progress) => {
      if (progress.lengthComputable) {
        setStatus({ kind: 'uploading', name: file.name, pct: Math.round((progress.loaded / progress.total) * 100) })
      }
    }
    xhr.onload = () => {
      let body: { path?: string; error?: string } = {}
      try {
        body = JSON.parse(xhr.responseText) as { path?: string; error?: string }
      } catch {
        // A non-JSON body (e.g. an error page); fall through to the status branch.
      }
      if (xhr.status === 200 && typeof body.path === 'string') {
        setStatus({ kind: 'done', name: file.name, path: body.path })
      } else {
        setStatus({
          kind: 'error',
          httpStatus: xhr.status,
          ...(body.error !== undefined ? { serverError: body.error } : {}),
        })
      }
    }
    xhr.onerror = () => { setStatus({ kind: 'error' }) }
    setStatus({ kind: 'uploading', name: file.name, pct: 0 })
    xhr.send(file)
  }

  const errorText = (s: Extract<Status, { kind: 'error' }>): string => {
    if (s.serverError !== undefined) return t('error', { message: s.serverError })
    if (s.httpStatus !== undefined && s.httpStatus !== 0) return t('errorHttp', { status: s.httpStatus })
    return t('errorNetwork')
  }

  return (
    <span className={css.root}>
      <button
        type="button"
        className={css.button}
        aria-label={t('upload')}
        disabled={sessionId === undefined || status.kind === 'uploading'}
        onClick={() => { inputRef.current?.click() }}
      >
        {t('upload')}
      </button>
      <input ref={inputRef} type="file" className={css.hidden} onChange={onPick} />
      {status.kind === 'uploading' && (
        <span className={css.status}>{t('uploading', { name: status.name, pct: status.pct })}</span>
      )}
      {status.kind === 'done' && (
        <span className={css.status}>
          {t('done', { name: status.name })} <code className={css.path}>{status.path}</code>
        </span>
      )}
      {status.kind === 'error' && <span className={css.error}>{errorText(status)}</span>}
    </span>
  )
}
