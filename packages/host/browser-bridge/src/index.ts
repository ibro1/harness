/**
 * Browser control: one WebSocket the operator's browser extension holds open,
 * and the agent tools that speak through it.
 *
 * The extension runs in a browser this process cannot reach — behind NAT, on a
 * laptop — so the browser dials in and the connection stays open, rather than
 * the harness calling out. Every tool call is a request over that socket with a
 * correlation id, awaiting the extension's reply.
 *
 * Authentication is a shared token in the upgrade query string, because a
 * browser cannot set request headers on a WebSocket. The token is compared in
 * constant time and the socket is destroyed without a response when it does not
 * match, so the endpoint reveals nothing about whether it exists.
 */

import { randomUUID, timingSafeEqual, createHash } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { WebSocketServer, type WebSocket } from 'ws'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-tools'
import { registerBrowserTools } from './tools.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    browserBridge: BrowserBridge
  }
}

/** How long a tool call waits for the browser before giving up. */
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000

/** Bridge configuration. */
export interface Config {
  /** Absolute upgrade path the extension connects to. */
  path: string
  /** Shared secret the extension presents as `?token=`. */
  token: string
  /** Milliseconds one command may take before it is abandoned. */
  commandTimeoutMs: number
}

/** One command awaiting its reply from the browser. */
interface Pending {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** Compare two secrets without leaking their relationship through timing. */
function secretEquals(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash('sha256').update(a).digest(),
    createHash('sha256').update(b).digest(),
  )
}

/**
 * The connected browser, and the request/reply channel to it.
 *
 * One connection at a time: a second extension replaces the first, because two
 * browsers answering the same `browser_click` would make the result ambiguous
 * rather than doubling the capability.
 */
export class BrowserBridge extends Service {
  static inject = ['webServer', 'tools']

  static Config: z<Config> = z.object({
    path: z.string().default('/browser-bridge'),
    token: z.string().default(''),
    commandTimeoutMs: z.natural().min(1000).default(DEFAULT_COMMAND_TIMEOUT_MS),
  })

  private readonly server = new WebSocketServer({ noServer: true })
  private socket: WebSocket | undefined
  private readonly pending = new Map<string, Pending>()

  /** @param ctx - host context. @param config - validated bridge config. */
  constructor(ctx: Context, public config: Config) {
    super(ctx, 'browserBridge')
  }

  /** Whether an extension is currently connected. */
  get connected(): boolean {
    return this.socket !== undefined
  }

  /**
   * Send one command to the connected browser and await its reply.
   * @param type - command name the extension dispatches on.
   * @param payload - command arguments, JSON-serializable.
   * @returns the extension's result.
   * @throws when no browser is connected, or the reply does not arrive in time.
   */
  async call(type: string, payload: unknown): Promise<unknown> {
    const socket = this.socket
    if (socket === undefined) {
      throw new Error('no browser is connected; open a page and connect the extension')
    }
    const id = randomUUID()
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`browser did not answer ${type} within ${String(this.config.commandTimeoutMs)}ms`))
      }, this.config.commandTimeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      socket.send(JSON.stringify({ id, type, payload }))
    })
  }

  /** Accept or refuse one upgrade, then own the socket. */
  private readonly handleUpgrade = (req: IncomingMessage, rawSocket: Duplex, head: Buffer): void => {
    const url = new URL(req.url ?? '/', 'http://x')
    const presented = url.searchParams.get('token') ?? ''
    if (this.config.token === '' || !secretEquals(presented, this.config.token)) {
      // No response body: an endpoint that answers differently to a wrong token
      // tells an unauthenticated caller that it exists.
      rawSocket.destroy()
      return
    }
    this.server.handleUpgrade(req, rawSocket, head, (socket) => {
      this.adopt(socket)
    })
  }

  /** Replace any existing connection with this one and wire its lifetime. */
  private adopt(socket: WebSocket): void {
    this.socket?.close(1000, 'replaced by a newer connection')
    this.socket = socket
    // ws hands a Buffer (or an array of them) per frame; the protocol is text.
    socket.on('message', (data: Buffer | Buffer[]) => {
      this.receive(Array.isArray(data) ? Buffer.concat(data).toString('utf8') : data.toString('utf8'))
    })
    socket.on('close', () => {
      // A socket already replaced by a newer one owns nothing: its close is the
      // tail of `adopt` above, and failing the pending commands here would
      // abandon work the connected browser is still able to answer.
      if (this.socket !== socket) return
      this.socket = undefined
      this.failAll(new Error('the browser disconnected'))
    })
    socket.on('error', () => { socket.close() })
    this.ctx.logger.info('browser-bridge: extension connected')
  }

  /** Settle the pending command one reply belongs to. */
  private receive(raw: string): void {
    let message: { id?: unknown; result?: unknown; error?: unknown }
    try {
      message = JSON.parse(raw) as typeof message
    } catch {
      // A frame this build cannot parse settles nothing; the command times out.
      return
    }
    const id = typeof message.id === 'string' ? message.id : undefined
    if (id === undefined) return
    const waiting = this.pending.get(id)
    if (waiting === undefined) return
    this.pending.delete(id)
    clearTimeout(waiting.timer)
    if (typeof message.error === 'string') waiting.reject(new Error(message.error))
    else waiting.resolve(message.result)
  }

  /** Reject everything still waiting, so no tool call hangs past a disconnect. */
  private failAll(reason: Error): void {
    for (const [id, waiting] of this.pending) {
      this.pending.delete(id)
      clearTimeout(waiting.timer)
      waiting.reject(reason)
    }
  }

  /** Register the upgrade route and the browser tools. */
  [Service.init](): void {
    if (this.config.token === '') {
      throw new Error('browser-bridge: a token is required; set DSH_BROWSER_BRIDGE_TOKEN')
    }
    this.ctx.effect(
      () => this.ctx.webServer.registerUpgrade({
        path: this.config.path,
        handler: this.handleUpgrade,
        // The token in the upgrade URL is this route's own authentication.
        authenticate: false,
      }),
      `browser-bridge: ${this.config.path}`,
    )
    registerBrowserTools(this.ctx)
    // Teardown is a disposer, not a lifecycle method: cordis has no dispose
    // symbol, and the effect that owns the route should own the socket too.
    this.ctx.effect(() => () => {
      this.failAll(new Error('the bridge is shutting down'))
      this.socket?.close(1001, 'harness shutting down')
      this.socket = undefined
      this.server.close()
    }, 'browser-bridge: connection')
  }

}

export default BrowserBridge
