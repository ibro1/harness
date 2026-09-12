/**
 * The Chromium half of `capture_page`: resolving the binary, launching it with
 * a hard timeout, speaking the DevTools Protocol to it, and reading the page's
 * geometry back out of the live DOM.
 *
 * Two seams keep this file out of the tests. {@link LaunchBrowser} owns the
 * process, and {@link ConnectCdp} owns the socket; {@link createChromiumDriver}
 * takes both, so the whole choreography — navigate, settle, force lazy content,
 * measure, screenshot, kill — can be driven against stand-ins.
 *
 * @module @deepseek-ai/dsh-host-capture/src/chromium
 */

import { spawn } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { isIP } from 'node:net'
import type { CaptureDriver, CaptureRequest, CaptureResult, PageMeasurement } from './driver.ts'

/** Executable names to try, in the order the `campaign-assets` skill tries them. */
export const BROWSER_CANDIDATES = ['chromium-browser', 'chromium', 'google-chrome', 'google-chrome-stable'] as const

/** A launched browser process and the way to end it. */
export interface LaunchedBrowser {
  /** The browser-level DevTools WebSocket endpoint it printed on startup. */
  endpoint: string
  /** Terminate the process. Safe to call more than once. */
  kill(): void
}

/**
 * Start a browser and wait for its DevTools endpoint.
 * @param binary - absolute path of the executable.
 * @param args - the full command line after the binary.
 * @param timeoutMs - give up if no endpoint is printed within this long.
 * @returns the running browser.
 * @throws when the process exits first or prints no endpoint in time.
 */
export type LaunchBrowser = (binary: string, args: string[], timeoutMs: number) => Promise<LaunchedBrowser>

/** One open DevTools Protocol connection, flattened sessions included. */
export interface CdpConnection {
  /**
   * Send one command and await its reply.
   * @param method - the CDP method name.
   * @param params - the method's parameters.
   * @param sessionId - the flattened session to address, or undefined for the browser.
   * @returns the reply's result object.
   * @throws when the protocol answers with an error or the socket closes first.
   */
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<Record<string, unknown>>
  /**
   * Await one event.
   * @param method - the CDP event name.
   * @param sessionId - the session it must arrive on, or undefined for any.
   * @param timeoutMs - reject when it has not arrived by then.
   * @param signal - reject when the capture is abandoned.
   * @returns the event's parameters.
   * @throws on timeout, abort, or socket close.
   */
  waitFor(method: string, sessionId: string | undefined, timeoutMs: number, signal: AbortSignal): Promise<Record<string, unknown>>
  /** Close the socket and reject everything still outstanding. */
  close(): void
}

/**
 * Open a DevTools Protocol connection.
 * @param endpoint - the `ws://` endpoint the browser printed.
 * @param signal - abort while connecting.
 * @returns the open connection.
 * @throws when the socket cannot be opened.
 */
export type ConnectCdp = (endpoint: string, signal: AbortSignal) => Promise<CdpConnection>

/** Everything the driver needs that deployment may vary. */
export interface ChromiumDriverOptions {
  /** Explicit browser path; empty means search PATH for {@link BROWSER_CANDIDATES}. */
  browserPath: string
  /** Milliseconds to wait for the DevTools endpoint after spawning. */
  launchTimeoutMs: number
  /** Milliseconds to wait for the load event after navigating. */
  loadTimeoutMs: number
  /** Milliseconds after which the browser is killed no matter what it is doing. */
  hardTimeoutMs: number
  /** Tallest full-page capture, in CSS pixels; taller documents are cut here. */
  maxFullPageHeightPx: number
  /** Pause after each scroll step while forcing lazy content to load. */
  scrollStepMs: number
  /** Process launcher; overridden in tests. */
  launch?: LaunchBrowser
  /** Connection opener; overridden in tests. */
  connect?: ConnectCdp
  /** Binary resolver; overridden in tests. */
  resolveBinary?: () => string
}

