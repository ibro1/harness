#!/usr/bin/env node
// An MCP server exposing the harness's browser tools to a CLI that runs its own
// agent loop.
//
// `agy` and `opencode` are agents, not models: they answer a chat request with
// their own tools and discard the ones the harness offers. A model reached
// through them therefore cannot drive the browser, however well the bridge
// works. MCP is the seam those CLIs do accept, so the tools arrive as the CLI's
// own rather than the harness's.
//
// Transport is stdio: newline-delimited JSON-RPC on stdin and stdout, which is
// what `agy mcp add <name> node <this file>` spawns. Nothing is written to
// stdout that is not a response — diagnostics go to stderr, since a stray line
// on stdout corrupts the protocol.
//
// The tool catalogue is fetched from the bridge rather than restated here: one
// list, so a schema cannot drift from the one the harness registers.

import { createInterface } from 'node:readline'

const COMMAND_URL = process.env.DSH_BROWSER_COMMAND_URL ?? 'http://127.0.0.1:3081/browser-bridge/command'
const TOKEN = process.env.DSH_BROWSER_BRIDGE_TOKEN ?? ''
const PROTOCOL_VERSION = '2024-11-05'

/** @param {string} message - one line, for the operator, never the protocol. */
function warn(message) {
  process.stderr.write(`browser-mcp: ${message}\n`)
}

/**
 * Call the bridge's command surface.
 * @param {string} method - GET for the catalogue, POST for a command.
 * @param {object} [body] - the command, for POST.
 * @returns {Promise<object>} the bridge's JSON answer.
 */
async function bridge(method, body) {
  const response = await fetch(COMMAND_URL, {
    method,
    headers: {
      'Authorization': `Bearer ${TOKEN}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!response.ok) throw new Error(`the harness answered ${String(response.status)}`)
  return await response.json()
}

/** The catalogue, fetched once per process and reused. */
let catalogue

/** @returns {Promise<Array<{name: string, description: string, inputSchema: object}>>} */
async function tools() {
  if (catalogue !== undefined) return catalogue
  const answer = await bridge('GET')
  catalogue = (answer.tools ?? []).map(tool => ({
    name: tool.name,
    description: tool.description,
    // Already JSON Schema, compiled by the harness from one declaration: it is
    // passed through rather than rebuilt, so a CLI and the harness cannot
    // disagree about what an argument means.
    inputSchema: tool.parameters,
  }))
  return catalogue
}

/**
 * Answer one JSON-RPC request.
 * @param {{method: string, params?: object}} request
 * @returns {Promise<object>} the result payload.
 */
async function handle(request) {
  switch (request.method) {
    case 'initialize':
      return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'dsh-browser', version: '1.0.0' },
      }
    case 'tools/list':
      return { tools: await tools() }
    case 'tools/call': {
      const { name, arguments: args } = request.params ?? {}
      const known = await tools()
      if (!known.some(tool => tool.name === name)) {
        return { content: [{ type: 'text', text: `No such tool: ${String(name)}` }], isError: true }
      }
      // The tool name carries the command: browser_snapshot drives 'snapshot'.
      const { profile, ...payload } = args ?? {}
      const answer = await bridge('POST', {
        type: String(name).replace(/^browser_/, ''),
        payload,
        profile,
      })
      if (answer.error !== undefined) {
        // A browser that is not connected, or a ref that has gone, is an answer
        // the model should read and act on, not a transport failure.
        return { content: [{ type: 'text', text: answer.error }], isError: true }
      }
      const result = answer.result
      const text = typeof result === 'string' ? result : JSON.stringify(result ?? '')
      return { content: [{ type: 'text', text }] }
    }
    default:
      throw Object.assign(new Error(`unsupported method ${request.method}`), { code: -32601 })
  }
}

const input = createInterface({ input: process.stdin })

input.on('line', (line) => {
  if (line.trim() === '') return
  let request
  try {
    request = JSON.parse(line)
  } catch {
    warn('ignored a line that is not JSON')
    return
  }
  void handle(request).then(
    (result) => {
      // A notification has no id and takes no answer.
      if (request.id === undefined || request.id === null) return
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`)
    },
    (error) => {
      if (request.id === undefined || request.id === null) return
      process.stdout.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        error: { code: error.code ?? -32603, message: error instanceof Error ? error.message : String(error) },
      })}\n`)
    },
  )
})

if (TOKEN === '') warn('DSH_BROWSER_BRIDGE_TOKEN is unset; every call will be refused')
