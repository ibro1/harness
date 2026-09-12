/**
 * Page capture that comes with evidence: `capture_page` screenshots a URL
 * through the DevTools Protocol and returns the geometry it read back from the
 * live DOM alongside the image.
 *
 * It exists because `chromium --headless --screenshot` silently drops content.
 * In one session that PNG produced two confident, wrong bug reports — "this
 * element is missing", "this button does not render" — about elements that were
 * demonstrably present, laid out and painted when the same page was inspected
 * through CDP. A PNG is not evidence on its own: nothing in it distinguishes an
 * element that failed to render from one the screenshotter failed to capture.
 * So every capture also returns numbers a claim can be checked against —
 * `scrollWidth` against the viewport width, the count of elements in the
 * document, the `currentSrc` of every image that did not load, and the box of a
 * named selector — and it forces lazy content to load before it shoots, because
 * a full-page capture that skips every below-the-fold image is that same
 * failure wearing a different hat.
 *
 * The URL comes from a model, so it is screened before a browser starts: the
 * hostname is resolved and every address refused unless it is publicly
 * routable. The harness runs its own web server and several bridges on
 * loopback, and a screenshot tool that can reach them is a credential-reading
 * tool.
 *
 * @module @deepseek-ai/dsh-host-capture
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolRunContext, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import { createChromiumDriver } from './chromium.ts'
import { isOutputsCapability } from './driver.ts'
import type { CaptureDriver, CaptureRequest, CaptureResult, DomRect, OutputsCapability } from './driver.ts'
import { screenUrl, systemLookup } from './ssrf.ts'
import type { HostLookup } from './ssrf.ts'

/** The plugin name, for the Loader. */
export const name = 'capture'

/** The services this plugin reads. `outputs` is optional and read per call. */
export const inject = ['agents']

/** Model-facing default viewport width, in CSS pixels. */
const DEFAULT_WIDTH = 1280

/** Model-facing default viewport height, in CSS pixels. */
const DEFAULT_HEIGHT = 900

/** Model-facing default settle time after load, in milliseconds. */
const DEFAULT_WAIT_MS = 3000

/** Smallest viewport a capture may ask for; below this nothing lays out sensibly. */
const MIN_VIEWPORT_PX = 200

/** Composition config: the resource ceilings and timeouts a deployment varies. */
export interface Config {
  /** Widest viewport a call may ask for, in CSS pixels. */
  maxWidth: number
  /** Tallest viewport a call may ask for, in CSS pixels. */
  maxHeight: number
  /** Largest device pixel ratio a call may ask for. */
  maxDeviceScaleFactor: number
  /** Longest settle time a call may ask for, in milliseconds. */
  maxWaitMs: number
  /** Tallest full-page capture, in CSS pixels; taller documents are cut here. */
  maxFullPageHeightPx: number
  /** Largest bitmap one call may allocate, in device pixels. */
  maxPixels: number
  /** Milliseconds to wait for the browser's DevTools endpoint after spawning. */
  launchTimeoutMs: number
  /** Milliseconds to wait for the page's load event after navigating. */
  loadTimeoutMs: number
  /** Milliseconds after which the browser is killed whatever it is doing. */
  hardTimeoutMs: number
  /** Pause after each scroll step while forcing lazy content to load. */
  scrollStepMs: number
  /** Explicit browser path; empty searches PATH for chromium, then chrome. */
  browserPath: string
  /**
   * Directory under the session cwd that receives the PNG when no `outputs`
   * capability is mounted. `edit` is what the composer's session-outputs drawer
   * lists, so a capture stays visible to the person who asked for it.
   */
  fallbackDir: string
}

/** Composition config: the resource ceilings and timeouts a deployment varies. */
export const Config: z<Config> = z.object({
  maxWidth: z.natural().min(MIN_VIEWPORT_PX).default(3840),
  maxHeight: z.natural().min(MIN_VIEWPORT_PX).default(4320),
  maxDeviceScaleFactor: z.number().min(1).max(4).default(3),
  maxWaitMs: z.natural().default(15_000),
  maxFullPageHeightPx: z.natural().min(1000).default(20_000),
  maxPixels: z.natural().min(1_000_000).default(40_000_000),
  launchTimeoutMs: z.natural().min(1000).default(20_000),
  loadTimeoutMs: z.natural().min(1000).default(30_000),
  hardTimeoutMs: z.natural().min(5000).default(90_000),
  scrollStepMs: z.natural().default(120),
  browserPath: z.string().default(''),
  // Matches what `dsh-host-outputs` publishes into, so a capture lands in the
  // same place whether or not that capability is mounted. The composer drawer
  // lists this and the older `edit/` both, while existing skills move over.
  fallbackDir: z.string().default('.outputs'),
})

