/**
 * The code-enforced checks an article draft passes before it is published.
 * Articles auto-publish, so this is the last gate: every problem names the
 * field and says in plain words what to change, and the writer revises until
 * the list is empty.
 */

import type { ArticleDraft, RemoteArticle } from '../types.ts'
import { articleStyleProblems, wordCount } from './style.ts'

export { wordCount }

/** Where a draft problem is. */
export type DraftField =
  | 'slug' | 'title' | 'metaTitle' | 'metaDescription' | 'dek' | 'body' | 'tags' | 'faq' | 'sources' | 'cover'

/** One reason a draft cannot be published yet. */
export interface DraftProblem {
  field: DraftField
  /** Stable rule id, for example `slug-taken` or `style:long-dash`. */
  rule: string
  /** What is wrong and what to do, in plain words. */
  reason: string
}

/** What the draft checks need to know about the site. */
export interface DraftContext {
  /** The site's public origin, for example `https://klipara.linkfa.de`. */
  siteBaseUrl: string
  /** Every article on the site; slugs must not collide, and published URLs count as known internal links. */
  existing: RemoteArticle[]
  /** Known live URLs on the site, absolute or root-relative; internal links must point at one of these. */
  internalUrls: string[]
  /** When the draft revises an existing article, its id, so the article's own slug does not count as taken. */
  updatingId?: string
  /** Fewest body words; default {@link DEFAULT_MIN_WORDS}. */
  minWords?: number
  /** Most body words; default {@link DEFAULT_MAX_WORDS}. */
  maxWords?: number
  /** Phrases the site's voice forbids, matched case-insensitively anywhere in the article. */
  bannedPhrases?: string[]
  /** Whether the body must embed at least one `::clip[id]` line. */
  requireClip?: boolean
}

/** Default fewest body words. */
export const DEFAULT_MIN_WORDS = 900
/** Default most body words. */
export const DEFAULT_MAX_WORDS = 3500
/** Most characters in a slug. */
export const MAX_SLUG = 70
/** Most characters in a title. */
export const MAX_TITLE = 70
/** Most characters in a meta title. */
export const MAX_META_TITLE = 60
/** Fewest characters in a meta description. */
export const MIN_META_DESCRIPTION = 70
/** Most characters in a meta description. */
export const MAX_META_DESCRIPTION = 160
/** Most characters in a dek. */
export const MAX_DEK = 160
/** Fewest H2 sections in a body. */
export const MIN_H2 = 3
/** Fewest distinct known internal links in a body. */
export const MIN_INTERNAL_LINKS = 2
/** FAQ size when present: none, or between these. */
export const FAQ_ITEMS = { min: 3, max: 6 } as const
/** Words in each FAQ answer. */
export const FAQ_ANSWER_WORDS = { min: 30, max: 80 } as const
/** Number of tags. */
export const TAGS = { min: 1, max: 5 } as const

const CLIP_LINE = /^::clip\[[A-Za-z0-9_-]{6,40}\]$/u
const STATISTIC = /\d\s?%|\bper ?cent\b|[$\u20ac\u00a3\u20a6]\s?\d|\b(?:million|billion|trillion)\b/iu
const SHOUT_WORDS = /\b(?:FREE|NOW|BEST|NEVER|ALWAYS|MUST|SHOCKING|INSANE|HUGE|SECRET|STOP|WARNING|AMAZING|ULTIMATE|EVER)\b/u
const CLICKBAIT = new RegExp([
  String.raw`\byou won'?t believe\b`,
  String.raw`\bwill (?:shock|blow) you\b`,
  String.raw`\bwhat happen(?:s|ed) next\b`,
  String.raw`\bthis one (?:simple )?trick\b`,
  String.raw`\bhates? (?:him|her|this)\b`,
].join('|'), 'iu')

interface Link {
  url: string
  image: boolean
}

