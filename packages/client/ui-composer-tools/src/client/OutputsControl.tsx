import { useCallback, useState, type ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only merges: the input.left SlotMap entry and the session-scope sessionId.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import {
  Modal,
  IconFolderOpenOutline16,
  IconDownloadOutline16,
  IconRefreshOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import css from './tools.module.css'

/** One output file, as the host's /workspace-files route reports it. */
interface OutputFile {
  name: string
  rel: string
  bytes: number
  mtime: number
  kind: 'video' | 'image' | 'audio' | 'other'
}

/** `sessionId` from the runtime and `t` from the locale. */
export type OutputsControlProps = PropsRuntime<'conversation.input.left'>
  & PropsLocale<'composer-tools'>

/**
 * Leading-row icon that opens a panel of this session's outputs (its `edit/`
 * directory): each file previews inline (video/image/audio) and downloads with
 * one tap. Fills the gap where the agent could only hand back a container path.
 * @param props - `sessionId` and `t`.
 */
export function OutputsControl({ sessionId, t }: OutputsControlProps) {
  const [open, setOpen] = useState(false)
  const [files, setFiles] = useState<OutputFile[] | null>(null)
  const [error, setError] = useState(false)
  const [loading, setLoading] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    setError(false)
    void fetch(`/workspace-files?session=${encodeURIComponent(sessionId)}`)
      .then(response => (response.ok
        ? response.json() as Promise<{ files?: OutputFile[] }>
        : Promise.reject(new Error(String(response.status)))))
      .then((body) => { setFiles(body.files ?? []) })
      .catch(() => { setError(true); setFiles([]) })
      .finally(() => { setLoading(false) })
  }, [sessionId])

  // `inline` previews in place; without it the browser downloads (attachment).
  const url = (rel: string, inline: boolean) =>
    `/workspace-download?session=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(rel)}${inline ? '&inline=1' : ''}`

  // Units come from the locale (the i18n gate rejects them as JS literals).
  const sizeLabel = (bytes: number): string => {
    if (bytes >= 1024 * 1024) return t('outputs.mb', { n: (bytes / 1024 / 1024).toFixed(1) })
    if (bytes >= 1024) return t('outputs.kb', { n: String(Math.round(bytes / 1024)) })
    return t('outputs.b', { n: String(bytes) })
  }

  const preview = (file: OutputFile): ReactNode => {
    if (file.kind === 'video') return <video className={css.outMedia} src={url(file.rel, true)} controls preload="metadata" />
    if (file.kind === 'image') return <img className={css.outMedia} src={url(file.rel, true)} alt={file.name} />
    if (file.kind === 'audio') return <audio className={css.outAudio} src={url(file.rel, true)} controls preload="metadata" />
    return null
  }

  let body: ReactNode
  if (loading && files === null) body = <p className={css.outMuted}>{t('outputs.loading')}</p>
  else if (error) body = <p className={css.outMuted}>{t('outputs.error')}</p>
  else if (files === null || files.length === 0) body = <p className={css.outMuted}>{t('outputs.empty')}</p>
  else {
    body = (
      <ul className={css.outList}>
        {files.map(file => (
          <li key={file.rel} className={css.outRow}>
            {preview(file) !== null && <div className={css.outPreview}>{preview(file)}</div>}
            <div className={css.outInfo}>
              <span className={css.outName} title={file.name}>{file.name}</span>
              <span className={css.outSize}>{sizeLabel(file.bytes)}</span>
            </div>
            <a
              className={css.outDownload}
              href={url(file.rel, false)}
              download={file.name}
              aria-label={t('outputs.download', { name: file.name })}
              title={t('outputs.download', { name: file.name })}
            >
              <IconDownloadOutline16 size={16} />
            </a>
          </li>
        ))}
      </ul>
    )
  }

  return (
    <>
      <button
        type="button"
        className={css.icon}
        aria-label={t('outputs')}
        title={t('outputs')}
        onMouseDown={(event) => { event.preventDefault() }}
        onClick={() => { setOpen(true); load() }}
      >
        <IconFolderOpenOutline16 size={16} />
      </button>
      <Modal
        open={open}
        onClose={() => { setOpen(false) }}
        title={t('outputs.title')}
        closeLabel={t('outputs.close')}
      >
        <div className={css.outContent}>
          <div className={css.outBar}>
            <button type="button" className={css.outRefresh} onClick={() => { load() }} disabled={loading}>
              <IconRefreshOutline16 size={16} />
              <span>{t('outputs.refresh')}</span>
            </button>
          </div>
          {body}
        </div>
      </Modal>
    </>
  )
}