/**
 * Find a Chromium executable on PATH.
 *
 * The deployed image installs `chromium` from apt, so the plain name is
 * normally the hit; the candidate order matches the `campaign-assets` skill's
 * `command -v chromium-browser || chromium || google-chrome` so both surfaces
 * pick the same browser on a machine that has several.
 *
 * @param explicit - a configured absolute path, tried first when non-empty.
 * @returns the absolute path of the executable.
 * @throws when no candidate is executable, naming every name tried — a blank
 * PNG from a missing binary is the failure this plugin exists to stop.
 */
export function resolveBrowserPath(explicit = ''): string {
  const executable = (candidate: string): boolean => {
    try {
      accessSync(candidate, constants.X_OK)
      return true
    } catch {
      // Not present or not executable; the next candidate is tried, and an
      // exhausted list throws below with the full list.
      return false
    }
  }
  if (explicit !== '') {
    if (executable(explicit)) return explicit
    throw new Error(`capture_page: the configured browser ${explicit} is not an executable file.`)
  }
  const dirs = (process.env['PATH'] ?? '').split(delimiter).filter(dir => dir !== '')
  for (const candidate of BROWSER_CANDIDATES) {
    for (const dir of dirs) {
      const full = join(dir, candidate)
      if (executable(full)) return full
    }
  }
  throw new Error(
    `capture_page found no browser on PATH: tried ${BROWSER_CANDIDATES.join(', ')}. `
    + 'Install chromium (the deployed image installs it from apt) or set the capture plugin\'s browserPath.',
  )
}

/** The endpoint line Chromium prints on stderr once the protocol is listening. */
const ENDPOINT_LINE = /DevTools listening on (ws:\/\/\S+)/u

/**
 * Spawn a browser and read the DevTools endpoint off its stderr.
 * @param binary - absolute path of the executable.
 * @param args - the command line after the binary.
 * @param timeoutMs - give up if no endpoint appears within this long.
 * @returns the running browser and its endpoint.
 * @throws when the process fails to spawn, exits early, or stays silent.
 */
export const spawnChromium: LaunchBrowser = (binary, args, timeoutMs) => {
  return new Promise<LaunchedBrowser>((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    // SIGKILL rather than a graceful shutdown: the caller owns the profile
    // directory and deletes it, so there is nothing for the browser to flush,
    // and a wedged renderer must not outlive the tool call.
    const kill = (): void => { child.kill('SIGKILL') }
    let stderr = ''
    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }
    const timer = setTimeout(() => {
      finish(() => {
        kill()
        reject(new Error(`capture_page: ${binary} printed no DevTools endpoint within ${String(timeoutMs)}ms. Last output: ${stderr.slice(-300)}`))
      })
    }, timeoutMs)
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
      const match = ENDPOINT_LINE.exec(stderr)
      if (match !== null) finish(() => { resolve({ endpoint: match[1] as string, kill }) })
    })
    child.on('error', (error: Error) => {
      finish(() => { reject(new Error(`capture_page could not start ${binary}: ${error.message}`)) })
    })
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      finish(() => {
        reject(new Error(`capture_page: ${binary} exited (${String(code ?? signal)}) before listening. Output: ${stderr.slice(-300)}`))
      })
    })
  })
}

/** One outstanding command awaiting its reply. */
interface PendingCommand {
  resolve: (value: Record<string, unknown>) => void
  reject: (error: Error) => void
  method: string
}

/** One event a caller is waiting for. */
interface EventWaiter {
  method: string
  sessionId: string | undefined
  deliver: (params: Record<string, unknown>) => void
}

/** A DevTools Protocol message, as far as this client reads it. */
interface CdpMessage {
  id?: number
  method?: string
  sessionId?: string
  params?: Record<string, unknown>
  result?: Record<string, unknown>
  error?: { message?: string; data?: string }
}

/** A connection over one WebSocket, multiplexing commands and events by id. */
class SocketConnection implements CdpConnection {
  #nextId = 1
  readonly #pending = new Map<number, PendingCommand>()
  readonly #waiters = new Set<EventWaiter>()
  #closedWith: Error | undefined

