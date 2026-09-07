import { useRef, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only merges: the input.left SlotMap entry and the session-scope base.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import css from './tools.module.css'

/** `t` (namespace-scoped) plus the injected composer-draft writer. */
export type VoiceControlProps = PropsRuntime<'conversation.input.left'>
  & PropsLocale<'composer-tools'>
  & { insertDraft: (text: string) => void }

/** Host relay; matches composer-tools.mjs's default voicePath. */
const VOICE_PATH = '/voice-transcribe'

/** Container preferences: opus in webm is the broad default; mp4 is the Safari
 *  fallback. All are accepted by Groq Whisper. */
const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']

function pickMime(): string {
  if (typeof MediaRecorder === 'undefined') return ''
  for (const mime of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(mime)) return mime
  }
  return ''
}

type Status =
  | { kind: 'idle' }
  | { kind: 'recording' }
  | { kind: 'transcribing' }
  | { kind: 'error'; text: string }

/** A simple microphone glyph (no mic primitive ships in ui-primitives). */
function MicGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="6" y="1.5" width="4" height="8" rx="2" fill="currentColor" />
      <path d="M3.5 7.5a4.5 4.5 0 0 0 9 0" stroke="currentColor" strokeWidth="1.3" fill="none" strokeLinecap="round" />
      <line x1="8" y1="12" x2="8" y2="14.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

/**
 * Leading-row icon that records speech, transcribes it through the host relay
 * (Groq Whisper), and appends the text to the composer draft. The API key never
 * reaches the browser — the relay holds it. Errors surface on the button's
 * title and a red tint until the next click.
 * @param props - `t` and the injected `insertDraft`.
 */
export function VoiceControl({ t, insertDraft }: VoiceControlProps) {
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])

  // mediaDevices is absent in insecure contexts, and MediaRecorder in older
  // browsers, despite the DOM types claiming both are always present.
  const mediaDevices = navigator.mediaDevices as MediaDevices | undefined
  const supported = mediaDevices !== undefined && typeof MediaRecorder !== 'undefined'

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
        // Non-JSON error page; handled below.
      }
      if (!resp.ok) {
        setStatus({
          kind: 'error',
          text: resp.status === 503 ? t('voice.errorKey') : t('voice.error', { message: body.error ?? String(resp.status) }),
        })
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
        void send(new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' }))
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
  const label = recording ? t('voice.stop')
    : status.kind === 'transcribing' ? t('voice.transcribing')
      : status.kind === 'error' ? status.text
        : t('voice.record')

  return (
    <button
      type="button"
      className={recording ? `${css.icon} ${css.recording}` : css.icon}
      aria-label={label}
      title={label}
      disabled={!supported || status.kind === 'transcribing'}
      onMouseDown={(event) => { event.preventDefault() }}
      onClick={onClick}
    >
      <MicGlyph />
    </button>
  )
}
