// WhatsApp plugin (Node half): proxies the whatsmeow sidecar to the browser and
// the agent, and enforces the human-in-the-loop SEND gate.
//
// Two audiences, two auth models:
//   - The settings CARD (browser) reaches /whatsapp/{status,login,logout,pending,
//     approve,discard} behind the password gate (authenticate defaults true).
//   - The MCP TOOLS (agy/opencode, server-side, no cookie) reach one command
//     route /whatsapp/command on loopback with a Bearer token (authenticate
//     false) — the dokploy pattern. The agent can READ freely, but whatsapp_send
//     only QUEUES a pending draft; nothing goes out until the operator Approves
//     it in the card. So even an over-eager agent cannot message anyone
//     autonomously.
//
// Disabled (routes 503) when WA_SVC_TOKEN is unset, so a deploy without the
// sidecar fails safe.

import { randomUUID } from 'node:crypto'
import z from '@deepseek-ai/schemastery'

export const name = 'whatsapp'
// 'settings' is load-bearing: the Settings → Plugins tab only renders a card
// whose key is ALSO a settings namespace the host serves. WhatsApp has nothing
// to configure (it's linked by scanning the card's QR), so the namespace is an
// empty schema — its mere presence is what lists the card.
export const inject = ['webServer', 'settings']

const SVC_URL = (process.env.WA_SVC_URL ?? 'http://127.0.0.1:8003').replace(/\/$/, '')
const SVC_TOKEN = (process.env.WA_SVC_TOKEN ?? '').trim()
const AGENT_TOKEN = (process.env.WA_AGENT_TOKEN ?? '').trim()
// The token another service on this box presents to drive its OWN WhatsApp
// sessions. Separate from WA_AGENT_TOKEN (this harness's agent) and from
// DSH_AUTH_API_TOKEN (the whole harness): a marketing app that links its
// tenants' phones should hold neither of those.
const EXTERNAL_TOKEN = (process.env.WA_EXTERNAL_TOKEN ?? '').trim()
// The session the card and the agent drive. External callers may never name it,
// so a tenant cannot act as, or read, the operator's own WhatsApp.
const DEFAULT_SESSION = (process.env.WA_DEFAULT_SESSION ?? 'default').trim() || 'default'

/** Pending sends awaiting operator approval: id → {id,to,name,text,createdAt}.
 *  In-memory on purpose: a draft the operator never approves evaporates on
 *  restart rather than lingering. */
const pending = new Map()

/** The tools the MCP advertises; schemas live here so they cannot drift. */
const TOOLS = [
  { name: 'whatsapp_status', description: 'Check whether WhatsApp is linked and connected.',
    parameters: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'whatsapp_contacts', description: 'List WhatsApp contacts, optionally filtered by a name or number substring.',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'Optional name/number substring.' } }, additionalProperties: false } },
  { name: 'whatsapp_chats', description: 'List recent WhatsApp chats (latest message per chat), newest first.',
    parameters: { type: 'object', properties: { limit: { type: 'number', description: 'Max chats (default 30).' } }, additionalProperties: false } },
  { name: 'whatsapp_read', description: 'Read recent WhatsApp messages, optionally for one chat/contact.',
    parameters: { type: 'object', properties: { chat: { type: 'string', description: 'Contact name, phone number, or JID. Omit for the latest across all chats.' }, limit: { type: 'number', description: 'Max messages (default 30).' } }, additionalProperties: false } },
  { name: 'whatsapp_resolve', description: 'Resolve a contact name or phone number to a WhatsApp id, to confirm a recipient before sending.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } },
  { name: 'whatsapp_send', description: 'Send or queue a WhatsApp message. BY DEFAULT (send_now omitted/false) the message is NOT sent — it is queued for the user to approve, either by saying "yes"/"send it" in chat (then call whatsapp_approve) or in the WhatsApp card. When you queue, tell the user it is waiting for their approval. Set send_now=true ONLY when the user has explicitly told you to send automatically / take over WhatsApp for this conversation, and has not since told you to stop.',
    parameters: { type: 'object', properties: { to: { type: 'string', description: 'Recipient: contact name, phone number, or JID.' }, text: { type: 'string', description: 'Message text.' }, send_now: { type: 'boolean', description: 'Send immediately without queuing. Use ONLY if the user authorized automatic sending for this conversation; otherwise omit it so the message is queued for approval.' } }, required: ['to', 'text'], additionalProperties: false } },
  { name: 'whatsapp_approve', description: 'Approve and send pending WhatsApp draft(s) — call this when the user approves a queued message in chat (e.g. says "yes", "send it"). Pass the draft id, or omit it to approve the single pending draft; if several are pending, ask the user which one.',
    parameters: { type: 'object', properties: { id: { type: 'string', description: 'The pending draft id to approve. Omit to approve the only pending draft.' } }, additionalProperties: false } },
]

