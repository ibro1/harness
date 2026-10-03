/**
 * The YouTube niche scout's tools. The model chooses what to research and
 * judges what it reads; the plugin owns what must hold whatever the model
 * does: the API key's quota and the per-run search cap, which videos and
 * channels count as outliers, the RPM band and policy-risk floor of each
 * category, the weighted score, that cited channels were really fetched, and
 * what a finished report must contain.
 */

import { randomBytes } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ParameterSchemaSpec, ToolDefinition, ToolRunContext, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import { rankChanges, rpmText } from './report.ts'
import {
  CATEGORIES, channelIsOutlier, channelProfile, competition, monetization, nicheScore, policyRisk, quotaDay, quotaRefusal, videoOutlier,
  type CategoryKey, type ScoreParts,
} from './scoring.ts'
import type { NicheRecord, ReportRecord, RunRecord, ScoutState, ScoutStore, SearchCacheEntry } from './store.ts'
import { prune } from './store.ts'
import { expansionQueries, pooled, type Expansion, type SuggestRequest, type SuggestSource } from './suggest.ts'
import { channelRef, QUOTA_COST, QuotaExhausted, type ChannelInfo, type VideoInfo, type YouTube } from './youtube.ts'

/** Settings the tools read live. */
export interface ScoutSettings {
  seeds: () => string[]
  /** ISO country codes, the first is the default market. */
  markets: () => string[]
  /** Language codes, the first is the default. */
  languages: () => string[]
  dailyQuota: () => number
  searchesPerRun: () => number
  /** How far back a topic search looks for videos. */
  windowDays: () => number
  /** What counts as a young channel. */
  maxChannelAgeMonths: () => number
  cacheDays: () => number
}

/** What the tools read and call. */
export interface ScoutDeps {
  store: ScoutStore
  youtube: YouTube
  suggest: (request: SuggestRequest, signal: AbortSignal) => Promise<string[]>
  settings: ScoutSettings
  now: () => Date
  /** The signed address of a report's page. */
  reportLink: (reportId: string) => string
  /** Tell the owner a report is ready; says whether the message went. Never throws. */
  announce: (report: ReportRecord) => Promise<string>
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { text: { type: 'string', required: true, description: 'What happened.' } },
} as const satisfies ValueSchemaSpec

/** Fewest niches a report ranks. */
export const MIN_NICHES = 5
/** Most niches a report shows. */
export const MAX_NICHES = 8
/** Most niches one run may save. */
const MAX_SAVED = 12
/** Fewest title ideas for each of the top niches. */
export const MIN_IDEAS = 10
/** Most title ideas for each of the top niches. */
export const MAX_IDEAS = 20
/** Shortest reason accepted for a score part. */
const MIN_WHY = 20
/** An open run older than this is left behind and a new one opened. */
const RUN_LIFETIME_MS = 2 * 86_400_000

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(str).filter(s => s !== '') : []
}

