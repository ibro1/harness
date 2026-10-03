/**
 * The scout's arithmetic, kept out of the model's hands: which videos and
 * channels count as outliers, the money a niche can make per thousand views
 * (a maintained table), the floor of its policy risk, the weighted niche
 * score, the API key's daily quota, the weekly schedule and the gap between
 * two "Run now" presses.
 */

import type { ChannelInfo, VideoInfo } from './youtube.ts'

const DAY_MS = 86_400_000
const MONTH_DAYS = 30.44

/**
 * How old a channel is.
 * @param createdAt - ISO creation time.
 * @param now - the instant.
 * @returns months, infinite for an unreadable date.
 */
export function ageMonths(createdAt: string, now: Date): number {
  const at = Date.parse(createdAt)
  return Number.isFinite(at) ? Math.max(0, (now.getTime() - at) / DAY_MS / MONTH_DAYS) : Number.POSITIVE_INFINITY
}

/** A channel's shape: age, average views per video and views per month of its life. */
export interface ChannelProfile {
  ageMonths: number
  avgViewsPerVideo: number
  monthlyViews: number
  /** Created within the configured age limit. */
  young: boolean
}

/**
 * Profile a channel.
 * @param channel - the channel.
 * @param now - the instant.
 * @param maxAgeMonths - what counts as young.
 * @returns the profile.
 */
export function channelProfile(channel: ChannelInfo, now: Date, maxAgeMonths = 12): ChannelProfile {
  const months = ageMonths(channel.createdAt, now)
  return {
    ageMonths: months,
    avgViewsPerVideo: channel.videos > 0 ? channel.views / channel.videos : 0,
    monthlyViews: channel.views / Math.max(1, months),
    young: months <= maxAgeMonths,
  }
}

/** How strongly one video outperforms its channel. */
export type OutlierTier = 'strong' | 'moderate' | 'none'

/** One video's outlier reading. */
export interface VideoOutlier {
  /** Views per subscriber (subscribers floored at 1,000); undefined when the channel hides its count. */
  ratio?: number
  /** Views over the channel's average views per video. */
  vsAverage: number
  viewsPerDay: number
  tier: OutlierTier
}

/**
 * Score one video against its channel. Strong: a channel younger than the limit whose video has at least 3× its
 * subscribers in views and 20,000 views. Moderate: a channel under twice the limit with 2× and 10,000 views, or a
 * channel under 100,000 subscribers with 5× and 50,000 views (or, with the count hidden, 5× its average and 50,000).
 * @param video - the video.
 * @param channel - its channel.
 * @param now - the instant.
 * @param maxAgeMonths - what counts as a young channel.
 * @returns the reading.
 */
export function videoOutlier(video: VideoInfo, channel: ChannelInfo, now: Date, maxAgeMonths = 12): VideoOutlier {
  const profile = channelProfile(channel, now, maxAgeMonths)
  const ratio = channel.subscribers === undefined ? undefined : video.views / Math.max(1000, channel.subscribers)
  const vsAverage = profile.avgViewsPerVideo > 0 ? video.views / profile.avgViewsPerVideo : 0
  const days = Math.max(1, (now.getTime() - Date.parse(video.publishedAt)) / DAY_MS)
  const viewsPerDay = Number.isFinite(days) ? video.views / days : 0
  let tier: OutlierTier = 'none'
  if (ratio !== undefined) {
    if (profile.young && ratio >= 3 && video.views >= 20_000) tier = 'strong'
    else if ((profile.ageMonths <= maxAgeMonths * 2 && ratio >= 2 && video.views >= 10_000)
      || ((channel.subscribers ?? 0) < 100_000 && ratio >= 5 && video.views >= 50_000)) tier = 'moderate'
  } else if (vsAverage >= 5 && video.views >= 50_000) tier = 'moderate'
  return { ...ratio === undefined ? {} : { ratio }, vsAverage, viewsPerDay, tier }
}

/**
 * Whether a whole channel is an outlier: young, few videos, many views each, fast monthly growth.
 * @param channel - the channel.
 * @param now - the instant.
 * @param maxAgeMonths - what counts as young.
 * @returns true for a young channel with at most 60 videos averaging 10,000 views and 100,000 views a month.
 */
export function channelIsOutlier(channel: ChannelInfo, now: Date, maxAgeMonths = 12): boolean {
  const p = channelProfile(channel, now, maxAgeMonths)
  return p.young && channel.videos > 0 && channel.videos <= 60 && p.avgViewsPerVideo >= 10_000 && p.monthlyViews >= 100_000
}

