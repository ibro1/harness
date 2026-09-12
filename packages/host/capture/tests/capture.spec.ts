/**
 * The capture tool, driven against a stand-in browser: tool registration on an
 * agent, the address screening that runs before anything launches, argument
 * clamping, the measurements the tool passes through, where the PNG goes when
 * no outputs capability is mounted, and the browser being killed when a page
 * never loads.
 *
 * No test launches Chromium. The driver seam stands in for the browser in the
 * tool tests, and the launcher/connection seams stand in for the process and
 * the socket in the driver tests.
 */

import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply, buildCaptureTools, clampRequest } from '../src/index.ts'
import type { CaptureDeps, Config } from '../src/index.ts'
import { createChromiumDriver, resolveBrowserPath } from '../src/chromium.ts'
import type { CdpConnection, ChromiumDriverOptions, LaunchedBrowser } from '../src/chromium.ts'
import type { CaptureDriver, CaptureRequest, CaptureResult, PageMeasurement, PublishedOutput } from '../src/driver.ts'
import { screenUrl } from '../src/ssrf.ts'
import type { ResolvedAddress } from '../src/ssrf.ts'

/** A registered tool, as the stub registry records it. */
interface RecordedTool {
  name: string
  parameters: Record<string, unknown>
  execute: (args: Record<string, unknown>, exec: { signal: AbortSignal; agent?: unknown }) => Promise<Record<string, unknown>>
}

const temporaryDirs: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/** A working directory that stands in for a session cwd. */
async function sessionDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'capture-spec-'))
  temporaryDirs.push(dir)
  return dir
}

/** The shipped defaults, spelled out so a test can move one of them. */
function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    maxWidth: 3840,
    maxHeight: 4320,
    maxDeviceScaleFactor: 3,
    maxWaitMs: 15_000,
    maxFullPageHeightPx: 20_000,
    maxPixels: 40_000_000,
    launchTimeoutMs: 20_000,
    loadTimeoutMs: 30_000,
    hardTimeoutMs: 90_000,
    scrollStepMs: 120,
    browserPath: '',
    fallbackDir: 'edit',
    ...overrides,
  }
}

/** Measurements a page might report; overridden per test. */
function measurement(overrides: Partial<PageMeasurement> = {}): PageMeasurement {
  return {
    title: 'Example',
    finalUrl: 'https://example.test/',
    viewportWidth: 1280,
    viewportHeight: 900,
    scrollWidth: 1280,
    scrollHeight: 2400,
    elementCount: 412,
    paintedElementCount: 388,
    imageCount: 3,
    brokenImages: [],
    ...overrides,
  }
}

/** A browser stand-in that records what it was asked for. */
function stubDriver(result?: Partial<CaptureResult>): CaptureDriver & { seen: CaptureRequest[] } {
  const seen: CaptureRequest[] = []
  return {
    seen,
    capture(request: CaptureRequest): Promise<CaptureResult> {
      seen.push(request)
      return Promise.resolve({
        png: Buffer.from('89504e470d0a1a0a', 'hex'),
        measurement: measurement(),
        notes: [],
        ...result,
      })
    },
  }
}

/** A resolver that answers every name with one address. */
function stubLookup(address: string, family = 4): (hostname: string) => Promise<ResolvedAddress[]> {
  return () => Promise.resolve([{ address, family }])
}

/** Build the tool against stand-ins and return `capture_page`. */
function captureTool(deps: CaptureDeps, config = testConfig()): RecordedTool {
  const tool = buildCaptureTools(config, { hostLookup: stubLookup('93.184.216.34'), ...deps })[0]
  return tool as unknown as RecordedTool
}

/** An execution context naming a session working directory. */
function execIn(cwd: string): { signal: AbortSignal; agent: unknown } {
  return { signal: new AbortController().signal, agent: { session: { header: { cwd } } } }
}