/** The tool's canonical output: the numbers first, the image second. */
const RECT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    x: { type: 'number', required: true },
    y: { type: 'number', required: true },
    width: { type: 'number', required: true },
    height: { type: 'number', required: true },
    top: { type: 'number', required: true },
    right: { type: 'number', required: true },
    bottom: { type: 'number', required: true },
    left: { type: 'number', required: true },
  },
} as const satisfies ValueSchemaSpec

/** The canonical value every `capture_page` call returns. */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string', required: true, description: 'The capture summarized for reading.' },
    requestedUrl: { type: 'string', required: true, description: 'The URL as asked for.' },
    finalUrl: { type: 'string', required: true, description: 'location.href after every redirect.' },
    title: { type: 'string', required: true, description: 'document.title after load.' },
    image: {
      type: 'object',
      required: true,
      additionalProperties: false,
      description: 'Where the PNG went.',
      properties: {
        name: { type: 'string', required: true, description: 'The file name.' },
        bytes: { type: 'integer', required: true, description: 'Size of the PNG.' },
        published: { type: 'boolean', required: true, description: 'True when it reached the session outputs drawer.' },
        rel: { type: 'string', description: 'Path the outputs drawer lists it under.' },
        path: { type: 'string', description: 'Absolute path on disk, when it was written directly.' },
        dir: { type: 'string', description: 'Directory it landed in.' },
      },
    },
    viewport: {
      type: 'object',
      required: true,
      additionalProperties: false,
      description: 'The emulated viewport actually used, after clamping.',
      properties: {
        width: { type: 'integer', required: true },
        height: { type: 'integer', required: true },
        deviceScaleFactor: { type: 'number', required: true },
        mobile: { type: 'boolean', required: true },
        fullPage: { type: 'boolean', required: true },
        darkMode: { type: 'boolean', required: true },
        waitMs: { type: 'integer', required: true },
      },
    },
    scrollWidth: { type: 'integer', required: true, description: 'document.documentElement.scrollWidth.' },
    scrollHeight: { type: 'integer', required: true, description: 'document.documentElement.scrollHeight.' },
    horizontalOverflowPx: {
      type: 'integer',
      required: true,
      description: 'scrollWidth minus the viewport width, floored at 0. Greater than 0 means the page scrolls sideways.',
    },
    elementCount: { type: 'integer', required: true, description: 'Elements in the document.' },
    paintedElementCount: { type: 'integer', required: true, description: 'Elements with a non-zero box.' },
    imageCount: { type: 'integer', required: true, description: 'Total <img> elements.' },
    brokenImages: {
      type: 'array',
      required: true,
      items: { type: 'string' },
      description: 'currentSrc of every <img> whose complete is false or naturalWidth is 0.',
    },
    clamped: {
      type: 'array',
      required: true,
      items: { type: 'string' },
      description: 'Parameters the plugin reduced to its configured ceilings.',
    },
    notes: { type: 'array', required: true, items: { type: 'string' }, description: 'Anything else the capture had to do.' },
    selector: {
      type: 'object',
      additionalProperties: false,
      description: 'Present only when the call named a selector.',
      properties: {
        selector: { type: 'string', required: true },
        matched: { type: 'boolean', required: true },
        count: { type: 'integer', required: true },
        rect: RECT_SCHEMA,
      },
    },
  },
} as const satisfies ValueSchemaSpec

/** What the tool needs from outside itself; every field has a real default. */
export interface CaptureDeps {
  /** The browser. Tests pass a stand-in so no Chromium is launched. */
  driver?: CaptureDriver
  /** The resolver the SSRF screen uses. */
  hostLookup?: HostLookup
  /** Reads the optional `outputs` capability at call time. */
  readOutputs?: () => OutputsCapability | undefined
}

/** Clamp one number into range, recording the parameter name when it moved. */
function clamp(value: number, min: number, max: number, label: string, clamped: string[]): number {
  if (!Number.isFinite(value)) {
    clamped.push(`${label} was not a number; used ${String(min)}`)
    return min
  }
  if (value < min) {
    clamped.push(`${label} ${String(value)} raised to ${String(min)}`)
    return min
  }
  if (value > max) {
    clamped.push(`${label} ${String(value)} capped at ${String(max)}`)
    return max
  }
  return value
}

/** The model arguments of one call, before clamping. */
interface CaptureArgs {
  url: string
  width?: number
  height?: number
  fullPage?: boolean
  deviceScaleFactor?: number
  mobile?: boolean
  waitMs?: number
  selector?: string
  darkMode?: boolean
}