function withoutCode(markdown: string): string {
  return markdown
    .replace(/\r\n?/gu, '\n')
    .replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$/gmu, '')
    .replace(/^(?:`{3,}|~{3,})[\s\S]*$/mu, '')
    .replace(/`[^`\n]*`/gu, '')
}

function linksIn(markdown: string): Link[] {
  const links: Link[] = []
  for (const m of markdown.matchAll(/(!?)\[[^\]]*\]\(\s*<?([^\s)>]+)>?(?:\s+"[^"]*")?\s*\)/gu)) {
    links.push({ url: m[2] ?? '', image: m[1] === '!' })
  }
  for (const m of markdown.matchAll(/<((?:https?|mailto):[^>\s]+)>/giu)) links.push({ url: m[1] ?? '', image: false })
  return links
}

function parse(url: string, base?: string): URL | undefined {
  try {
    return new URL(url, base)
  } catch {
    // TypeError: not a URL; callers report it as an invalid link.
    return undefined
  }
}

/** `protocol//host/path` with no query, fragment, or trailing slash. */
function key(url: URL): string {
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/u, '')}`
}

/** {@link key} of a URL resolved against the site; undefined when it does not parse. */
function normalise(url: string, base: string): string | undefined {
  const parsed = parse(url, base)
  return parsed && key(parsed)
}

function lengthProblem(field: DraftField, value: string, label: string, min: number, max: number): DraftProblem[] {
  const n = Array.from(value.trim()).length
  let reason: string | undefined
  if (n === 0) return [{ field, rule: `${field}-missing`, reason: `The ${label} is empty.` }]
  if (n < min) reason = `The ${label} is ${String(n)} characters; make it at least ${String(min)}.`
  if (n > max) reason = `The ${label} is ${String(n)} characters; cut it to ${String(max)} or fewer.`
  return reason === undefined ? [] : [{ field, rule: `${field}-length`, reason }]
}

function slugProblems(draft: ArticleDraft, ctx: DraftContext): DraftProblem[] {
  const problems: DraftProblem[] = []
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(draft.slug)) {
    problems.push({ field: 'slug', rule: 'slug-format', reason: 'The slug must be lowercase letters and digits joined by single hyphens.' })
  }
  if (draft.slug.length > MAX_SLUG) {
    problems.push({
      field: 'slug',
      rule: 'slug-length',
      reason: `The slug is ${String(draft.slug.length)} characters; cut it to ${String(MAX_SLUG)}.`,
    })
  }
  const taken = ctx.existing.find(a => a.slug === draft.slug && a.id !== ctx.updatingId)
  if (taken !== undefined) {
    problems.push({
      field: 'slug',
      rule: 'slug-taken',
      reason: `The slug "${draft.slug}" is already used by "${taken.title}"; choose another.`,
    })
  }
  return problems
}

function titleProblems(title: string): DraftProblem[] {
  const problems = lengthProblem('title', title, 'title', 1, MAX_TITLE)
  const shouting = /\b[A-Z]{4,}\s+[A-Z]{4,}\b/u.test(title) || SHOUT_WORDS.test(title)
  if (shouting || CLICKBAIT.test(title)) {
    problems.push({
      field: 'title',
      rule: 'title-clickbait',
      reason: 'The title reads as clickbait (shouted words or a teaser); say plainly what the article answers.',
    })
  }
  return problems
}

/** Whether a line can carry a setext underline: non-blank text that is not a heading, list item, quote, or rule. */
function isParagraphLine(line: string | undefined): boolean {
  return line !== undefined && /\w/u.test(line) && !/^\s*(?:#|[-*+]\s|\d+[.)]\s|>|[-=]{2,}\s*$)/u.test(line)
}

function headingProblems(body: string): DraftProblem[] {
  const problems: DraftProblem[] = []
  const levels: number[] = []
  const lines = body.split('\n')
  for (const [i, line] of lines.entries()) {
    const atx = /^ {0,3}(#{1,6})(?:\s|$)/u.exec(line)
    if (atx) levels.push(atx[1]?.length ?? 0)
    else if (/^ {0,3}=+\s*$/u.test(line) && isParagraphLine(lines[i - 1])) levels.push(1)
    else if (/^ {0,3}-{2,}\s*$/u.test(line) && isParagraphLine(lines[i - 1])) levels.push(2)
  }
  const h1 = levels.filter(l => l === 1).length
  if (h1 > 0) {
    problems.push({
      field: 'body',
      rule: 'body-h1',
      reason: `The body has ${String(h1)} H1 heading(s); the title is the H1, so start sections at H2.`,
    })
  }
  const h2 = levels.filter(l => l === 2).length
  if (h2 < MIN_H2) {
    problems.push({
      field: 'body',
      rule: 'body-h2-count',
      reason: `The body has ${String(h2)} H2 sections; give it at least ${String(MIN_H2)}.`,
    })
  }
  let previous = 1
  for (const level of levels) {
    if (level > previous + 1) {
      problems.push({
        field: 'body',
        rule: 'body-heading-skip',
        reason: `A heading jumps from H${String(previous)} to H${String(level)}; do not skip heading levels.`,
      })
      break
    }
    previous = level
  }
  return problems
}

function linkProblems(body: string, draft: ArticleDraft, ctx: DraftContext): DraftProblem[] {
  const problems: DraftProblem[] = []
  const siteOrigin = parse(ctx.siteBaseUrl)?.origin
  const known = new Set<string>()
  for (const url of [...ctx.internalUrls, ...ctx.existing.filter(a => a.status === 'published').map(a => a.url)]) {
    const n = normalise(url, ctx.siteBaseUrl)
    if (n !== undefined) known.add(n)
  }
  const internalHits = new Set<string>()
  const linked = new Set<string>()
  for (const link of linksIn(body)) {
    if (link.url.startsWith('#') || /^mailto:/iu.test(link.url)) continue
    const absolute = /^[a-z][a-z0-9+.-]*:/iu.test(link.url) || link.url.startsWith('//')
    if (!absolute && !link.url.startsWith('/')) {
      problems.push({
        field: 'body',
        rule: 'link-relative',
        reason: `The link "${link.url}" is relative; use a full https URL or a path starting with "/".`,
      })
      continue
    }
    const parsed = parse(link.url, ctx.siteBaseUrl)
    if (parsed === undefined) {
      problems.push({ field: 'body', rule: 'link-invalid', reason: `The link "${link.url}" is not a valid URL.` })
      continue
    }
    const target = key(parsed)
    linked.add(target)
    const internal = !absolute || parsed.origin === siteOrigin
    if (internal) {
      if (link.image) continue
      if (known.has(target)) internalHits.add(target)
      else {
        problems.push({
          field: 'body',
          rule: 'link-unknown-internal',
          reason: `The internal link "${link.url}" is not a page on the site; link only to pages from the site's list.`,
        })
      }
    } else if (!/^https:/iu.test(link.url)) {
      problems.push({
        field: 'body',
        rule: 'link-not-https',
        reason: `The external link "${link.url}" is not https; use the https address.`,
      })
    }
  }
  if (internalHits.size < MIN_INTERNAL_LINKS) {
    problems.push({
      field: 'body',
      rule: 'internal-links',
      reason: `The body links to ${String(internalHits.size)} known page(s) on the site; link to at least ${String(MIN_INTERNAL_LINKS)}.`,
    })
  }
  problems.push(...sourceProblems(body, draft, linked, ctx.siteBaseUrl))
  return problems
}

