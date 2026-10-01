/**
 * Owner alerts over WhatsApp, through the WhatsApp plugin's token-guarded
 * command route. An alert that cannot be sent is reported in the returned
 * text, never thrown: an employee's work does not stop because a message
 * failed.
 */

/** Where alerts go. */
export interface WhatsAppRoute {
  /** The WhatsApp plugin's command route; empty turns alerts off. */
  url: string
  /** Bearer token for that route. */
  token: string
  /** Chat name or number, read at send time so a settings change applies at once. */
  to: () => string
}

/**
 * Build the owner-alert function for one employee.
 * @param route - the WhatsApp route and recipient.
 * @param fetcher - HTTP, injectable for tests.
 * @returns a function that sends a text and says what happened (`sent to …`, `not sent (…)`, `failed: …`).
 */
export function whatsAppNotifier(route: WhatsAppRoute, fetcher: typeof fetch = fetch): (text: string) => Promise<string> {
  return async (text) => {
    const to = route.to().trim()
    if (to === '' || route.url === '' || route.token === '') return 'not sent (no WhatsApp recipient or route configured)'
    try {
      const response = await fetcher(route.url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${route.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'whatsapp_send', args: { to, text, send_now: true } }),
        signal: AbortSignal.timeout(20_000),
      })
      const body = await response.json() as { error?: string }
      return body.error === undefined ? `sent to ${to}` : `failed: ${body.error}`
    } catch (error) {
      return `failed: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}

/** One stored WhatsApp message, as the WhatsApp plugin's `whatsapp_read` returns it. */
export interface WhatsAppMessage {
  chat: string
  senderName: string
  fromMe: boolean
  /** Unix seconds. */
  ts: number
  body: string
}

/**
 * Build a reader of the owner's chat, for answers an employee asked for.
 * @param route - the WhatsApp route and the chat to read.
 * @param fetcher - HTTP, injectable for tests.
 * @returns a function that returns up to `limit` recent messages, newest first; it throws when the route answers with an error.
 */
export function whatsAppReader(route: WhatsAppRoute, fetcher: typeof fetch = fetch): (limit: number) => Promise<WhatsAppMessage[]> {
  return async (limit) => {
    const chat = route.to().trim()
    if (chat === '' || route.url === '' || route.token === '') throw new Error('No WhatsApp chat or route is configured.')
    const response = await fetcher(route.url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${route.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'whatsapp_read', args: { chat, limit } }),
      signal: AbortSignal.timeout(20_000),
    })
    const body = await response.json() as { error?: string; result?: { messages?: unknown; error?: string }; messages?: unknown }
    const payload = body.result ?? body
    const error = body.error ?? payload.error
    if (error !== undefined) throw new Error(`WhatsApp read failed: ${error}`)
    const rows = Array.isArray(payload.messages) ? payload.messages as Record<string, unknown>[] : []
    return rows.map(row => ({
      chat: typeof row['chat'] === 'string' ? row['chat'] : '',
      senderName: typeof row['senderName'] === 'string' ? row['senderName'] : '',
      fromMe: row['fromMe'] === true,
      ts: typeof row['ts'] === 'number' ? row['ts'] : 0,
      body: typeof row['body'] === 'string' ? row['body'] : '',
    }))
  }
}