/** A clamped request, with the ceilings it ran into. */
interface ClampedRequest {
  request: Omit<CaptureRequest, 'url' | 'addresses' | 'literalHost'>
  clamped: string[]
}

/**
 * Bring one call's arguments inside the configured ceilings, so no single call
 * can allocate an enormous bitmap or hold the box for minutes.
 * @param args - the model's arguments.
 * @param config - the ceilings.
 * @returns the clamped request and a note for every value that moved.
 */
export function clampRequest(args: CaptureArgs, config: Config): ClampedRequest {
  const clamped: string[] = []
  const width = Math.round(clamp(args.width ?? DEFAULT_WIDTH, MIN_VIEWPORT_PX, config.maxWidth, 'width', clamped))
  let height = Math.round(clamp(args.height ?? DEFAULT_HEIGHT, MIN_VIEWPORT_PX, config.maxHeight, 'height', clamped))
  const deviceScaleFactor = clamp(args.deviceScaleFactor ?? 1, 1, config.maxDeviceScaleFactor, 'deviceScaleFactor', clamped)
  const waitMs = Math.round(clamp(args.waitMs ?? DEFAULT_WAIT_MS, 0, config.maxWaitMs, 'waitMs', clamped))
  // Width and scale are what the caller asked to see; height is the dimension
  // that can be traded away to keep the bitmap inside the pixel budget.
  const pixels = width * height * deviceScaleFactor * deviceScaleFactor
  if (pixels > config.maxPixels) {
    const fitted = Math.max(MIN_VIEWPORT_PX, Math.floor(config.maxPixels / (width * deviceScaleFactor * deviceScaleFactor)))
    clamped.push(`height ${String(height)} reduced to ${String(fitted)} to stay inside the ${String(config.maxPixels)}-pixel budget`)
    height = fitted
  }
  return {
    request: {
      width,
      height,
      deviceScaleFactor,
      waitMs,
      fullPage: args.fullPage === true,
      mobile: args.mobile === true,
      darkMode: args.darkMode === true,
      ...args.selector === undefined || args.selector === '' ? {} : { selector: args.selector },
    },
    clamped,
  }
}

/** Where the PNG ended up. */
interface ImageRecord {
  name: string
  bytes: number
  published: boolean
  rel?: string
  path?: string
  dir?: string
}

/** A file name that carries the host and the moment, and survives any filesystem. */
function captureFileName(url: URL): string {
  const host = url.hostname.replace(/[^a-zA-Z0-9.-]/gu, '-')
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
  return `capture-${host}-${stamp}.png`
}

/**
 * Put the PNG where the person who asked can open it: through the `outputs`
 * capability when one is mounted, otherwise in the session's own output
 * directory, saying which happened.
 * @param png - the image bytes.
 * @param fileName - the name to give it.
 * @param cwd - the session working directory.
 * @param outputs - the capability, when mounted.
 * @param fallbackDir - directory under `cwd` used when it is not.
 * @param notes - collects a fallback explanation for the model.
 * @returns where the file landed.
 * @throws when the file cannot be written at all.
 */
async function deliverImage(
  png: Uint8Array,
  fileName: string,
  cwd: string,
  outputs: OutputsCapability | undefined,
  fallbackDir: string,
  notes: string[],
): Promise<ImageRecord> {
  if (outputs !== undefined) {
    const staging = await mkdtemp(join(tmpdir(), 'dsh-capture-out-'))
    const staged = join(staging, fileName)
    try {
      await writeFile(staged, png)
      const published = await outputs.publish(cwd, staged, 'page capture')
      return {
        name: published.name,
        bytes: published.bytes,
        published: true,
        rel: published.rel,
        dir: outputs.dir(cwd),
      }
    } catch (error) {
      notes.push(`Publishing through the outputs capability failed (${error instanceof Error ? error.message : String(error)}); the image was written to disk instead.`)
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => {
        // A staging directory left in the system temp dir is harmless, and
        // nothing in this call can act on the failure.
      })
    }
  }
  const dir = join(cwd, fallbackDir)
  await mkdir(dir, { recursive: true })
  const path = join(dir, fileName)
  await writeFile(path, png)
  return { name: fileName, bytes: png.byteLength, published: false, path, dir }
}

/** The canonical value of one finished capture. */
interface CaptureValue {
  text: string
  requestedUrl: string
  finalUrl: string
  title: string
  image: ImageRecord
  viewport: {
    width: number
    height: number
    deviceScaleFactor: number
    mobile: boolean
    fullPage: boolean
    darkMode: boolean
    waitMs: number
  }
  scrollWidth: number
  scrollHeight: number
  horizontalOverflowPx: number
  elementCount: number
  paintedElementCount: number
  imageCount: number
  brokenImages: string[]
  clamped: string[]
  notes: string[]
  selector?: {
    selector: string
    matched: boolean
    count: number
    rect?: DomRect
  }
}

