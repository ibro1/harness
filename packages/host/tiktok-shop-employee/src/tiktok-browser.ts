/**
 * The owner's TikTok account in its own browser: a persistent Chromium profile
 * kept with the employee's data, used for nothing but TikTok, and always
 * routed through the owner's proxy (a UK account should not sign in from a
 * server's address). It never shares a profile with the DeerFlow browsers.
 *
 * Signing in is by QR code: the login page is opened headless, its QR code is
 * shown on the settings page, and the owner scans it with the TikTok app. The
 * session then lives in the profile.
 *
 * Posting is a fixed script the owner starts from a video's review page, never
 * the model. `prepare` uploads the video, types the caption, tags the product
 * and sets the AI-generated and promotional labels, then screenshots the page
 * without posting; `post` does the same and presses Post. TikTok does not
 * document its upload page, so each step looks for controls by their visible
 * words, records whether it found them, and a step that cannot be done is
 * reported rather than guessed at. Posting refuses when the product could not
 * be tagged, since an untagged video earns no commission.
 */

import { mkdir, rm } from 'node:fs/promises'
import { chromium } from 'playwright-core'
import type { BrowserContext, Page } from 'playwright-core'
import { gotoThroughProxy, proxyOption } from './direct.ts'

/** What the browser needs, read on every use. */
export interface TikTokBrowserSettings {
  profileDir: string
  browserPath: string
  /** Required: the account is only ever used through it. */
  proxy: string
  uploadUrl: string
}

/** The account as the settings page shows it. */
export interface AccountState {
  state: 'signed-out' | 'waiting-for-scan' | 'signed-in' | 'error'
  /** The QR code to scan, as a PNG data URL, while waiting. */
  qr?: string
  /** TikTok's name for the signed-in account, when the page shows it. */
  user?: string
  error?: string
  checkedAt?: string
}

/** One step of a post, as the review page lists it. */
export interface PostStep {
  step: string
  ok: boolean
  note?: string
}

/** What a prepare or post run did. */
export interface PostRun {
  mode: 'prepare' | 'post'
  steps: PostStep[]
  /** PNG of the upload page at the end. */
  screenshot?: Buffer
  posted: boolean
  error?: string
}

/** What one post needs. */
export interface PostRequest {
  videoPath: string
  caption: string
  /** The product to tag, by id and by title (the search box takes either). */
  productId: string
  productTitle: string
}

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36'

/** Seconds a QR sign-in stays open before it is abandoned. */
const LOGIN_WINDOW_MS = 180_000

/** The browser, one use at a time. */
export class TikTokBrowser {
  private queue: Promise<unknown> = Promise.resolve()
  private login: { context: BrowserContext; until: number } | undefined
  private account: AccountState = { state: 'signed-out' }

  /** @param settings - read on every use. */
  constructor(private readonly settings: () => TikTokBrowserSettings) {}

  /** The account as last seen. */
  current(): AccountState {
    return { ...this.account }
  }

