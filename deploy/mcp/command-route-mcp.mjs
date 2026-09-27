// An MCP server over one of the harness's token-guarded command routes, for a
// CLI that runs its own agent loop (agy, opencode). Those CLIs answer with
// their own tools and drop the ones the harness offers, so a model reached
// through them cannot see a plugin's tools the way a direct-provider agent
// does. MCP is the seam they accept; each plugin's wrapper script names its
// route and token and calls serveCommandRoute.
//
// Transport is stdio, spawned by `agy mcp add` / opencode.jsonc. Only JSON-RPC
// responses go to stdout; diagnostics go to stderr, since a stray stdout line
// corrupts the protocol. The tool catalogue is fetched from the command route,
// so a schema cannot drift from the one the harness registers.
//
// Every call carries the CLI's DSH_SESSION_ID, which the bridges set per
// request and the CLIs pass on to the servers they spawn. A route whose tools
// act on a session's workspace resolves the directory from it; the others
// ignore it.

import { createInterface } from 'node:readline'

const PROTOCOL_VERSION = '2024-11-05'

/**
 * Serve one command route over MCP on stdio until stdin closes.
 * @param {object} options
 * @param {string} options.name - the MCP server name, as registered with the CLI.
 * @param {string} options.url - the command route's absolute URL.
 * @param {string} options.token - the route's bearer token.
 * @param {string} options.tokenVar - the variable the token came from, for the startup warning.
 */
export function serveCommandRoute({ name, url, token, tokenVar }) {
  const session = process.env.DSH_SESSION_ID ?? ''

  /** @param {string} message - one line, for the operator, never the protocol. */
  const warn = (message) => {
    process.stderr.write(`${name}: ${message}\n`)
  }

  /**
   * Call the command route.
   * @param {string} method - GET for the catalogue, POST for a tool call.
   * @param {object} [body] - the { name, args, session } call, for POST.
   * @returns {Promise<object>} the route's JSON answer.
   */
  const route = async (method, body) => {
    const response = await fetch(url, {
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
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
  const tools = async () => {
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
  const handle = async (request) => {
    switch (request.method) {
      case 'initialize':
        return {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name, version: '1.0.0' },
        }
      case 'tools/list':
        return { tools: await tools() }
      case 'tools/call': {
        const { name: tool, arguments: args } = request.params ?? {}
        const known = await tools()
        if (!known.some(entry => entry.name === tool)) {
          return { content: [{ type: 'text', text: `No such tool: ${String(tool)}` }], isError: true }
        }
        const answer = await route('POST', { name: tool, args: args ?? {}, ...(session === '' ? {} : { session }) })
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

  if (token === '') warn(`${tokenVar} is unset; every call will be refused`)
}