/** Render the measurements as the text a reader (or a bug report) can quote. */
function summarize(value: Omit<CaptureValue, 'text'>): string {
  const lines: string[] = []
  lines.push(value.finalUrl === value.requestedUrl
    ? `Captured ${value.requestedUrl}`
    : `Captured ${value.requestedUrl} (ended at ${value.finalUrl})`)
  lines.push(`Title: ${value.title === '' ? '(none)' : value.title}`)
  const where = value.image.published
    ? `published to the session outputs as ${value.image.rel ?? value.image.name}`
    : `written to ${value.image.path ?? value.image.name}`
  lines.push(`Image: ${value.image.name}, ${String(value.image.bytes)} bytes, ${where}`)
  lines.push(`Viewport ${String(value.viewport.width)}x${String(value.viewport.height)} at ${String(value.viewport.deviceScaleFactor)}x`
    + `${value.viewport.mobile ? ', mobile' : ''}${value.viewport.darkMode ? ', dark mode' : ''}`
    + `; document ${String(value.scrollWidth)}x${String(value.scrollHeight)}`)
  lines.push(value.horizontalOverflowPx > 0
    ? `Horizontal overflow: ${String(value.horizontalOverflowPx)}px (scrollWidth ${String(value.scrollWidth)} vs viewport ${String(value.viewport.width)}) — the page scrolls sideways`
    : `Horizontal overflow: none (scrollWidth ${String(value.scrollWidth)} fits viewport ${String(value.viewport.width)})`)
  lines.push(`Elements: ${String(value.elementCount)} in the document, ${String(value.paintedElementCount)} with a non-zero box`)
  lines.push(`Images: ${String(value.imageCount)}, ${String(value.brokenImages.length)} broken`)
  for (const broken of value.brokenImages) lines.push(`  broken image: ${broken}`)
  if (value.selector !== undefined) {
    const rect = value.selector.rect
    lines.push(value.selector.matched && rect !== undefined
      ? `Selector ${JSON.stringify(value.selector.selector)}: ${String(value.selector.count)} match(es); first box ${String(Math.round(rect.width))}x${String(Math.round(rect.height))} at (${String(Math.round(rect.left))}, ${String(Math.round(rect.top))})`
      : `Selector ${JSON.stringify(value.selector.selector)}: no match`)
  }
  for (const note of value.clamped) lines.push(`Clamped: ${note}`)
  for (const note of value.notes) lines.push(`Note: ${note}`)
  return lines.join('\n')
}

/**
 * Build the capture tool without registering it, so the same definition serves
 * the per-agent registry and a test.
 * @param config - validated composition config.
 * @param deps - the browser, the resolver and the outputs reader; all default.
 * @returns the tool definitions this plugin contributes.
 */