describe('capture plugin registration', () => {
  it('registers capture_page on every agent', () => {
    const tools = new Map<string, RecordedTool>()
    const agentCtx = {
      inject(_names: string[], fn: (scope: unknown) => void) {
        fn({
          effect(effectFn: () => unknown) { return effectFn() },
          tools: { register(tool: RecordedTool) { tools.set(tool.name, tool); return () => {} } },
        })
        return { dispose: () => Promise.resolve() }
      },
    }
    const ctx = {
      agents: { list: () => [{ ctx: agentCtx }] },
      get: () => undefined,
      on() {},
      effect(fn: () => unknown) { fn() },
    }
    apply(ctx as unknown as Context, testConfig())
    expect([...tools.keys()]).toEqual(['capture_page'])
    expect(tools.get('capture_page')?.parameters).toHaveProperty('properties.url')
    expect(tools.get('capture_page')?.parameters).toHaveProperty('properties.selector')
  })
})

describe('capture_page address screening', () => {
  const cases: [string, string][] = [
    ['http://127.0.0.1:8080/', 'loopback'],
    ['http://10.1.2.3/', 'private range 10.0.0.0/8'],
    ['http://192.168.1.1/', 'private range 192.168.0.0/16'],
    ['http://172.20.0.5/', 'private range 172.16.0.0/12'],
    ['http://169.254.169.254/latest/meta-data/', 'link-local'],
    ['http://100.100.0.1/', 'carrier-grade NAT'],
    ['http://[::1]/', 'loopback address ::1'],
    ['http://[::ffff:127.0.0.1]/', 'IPv4-mapped'],
    ['http://[fd00::1]/', 'unique-local'],
  ]
  for (const [url, reason] of cases) {
    it(`refuses ${url}`, async () => {
      const driver = stubDriver()
      await expect(captureTool({ driver }).execute({ url }, execIn('/tmp'))).rejects.toThrow(reason)
      expect(driver.seen).toHaveLength(0)
    })
  }

  it('refuses a scheme that is not http or https', async () => {
    const driver = stubDriver()
    await expect(captureTool({ driver }).execute({ url: 'file:///etc/passwd' }, execIn('/tmp')))
      .rejects.toThrow('refuses the file: scheme')
    expect(driver.seen).toHaveLength(0)
  })

  it('refuses a public-looking hostname that resolves to loopback', async () => {
    const driver = stubDriver()
    const tool = captureTool({ driver, hostLookup: stubLookup('127.0.0.1') })
    await expect(tool.execute({ url: 'https://totally-public.example/' }, execIn('/tmp')))
      .rejects.toThrow('resolves to 127.0.0.1')
    expect(driver.seen).toHaveLength(0)
  })

  it('refuses when any one of several resolved addresses is private', async () => {
    const lookup = (): Promise<ResolvedAddress[]> => Promise.resolve([
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.7', family: 4 },
    ])
    await expect(screenUrl('https://mixed.example/', lookup)).rejects.toThrow('10.0.0.7')
  })

  it('pins the screened address so the browser resolves the same answer', async () => {
    const screened = await screenUrl('https://example.test/page', stubLookup('93.184.216.34'))
    expect(screened.addresses).toEqual(['93.184.216.34'])
    expect(screened.literal).toBe(false)
  })
})

describe('capture_page argument clamping', () => {
  it('caps width, height, deviceScaleFactor and waitMs', () => {
    const { request, clamped } = clampRequest(
      { url: 'https://example.test/', width: 99_999, height: 99_999, deviceScaleFactor: 12, waitMs: 600_000 },
      testConfig(),
    )
    expect(request.width).toBe(3840)
    expect(request.deviceScaleFactor).toBe(3)
    expect(request.waitMs).toBe(15_000)
    expect(request.height).toBeLessThanOrEqual(4320)
    expect(clamped.join(' ')).toContain('width 99999 capped at 3840')
  })

  it('trades height away to stay inside the pixel budget', () => {
    const { request, clamped } = clampRequest(
      { url: 'https://example.test/', width: 3840, height: 4320, deviceScaleFactor: 3 },
      testConfig(),
    )
    expect(request.width * request.height * 9).toBeLessThanOrEqual(40_000_000)
    expect(clamped.join(' ')).toContain('pixel budget')
  })

  it('raises a viewport smaller than anything lays out in', () => {
    const { request } = clampRequest({ url: 'https://example.test/', width: 1, height: 1 }, testConfig())
    expect(request.width).toBe(200)
    expect(request.height).toBe(200)
  })

  it('applies the documented defaults', () => {
    const { request, clamped } = clampRequest({ url: 'https://example.test/' }, testConfig())
    expect(request).toMatchObject({
      width: 1280, height: 900, deviceScaleFactor: 1, waitMs: 3000,
      fullPage: false, mobile: false, darkMode: false,
    })
    expect(clamped).toEqual([])
  })

  it('hands the clamped values to the browser, not the asked-for ones', async () => {
    const driver = stubDriver()
    const cwd = await sessionDir()
    await captureTool({ driver }).execute({ url: 'https://example.test/', width: 99_999, waitMs: 999_999 }, execIn(cwd))
    expect(driver.seen[0]?.width).toBe(3840)
    expect(driver.seen[0]?.waitMs).toBe(15_000)
  })
})

