/**
 * The rules a keyword must pass before a tool is built for it, decided in
 * code from the evidence the tools gathered, never from the model's say-so:
 * real demand (autocomplete, and Keyword Planner volume when the SEO
 * employee's access is available), a first page with room (no Google
 * answer widget, not owned by big sites), an evergreen query, and an
 * audience worth advertising to. Also the publishing pace, the owner's
 * approval replies, and the weekly schedule.
 */

import type { SerpVerdict } from './serp.ts'

/** Tier-1 advertising markets: the highest display-ad RPMs. */
export const TIER1 = new Set(['US', 'GB', 'CA', 'AU', 'NZ', 'IE', 'DE', 'NL', 'SE', 'NO', 'DK', 'CH', 'AT', 'BE', 'FI', 'LU'])
/** Tier-2 markets: roughly half of tier 1. */
export const TIER2 = new Set(['FR', 'ES', 'IT', 'PT', 'JP', 'KR', 'SG', 'HK', 'TW', 'AE', 'SA', 'QA', 'KW', 'BH', 'OM', 'IL', 'PL', 'CZ', 'MY'])

/** A tool niche's advertiser value. */
export type Niche = 'finance' | 'tax-legal' | 'islamic-finance' | 'health' | 'property' | 'business' | 'education' | 'utility' | 'dates-time'

/**
 * Estimated page RPM (US dollars per 1,000 page views, all ads on a page) for display ads on a tool page with a tier-1
 * audience. Tool pages earn less than articles: visitors use the tool and leave. These are planning estimates from
 * public publisher reports, not quotes; the employee labels them as such.
 */
export const NICHE_RPM: Record<Niche, { rpm: [number, number]; label: string }> = {
  'finance': { rpm: [12, 30], label: 'personal finance (loans, savings, pensions)' },
  'tax-legal': { rpm: [10, 28], label: 'tax, legal and insurance' },
  'islamic-finance': { rpm: [6, 15], label: 'Islamic finance (zakat, inheritance, halal investing)' },
  'property': { rpm: [10, 25], label: 'property and mortgages' },
  'business': { rpm: [8, 20], label: 'business and accounting' },
  'health': { rpm: [5, 14], label: 'health and fitness' },
  'education': { rpm: [3, 8], label: 'education and study' },
  'utility': { rpm: [2, 7], label: 'general converters and utilities' },
  'dates-time': { rpm: [1.5, 5], label: 'dates, time and calendars' },
}

/**
 * How much an audience's countries earn against tier 1.
 * @param markets - two-letter codes; the first is the main audience.
 * @returns the factor and the tier of the main market.
 */
export function marketFactor(markets: readonly string[]): { factor: number; tier: 1 | 2 | 3 } {
  const main = (markets[0] ?? '').toUpperCase()
  const tier = TIER1.has(main) ? 1 : TIER2.has(main) ? 2 : 3
  return { factor: tier === 1 ? 1 : tier === 2 ? 0.5 : 0.15, tier }
}

/**
 * The RPM band for a niche and audience.
 * @param niche - the niche.
 * @param markets - the audience's countries.
 * @returns low and high, US dollars, rounded to 50 cents.
 */
export function rpmBand(niche: Niche, markets: readonly string[]): [number, number] {
  const { factor } = marketFactor(markets)
  const round = (n: number): number => Math.max(0.5, Math.round(n * factor * 2) / 2)
  return [round(NICHE_RPM[niche].rpm[0]), round(NICHE_RPM[niche].rpm[1])]
}

/**
 * The band as text.
 * @param band - low and high.
 * @returns for example `$6–15`.
 */
export function rpmText(band: readonly [number, number]): string {
  const f = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(1))
  return `$${f(band[0])}–${f(band[1])}`
}

/** Words that tie a query to a moment rather than a lasting need. */
const SPIKE = new RegExp(String.raw`\b(?:today|tonight|live|latest|news|breaking|this week|election|results?|score|fixtures?|vs\.?|`
  + String.raw`release date|countdown to|black friday|cyber monday)\b`, 'iu')