export function buildCaptureTools(config: Config, deps: CaptureDeps = {}): ToolDefinition[] {
  const driver = deps.driver ?? createChromiumDriver({
    browserPath: config.browserPath,
    launchTimeoutMs: config.launchTimeoutMs,
    loadTimeoutMs: config.loadTimeoutMs,
    hardTimeoutMs: config.hardTimeoutMs,
    maxFullPageHeightPx: config.maxFullPageHeightPx,
    scrollStepMs: config.scrollStepMs,
  })
  const hostLookup = deps.hostLookup ?? systemLookup
  const readOutputs = deps.readOutputs ?? ((): undefined => undefined)

  return [
    defineTool({
      name: 'capture_page',
      description: 'Screenshot a web page AND measure it: the PNG plus the geometry read back from the live DOM — '
        + 'scrollWidth against the viewport width (horizontal overflow as a number), the page title and final URL, '
        + 'every image that failed to load, the box of an optional CSS selector, and how many elements the document holds. '
        + 'Use it instead of a plain headless screenshot whenever a claim about a page has to be checked rather than eyeballed.',
      parameters: {
        url: {
          type: 'string',
          required: true,
          description: 'Absolute http:// or https:// URL to capture. Private, loopback and link-local addresses are refused.',
        },
        width: { type: 'integer', description: `Viewport width in CSS pixels. Default ${String(DEFAULT_WIDTH)}.` },
        height: { type: 'integer', description: `Viewport height in CSS pixels. Default ${String(DEFAULT_HEIGHT)}.` },
        fullPage: { type: 'boolean', description: 'Capture the whole document instead of only the viewport. Default false.' },
        deviceScaleFactor: { type: 'number', description: 'Device pixel ratio; 2 gives a retina-density image. Default 1.' },
        mobile: { type: 'boolean', description: 'Emulate a mobile device (viewport meta, touch). Default false.' },
        waitMs: { type: 'integer', description: `Settle time after load, in milliseconds. Default ${String(DEFAULT_WAIT_MS)}.` },
        selector: { type: 'string', description: 'CSS selector; capture just that element box and report whether it matched.' },
        darkMode: { type: 'boolean', description: 'Emulate prefers-color-scheme: dark. Default false.' },
      },
      timeoutMs: config.hardTimeoutMs + 5000,
      output: { schema: OUTPUT_SCHEMA, render: (_args, value) => [{ type: 'text', text: value.text }] },
      execute: async (args, exec: ToolRunContext): Promise<CaptureValue> => {
        exec.signal.throwIfAborted()
        const screened = await screenUrl(args.url, hostLookup)
        const { request, clamped } = clampRequest(args, config)
        const result: CaptureResult = await driver.capture({
          ...request,
          url: screened.url.href,
          addresses: screened.addresses,
          literalHost: screened.literal,
        }, exec.signal)

        const notes = [...result.notes]
        const cwd = exec.agent?.session.header.cwd ?? process.cwd()
        const image = await deliverImage(
          result.png,
          captureFileName(screened.url),
          cwd,
          readOutputs(),
          config.fallbackDir,
          notes,
        )

        const measurement = result.measurement
        const body: Omit<CaptureValue, 'text'> = {
          requestedUrl: args.url,
          finalUrl: measurement.finalUrl,
          title: measurement.title,
          image,
          viewport: {
            width: request.width,
            height: request.height,
            deviceScaleFactor: request.deviceScaleFactor,
            mobile: request.mobile,
            fullPage: request.fullPage,
            darkMode: request.darkMode,
            waitMs: request.waitMs,
          },
          scrollWidth: measurement.scrollWidth,
          scrollHeight: measurement.scrollHeight,
          horizontalOverflowPx: Math.max(0, measurement.scrollWidth - measurement.viewportWidth),
          elementCount: measurement.elementCount,
          paintedElementCount: measurement.paintedElementCount,
          imageCount: measurement.imageCount,
          brokenImages: measurement.brokenImages,
          clamped,
          notes,
          ...measurement.selector === undefined ? {} : {
            selector: {
              selector: measurement.selector.selector,
              matched: measurement.selector.matched,
              count: measurement.selector.count,
              ...measurement.selector.rect === undefined ? {} : { rect: measurement.selector.rect },
            },
          },
        }
        return { ...body, text: summarize(body) }
      },
      presentCall: args => ({ card: 'generic', title: `Capture ${args.url}`, kind: 'other', rawInput: args.url }),
    }),
  ]
}

/**
 * Register the capture tool on one agent's context.
 * @param ctx - the agent's context, carrying its tool registry.
 * @param tools - the definitions to register.
 */
function registerCaptureTools(ctx: Context, tools: ToolDefinition[]): void {
  for (const tool of tools) {
    ctx.effect(() => ctx.tools.register(tool), `capture: ${tool.name}`)
  }
}

/**
 * Mount `capture_page` on every agent.
 * @param ctx - the plugin context, injecting `agents`.
 * @param config - validated composition config.
 */
export function apply(ctx: Context, config: Config): void {
  // `outputs` is read per call rather than injected: another plugin provides it
  // and this one stays useful without it, writing beside the session cwd
  // instead. Reading it at call time also picks up a later mount.
  const readOutputs = (): OutputsCapability | undefined => {
    const service: unknown = ctx.get('outputs')
    return isOutputsCapability(service) ? service : undefined
  }
  const tools = buildCaptureTools(config, { readOutputs })

  const installed = new Map<Agent, { dispose: () => Promise<void> }>()
  const install = (agent: Agent): void => {
    if (installed.has(agent)) return
    installed.set(agent, agent.ctx.inject(['tools'], (scope) => {
      registerCaptureTools(scope, tools)
    }))
  }
  const remove = (agent: Agent): void => {
    const fiber = installed.get(agent)
    if (fiber === undefined) return
    installed.delete(agent)
    void fiber.dispose().catch(() => {
      // The agent is gone; its registry went with it.
    })
  }
  for (const agent of ctx.agents.list()) install(agent)
  ctx.on('agent/created', ({ agent }) => { install(agent) })
  ctx.on('agent/disposed', ({ agent }) => { remove(agent) })
}