describe('capture_page measurements', () => {
  it('reports horizontal overflow as a number, not a judgement', async () => {
    const driver = stubDriver({ measurement: measurement({ scrollWidth: 1620, viewportWidth: 1280 }) })
    const cwd = await sessionDir()
    const value = await captureTool({ driver }).execute({ url: 'https://example.test/' }, execIn(cwd))
    expect(value.scrollWidth).toBe(1620)
    expect(value.horizontalOverflowPx).toBe(340)
    expect(String(value.text)).toContain('Horizontal overflow: 340px')
  })

  it('passes the broken-image list through by currentSrc', async () => {
    const broken = ['https://cdn.example.test/hero.png', 'https://cdn.example.test/logo.svg']
    const driver = stubDriver({ measurement: measurement({ brokenImages: broken, imageCount: 5 }) })
    const cwd = await sessionDir()
    const value = await captureTool({ driver }).execute({ url: 'https://example.test/' }, execIn(cwd))
    expect(value.brokenImages).toEqual(broken)
    expect(String(value.text)).toContain('Images: 5, 2 broken')
    expect(String(value.text)).toContain('hero.png')
  })

  it('distinguishes "rendered nothing" from "rendered off-screen"', async () => {
    const driver = stubDriver({ measurement: measurement({ elementCount: 91, paintedElementCount: 0 }) })
    const cwd = await sessionDir()
    const value = await captureTool({ driver }).execute({ url: 'https://example.test/' }, execIn(cwd))
    expect(value.elementCount).toBe(91)
    expect(value.paintedElementCount).toBe(0)
  })

  it('reports a selector that matched, with its box', async () => {
    const rect = { x: 40, y: 120, width: 420, height: 64, top: 120, right: 460, bottom: 184, left: 40 }
    const driver = stubDriver({
      measurement: measurement({ selector: { selector: '#cta', matched: true, count: 1, rect, page: { x: 40, y: 120, width: 420, height: 64 } } }),
    })
    const cwd = await sessionDir()
    const value = await captureTool({ driver }).execute({ url: 'https://example.test/', selector: '#cta' }, execIn(cwd))
    expect(value.selector).toMatchObject({ selector: '#cta', matched: true, count: 1 })
    expect(driver.seen[0]?.selector).toBe('#cta')
  })

  it('reports a selector that matched nothing without failing the call', async () => {
    const driver = stubDriver({ measurement: measurement({ selector: { selector: '.missing', matched: false, count: 0 } }) })
    const cwd = await sessionDir()
    const value = await captureTool({ driver }).execute({ url: 'https://example.test/', selector: '.missing' }, execIn(cwd))
    expect(value.selector).toMatchObject({ matched: false, count: 0 })
    expect(String(value.text)).toContain('no match')
  })
})

