/**
 * The delegate's WhatsApp access through the WhatsApp plugin's token-guarded
 * command route: reading a chat after a row id, downloading a message's media,
 * and sending, optionally as a reply to one message. The route wraps a tool's
 * answer in `{ result }`, so a refusal by the WhatsApp service arrives as
 * `result.error`; both places are read.
 */

import type { WaRow } from './logic.ts'

/** The WhatsApp plugin's command route. */
export interface WhatsAppRoute {
  /** The command route; empty turns WhatsApp off. */
  url: string
  /** Bearer token for that route. */
  token: string
}

/** What a send did. */
export type SendOutcome = { ok: true; waId?: string } | { ok: false; error: string }

/** The calls the delegate makes. */
export interface WhatsAppClient {
  /** Whether a route is configured at all. */
  configured: boolean
  /**
   * Rows of one chat after a row id, oldest first; with no `after`, the latest `limit` rows, newest first.
   * Rejects when the WhatsApp service is too old to give row ids.
   */
  read: (chat: string, options: { after?: number; limit: number }) => Promise<WaRow[]>
  /** A message's picture, voice note or file. */
  media: (rowId: number) => Promise<{ mime: string; data: Buffer }>
  /** Send a text, as a reply to `quote` (a WhatsApp message id) when given. */
  send: (to: string, text: string, quote?: string) => Promise<SendOutcome>
}

function rowFrom(value: Record<string, unknown>): WaRow | undefined {
  if (typeof value['id'] !== 'number') return undefined
  const str = (key: string): string => typeof value[key] === 'string' ? value[key] : ''
  return {
    id: value['id'],
    waId: str('waId'),
    chat: str('chat'),
    sender: str('sender'),
    senderName: str('senderName'),
    fromMe: value['fromMe'] === true,
    viaApi: value['viaApi'] === true,
    ts: typeof value['ts'] === 'number' ? value['ts'] : 0,
    kind: str('kind') || 'text',
    body: str('body'),
    replyTo: str('replyTo'),
    hasMedia: value['hasMedia'] === true,
  }
}

/**
 * Build the client.
 * @param route - the command route.
 * @param fetcher - HTTP, injectable for tests.
 * @returns the client.
 */
export function whatsAppClient(route: WhatsAppRoute, fetcher: typeof fetch = fetch): WhatsAppClient {
  const call = async (name: string, args: Record<string, unknown>, timeoutMs = 20_000): Promise<Record<string, unknown>> => {
    if (route.url === '' || route.token === '') throw new Error('no WhatsApp route configured')
    const response = await fetcher(route.url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${route.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, args }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const body = await response.json() as { error?: unknown; result?: Record<string, unknown> }
    const error = body.error ?? body.result?.['error']
    if (error !== undefined) throw new Error(typeof error === 'string' ? error : JSON.stringify(error))
    if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
    return body.result ?? {}
  }
  return {
    configured: route.url !== '' && route.token !== '',
    read: async (chat, options) => {
      const result = await call('whatsapp_read', {
        chat, limit: options.limit, include_sent: true, ...options.after === undefined ? {} : { after: options.after },
      })
      const raw = Array.isArray(result['messages']) ? result['messages'] as Record<string, unknown>[] : []
      const rows = raw.map(rowFrom)
      if (rows.some(row => row === undefined)) throw new Error('the WhatsApp service gives no message ids; deploy the updated WhatsApp sidecar')
      return rows.filter((row): row is WaRow => row !== undefined)
    },
    media: async (rowId) => {
      const result = await call('whatsapp_media', { id: rowId }, 120_000)
      if (typeof result['base64'] !== 'string') throw new Error('the WhatsApp service returned no media')
      return { mime: typeof result['mime'] === 'string' ? result['mime'] : 'application/octet-stream', data: Buffer.from(result['base64'], 'base64') }
    },
    send: async (to, text, quote) => {
      try {
        const result = await call('whatsapp_send', { to, text, send_now: true, ...quote === undefined ? {} : { quote } })
        if (result['sent'] !== true) return { ok: false, error: `unexpected answer ${JSON.stringify(result).slice(0, 200)}` }
        return typeof result['waId'] === 'string' && result['waId'] !== '' ? { ok: true, waId: result['waId'] } : { ok: true }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}

/** File extensions Groq accepts, by the voice note's type. */
const AUDIO_EXT: Record<string, string> = { 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'm4a', 'audio/wav': 'wav', 'audio/webm': 'webm' }

/**
 * Transcribe a voice note with Groq Whisper.
 * @param audio - the note and its type.
 * @param options - the key and model.
 * @param fetcher - HTTP, injectable for tests.
 * @returns the text.
 */
export async function transcribe(
  audio: { mime: string; data: Buffer }, options: { apiKey: string; model: string }, fetcher: typeof fetch = fetch,
): Promise<string> {
  if (options.apiKey === '') throw new Error('no Groq key for transcription')
  const type = audio.mime.split(';')[0]?.trim() ?? 'audio/ogg'
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(audio.data)], { type }), `voice.${AUDIO_EXT[type] ?? 'ogg'}`)
  form.append('model', options.model)
  form.append('response_format', 'json')
  const response = await fetcher('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST', headers: { Authorization: `Bearer ${options.apiKey}` }, body: form, signal: AbortSignal.timeout(120_000),
  })
  const body = await response.text()
  if (!response.ok) throw new Error(`Groq answered ${String(response.status)}: ${body.slice(0, 200)}`)
  const parsed = JSON.parse(body) as { text?: unknown }
  return typeof parsed.text === 'string' ? parsed.text.trim() : ''
}
