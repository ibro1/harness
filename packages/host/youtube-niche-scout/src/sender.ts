/**
 * Posting to WhatsApp through the WhatsApp plugin's token-guarded command
 * route, the employee-kit `whatsAppNotifier` way, but to a chat named per
 * message. A message that cannot be sent is reported in the returned text,
 * never thrown. The route wraps a tool's answer in `{ result }`, so a refusal
 * by the WhatsApp service arrives as `result.error` and is read there too.
 * The same sender as the meeting-reminders plugin's.
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

/** One WhatsApp group the linked account belongs to. */
export interface WhatsAppGroup {
  jid: string
  /** The group's subject; empty when WhatsApp gave none. */
  name: string
}

/**
 * Build the group lister for the settings page's dropdown. It asks the WhatsApp plugin's `whatsapp_groups` tool; a
 * WhatsApp plugin without that tool answers from `whatsapp_chats` instead, which knows group ids but not their names.
 * @param route - the command route.
 * @param fetcher - HTTP, injectable for tests.
 * @returns a function that resolves to the groups, sorted by name, or rejects with the route's error.
 */
export function whatsAppGroups(route: WhatsAppRoute, fetcher: typeof fetch = fetch): () => Promise<WhatsAppGroup[]> {
  const call = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (route.url === '' || route.token === '') throw new Error('no WhatsApp route configured')
    const response = await fetcher(route.url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${route.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, args }),
      signal: AbortSignal.timeout(20_000),
    })
    const body = await response.json() as { error?: unknown; result?: Record<string, unknown> }
    const error = body.error ?? body.result?.['error']
    if (error !== undefined) throw new Error(typeof error === 'string' ? error : JSON.stringify(error))
    return body.result ?? {}
  }
  const rows = (value: unknown): Record<string, unknown>[] =>
    Array.isArray(value) ? value.filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null) : []
  const text = (value: unknown): string => typeof value === 'string' ? value : ''
  return async () => {
    let groups: WhatsAppGroup[]
    try {
      groups = rows((await call('whatsapp_groups', {}))['groups']).map(row => ({ jid: text(row['jid']), name: text(row['name']) }))
    } catch (error) {
      if (!(error instanceof Error && error.message.startsWith('no such tool'))) throw error
      const seen = new Set<string>()
      groups = rows((await call('whatsapp_chats', { limit: 200 }))['messages'])
        .map(row => text(row['chat']))
        .filter(jid => jid.endsWith('@g.us') && !seen.has(jid) && seen.add(jid))
        .map(jid => ({ jid, name: '' }))
    }
    return groups.filter(g => g.jid.endsWith('@g.us')).sort((a, b) => a.name.localeCompare(b.name))
  }
}
