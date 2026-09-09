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

export const name = 'whatsapp'
export const inject = ['webServer']

const SVC_URL = (process.env.WA_SVC_URL ?? 'http://127.0.0.1:8003').replace(/\/$/, '')
const SVC_TOKEN = (process.env.WA_SVC_TOKEN ?? '').trim()
const AGENT_TOKEN = (process.env.WA_AGENT_TOKEN ?? '').trim()

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
  { name: 'whatsapp_send', description: 'Queue a WhatsApp message for the user to approve. It is NOT sent until the user approves it in Settings → Plugins → WhatsApp; always tell the user to approve it there.',
    parameters: { type: 'object', properties: { to: { type: 'string', description: 'Recipient: contact name, phone number, or JID.' }, text: { type: 'string', description: 'Message text.' } }, required: ['to', 'text'], additionalProperties: false } },
]

function announce(message) { process.stderr.write(`whatsapp: ${message}\n`) }

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** Call the sidecar; returns { status, body } (body is parsed JSON or {}). */
async function svc(path, { method = 'GET', body } = {}) {
  const resp = await fetch(`${SVC_URL}${path}`, {
    method,
    headers: { 'X-WA-Token': SVC_TOKEN, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  let parsed = {}
  try { parsed = await resp.json() } catch { /* non-JSON */ }
  return { status: resp.status, body: parsed }
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
      const { status, body: resolved } = await svc(`/resolve?query=${encodeURIComponent(args.to)}`)
      if (status !== 200 || typeof resolved.jid !== 'string') return { error: resolved.error ?? `could not resolve "${args.to}"` }
      const draft = { id: randomUUID(), to: resolved.jid, name: resolved.name || args.to, text: args.text, createdAt: Date.now() }
      pending.set(draft.id, draft)
      return { queued: true, id: draft.id, recipient: draft.name, text: draft.text,
        note: 'Queued. This message will NOT be sent until the user approves it in Settings → Plugins → WhatsApp. Tell the user to approve it there.' }
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
      const { status, body: out } = await svc('/send', { method: 'POST', body: { to: draft.to, text: draft.text } })
      if (status === 200) { pending.delete(draft.id); json(res, 200, { ok: true, sent: out }); return }
      json(res, status, out)
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
