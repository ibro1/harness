/**
 * The voiceover: one WAV per spoken line.
 *
 * `auto` (the default) tries Gemini first and Groq last: every Gemini key in
 * the environment (`GEMINI_API_KEY`, then `GEMINI_API_KEY_1` … `_9`), then
 * every Groq key (the one saved on the settings page, `GROQ_API_KEY`, then
 * `GROQ_API_KEY_1` … `_9`). A key that answers with a rate limit or a spent
 * quota rests (a minute for a per-minute limit, until tomorrow for a daily
 * one), any other failure rests it ten minutes, and the next key takes the
 * line at once, so one busy or broken key never stalls a render. `gemini` and `groq` use only that provider's keys; `elevenlabs` goes
 * through video-use's `speak.py`, which reads its own key.
 *
 * Gemini and Groq are called directly: Gemini returns raw 16-bit PCM, wrapped
 * here in a WAV header; Groq's Orpheus returns WAV. Groq's organisation must
 * accept the Orpheus model terms once in the Groq console.
 */

import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'

/** The voice providers. */
export type VoiceProvider = 'auto' | 'gemini' | 'groq' | 'elevenlabs'

/** Every provider, for settings validation. */
export const VOICE_PROVIDERS: readonly VoiceProvider[] = ['auto', 'gemini', 'groq', 'elevenlabs']

/** How lines are spoken. */
export interface VoiceSettings {
  provider: VoiceProvider
  /** Voice name for the provider that speaks; empty uses its default. Gemini names do not exist on Groq, and the reverse. */
  geminiVoice: string
  groqVoice: string
  /** ElevenLabs voice id, for `elevenlabs`. */
  elevenLabsVoice: string
  /** Gemini only: how the line is delivered. */
  style: string
  /** Gemini speech model. */
  geminiModel: string
  /** A Groq key saved on the settings page; tried before the environment's. */
  groqApiKey: string
  /** Path of video-use's `speak.py`, for `elevenlabs`. */
  speakScript: string
}

/** Groq's Orpheus speech model and its default voice. */
const GROQ_MODEL = 'canopylabs/orpheus-v1-english'
const GROQ_DEFAULT_VOICE = 'troy'
const GEMINI_DEFAULT_VOICE = 'Puck'

/** How long a key rests after a per-minute limit, and after a daily quota, in milliseconds. */
const MINUTE_REST_MS = 65_000
const DAY_REST_MS = 6 * 3_600_000
/** Longest wait for a resting key to free up, and how many times to wait, before a line fails. */
const MAX_WAIT_MS = 90_000
const MAX_WAIT_ROUNDS = 4

/** How long a key rests after any other failure. */
const FAILED_REST_MS = 10 * 60_000

/** One key of one provider. */
interface VoiceKey {
  provider: 'gemini' | 'groq'
  /** Where the key came from, for messages; never the key itself. */
  name: string
  key: string
}

/**
 * The keys in the environment for a provider, in order: `<BASE>`, then `<BASE>_1` … `<BASE>_9`, without repeats.
 * @param env - the environment.
 * @param base - `GEMINI_API_KEY` or `GROQ_API_KEY`.
 * @returns names and keys.
 */
export function envKeys(env: NodeJS.ProcessEnv, base: string): { name: string; key: string }[] {
  const out: { name: string; key: string }[] = []
  for (const name of [base, ...Array.from({ length: 9 }, (_, i) => `${base}_${String(i + 1)}`)]) {
    const key = (env[name] ?? '').trim()
    if (key !== '' && !out.some(k => k.key === key)) out.push({ name, key })
  }
  return out
}

/** A refusal that another key, or a wait, may cure. */
class KeyBusy extends Error {
  /** @param restMs - how long this key should rest. */
  constructor(message: string, readonly restMs: number) { super(message) }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason instanceof Error ? signal.reason : new Error('aborted')) }, { once: true })
  })
}

/** Wrap 16-bit little-endian mono PCM in a WAV header. */
export function pcmToWav(pcm: Buffer, rate: number): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

