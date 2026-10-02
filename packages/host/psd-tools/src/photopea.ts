/**
 * Photopea in a headless Chromium, driven by its iframe messaging interface.
 *
 * A local page holds Photopea in an iframe and records what it posts back:
 * strings from `app.echoToOE`, `ArrayBuffer`s from `saveToOE`, and `done`
 * after each script or opened file. Posting an `ArrayBuffer` to the frame opens
 * it (a PSD, an image or a font), and posting a string runs it as a script.
 *
 * One browser serves every call, started on first use and closed after an idle
 * period, because Photopea takes seconds to load. Jobs run one at a time and
 * each begins by closing every open document, so no call sees another's file.
 * A job that times out closes the browser, since Photopea's state is then
 * unknown.
 *
 * @module @deepseek-ai/dsh-host-psd-tools/src/photopea
 */

import { chromium } from 'playwright-core'
import type { Browser, Frame, Page } from 'playwright-core'
import { COUNT_SCRIPT, ECHO_MARK, ERROR_MARK, RESET_SCRIPT, RETRY_MARK } from './scripts.ts'

/** One job: files to open in order, then scripts to run one after another. */
export interface PhotopeaJob {
  /** Opened before the script; PSDs and images become documents in this order, fonts are installed. */
  files: Uint8Array[]
  /** How many of `files` are documents, which the job checks after opening them. */
  documents: number
  /**
   * The wrapped scripts, each posted after the previous one finished. Photopea
   * finishes some work (text layout, layer bounds after a change, resizing a
   * copied layer) only between scripts, so a step that reads the result of an
   * earlier change goes in a later script.
   */
  scripts: string[]
}

/** What a job's scripts answered. */
export interface PhotopeaResult {
  /** Strings from `app.echoToOE`, in order. */
  echoes: string[]
  /** Files from `saveToOE`, in order. */
  files: Uint8Array[]
}

/** Runs jobs in Photopea. */
export interface PhotopeaEngine {
  /**
   * Run one job after every earlier one has finished.
   * @param job - files to open and the script to run.
   * @param signal - abandons the job; the browser is then closed.
   * @returns the script's echoes and files.
   * @throws when Photopea does not load, a file does not open, the script reports an error, or a step times out.
   */
  run(job: PhotopeaJob, signal: AbortSignal): Promise<PhotopeaResult>
  /** Close the browser if it is open. */
  close(): Promise<void>
}

/** Settings for {@link createPhotopeaEngine}. */
export interface PhotopeaEngineOptions {
  /** Resolves the Chromium executable when the browser first starts. */
  resolveBrowser: () => string
  /** Photopea's address. */
  photopeaUrl: string
  /** Longest wait for Photopea to load, in milliseconds. */
  loadTimeoutMs: number
  /** Longest wait for one opened file or script, in milliseconds. */
  stepTimeoutMs: number
  /** Close the browser after this long without a job, in milliseconds. */
  idleCloseMs: number
}

/** Pause before posting a script again that asked to wait, in milliseconds. */
const RETRY_PAUSE_MS = 250

/** The page that hosts the iframe and records its messages, base64-encoding files. */
const HOST_PAGE = (src: string): string => `<!doctype html><meta charset="utf-8"><body style="margin:0">
<script>
window.__pp = { msgs: [], dones: 0 };
function __b64(buf) { var u = new Uint8Array(buf), s = ''; for (var i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s) }
window.addEventListener('message', function (e) {
  var f = document.getElementById('pp'); if (!f || e.source !== f.contentWindow) return;
  if (e.data === 'done') { window.__pp.dones++; return }
  window.__pp.msgs.push(e.data instanceof ArrayBuffer ? { bin: __b64(e.data) } : String(e.data));
});
</script>
<iframe id="pp" style="width:1280px;height:860px;border:0" src="${src}"></iframe>`

/** A live browser with Photopea loaded. */
interface Live {
  browser: Browser
  page: Page
}

/** One recorded message. */
type Message = string | { bin: string }

