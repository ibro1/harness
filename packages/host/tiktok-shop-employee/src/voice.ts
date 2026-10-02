/**
 * The voiceover: one WAV per spoken line, from one of three providers.
 *
 * - `groq`: Orpheus on Groq, called directly. Free-tier friendly; the Groq
 *   organisation must accept the model's terms once in the Groq console.
 * - `gemini` and `elevenlabs`: through video-use's `speak.py`, which reads its
 *   own keys and caches by text, so a re-render of the same script costs nothing.
 *
 * Calls are made one at a time with a pause between them, and a rate-limit
 * answer (HTTP 429) is retried after a longer wait: Gemini's free tier allows
 * only a few speech requests a minute.
 */

import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'

/** The voice providers. */
export type VoiceProvider = 'groq' | 'gemini' | 'elevenlabs'

/** Every provider, for settings validation. */
export const VOICE_PROVIDERS: readonly VoiceProvider[] = ['groq', 'gemini', 'elevenlabs']

/** How one line is spoken. */
export interface VoiceSettings {
  provider: VoiceProvider
  /** Groq or Gemini voice name, or ElevenLabs voice id; empty uses the provider's default. */
  voice: string
  /** Gemini only: the delivery, in words ("upbeat British TikTok voiceover, quick pace"). */
  style: string
  /** Groq's API key; Gemini and ElevenLabs keys are read by `speak.py`. */
  groqApiKey: string
  /** Path of video-use's `speak.py`. */
  speakScript: string
  /** Pause after each call, in milliseconds. */
  pauseMs: number
}

/** Groq's Orpheus speech model and its default voice. */
const GROQ_MODEL = 'canopylabs/orpheus-v1-english'
const GROQ_DEFAULT_VOICE = 'troy'

/** Waits after a rate-limit answer, in milliseconds, before each retry. */
const RATE_LIMIT_WAITS = [20_000, 40_000, 60_000]

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason instanceof Error ? signal.reason : new Error('aborted')) }, { once: true })
  })
}

/** A provider's refusal that a wait may cure. */
class RateLimited extends Error {}

async function groqSpeak(fetcher: typeof fetch, settings: VoiceSettings, text: string, out: string, signal: AbortSignal): Promise<void> {
  if (settings.groqApiKey.trim() === '') throw new Error('No Groq API key is saved for the voiceover.')
  const response = await fetcher('https://api.groq.com/openai/v1/audio/speech', {
    method: 'POST',
    signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
    headers: { 'Authorization': `Bearer ${settings.groqApiKey.trim()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: GROQ_MODEL, voice: settings.voice.trim() || GROQ_DEFAULT_VOICE, input: text, response_format: 'wav' }),
  })
  if (response.status === 429) throw new RateLimited('Groq speech is rate-limited')
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    const terms = /model_terms_required/u.test(body) ? ' Accept the Orpheus model terms once in the Groq console (Playground, canopylabs/orpheus-v1-english).' : ''
    throw new Error(`Groq speech answered HTTP ${String(response.status)}.${terms} ${body.slice(0, 200)}`)
  }
  await writeFile(out, Buffer.from(await response.arrayBuffer()))
}

function speakScript(settings: VoiceSettings, text: string, out: string, signal: AbortSignal): Promise<void> {
  const args = [settings.speakScript, text, '--provider', settings.provider, '-o', out]
  if (settings.voice.trim() !== '') args.push('--voice', settings.voice.trim())
  if (settings.provider === 'gemini' && settings.style.trim() !== '') args.push('--style', settings.style.trim())
  return new Promise((resolve, reject) => {
    execFile('python3', args, { signal, timeout: 180_000, maxBuffer: 4 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (error === null) { resolve(); return }
      const message = (stderr || error.message).trim().split('\n').slice(-2).join(' ')
      reject(/429|rate-limit/iu.test(message) ? new RateLimited(message) : new Error(`The voiceover failed: ${message}`))
    })
  })
}

/**
 * A function that speaks one line into a WAV file, pacing and retrying calls.
 * @param settings - provider, voice and keys, read once per call.
 * @param fetcher - HTTP for Groq.
 * @returns the speaker.
 */
export function createSpeaker(
  settings: () => VoiceSettings, fetcher: typeof fetch = fetch,
): (text: string, out: string, signal: AbortSignal) => Promise<void> {
  return async (text, out, signal) => {
    const current = settings()
    for (let attempt = 0; ; attempt++) {
      try {
        if (current.provider === 'groq') await groqSpeak(fetcher, current, text, out, signal)
        else await speakScript(current, text, out, signal)
        if (current.pauseMs > 0) await sleep(current.pauseMs, signal)
        return
      } catch (error) {
        const wait = RATE_LIMIT_WAITS[attempt]
        if (!(error instanceof RateLimited) || wait === undefined) {
          throw error instanceof RateLimited ? new Error(`The ${current.provider} voice stayed rate-limited after ${String(RATE_LIMIT_WAITS.length)} retries; its daily quota may be spent.`) : error
        }
        await sleep(wait, signal)
      }
    }
  }
}