function announce(message) { process.stderr.write(`whatsapp: ${message}\n`) }

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** Call the sidecar; returns { status, body } (body is parsed JSON or {}). */
async function svc(path, { method = 'GET', body, session } = {}) {
  const resp = await fetch(`${SVC_URL}${path}`, {
    method,
    headers: {
      'X-WA-Token': SVC_TOKEN,
      // Omitted for the card and the agent, so the sidecar applies its default
      // session — the operator's own account.
      ...(session === undefined ? {} : { 'X-WA-Session': session }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  let parsed = {}
  try { parsed = await resp.json() } catch { /* non-JSON */ }
  return { status: resp.status, body: parsed }
}

/** Send one pending draft via the sidecar and drop it from the queue. Shared by
 *  the card's Approve button and the agent's whatsapp_approve tool. */
async function sendDraft(draft) {
  const { status, body } = await svc('/send', { method: 'POST', body: { to: draft.to, text: draft.text } })
  if (status === 200) { pending.delete(draft.id); return { ok: true, sent: body } }
  return { ok: false, status, error: body.error ?? `HTTP ${status}` }
}

/** Resolve a recipient and send immediately (take-over mode). */
async function sendNow(to, text) {
  const { status, body: resolved } = await svc(`/resolve?query=${encodeURIComponent(to)}`)
  if (status !== 200 || typeof resolved.jid !== 'string') return { error: resolved.error ?? `could not resolve "${to}"` }
  const { status: s2, body: out } = await svc('/send', { method: 'POST', body: { to: resolved.jid, text } })
  if (s2 === 200) return { sent: true, to: resolved.name || to, text }
  return { error: out.error ?? `send failed (HTTP ${s2})` }
}

/** Read a small JSON request body. */
function readJson(req) {
  return new Promise((resolve) => {
    let text = ''
    let bytes = 0
    req.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > 64 * 1024) { req.destroy(); resolve(undefined); return }
      text += chunk
    })
    req.on('end', () => { try { resolve(text === '' ? {} : JSON.parse(text)) } catch { resolve(undefined) } })
    req.on('error', () => resolve(undefined))
  })
}

/** Straight proxy of a sidecar path (card status/login/logout). */
function passthrough(sidecarPath) {
  return async (req, res) => {
    if (SVC_TOKEN === '') { json(res, 503, { error: 'WhatsApp not configured (WA_SVC_TOKEN unset)' }); return }
    try {
      const { status, body } = await svc(sidecarPath, { method: req.method === 'POST' ? 'POST' : 'GET' })
      json(res, status, body)
    } catch (error) {
      json(res, 502, { error: `sidecar unreachable: ${String(error)}` })
    }
  }
}

/** Execute one agent tool. Reads proxy the sidecar; send QUEUES for approval. */
async function runTool(name, args) {
  switch (name) {
    case 'whatsapp_status': return (await svc('/status')).body
    case 'whatsapp_contacts': return (await svc(`/contacts${args.query ? `?query=${encodeURIComponent(String(args.query))}` : ''}`)).body
    case 'whatsapp_chats': return (await svc(`/chats${args.limit ? `?limit=${encodeURIComponent(String(args.limit))}` : ''}`)).body
    case 'whatsapp_read': {
      const params = [args.chat ? `chat=${encodeURIComponent(String(args.chat))}` : '', args.limit ? `limit=${encodeURIComponent(String(args.limit))}` : ''].filter(Boolean).join('&')
      return (await svc(`/messages${params ? `?${params}` : ''}`)).body
    }
    case 'whatsapp_resolve': return (await svc(`/resolve?query=${encodeURIComponent(String(args.query ?? ''))}`)).body
    case 'whatsapp_send': {
      if (typeof args.to !== 'string' || typeof args.text !== 'string' || args.text === '') return { error: 'need {to, text}' }
      // Take-over mode: the user authorized automatic sending, so send now.
      if (args.send_now === true) return sendNow(args.to, args.text)
      // Default: queue for the user's approval (chat "yes" → whatsapp_approve, or the card).
      const { status, body: resolved } = await svc(`/resolve?query=${encodeURIComponent(args.to)}`)
      if (status !== 200 || typeof resolved.jid !== 'string') return { error: resolved.error ?? `could not resolve "${args.to}"` }
      const draft = { id: randomUUID(), to: resolved.jid, name: resolved.name || args.to, text: args.text, createdAt: Date.now() }
      pending.set(draft.id, draft)
      return { queued: true, id: draft.id, recipient: draft.name, text: draft.text,
        note: 'Queued — NOT sent yet. Tell the user; they approve by saying "yes"/"send it" (then call whatsapp_approve) or in the WhatsApp card.' }
    }
    case 'whatsapp_approve': {
      const list = [...pending.values()]
      if (list.length === 0) return { error: 'nothing is pending to approve' }
      let targets
      if (typeof args.id === 'string' && args.id !== '') {
        const draft = pending.get(args.id)
        if (draft === undefined) return { error: `no pending send with id ${args.id}` }
        targets = [draft]
      } else if (list.length === 1) {
        targets = list
      } else {
        return { needId: true, pending: list.map(d => ({ id: d.id, to: d.name, text: d.text })),
          note: 'Several drafts are pending — ask the user which id to approve.' }
      }
      const approved = []
      for (const draft of targets) {
        const r = await sendDraft(draft)
        approved.push({ to: draft.name, text: draft.text, ok: r.ok, ...(r.ok ? {} : { error: r.error }) })
      }
      return { approved }
    }
    default: return { error: `no such tool: ${name}` }
  }
}

export function apply(ctx) {
  if (SVC_TOKEN === '') {
    announce('WA_SVC_TOKEN unset — WhatsApp routes disabled')
  } else {
    announce(`proxying sidecar ${SVC_URL}; command route ${AGENT_TOKEN === '' ? 'DISABLED (no WA_AGENT_TOKEN)' : 'enabled'}`)
  }

  // Serve the `whatsapp` settings namespace so the Settings → Plugins tab lists
  // the card (its key must be both a registered card AND a served namespace).
  // Empty schema: there is nothing to configure — linking happens via the QR.
  // Called directly, NOT via ctx.effect: settings.register returns a scope, not
  // a disposer, so wrapping it makes cordis reject it as an "Invalid effect"
  // (the same direct call dokploy's host plugin uses).
  ctx.settings.register('whatsapp', z.object({}).description('WhatsApp is linked from this card by scanning a QR — nothing to configure.'), { base: {} })

  const route = (path, handler) =>
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path, handler }), `whatsapp: ${path}`)

  // ---- Card routes (behind the password gate) ----
  route('/whatsapp/status', passthrough('/status'))
  route('/whatsapp/login', passthrough('/login'))
  route('/whatsapp/logout', passthrough('/logout'))

  route('/whatsapp/pending', (req, res) => {
    if (SVC_TOKEN === '') { json(res, 503, { error: 'WhatsApp not configured' }); return }
    json(res, 200, { pending: [...pending.values()] })
  })

  route('/whatsapp/approve', async (req, res) => {
    if (SVC_TOKEN === '') { json(res, 503, { error: 'WhatsApp not configured' }); return }
    const body = await readJson(req)
    const draft = body && typeof body.id === 'string' ? pending.get(body.id) : undefined
    if (draft === undefined) { json(res, 404, { error: 'no such pending send' }); return }
    try {
      const r = await sendDraft(draft)
      if (r.ok) { json(res, 200, { ok: true, sent: r.sent }); return }
      json(res, r.status ?? 502, { error: r.error })
    } catch (error) {
      json(res, 502, { error: `send failed: ${String(error)}` })
    }
  })

  route('/whatsapp/discard', async (req, res) => {
    if (SVC_TOKEN === '') { json(res, 503, { error: 'WhatsApp not configured' }); return }
    const body = await readJson(req)
    if (body && typeof body.id === 'string') pending.delete(body.id)
    json(res, 200, { ok: true })
  })

  // ---- External API (another service on this box, one session per tenant) ----
  //
  // Reachable over the network, unlike the agent command route, because the
  // caller is a different container. Three properties make that safe:
  //
  //   - its own token (WA_EXTERNAL_TOKEN), so holding it grants WhatsApp
  //     sessions and nothing else in the harness;
  //   - a session key is REQUIRED, so a caller cannot fall through to the
  //     sidecar's default;
  //   - the default session is refused outright, so no tenant can send as, or
  //     read, the operator's own linked phone.
  //
  // There is deliberately no approval gate here. The gate exists because the
  // harness's agent is the one drafting; an external service is acting for a
  // tenant on their own linked account, and owns its own policy.
  if (EXTERNAL_TOKEN !== '') {
    const EXTERNAL_ROUTES = {
      '/whatsapp/api/status': { path: '/status', method: 'GET' },
      '/whatsapp/api/login': { path: '/login', method: 'POST' },
      '/whatsapp/api/logout': { path: '/logout', method: 'POST' },
      '/whatsapp/api/send': { path: '/send', method: 'POST' },
      '/whatsapp/api/messages': { path: '/messages', method: 'GET' },
      '/whatsapp/api/chats': { path: '/chats', method: 'GET' },
      '/whatsapp/api/contacts': { path: '/contacts', method: 'GET' },
      '/whatsapp/api/resolve': { path: '/resolve', method: 'GET' },
    }
    for (const [routePath, target] of Object.entries(EXTERNAL_ROUTES)) {
      ctx.effect(() => ctx.webServer.register({
        kind: 'exact',
        path: routePath,
        authenticate: false,
        handler: async (req, res) => {
          if (SVC_TOKEN === '') { json(res, 503, { error: 'WhatsApp not configured' }); return }
          const auth = req.headers['authorization'] ?? ''
          if (auth !== `Bearer ${EXTERNAL_TOKEN}`) { json(res, 401, { error: 'unauthorized' }); return }

          const url = new URL(req.url, 'http://localhost')
          const session = (req.headers['x-wa-session'] ?? url.searchParams.get('session') ?? '').toString().trim()
          if (session === '') { json(res, 400, { error: 'X-WA-Session is required' }); return }
          if (session === DEFAULT_SESSION) {
            json(res, 403, { error: 'the default session is the operator\'s own account and is not reachable here' })
            return
          }

          // Carry through the sidecar's own query parameters (chat, limit,
          // query), minus the session, which travels as a header.
          url.searchParams.delete('session')
          const qs = url.searchParams.toString()
          const sidecarPath = `${target.path}${qs === '' ? '' : `?${qs}`}`

          const body = target.method === 'POST' ? await readJson(req) : undefined
          if (target.method === 'POST' && body === undefined) { json(res, 400, { error: 'invalid JSON body' }); return }
          try {
            const out = await svc(sidecarPath, { method: target.method, body, session })
            json(res, out.status, out.body)
          } catch (error) {
            json(res, 502, { error: `sidecar unreachable: ${String(error)}` })
          }
        },
      }), `whatsapp: ${routePath}`)
    }
    announce(`external API enabled on /whatsapp/api/* (session required, "${DEFAULT_SESSION}" refused)`)
  }

  // ---- Agent command route (loopback + Bearer token; the MCP calls this) ----
  // GET → tool catalogue; POST { name, args } → execute. Mirrors dokploy.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/whatsapp/command',
    authenticate: false,
    handler: async (req, res) => {
      if (SVC_TOKEN === '' || AGENT_TOKEN === '') { json(res, 503, { error: 'WhatsApp command route not configured' }); return }
      const remote = req.socket?.remoteAddress ?? ''
      const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
      if (!loopback) { json(res, 403, { error: 'loopback only' }); return }
      const auth = req.headers['authorization'] ?? ''
      if (auth !== `Bearer ${AGENT_TOKEN}`) { json(res, 401, { error: 'bad token' }); return }
      if (req.method === 'GET') { json(res, 200, { tools: TOOLS }); return }
      if (req.method !== 'POST') { json(res, 405, { error: 'GET or POST' }); return }
      const body = await readJson(req)
      if (!body || typeof body.name !== 'string') { json(res, 400, { error: 'need { name, args }' }); return }
      try {
        const result = await runTool(body.name, body.args ?? {})
        json(res, 200, { result })
      } catch (error) {
        json(res, 200, { error: String(error) })
      }
    },
  }), 'whatsapp: command route')
}
