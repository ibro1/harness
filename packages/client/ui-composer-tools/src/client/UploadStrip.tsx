import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only merges: the composer.dock SlotMap entry and the session-scope sessionId.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { IconCloseOutline16, IconFolderOpenOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import * as store from './store.ts'
import css from './tools.module.css'

/** `t` (namespace-scoped), the session-scope `sessionId`, and the injected
 *  submit watcher (clears the strip on send). */
export type UploadStripProps = PropsRuntime<'conversation.composer.dock'>
  & PropsLocale<'composer-tools'>
  & { watchSubmit: (onSubmit: () => void) => () => void }

/**
 * Full-width strip below the input showing this session's uploads: an image
 * thumbnail or a file icon, the name, progress or the landed state, and a
 * dismiss control. State is the shared per-session store, so it reflects
 * uploads kicked off by the leading-row paperclip.
 * @param props - `sessionId`, `t`, and `watchSubmit`.
 */
export function UploadStrip({ sessionId, t, watchSubmit }: UploadStripProps) {
  const subscribe = useCallback(
    (cb: () => void) => store.subscribe(sessionId, cb),
    [sessionId],
  )
  const snapshot = useCallback(
    () => store.getSnapshot(sessionId),
    [sessionId],
  )
  const items = useSyncExternalStore(subscribe, snapshot)

  // Uploaded files (their paths sit in the draft) leave the strip when the draft
  // is sent; the watcher fires once as the input enters its submit phase. The
  // ref keeps the subscription to one per session, immune to a fresh watchSubmit
  // closure on re-render (a new one resolves the same session input anyway).
  const watchRef = useRef(watchSubmit)
  watchRef.current = watchSubmit
  useEffect(() => watchRef.current(() => { store.clear(sessionId) }), [sessionId])

  if (items.length === 0) return null

  return (
    <div className={css.strip}>
      {items.map(item => (
        <span key={item.id} className={item.status === 'error' ? `${css.chip} ${css.chipError}` : css.chip}>
          {item.isImage && item.previewUrl !== undefined
            ? <img className={css.thumb} src={item.previewUrl} alt="" />
            : <span className={css.thumbIcon}><IconFolderOpenOutline16 size={16} /></span>}
          <span className={css.name} title={item.name}>{item.name}</span>
          {item.status === 'uploading' && <span className={css.meta}>{t('pct', { pct: item.pct })}</span>}
          {item.status === 'error' && <span className={css.metaError} title={item.error ?? ''}>{t('uploadFailed')}</span>}
          <button
            type="button"
            className={css.remove}
            aria-label={t('remove', { name: item.name })}
            title={t('remove', { name: item.name })}
            onClick={() => { store.remove(sessionId, item.id) }}
          >
            <IconCloseOutline16 size={14} />
          </button>
        </span>
      ))}
    </div>
  )
}