  /**
   * @param socket - an already-open socket to the browser endpoint.
   */
  constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', (event: { data: unknown }) => { this.#receive(event.data) })
    socket.addEventListener('close', () => { this.#fail(new Error('capture_page: the browser closed its DevTools connection.')) })
    socket.addEventListener('error', () => { this.#fail(new Error('capture_page: the DevTools connection failed.')) })
  }

  /** Route one incoming frame to its command or its event waiters. */
  #receive(data: unknown): void {
    if (typeof data !== 'string') return
    let message: CdpMessage
    try {
      message = JSON.parse(data) as CdpMessage
    } catch {
      // A frame that is not JSON cannot be routed; the command that wanted it
      // still times out with its own message.
      return
    }
    if (typeof message.id === 'number') {
      const pending = this.#pending.get(message.id)
      if (pending === undefined) return
      this.#pending.delete(message.id)
      if (message.error !== undefined) {
        pending.reject(new Error(`capture_page: ${pending.method} failed: ${message.error.message ?? 'unknown protocol error'}`))
        return
      }
      pending.resolve(message.result ?? {})
      return
    }
    if (typeof message.method !== 'string') return
    for (const waiter of [...this.#waiters]) {
      if (waiter.method !== message.method) continue
      if (waiter.sessionId !== undefined && waiter.sessionId !== message.sessionId) continue
      this.#waiters.delete(waiter)
      waiter.deliver(message.params ?? {})
    }
  }

  /** Reject everything outstanding once the socket can no longer answer. */
  #fail(error: Error): void {
    this.#closedWith ??= error
    for (const pending of this.#pending.values()) pending.reject(error)
    this.#pending.clear()
    this.#waiters.clear()
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    if (this.#closedWith !== undefined) return Promise.reject(this.#closedWith)
    const id = this.#nextId++
    const frame = JSON.stringify({ id, method, params, ...sessionId === undefined ? {} : { sessionId } })
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, method })
      try {
        this.socket.send(frame)
      } catch (error) {
        this.#pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  waitFor(method: string, sessionId: string | undefined, timeoutMs: number, signal: AbortSignal): Promise<Record<string, unknown>> {
    if (this.#closedWith !== undefined) return Promise.reject(this.#closedWith)
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const waiter: EventWaiter = {
        method,
        sessionId,
        deliver: (params) => {
          clearTimeout(timer)
          signal.removeEventListener('abort', onAbort)
          resolve(params)
        },
      }
      const stop = (error: Error): void => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        this.#waiters.delete(waiter)
        reject(error)
      }
      const onAbort = (): void => { stop(new Error(`capture_page: abandoned while waiting for ${method}.`)) }
      const timer = setTimeout(() => { stop(new Error(`capture_page: ${method} did not arrive within ${String(timeoutMs)}ms.`)) }, timeoutMs)
      signal.addEventListener('abort', onAbort, { once: true })
      this.#waiters.add(waiter)
    })
  }

  close(): void {
    this.#fail(new Error('capture_page: the DevTools connection was closed.'))
    try {
      this.socket.close()
    } catch {
      // Already closing or closed; nothing else holds the socket.
    }
  }
}

/** Open a WebSocket to the browser endpoint using the runtime's own client. */
export const connectWebSocket: ConnectCdp = (endpoint, signal) => {
  return new Promise<CdpConnection>((resolve, reject) => {
    const socket = new WebSocket(endpoint)
    const onAbort = (): void => {
      socket.close()
      reject(new Error('capture_page: abandoned while connecting to the browser.'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    socket.addEventListener('open', () => {
      signal.removeEventListener('abort', onAbort)
      resolve(new SocketConnection(socket))
    }, { once: true })
    socket.addEventListener('error', () => {
      signal.removeEventListener('abort', onAbort)
      reject(new Error(`capture_page could not open the DevTools connection at ${endpoint}.`))
    }, { once: true })
  })
}

/**
 * Force every lazy image to load and let the page react to being scrolled.
 *
 * `captureBeyondViewport` alone does NOT materialise lazy content: Chromium
 * paints a taller surface, but `loading="lazy"` images below the fold were
 * never requested, so they come out blank — a full-page screenshot that
 * "proves" images are missing when they load fine for a human. Setting
 * `loading` to eager and re-assigning `src` starts the fetch, and the scroll
 * pass additionally triggers IntersectionObserver-driven loaders and
 * scroll-reveal animations that no flag can reach.
 *
 * @param stepMs - pause after each scroll step.
 * @returns the expression to evaluate in the page.
 */
function forceLazyContentScript(stepMs: number): string {
  return `(async () => {
    const pause = (ms) => new Promise(done => setTimeout(done, ms))
    for (const img of document.querySelectorAll('img[loading="lazy"], iframe[loading="lazy"]')) {
      img.loading = 'eager'
      const src = img.currentSrc || img.src
      if (src) img.src = src
    }
    const step = Math.max(200, window.innerHeight || 600)
    const total = () => Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)
    for (let y = 0; y < total(); y += step) {
      window.scrollTo(0, y)
      await pause(${String(stepMs)})
    }
    window.scrollTo(0, 0)
    await pause(${String(stepMs)})
    await Promise.all([...document.images].filter(img => !img.complete).map(img => new Promise(done => {
      img.addEventListener('load', done, { once: true })
      img.addEventListener('error', done, { once: true })
      setTimeout(done, ${String(Math.max(stepMs, 250))})
    })))
    if (document.fonts && document.fonts.ready) await document.fonts.ready
    return true
  })()`
}

/**
 * Read the page's geometry back out of the live DOM.
 *
 * Everything here is a number or a string the caller can quote in a bug report:
 * `scrollWidth` against the viewport width makes horizontal overflow a
 * measurement instead of an opinion, and the broken-image list names the
 * requests that actually failed rather than leaving a reader to squint at a PNG.
 *
 * @param selector - the selector to measure, or undefined.
 * @returns the expression to evaluate in the page.
 */
function measureScript(selector: string | undefined): string {
  const selectorJson = JSON.stringify(selector ?? null)
  return `(() => {
    const doc = document.documentElement
    const images = [...document.querySelectorAll('img')]
    const broken = images
      .filter(img => !img.complete || img.naturalWidth === 0)
      .map(img => img.currentSrc || img.getAttribute('src') || '(no src)')
    const all = document.querySelectorAll('*')
    let painted = 0
    for (const element of all) {
      const box = element.getBoundingClientRect()
      if (box.width > 0 && box.height > 0) painted++
    }
    const result = {
      title: document.title,
      finalUrl: location.href,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      scrollWidth: doc.scrollWidth,
      scrollHeight: doc.scrollHeight,
      elementCount: all.length,
      paintedElementCount: painted,
      imageCount: images.length,
      brokenImages: broken.slice(0, 50),
    }
    const selector = ${selectorJson}
    if (selector !== null) {
      let matches = []
      try {
        matches = [...document.querySelectorAll(selector)]
      } catch (error) {
        return { ...result, selector: { selector, matched: false, count: 0, error: String(error && error.message || error) } }
      }
      const first = matches[0]
      if (!first) {
        result.selector = { selector, matched: false, count: 0 }
      } else {
        const box = first.getBoundingClientRect()
        result.selector = {
          selector,
          matched: true,
          count: matches.length,
          rect: {
            x: box.x, y: box.y, width: box.width, height: box.height,
            top: box.top, right: box.right, bottom: box.bottom, left: box.left,
          },
          page: {
            x: box.left + window.scrollX,
            y: box.top + window.scrollY,
            width: box.width,
            height: box.height,
          },
        }
      }
    }
    return result
  })()`
}

/** Read a string field out of a protocol reply. */
function str(value: unknown, field: string, method: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`capture_page: ${method} returned no ${field}.`)
  }
  return value
}

/** The Chromium flags every launch uses, with the reason each one is not optional. */
function browserArgs(request: CaptureRequest, userDataDir: string): string[] {
  const args = [
    // Plain --headless, not --headless=new: recent Chromium maps it to the new
    // headless and older builds still understand it, so one spelling works
    // across the versions an apt image may carry.
    '--headless',
    // uid 1000 with no user namespaces in this container: the sandbox cannot
    // start, and without this flag the browser exits before it listens.
    '--no-sandbox',
    // /dev/shm is small in containers; without this a large page crashes the
    // renderer mid-capture and the screenshot comes back blank.
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--hide-scrollbars',
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--metrics-recording-only',
    `--user-data-dir=${userDataDir}`,
    '--remote-debugging-port=0',
  ]
  if (!request.literalHost && request.addresses.length > 0) {
    // Pin the screened answer into the browser's own resolver, so a name that
    // answers differently on the browser's lookup than on ours cannot move the
    // capture to an address the SSRF screen never saw.
    const address = request.addresses[0] as string
    const mapped = isIP(address) === 6 ? `[${address}]` : address
    args.push(`--host-resolver-rules=MAP ${new URL(request.url).hostname} ${mapped}`)
  }
  args.push('about:blank')
  return args
}

/** Sleep, giving up early when the capture is abandoned. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('capture_page: abandoned while waiting for the page to settle.'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Evaluate one expression in the page and return its value.
 * @param connection - the open protocol connection.
 * @param sessionId - the page session.
 * @param expression - JavaScript to run, awaited when it returns a promise.
 * @returns the value, structured-cloned back from the page.
 * @throws when the page threw.
 */
async function evaluate<T>(connection: CdpConnection, sessionId: string, expression: string): Promise<T> {
  const reply = await connection.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  }, sessionId)
  const details = reply['exceptionDetails'] as { text?: string; exception?: { description?: string } } | undefined
  if (details !== undefined) {
    throw new Error(`capture_page: the page threw while being measured: ${details.exception?.description ?? details.text ?? 'unknown error'}`)
  }
  const result = reply['result'] as { value?: unknown } | undefined
  return result?.value as T
}