/**
 * Why a keyword looks like a passing spike rather than an evergreen need.
 * @param keyword - the keyword.
 * @param year - the current year.
 * @returns the reason, or undefined when nothing in the wording says so.
 */
export function spikeReason(keyword: string, year: number): string | undefined {
  const text = keyword.toLowerCase()
  const years = [...text.matchAll(/\b(20\d\d)\b/gu)].map(m => Number(m[1]))
  if (years.some(y => y < year)) return `it names a past year (${String(years.find(y => y < year))}): its searches are fading`
  if (years.length > 0) return 'it names a year: target the lasting phrase and keep the year in the title instead'
  const spike = SPIKE.exec(text)
  return spike === null ? undefined : `"${spike[0]}" ties it to news or an event`
}

/** Demand evidence for a keyword. */
export interface DemandEvidence {
  /** Google autocomplete suggestions for the keyword and its variants. */
  suggestions: string[]
  /** Keyword Planner's average monthly searches, when the SEO employee's access answered. */
  volume?: number
}

/**
 * Judge demand. Autocomplete only suggests phrases enough people type, so the keyword (or a longer phrase starting
 * with it) appearing there is evidence of searches; Keyword Planner's volume, when known, decides.
 * @param keyword - the keyword.
 * @param evidence - suggestions and volume.
 * @returns the score out of 10 and the reasons; a score of 0 fails the gate.
 */
export function demandScore(keyword: string, evidence: DemandEvidence): { score: number; reasons: string[]; failed?: string } {
  const key = keyword.trim().toLowerCase()
  const words = key.split(/\s+/u).filter(w => w.length > 2)
  const exact = evidence.suggestions.some(s => s === key || s.startsWith(`${key} `))
  const related = evidence.suggestions.filter(s => words.filter(w => s.includes(w)).length >= Math.min(2, words.length)).length
  const reasons: string[] = []
  if (evidence.volume !== undefined) {
    if (evidence.volume < 30) return { score: 0, reasons: [`Keyword Planner: about ${String(evidence.volume)} searches a month.`], failed: 'almost nobody searches it (under 30 a month)' }
    reasons.push(`Keyword Planner: about ${String(evidence.volume)} searches a month.`)
  }
  if (!exact && evidence.volume === undefined) {
    return { score: 0, reasons: [`Google autocomplete does not suggest "${key}" (${String(related)} related suggestions).`], failed: 'no evidence anyone types it: Google autocomplete does not suggest it' }
  }
  if (exact) reasons.push(`Google autocomplete suggests it, with ${String(related)} related phrasings.`)
  let score = exact ? 4 : 2
  score += Math.min(3, related / 4)
  if (evidence.volume !== undefined) score += evidence.volume >= 5000 ? 3 : evidence.volume >= 1000 ? 2.5 : evidence.volume >= 300 ? 2 : 1
  return { score: Math.round(Math.min(10, score) * 10) / 10, reasons }
}

/** What the gate weighs for one keyword. */
export interface GateInput {
  keyword: string
  demand: DemandEvidence
  serp: SerpVerdict | undefined
  /** When the first page was read; older than the cache window does not count. */
  serpAt: string | undefined
  /** The model's judgement that the need lasts, with its reason. */
  evergreen: { lasting: boolean; why: string }
  niche: Niche
  markets: string[]
  /** What the tool will do better than the first page. */
  differentiator: string
  now: Date
  serpMaxAgeDays: number
}

/** The gate's decision. */
export interface GateResult {
  pass: boolean
  /** Out of 100, for ranking candidates that pass. */
  score: number
  /** 1 (easy) to 10 (hard). */
  difficulty: number
  rpm: [number, number]
  tier: 1 | 2 | 3
  reasons: string[]
  failures: string[]
}

/**
 * Decide whether a tool may be proposed for a keyword.
 * @param input - the evidence.
 * @returns pass or fail, with the score, difficulty, RPM band and every reason.
 */
