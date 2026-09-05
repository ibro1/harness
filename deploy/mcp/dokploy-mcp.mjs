#!/usr/bin/env node
// An MCP server exposing the harness's Dokploy tools to a CLI that runs its own
// agent loop (agy, opencode). Those CLIs answer with their own tools and drop
// the ones the harness offers, so a model reached through them cannot see the
// Dokploy tools a direct-provider agent gets natively. MCP is the seam they
// accept.
//
// Transport is stdio, spawned by `agy mcp add` / opencode.jsonc. Only JSON-RPC
// responses go to stdout; diagnostics go to stderr, since a stray stdout line
// corrupts the protocol. The tool catalogue is fetched from the harness command
// route, so a schema cannot drift from the one the harness registers.

import { createInterface } from 'node:readline'

const COMMAND_URL = process.env.DSH_DOKPLOY_COMMAND_URL ?? 'http://127.0.0.1:3081/dokploy/command'
const TOKEN = process.env.DSH_DOKPLOY_TOKEN ?? ''
const PROTOCOL_VERSION = '2024-11-05'

/** @param {string} message - one line, for the operator, never the protocol. */
function warn(message) {
  process.stderr.write(`dokploy-mcp: ${message}\n`)
}

/**
 * Call the harness command route.
 * @param {string} method - GET for the catalogue, POST for a tool call.
 * @param {object} [body] - the { name, args } call, for POST.
 * @returns {Promise<object>} the route's JSON answer.
 */
async function route(method, body) {
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
  const answer = await route('GET')
  catalogue = (answer.tools ?? []).map(tool => ({
    name: tool.name,
    description: tool.description,
    // Already JSON Schema, compiled by the harness, passed through unchanged.
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
        serverInfo: { name: 'dsh-dokploy', version: '1.0.0' },
      }
    case 'tools/list':
      return { tools: await tools() }
    case 'tools/call': {
      const { name, arguments: args } = request.params ?? {}
      const known = await tools()
      if (!known.some(tool => tool.name === name)) {
        return { content: [{ type: 'text', text: `No such tool: ${String(name)}` }], isError: true }
      }
      const answer = await route('POST', { name, args: args ?? {} })
      if (answer.error !== undefined) {
        // A missing server or an unset key is an answer the model reads, not a
        // transport failure.
        return { content: [{ type: 'text', text: answer.error }], isError: true }
      }
      const result = answer.result
      const text = typeof result === 'string'
        ? result
        : typeof result === 'object' && result !== null && typeof result.text === 'string'
          ? result.text
          : JSON.stringify(result ?? '')
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

if (TOKEN === '') warn('DSH_DOKPLOY_TOKEN is unset; every call will be refused')