/** How crowded one topic search looks. */
export interface Competition {
  videos: number
  channels: number
  /** Share of the results from channels of a million subscribers or more. */
  bigChannelShare: number
  /** Channels younger than the limit among the results. */
  youngChannels: number
  medianViews: number
  /** Share of results that are 8–15 minutes. */
  targetLengthShare: number
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] ?? 0 : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}

/**
 * Summarize who holds a topic's results.
 * @param videos - the results.
 * @param channels - their channels by id.
 * @param now - the instant.
 * @param maxAgeMonths - what counts as young.
 * @returns the summary.
 */
export function competition(videos: VideoInfo[], channels: ReadonlyMap<string, ChannelInfo>, now: Date, maxAgeMonths = 12): Competition {
  const ids = new Set(videos.map(v => v.channelId))
  const big = videos.filter(v => (channels.get(v.channelId)?.subscribers ?? 0) >= 1_000_000).length
  const young = [...ids].filter((id) => {
    const c = channels.get(id)
    return c !== undefined && channelProfile(c, now, maxAgeMonths).young
  }).length
  return {
    videos: videos.length,
    channels: ids.size,
    bigChannelShare: videos.length === 0 ? 0 : big / videos.length,
    youngChannels: young,
    medianViews: median(videos.map(v => v.views)),
    targetLengthShare: videos.length === 0 ? 0 : videos.filter(v => v.seconds >= 480 && v.seconds <= 900).length / videos.length,
  }
}

/** One row of the monetization table. */
export interface NicheCategory {
  label: string
  /** Typical long-form RPM to the creator, US dollars, for a mostly tier-1 audience. */
  rpm: readonly [number, number]
  advertisers: 'high' | 'medium' | 'low'
  /** Lowest policy risk (0–10) a niche of this category may be scored with. */
  riskFloor: number
  note: string
}

/**
 * RPM bands by category. Creator RPM after YouTube's share, long-form, mostly US/UK/CA/AU viewers; reviewed against
 * creators' published earnings reports. A wide band is honest: RPM moves with season (Q4 high, January low) and audience.
 */
export const CATEGORIES = {
  'personal-finance': { label: 'Personal finance and investing', rpm: [12, 30], advertisers: 'high', riskFloor: 3, note: 'Finance advertisers pay the most; no promises of returns, no specific investment advice.' },
  'business': { label: 'Business, entrepreneurship and marketing', rpm: [10, 25], advertisers: 'high', riskFloor: 1, note: 'Case studies and company stories monetize well.' },
  'tech': { label: 'Tech, software and AI tools', rpm: [8, 18], advertisers: 'high', riskFloor: 1, note: 'SaaS and gadget advertisers; news moves fast.' },
  'legal-insurance-realestate': { label: 'Law, insurance and real estate', rpm: [12, 30], advertisers: 'high', riskFloor: 3, note: 'High RPM; explain, never give individual legal advice.' },
  'health-fitness': { label: 'Health and fitness (not medical advice)', rpm: [6, 14], advertisers: 'medium', riskFloor: 5, note: 'Medical misinformation policy applies; cite sources, no treatment claims.' },
  'medical': { label: 'Medical conditions and treatment', rpm: [8, 20], advertisers: 'medium', riskFloor: 8, note: 'Medical misinformation policy: claims must match health authorities. Poor fit for an AI host.' },
  'careers-productivity': { label: 'Careers, productivity and self-improvement', rpm: [5, 12], advertisers: 'medium', riskFloor: 1, note: 'Steady evergreen demand.' },
  'education-science': { label: 'Science, history and explainers', rpm: [4, 10], advertisers: 'medium', riskFloor: 1, note: 'Evergreen; rewards research and good visuals.' },
  'automotive': { label: 'Cars and the car industry', rpm: [6, 12], advertisers: 'medium', riskFloor: 1, note: 'Industry news and buying explainers.' },
  'travel': { label: 'Travel and places', rpm: [4, 10], advertisers: 'medium', riskFloor: 1, note: 'Footage-hungry: needs licensed or generated visuals.' },
  'psychology-relationships': { label: 'Psychology and relationships', rpm: [3, 8], advertisers: 'medium', riskFloor: 2, note: 'Large audience; avoid diagnosing viewers.' },
  'news-politics': { label: 'News, politics and geopolitics', rpm: [3, 8], advertisers: 'medium', riskFloor: 5, note: 'Limited-ads risk on conflict and tragedy; election misinformation policy; heavy fact-checking.' },
  'true-crime-mystery': { label: 'True crime, mystery and documentary', rpm: [3, 8], advertisers: 'low', riskFloor: 4, note: 'Limited ads on graphic violence; victims\' families and defamation risk.' },
  'food': { label: 'Food and cooking', rpm: [3, 8], advertisers: 'medium', riskFloor: 1, note: 'Usually needs filmed cooking; weak fit for a faceless host.' },
  'sports': { label: 'Sports', rpm: [2, 6], advertisers: 'medium', riskFloor: 4, note: 'Match footage is licensed and Content ID protected.' },
  'gaming': { label: 'Gaming', rpm: [1, 4], advertisers: 'low', riskFloor: 2, note: 'Low RPM; gameplay footage is the usual reused-content trap.' },
  'entertainment': { label: 'Entertainment, celebrities and pop culture', rpm: [1, 4], advertisers: 'low', riskFloor: 5, note: 'Low RPM; depends on clips of others\' shows and films.' },
  'religion-spirituality': { label: 'Religion and spirituality', rpm: [2, 6], advertisers: 'low', riskFloor: 2, note: 'Loyal audience, few advertisers.' },
  'kids': { label: 'Children and family', rpm: [0.5, 3], advertisers: 'low', riskFloor: 9, note: 'Made-for-kids (COPPA): no personalized ads, no comments; mass-produced AI kids content is demonetized. Avoid.' },
  'other': { label: 'Other', rpm: [2, 6], advertisers: 'medium', riskFloor: 2, note: 'Unclassified: check RPM claims by hand.' },
} as const satisfies Record<string, NicheCategory>

