/**
 * Google's first page for a keyword, read in the harness's own headless
 * Chromium (through the proxy when one is set), and the verdict on it: is
 * there room for a small, new tool page? A page where Google answers the
 * query itself (calculator, unit or currency converter, timer, translation,
 * weather, dictionary, sports) is rejected outright: the click never
 * happens. Forums, app stores and small or young sites in the results, and
 * few dedicated tools, mean room; government pages and big calculator brands
 * mean none.
 *
 * The page is read by one script (`EXTRACT_SERP`) that runs inside the
 * browser and returns plain data; the verdict is decided here from that
 * data, so saved result pages can be tested by running the same script in a
 * DOM implementation.
 */

import { chromium } from 'playwright-core'
import type { Browser } from 'playwright-core'

/** One organic result. */
export interface SerpResult {
  title: string
  /** Host without `www.`. */
  host: string
  /** The address as Google shows it, which may be shortened. */
  shown: string
}

/** What the browser read off one results page. */
export interface SerpExtract {
  /** Google showed its "unusual traffic" or consent page instead of results. */
  blocked: boolean
  results: SerpResult[]
  /** "People also ask" questions. */
  questions: string[]
  /** "People also search for" phrases. */
  related: string[]
  /** Section headings on the page, such as `Currency converter` or `AI Overview`. */
  headings: string[]
  /** Labels of form controls Google drew on the page (its own widgets). */
  controls: string[]
  /** Ids of known answer boxes present on the page. */
  boxes: string[]
  ads: number
}

/**
 * The extraction, as a function expression of `document`, kept as source text so it runs unchanged in the browser
 * (`page.evaluate`) and in tests (a DOM implementation's `eval`).
 */
export const EXTRACT_SERP = String.raw`(function (doc) {
  var text = function (el) { return (el && el.textContent || '').replace(/\s+/g, ' ').trim() }
  var body = text(doc.body)
  var robot = /unusual traffic|not a robot|detected unusual/i.test(body) || doc.querySelector('form#captcha-form, #recaptcha') !== null
  var results = []
  var seen = {}
  var heads = doc.querySelectorAll('#search a h3, #rso a h3')
  for (var i = 0; i < heads.length && results.length < 12; i++) {
    var h = heads[i]
    var a = h.closest('a')
    if (!a) continue
    var box = a
    for (var k = 0; k < 8 && box && !box.querySelector('cite'); k++) box = box.parentElement
    var shown = text(box && box.querySelector('cite'))
    var href = a.getAttribute('href') || ''
    var raw = /^https?:\/\//.test(href) ? href : (shown.split(' ')[0] || '')
    if (!/^(?:https?:\/\/)?[a-z0-9-]+(?:\.[a-z0-9-]+)+/i.test(raw)) {
      // Discussion results name the forum beside the title instead of an address.
      var area = a
      for (var u = 0; u < 6 && area.parentElement && text(area).length <= text(h).length + 2; u++) area = area.parentElement
      var after = text(area).slice(text(area).indexOf(text(h)) + text(h).length).slice(0, 120)
      var named = /(reddit|quora|youtube|facebook|tiktok|instagram|mumsnet|stackexchange)/i.exec(after)
      raw = named ? named[1].toLowerCase() + '.com' : ''
    }
    var host = ''
    try { host = new URL(/^https?:\/\//.test(raw) ? raw : 'https://' + raw).hostname.replace(/^www\./, '') } catch (e) { host = '' }
    var key = text(h) + '|' + host
    if (!host || seen[key]) continue
    seen[key] = true
    results.push({ title: text(h), host: host, shown: shown })
  }
  var questions = []
  var qs = doc.querySelectorAll('[data-q]')
  for (var j = 0; j < qs.length; j++) {
    var q = (qs[j].getAttribute('data-q') || '').trim()
    if (q && questions.indexOf(q) < 0) questions.push(q)
  }
  var related = []
  var rl = doc.querySelectorAll('#botstuff a[href*="/search?"]')
  for (var r = 0; r < rl.length; r++) {
    var t = text(rl[r])
    if (t.length > 2 && !/^\d+$/.test(t) && related.indexOf(t) < 0 && t !== 'Next') related.push(t)
  }
  var headings = []
  var hs = doc.querySelectorAll('h2, [role=heading][aria-level="2"], [role=heading]:not([aria-level])')
  for (var m = 0; m < hs.length && headings.length < 40; m++) {
    var ht = text(hs[m])
    if (ht && ht.length < 80 && headings.indexOf(ht) < 0) headings.push(ht)
  }
  var controls = []
  var cs = doc.querySelectorAll('#search input[aria-label], #search select[aria-label], #rso input[aria-label], #rso select[aria-label], #center_col [aria-label] input, #center_col select')
  for (var c = 0; c < cs.length && controls.length < 20; c++) {
    var label = cs[c].getAttribute('aria-label') || ''
    if (label && controls.indexOf(label) < 0) controls.push(label)
  }
  var boxes = []
  var known = ['cwos', 'knowledge-currency__updatable-data-column', 'tw-main', 'wob_wc', 'act-timer-section', 'sports-app']
  for (var b = 0; b < known.length; b++) if (doc.getElementById(known[b])) boxes.push(known[b])
  if (doc.querySelector('[data-attrid="Converter"], [data-attrid*="UnitConverter"]')) boxes.push('converter')
  if (doc.querySelector('[data-dobid="hdw"], [data-attrid="EntryHeader"]')) boxes.push('dictionary')
  var ads = doc.querySelectorAll('#tads [data-text-ad], #bottomads [data-text-ad]').length
  // Google's consent page sits over the results in some countries; only a page with no results is blocked by it.
  var blocked = robot || (results.length === 0 && /^Before you continue/i.test(text(doc.querySelector('h1'))))
  return { blocked: blocked, results: results, questions: questions, related: related, headings: headings, controls: controls, boxes: boxes, ads: ads }
})`

