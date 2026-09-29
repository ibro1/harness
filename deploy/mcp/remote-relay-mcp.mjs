#!/usr/bin/env node
// A stdio MCP server that relays to a remote streamable-HTTP MCP server, for
// the agy and opencode CLIs, with one rule the remote cannot apply itself:
// a CLI run for a Session whose id starts with RELAY_DENY_SESSION_PREFIX sees
// no tools and has every call refused.
//
// It exists for the DeerFlow browser. Its Google account is the one Klipara
// downloads YouTube videos with, so Klipara Scout Sessions (ids `scout-…`)
// must never drive it; they use the separate outreach browser. The CLIs pass
// each run's DSH_SESSION_ID to the servers they start, and a direct remote
// registration cannot see it, so the CLIs reach DeerFlow through this relay.
//
//   RELAY_NAME                   server name, for messages
//   RELAY_URL_VAR / RELAY_TOKEN_VAR   names of the variables holding the URL and bearer token
//   RELAY_DENY_SESSION_PREFIX    e.g. "scout-"; empty relays everything
//
// Only JSON-RPC goes to stdout; diagnostics go to stderr.

import { createInterface } from 'node:readline'

const NAME = process.env.RELAY_NAME ?? 'relay'
const URL_ = process.env[process.env.RELAY_URL_VAR ?? 'RELAY_URL'] ?? ''
const TOKEN = process.env[process.env.RELAY_TOKEN_VAR ?? 'RELAY_TOKEN'] ?? ''
const DENY = process.env.RELAY_DENY_SESSION_PREFIX ?? ''
const SESSION = process.env.DSH_SESSION_ID ?? ''
const denied = DENY !== '' && SESSION.startsWith(DENY)

let remoteSession
const write = (message) => { process.stdout.write(`${JSON.stringify(message)}\n`) }
const warn = (text) => { process.stderr.write(`${NAME}: ${text}\n`) }

/**
 * Send one JSON-RPC message to the remote and return the response to it, if any.
 * The remote answers with JSON or with an SSE stream whose `data:` lines carry
 * JSON-RPC messages; the one with the request's id is the response.
 */
async function forward(message) {
  const response = await fetch(URL_, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      ...TOKEN === '' ? {} : { Authorization: `Bearer ${TOKEN}` },
      ...remoteSession === undefined ? {} : { 'Mcp-Session-Id': remoteSession },
    },
    body: JSON.stringify(message),
  })
  const sessionHeader = response.headers.get('mcp-session-id')
  if (sessionHeader !== null) remoteSession = sessionHeader
  if (message.id === undefined || message.id === null) return undefined
  if (!response.ok) throw new Error(`${NAME} answered HTTP ${String(response.status)}`)
  const text = await response.text()
  if ((response.headers.get('content-type') ?? '').includes('text/event-stream')) {
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue
      try {
        const parsed = JSON.parse(line.slice(5).trim())
        if (parsed.id === message.id) return parsed
      } catch {
        // A keep-alive or partial line; the next one may carry the response.
      }
    }
    throw new Error(`${NAME} closed the stream without a response`)
  }
  return JSON.parse(text)
}

/** Answer locally what a denied Session may and may not do. */
function deniedAnswer(message) {
  switch (message.method) {
    case 'initialize':
      return { protocolVersion: message.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: NAME, version: '1.0.0' } }
    case 'tools/list':
      return { tools: [] }
    case 'tools/call':
      return {
        content: [{ type: 'text', text: `The ${NAME} browser is not available to Klipara Scout sessions: its Google account is the one Klipara downloads with. Use the outreach browser tools.` }],
        isError: true,
      }
    default:
      return {}
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim() === '') return
  let message
  try {
    message = JSON.parse(line)
  } catch {
    warn('ignored a line that is not JSON')
    return
  }
  const hasId = message.id !== undefined && message.id !== null
  if (denied) {
    if (hasId) write({ jsonrpc: '2.0', id: message.id, result: deniedAnswer(message) })
    return
  }
  void forward(message).then(
    (response) => { if (hasId && response !== undefined) write(response) },
    (error) => {
      if (hasId) write({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } })
      else warn(error instanceof Error ? error.message : String(error))
    },
  )
})

if (URL_ === '') warn('no remote URL is set; every call will fail')
