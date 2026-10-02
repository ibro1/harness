/**
 * Reading TikTok Shop directly, in a real headless Chromium routed through a
 * proxy. From this server's own address TikTok answers every automated reader
 * with a "Security Check" page; through a residential or mobile proxy a real
 * browser can get the page, which costs nothing per request.
 *
 * TikTok does not document its shop pages, so nothing here depends on one
 * page layout: the page's own JSON (inline scripts and every JSON response it
 * loads from TikTok) is walked for objects that read as products, through the
 * same field-name-tolerant parser the SocialCrawl client uses. The search and
 * product page addresses are settings, with `{region}`, `{query}` and `{id}`
 * placeholders. A security check, an empty answer or a failure is reported as
 * such, so the caller can fall back to SocialCrawl.
 */

import { chromium } from 'playwright-core'
import type { Browser, Response as PlaywrightResponse } from 'playwright-core'
import { parseProduct, type ShopProduct, type SocialCrawl } from './socialcrawl.ts'

/** Why a direct read gave nothing usable. */
export class DirectUnavailable extends Error {}

/** Settings for the direct reader, read on every call. */
export interface DirectSettings {
  /** `http://user:pass@host:port` or `socks5://host:port`; empty means no proxy, and no direct read. */
  proxy: string
  browserPath: string
  region: string
  /** Search page address; `{region}` and `{query}` are filled in. */
  searchUrl: string
  /** Product page address; `{region}` and `{id}` are filled in. */
  productUrl: string
  /** Longest wait for one page, in milliseconds. */
  timeoutMs: number
}

/** Hosts whose JSON responses may carry products. */
const TIKTOK_HOST = /(?:^|\.)(?:tiktok\.com|tiktokshop\.com|tiktokv\.com|tiktokcdn\.com)$/iu

/**
 * Every object in a JSON value that reads as a product, without repeats.
 * @param value - parsed JSON.
 * @param region - fills in the currency when a product names none.
 * @returns the products, in the order found.
 */
export function productsIn(value: unknown, region = 'GB'): ShopProduct[] {
  const currency = region.toUpperCase() === 'GB' ? 'GBP' : region.toUpperCase() === 'US' ? 'USD' : 'GBP'
  const found = new Map<string, ShopProduct>()
  const stack: unknown[] = [value]
  let visited = 0
  while (stack.length > 0 && visited < 200_000) {
    visited++
    const item = stack.pop()
    if (Array.isArray(item)) { for (const child of item) stack.push(child); continue }
    if (typeof item !== 'object' || item === null) continue
    const product = parseProduct(item, currency)
    if (product !== undefined && /^\d{6,}$/u.test(product.id) && !found.has(product.id)) {
      found.set(product.id, product)
      continue
    }
    for (const child of Object.values(item)) stack.push(child)
  }
  return [...found.values()]
}

/** The proxy as Playwright takes it. */
export function proxyOption(url: string): { server: string; username?: string; password?: string } {
  const parsed = new URL(url)
  const server = `${parsed.protocol}//${parsed.hostname}${parsed.port === '' ? '' : `:${parsed.port}`}`
  return {
    server,
    ...parsed.username === '' ? {} : { username: decodeURIComponent(parsed.username) },
    ...parsed.password === '' ? {} : { password: decodeURIComponent(parsed.password) },
  }
}

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/gu, (_, key: string) => encodeURIComponent(values[key] ?? ''))
}

/**
 * The direct reader, with the same calls as the SocialCrawl client.
 * @param settings - read on every call.
 * @returns the reader; each call starts and closes its own browser.
 */