describe('capture_page image delivery', () => {
  it('publishes the PNG through the outputs capability when one is mounted', async () => {
    const published: string[] = []
    const outputs = {
      dir: (cwd: string) => join(cwd, 'edit'),
      publish: (_cwd: string, absPath: string, label?: string): Promise<PublishedOutput> => {
        published.push(absPath)
        return Promise.resolve({ name: 'shot.png', rel: 'edit/shot.png', bytes: 8, mtime: 1, ...label === undefined ? {} : { label } })
      },
      list: () => Promise.resolve([]),
    }
    const cwd = await sessionDir()
    const value = await captureTool({ driver: stubDriver(), readOutputs: () => outputs })
      .execute({ url: 'https://example.test/' }, execIn(cwd))
    expect(published).toHaveLength(1)
    expect(value.image).toMatchObject({ published: true, rel: 'edit/shot.png', name: 'shot.png' })
    // The summary has to end the question "where did it go, and is it done?".
    // The first real run answered the old wording with pwd, ls, a grep across
    // the workspace and two redundant copies of the image.
    expect(String(value.text)).toContain('Delivered: it is in the session outputs drawer at edit/shot.png')
    expect(String(value.text)).toContain('do not copy it anywhere else')
  })

  it('writes beside the session cwd and says where when no capability is mounted', async () => {
    const cwd = await sessionDir()
    const value = await captureTool({ driver: stubDriver() }).execute({ url: 'https://example.test/' }, execIn(cwd))
    const image = value.image as { published: boolean; path: string; name: string }
    expect(image.published).toBe(false)
    expect(image.path.startsWith(join(cwd, 'edit'))).toBe(true)
    expect(await readdir(join(cwd, 'edit'))).toEqual([image.name])
    expect(String(value.text)).toContain(image.path)
  })

  it('falls back to disk and says so when publishing fails', async () => {
    const outputs = {
      dir: (cwd: string) => join(cwd, 'edit'),
      publish: () => Promise.reject(new Error('drawer is full')),
      list: () => Promise.resolve([]),
    }
    const cwd = await sessionDir()
    const value = await captureTool({ driver: stubDriver(), readOutputs: () => outputs })
      .execute({ url: 'https://example.test/' }, execIn(cwd))
    expect((value.image as { published: boolean }).published).toBe(false)
    expect(String(value.text)).toContain('drawer is full')
  })
})

/** A connection stand-in that records what it was asked to do. */
interface StubConnection extends CdpConnection {
  sent: string[]
  evaluated: string[]
  closed: boolean
}

/** A connection stand-in: canned replies, and an event that never arrives. */
function stubConnection(overrides: Partial<Record<string, Record<string, unknown>>> = {}): StubConnection {
  const sent: string[] = []
  const evaluated: string[] = []
  const connection: StubConnection = {
    sent,
    evaluated,
    closed: false,
    send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
      sent.push(method)
      if (method === 'Runtime.evaluate') evaluated.push(String(params['expression']))
      if (Object.hasOwn(overrides, method)) return Promise.resolve(overrides[method] as Record<string, unknown>)
      if (method === 'Target.createTarget') return Promise.resolve({ targetId: 't1' })
      if (method === 'Target.attachToTarget') return Promise.resolve({ sessionId: 's1' })
      return Promise.resolve({})
    },
    waitFor(method: string, _sessionId: string | undefined, timeoutMs: number): Promise<Record<string, unknown>> {
      // Nothing ever fires this event; the driver's own deadline must end it.
      return new Promise((_resolve, reject) => {
        setTimeout(() => { reject(new Error(`capture_page: ${method} did not arrive within ${String(timeoutMs)}ms.`)) }, 10)
      })
    },
    close() { connection.closed = true },
  }
  return connection
}

/** Driver options with both browser seams stubbed out. */
function driverOptions(overrides: Partial<ChromiumDriverOptions> = {}): ChromiumDriverOptions {
  return {
    browserPath: '',
    launchTimeoutMs: 1000,
    loadTimeoutMs: 50,
    hardTimeoutMs: 5000,
    maxFullPageHeightPx: 20_000,
    scrollStepMs: 0,
    resolveBinary: () => '/stub/chromium',
    ...overrides,
  }
}

/** The request the driver tests capture. */
const driverRequest: CaptureRequest = {
  url: 'https://example.test/',
  addresses: ['93.184.216.34'],
  literalHost: false,
  width: 1280,
  height: 900,
  fullPage: false,
  deviceScaleFactor: 1,
  mobile: false,
  waitMs: 0,
  darkMode: false,
}

