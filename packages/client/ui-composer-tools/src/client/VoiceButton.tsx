import { useRef, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only merges: composer.dock SlotMap entry and the session-scope base.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import css from './VoiceButton.module.css'

/** `t` (namespace-scoped) plus the injected composer-draft writer. */
export type VoiceButtonProps = PropsRuntime<'conversation.composer.dock'>
  & PropsLocale<'composer-tools'>
  & { insertDraft(text: string): void }

/** Host relay; matches composer-tools.mjs's default voicePath. */
const VOICE_PATH = '/voice-transcribe'

/** Recorder container preferences: opus in webm is the broad default; mp4 is
 *  the Safari fallback. All are accepted by Groq Whisper. */
const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']

function pickMime(): string {
  if (typeof MediaRecorder === 'undefined') return ''
  for (const m of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(m)) return m
  }
  return ''
}

type Status =
  | { kind: 'idle' }
  | { kind: 'recording' }
  | { kind: 'transcribing' }
  | { kind: 'error'; text: string }

/**
 * Compose-dock control: record speech, transcribe it through the host relay
 * (Groq Whisper), and append the text to the composer draft. The API key never
 * reaches the browser — the relay holds it.
 * @param props - `t` and the injected `insertDraft`.
 */
export function VoiceButton({ t, insertDraft }: VoiceButtonProps) {
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])

  const supported = typeof navigator !== 'undefined'
    && navigator.mediaDevices !== undefined
    && typeof MediaRecorder !== 'undefined'

  const send = async (blob: Blob) => {
    setStatus({ kind: 'transcribing' })
    try {
      const resp = await fetch(VOICE_PATH, {
        method: 'POST',
        headers: { 'content-type': blob.type || 'audio/webm' },
        body: blob,
      })
      let body: { text?: string; error?: string } = {}
      try {
        body = await resp.json() as { text?: string; error?: string }
      } catch {
        // non-JSON error page; handled by the status branch below.
      }
      if (!resp.ok) {
        const message = resp.status === 503 ? t('voice.errorKey') : t('voice.error', { message: body.error ?? String(resp.status) })
        setStatus({ kind: 'error', text: message })
        return
      }
      const text = (body.text ?? '').trim()
      if (text === '') {
        setStatus({ kind: 'error', text: t('voice.empty') })
        return
      }
      insertDraft(text)
      setStatus({ kind: 'idle' })
    } catch {
      setStatus({ kind: 'error', text: t('voice.errorNetwork') })
    }
  }

  const start = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mime = pickMime()
      const recorder = new MediaRecorder(stream, mime === '' ? undefined : { mimeType: mime })
      chunksRef.current = []
      recorder.ondataavailable = (event) => { if (event.data.size > 0) chunksRef.current.push(event.data) }
      recorder.onstop = () => {
        for (const track of stream.getTracks()) track.stop()
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' })
        void send(blob)
      }
      recorderRef.current = recorder
      recorder.start()
      setStatus({ kind: 'recording' })
    } catch {
      setStatus({ kind: 'error', text: t('voice.errorMic') })
    }
  }

  const stop = () => {
    recorderRef.current?.stop()
    recorderRef.current = null
  }

  const onClick = () => {
    if (status.kind === 'recording') stop()
    else if (status.kind === 'idle' || status.kind === 'error') void start()
  }

  const recording = status.kind === 'recording'
  return (
    <span className={css.root}>
      <button
        type="button"
        className={recording ? css.recording : css.button}
        aria-label={recording ? t('voice.stop') : t('voice.record')}
        disabled={!supported || status.kind === 'transcribing'}
        onClick={onClick}
      >
        {recording ? t('voice.stop') : t('voice.record')}
      </button>
      {status.kind === 'recording' && <span className={css.status}>{t('voice.recording')}</span>}
      {status.kind === 'transcribing' && <span className={css.status}>{t('voice.transcribing')}</span>}
      {status.kind === 'error' && <span className={css.error}>{status.text}</span>}
    </span>
  )
}