/**
 * The "People also ask" questions, without the query itself (Google repeats it in an element of the same kind).
 * @param page - the extract.
 * @param keyword - the query.
 * @returns the questions.
 */
export function peopleAsk(page: Pick<SerpExtract, 'questions'>, keyword: string): string[] {
  return page.questions.filter(q => q.trim().toLowerCase() !== keyword.trim().toLowerCase())
}

/** Google's own answer widgets, by what gives each away. */
const WIDGETS: { kind: string; headings: RegExp; controls?: RegExp; boxes?: string[] }[] = [
  { kind: 'calculator', headings: /^calculator(?: result)?$/iu, boxes: ['cwos'] },
  { kind: 'currency converter', headings: /^currency converter$/iu, controls: /currency (?:amount|type)/iu, boxes: ['knowledge-currency__updatable-data-column'] },
  { kind: 'unit converter', headings: /^unit converter$/iu, controls: /^(?:unit category|source unit|converted unit)$/iu, boxes: ['converter'] },
  { kind: 'timer or stopwatch', headings: /^(?:timer|stopwatch)$/iu, boxes: ['act-timer-section'] },
  { kind: 'translation', headings: /^(?:translation result|translate)$/iu, controls: /^(?:source text|translated text)$/iu, boxes: ['tw-main'] },
  { kind: 'weather', headings: /^weather$/iu, boxes: ['wob_wc'] },
  { kind: 'dictionary definition', headings: /^(?:dictionary|definitions?(?: from .+)?)$/iu, boxes: ['dictionary'] },
  { kind: 'sports results', headings: /^(?:matches|standings|fixtures)$/iu, boxes: ['sports-app'] },
  { kind: 'mortgage or loan calculator', headings: /^(?:mortgage|loan) calculator$/iu },
  { kind: 'time zone or clock', headings: /^(?:local time|time zone converter|current time)$/iu },
  { kind: 'colour picker', headings: /^colou?r picker$/iu },
  { kind: 'random number or coin flip', headings: /^(?:random number generator|flip a coin|roll a die)$/iu },
]

/**
 * Which of Google's own answer widgets the page shows, if any.
 * @param page - the extract.
 * @returns the widget's kind, or undefined.
 */
export function answerWidget(page: Pick<SerpExtract, 'headings' | 'controls' | 'boxes'>): string | undefined {
  for (const widget of WIDGETS) {
    if (page.headings.some(h => widget.headings.test(h.trim()))) return widget.kind
    if (widget.controls !== undefined && page.controls.some(c => widget.controls?.test(c.trim()) === true)) return widget.kind
    if (widget.boxes?.some(box => page.boxes.includes(box)) === true) return widget.kind
  }
  return undefined
}

/**
 * A pattern matching a host or any subdomain of it.
 * @param patterns - host patterns, regular-expression source.
 * @returns the pattern.
 */
function hosts(patterns: readonly string[]): RegExp {
  return new RegExp(`(?:^|\\.)(?:${patterns.join('|')})$`, 'iu')
}