function count(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`
  return String(Math.round(n))
}

function minutes(seconds: number): string {
  return `${String(Math.floor(seconds / 60))}:${String(Math.round(seconds % 60)).padStart(2, '0')}`
}

/**
 * The open run, opening one for tool calls made outside a shift.
 * @param state - the state, changed in place.
 * @param now - the instant.
 * @returns the run.
 */
export function openRun(state: ScoutState, now: Date): RunRecord {
  const last = state.runs.at(-1)
  if (last !== undefined && last.finishedAt === undefined && now.getTime() - Date.parse(last.startedAt) < RUN_LIFETIME_MS) return last
  return startRun(state, now, 'tool')
}

/**
 * Start a run, leaving behind any run still open.
 * @param state - the state, changed in place.
 * @param now - the instant.
 * @param trigger - what started it.
 * @returns the new run.
 */
export function startRun(state: ScoutState, now: Date, trigger: RunRecord['trigger']): RunRecord {
  for (const run of state.runs) {
    if (run.finishedAt === undefined) Object.assign(run, { finishedAt: now.toISOString(), abandoned: true })
  }
  const run: RunRecord = { id: randomBytes(6).toString('hex'), startedAt: now.toISOString(), trigger, searches: 0, units: 0, niches: [] }
  state.runs.push(run)
  return run
}

/**
 * The quota budget the YouTube client charges before each call: refuses past the key's day or the run's search cap,
 * otherwise records the units against the Pacific day and the open run.
 * @param store - the state.
 * @param settings - the limits.
 * @param now - the clock.
 * @returns the charge function.
 */
export function quotaCharger(
  store: ScoutStore, settings: Pick<ScoutSettings, 'dailyQuota' | 'searchesPerRun'>, now: () => Date,
): (units: number, method: keyof typeof QUOTA_COST) => Promise<void> {
  return (units: number, method: keyof typeof QUOTA_COST): Promise<void> => store.update((s) => {
    const at = now()
    const day = quotaDay(at)
    const run = openRun(s, at)
    const refusal = quotaRefusal({
      method, cost: units, usedToday: s.quota[day] ?? 0, dailyLimit: settings.dailyQuota(),
      searchesThisRun: run.searches, searchesPerRun: settings.searchesPerRun(),
    })
    if (refusal !== undefined) throw new QuotaExhausted(refusal)
    s.quota[day] = (s.quota[day] ?? 0) + units
    run.units += units
    if (method === 'search') run.searches += 1
  })
}

/**
 * Rank a run's niches, best first.
 * @param niches - the niches.
 * @returns a sorted copy.
 */
export function ranked(niches: readonly NicheRecord[]): NicheRecord[] {
  return [...niches].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
}

function describeVideo(v: VideoInfo, c: ChannelInfo | undefined, now: Date, maxAge: number): string {
  const days = Math.max(0, Math.round((now.getTime() - Date.parse(v.publishedAt)) / 86_400_000))
  if (c === undefined) return `- "${v.title}" — ${count(v.views)} views, ${minutes(v.seconds)}, ${String(days)}d old | ${v.channelTitle} | https://youtu.be/${v.id}`
  const o = videoOutlier(v, c, now, maxAge)
  const p = channelProfile(c, now, maxAge)
  const subs = c.subscribers === undefined ? 'hidden subs' : `${count(c.subscribers)} subs`
  const ratio = o.ratio === undefined ? `${o.vsAverage.toFixed(1)}× its average` : `${o.ratio.toFixed(1)}× subs`
  return `- [${o.tier}] "${v.title}" — ${count(v.views)} views (${ratio}, ${count(o.viewsPerDay)}/day), ${minutes(v.seconds)}, ${String(days)}d old`
    + ` | ${c.title} (${c.id}): ${subs}, ${p.ageMonths.toFixed(1)} months old, ${String(c.videos)} videos | https://youtu.be/${v.id}`
}

function scorePart(description: string): ValueSchemaSpec {
  return {
    type: 'object',
    additionalProperties: false,
    description,
    properties: {
      score: { type: 'number', required: true, description: '0 to 10.' },
      why: { type: 'string', required: true, description: 'The evidence: numbers and names from the tools, not impressions.' },
    },
  }
}

function readPart(args: Record<string, unknown>, key: string, label: string, problems: string[]): { score: number; why: string } {
  const value = typeof args[key] === 'object' && args[key] !== null ? args[key] as Record<string, unknown> : {}
  const score = typeof value['score'] === 'number' ? value['score'] : Number.NaN
  const why = str(value['why'])
  if (!Number.isFinite(score) || score < 0 || score > 10) problems.push(`${label}: score must be 0–10.`)
  if (why.length < MIN_WHY) problems.push(`${label}: give the evidence (at least ${String(MIN_WHY)} characters).`)
  return { score: Number.isFinite(score) ? Math.min(10, Math.max(0, score)) : 0, why }
}

/**
 * Build the tools.
 * @param deps - store, YouTube client, autocomplete, settings and the owner's channel.
 * @returns the tool definitions.
 */