export function directShop(settings: () => DirectSettings): SocialCrawl {
  const read = async (url: string, signal: AbortSignal): Promise<ShopProduct[]> => {
    const current = settings()
    if (current.proxy.trim() === '') throw new DirectUnavailable('no proxy is set, and TikTok blocks this server\'s own address')
    let browser: Browser | undefined
    const onAbort = (): void => { void browser?.close() }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      browser = await chromium.launch({
        executablePath: current.browserPath,
        proxy: proxyOption(current.proxy.trim()),
        args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
      })
      const page = await browser.newPage({
        locale: current.region.toUpperCase() === 'GB' ? 'en-GB' : 'en-US',
        viewport: { width: 1280, height: 900 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
      })
      const bodies: unknown[] = []
      const pending: Promise<void>[] = []
      page.on('response', (response: PlaywrightResponse) => {
        let host = ''
        try { host = new URL(response.url()).hostname } catch (_error) { return }
        if (!TIKTOK_HOST.test(host) || !(response.headers()['content-type'] ?? '').includes('json')) return
        pending.push(response.json().then((body: unknown) => { bodies.push(body) }, () => undefined))
      })
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: current.timeoutMs })
      // Product lists load after the first paint; scroll once to trigger lazy loading, then let requests settle.
      await page.waitForTimeout(4000)
      await page.mouse.wheel(0, 2400)
      await page.waitForTimeout(3000)
      const title = await page.title()
      if (/security check|verify|captcha/iu.test(title)) throw new DirectUnavailable(`TikTok showed "${title}" through the proxy`)
      const inline = await page.evaluate(() => [...document.querySelectorAll('script')]
        .map(s => s.text).filter(t => t.length > 50 && /^\s*[[{]/u.test(t)))
      for (const text of inline) {
        try { bodies.push(JSON.parse(text)) } catch (_error) { /* not JSON: a script, not data */ }
      }
      await Promise.all(pending)
      const products = bodies.flatMap(body => productsIn(body, current.region))
      return [...new Map(products.map(p => [p.id, p])).values()]
    } catch (error) {
      if (error instanceof DirectUnavailable || signal.aborted) throw error
      throw new DirectUnavailable(`the direct read failed: ${error instanceof Error ? error.message.split('\n')[0] ?? '' : String(error)}`)
    } finally {
      signal.removeEventListener('abort', onAbort)
      await browser?.close().catch(() => undefined)
    }
  }
  return {
    async search(query, signal) {
      const current = settings()
      const products = await read(fill(current.searchUrl, { region: current.region.toLowerCase(), query }), signal)
      if (products.length === 0) throw new DirectUnavailable('the search page showed no products the reader could recognise')
      return products
    },
    async product(ref, signal) {
      const current = settings()
      const id = /^\d+$/u.test(ref) ? ref : /(\d{12,})/u.exec(ref)?.[1] ?? ''
      const url = /^https?:\/\//u.test(ref) ? ref : fill(current.productUrl, { region: current.region.toLowerCase(), id })
      const products = await read(url, signal)
      const exact = products.find(p => p.id === id) ?? products[0]
      if (exact === undefined) throw new DirectUnavailable('the product page showed no product the reader could recognise')
      return exact
    },
  }
}

/** Which source answered, for the tool's reply. */
export interface SourcedAnswer<T> {
  value: T
  source: 'TikTok directly' | 'SocialCrawl'
  /** Why the direct read was not used, when it was tried and failed. */
  directFailed?: string
}

/**
 * Direct first when a proxy is set, SocialCrawl when that is unavailable.
 * @param direct - the direct reader.
 * @param crawl - the SocialCrawl client.
 * @param directEnabled - whether to try the direct reader at all.
 * @returns search and product calls that say which source answered.
 */
export function withFallback(direct: SocialCrawl, crawl: SocialCrawl, directEnabled: () => boolean): {
  search: (query: string, signal: AbortSignal) => Promise<SourcedAnswer<ShopProduct[]>>
  product: (ref: string, signal: AbortSignal) => Promise<SourcedAnswer<ShopProduct | undefined>>
} {
  const attempt = async <T>(viaDirect: () => Promise<T>, viaCrawl: () => Promise<T>): Promise<SourcedAnswer<T>> => {
    let directFailed: string | undefined
    if (directEnabled()) {
      try {
        return { value: await viaDirect(), source: 'TikTok directly' }
      } catch (error) {
        if (!(error instanceof DirectUnavailable)) throw error
        directFailed = error.message
      }
    }
    try {
      return { value: await viaCrawl(), source: 'SocialCrawl', ...directFailed === undefined ? {} : { directFailed } }
    } catch (error) {
      if (directFailed === undefined) throw error
      throw new Error(`Neither source answered. TikTok directly: ${directFailed}. SocialCrawl: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
  }
  return {
    search: (query, signal) => attempt(() => direct.search(query, signal), () => crawl.search(query, signal)),
    product: (ref, signal) => attempt(() => direct.product(ref, signal), () => crawl.product(ref, signal)),
  }
}