describe('browser resolution', () => {
  it('names every candidate when no browser is on PATH', () => {
    const previous = process.env['PATH']
    process.env['PATH'] = join(tmpdir(), 'definitely-not-a-bin-dir')
    try {
      expect(() => resolveBrowserPath()).toThrow('tried chromium-browser, chromium, google-chrome, google-chrome-stable')
    } finally {
      process.env['PATH'] = previous
    }
  })

  it('rejects a configured path that is not executable', () => {
    expect(() => resolveBrowserPath(join(tmpdir(), 'no-such-chromium'))).toThrow('is not an executable file')
  })
})

describe('chromium driver lifecycle', () => {
  it('kills the browser when the page never loads', async () => {
    let killed = 0
    const connection = stubConnection()
    const driver = createChromiumDriver(driverOptions({
      launch: (): Promise<LaunchedBrowser> => Promise.resolve({ endpoint: 'ws://stub/devtools', kill: () => { killed++ } }),
      connect: () => Promise.resolve(connection),
    }))
    await expect(driver.capture(driverRequest, new AbortController().signal))
      .rejects.toThrow('Page.loadEventFired did not arrive')
    expect(killed).toBe(1)
    expect(connection.closed).toBe(true)
  })

  it('kills the browser when the launcher itself fails', async () => {
    const driver = createChromiumDriver(driverOptions({
      launch: () => Promise.reject(new Error('chromium exited before listening')),
      connect: () => Promise.reject(new Error('unreachable')),
    }))
    await expect(driver.capture(driverRequest, new AbortController().signal))
      .rejects.toThrow('chromium exited before listening')
  })

  it('reports a navigation error without waiting out the load deadline', async () => {
    let killed = 0
    const driver = createChromiumDriver(driverOptions({
      loadTimeoutMs: 5000,
      launch: (): Promise<LaunchedBrowser> => Promise.resolve({ endpoint: 'ws://stub/devtools', kill: () => { killed++ } }),
      connect: () => Promise.resolve(stubConnection({ 'Page.navigate': { errorText: 'net::ERR_NAME_NOT_RESOLVED' } })),
    }))
    await expect(driver.capture(driverRequest, new AbortController().signal))
      .rejects.toThrow('net::ERR_NAME_NOT_RESOLVED')
    expect(killed).toBe(1)
  })

  it('forces lazy images to load before measuring and screenshotting', async () => {
    // The load event has to arrive for the capture to get as far as the page
    // scripts, so this connection answers it immediately.
    const base = stubConnection({ 'Page.captureScreenshot': { data: Buffer.from('png').toString('base64') } })
    const connection: CdpConnection = {
      close: () => { base.close() },
      waitFor: () => Promise.resolve({}),
      send: (method, params, sessionId) => {
        if (method === 'Runtime.evaluate') {
          const expression = String((params ?? {})['expression'])
          base.evaluated.push(expression)
          base.sent.push(method)
          return expression.includes('scrollWidth')
            ? Promise.resolve({ result: { value: measurement() } })
            : Promise.resolve({ result: { value: true } })
        }
        return base.send(method, params, sessionId)
      },
    }
    const driver = createChromiumDriver(driverOptions({
      launch: (): Promise<LaunchedBrowser> => Promise.resolve({ endpoint: 'ws://stub/devtools', kill: () => {} }),
      connect: () => Promise.resolve(connection),
    }))
    const result = await driver.capture(driverRequest, new AbortController().signal)
    expect(result.measurement.scrollWidth).toBe(1280)
    expect(result.png.byteLength).toBeGreaterThan(0)
    const lazyScript = base.evaluated.find(script => script.includes('loading="lazy"'))
    expect(lazyScript).toBeDefined()
    expect(lazyScript).toContain('img.loading = \'eager\'')
    expect(lazyScript).toContain('window.scrollTo(0, 0)')
    expect(base.sent).toContain('Emulation.setDeviceMetricsOverride')
    expect(base.sent).toContain('Page.captureScreenshot')
  })
})