function sourceProblems(body: string, draft: ArticleDraft, linked: ReadonlySet<string>, base: string): DraftProblem[] {
  const problems: DraftProblem[] = []
  const stat = STATISTIC.exec(body.replace(/\]\([^)]*\)/gu, ']').replace(/<?\bhttps?:\/\/[^\s)>]+>?/giu, ''))
  if (stat && draft.sources.length === 0) {
    problems.push({
      field: 'sources',
      rule: 'stats-unsourced',
      reason: `The body states figures (for example "${stat[0]}") but lists no sources; cite where each figure comes from, or cut it.`,
    })
  }
  for (const source of draft.sources) {
    if (!/^https:\/\//iu.test(source.url)) {
      problems.push({ field: 'sources', rule: 'source-not-https', reason: `The source "${source.url}" is not an https URL.` })
      continue
    }
    const n = normalise(source.url, base)
    if (n === undefined || !linked.has(n)) {
      problems.push({
        field: 'sources',
        rule: 'source-not-linked',
        reason: `The source "${source.title}" is not linked in the body; link it where its claim is made.`,
      })
    }
  }
  return problems
}

function faqProblems(draft: ArticleDraft): DraftProblem[] {
  const problems: DraftProblem[] = []
  const n = draft.faq.length
  if (n > 0 && (n < FAQ_ITEMS.min || n > FAQ_ITEMS.max)) {
    problems.push({
      field: 'faq',
      rule: 'faq-count',
      reason: `The FAQ has ${String(n)} item(s); give none or ${String(FAQ_ITEMS.min)} to ${String(FAQ_ITEMS.max)}.`,
    })
  }
  for (const [i, item] of draft.faq.entries()) {
    const label = `FAQ ${String(i + 1)}`
    if (item.q.trim() === '') problems.push({ field: 'faq', rule: 'faq-question', reason: `${label} has no question.` })
    const words = wordCount(item.a)
    if (words < FAQ_ANSWER_WORDS.min || words > FAQ_ANSWER_WORDS.max) {
      problems.push({
        field: 'faq',
        rule: 'faq-answer-length',
        reason: `${label}'s answer is ${String(words)} words; make it ${String(FAQ_ANSWER_WORDS.min)} to ${String(FAQ_ANSWER_WORDS.max)}.`,
      })
    }
  }
  return problems
}

function clipProblems(body: string, requireClip: boolean): DraftProblem[] {
  const problems: DraftProblem[] = []
  let clips = 0
  for (const line of body.split('\n')) {
    if (!line.includes('::clip')) continue
    if (CLIP_LINE.test(line.trim())) clips++
    else {
      problems.push({
        field: 'body',
        rule: 'clip-malformed',
        reason: `"${line.trim().slice(0, 80)}" is not a clip line; write ::clip[id] alone on its line, id 6 to 40 of A-Z a-z 0-9 _ -.`,
      })
    }
  }
  if (requireClip && clips === 0) {
    problems.push({ field: 'body', rule: 'clip-missing', reason: 'This site needs at least one Klipara clip; add a ::clip[id] line.' })
  }
  return problems
}

