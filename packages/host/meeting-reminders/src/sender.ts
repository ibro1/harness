/**
 * Posting to WhatsApp through the WhatsApp plugin's token-guarded command
 * route, the employee-kit `whatsAppNotifier` way, but to a chat named per
 * message. A message that cannot be sent is reported in the returned text,
 * never thrown. The route wraps a tool's answer in `{ result }`, so a refusal
 * by the WhatsApp service arrives as `result.error` and is read there too.
 */

/** The WhatsApp plugin's command route. */
export interface WhatsAppRoute {
  /** The command route; empty turns sending off. */
  url: string
  /** Bearer token for that route. */
  token: string
}

/**
 * Build the send function.
 * @param route - the command route.
 * @param fetcher - HTTP, injectable for tests.
 * @returns a function that sends a text to a chat and says what happened (`sent to …`, `not sent (…)`, `failed: …`).
 */
export function whatsAppSender(route: WhatsAppRoute, fetcher: typeof fetch = fetch): (to: string, text: string) => Promise<string> {
  return async (to, text) => {
    const chat = to.trim()
    if (chat === '' || route.url === '' || route.token === '') return 'not sent (no WhatsApp chat or route configured)'
    try {
      const response = await fetcher(route.url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${route.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'whatsapp_send', args: { to: chat, text, send_now: true } }),
        signal: AbortSignal.timeout(20_000),
      })
      const body = await response.json() as { error?: unknown; result?: { error?: unknown; sent?: unknown } }
      const error = body.error ?? body.result?.error
      if (error !== undefined) return `failed: ${typeof error === 'string' ? error : JSON.stringify(error)}`
      if (!response.ok) return `failed: HTTP ${String(response.status)}`
      return body.result?.sent === true ? `sent to ${chat}` : `failed: unexpected answer ${JSON.stringify(body).slice(0, 200)}`
    } catch (error) {
      return `failed: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}
