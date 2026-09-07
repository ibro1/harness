import { useRef, type ChangeEvent } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only merges: the input.left SlotMap entry and the session-scope sessionId.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { IconPaperclipOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import * as store from './store.ts'
import css from './tools.module.css'

/** `t` (namespace-scoped), the session-scope `sessionId`, the composer-draft
 *  writer, and the vision-attachment router for images. */
export type UploadControlProps = PropsRuntime<'conversation.input.left'>
  & PropsLocale<'composer-tools'>
  & {
    insertDraft: (text: string) => void
    attachImages: (files: readonly File[]) => string | null
  }

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
 * Leading-row icon that picks one or more files. Images route through the
 * built-in vision attachment (a thumbnail that persists in the sent message,
 * with no path text); every other file uploads into the current session's
 * workspace in parallel, with rows and progress in the shared store (rendered
 * by UploadStrip) and one draft note listing the landed paths when the batch
 * finishes.
 * @param props - `sessionId`, `t`, `insertDraft`, and `attachImages`.
 */
export function UploadControl({ sessionId, t, insertDraft, attachImages }: UploadControlProps) {
  const inputRef = useRef<HTMLInputElement | null>(null)

  const onPick = (event: ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(event.target.files ?? [])
    event.target.value = ''
    if (picked.length === 0) return

    // Images go to the vision attachment; only if that rejects the media type
    // (a non-null message) do they fall back to a workspace upload, so nothing
    // a user picked is ever silently lost.
    const images = picked.filter(file => file.type.startsWith('image/'))
    const others = picked.filter(file => !file.type.startsWith('image/'))
    const fallback = images.length > 0 && attachImages(images) !== null ? images : []
    const files = [...others, ...fallback]
    if (files.length === 0) return

    const items = store.addItems(sessionId, files)
    const landed: { name: string; path: string }[] = []
    let remaining = files.length
    const done = (name: string, path: string | undefined) => {
      if (path !== undefined) landed.push({ name, path })
      remaining -= 1
      if (remaining === 0 && landed.length > 0) {
        // Just the path(s): the agent needs them to read the workspace files,
        // and a preamble only clutters the prompt.
        insertDraft(landed.map(l => l.path).join(' '))
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