  private async open(): Promise<BrowserContext> {
    const s = this.settings()
    if (s.proxy.trim() === '') throw new Error('Set a proxy first: the TikTok account is only used through it, never from this server\'s own address.')
    await mkdir(s.profileDir, { recursive: true })
    return chromium.launchPersistentContext(s.profileDir, {
      executablePath: s.browserPath,
      headless: true,
      proxy: proxyOption(s.proxy.trim()),
      locale: 'en-GB',
      timezoneId: 'Europe/London',
      viewport: { width: 1366, height: 900 },
      userAgent: USER_AGENT,
      args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
    })
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work)
    this.queue = run.catch(() => undefined)
    return run
  }

  private static async signedIn(context: BrowserContext): Promise<boolean> {
    return (await context.cookies('https://www.tiktok.com')).some(c => c.name === 'sessionid' && c.value !== '')
  }

  /**
   * Open the QR login, or report that the account is already signed in. The login stays open in the background,
   * refreshing the QR code, until the owner scans it or the window passes.
   * @returns the account state, with the QR code while waiting.
   */
  startLogin(): Promise<AccountState> {
    return this.exclusive(async () => {
      if (this.login !== undefined) return this.current()
      const context = await this.open()
      try {
        if (await TikTokBrowser.signedIn(context)) {
          this.account = { state: 'signed-in', checkedAt: new Date().toISOString() }
          await context.close()
          return this.current()
        }
        const page = context.pages()[0] ?? await context.newPage()
        await gotoThroughProxy(page, 'https://www.tiktok.com/login/qrcode', 60_000)
        await page.waitForTimeout(2000)
        await dismissCookies(page)
        this.login = { context, until: Date.now() + LOGIN_WINDOW_MS }
        this.account = { state: 'waiting-for-scan', ...await TikTokBrowser.qr(page) }
        void this.watchLogin(page)
        return this.current()
      } catch (error) {
        await context.close().catch(() => undefined)
        this.account = { state: 'error', error: error instanceof Error ? error.message.split('\n')[0] ?? '' : String(error) }
        return this.current()
      }
    })
  }

  private static async qr(page: Page): Promise<{ qr?: string; error?: string }> {
    // The code is drawn on a canvas or an image near the "scan" instructions; take the largest square one.
    await page.waitForTimeout(3000)
    const title = await page.title()
    if (/security check|verify/iu.test(title)) return { error: `TikTok showed "${title}" through the proxy` }
    for (const selector of ['canvas', 'img[src^="data:image"]', '[data-e2e*="qr"] img', 'img[alt*="QR" i]']) {
      for (const element of await page.locator(selector).all()) {
        const box = await element.boundingBox().catch(() => null)
        if (box === null || box.width < 120 || Math.abs(box.width - box.height) > 20) continue
        const png = await element.screenshot()
        return { qr: `data:image/png;base64,${png.toString('base64')}` }
      }
    }
    return { error: 'the login page showed no QR code; it may have changed' }
  }

  private async watchLogin(page: Page): Promise<void> {
    const login = this.login
    if (login === undefined) return
    try {
      while (Date.now() < login.until) {
        await page.waitForTimeout(4000)
        if (await TikTokBrowser.signedIn(login.context)) {
          await page.waitForTimeout(3000)
          this.account = { state: 'signed-in', checkedAt: new Date().toISOString() }
          return
        }
        // The QR code expires and is replaced; show the current one.
        const fresh = await TikTokBrowser.qr(page)
        if (fresh.qr !== undefined) this.account = { state: 'waiting-for-scan', qr: fresh.qr }
      }
      this.account = { state: 'signed-out', error: 'the QR code was not scanned in time' }
    } catch (error) {
      this.account = { state: 'error', error: error instanceof Error ? error.message.split('\n')[0] ?? '' : String(error) }
    } finally {
      this.login = undefined
      await login.context.close().catch(() => undefined)
    }
  }

  /**
   * Check whether the saved session is still signed in.
   * @returns the account state.
   */
  check(): Promise<AccountState> {
    return this.exclusive(async () => {
      if (this.login !== undefined) return this.current()
      const context = await this.open()
      try {
        this.account = (await TikTokBrowser.signedIn(context))
          ? { state: 'signed-in', checkedAt: new Date().toISOString() }
          : { state: 'signed-out', checkedAt: new Date().toISOString() }
      } finally {
        await context.close().catch(() => undefined)
      }
      return this.current()
    })
  }

  /** Forget the session: the profile is deleted. */
  signOut(): Promise<void> {
    return this.exclusive(async () => {
      await this.login?.context.close().catch(() => undefined)
      this.login = undefined
      await rm(this.settings().profileDir, { recursive: true, force: true })
      this.account = { state: 'signed-out' }
    })
  }

  /**
   * Upload one video and fill everything in; press Post only in `post` mode and only when every required step worked.
   * @param request - the video, caption and product.
   * @param mode - `prepare` stops before posting.
   * @returns the steps, a screenshot and whether it was posted.
   */
  run(request: PostRequest, mode: 'prepare' | 'post'): Promise<PostRun> {
    return this.exclusive(async () => {
      if (this.login !== undefined) return { mode, steps: [], posted: false, error: 'a QR sign-in is open; finish it first' }
      const steps: PostStep[] = []
      const record = (step: string, ok: boolean, note?: string): boolean => {
        steps.push({ step, ok, ...note === undefined ? {} : { note } })
        return ok
      }
      const appears = (words: RegExp, ms: number): Promise<boolean> =>
        page.getByText(words).first().waitFor({ timeout: ms }).then(() => true, () => false)
      const context = await this.open()
      const page = context.pages()[0] ?? await context.newPage()
      try {
        if (!record('Signed in', await TikTokBrowser.signedIn(context), 'scan the QR code on Plugins → TikTok Shop employee')) {
          this.account = { state: 'signed-out' }
          return { mode, steps, posted: false, error: 'not signed in' }
        }
        await gotoThroughProxy(page, this.settings().uploadUrl, 60_000)
        await page.waitForTimeout(5000)
        await dismissCookies(page)
        const title = await page.title()
        if (!record('Upload page', !/security check|log in|login/iu.test(title), title)) return await finish(false, 'the upload page did not open')

        const input = page.locator('input[type="file"]').first()
        await input.setInputFiles(request.videoPath, { timeout: 30_000 })
        // The caption box and the Post button come alive once the upload is processed.
        const uploaded = await appears(/Uploaded|Upload complete|100%/iu, 180_000)
        record('Video uploaded', uploaded, uploaded ? undefined : 'no "Uploaded" message within 3 minutes')

        const editor = page.locator('[contenteditable="true"]').first()
        const captionOk = await editor.waitFor({ timeout: 30_000 }).then(async () => {
          await editor.click()
          await page.keyboard.press('Control+A')
          await page.keyboard.press('Backspace')
          // Hashtags open a suggestion list; a space after each closes it.
          for (const part of request.caption.split(/(\s+)/u)) {
            await page.keyboard.type(part, { delay: 15 })
            if (part.startsWith('#')) await page.keyboard.type(' ')
          }
          return true
        }, () => false)
        record('Caption', captionOk)

        const tagged = await tagProduct(page, request).catch((error: unknown) => ({ ok: false, note: error instanceof Error ? error.message.split('\n')[0] ?? '' : String(error) }))
        record('Product tagged', tagged.ok, tagged.note)

        const more = page.getByText(/Show more|More options|Advanced settings/iu).first()
        if (await more.isVisible().catch(() => false)) await more.click().catch(() => undefined)
        record('AI-generated label', await switchOn(page, /AI-generated content/iu))
        record('Promotional content label', await switchOn(page, /Disclose (?:post|video) content|Content disclosure/iu))

        if (mode === 'prepare') return await finish(false)
        const required = steps.filter(s => ['Signed in', 'Upload page', 'Video uploaded', 'Caption', 'Product tagged'].includes(s.step))
        if (required.some(s => !s.ok)) return await finish(false, 'not posted: a required step did not work (see the steps)')
        const post = page.getByRole('button', { name: /^Post$/u }).first()
        await post.click({ timeout: 15_000 })
        const done = await appears(/posted|uploaded successfully|Manage your posts|View profile/iu, 90_000)
        record('Posted', done, done ? undefined : 'no confirmation within 90 seconds; check the account before posting again')
        return await finish(done, done ? undefined : 'no posting confirmation')
      } catch (error) {
        return await finish(false, error instanceof Error ? error.message.split('\n')[0] ?? '' : String(error))
      } finally {
        await context.close().catch(() => undefined)
      }

      async function finish(posted: boolean, error?: string): Promise<PostRun> {
        const screenshot = await page.screenshot({ fullPage: true }).catch(() => undefined)
        return { mode, steps, posted, ...screenshot === undefined ? {} : { screenshot }, ...error === undefined ? {} : { error } }
      }
    })
  }
}