export function keywordGate(input: GateInput): GateResult {
  const failures: string[] = []
  const reasons: string[] = []
  const demand = demandScore(input.keyword, input.demand)
  reasons.push(...demand.reasons)
  if (demand.failed !== undefined) failures.push(`Demand: ${demand.failed}.`)
  const serp = input.serp
  const fresh = input.serpAt !== undefined && input.now.getTime() - Date.parse(input.serpAt) <= input.serpMaxAgeDays * 86_400_000
  if (serp === undefined || !fresh) failures.push('First page: not inspected in the last two weeks; run tools_inspect_serp first.')
  else if (serp.verdict === 'reject') failures.push(`First page: ${serp.reasons[0] ?? 'Google answers it itself.'}`)
  else if (serp.verdict === 'unknown') failures.push('First page: could not be read (robot check); try again later.')
  else if (serp.verdict === 'hard') failures.push(`First page: big sites own it (room ${String(serp.room)}/10): ${serp.reasons.join(' ')}`)
  else reasons.push(`First page ${serp.verdict} (room ${String(serp.room)}/10): ${serp.reasons.join(' ')}`)
  const spike = spikeReason(input.keyword, input.now.getUTCFullYear())
  if (!input.evergreen.lasting) failures.push(`Evergreen: ${input.evergreen.why || 'judged a passing spike'}.`)
  else if (spike !== undefined && spike.includes('past year')) failures.push(`Evergreen: ${spike}.`)
  else if (spike !== undefined) reasons.push(`Evergreen check: ${spike}.`)
  else reasons.push(`Evergreen: ${input.evergreen.why}`)
  const { tier } = marketFactor(input.markets)
  const rpm = rpmBand(input.niche, input.markets)
  if (tier === 3) failures.push(`Audience: ${input.markets[0] ?? '?'} is a low-RPM market; target tier-1 or tier-2 searchers.`)
  reasons.push(`Audience ${input.markets.join(', ')} (tier ${String(tier)}): ${NICHE_RPM[input.niche].label}, estimated page RPM ${rpmText(rpm)}.`)
  if (input.differentiator.trim().length < 40) failures.push('Better than page one: say what this tool adds that the top results lack (40+ characters).')
  const room = serp?.room ?? 0
  const difficulty = Math.round(Math.min(10, Math.max(1, 10 - room + (serp?.strong ?? 0) * 0.3)))
  const value = ((rpm[0] + rpm[1]) / 2) / 21 * 10
  const score = Math.round((demand.score * 0.35 + room * 0.35 + Math.min(10, value) * 0.2 + (tier === 1 ? 10 : 6) * 0.1) * 10)
  return { pass: failures.length === 0, score, difficulty, rpm, tier, reasons, failures }
}

/**
 * The ISO week a date falls in, in a time zone.
 * @param at - the instant.
 * @param timeZone - an IANA zone.
 * @returns for example `2026-W40`.
 */
export function isoWeek(at: Date, timeZone: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(at).map(p => [p.type, p.value]))
  const date = new Date(Date.UTC(Number(parts['year']), Number(parts['month']) - 1, Number(parts['day'])))
  const day = date.getUTCDay() === 0 ? 7 : date.getUTCDay()
  date.setUTCDate(date.getUTCDate() + 4 - day)
  const first = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((date.getTime() - first.getTime()) / 86_400_000 + 1) / 7)
  return `${String(date.getUTCFullYear())}-W${String(week).padStart(2, '0')}`
}

/** Hard ceiling on new tools a week, whatever the setting says (Google's scaled-content-abuse policy). */
export const MAX_TOOLS_PER_WEEK = 5

/**
 * Why a new tool may not be published now.
 * @param publishedAt - when each non-seed tool was first published.
 * @param now - the instant.
 * @param timeZone - the owner's time zone.
 * @param perWeek - the setting.
 * @returns the refusal, or undefined.
 */