export function buildScoutTools(deps: ScoutDeps): ToolDefinition[] {
  const { store, settings } = deps
  const cacheMs = (): number => settings.cacheDays() * 86_400_000
  const fresh = (at: string): boolean => deps.now().getTime() - Date.parse(at) < cacheMs()
  const market = (value: unknown): string => (str(value) || settings.markets()[0] || 'US').toUpperCase()
  const language = (value: unknown): string => (str(value) || settings.languages()[0] || 'en').toLowerCase()
  const tool = (spec: {
    name: string
    description: string
    parameters: ParameterSchemaSpec
    run: (args: Record<string, unknown>, exec: ToolRunContext) => Promise<string>
  }): ToolDefinition => defineTool({
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: { schema: OUTPUT_SCHEMA, render: (_args, value) => [{ type: 'text', text: value.text }] },
    execute: async (args, exec) => ({ text: await spec.run(args as Record<string, unknown>, exec) }),
    presentCall: () => ({ card: 'generic', title: spec.name.replace(/_/gu, ' '), kind: 'other', rawInput: '' }),
  })

  /** Read channels, from the cache when fresh, the rest in one call; every channel read is cached. */
  const channels = async (ids: string[], signal: AbortSignal): Promise<Map<string, ChannelInfo>> => {
    const state = await store.read()
    const out = new Map<string, ChannelInfo>()
    const missing: string[] = []
    for (const id of new Set(ids)) {
      const hit = state.channels[id]
      if (hit !== undefined && fresh(hit.at)) out.set(id, hit.channel)
      else missing.push(id)
    }
    if (missing.length > 0) {
      const read = await deps.youtube.channels({ ids: missing.slice(0, 50) }, signal)
      const at = deps.now().toISOString()
      await store.update((s) => { for (const c of read) s.channels[c.id] = { at, channel: c } })
      for (const c of read) out.set(c.id, c)
    }
    return out
  }

  return [
    tool({
      name: 'yns_status',
      description: 'The run\'s brief: the owner\'s seed topics, markets and languages, the API key\'s quota left today, this run\'s searches left, the niches saved so far, and the last reports. Call it first.',
      parameters: {},
      run: async () => {
        const now = deps.now()
        const state = await store.update((s) => {
          prune(s, now, cacheMs())
          openRun(s, now)
          return s
        })
        const run = openRun(state, now)
        const used = state.quota[quotaDay(now)] ?? 0
        const reports = [...state.reports].reverse().slice(0, 3)
        return [
          `Seed topics: ${settings.seeds().join('; ') || '(none set: choose broad faceless-friendly topics yourself)'}.`,
          `Markets: ${settings.markets().join(', ') || 'US'}. Languages: ${settings.languages().join(', ') || 'en'}.`,
          `YouTube quota today (Pacific): ${String(used)}/${String(settings.dailyQuota())} units used. A topic search costs ${String(QUOTA_COST.search)}; channel and video reads cost 1.`,
          `This run (${run.id}, started ${run.startedAt.slice(0, 16)}): ${String(run.searches)}/${String(settings.searchesPerRun())} topic searches, ${String(run.units)} units.`,
          run.niches.length === 0
            ? `No niches saved yet; a report needs ${String(MIN_NICHES)}–${String(MAX_NICHES)}.`
            : `Niches saved: ${ranked(run.niches).map(n => `${n.name} ${String(n.score)}`).join('; ')}.`,
          reports.length === 0
            ? 'No earlier reports.'
            : `Earlier reports: ${reports.map(r => `${r.createdAt.slice(0, 10)} → ${r.recommendation.niche} (${r.niches.map(n => n.name).slice(0, 5).join(', ')})`).join(' | ')}.`,
          `Cached topic searches: ${String(Object.keys(state.searches).length)} (reused for free for ${String(settings.cacheDays())} days).`,
        ].join('\n')
      },
    }),
    tool({
      name: 'yns_search_outliers',
      description: `Search YouTube for the most-viewed recent long-form videos on a topic and mark the outliers: videos with far more views than their channel has subscribers, mostly on young channels. Also says how crowded the topic is (big channels' share, young channels, median views, share of 8–15 minute videos). Costs ${String(QUOTA_COST.search + 2)} quota units unless cached; the run has a search cap, so choose seeds deliberately.`,
      parameters: {
        seed: { type: 'string', required: true, description: 'Topic words as a viewer would search them, such as "ai tools explained".' },
        market: { type: 'string', description: 'ISO country code for regionCode. Defaults to the first market.' },
        language: { type: 'string', description: 'Language code for relevanceLanguage. Defaults to the first language.' },
        duration: { type: 'string', enum: ['medium', 'long'], description: 'medium is 4–20 minutes (default, holds the 8–15 minute target); long is over 20.' },
        window_days: { type: 'integer', description: 'Only videos published in the last N days, 14 to 365. Defaults to the setting.' },
      },
      run: async (args, exec) => {
        const seed = str(args['seed']).toLowerCase()
        if (seed === '') throw new Error('Give a seed topic.')
        const region = market(args['market'])
        const lang = language(args['language'])
        const duration = args['duration'] === 'long' ? 'long' : 'medium'
        const days = Math.min(365, Math.max(14, typeof args['window_days'] === 'number' ? Math.round(args['window_days']) : settings.windowDays()))
        const maxAge = settings.maxChannelAgeMonths()
        const key = [seed, region, lang, duration, String(days)].join('|')
        const now = deps.now()
        let entry: SearchCacheEntry | undefined = (await store.read()).searches[key]
        let cached = entry !== undefined && fresh(entry.at)
        let byId: Map<string, ChannelInfo>
        if (entry !== undefined && cached) {
          byId = await channels(entry.videos.map(v => v.channelId), exec.signal)
        } else {
          cached = false
          const page = await deps.youtube.search({
            query: seed, duration, publishedAfter: new Date(now.getTime() - days * 86_400_000).toISOString(),
            regionCode: region, relevanceLanguage: lang,
          }, exec.signal)
          const videos = await deps.youtube.videos(page.videoIds, exec.signal)
          byId = await channels(videos.map(v => v.channelId), exec.signal)
          entry = { at: now.toISOString(), totalResults: page.totalResults, videos, competition: competition(videos, byId, now, maxAge) }
          const saved = entry
          await store.update((s) => { s.searches[key] = saved })
        }
        const c = entry.competition
        const order = { strong: 0, moderate: 1, none: 2 } as const
        const rows = entry.videos.map((v) => {
          const channel = byId.get(v.channelId)
          return { v, channel, o: channel === undefined ? undefined : videoOutlier(v, channel, now, maxAge) }
        })
        const outliers = rows.filter(r => r.o !== undefined && r.o.tier !== 'none')
          .sort((a, b) => order[a.o?.tier ?? 'none'] - order[b.o?.tier ?? 'none'] || (b.o?.ratio ?? b.o?.vsAverage ?? 0) - (a.o?.ratio ?? a.o?.vsAverage ?? 0))
        const youngOutliers = [...byId.values()].filter(ch => channelIsOutlier(ch, now, maxAge))
        const others = rows.filter(r => r.o?.tier === 'none' || r.o === undefined).slice(0, 5)
        return [
          `"${seed}" in ${region}/${lang}, ${duration} length, last ${String(days)} days${cached ? ` (cached ${entry.at.slice(0, 10)}, no quota spent)` : ''}:`,
          `YouTube reports about ${count(entry.totalResults)} matches (rough). Read ${String(c.videos)} top videos by views from ${String(c.channels)} channels; median ${count(c.medianViews)} views;`
            + ` ${String(Math.round(c.bigChannelShare * 100))}% from channels with 1M+ subscribers; ${String(c.youngChannels)} channels under ${String(maxAge)} months old;`
            + ` ${String(Math.round(c.targetLengthShare * 100))}% are 8–15 minutes.`,
          outliers.length === 0 ? 'No outlier videos.' : `Outlier videos (${String(outliers.length)}):`,
          ...outliers.slice(0, 15).map(r => describeVideo(r.v, r.channel, now, maxAge)),
          youngOutliers.length === 0 ? 'No young outlier channels.' : 'Young outlier channels (whole channel growing fast):',
          ...youngOutliers.slice(0, 8).map((ch) => {
            const p = channelProfile(ch, now, maxAge)
            return `- ${ch.title} (${ch.id}): ${p.ageMonths.toFixed(1)} months, ${String(ch.videos)} videos, ${count(p.avgViewsPerVideo)} avg views/video, ${count(p.monthlyViews)} views/month,`
              + ` ${ch.subscribers === undefined ? 'hidden' : count(ch.subscribers)} subs`
          }),
          others.length === 0 ? '' : 'Top results that are not outliers (who already wins):',
          ...others.map(r => describeVideo(r.v, r.channel, now, maxAge)),
        ].filter(line => line !== '').join('\n')
      },
    }),
    tool({
      name: 'yns_channel',
      description: 'Read one channel in depth (3 quota units): age, subscribers, total and average views, and its latest uploads: cadence, median views, typical length, Shorts share, and its best recent videos. Use it to confirm an outlier before citing it.',
      parameters: { channel: { type: 'string', required: true, description: 'A channel id (UC…), an @handle, or a channel or video page address with either.' } },
      run: async (args, exec) => {
        const ref = channelRef(str(args['channel']))
        if (ref === undefined) throw new Error('Give a channel id (UC…) or an @handle.')
        const now = deps.now()
        const maxAge = settings.maxChannelAgeMonths()
        const [channel] = await deps.youtube.channels(ref, exec.signal)
        if (channel === undefined) throw new Error('YouTube has no such channel.')
        await store.update((s) => { s.channels[channel.id] = { at: now.toISOString(), channel } })
        const p = channelProfile(channel, now, maxAge)
        const ids = channel.uploads === undefined ? [] : await deps.youtube.uploads(channel.uploads, exec.signal)
        const recent = await deps.youtube.videos(ids, exec.signal)
        const age = (v: VideoInfo): number => (now.getTime() - Date.parse(v.publishedAt)) / 86_400_000
        const long = recent.filter(v => v.seconds > 180)
        const views = long.slice(0, 10).map(v => v.views).sort((a, b) => a - b)
        const medianViews = views.length === 0 ? 0 : views[Math.floor(views.length / 2)] ?? 0
        const best = [...long].sort((a, b) => b.views - a.views).slice(0, 5)
        return [
          `${channel.title}${channel.handle === undefined ? '' : ` (${channel.handle})`} — ${channel.id}, https://www.youtube.com/channel/${channel.id}`,
          `Created ${channel.createdAt.slice(0, 10)} (${p.ageMonths.toFixed(1)} months)${channel.country === undefined ? '' : `, ${channel.country}`}.`
            + ` ${channel.subscribers === undefined ? 'Subscribers hidden' : `${count(channel.subscribers)} subscribers`}, ${String(channel.videos)} videos, ${count(channel.views)} views`
            + ` (${count(p.avgViewsPerVideo)} per video, ${count(p.monthlyViews)} per month of its life).`,
          channelIsOutlier(channel, now, maxAge) ? 'OUTLIER CHANNEL: young, few videos, many views each.' : p.young ? 'Young channel, not (yet) an outlier.' : 'Not a young channel.',
          `Latest ${String(recent.length)} uploads: ${String(recent.filter(v => age(v) <= 30).length)} in the last 30 days, ${String(recent.filter(v => age(v) <= 90).length)} in 90;`
            + ` ${String(recent.filter(v => v.seconds > 0 && v.seconds <= 180).length)} Shorts; ${String(recent.filter(v => v.seconds >= 480 && v.seconds <= 900).length)} are 8–15 minutes;`
            + ` median of the last 10 long videos ${count(medianViews)} views.`,
          best.length === 0 ? 'No long videos among the latest uploads.' : 'Best recent long videos:',
          ...best.map(v => describeVideo(v, channel, now, maxAge)),
        ].join('\n')
      },
    }),
    tool({
      name: 'yns_keywords',
      description: 'Expand a seed into the long-tail searches people type, from YouTube\'s (and optionally Google\'s) autocomplete. Free, no quota. Gives phrasings and a breadth signal (how many distinct suggestions), never search volumes.',
      parameters: {
        seed: { type: 'string', required: true, description: 'The seed keyword.' },
        expansion: { type: 'string', enum: ['basic', 'questions', 'alphabet'], description: 'basic: the seed alone; questions (default): how/why/what/is/can/best/vs before it; alphabet: the seed followed by a–z (27 requests).' },
        source: { type: 'string', enum: ['youtube', 'google', 'both'], description: 'Whose autocomplete. Defaults to youtube.' },
        market: { type: 'string', description: 'ISO country code. Defaults to the first market.' },
        language: { type: 'string', description: 'Language code. Defaults to the first language.' },
      },
      run: async (args, exec) => {
        const seed = str(args['seed'])
        if (seed === '') throw new Error('Give a seed keyword.')
        const expansion: Expansion = args['expansion'] === 'basic' || args['expansion'] === 'alphabet' ? args['expansion'] : 'questions'
        const sources: SuggestSource[] = args['source'] === 'both' ? ['youtube', 'google'] : args['source'] === 'google' ? ['google'] : ['youtube']
        const country = market(args['market'])
        const lang = language(args['language'])
        const state = await store.read()
        const jobs = sources.flatMap(source => expansionQueries(seed, expansion).map(query => ({ source, query })))
        const results = await pooled(jobs, 4, async (job) => {
          const key = [job.source, country, lang, job.query].join('|')
          const hit = state.suggestions[key]
          if (hit !== undefined && fresh(hit.at)) return hit.list
          const list = await deps.suggest({ query: job.query, source: job.source, country, language: lang }, exec.signal)
          await store.update((s) => { s.suggestions[key] = { at: deps.now().toISOString(), list } })
          return list
        })
        const failed = results.filter(r => r instanceof Error)
        const lines: string[] = [`Autocomplete for "${seed}" (${expansion}, ${country}/${lang}):`]
        for (const source of sources) {
          const seen = new Set<string>()
          results.forEach((r, i) => {
            if (jobs[i]?.source === source && !(r instanceof Error)) for (const s of r) seen.add(s)
          })
          lines.push(`${source === 'youtube' ? 'YouTube' : 'Google'}: ${String(seen.size)} distinct suggestions.`, ...[...seen].slice(0, 80).map(s => `- ${s}`))
        }
        if (failed.length > 0) lines.push(`${String(failed.length)} of ${String(jobs.length)} requests failed (${failed[0]?.message ?? ''}).`)
        return lines.join('\n')
      },
    }),
    tool({
      name: 'yns_save_niche',
      description: `Save or replace one scored niche in this run. You score demand, outlier evidence, competition (10 = open field), policy risk (10 = riskiest) and production fit, each 0–10 with evidence; the plugin sets RPM from the category and the audience's countries, raises policy risk to the category's floor (and to 7 when the videos need other people's footage), and computes the score out of 100. Example channels must be ones yns_search_outliers or yns_channel read; an outlier score of 4 or more needs at least one. Categories: ${Object.keys(CATEGORIES).join(', ')}.`,
      parameters: {
        name: { type: 'string', required: true, description: 'A specific niche, such as "AI tools for small business explained", not a broad category.' },
        category: { type: 'string', required: true, enum: Object.keys(CATEGORIES), description: 'The monetization category.' },
        keywords: { type: 'array', items: { type: 'string' }, required: true, description: 'The seeds and long-tail keywords that define it.' },
        markets: { type: 'array', items: { type: 'string' }, description: 'The audience\'s countries (ISO codes). Defaults to the owner\'s markets.' },
        demand: { ...scorePart('Search and viewing demand: autocomplete breadth, outlier views, YouTube\'s match counts.'), required: true },
        outliers: { ...scorePart('How much outlier evidence: young channels and videos far above their subscriber counts.'), required: true },
        competition: { ...scorePart('Room to enter: 10 when few, small or stale channels hold the topic.'), required: true },
        policy_risk: { ...scorePart('Reused-content, misinformation, limited-ads and made-for-kids risk; 10 is the riskiest.'), required: true },
        production_fit: { ...scorePart('Whether the pipeline can make it weekly: sources and transcripts, B-roll, AI voice and visuals, ffmpeg edit.'), required: true },
        relies_on_others_footage: { type: 'boolean', required: true, description: 'True when the videos need other people\'s clips (shows, matches, other creators).' },
        example_channels: {
          type: 'array',
          description: 'The outlier channels the score rests on.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', required: true, description: 'Channel id (UC…).' },
              note: { type: 'string', required: true, description: 'What makes it evidence, with numbers.' },
            },
          },
        },
        gaps: { type: 'string', description: 'Content gaps: unanswered questions in comments, outdated top videos, angles nobody covers.' },
      },
      run: async (args) => {
        const name = str(args['name'])
        const category = str(args['category']) as CategoryKey
        const problems: string[] = []
        if (name === '') problems.push('Give the niche a name.')
        if (!(category in CATEGORIES)) problems.push(`Unknown category "${category}".`)
        const keywords = strings(args['keywords'])
        if (keywords.length === 0) problems.push('Give at least one keyword.')
        const demand = readPart(args, 'demand', 'demand', problems)
        const outliers = readPart(args, 'outliers', 'outliers', problems)
        const room = readPart(args, 'competition', 'competition', problems)
        const risk = readPart(args, 'policy_risk', 'policy_risk', problems)
        const fit = readPart(args, 'production_fit', 'production_fit', problems)
        const footage = args['relies_on_others_footage'] === true
        const markets = (strings(args['markets']).length > 0 ? strings(args['markets']) : settings.markets()).map(m => m.toUpperCase())
        const state = await store.read()
        const rawExamples = Array.isArray(args['example_channels']) ? args['example_channels'] as Record<string, unknown>[] : []
        const examples: NicheRecord['examples'] = []
        for (const e of rawExamples) {
          const id = str(e['id'])
          const known = state.channels[id]?.channel
          if (known === undefined) problems.push(`Channel ${id || '(empty)'} was not read by yns_search_outliers or yns_channel; cite only channels the tools returned.`)
          else examples.push({ id, title: known.title, note: str(e['note']) })
        }
        if (outliers.score >= 4 && examples.length === 0) problems.push('An outlier score of 4 or more needs at least one example channel.')
        if (problems.length > 0) throw new Error(`Not saved:\n- ${problems.join('\n- ')}`)
        const money = monetization(category, markets)
        const parts: ScoreParts = {
          demand: demand.score, outliers: outliers.score, rpm: money.score, competition: room.score,
          policyRisk: policyRisk(category, risk.score, footage), productionFit: fit.score,
        }
        const floorNote = parts.policyRisk > Math.round(risk.score) ? ` (raised from ${String(Math.round(risk.score))}: ${footage ? 'others\' footage' : 'category floor'})` : ''
        const niche: NicheRecord = {
          name, category, keywords, markets, parts,
          evidence: {
            demand: demand.why, outliers: outliers.why, competition: room.why, productionFit: fit.why,
            policyRisk: `${risk.why}${floorNote}`, rpm: `${CATEGORIES[category].label}: ${money.note} Advertisers: ${money.advertisers}.`,
          },
          rpm: money.rpm, score: nicheScore(parts), examples, reliesOnOthersFootage: footage, gaps: str(args['gaps']), savedAt: deps.now().toISOString(),
        }
        const run = await store.update((s) => {
          const open = openRun(s, deps.now())
          const index = open.niches.findIndex(n => n.name.toLowerCase() === name.toLowerCase())
          if (index < 0 && open.niches.length >= MAX_SAVED) throw new Error(`This run already has ${String(MAX_SAVED)} niches; replace one by saving under its name.`)
          if (index < 0) open.niches.push(niche)
          else open.niches[index] = niche
          return open
        })
        return [
          `Saved "${name}": ${String(niche.score)}/100 — demand ${String(parts.demand)}, outliers ${String(parts.outliers)}, RPM ${String(parts.rpm)} (${rpmText(money.rpm)} for ${markets.join(', ')}),`
            + ` room ${String(parts.competition)}, policy risk ${String(parts.policyRisk)}${floorNote}, production fit ${String(parts.productionFit)}.`,
          `Ranking so far: ${ranked(run.niches).map((n, i) => `${String(i + 1)}. ${n.name} ${String(n.score)}`).join('; ')}.`,
        ].join('\n')
      },
    }),
    tool({
      name: 'yns_write_report',
      description: `Finish the run: rank its saved niches (${String(MIN_NICHES)}–${String(MAX_NICHES)} are needed; the top ${String(MAX_NICHES)} are shown), publish the report page, and send the owner the link and the recommendation on WhatsApp. Ideas: ${String(MIN_IDEAS)}–${String(MAX_IDEAS)} video titles for each of the three highest-scoring niches and for the recommended one.`,
      parameters: {
        summary: { type: 'string', required: true, description: 'What the week\'s research found, in a few sentences.' },
        recommendation: { type: 'string', required: true, description: 'The niche to enter: one of the saved names.' },
        why: { type: 'string', required: true, description: 'Why this one, with the numbers; if it is not the top score, why it still wins.' },
        first_steps: { type: 'array', items: { type: 'string' }, description: 'The first things the long-form channel employee should do.' },
        ideas: {
          type: 'array',
          required: true,
          description: 'Video ideas per niche.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              niche: { type: 'string', required: true, description: 'A saved niche name.' },
              titles: { type: 'array', items: { type: 'string' }, required: true, description: 'Titles as they would appear on YouTube, at most 100 characters.' },
            },
          },
        },
        risks: { type: 'string', description: 'What could make the recommendation wrong.' },
        method: { type: 'string', required: true, description: 'What you used and what you could not (autocomplete, outlier searches, channel reads; Keyword Planner volumes and Google Trends are not available here).' },
      },
      run: async (args) => {
        const now = deps.now()
        const state = await store.read()
        const run = openRun(state, now)
        const niches = ranked(run.niches)
        const problems: string[] = []
        if (niches.length < MIN_NICHES) problems.push(`Only ${String(niches.length)} niches are saved in this run; a report needs at least ${String(MIN_NICHES)}.`)
        const shown = niches.slice(0, MAX_NICHES)
        const pick = str(args['recommendation'])
        const picked = shown.find(n => n.name.toLowerCase() === pick.toLowerCase())
        if (picked === undefined) problems.push(`"${pick}" is not one of the ranked niches: ${shown.map(n => n.name).join('; ')}.`)
        const ideas = (Array.isArray(args['ideas']) ? args['ideas'] as Record<string, unknown>[] : []).map(i => ({ niche: str(i['niche']), titles: strings(i['titles']) }))
        const needIdeas = [...new Set([...shown.slice(0, 3), ...picked === undefined ? [] : [picked]])]
        for (const n of needIdeas) {
          const set = ideas.find(i => i.niche.toLowerCase() === n.name.toLowerCase())
          const titles = new Set(set?.titles.map(t => t.toLowerCase()) ?? [])
          if (titles.size < MIN_IDEAS || titles.size > MAX_IDEAS) problems.push(`"${n.name}" needs ${String(MIN_IDEAS)}–${String(MAX_IDEAS)} distinct titles (has ${String(titles.size)}).`)
          const long = set?.titles.filter(t => t.length > 100) ?? []
          if (long.length > 0) problems.push(`Titles over 100 characters for "${n.name}": ${long.map(t => `"${t.slice(0, 40)}…"`).join(', ')}.`)
        }
        for (const set of ideas) {
          if (!shown.some(n => n.name.toLowerCase() === set.niche.toLowerCase())) problems.push(`Ideas for "${set.niche}", which is not a ranked niche.`)
        }
        const why = str(args['why'])
        if (why.length < 40) problems.push('Explain the recommendation (at least 40 characters).')
        if (problems.length > 0) throw new Error(`Report not written:\n- ${problems.join('\n- ')}`)
        const previous = state.reports.at(-1)
        const report: ReportRecord = {
          id: randomBytes(8).toString('hex'),
          runId: run.id,
          createdAt: now.toISOString(),
          summary: str(args['summary']),
          recommendation: { niche: picked?.name ?? pick, why, firstSteps: strings(args['first_steps']) },
          niches: shown,
          ideas: ideas.map(i => ({
            niche: shown.find(n => n.name.toLowerCase() === i.niche.toLowerCase())?.name ?? i.niche, titles: [...new Set(i.titles)],
          })),
          risks: str(args['risks']),
          method: str(args['method']),
          changes: rankChanges(previous?.niches, shown),
          searches: run.searches,
          units: run.units,
        }
        await store.update((s) => {
          const live = s.runs.find(r => r.id === run.id)
          if (live !== undefined) Object.assign(live, { finishedAt: report.createdAt, reportId: report.id })
          s.reports.push(report)
        })
        const sent = await deps.announce(report)
        return [
          `Report written: ${deps.reportLink(report.id)}`,
          `Recommendation: ${report.recommendation.niche}. Ranked: ${shown.map((n, i) => `${String(i + 1)}. ${n.name} ${String(n.score)}`).join('; ')}.`,
          `WhatsApp: ${sent}.`,
          'The run is finished. Stop here.',
        ].join('\n')
      },
    }),
    tool({
      name: 'yns_reports',
      description: 'Past reports, newest first: date, recommendation, the ranked niches with scores, and the link. Use it to see how niches moved week to week.',
      parameters: { limit: { type: 'integer', description: 'How many, 1 to 20. Defaults to 5.' } },
      run: async (args) => {
        const limit = Math.min(20, Math.max(1, typeof args['limit'] === 'number' ? Math.round(args['limit']) : 5))
        const reports = [...(await store.read()).reports].reverse().slice(0, limit)
        if (reports.length === 0) return 'No reports yet.'
        return reports.map(r => [
          `${r.createdAt.slice(0, 10)} → ${r.recommendation.niche} — ${deps.reportLink(r.id)}`,
          `  ${r.niches.map((n, i) => `${String(i + 1)}. ${n.name} ${String(n.score)}`).join('; ')}`,
          ...r.changes.length === 0 ? [] : [`  Changes: ${r.changes.join(' ')}`],
        ].join('\n')).join('\n')
      },
    }),
  ]
}