/**
 * Build the real driver: one browser per capture, killed in a `finally`.
 * @param options - timeouts, caps, and the launcher/connection seams.
 * @returns a driver that screenshots and measures one page per call.
 */
export function createChromiumDriver(options: ChromiumDriverOptions): CaptureDriver {
  const launch = options.launch ?? spawnChromium
  const connect = options.connect ?? connectWebSocket
  const resolveBinary = options.resolveBinary ?? (() => resolveBrowserPath(options.browserPath))

  return {
    async capture(request: CaptureRequest, signal: AbortSignal): Promise<CaptureResult> {
      const binary = resolveBinary()
      const userDataDir = await mkdtemp(join(tmpdir(), 'dsh-capture-'))
      const notes: string[] = []
      // Every wait below observes this one signal, so the hard timeout, the
      // caller's cancellation and a protocol failure all end the same way.
      const controller = new AbortController()
      const onAbort = (): void => { controller.abort() }
      signal.addEventListener('abort', onAbort, { once: true })
      // A property rather than a local: the only assignment happens inside the
      // timer callback, and control-flow analysis narrows a local to `false`
      // everywhere else — which reads as "this branch is dead" when it is the
      // branch that turns a hung page into a message worth reading.
      const deadline = { passed: false }
      const hardTimer = setTimeout(() => {
        deadline.passed = true
        controller.abort()
      }, options.hardTimeoutMs)
      let browser: LaunchedBrowser | undefined
      let connection: CdpConnection | undefined
      try {
        browser = await launch(binary, browserArgs(request, userDataDir), options.launchTimeoutMs)
        connection = await connect(browser.endpoint, controller.signal)
        const created = await connection.send('Target.createTarget', { url: 'about:blank' })
        const targetId = str(created['targetId'], 'targetId', 'Target.createTarget')
        const attached = await connection.send('Target.attachToTarget', { targetId, flatten: true })
        const sessionId = str(attached['sessionId'], 'sessionId', 'Target.attachToTarget')

        await connection.send('Page.enable', {}, sessionId)
        await connection.send('Runtime.enable', {}, sessionId)
        await connection.send('Emulation.setDeviceMetricsOverride', {
          width: request.width,
          height: request.height,
          deviceScaleFactor: request.deviceScaleFactor,
          mobile: request.mobile,
        }, sessionId)
        if (request.darkMode) {
          await connection.send('Emulation.setEmulatedMedia', {
            features: [{ name: 'prefers-color-scheme', value: 'dark' }],
          }, sessionId)
        }

        // Registered before navigating, because a fast page can fire the load
        // event before the navigate reply comes back.
        const loaded = connection.waitFor('Page.loadEventFired', sessionId, options.loadTimeoutMs, controller.signal)
        loaded.catch(() => {
          // Awaited below; this handler only keeps a navigate failure from
          // surfacing as an unhandled rejection instead of its own error.
        })
        const navigated = await connection.send('Page.navigate', { url: request.url }, sessionId)
        const errorText = navigated['errorText']
        if (typeof errorText === 'string' && errorText !== '') {
          throw new Error(`capture_page could not open ${request.url}: ${errorText}`)
        }
        await loaded

        await delay(request.waitMs, controller.signal)
        await evaluate<boolean>(connection, sessionId, forceLazyContentScript(options.scrollStepMs))
        // Typed as PageMeasurement, but it is whatever the page's script
        // returned: a page that throws, navigates mid-evaluate or defines its
        // own globals can hand back anything at all. The check is a runtime
        // one and the cast is what lets it be written.
        const measured: unknown = await evaluate<PageMeasurement>(connection, sessionId, measureScript(request.selector))
        if (typeof measured !== 'object' || measured === null) {
          throw new Error('capture_page: the page returned no measurements.')
        }
        const measurement = measured as PageMeasurement

        const screenshot = await connection.send('Page.captureScreenshot', {
          format: 'png',
          ...clipFor(request, measurement, options.maxFullPageHeightPx, notes),
        }, sessionId)
        const data = str(screenshot['data'], 'data', 'Page.captureScreenshot')
        return { png: Buffer.from(data, 'base64'), measurement, notes }
      } catch (error) {
        if (deadline.passed) {
          throw new Error(`capture_page gave up on ${request.url} after ${String(options.hardTimeoutMs)}ms and killed the browser.`)
        }
        throw error instanceof Error ? error : new Error(String(error))
      } finally {
        clearTimeout(hardTimer)
        signal.removeEventListener('abort', onAbort)
        connection?.close()
        browser?.kill()
        await rm(userDataDir, { recursive: true, force: true }).catch(() => {
          // A leftover profile directory in the system temp dir is harmless and
          // nothing else in this call can act on the failure.
        })
      }
    },
  }
}

