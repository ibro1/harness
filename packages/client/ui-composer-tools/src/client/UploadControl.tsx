import { useRef, type ChangeEvent } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only merges: the input.left SlotMap entry and the session-scope sessionId.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { IconPaperclipOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import * as store from './store.ts'
import css from './tools.module.css'

/** `t` (namespace-scoped), the session-scope `sessionId`, and the injected
 *  composer-draft writer. */
export type UploadControlProps = PropsRuntime<'conversation.input.left'>
  & PropsLocale<'composer-tools'>
  & { insertDraft: (text: string) => void }

/** Host route; matches composer-tools.mjs's default path. */
const UPLOAD_PATH = '/workspace-upload'

/** Stream one file to the workspace, updating its store row; `done` fires once
 *  with the landed path (or undefined on failure) so the caller can batch the
 *  single draft note across a multi-file pick. */
function uploadOne(
  sessionId: string,
  id: string,
  file: File,
  done: (name: string, path: string | undefined) => void,
): void {
  const xhr = new XMLHttpRequest()
  xhr.open('POST', `${UPLOAD_PATH}?session=${encodeURIComponent(sessionId)}&name=${encodeURIComponent(file.name)}`)
  xhr.upload.onprogress = (progress) => {
    if (progress.lengthComputable) {
      store.setProgress(sessionId, id, Math.round((progress.loaded / progress.total) * 100))
    }
  }
  xhr.onload = () => {
    let body: { path?: string; error?: string } = {}
    try {
      body = JSON.parse(xhr.responseText) as { path?: string; error?: string }
    } catch {
      // Non-JSON body (an error page); handled by the status branch below.
    }
    if (xhr.status === 200 && typeof body.path === 'string') {
      store.setDone(sessionId, id, body.path)
      done(file.name, body.path)
    } else {
      store.setError(sessionId, id, body.error ?? `HTTP ${String(xhr.status)}`)
      done(file.name, undefined)
    }
  }
  xhr.onerror = () => {
    store.setError(sessionId, id, 'network')
    done(file.name, undefined)
  }
  xhr.send(file)
}

/**
 * Leading-row icon that picks one or more files and uploads each into the
 * current session's workspace in parallel. Rows and progress live in the shared
 * store (rendered by UploadStrip); when the whole pick finishes, one draft note
 * lists what landed.
 * @param props - `sessionId`, `t`, and `insertDraft`.
 */
export function UploadControl({ sessionId, t, insertDraft }: UploadControlProps) {
  const inputRef = useRef<HTMLInputElement | null>(null)

  const onPick = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    event.target.value = ''
    if (files.length === 0) return

    const items = store.addItems(sessionId, files)
    const landed: { name: string; path: string }[] = []
    let remaining = files.length
    const done = (name: string, path: string | undefined) => {
      if (path !== undefined) landed.push({ name, path })
      remaining -= 1
      if (remaining === 0 && landed.length > 0) {
        insertDraft(t('insertNote', {
          names: landed.map(l => l.name).join(', '),
          paths: landed.map(l => l.path).join(', '),
        }))
      }
    }
    // `items` is 1:1 with `files` (addItems preserves order); pairing avoids a
    // non-null index assertion. The guard keeps `remaining` honest if a slot is
    // ever missing.
    items.forEach((item, index) => {
      const file = files[index]
      if (file === undefined) { done('', undefined); return }
      uploadOne(sessionId, item.id, file, done)
    })
  }

  return (
    <>
      <button
        type="button"
        className={css.icon}
        aria-label={t('upload')}
        title={t('upload')}
        onMouseDown={(event) => { event.preventDefault() }}
        onClick={() => { inputRef.current?.click() }}
      >
        <IconPaperclipOutline16 size={16} />
      </button>
      <input ref={inputRef} type="file" multiple className={css.hidden} onChange={onPick} />
    </>
  )
}
