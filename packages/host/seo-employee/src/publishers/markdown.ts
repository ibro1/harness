/**
 * A Markdown-to-HTML converter for the subset article drafts use. Every
 * character of input that is not recognised Markdown syntax is HTML-escaped, so
 * raw HTML in a draft renders as text; link and image targets are limited to
 * `http:`, `https:` and relative URLs.
 *
 * Supported: `#`–`####` headings (`#` renders as `<h2>`, since the page title is
 * the `<h1>`; `#####` and deeper render as `<h4>`), paragraphs, `**bold**`,
 * `__bold__`, `*italic*`, `_italic_`, `` `code` ``, fenced code, links,
 * images, unordered and ordered lists with one level of nesting, blockquotes,
 * horizontal rules, backslash escapes, and the Klipara clip line `::clip[<id>]`.
 */

/** Options for {@link markdownToHtml}. */
export interface MarkdownOptions {
  /**
   * The page a `::clip[<id>]` line links to, or undefined to render the line as
   * text. Called only for ids of letters, digits, `-` and `_`.
   */
  clipUrl?: (id: string) => string
  /** The site's own origin, for example `https://linkfa.de`; links to it carry no `rel`. */
  siteOrigin?: string
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }

/**
 * Escape text for an HTML element body or a double-quoted attribute.
 * @param value - the raw text.
 * @returns the escaped text.
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, c => ESCAPES[c] ?? c)
}

/** Blockquotes nest at most this deep; deeper `>` markers render as text. */
const MAX_QUOTE_DEPTH = 3
const CLIP_LINE = /^::clip\[([A-Za-z0-9_-]+)\]\s*$/u
const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+-]*)\s*$/u
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/u
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/u
const QUOTE = /^ {0,3}>\s?(.*)$/u
const ITEM = /^( *)([-*+]|\d{1,9}[.)])\s+(.*)$/u

/**
 * Accept a link or image target: absolute `http:`/`https:`, or relative
 * (`/path`, `#frag`, `./x`, `page`). Everything else, including other schemes,
 * protocol-relative `//host`, and targets with whitespace or control characters, is refused.
 * @param raw - the target as written.
 * @returns the target, or undefined when refused.
 */