/** Forums and question-and-answer sites: real people asking, few pages built for the query. */
const FORUMS = hosts([
  'reddit\\.com', 'quora\\.com', 'stackexchange\\.com', 'stackoverflow\\.com', 'answers\\.com', 'mumsnet\\.com', 'forums?\\.[\\w-]+\\.\\w+',
  'community\\.[\\w-]+\\.\\w+', 'boards\\.[\\w-]+\\.\\w+', 'islamqa\\.info', 'tripadvisor\\.[\\w.]+',
])
/** Platforms a tool page outranks easily: apps, videos and social posts. */
const PLATFORMS = hosts([
  'youtube\\.com', 'play\\.google\\.com', 'apps\\.apple\\.com', 'facebook\\.com', 'instagram\\.com', 'tiktok\\.com', 'pinterest\\.[\\w.]+',
  'linkedin\\.com', 'medium\\.com', 'x\\.com', 'twitter\\.com', 'scribd\\.com', 'slideshare\\.net',
])
/** Domains a small new site does not outrank: governments, encyclopedias, big brands and calculator sites. */
const STRONG = hosts([
  'gov\\.uk', 'gov', 'gov\\.\\w\\w', 'nhs\\.uk', 'wikipedia\\.org', 'bbc\\.co\\.uk', 'calculator\\.net', 'omnicalculator\\.com',
  'rapidtables\\.com', 'calculatorsoup\\.com', 'thecalculatorsite\\.com', 'inchcalculator\\.com', 'nerdwallet\\.com',
  'investopedia\\.com', 'moneysavingexpert\\.com', 'which\\.co\\.uk', 'bankrate\\.com', 'xe\\.com', 'wise\\.com', 'timeanddate\\.com',
  'forbes\\.com', 'hmrc\\.gov\\.uk', 'mayoclinic\\.org', 'webmd\\.com', 'healthline\\.com', 'nytimes\\.com', 'theguardian\\.com',
  'bupa\\.co\\.uk', 'hl\\.co\\.uk', 'vanguardinvestor\\.co\\.uk', 'unbiased\\.co\\.uk', 'money\\.co\\.uk', 'uswitch\\.com',
  'islamic-relief\\.org(?:\\.uk)?', 'nzf\\.org\\.uk', 'zakat\\.org', 'symbolab\\.com', 'mathsisfun\\.com', 'wolframalpha\\.com',
  'microsoft\\.com', 'apple\\.com', 'amazon\\.[\\w.]+', 'britannica\\.com', 'dictionary\\.com', 'merriam-webster\\.com',
  'cambridge\\.org',
])
/** A result built as a tool. */
const TOOL_WORDS = /\b(?:calculator|calculate|converter|convert|checker|generator|estimator|tool|planner)\b/iu

/** How a result's site counts. */
export type HostKind = 'forum' | 'platform' | 'strong' | 'other'

/**
 * Classify a result's host.
 * @param host - the host.
 * @returns its kind.
 */
export function hostKind(host: string): HostKind {
  if (FORUMS.test(host)) return 'forum'
  if (PLATFORMS.test(host)) return 'platform'
  if (STRONG.test(host)) return 'strong'
  return 'other'
}

/** The verdict on a results page. */
export interface SerpVerdict {
  /**
   * `reject`: Google answers it itself; `open`: room for a new tool; `contested`: possible with a clearly better tool;
   * `hard`: big sites own it; `unknown`: no results read.
   */
  verdict: 'reject' | 'open' | 'contested' | 'hard' | 'unknown'
  /** 0 (no room) to 10 (wide open). */
  room: number
  widget?: string
  forums: number
  platforms: number
  strong: number
  /** Dedicated tools in the top ten. */
  tools: number
  aiOverview: boolean
  reasons: string[]
}

/**
 * Judge a results page.
 * @param page - the extract.
 * @returns the verdict and why.
 */
