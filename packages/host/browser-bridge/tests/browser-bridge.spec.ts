/**
 * REAL-composition coverage: a test-only cordis.yml booted through the vendored
 * Loader mounts the webserver and the bridge, and a WebSocket client standing in
 * for the browser extension exercises the wire protocol the extension speaks —
 * upgrade authentication, request/reply correlation, and every way a command
 * fails to produce a reply.
 *
 * The `tools` service is a stub: the bridge injects it to register its six
 * tools, but what those tools do to a page belongs to the extension, and the
 * registration itself is the only part the bridge owns.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { WebSocket } from 'ws'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import BrowserBridge from '../src/index.ts'

const TOKEN = 'test-token-not-a-secret'

let root: string | undefined
let context: Context | undefined

/** Stands in for the tool runtime, recording what the bridge registers. */
class StubTools extends Service {
  readonly registered: string[] = []
  constructor(ctx: Context) {
    super(ctx, 'tools')
  }
  /**
   * Record one tool registration.
   * @param definition - the tool the bridge registers.
   * @returns a disposer, as the real registry returns.
   */
  register(definition: { name: string }): () => void {
    this.registered.push(definition.name)
    return () => {}
  }
}

/**
 * Stands in for the agent roster. One agent, listed before the bridge mounts,
 * whose context carries the tool registry — which is where the Web surface puts
 * it, one registry per session behind a preset rather than one on the host.
 */
class StubAgents extends Service {
  readonly agents: { ctx: Context }[]
  constructor(ctx: Context) {
    super(ctx, 'agents')
    this.agents = [{ ctx }]
  }
  /** @returns the agents the bridge should install its tools onto. */
  list(): { ctx: Context }[] {
    return this.agents
  }
}

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Boot a webserver + bridge composition through the real Loader on one port. */
async function loadComposition(port: number, commandTimeoutMs = 30_000, path = '/browser-bridge'): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-browser-bridge-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    `    port: ${String(port)}`,
    '    authenticate: false',
    "- name: 'stub-tools'",
    "- name: 'stub-agents'",
    "- name: '@deepseek-ai/dsh-host-browser-bridge'",
    '  config:',
    `    path: '${path}'`,
    `    token: '${TOKEN}'`,
    `    commandTimeoutMs: ${String(commandTimeoutMs)}`,
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
    ['stub-agents', StubAgents],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return context
}

/** Connect as the extension does, with the token in the upgrade query string. */
function connectExtension(port: number, token: string, label?: string): WebSocket {
  const query = `token=${encodeURIComponent(token)}${label === undefined ? '' : `&label=${encodeURIComponent(label)}`}`
  return new WebSocket(`ws://127.0.0.1:${String(port)}/browser-bridge?${query}`)
}

/** Answer every command with one reply built from the request. */
function autoReply(socket: WebSocket, reply: (message: { id: string; type: string; payload: unknown }) => unknown): void {
  socket.on('message', (data: Buffer) => {
    const message = JSON.parse(String(data)) as { id: string; type: string; payload: unknown }
    socket.send(JSON.stringify({ id: message.id, result: reply(message) }))
  })
}