export function safeUrl(raw: string): string | undefined {
  const url = raw.trim()
  const control = Array.from(url).some(ch => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7F)
  if (url === '' || control || /[\s<>"`\\]/u.test(url)) return undefined
  if (/^https?:\/\/[^/]/iu.test(url)) return url
  if (url.startsWith('//')) return undefined
  const colon = url.indexOf(':')
  if (colon === -1) return url
  const firstDelimiter = url.search(/[/?#]/u)
  return firstDelimiter !== -1 && firstDelimiter < colon ? url : undefined
}

/** Find the closing `)` of a link target, allowing one level of balanced parentheses. */
function closeParen(s: string, from: number): number {
  let depth = 0
  for (let i = from; i < s.length; i++) {
    const c = s[i]
    if (c === '\\') i++
    else if (c === '(') depth++
    else if (c === ')') {
      if (depth === 0) return i
      depth--
    }
  }
  return -1
}

/** Find the `]` closing a link label that starts after `from`, skipping escaped and nested brackets. */
function closeBracket(s: string, from: number): number {
  let depth = 0
  for (let i = from; i < s.length; i++) {
    const c = s[i]
    if (c === '\\') i++
    else if (c === '[') depth++
    else if (c === ']') {
      if (depth === 0) return i
      depth--
    }
  }
  return -1
}

/** Split `url "title"` into the target; the title is dropped. */
function linkTarget(inside: string): string {
  return inside.trim().replace(/\s+(?:"[^"]*"|'[^']*')$/u, '')
}

/** Render inline Markdown. `inLink` stops links nesting inside link text. */
function inline(s: string, options: MarkdownOptions, inLink: boolean): string {
  let out = ''
  let i = 0
  while (i < s.length) {
    const c = s[i] ?? ''
    if (c === '\\' && i + 1 < s.length && /[!-/:-@[-`{-~]/u.test(s[i + 1] ?? '')) {
      out += escapeHtml(s[i + 1] ?? '')
      i += 2
      continue
    }
    if (c === '`') {
      const run = /^`+/u.exec(s.slice(i))?.[0] ?? '`'
      const end = s.indexOf(run, i + run.length)
      if (end !== -1) {
        out += `<code>${escapeHtml(s.slice(i + run.length, end).trim())}</code>`
        i = end + run.length
        continue
      }
      out += escapeHtml(run)
      i += run.length
      continue
    }
    const isImage = c === '!' && s[i + 1] === '['
    if ((isImage || c === '[') && !inLink) {
      const labelStart = i + (isImage ? 2 : 1)
      const labelEnd = closeBracket(s, labelStart)
      if (labelEnd !== -1 && s[labelEnd + 1] === '(') {
        const targetEnd = closeParen(s, labelEnd + 2)
        if (targetEnd !== -1) {
          const label = s.slice(labelStart, labelEnd)
          const url = safeUrl(linkTarget(s.slice(labelEnd + 2, targetEnd)))
          out += isImage ? image(label, url) : link(label, url, options)
          i = targetEnd + 1
          continue
        }
      }
    }
    const emphasis = emphasisAt(s, i)
    if (emphasis !== undefined) {
      const tag = emphasis.marker.length === 2 ? 'strong' : 'em'
      out += `<${tag}>${inline(emphasis.content, options, inLink)}</${tag}>`
      i = emphasis.end
      continue
    }
    out += escapeHtml(c)
    i++
  }
  return out
}

/** Render an image, or its alt text when the target was refused. */
function image(alt: string, url: string | undefined): string {
  const plain = alt.replace(/\\(.)/gu, '$1')
  if (url === undefined) return escapeHtml(plain)
  return `<img src="${escapeHtml(url)}" alt="${escapeHtml(plain)}" loading="lazy">`
}

/** Render a link, or only its text when the target was refused. */
function link(label: string, url: string | undefined, options: MarkdownOptions): string {
  const body = inline(label, options, true)
  if (url === undefined) return body
  const external = /^https?:\/\//iu.test(url) && !(options.siteOrigin !== undefined && sameOrigin(url, options.siteOrigin))
  return `<a href="${escapeHtml(url)}"${external ? ' rel="noopener"' : ''}>${body}</a>`
}

/** Whether an absolute URL is on the given origin. */
function sameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === new URL(origin).origin
  } catch {
    // TypeError: an unparsable URL or origin is treated as external.
    return false
  }
}

/** Find emphasis opening at `i`: `**x**`, `__x__`, `*x*`, or `_x_` (underscores only at word edges). */
function emphasisAt(s: string, i: number): { marker: string; content: string; end: number } | undefined {
  const c = s[i]
  if (c !== '*' && c !== '_') return undefined
  const marker = s[i + 1] === c ? c + c : c
  if (c === '_' && i > 0 && /[\p{L}\p{N}]/u.test(s[i - 1] ?? '')) return undefined
  const start = i + marker.length
  if (start >= s.length || /\s/u.test(s[start] ?? '')) return undefined
  let close = s.indexOf(marker, start)
  while (close !== -1) {
    const inner = s.slice(start, close)
    const afterOk = c !== '_' || !/[\p{L}\p{N}]/u.test(s[close + marker.length] ?? '')
    const singleOk = marker.length === 2 || s[close + 1] !== c
    if (inner !== '' && !/\s$/u.test(inner) && afterOk && singleOk) return { marker, content: inner, end: close + marker.length }
    close = s.indexOf(marker, close + (marker.length === 2 ? 1 : 2))
  }
  return undefined
}

/** One list item: its own text lines and a nested list's lines. */
interface ListItem {
  lines: string[]
  nested: string[]
}

/** Render a list starting at `lines[start]`; returns the HTML and the index after it. */
function list(lines: readonly string[], start: number, options: MarkdownOptions, nestable: boolean): { html: string; next: number } {
  const first = ITEM.exec(lines[start] ?? '')
  const indent = first?.[1]?.length ?? 0
  const ordered = /\d/u.test(first?.[2] ?? '')
  const items: ListItem[] = []
  let i = start
  for (; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (line.trim() === '') {
      const next = lines[i + 1] ?? ''
      const continues = ITEM.exec(next)
      if (continues !== null && (continues[1]?.length ?? 0) >= indent && /\d/u.test(continues[2] ?? '') === ordered) continue
      break
    }
    const match = ITEM.exec(line)
    const level = match?.[1]?.length ?? 0
    if (match !== null && level <= indent + 1) {
      if (/\d/u.test(match[2] ?? '') !== ordered) break
      items.push({ lines: [match[3] ?? ''], nested: [] })
      continue
    }
    const current = items.at(-1)
    if (current === undefined) break
    if (match !== null && level >= indent + 2) {
      current.nested.push(line.slice(indent + 2))
      continue
    }
    if (/^\s+\S/u.test(line) || !startsBlock(line)) {
      if (current.nested.length > 0) current.nested.push(line.slice(Math.min(indent + 2, line.search(/\S/u))))
      else current.lines.push(line.trim())
      continue
    }
    break
  }
  const startNumber = ordered ? Number.parseInt(first?.[2] ?? '1', 10) : 1
  const tag = ordered ? 'ol' : 'ul'
  const open = ordered && startNumber !== 1 ? `<ol start="${String(startNumber)}">` : `<${tag}>`
  const body = items.map((item) => {
    const own = inline(item.lines.join(' '), options, false)
    if (item.nested.length === 0) return `<li>${own}</li>`
    const sub = nestable && ITEM.test(item.nested[0] ?? '')
      ? list(item.nested, 0, options, false).html
      : escapeHtml(item.nested.join(' '))
    return `<li>${own}${sub}</li>`
  }).join('')
  return { html: `${open}${body}</${tag}>`, next: i }
}

/** Whether a line opens a block other than a paragraph. */
function startsBlock(line: string): boolean {
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || /^ {0,3}([-*+]|\d{1,9}[.)])\s+\S/u.test(line)
}

/** Render a sequence of block lines. */
function blocks(lines: readonly string[], options: MarkdownOptions, quoteDepth: number): string[] {
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    if (line.trim() === '') {
      i++
      continue
    }
    const fence = FENCE.exec(line)
    if (fence !== null) {
      const marker = fence[1] ?? '```'
      const body: string[] = []
      i++
      while (i < lines.length && !(lines[i] ?? '').trimStart().startsWith(marker)) body.push(lines[i++] ?? '')
      i++
      const lang = fence[2] ?? ''
      const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`
      out.push(`<pre><code${cls}>${escapeHtml(body.join('\n'))}</code></pre>`)
      continue
    }
    const clip = CLIP_LINE.exec(line.trim())
    if (clip !== null && options.clipUrl !== undefined) {
      const href = safeUrl(options.clipUrl(clip[1] ?? ''))
      if (href !== undefined) {
        out.push(`<p><a href="${escapeHtml(href)}">Watch the clip</a></p>`)
        i++
        continue
      }
    }
    const heading = HEADING.exec(line)
    if (heading !== null) {
      const level = Math.min(Math.max((heading[1] ?? '').length, 2), 4)
      out.push(`<h${String(level)}>${inline(heading[2] ?? '', options, false)}</h${String(level)}>`)
      i++
      continue
    }
    if (RULE.test(line)) {
      out.push('<hr>')
      i++
      continue
    }
    if (QUOTE.test(line) && quoteDepth < MAX_QUOTE_DEPTH) {
      const inner: string[] = []
      while (i < lines.length && QUOTE.test(lines[i] ?? '')) inner.push(QUOTE.exec(lines[i++] ?? '')?.[1] ?? '')
      out.push(`<blockquote>${blocks(inner, options, quoteDepth + 1).join('')}</blockquote>`)
      continue
    }
    if (/^ {0,3}([-*+]|\d{1,9}[.)])\s+\S/u.test(line)) {
      const rendered = list(lines, i, options, true)
      out.push(rendered.html)
      i = rendered.next
      continue
    }
    const para: string[] = [line.trim()]
    i++
    while (i < lines.length && (lines[i] ?? '').trim() !== '' && !startsBlock(lines[i] ?? '')) para.push((lines[i++] ?? '').trim())
    out.push(`<p>${inline(para.join(' '), options, false)}</p>`)
  }
  return out
}

/**
 * Convert draft Markdown to HTML. The result contains only `h2`–`h4`, `p`,
 * `strong`, `em`, `code`, `pre`, `a`, `img`, `ul`, `ol`, `li`, `blockquote`
 * and `hr` elements; all other input is escaped text.
 * @param md - the Markdown.
 * @param options - clip links and the site origin.
 * @returns the HTML, blocks separated by newlines.
 */
export function markdownToHtml(md: string, options: MarkdownOptions = {}): string {
  return blocks(md.replace(/\r\n?/gu, '\n').split('\n'), options, 0).join('\n')
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': '\'' }

/**
 * Convert draft Markdown to plain text for word counts: markup, fenced code,
 * images and clip lines are dropped; link text is kept.
 * @param md - the Markdown.
 * @returns the text, one line per block.
 */
export function markdownToText(md: string): string {
  return markdownToHtml(md)
    .replace(/<pre>[\s\S]*?<\/pre>/gu, '')
    .replace(/^<p>::clip\[[A-Za-z0-9_-]+\]<\/p>$/gmu, '')
    .replace(/<\/(?:p|h[2-4]|li|blockquote)>/gu, '\n')
    .replace(/<[^>]*>/gu, '')
    .replace(/&(?:amp|lt|gt|quot|#39);/gu, e => ENTITIES[e] ?? e)
    .split('\n').map(l => l.trim()).filter(l => l !== '').join('\n')
}