export function paceRefusal(publishedAt: readonly string[], now: Date, timeZone: string, perWeek: number): string | undefined {
  const limit = Math.max(0, Math.min(MAX_TOOLS_PER_WEEK, perWeek))
  const week = isoWeek(now, timeZone)
  const count = publishedAt.filter(at => isoWeek(new Date(at), timeZone) === week).length
  if (count < limit) return undefined
  return `${String(count)} new tools are already published this week (${week}); the limit is ${String(limit)} a week so the site grows at a pace Google trusts. It goes out next week.`
}

/** The owner's decision on a shortlist. */
export type ApprovalReply = { kind: 'some'; numbers: number[] } | { kind: 'all' } | { kind: 'none' }

/**
 * Read an approval reply such as `build 1,3`, `build 2 and 4`, `build all` or `build none`, optionally after the
 * shortlist's tag (`#t1a2b build 1`).
 * @param text - the message.
 * @param tag - the shortlist's tag.
 * @param size - how many items the shortlist has.
 * @returns the decision, or undefined when the message is not one.
 */
export function parseApproval(text: string, tag: string, size: number): ApprovalReply | undefined {
  let body = text.trim().toLowerCase()
  if (body.startsWith(tag.toLowerCase())) body = body.slice(tag.length).trim()
  const match = /^(?:build|approve)\s*[:,-]?\s*(.+)$/u.exec(body)
  if (match === null) return undefined
  const rest = (match[1] ?? '').trim().replace(/[.!]+$/u, '')
  if (/^(?:all|everything)$/u.test(rest)) return { kind: 'all' }
  if (/^(?:none|nothing|0)$/u.test(rest)) return { kind: 'none' }
  if (!/^[\d\s,&+]+(?:and[\d\s,&+]+)*$/u.test(rest)) return undefined
  const numbers = [...new Set([...rest.matchAll(/\d+/gu)].map(m => Number(m[0])))].filter(n => n >= 1 && n <= size).sort((a, b) => a - b)
  return numbers.length === 0 ? undefined : { kind: 'some', numbers }
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const

/**
 * Read a weekday setting.
 * @param value - `monday`, `Mon`, …
 * @returns 0 for Sunday to 6, or undefined.
 */
export function parseWeekday(value: string): number | undefined {
  const text = value.trim().toLowerCase()
  if (text.length < 3) return undefined
  const index = WEEKDAYS.findIndex(day => day.startsWith(text))
  return index < 0 ? undefined : index
}

function addDays(date: string, days: number): string {
  const at = new Date(`${date}T00:00:00Z`)
  at.setUTCDate(at.getUTCDate() + days)
  return at.toISOString().slice(0, 10)
}

/**
 * Whether this week's shift is due: the latest weekly slot has passed and no scheduled shift started on or after it.
 * @param now - the local date and minute.
 * @param weekday - 0 for Sunday to 6.
 * @param minutes - the start, minutes since midnight.
 * @param lastShiftDate - the local date the last scheduled shift started.
 * @returns whether to start one now.
 */
export function weeklyDue(now: { date: string; minutes: number }, weekday: number, minutes: number, lastShiftDate: string | null): boolean {
  const today = new Date(`${now.date}T00:00:00Z`).getUTCDay()
  let back = (today - weekday + 7) % 7
  if (back === 0 && now.minutes < minutes) back = 7
  return lastShiftDate === null || lastShiftDate < addDays(now.date, -back)
}

/**
 * Why a new run may not start yet.
 * @param now - epoch milliseconds.
 * @param lastStart - epoch milliseconds of the last start, 0 for never.
 * @param gapMs - the shortest time between two starts.
 * @returns the refusal, or undefined.
 */
export function runNowRefusal(now: number, lastStart: number, gapMs: number): string | undefined {
  const wait = lastStart + gapMs - now
  if (lastStart <= 0 || wait <= 0) return undefined
  return `a run started ${String(Math.max(1, Math.round((now - lastStart) / 60_000)))} minutes ago and is still working; try again in ${String(Math.ceil(wait / 60_000))} minutes`
}