declare global {
  interface Window {
    /** What {@link HOST_PAGE} records from Photopea: messages since the last post, and how many `done`s so far. */
    __pp: { msgs: Message[]; dones: number }
  }
}

/**
 * Create the engine. Nothing starts until the first job.
 * @param options - browser, address and timeouts.
 * @returns the engine.
 */
export function createPhotopeaEngine(options: PhotopeaEngineOptions): PhotopeaEngine {
  let live: Promise<Live> | undefined
  let queue: Promise<unknown> = Promise.resolve()
  let idle: NodeJS.Timeout | undefined

  const shutdown = async (): Promise<void> => {
    const current = live
    live = undefined
    if (current === undefined) return
    try {
      const { browser } = await current
      await browser.close()
    } catch (error) {
      // A browser that failed to start or already died has nothing to close.
      void error
    }
  }

  const start = async (): Promise<Live> => {
    const browser = await chromium.launch({
      executablePath: options.resolveBrowser(),
      // Photopea draws with WebGL; a headless server has no GPU, so SwiftShader stands in.
      args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    })
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
      // An empty JSON configuration after the hash opens the editor rather than the landing page.
      await page.setContent(HOST_PAGE(`${options.photopeaUrl}#%7B%7D`))
      const frame = await photopeaFrame(page, options.loadTimeoutMs)
      await frame.waitForLoadState('domcontentloaded', { timeout: options.loadTimeoutMs })
      // Embedded with a configuration, Photopea announces itself to the parent only once `addPP` runs.
      await frame.evaluate(() => {
        const start = (globalThis as { addPP?: () => void }).addPP
        if (typeof start === 'function') start()
      })
      await page.waitForFunction(() => window.__pp.dones > 0, null, { timeout: options.loadTimeoutMs })
      return { browser, page }
    } catch (error) {
      await browser.close().catch(() => {
        // Already gone; the load error below is the one to report.
      })
      throw new Error(`Photopea did not load: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
  }

  const post = async (page: Page, payload: string | Uint8Array, signal: AbortSignal): Promise<Message[]> => {
    signal.throwIfAborted()
    const before = await page.evaluate(() => {
      const pp = window.__pp
      pp.msgs = []
      return pp.dones
    })
    await page.evaluate(([data, isFile]) => {
      const frame = document.getElementById('pp') as HTMLIFrameElement
      if (isFile) {
        const raw = atob(data)
        const bytes = new Uint8Array(raw.length)
        for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
        frame.contentWindow?.postMessage(bytes.buffer, '*', [bytes.buffer])
      } else {
        frame.contentWindow?.postMessage(data, '*')
      }
    }, [typeof payload === 'string' ? payload : Buffer.from(payload).toString('base64'), typeof payload !== 'string'] as const)
    const wait = page.waitForFunction(n => window.__pp.dones > n, before, { timeout: options.stepTimeoutMs })
    // An error Photopea throws outside the script (reading a property it does
    // not expose) ends the script without `done`; it is reported at once
    // instead of after the step timeout. Photopea stays usable afterwards.
    let onError: ((error: Error) => void) | undefined
    const crashed = new Promise<never>((_, reject) => {
      onError = (error: Error) => { reject(new ScriptError(`Photopea stopped with an internal error (${error.message || 'no message'}); the script used something Photopea does not support`)) }
      page.on('pageerror', onError)
    })
    try {
      await abortable(Promise.race([wait, crashed]), signal)
    } catch (error) {
      if (signal.aborted || error instanceof ScriptError) throw error
      const said = await page.evaluate(() => window.__pp.msgs.filter(m => typeof m === 'string')).catch(() => [])
      const tail = said.slice(-3).map(m => m.replace(ECHO_MARK, '')).join(' | ')
      throw new Error(`Photopea did not finish within ${String(options.stepTimeoutMs)} ms${tail === '' ? '' : `; its last messages: ${tail}`}`, { cause: error })
    } finally {
      if (onError !== undefined) page.off('pageerror', onError)
      crashed.catch(() => {
        // Only a step still waiting reads this rejection.
      })
    }
    return page.evaluate(() => window.__pp.msgs)
  }

  // A script that echoes RETRY_MARK is waiting for Photopea to finish earlier
  // work (a picture still loading); it is posted again after a pause.
  const postUntilSettled = async (page: Page, script: string, signal: AbortSignal): Promise<Message[]> => {
    const deadline = Date.now() + options.stepTimeoutMs
    for (;;) {
      const messages = failOn(await post(page, script, signal))
      if (!messages.includes(RETRY_MARK)) return messages
      if (Date.now() > deadline) throw new ScriptError(`Photopea was still busy after ${String(options.stepTimeoutMs)} ms (a picture may be too large or damaged)`)
      await new Promise(resolve => setTimeout(resolve, RETRY_PAUSE_MS))
    }
  }

  const runNow = async (job: PhotopeaJob, signal: AbortSignal): Promise<PhotopeaResult> => {
    live ??= start()
    let page: Page
    try {
      page = (await live).page
    } catch (error) {
      live = undefined
      throw error
    }
    try {
      failOn(await post(page, RESET_SCRIPT, signal))
      for (const file of job.files) failOn(await post(page, file, signal))
      const counted = echoes(failOn(await post(page, COUNT_SCRIPT, signal)))
      if (counted[0] !== String(job.documents)) {
        throw new Error(`Photopea opened ${counted[0] ?? '?'} of the ${String(job.documents)} files given; a file may be damaged or in a format it does not read`)
      }
      const messages: Message[] = []
      for (const [i, script] of job.scripts.entries()) {
        try {
          messages.push(...await postUntilSettled(page, script, signal))
        } catch (error) {
          if (job.scripts.length === 1 || !(error instanceof Error)) throw error
          throw new (error instanceof ScriptError ? ScriptError : Error)(`step ${String(i + 1)} of ${String(job.scripts.length)}: ${error.message}`, { cause: error })
        }
      }
      return {
        echoes: messages.filter((m): m is string => typeof m === 'string'),
        files: messages.filter((m): m is { bin: string } => typeof m !== 'string').map(m => new Uint8Array(Buffer.from(m.bin, 'base64'))),
      }
    } catch (error) {
      // A script error leaves Photopea usable; a timeout or abort may not.
      if (!(error instanceof ScriptError)) await shutdown()
      throw error
    }
  }

  return {
    run(job, signal) {
      if (idle !== undefined) clearTimeout(idle)
      const result = queue.then(() => runNow(job, signal))
      queue = result.catch(() => undefined).then(() => {
        if (idle !== undefined) clearTimeout(idle)
        idle = setTimeout(() => { void shutdown() }, options.idleCloseMs)
        idle.unref()
      })
      return result
    },
    async close() {
      if (idle !== undefined) clearTimeout(idle)
      await shutdown()
    },
  }
}

/** An error the script itself reported. */
export class ScriptError extends Error {}

/** Throw the script's reported error, if any; otherwise return the messages. */
function failOn(messages: Message[]): Message[] {
  for (const m of messages) {
    if (typeof m === 'string' && m.startsWith(ERROR_MARK)) throw new ScriptError(`Photopea: ${m.slice(ERROR_MARK.length)}`)
  }
  return messages
}

/** The raw script echoes, without the mark. */
function echoes(messages: Message[]): string[] {
  return messages.filter((m): m is string => typeof m === 'string' && m.startsWith(ECHO_MARK)).map(m => m.slice(ECHO_MARK.length))
}

/** Wait for Photopea's frame to appear in the host page. */
async function photopeaFrame(page: Page, timeoutMs: number): Promise<Frame> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const frame = page.frames().find(f => f !== page.mainFrame() && f.url().startsWith('http'))
    if (frame !== undefined) return frame
    if (Date.now() > deadline) throw new Error('the Photopea frame never appeared')
    await new Promise(resolve => setTimeout(resolve, 200))
  }
}

/** Reject when the signal aborts, whatever the promise is doing. */
async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => { reject(signal.reason instanceof Error ? signal.reason : new Error('the PSD job was abandoned')) }
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([promise, aborted])
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
    promise.catch(() => {
      // The race already settled; a later rejection has no reader.
    })
  }
}