/**
 * Choose the screenshot clip: an element's box, the whole document, or the
 * viewport.
 * @param request - the capture being taken.
 * @param measurement - the geometry just read from the page.
 * @param maxFullPageHeightPx - tallest full-page capture allowed.
 * @param notes - collects anything the model should know about the clip.
 * @returns the `Page.captureScreenshot` parameters that select the region.
 */
function clipFor(
  request: CaptureRequest,
  measurement: PageMeasurement,
  maxFullPageHeightPx: number,
  notes: string[],
): Record<string, unknown> {
  const box = measurement.selector?.page
  if (request.selector !== undefined) {
    if (box === undefined || box.width < 1 || box.height < 1) {
      notes.push(measurement.selector?.matched === true
        ? 'The selector matched an element with a zero-sized box, so the image is the viewport instead of that element.'
        : 'The selector matched nothing, so the image is the viewport.')
      return { captureBeyondViewport: false }
    }
    return {
      captureBeyondViewport: true,
      clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale: 1 },
    }
  }
  if (!request.fullPage) return { captureBeyondViewport: false }
  const width = Math.max(measurement.scrollWidth, request.width)
  const height = Math.min(measurement.scrollHeight, maxFullPageHeightPx)
  if (measurement.scrollHeight > maxFullPageHeightPx) {
    notes.push(`The document is ${String(measurement.scrollHeight)}px tall; the capture stops at ${String(maxFullPageHeightPx)}px.`)
  }
  return {
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width, height: Math.max(height, 1), scale: 1 },
  }
}