describe('browser-bridge', () => {
  it('registers the browser tools when it mounts', async () => {
    const ctx = await loadComposition(19_731)
    const tools = ctx.get('tools') as unknown as StubTools
    expect(tools.registered).toEqual([
      'browser_profiles',
      'browser_navigate',
      'browser_snapshot',
      'browser_click',
      'browser_type',
      'browser_scroll',
      'browser_wait',
    ])
  })

  it('refuses to start on a path no client could request', async () => {
    // A set-but-empty DSH_BROWSER_BRIDGE_PATH reached the config as '' and the
    // route registered on it, reporting success while every real upgrade to
    // /browser-bridge found no route and was destroyed without a response.
    await expect(loadComposition(19_741, 30_000, '')).rejects.toThrow('path must start with "/"')
  })

  it('refuses an upgrade presenting the wrong token', async () => {
    const ctx = await loadComposition(19_732)
    const socket = connectExtension(19_732, 'wrong-token')
    const [error] = await once(socket, 'error') as [Error]
    expect(error).toBeInstanceOf(Error)
    expect(ctx.browserBridge.connected).toBe(false)
  })

  it('carries a command to the extension and its reply back', async () => {
    const ctx = await loadComposition(19_733)
    const socket = connectExtension(19_733, TOKEN)
    await once(socket, 'open')
    const seen: { type: string; payload: unknown }[] = []
    autoReply(socket, (message) => {
      seen.push({ type: message.type, payload: message.payload })
      return 'Navigated to https://example.com/ (Example Domain)'
    })
    const result = await ctx.browserBridge.call('navigate', { url: 'https://example.com' })
    expect(result).toBe('Navigated to https://example.com/ (Example Domain)')
    expect(seen).toEqual([{ type: 'navigate', payload: { url: 'https://example.com' } }])
    socket.close()
  })

  it('correlates concurrent commands by id rather than by arrival order', async () => {
    const ctx = await loadComposition(19_734)
    const socket = connectExtension(19_734, TOKEN)
    await once(socket, 'open')
    // Replies are sent in reverse, so passing proves correlation is by id.
    const inbox: { id: string; type: string }[] = []
    socket.on('message', (data: Buffer) => {
      const message = JSON.parse(String(data)) as { id: string; type: string }
      inbox.push(message)
      if (inbox.length === 2) {
        for (const pending of [...inbox].reverse()) {
          socket.send(JSON.stringify({ id: pending.id, result: `answered ${pending.type}` }))
        }
      }
    })
    const [first, second] = await Promise.all([
      ctx.browserBridge.call('snapshot', { full: false }),
      ctx.browserBridge.call('scroll', { direction: 'down' }),
    ])
    expect(first).toBe('answered snapshot')
    expect(second).toBe('answered scroll')
    socket.close()
  })

  it('surfaces an extension-reported failure as the call rejecting', async () => {
    const ctx = await loadComposition(19_735)
    const socket = connectExtension(19_735, TOKEN)
    await once(socket, 'open')
    socket.on('message', (data: Buffer) => {
      const message = JSON.parse(String(data)) as { id: string }
      socket.send(JSON.stringify({ id: message.id, error: 'ref 12 is no longer in the document' }))
    })
    await expect(ctx.browserBridge.call('click', { ref: 12 }))
      .rejects.toThrow('ref 12 is no longer in the document')
    socket.close()
  })

  it('rejects a command that no browser is connected to receive', async () => {
    const ctx = await loadComposition(19_736)
    await expect(ctx.browserBridge.call('snapshot', {}))
      .rejects.toThrow('no browser is connected')
  })

  it('abandons a command the extension never answers', async () => {
    const ctx = await loadComposition(19_737, 1_000)
    const socket = connectExtension(19_737, TOKEN)
    await once(socket, 'open')
    // The extension stays silent: the bridge's own timeout is the only settlement.
    await expect(ctx.browserBridge.call('snapshot', {}))
      .rejects.toThrow('browser did not answer snapshot within 1000ms')
    socket.close()
  })

  it('fails a command in flight when the browser disconnects', async () => {
    const ctx = await loadComposition(19_738)
    const socket = connectExtension(19_738, TOKEN)
    await once(socket, 'open')
    const pending = ctx.browserBridge.call('snapshot', {})
    socket.on('message', () => { socket.close() })
    await expect(pending).rejects.toThrow('the browser connected as default disconnected')
  })

  it('keeps two labelled browsers side by side and routes to the named one', async () => {
    const ctx = await loadComposition(19_742)
    const work = connectExtension(19_742, TOKEN, 'work')
    const home = connectExtension(19_742, TOKEN, 'home')
    await Promise.all([once(work, 'open'), once(home, 'open')])
    autoReply(work, () => 'from work')
    autoReply(home, () => 'from home')

    expect(ctx.browserBridge.profiles()).toEqual(['home', 'work'])
    expect(await ctx.browserBridge.call('snapshot', {}, 'work')).toBe('from work')
    expect(await ctx.browserBridge.call('snapshot', {}, 'home')).toBe('from home')

    work.close()
    home.close()
  })

  it('refuses to guess when several browsers are connected', async () => {
    const ctx = await loadComposition(19_743)
    const work = connectExtension(19_743, TOKEN, 'work')
    const home = connectExtension(19_743, TOKEN, 'home')
    await Promise.all([once(work, 'open'), once(home, 'open')])
    // Acting on an unintended browser is worse than refusing to act.
    await expect(ctx.browserBridge.call('click', { ref: 1 }))
      .rejects.toThrow('several browsers are connected (home, work); pass profile to choose one')
    await expect(ctx.browserBridge.call('click', { ref: 1 }, 'laptop'))
      .rejects.toThrow('no browser is connected as "laptop"; connected: home, work')
    work.close()
    home.close()
  })

  it('fails only the disconnected profile\'s commands', async () => {
    const ctx = await loadComposition(19_744)
    const work = connectExtension(19_744, TOKEN, 'work')
    const home = connectExtension(19_744, TOKEN, 'home')
    await Promise.all([once(work, 'open'), once(home, 'open')])
    autoReply(home, () => 'home still answers')

    const orphaned = ctx.browserBridge.call('snapshot', {}, 'work')
    work.close()
    await expect(orphaned).rejects.toThrow('the browser connected as work disconnected')
    // The surviving browser is unaffected by its neighbour going away.
    expect(await ctx.browserBridge.call('snapshot', {}, 'home')).toBe('home still answers')
    home.close()
  })

  it('refuses a connection whose label could not be used', async () => {
    const ctx = await loadComposition(19_745)
    const socket = connectExtension(19_745, TOKEN, 'not a label!')
    await once(socket, 'error')
    expect(ctx.browserBridge.profiles()).toEqual([])
  })

  it('replaces an existing connection with a newer one', async () => {
    const ctx = await loadComposition(19_739)
    const first = connectExtension(19_739, TOKEN)
    await once(first, 'open')
    const closed = once(first, 'close')
    const second = connectExtension(19_739, TOKEN)
    await once(second, 'open')
    await closed
    autoReply(second, () => 'from the second connection')
    expect(await ctx.browserBridge.call('snapshot', {})).toBe('from the second connection')
    second.close()
  })

  it('drops the route and fails pending commands when the fiber disposes', async () => {
    const ctx = await loadComposition(19_740)
    const socket = connectExtension(19_740, TOKEN)
    await once(socket, 'open')
    const pending = ctx.browserBridge.call('snapshot', {})
    const settled = expect(pending).rejects.toThrow('the bridge is shutting down')
    await ctx.fiber.dispose()
    context = undefined
    await settled

    // The port is released with the server, so the extension's next dial fails
    // rather than reaching a bridge that can no longer answer.
    const refused = connectExtension(19_740, TOKEN)
    const [error] = await once(refused, 'error') as [NodeJS.ErrnoException]
    expect(error.code).toBe('ECONNREFUSED')
  })
})