async function geminiSpeak(
  fetcher: typeof fetch, key: string, settings: VoiceSettings, text: string, out: string, signal: AbortSignal,
): Promise<void> {
  const response = await fetcher(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(settings.geminiModel)}:generateContent`, {
    method: 'POST',
    signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
    headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: `${settings.style.trim() === '' ? '' : `${settings.style.trim()}\n\n`}${text}` }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: settings.geminiVoice.trim() || GEMINI_DEFAULT_VOICE } } },
      },
    }),
  })
  const raw = await response.text()
  if (response.status === 429) {
    // Google says how long to wait (RetryInfo); without it, a per-day quota rests for hours and anything else a minute.
    const delay = Number.parseFloat(/"retryDelay"\s*:\s*"([\d.]+)s"/u.exec(raw)?.[1] ?? '')
    const daily = /PerDay/u.test(raw)
    const rest = Number.isFinite(delay) ? delay * 1000 + 1000 : daily ? DAY_REST_MS : MINUTE_REST_MS
    throw new KeyBusy(daily ? 'daily quota spent (the free tier allows 10 speech requests a day per Google Cloud project)' : 'rate-limited', rest)
  }
  if (!response.ok) throw new Error(`Gemini speech answered HTTP ${String(response.status)}: ${raw.slice(0, 200)}`)
  const body = JSON.parse(raw) as { candidates?: { content?: { parts?: { inlineData?: { mimeType?: string; data?: string } }[] } }[] }
  const audio = body.candidates?.[0]?.content?.parts?.find(p => p.inlineData?.data !== undefined)?.inlineData
  if (audio?.data === undefined) throw new Error('Gemini speech returned no audio')
  const rate = Number.parseInt(/rate=(\d+)/u.exec(audio.mimeType ?? '')?.[1] ?? '24000', 10)
  await writeFile(out, pcmToWav(Buffer.from(audio.data, 'base64'), rate))
}

async function groqSpeak(
  fetcher: typeof fetch, key: string, settings: VoiceSettings, text: string, out: string, signal: AbortSignal,
): Promise<void> {
  const response = await fetcher('https://api.groq.com/openai/v1/audio/speech', {
    method: 'POST',
    signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: GROQ_MODEL, voice: settings.groqVoice.trim() || GROQ_DEFAULT_VOICE, input: text, response_format: 'wav' }),
  })
  if (response.status === 429) throw new KeyBusy('rate-limited', MINUTE_REST_MS)
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    // Terms not accepted on this key's organisation: rest it for long, another key may belong to an organisation that has.
    if (/model_terms_required/u.test(body)) throw new KeyBusy('the Orpheus model terms are not accepted on this key\'s Groq organisation', DAY_REST_MS)
    throw new Error(`Groq speech answered HTTP ${String(response.status)}: ${body.slice(0, 200)}`)
  }
  await writeFile(out, Buffer.from(await response.arrayBuffer()))
}

function elevenLabsSpeak(settings: VoiceSettings, text: string, out: string, signal: AbortSignal): Promise<void> {
  const args = [settings.speakScript, text, '--provider', 'elevenlabs', '-o', out]
  if (settings.elevenLabsVoice.trim() !== '') args.push('--voice', settings.elevenLabsVoice.trim())
  return new Promise((resolve, reject) => {
    execFile('python3', args, { signal, timeout: 180_000, maxBuffer: 4 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (error === null) resolve()
      else reject(new Error(`The ElevenLabs voiceover failed: ${(stderr || error.message).trim().split('\n').slice(-2).join(' ')}`))
    })
  })
}

/**
 * A function that speaks one line into a WAV file, moving to the next key when one is busy.
 * @param settings - provider, voices and the saved Groq key, read on every line.
 * @param env - where the Gemini and Groq keys are read from.
 * @param fetcher - HTTP.
 * @param now - the clock, for key rests.
 * @returns the speaker.
 */
export function createSpeaker(
  settings: () => VoiceSettings, env: NodeJS.ProcessEnv = process.env, fetcher: typeof fetch = fetch, now: () => number = Date.now,
): (text: string, out: string, signal: AbortSignal) => Promise<void> {
  const restingUntil = new Map<string, number>()
  return async (text, out, signal) => {
    const current = settings()
    if (current.provider === 'elevenlabs') return elevenLabsSpeak(current, text, out, signal)
    const keys: VoiceKey[] = []
    if (current.provider !== 'groq') keys.push(...envKeys(env, 'GEMINI_API_KEY').map(k => ({ provider: 'gemini' as const, ...k })))
    if (current.provider !== 'gemini') {
      const saved = current.groqApiKey.trim()
      const groq = [...saved === '' ? [] : [{ name: 'the saved Groq key', key: saved }], ...envKeys(env, 'GROQ_API_KEY')]
      keys.push(...groq.filter((k, i) => groq.findIndex(x => x.key === k.key) === i).map(k => ({ provider: 'groq' as const, ...k })))
    }
    if (keys.length === 0) {
      const which = current.provider === 'auto' ? 'Gemini or Groq' : current.provider
      throw new Error(`No ${which} key for the voiceover: set GEMINI_API_KEY (and _1 … _9) or GROQ_API_KEY in the deployment.`)
    }
    // When every key is resting but one frees up within a short wait (a per-minute limit), wait for it rather than
    // fail; a key resting for a daily quota never qualifies.
    for (let round = 0; ; round++) {
      const busy: string[] = []
      const spoken = await tryKeys(keys, current, text, out, signal, busy)
      if (spoken) return
      const soonest = Math.min(...keys.map(k => restingUntil.get(k.key) ?? 0)) - now()
      if (round >= MAX_WAIT_ROUNDS || soonest > MAX_WAIT_MS) {
        throw new Error(`No voice key could speak the line (${busy.join('; ')}). Try again later or add a key.`)
      }
      await sleep(Math.max(1_000, soonest), signal)
    }
  }

  /** Try each key in order; record why each that failed did. Returns whether one spoke the line. */
  async function tryKeys(
    keys: VoiceKey[], current: VoiceSettings, text: string, out: string, signal: AbortSignal, busy: string[],
  ): Promise<boolean> {
    for (const candidate of keys) {
      if ((restingUntil.get(candidate.key) ?? 0) > now()) { busy.push(`${candidate.name} resting`); continue }
      try {
        if (candidate.provider === 'gemini') await geminiSpeak(fetcher, candidate.key, current, text, out, signal)
        else await groqSpeak(fetcher, candidate.key, current, text, out, signal)
        return true
      } catch (error) {
        if (signal.aborted) throw error
        // A busy key rests for as long as its limit says; any other failure (a revoked key, a server error) rests it
        // for a while too, and the next key takes the line.
        restingUntil.set(candidate.key, now() + (error instanceof KeyBusy ? error.restMs : FAILED_REST_MS))
        busy.push(`${candidate.name}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return false
  }
}