/** A category key. */
export type CategoryKey = keyof typeof CATEGORIES

/** Countries whose viewers earn about full RPM; the rest earn a share of it. */
const TIER_1 = new Set(['US', 'GB', 'CA', 'AU', 'NZ', 'IE', 'DE', 'NL', 'NO', 'SE', 'DK', 'CH', 'AT', 'BE', 'FI', 'LU'])
const TIER_2 = new Set(['FR', 'ES', 'IT', 'JP', 'KR', 'SG', 'AE', 'SA', 'QA', 'IL', 'HK', 'TW', 'PT', 'PL', 'CZ'])

/**
 * How much of a tier-1 RPM a country's viewers earn.
 * @param country - ISO 3166 code.
 * @returns 1 for tier 1, 0.55 for tier 2, 0.2 otherwise (Nigeria, India, the Philippines and the like).
 */
export function geoFactor(country: string): number {
  const code = country.trim().toUpperCase()
  return TIER_1.has(code) ? 1 : TIER_2.has(code) ? 0.55 : 0.2
}

/** A niche's money reading. */
export interface Monetization {
  category: CategoryKey
  /** The band adjusted for the audience's countries, US dollars. */
  rpm: [number, number]
  /** 0–10. */
  score: number
  advertisers: NicheCategory['advertisers']
  note: string
}

/**
 * The money a niche can make for an audience in the given countries (an even mix of them).
 * @param category - the category key.
 * @param markets - the audience's countries; none means tier 1.
 * @returns the band and its 0–10 score (2 plus the band's midpoint over $2.50, at most 10).
 */
export function monetization(category: CategoryKey, markets: readonly string[]): Monetization {
  const row: NicheCategory = CATEGORIES[category]
  const factor = markets.length === 0 ? 1 : markets.reduce((sum, m) => sum + geoFactor(m), 0) / markets.length
  const rpm: [number, number] = [Math.round(row.rpm[0] * factor * 10) / 10, Math.round(row.rpm[1] * factor * 10) / 10]
  const mid = (rpm[0] + rpm[1]) / 2
  return { category, rpm, score: Math.min(10, Math.max(0, Math.round(2 + mid / 2.5))), advertisers: row.advertisers, note: row.note }
}

/**
 * A niche's policy risk after the floors: its category's, and 7 for a niche that depends on other people's footage
 * (YouTube's reused-content policy demonetizes channels built on it unless the commentary transforms it).
 * @param category - the category.
 * @param proposed - the model's 0–10.
 * @param reliesOnOthersFootage - whether the videos need others' clips.
 * @returns the risk to score with.
 */
