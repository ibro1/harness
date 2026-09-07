/**
 * Module-level, per-session upload store shared by the two composer slots: the
 * paperclip control (conversation.input.left) writes to it while uploading, and
 * the preview strip (conversation.composer.dock) reads it — they are separate
 * slot components, so a plain React state won't reach across. Consumed with
 * useSyncExternalStore, so getSnapshot returns a stable array reference until a
 * mutation replaces it.
 */

/** One file's row in a session's upload strip. */
export interface UploadItem {
  readonly id: string
  readonly name: string
  readonly isImage: boolean
  /** Object URL for an image preview; revoked on removal. */
  readonly previewUrl?: string
  readonly status: 'uploading' | 'done' | 'error'
  readonly pct: number
  readonly path?: string
  readonly error?: string
}

interface Bucket {
  items: readonly UploadItem[]
  readonly listeners: Set<() => void>
}

const buckets = new Map<string, Bucket>()

/** Shared stable empty snapshot (no session, or nothing uploaded yet). */
export const EMPTY: readonly UploadItem[] = []

let counter = 0

function bucket(sessionId: string): Bucket {
  let b = buckets.get(sessionId)
  if (b === undefined) {
    b = { items: EMPTY, listeners: new Set() }
    buckets.set(sessionId, b)
  }
  return b
}

function emit(b: Bucket): void {
  for (const listener of b.listeners) listener()
}

/** Subscribe a component to one session's strip. */
export function subscribe(sessionId: string, callback: () => void): () => void {
  const b = bucket(sessionId)
  b.listeners.add(callback)
  return () => { b.listeners.delete(callback) }
}

/** Current items for a session; a stable reference until the next mutation. */
export function getSnapshot(sessionId: string): readonly UploadItem[] {
  return buckets.get(sessionId)?.items ?? EMPTY
}

/** Stage picked files as uploading rows; returns them in the input order. */
export function addItems(sessionId: string, files: readonly File[]): readonly UploadItem[] {
  const b = bucket(sessionId)
  const created = files.map((file): UploadItem => {
    const isImage = file.type.startsWith('image/')
    return {
      id: `u${String(++counter)}`,
      name: file.name,
      isImage,
      status: 'uploading',
      pct: 0,
      ...(isImage ? { previewUrl: URL.createObjectURL(file) } : {}),
    }
  })
  b.items = [...b.items, ...created]
  emit(b)
  return created
}

function patch(sessionId: string, id: string, next: Partial<UploadItem>): void {
  const b = buckets.get(sessionId)
  if (b === undefined) return
  b.items = b.items.map(item => (item.id === id ? { ...item, ...next } : item))
  emit(b)
}

/** Update one row's upload progress. */
export function setProgress(sessionId: string, id: string, pct: number): void {
  patch(sessionId, id, { status: 'uploading', pct })
}

/** Mark one row done with the landed path. */
export function setDone(sessionId: string, id: string, path: string): void {
  patch(sessionId, id, { status: 'done', pct: 100, path })
}

/** Mark one row failed. */
export function setError(sessionId: string, id: string, error: string): void {
  patch(sessionId, id, { status: 'error', error })
}

/** Drop one row from the strip and free its preview URL. */
export function remove(sessionId: string, id: string): void {
  const b = buckets.get(sessionId)
  if (b === undefined) return
  const gone = b.items.find(item => item.id === id)
  if (gone?.previewUrl !== undefined) URL.revokeObjectURL(gone.previewUrl)
  b.items = b.items.filter(item => item.id !== id)
  emit(b)
}