function bannedProblems(draft: ArticleDraft, banned: readonly string[]): DraftProblem[] {
  const fields: [DraftField, string][] = [
    ['title', draft.title], ['metaTitle', draft.metaTitle], ['metaDescription', draft.metaDescription], ['dek', draft.dek],
    ['body', draft.bodyMarkdown], ['faq', draft.faq.map(f => `${f.q}\n${f.a}`).join('\n')],
  ]
  const problems: DraftProblem[] = []
  for (const phrase of banned) {
    const needle = phrase.trim().replace(/\s+/gu, ' ').toLowerCase()
    if (needle === '') continue
    for (const [field, text] of fields) {
      if (!text.replace(/\s+/gu, ' ').toLowerCase().includes(needle)) continue
      problems.push({ field, rule: 'banned-phrase', reason: `"${phrase}" is on the site's list of words to avoid; rephrase.` })
    }
  }
  return problems
}

function styleProblemsFor(field: DraftField, text: string, skip: readonly string[] = []): DraftProblem[] {
  return articleStyleProblems(text)
    .filter(p => !skip.includes(p.rule))
    .map(p => ({ field, rule: `style:${p.rule}`, reason: `${p.fix} Found: "${p.found}".` }))
}

/**
 * Every reason a draft cannot be published yet.
 * @param draft - the article as the writer submitted it.
 * @param ctx - the site's origin, its articles and known URLs, and the site's limits.
 * @returns the problems, each naming its field and what to change; empty when the draft may be published.
 */
export function draftProblems(draft: ArticleDraft, ctx: DraftContext): DraftProblem[] {
  const body = withoutCode(draft.bodyMarkdown)
  const words = wordCount(draft.bodyMarkdown)
  const minWords = ctx.minWords ?? DEFAULT_MIN_WORDS
  const maxWords = ctx.maxWords ?? DEFAULT_MAX_WORDS
  const problems: DraftProblem[] = [
    ...slugProblems(draft, ctx),
    ...titleProblems(draft.title),
    ...lengthProblem('metaTitle', draft.metaTitle, 'meta title', 1, MAX_META_TITLE),
    ...lengthProblem('metaDescription', draft.metaDescription, 'meta description', MIN_META_DESCRIPTION, MAX_META_DESCRIPTION),
    ...lengthProblem('dek', draft.dek, 'dek', 1, MAX_DEK),
  ]
  if (words < minWords) {
    problems.push({
      field: 'body',
      rule: 'body-too-short',
      reason: `The body is ${String(words)} words; write at least ${String(minWords)}.`,
    })
  }
  if (words > maxWords) {
    problems.push({
      field: 'body',
      rule: 'body-too-long',
      reason: `The body is ${String(words)} words; cut it to ${String(maxWords)} or fewer.`,
    })
  }
  const html = /<!--|<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>/u.exec(body)
  if (html) {
    problems.push({
      field: 'body',
      rule: 'body-html',
      reason: `The body contains raw HTML ("${html[0].slice(0, 40)}"); use Markdown only.`,
    })
  }
  problems.push(...headingProblems(body), ...linkProblems(body, draft, ctx), ...faqProblems(draft))
  if (draft.tags.length < TAGS.min || draft.tags.length > TAGS.max || draft.tags.some(t => t.trim() === '')) {
    problems.push({
      field: 'tags',
      rule: 'tags-count',
      reason: `Give ${String(TAGS.min)} to ${String(TAGS.max)} non-empty tags (there are ${String(draft.tags.length)}).`,
    })
  }
  if (draft.coverImageUrl !== undefined && draft.coverImageUrl !== '') {
    if ((draft.coverAlt ?? '').trim() === '') {
      problems.push({ field: 'cover', rule: 'cover-alt', reason: 'The cover image has no alt text; describe what it shows.' })
    }
    if (!/^https:\/\//iu.test(draft.coverImageUrl)) {
      problems.push({ field: 'cover', rule: 'cover-not-https', reason: 'The cover image URL must be https.' })
    }
  }
  problems.push(
    ...clipProblems(draft.bodyMarkdown, ctx.requireClip === true),
    ...bannedProblems(draft, ctx.bannedPhrases ?? []),
    ...styleProblemsFor('title', draft.title, ['rhetorical-question']),
    ...styleProblemsFor('metaDescription', draft.metaDescription),
    ...styleProblemsFor('dek', draft.dek),
    ...draft.faq.flatMap(item => styleProblemsFor('faq', item.a)),
    ...styleProblemsFor('body', draft.bodyMarkdown),
  )
  return problems
}
