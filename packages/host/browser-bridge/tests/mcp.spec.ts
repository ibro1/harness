/**
 * The MCP server, driven as a CLI drives it: a real subprocess speaking
 * newline-delimited JSON-RPC over stdio against a running bridge.
 *
 * It exists because `agy` and `opencode` answer with their own tools and
 * discard the harness's, so a model reached through them can only drive the
 * browser if the tools arrive as the CLI's own. That path is the product here,
 * and it crosses a process boundary no unit test covers.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { WebSocket } from 'ws'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import BrowserBridge from '../src/index.ts'

const TOKEN = 'test-token-not-a-secret'
const SERVER = join(dirname(new URL(import.meta.url).pathname), '../../../../deploy/mcp/browser-mcp.mjs')

let context: Context | undefined
let child: ChildProcessWithoutNullStreams | undefined
let root: string | undefined

class StubTools extends Service {
  constructor(ctx: Context) { super(ctx, 'tools') }
  /** @returns a disposer, as the real registry returns. */
  register(): () => void { return () => {} }
}

afterEach(async () => {
  child?.kill()
  child = undefined
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Boot a webserver + bridge composition on one port. */
async function boot(port: number): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-mcp-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    `    port: ${String(port)}`,
    '    authenticate: false',
    "- name: 'stub-tools'",
    "- name: '@deepseek-ai/dsh-host-browser-bridge'",
    '  config:',
    "    path: '/browser-bridge'",
    `    token: '${TOKEN}'`,
    '',
  ].join('\n'))
  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', HttpServer],
    ['@deepseek-ai/dsh-host-browser-bridge', BrowserBridge],
    ['stub-tools', StubTools],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await context.loader.await()
  return context
}

/** Start the MCP server pointed at one bridge, and return a request function. */
function start(port: number, token = TOKEN): (method: string, params?: unknown) => Promise<Record<string, unknown>> {
  child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      DSH_BROWSER_COMMAND_URL: `http://127.0.0.1:${String(port)}/browser-bridge/command`,
      DSH_BROWSER_BRIDGE_TOKEN: token,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let buffer = ''
  const waiting = new Map<number, (value: Record<string, unknown>) => void>()
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    let index = buffer.indexOf('\n')
    while (index !== -1) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (line.trim() !== '') {
        const message = JSON.parse(line) as { id: number } & Record<string, unknown>
        waiting.get(message.id)?.(message)
        waiting.delete(message.id)
      }
      index = buffer.indexOf('\n')
    }
  })
  let id = 0
  return async (method, params) => {
    id += 1
    const current = id
    const reply = new Promise<Record<string, unknown>>((resolve) => { waiting.set(current, resolve) })
    child?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: current, method, params })}\n`)
    return await reply
  }
}

/** Connect as the extension does, answering every command from its type. */
async function connectBrowser(port: number, label: string): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/browser-bridge?token=${TOKEN}&label=${label}`)
  await once(socket, 'open')
  socket.on('message', (data: Buffer) => {
    const message = JSON.parse(String(data)) as { id: string; type: string; payload: { url?: string } }
    socket.send(JSON.stringify({ id: message.id, result: `${message.type} ran on ${message.payload.url ?? label}` }))
  })
  return socket
}

describe('browser MCP server', () => {
  it('advertises the same tools the harness registers', async () => {
    await boot(19_751)
    const request = start(19_751)
    const init = await request('initialize', {})
    expect((init.result as { serverInfo: { name: string } }).serverInfo.name).toBe('dsh-browser')

    const listed = await request('tools/list')
    const tools = (listed.result as { tools: { name: string; inputSchema: { properties: Record<string, unknown> } }[] }).tools
    expect(tools.map(tool => tool.name)).toEqual([
      'browser_profiles',
      'browser_navigate',
      'browser_snapshot',
      'browser_click',
      'browser_type',
      'browser_scroll',
      'browser_wait',
    ])
    // The catalogue is fetched from the bridge, so a schema cannot drift from
    // the one the harness registers.
    const navigate = tools.find(tool => tool.name === 'browser_navigate')
    expect(navigate?.inputSchema.properties).toHaveProperty('url')
    expect(navigate?.inputSchema.properties).toHaveProperty('profile')
  })

  it('drives a connected browser through a tool call', async () => {
    await boot(19_752)
    const socket = await connectBrowser(19_752, 'work')
    const request = start(19_752)
    await request('initialize', {})

    const called = await request('tools/call', {
      name: 'browser_navigate',
      arguments: { url: 'https://example.com', profile: 'work' },
    })
    expect(called.result).toEqual({ content: [{ type: 'text', text: 'navigate ran on https://example.com' }] })
    socket.close()
  })

  it('reports a bridge refusal as a tool error the model can read', async () => {
    await boot(19_753)
    const request = start(19_753)
    await request('initialize', {})
    // No browser connected: an answer to act on, not a transport failure.
    const called = await request('tools/call', { name: 'browser_snapshot', arguments: {} })
    expect(called.result).toEqual({
      content: [{ type: 'text', text: 'no browser is connected; open a page and connect the extension' }],
      isError: true,
    })
  })

  it('is refused wholesale when its token is wrong', async () => {
    await boot(19_754)
    const request = start(19_754, 'the-wrong-token')
    await request('initialize', {})
    const listed = await request('tools/list')
    expect(listed.error).toBeDefined()
  })
})