export function serpVerdict(page: SerpExtract): SerpVerdict {
  const base = { forums: 0, platforms: 0, strong: 0, tools: 0, aiOverview: false }
  if (page.blocked) return { ...base, verdict: 'unknown', room: 0, reasons: ['Google showed a robot check or consent page instead of results.'] }
  const widget = answerWidget(page)
  const aiOverview = page.headings.some(h => /^ai overview$/iu.test(h.trim()))
  if (widget !== undefined) {
    return { ...base, aiOverview, verdict: 'reject', room: 0, widget, reasons: [`Google answers this itself with its ${widget}: searchers get the answer without clicking.`] }
  }
  const top = page.results.slice(0, 10)
  if (top.length === 0) return { ...base, aiOverview, verdict: 'unknown', room: 0, reasons: ['No organic results were read.'] }
  const kinds = top.map(r => hostKind(r.host))
  const forums = kinds.filter(k => k === 'forum').length
  const platforms = kinds.filter(k => k === 'platform').length
  const strong = kinds.filter(k => k === 'strong').length
  const strongTop5 = kinds.slice(0, 5).filter(k => k === 'strong').length
  const otherTop5 = kinds.slice(0, 5).filter(k => k === 'other').length
  const tools = top.filter(r => TOOL_WORDS.test(r.title) || TOOL_WORDS.test(r.shown)).length
  let room = 5
  const reasons: string[] = []
  if (forums + platforms > 0) {
    room += Math.min(3, 1.5 * (forums + platforms))
    reasons.push(`${String(forums)} forum and ${String(platforms)} app/video/social results in the top ten: people ask and no page answers them well.`)
  }
  if (otherTop5 > 0) {
    room += Math.min(2, 0.5 * otherTop5)
    reasons.push(`${String(otherTop5)} of the top five ${otherTop5 === 1 ? 'is an ordinary site' : 'are ordinary sites'}, not big brands.`)
  }
  if (strongTop5 > 0) {
    room -= Math.min(4, 1.25 * strongTop5)
    reasons.push(`${String(strongTop5)} of the top five ${strongTop5 === 1 ? 'is a government or big-brand site' : 'are government or big-brand sites'} (${top.filter((_, i) => kinds[i] === 'strong').map(r => r.host).slice(0, 4).join(', ')}).`)
  }
  if (tools === 0) {
    room += 2
    reasons.push('No dedicated tool in the top ten: the query is answered by articles.')
  } else if (tools >= 7) {
    room -= 1
    reasons.push(`${String(tools)} of the top ten are already tools: ours must be clearly better.`)
  } else {
    reasons.push(`${String(tools)} of the top ten ${tools === 1 ? 'is a tool' : 'are tools'}.`)
  }
  if (aiOverview) {
    room -= 0.5
    reasons.push('Google shows an AI Overview, which takes some clicks.')
  }
  room = Math.round(Math.min(10, Math.max(0, room)) * 10) / 10
  const verdict = room >= 6 ? 'open' : room >= 4 ? 'contested' : 'hard'
  return { verdict, room, forums, platforms, strong, tools, aiOverview, reasons }
}

/** Settings for reading Google. */
export interface SerpBrowserSettings {
  browserPath: string
  /** `http://user:pass@host:port`; empty reads from the server's own address. */
  proxy: string
  timeoutMs: number
}

/**
 * The proxy as Playwright takes it.
 * @param url - the proxy address.
 * @returns server and credentials.
 */
export function proxyOption(url: string): { server: string; username?: string; password?: string } {
  const parsed = new URL(url)
  const server = `${parsed.protocol}//${parsed.hostname}${parsed.port === '' ? '' : `:${parsed.port}`}`
  return {
    server,
    ...parsed.username === '' ? {} : { username: decodeURIComponent(parsed.username) },
    ...parsed.password === '' ? {} : { password: decodeURIComponent(parsed.password) },
  }
}

/**
 * Google's results address for a keyword in one market.
 * @param keyword - the query.
 * @param market - two-letter country.
 * @returns the address.
 */
export function serpUrl(keyword: string, market: string): string {
  const url = new URL('https://www.google.com/search')
  url.search = new URLSearchParams({ q: keyword, hl: 'en', gl: market.toLowerCase(), num: '10', pws: '0' }).toString()
  return url.toString()
}

const LOCALES: Record<string, string> = { GB: 'en-GB', US: 'en-US', CA: 'en-CA', AU: 'en-AU', IE: 'en-IE', NZ: 'en-NZ', IN: 'en-IN', NG: 'en-NG' }

/**
 * Build the reader: each call starts its own browser, reads one page and closes it.
 * @param settings - read on every call.
 * @returns the reader.
 */
export function serpReader(
  settings: () => SerpBrowserSettings,
): (keyword: string, market: string, signal: AbortSignal) => Promise<SerpExtract> {
  return async (keyword, market, signal) => {
    const current = settings()
    let browser: Browser | undefined
    const onAbort = (): void => { void browser?.close() }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      browser = await chromium.launch({
        executablePath: current.browserPath,
        ...current.proxy.trim() === '' ? {} : { proxy: proxyOption(current.proxy.trim()) },
        args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
      })
      const page = await browser.newPage({
        locale: LOCALES[market.toUpperCase()] ?? 'en-GB',
        viewport: { width: 1280, height: 900 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
      })
      await page.goto(serpUrl(keyword, market), { waitUntil: 'domcontentloaded', timeout: current.timeoutMs })
      await page.waitForTimeout(2500)
      return await page.evaluate(`${EXTRACT_SERP}(document)`)
    } finally {
      signal.removeEventListener('abort', onAbort)
      await browser?.close().catch(() => undefined)
    }
  }
}
