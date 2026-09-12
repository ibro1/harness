/**
 * The types the capture tool and its browser implementation share, plus the
 * structural view of the outputs capability the tool publishes through.
 *
 * The tool depends on {@link CaptureDriver} and never on Chromium directly, so
 * the tests exercise argument clamping, screening and publishing without a
 * browser on the machine.
 *
 * @module @deepseek-ai/dsh-host-capture/src/driver
 */

/** A `getBoundingClientRect()` reading, in CSS pixels. */
export interface DomRect {
  x: number
  y: number
  width: number
  height: number
  top: number
  right: number
  bottom: number
  left: number
}

/** What a selector matched, read back from the live DOM. */
export interface SelectorMeasurement {
  /** The selector as given. */
  selector: string
  /** Whether any element matched it. */
  matched: boolean
  /** How many elements matched. */
  count: number
  /** The first match's box, absent when nothing matched. */
  rect?: DomRect
  /** The first match's box in page coordinates, used to clip the screenshot. */
  page?: { x: number; y: number; width: number; height: number }
}

/** Everything read back from the live DOM after the page settled. */
export interface PageMeasurement {
  /** `document.title` after load. */
  title: string
  /** `location.href` after every redirect. */
  finalUrl: string
  /** Emulated viewport width, the number `scrollWidth` is compared against. */
  viewportWidth: number
  /** Emulated viewport height. */
  viewportHeight: number
  /** `document.documentElement.scrollWidth`. */
  scrollWidth: number
  /** `document.documentElement.scrollHeight`. */
  scrollHeight: number
  /** Every element in the document, so "it rendered nothing" is a number. */
  elementCount: number
  /** Elements with a non-zero box, so "it rendered nothing" and "it rendered off-screen" differ. */
  paintedElementCount: number
  /** Every `<img>` in the document. */
  imageCount: number
  /** `currentSrc` of each `<img>` whose `complete` is false or `naturalWidth` is 0. */
  brokenImages: string[]
  /** Present only when the call passed a selector. */
  selector?: SelectorMeasurement
}

/** One capture, already clamped and screened by the tool. */
export interface CaptureRequest {
  /** The screened absolute URL to open. */
  url: string
  /** Addresses the hostname resolved to; the first is pinned in the browser's resolver. */
  addresses: readonly string[]
  /** Whether the URL named a numeric address, so no resolver pinning is needed. */
  literalHost: boolean
  /** Emulated viewport width in CSS pixels. */
  width: number
  /** Emulated viewport height in CSS pixels. */
  height: number
  /** Capture the whole document rather than the viewport. */
  fullPage: boolean
  /** Emulated device pixel ratio. */
  deviceScaleFactor: number
  /** Emulate a mobile device (viewport meta, touch). */
  mobile: boolean
  /** Settle time after load, in milliseconds. */
  waitMs: number
  /** Capture only this element's box, when given. */
  selector?: string
  /** Emulate `prefers-color-scheme: dark`. */
  darkMode: boolean
}

/** A finished capture: the image bytes and the geometry that justifies them. */
export interface CaptureResult {
  /** The PNG. */
  png: Uint8Array
  /** What the live DOM said while that PNG was taken. */
  measurement: PageMeasurement
  /** Notes the driver wants the model to see, such as a clip it had to widen. */
  notes: string[]
}

/** Screenshots one page. The tool holds this, not a browser. */
export interface CaptureDriver {
  /**
   * Capture one page and measure it.
   * @param request - the clamped, screened capture to perform.
   * @param signal - cancellation; the driver must kill its browser when aborted.
   * @returns the PNG and the DOM measurements taken alongside it.
   * @throws when the browser cannot be launched, the page never loads, or the
   * protocol reports an error. The browser is killed on every path.
   */
  capture(request: CaptureRequest, signal: AbortSignal): Promise<CaptureResult>
}

/** One file the outputs capability has published for a session. */
export interface PublishedOutput {
  name: string
  rel: string
  bytes: number
  mtime: number
  label?: string
}

/**
 * The `outputs` capability, declared structurally rather than imported, so this
 * plugin and the one that provides it are not build-coupled. The capability is
 * read with `ctx.get('outputs')` and used only when present.
 */
export interface OutputsCapability {
  dir(cwd: string): string
  publish(cwd: string, absPath: string, label?: string): Promise<PublishedOutput>
  list(cwd: string): Promise<PublishedOutput[]>
}

/**
 * Decide whether a value read off the context is usable as the outputs
 * capability. The value crosses an untyped boundary — another plugin provides
 * it and may not be loaded at all — so its methods are checked before use.
 * @param value - whatever `ctx.get('outputs')` returned.
 * @returns true when `dir` and `publish` are callable.
 */
export function isOutputsCapability(value: unknown): value is OutputsCapability {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<Record<keyof OutputsCapability, unknown>>
  return typeof candidate.dir === 'function' && typeof candidate.publish === 'function'
}