export function policyRisk(category: CategoryKey, proposed: number, reliesOnOthersFootage: boolean): number {
  const floor: number = Math.max(CATEGORIES[category].riskFloor, reliesOnOthersFootage ? 7 : 0)
  return Math.min(10, Math.max(floor, Math.round(proposed)))
}

/** The parts of a niche score, each 0–10. */
export interface ScoreParts {
  demand: number
  outliers: number
  rpm: number
  /** 10 is an open field. */
  competition: number
  /** 10 is the riskiest. */
  policyRisk: number
  productionFit: number
}

/** How much each part weighs; they add up to 1. */
export const WEIGHTS = { demand: 0.2, outliers: 0.25, rpm: 0.2, competition: 0.15, safety: 0.1, productionFit: 0.1 } as const

/**
 * The niche's score out of 100.
 * @param parts - the parts.
 * @returns the weighted sum, policy risk counted as safety (10 minus the risk).
 */
export function nicheScore(parts: ScoreParts): number {
  const clamp = (n: number): number => Math.min(10, Math.max(0, n))
  const sum = WEIGHTS.demand * clamp(parts.demand) + WEIGHTS.outliers * clamp(parts.outliers) + WEIGHTS.rpm * clamp(parts.rpm)
    + WEIGHTS.competition * clamp(parts.competition) + WEIGHTS.safety * (10 - clamp(parts.policyRisk))
    + WEIGHTS.productionFit * clamp(parts.productionFit)
  return Math.round(sum * 100) / 10
}

/**
 * The key's quota day: YouTube resets quotas at midnight Pacific time.
 * @param now - the instant.
 * @returns `YYYY-MM-DD` in Los Angeles.
 */
export function quotaDay(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

/**
 * Why the budget refuses a call.
 * @param input - the call's method and cost, the units used today, the daily limit, and this run's searches and cap.
 * @returns the refusal, or undefined when the call fits.
 */
export function quotaRefusal(input: {
  method: 'search' | 'videos' | 'channels' | 'playlistItems'
  cost: number
  usedToday: number
  dailyLimit: number
  searchesThisRun: number
  searchesPerRun: number
}): string | undefined {
  if (input.usedToday + input.cost > input.dailyLimit) {
    return `The YouTube key has ${String(Math.max(0, input.dailyLimit - input.usedToday))} of ${String(input.dailyLimit)} quota units left today (resets at midnight Pacific); this call needs ${String(input.cost)}. Work from cached results.`
  }
  if (input.method === 'search' && input.searchesThisRun >= input.searchesPerRun) {
    return `This run has used its ${String(input.searchesPerRun)} topic searches (100 units each). Work from what you have: cached seeds, yns_channel and yns_keywords still work.`
  }
  return undefined
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const

/** A weekday name, lower case. */
export type Weekday = typeof WEEKDAYS[number]

/**
 * Read a weekday name.
 * @param value - `monday`, `Mon` and the like.
 * @returns 0 for Sunday to 6 for Saturday, or undefined.
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
 * Whether this week's run is due: the latest scheduled slot (the weekday at the time, in local time) has passed and
 * no run has started on or after its date. A run missed while the server was down starts when it comes back.
 * @param now - the local date and minute.
 * @param weekday - 0 for Sunday to 6.
 * @param minutes - the start, minutes since midnight.
 * @param lastShiftDate - the local date the last scheduled run started.
 * @returns whether to start one now.
 */
export function weeklyDue(now: { date: string; minutes: number }, weekday: number, minutes: number, lastShiftDate: string | null): boolean {
  const today = new Date(`${now.date}T00:00:00Z`).getUTCDay()
  let back = (today - weekday + 7) % 7
  if (back === 0 && now.minutes < minutes) back = 7
  const slot = addDays(now.date, -back)
  return lastShiftDate === null || lastShiftDate < slot
}

/**
 * Why "Run now" is refused, or undefined when a run may start.
 * @param now - epoch milliseconds.
 * @param lastStart - epoch milliseconds of the last start, 0 for never.
 * @param gapMs - the shortest time between two starts.
 * @returns the refusal.
 */
export function runNowRefusal(now: number, lastStart: number, gapMs: number): string | undefined {
  const wait = lastStart + gapMs - now
  if (lastStart <= 0 || wait <= 0) return undefined
  return `a research run started ${String(Math.max(1, Math.round((now - lastStart) / 60_000)))} minutes ago and is still working; try again in ${String(Math.ceil(wait / 60_000))} minutes`
}