/** Decline TikTok's optional cookies when its banner shows, so the banner covers nothing the script clicks. */
async function dismissCookies(page: Page): Promise<void> {
  const decline = page.getByRole('button', { name: /Decline optional cookies/iu }).first()
  if (await decline.isVisible().catch(() => false)) await decline.click().catch(() => undefined)
}

/** Turn on the switch next to a label, if it is off. */
async function switchOn(page: Page, label: RegExp): Promise<boolean> {
  const row = page.getByText(label).first()
  if (!await row.isVisible().catch(() => false)) return false
  const container = row.locator('xpath=ancestor::*[.//*[@role="switch"] or .//input[@type="checkbox"]][1]')
  const control = container.locator('[role="switch"], input[type="checkbox"]').first()
  if (!await control.count().then(n => n > 0, () => false)) return false
  const on = await control.evaluate(el => el.getAttribute('aria-checked') === 'true' || (el instanceof HTMLInputElement && el.checked)).catch(() => false)
  if (!on) await control.click({ force: true }).catch(() => undefined)
  return control.evaluate(el => el.getAttribute('aria-checked') === 'true' || (el instanceof HTMLInputElement && el.checked)).catch(() => false)
}

/** Add the product link: "Add link" (or "Add product"), the Products tab, a search, the matching row, and confirm. */
async function tagProduct(page: Page, request: PostRequest): Promise<{ ok: boolean; note?: string }> {
  const open = page.getByText(/^(?:Add link|Add product|Add products|Link)$/iu).first()
  if (!await open.isVisible().catch(() => false)) return { ok: false, note: 'no "Add link" control on the upload page; the account may not have product links on the web' }
  await open.click()
  const products = page.getByText(/^Products?$/iu).first()
  if (await products.isVisible().catch(() => false)) await products.click()
  const next = page.getByRole('button', { name: /^Next$/iu }).first()
  if (await next.isVisible().catch(() => false)) await next.click()
  const search = page.getByPlaceholder(/search/iu).first()
  if (!await search.waitFor({ timeout: 10_000 }).then(() => true, () => false)) return { ok: false, note: 'no product search box appeared' }
  await search.fill(request.productId)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(3000)
  let row = page.getByText(request.productTitle.slice(0, 30), { exact: false }).first()
  if (!await row.isVisible().catch(() => false)) {
    await search.fill(request.productTitle.slice(0, 40))
    await page.keyboard.press('Enter')
    await page.waitForTimeout(3000)
    row = page.getByText(request.productTitle.slice(0, 30), { exact: false }).first()
  }
  if (!await row.isVisible().catch(() => false)) return { ok: false, note: 'the product was not found in the product search; is it in your showcase?' }
  await row.click()
  for (const name of [/^Next$/iu, /^Add$/iu, /^Done$/iu, /^Confirm$/iu]) {
    const button = page.getByRole('button', { name }).first()
    if (await button.isVisible().catch(() => false)) await button.click().catch(() => undefined)
    await page.waitForTimeout(800)
  }
  const shown = await page.getByText(request.productTitle.slice(0, 20), { exact: false }).first().isVisible().catch(() => false)
  return shown ? { ok: true } : { ok: false, note: 'the product was picked but does not show on the post' }
}
