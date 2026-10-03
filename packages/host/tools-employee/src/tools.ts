/**
 * The tools employee's tools. The model researches, judges and writes; the
 * plugin owns every rule that protects the site and the owner: the keyword
 * gate (demand evidence, a first page with room, evergreen, audience value),
 * the daily cap and pace of Google results-page reads, that only tools the
 * owner approved are built, that a tool's tests pass on its current files
 * before it is published, the build's quality checks, and the weekly pace of
 * new tools.
 */

import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ParameterSchemaSpec, ToolDefinition, ToolRunContext, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import { localTime } from '@deepseek-ai/dsh-host-employee-kit'
import { expansionQueries, pooled, type Expansion, type SuggestRequest } from '@deepseek-ai/dsh-host-youtube-niche-scout'
import { keywordGate, NICHE_RPM, paceRefusal, rpmText, type Niche } from './gate.ts'
import { review, type ReviewRules, type VolumeAnswer } from './google.ts'
import { adsenseReadiness, shortlistMessage, type ReadinessRules } from './report.ts'
import { hostKind, peopleAsk, serpVerdict, type SerpExtract } from './serp.ts'
import { dirHash, liveCheck, SLUG, type SiteRepo } from './site.ts'
import { prune, type Candidate, type Shortlist, type ToolRecord, type ToolsState, type ToolsStore } from './store.ts'
import type { GscRow } from '@deepseek-ai/dsh-host-seo-employee'

/** Settings the tools read live. */
export interface ToolsSettings {
  seeds: () => string[]
  /** Two-letter countries; the first is the default market. */
  markets: () => string[]
  maxToolsPerWeek: () => number
  /** Live Google results pages a day (capped at `MAX_SERPS_PER_DAY`). */
  serpPerDay: () => number
  /** Shortest wait between two live results-page reads. */
  serpGapMs: () => number
  /** How long a results page and autocomplete answers are reused. */
  cacheDays: () => number
  timeZone: () => string
  siteUrl: () => string
  adsenseClient: () => string
  readiness: () => ReadinessRules
  review: () => ReviewRules
}

/** What the tools read and call. */
export interface ToolsDeps {
  store: ToolsStore
  site: SiteRepo
  suggest: (request: SuggestRequest, signal: AbortSignal) => Promise<string[]>
  readSerp: (keyword: string, market: string, signal: AbortSignal) => Promise<SerpExtract>
  volumes: (keywords: string[], signal: AbortSignal) => Promise<VolumeAnswer>
  /** Search Console rows for the site; throws when it is not connected. */
  searchConsole: (signal: AbortSignal) => Promise<{ property: string; queryPages: GscRow[]; pages90: GscRow[] }>
  /** Why Search Console is not usable, or undefined when it is. */
  gscProblem: () => string | undefined
  settings: ToolsSettings
  now: () => Date
  sleep: (ms: number, signal: AbortSignal) => Promise<void>
  /** Message the owner; says whether it went. Never throws. */
  notify: (text: string) => Promise<string>
  /** The signed review page of a shortlist. */
  shortlistLink: (id: string) => string
  /** The shipped seed tools' slugs. */
  seedSlugs: () => string[]
  fetch: typeof fetch
}

/** Hard ceiling on live results-page reads a day. */
export const MAX_SERPS_PER_DAY = 20
/** Most tools on one shortlist. */
export const MAX_SHORTLIST = 6
/** A pending shortlist older than this is closed unapproved. */
const SHORTLIST_LIFETIME_MS = 14 * 86_400_000
/** After Google shows a robot check, results pages are not read for this long. */
const BLOCK_PAUSE_MS = 6 * 3_600_000

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { text: { type: 'string', required: true, description: 'What happened.' } },
} as const satisfies ValueSchemaSpec

const NICHES = Object.keys(NICHE_RPM) as Niche[]

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(str).filter(s => s !== '') : []
}

function norm(keyword: string): string {
  return keyword.trim().toLowerCase().replace(/\s+/gu, ' ')
}

/**
 * The live results-page reads made today in the owner's time zone.
 * @param state - the state.
 * @param now - the instant.
 * @param timeZone - the owner's zone.
 * @returns how many.
 */
export function serpsToday(state: Pick<ToolsState, 'serpLog'>, now: Date, timeZone: string): number {
  const today = localTime(now, timeZone).date
  return state.serpLog.filter(at => localTime(new Date(at), timeZone).date === today).length
}

/**
 * Close shortlists the owner left pending past their lifetime.
 * @param state - the state, changed in place.
 * @param now - the instant.
 */
export function expireShortlists(state: ToolsState, now: Date): void {
  for (const list of state.shortlists) {
    if (list.status === 'pending' && now.getTime() - Date.parse(list.createdAt) > SHORTLIST_LIFETIME_MS) {
      Object.assign(list, { status: 'decided', decidedAt: now.toISOString(), note: `${list.note} (expired unanswered)`.trim() })
      for (const item of list.items) item.approved ??= false
    }
  }
}

/**
 * Apply the owner's decision to a pending shortlist.
 * @param state - the state, changed in place.
 * @param id - the shortlist.
 * @param approved - the item numbers approved.
 * @param via - where the decision came from.
 * @param now - the instant.
 * @returns the approved items' tool names.
 */
export function decide(state: ToolsState, id: string, approved: number[], via: 'page' | 'whatsapp', now: Date): string[] {
  const list = state.shortlists.find(s => s.id === id)
  if (list === undefined) throw new Error('No such shortlist.')
  if (list.status !== 'pending') throw new Error('This shortlist was already decided.')
  for (const item of list.items) item.approved = approved.includes(item.n)
  Object.assign(list, { status: 'decided', decidedAt: now.toISOString(), decidedVia: via })
  return list.items.filter(i => i.approved === true).map(i => i.tool)
}

/**
 * The approved tools not yet published, oldest approval first.
 * @param state - the state.
 * @returns the items with their shortlist.
 */
export function approvedBacklog(state: ToolsState): { list: Shortlist; item: Shortlist['items'][number] }[] {
  return state.shortlists.flatMap(list => list.items
    .filter(i => i.approved === true && i.publishedAt === undefined)
    .map(item => ({ list, item })))
}

function findApproved(state: ToolsState, slug: string): { list: Shortlist; item: Shortlist['items'][number] } | undefined {
  return approvedBacklog(state).find(entry => entry.item.slug === slug)
}

/**
 * Build the tools.
 * @param deps - store, site, research sources, settings and the owner's channel.
 * @returns the tool definitions.
 */
export function buildEmployeeTools(deps: ToolsDeps): ToolDefinition[] {
  const { store, settings, site } = deps
  const cacheMs = (): number => settings.cacheDays() * 86_400_000
  const fresh = (at: string): boolean => deps.now().getTime() - Date.parse(at) < cacheMs()
  const market = (value: unknown): string => (str(value) || settings.markets()[0] || 'GB').toUpperCase()
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

  /** Every fresh autocomplete suggestion for a country. */
  const suggestionsFor = (state: ToolsState, country: string): string[] => [...new Set(Object.entries(state.suggestions)
    .filter(([key, entry]) => key.startsWith(`${country}|`) && fresh(entry.at)).flatMap(([, entry]) => entry.list))]

  const publishedNew = (state: ToolsState): string[] => Object.values(state.tools)
    .filter(t => !t.seed && t.firstPublishedAt !== undefined).map(t => t.firstPublishedAt ?? '')

  const testsCurrent = async (slug: string, record: ToolRecord | undefined): Promise<boolean> =>
    record?.tests?.status === 'passed' && record.tests.hash === await dirHash(site.toolDir(slug))

  return [
    tool({
      name: 'tools_status',
      description: 'The run\'s brief: seeds and markets, approved tools waiting to be built, the pending shortlist, the site\'s tools with their test status, this week\'s pace, today\'s results-page budget, and whether Search Console and Keyword Planner are available. Call it first.',
      parameters: {},
      run: async () => {
        const now = deps.now()
        const state = await store.update((s) => {
          prune(s, now, Math.max(cacheMs(), 14 * 86_400_000))
          expireShortlists(s, now)
          return s
        })
        const backlog = approvedBacklog(state)
        const pending = state.shortlists.find(s => s.status === 'pending')
        const pace = paceRefusal(publishedNew(state), now, settings.timeZone(), settings.maxToolsPerWeek())
        const tools = Object.values(state.tools)
        const gsc = deps.gscProblem()
        return [
          `Seeds: ${settings.seeds().join('; ') || '(none set: choose topics with tier-1 demand yourself)'}.`,
          `Markets: ${settings.markets().join(', ') || 'GB'}.`,
          backlog.length === 0
            ? 'Approved and waiting to be built: none.'
            : `Approved and waiting to be built (do these first, oldest first): ${backlog.map(b => `${b.item.slug} ("${b.item.keyword}")${b.item.builtAt === undefined ? '' : ' [tests passed, ready to publish]'}`).join('; ')}.`,
          pending === undefined ? 'No shortlist is waiting for the owner.' : `Shortlist sent ${pending.createdAt.slice(0, 10)} is waiting for the owner (${pending.items.map(i => i.slug).join(', ')}): do not propose another until it is decided.`,
          `Pace: ${pace ?? `${String(publishedNew(state).filter(at => at !== '').length)} new tools published so far; this week has room (limit ${String(settings.maxToolsPerWeek())} a week).`}`,
          `Google results pages today: ${String(serpsToday(state, now, settings.timeZone()))}/${String(Math.min(MAX_SERPS_PER_DAY, settings.serpPerDay()))}; cached pages are free for ${String(settings.cacheDays())} days.`,
          tools.length === 0 ? 'Site tools: none recorded yet (the seed tools are recorded on the first publish).' : `Site tools: ${tools.map(t => `${t.slug} [${t.firstPublishedAt === undefined ? 'not live' : 'live'}, tests ${t.tests?.status ?? 'not run'}${t.flag === undefined ? '' : `, ${t.flag}`}]`).join('; ')}.`,
          `Site: ${state.siteCheck === undefined ? 'not checked yet (tools_site_status)' : `${state.siteCheck.state}: ${state.siteCheck.detail}`}`,
          `Search Console: ${gsc ?? 'connected'}.`,
          `Recent candidates: ${state.candidates.slice(-8).map(c => `${c.keyword} → ${c.gate.pass ? `pass ${String(c.gate.score)}` : 'fail'}`).join('; ') || 'none'}.`,
        ].join('\n')
      },
    }),
    tool({
      name: 'tools_research_seed',
      description: 'Expand a seed into the phrasings people type into Google (autocomplete), and when the SEO employee\'s Keyword Planner access is set, their monthly search volumes. Autocomplete only suggests phrases enough people search, so a suggestion is demand evidence; it gives no volume. Free and cached. A keyword must be researched here before tools_score_keyword accepts it.',
      parameters: {
        seed: { type: 'string', required: true, description: 'The seed, such as "zakat calculator" or "stamp duty".' },
        market: { type: 'string', description: 'Two-letter country. Defaults to the first market.' },
        expansion: { type: 'string', enum: ['basic', 'questions', 'alphabet'], description: 'basic: the seed alone; questions (default): how/why/what/is/can/best/vs before it; alphabet: the seed followed by a–z (27 requests).' },
        volumes: { type: 'boolean', description: 'Ask Keyword Planner for the seed and the top suggestions (default true when available).' },
      },
      run: async (args, exec) => {
        const seed = norm(str(args['seed']))
        if (seed === '') throw new Error('Give a seed.')
        const country = market(args['market'])
        const expansion: Expansion = args['expansion'] === 'basic' || args['expansion'] === 'alphabet' ? args['expansion'] : 'questions'
        const state = await store.read()
        const queries = expansionQueries(seed, expansion)
        const results = await pooled(queries, 3, async (query) => {
          const key = `${country}|${query}`
          const hit = state.suggestions[key]
          if (hit !== undefined && fresh(hit.at)) return hit.list
          const list = await deps.suggest({ query, source: 'google', country, language: 'en' }, exec.signal)
          await store.update((s) => { s.suggestions[key] = { at: deps.now().toISOString(), list } })
          return list
        })
        const failed = results.filter(r => r instanceof Error)
        const found = [...new Set(results.flatMap(r => (r instanceof Error ? [] : r)))]
        const lines = [`Google autocomplete for "${seed}" (${expansion}, ${country}): ${String(found.length)} distinct suggestions.`, ...found.slice(0, 100).map(s => `- ${s}`)]
        if (failed.length > 0) lines.push(`${String(failed.length)} of ${String(queries.length)} requests failed (${failed[0]?.message ?? ''}).`)
        if (args['volumes'] !== false) {
          const wanted = [seed, ...found.filter(s => s !== seed)].slice(0, 20)
          const cached = new Map<string, number | null>()
          for (const k of wanted) {
            const hit = state.volumes[k]
            if (hit !== undefined && fresh(hit.at)) cached.set(k, hit.volume)
          }
          const missing = wanted.filter(k => !cached.has(k))
          const answer = missing.length === 0 ? undefined : await deps.volumes(missing, exec.signal)
          if (answer !== undefined && !answer.ok) {
            lines.push(`Keyword Planner volumes: not available (${answer.reason}). Demand rests on autocomplete.`)
          } else {
            if (answer?.ok === true) {
              await store.update((s) => { for (const [k, v] of answer.volumes) s.volumes[k] = { at: deps.now().toISOString(), volume: v } })
              for (const [k, v] of answer.volumes) cached.set(k, v)
            }
            lines.push(`Keyword Planner monthly searches${answer?.ok === true ? ` (${answer.market})` : ' (cached)'}:`, ...[...cached].map(([k, v]) => `- ${k}: ${v === null ? 'no data' : `~${String(v)}`}`))
          }
        }
        return lines.join('\n')
      },
    }),
    tool({
      name: 'tools_inspect_serp',
      description: `Read Google's first page for a keyword in the harness's own browser and judge it: rejected when Google answers the query itself (calculator, unit or currency converter, timer, translation, weather, dictionary, sports), open when forums, apps or small sites rank and few dedicated tools exist, hard when government and big-brand sites own it. Also returns "People also ask" (use them as FAQs) and related searches. At most ${String(MAX_SERPS_PER_DAY)} live pages a day, read slowly; cached pages are free for two weeks, so inspect only keywords that passed autocomplete.`,
      parameters: {
        keyword: { type: 'string', required: true, description: 'The exact keyword.' },
        market: { type: 'string', description: 'Two-letter country (gl). Defaults to the first market.' },
      },
      run: async (args, exec) => {
        const keyword = norm(str(args['keyword']))
        if (keyword === '') throw new Error('Give a keyword.')
        const country = market(args['market'])
        const key = `${country}|${keyword}`
        let state = await store.read()
        let entry = state.serpCache[key]
        let cached = entry !== undefined && fresh(entry.at)
        if (entry === undefined || !cached) {
          cached = false
          const now = deps.now()
          const blockedUntil = Math.max(0, ...state.serpLog.filter(at => at.endsWith('#blocked')).map(at => Date.parse(at.slice(0, -8)) + BLOCK_PAUSE_MS))
          if (blockedUntil > now.getTime()) throw new Error(`Google showed a robot check recently; results pages are paused until ${new Date(blockedUntil).toISOString().slice(11, 16)} UTC. Work from cached pages and autocomplete.`)
          const limit = Math.min(MAX_SERPS_PER_DAY, settings.serpPerDay())
          if (serpsToday(state, now, settings.timeZone()) >= limit) {
            throw new Error(`Today's ${String(limit)} Google results pages are used. Work from cached pages and autocomplete; more tomorrow.`)
          }
          const last = Math.max(0, ...state.serpLog.map(at => Date.parse(at.replace(/#blocked$/u, ''))))
          const gap = settings.serpGapMs() * (1 + Math.random() * 0.5)
          const wait = last + gap - now.getTime()
          if (wait > 0) await deps.sleep(wait, exec.signal)
          const at = deps.now().toISOString()
          await store.update((s) => { s.serpLog.push(at) })
          const extract = await deps.readSerp(keyword, country, exec.signal)
          const verdict = serpVerdict(extract)
          if (extract.blocked) {
            await store.update((s) => { s.serpLog.push(`${at}#blocked`) })
            throw new Error('Google showed a robot check instead of results. Results pages pause for six hours; work from cached pages and autocomplete.')
          }
          entry = { at, extract, verdict }
          const saved = entry
          await store.update((s) => { s.serpCache[key] = saved })
          state = await store.read()
        }
        const { extract, verdict } = entry
        return [
          `"${keyword}" in ${country}${cached ? ` (cached ${entry.at.slice(0, 10)})` : ''}: ${verdict.verdict.toUpperCase()}, room ${String(verdict.room)}/10.`,
          ...verdict.reasons.map(r => `- ${r}`),
          'Top results:',
          ...extract.results.slice(0, 10).map((r, i) => `${String(i + 1)}. ${r.title} — ${r.host} [${hostKind(r.host)}]`),
          peopleAsk(extract, keyword).length === 0 ? 'People also ask: none shown.' : `People also ask: ${peopleAsk(extract, keyword).join(' | ')}`,
          extract.related.length === 0 ? '' : `Related searches: ${extract.related.join(' | ')}`,
        ].filter(line => line !== '').join('\n')
      },
    }),
    tool({
      name: 'tools_score_keyword',
      description: `Put a keyword through the gate and save it as a candidate. The plugin decides from the evidence the tools gathered: demand (the keyword appears in Google autocomplete you researched, or Keyword Planner shows 30+ searches a month), a first page inspected in the last two weeks that is open or contested (never one where Google answers itself or big sites own it), evergreen, a tier-1 or tier-2 audience, and what the tool adds over page one. It sets the RPM band from the niche and audience. Niches: ${NICHES.join(', ')}.`,
      parameters: {
        keyword: { type: 'string', required: true, description: 'The main keyword, as researched and inspected.' },
        tool: { type: 'string', required: true, description: 'The tool as a reader would name it, such as "Zakat calculator for business stock".' },
        slug: { type: 'string', required: true, description: 'Its address on the site: lower-case words joined by hyphens, usually the keyword.' },
        niche: { type: 'string', required: true, enum: NICHES, description: 'The advertiser niche, for the RPM band.' },
        markets: { type: 'array', items: { type: 'string' }, description: 'The audience\'s countries, main first. Defaults to the owner\'s markets.' },
        evergreen: { type: 'boolean', required: true, description: 'Whether people will still search this in two years (not a news spike or one-off event).' },
        evergreen_why: { type: 'string', required: true, description: 'The evidence: autocomplete phrasings, a recurring rule (a tax year), a lasting need.' },
        differentiator: { type: 'string', required: true, description: 'What this tool will do that the first page\'s results do not, specifically.' },
      },
      run: async (args) => {
        const keyword = norm(str(args['keyword']))
        const slug = str(args['slug']).toLowerCase()
        const name = str(args['tool'])
        const niche = str(args['niche']) as Niche
        if (keyword === '' || name === '') throw new Error('Give the keyword and the tool\'s name.')
        if (!SLUG.test(slug)) throw new Error(`"${slug}" is not a slug: lower-case words joined by hyphens.`)
        if (!NICHES.includes(niche)) throw new Error(`Unknown niche "${niche}".`)
        const markets = (strings(args['markets']).length > 0 ? strings(args['markets']) : settings.markets()).map(m => m.toUpperCase())
        const state = await store.read()
        if (state.tools[slug] !== undefined || existsSync(site.toolDir(slug))) throw new Error(`tools.linkfa.de/${slug}/ already exists; improve that tool instead of making another.`)
        const taken = state.shortlists.flatMap(s => s.items)
          .find(i => i.slug === slug && i.approved !== false && norm(i.keyword) !== keyword)
        if (taken !== undefined) throw new Error(`The slug ${slug} is already proposed for "${taken.keyword}".`)
        const main = markets[0] ?? 'GB'
        const serp = state.serpCache[`${main}|${keyword}`]
        const volume = state.volumes[keyword]
        const gate = keywordGate({
          keyword,
          demand: {
            suggestions: suggestionsFor(state, main),
            ...volume?.volume === undefined || volume.volume === null ? {} : { volume: volume.volume },
          },
          serp: serp?.verdict,
          serpAt: serp?.at,
          evergreen: { lasting: args['evergreen'] === true, why: str(args['evergreen_why']) },
          niche,
          markets,
          differentiator: str(args['differentiator']),
          now: deps.now(),
          serpMaxAgeDays: 14,
        })
        const candidate: Candidate = {
          id: randomBytes(5).toString('hex'), keyword, tool: name, slug, niche, markets,
          suggestions: suggestionsFor(state, main).filter(s => keyword.split(' ').filter(w => w.length > 2).some(w => s.includes(w))).slice(0, 30),
          ...volume?.volume === undefined || volume.volume === null ? {} : { volume: volume.volume },
          serpVerdict: serp?.verdict ?? { verdict: 'unknown', room: 0, forums: 0, platforms: 0, strong: 0, tools: 0, aiOverview: false, reasons: [] },
          serpAt: serp?.at ?? '',
          questions: serp === undefined ? [] : peopleAsk(serp.extract, keyword),
          hosts: serp?.extract.results.map(r => r.host).slice(0, 10) ?? [],
          evergreen: { lasting: args['evergreen'] === true, why: str(args['evergreen_why']) },
          differentiator: str(args['differentiator']),
          gate, savedAt: deps.now().toISOString(), runId: state.runs.at(-1)?.id ?? '',
        }
        await store.update((s) => {
          s.candidates = s.candidates.filter(c => !(c.keyword === keyword && c.slug === slug))
          s.candidates.push(candidate)
        })
        return [
          gate.pass
            ? `PASS: "${keyword}" → ${name} (candidate ${candidate.id}), score ${String(gate.score)}/100, difficulty ${String(gate.difficulty)}/10, RPM ${rpmText(gate.rpm)} (estimate).`
            : `FAIL: "${keyword}" (candidate ${candidate.id} kept for the record).`,
          ...gate.failures.map(f => `- ✗ ${f}`),
          ...gate.reasons.map(r => `- ${r}`),
        ].join('\n')
      },
    }),
    tool({
      name: 'tools_list_candidates',
      description: 'Candidates saved in the last 30 days, passing ones first by score, with their gate result.',
      parameters: { passing_only: { type: 'boolean', description: 'Only candidates that pass the gate.' } },
      run: async (args) => {
        const now = deps.now().getTime()
        const list = (await store.read()).candidates
          .filter(c => now - Date.parse(c.savedAt) < 30 * 86_400_000 && (args['passing_only'] !== true || c.gate.pass))
          .sort((a, b) => Number(b.gate.pass) - Number(a.gate.pass) || b.gate.score - a.gate.score)
        if (list.length === 0) return 'No candidates yet.'
        return list.map(c => `- ${c.id} ${c.gate.pass ? `PASS ${String(c.gate.score)}` : 'FAIL'} "${c.keyword}" → ${c.tool} (/${c.slug}/), ${c.serpVerdict.verdict}, ${c.markets[0] ?? ''} RPM ${rpmText(c.gate.rpm)}, difficulty ${String(c.gate.difficulty)}${c.gate.pass ? '' : `: ${c.gate.failures[0] ?? ''}`}`).join('\n')
      },
    }),
    tool({
      name: 'tools_propose_shortlist',
      description: `Send the owner a shortlist of 1–${String(MAX_SHORTLIST)} candidates that passed the gate, as a signed review page on WhatsApp where they tick which to build (or reply "build 1,3"). Nothing is built until they approve. Refused while another shortlist waits for an answer.`,
      parameters: {
        candidate_ids: { type: 'array', items: { type: 'string' }, required: true, description: 'Candidate ids, best first.' },
        note: { type: 'string', description: 'One or two sentences for the owner: the week\'s theme or why these.' },
      },
      run: async (args) => {
        const ids = [...new Set(strings(args['candidate_ids']))]
        if (ids.length === 0 || ids.length > MAX_SHORTLIST) throw new Error(`Give 1 to ${String(MAX_SHORTLIST)} candidate ids.`)
        const now = deps.now()
        const list = await store.update((s) => {
          expireShortlists(s, now)
          if (s.shortlists.some(l => l.status === 'pending')) throw new Error('A shortlist is already waiting for the owner; it must be decided (or expire after two weeks) first.')
          const problems: string[] = []
          const picked = ids.map((id) => {
            const c = s.candidates.find(x => x.id === id)
            if (c === undefined) problems.push(`No candidate ${id}.`)
            else if (!c.gate.pass) problems.push(`${id} ("${c.keyword}") did not pass the gate.`)
            else if (now.getTime() - Date.parse(c.serpAt) > 14 * 86_400_000) problems.push(`${id}: its first page was read over two weeks ago; inspect it again.`)
            else if (s.tools[c.slug] !== undefined) problems.push(`${id}: /${c.slug}/ is already on the site.`)
            else if (approvedBacklog(s).some(b => b.item.slug === c.slug)) problems.push(`${id}: /${c.slug}/ is already approved.`)
            return c
          })
          if (problems.length > 0) throw new Error(`Not sent:\n- ${problems.join('\n- ')}`)
          const shortlist: Shortlist = {
            id: randomBytes(6).toString('hex'), tag: `#t${randomBytes(2).toString('hex')}`, createdAt: now.toISOString(), sent: '', status: 'pending',
            note: str(args['note']),
            items: picked.flatMap(c => (c === undefined ? [] : [c])).map((c, i) => ({
              n: i + 1, candidateId: c.id, slug: c.slug, tool: c.tool, keyword: c.keyword,
              verdict: `${c.serpVerdict.verdict} (room ${String(c.serpVerdict.room)}/10): ${c.serpVerdict.reasons.slice(0, 2).join(' ')}`,
              demand: c.volume === undefined ? `autocomplete suggests it (${String(c.suggestions.length)} related phrasings)` : `~${String(c.volume)} searches/month (Keyword Planner)`,
              market: c.markets.join(', '), rpm: rpmText(c.gate.rpm), difficulty: c.gate.difficulty, score: c.gate.score,
              differentiator: c.differentiator, approved: null,
            })),
          }
          s.shortlists.push(shortlist)
          return shortlist
        })
        const sent = await deps.notify(shortlistMessage(list, deps.shortlistLink(list.id)))
        await store.update((s) => {
          const live = s.shortlists.find(l => l.id === list.id)
          if (live !== undefined) live.sent = sent
        })
        return [`Shortlist sent: ${deps.shortlistLink(list.id)}`, `WhatsApp: ${sent}.`, 'Wait for the owner; nothing is built before approval. Continue with Search Console work or finish the run with tools_report.'].join('\n')
      },
    }),
    tool({
      name: 'tools_build_scaffold',
      description: 'Start building an approved tool: creates tools/<slug>/ in the site working copy with tool.json, content.html, form.html, logic.mjs, ui.mjs and logic.test.mjs to fill in, and returns the paths and the research to write from. Only for tools the owner approved.',
      parameters: {
        slug: { type: 'string', required: true, description: 'The approved tool\'s slug.' },
        category: { type: 'string', required: true, description: 'A category id from site.config.json (islamic-finance, uk-tax, money, conversions, dates), or a new id given with new_category_label.' },
        new_category_label: { type: 'string', description: 'Label for a new category, such as "Health".' },
        new_category_intro: { type: 'string', description: 'One-sentence intro for a new category.' },
      },
      run: async (args) => {
        const slug = str(args['slug']).toLowerCase()
        const state = await store.read()
        const approved = findApproved(state, slug)
        if (approved === undefined) throw new Error(`/${slug}/ is not an approved tool waiting to be built. tools_status lists them.`)
        const candidate = state.candidates.find(c => c.id === approved.item.candidateId)
        const note = await site.ensure()
        const category = str(args['category']).toLowerCase()
        const label = str(args['new_category_label'])
        if (label !== '') await site.addCategory({ id: category, label, intro: str(args['new_category_intro']) || label })
        const dir = site.toolDir(slug)
        const existed = existsSync(dir)
        if (!existed) {
          await site.scaffold({
            slug, title: approved.item.tool.slice(0, 60), h1: approved.item.tool, category, keyword: approved.item.keyword,
            today: localTime(deps.now(), 'UTC').date,
          })
        }
        return [
          `${existed ? 'Already started' : 'Created'}: ${dir} (${note}).`,
          'Files: tool.json (title ≤60, description 70–160, intro, differentiator, sources with checked dates, 3+ FAQs), content.html (h2 ids what/how/example, 350+ words),',
          'form.html (labelled controls, aria-live result), logic.mjs (pure exported functions), ui.mjs (imports ./logic.mjs), logic.test.mjs (3+ known-answer node:test cases).',
          `Keyword: "${approved.item.keyword}". Better because: ${approved.item.differentiator}`,
          candidate === undefined ? '' : `People also ask (FAQs): ${candidate.questions.join(' | ') || 'none recorded'}.`,
          candidate === undefined ? '' : `Page one today: ${candidate.hosts.join(', ')}. Related phrasings: ${candidate.suggestions.slice(0, 15).join('; ')}.`,
          `Existing tools to link as related and to copy conventions from: ${(await site.slugs()).filter(s => s !== slug).join(', ')}.`,
          'Write the tests first, then the logic; verify every rate or rule at its official source and date it. Then tools_run_tests.',
        ].filter(line => line !== '').join('\n')
      },
    }),
    tool({
      name: 'tools_run_tests',
      description: 'Run a tool\'s known-answer tests and the site build\'s quality checks for it (sections, word count, FAQs, dated sources, labelled form, near-duplicates). The result is recorded against the tool\'s current files: any later edit needs a new run before publishing.',
      parameters: { slug: { type: 'string', required: true, description: 'The tool.' } },
      run: async (args) => {
        const slug = str(args['slug']).toLowerCase()
        if (!SLUG.test(slug) || !existsSync(site.toolDir(slug))) throw new Error(`No tool tools/${slug} in the working copy.`)
        await site.ensure()
        const tests = await site.test(slug)
        const report = await site.check()
        const mine = report.problems.filter(p => p.startsWith(`tools/${slug}`) || !p.startsWith('tools/'))
        const passed = tests.ok && mine.length === 0
        const hash = await dirHash(site.toolDir(slug))
        const at = deps.now().toISOString()
        await store.update((s) => {
          const record = s.tools[slug] ?? { slug, title: slug, keyword: '', seed: deps.seedSlugs().includes(slug) }
          record.tests = { status: passed ? 'passed' : 'failed', at, hash, output: tests.output.slice(-2000) }
          const meta = report.tools.find(t => t.slug === slug)
          if (meta !== undefined) Object.assign(record, { title: meta.title, keyword: meta.keyword })
          s.tools[slug] = record
          const approved = findApproved(s, slug)
          if (approved !== undefined) {
            if (passed) approved.item.builtAt = at
            else delete approved.item.builtAt
          }
        })
        return [
          passed ? `PASSED: ${slug} tests and checks pass; publish it with tools_publish.` : 'FAILED: fix these, then run again.',
          `Tests (${tests.ok ? 'pass' : 'fail'}):`,
          tests.output.slice(-3500),
          mine.length === 0 ? 'Build checks: none failing.' : `Build checks:\n- ${mine.join('\n- ')}`,
        ].join('\n')
      },
    }),
    tool({
      name: 'tools_publish',
      description: 'Publish the site: refreshes the framework, runs every tool\'s tests and the build\'s checks (all must pass), commits, pushes to the site repository the Dokploy app builds from, and asks Dokploy to deploy. With a slug it publishes that approved tool (its recorded tests must match its current files; a new tool counts against the weekly pace) or an update to a live one; without, it republishes the site as is.',
      parameters: { slug: { type: 'string', description: 'The new or updated tool; omit to republish the site.' } },
      run: async (args) => {
        const slug = str(args['slug']).toLowerCase()
        const now = deps.now()
        let state = await store.read()
        await site.ensure()
        const seeds = deps.seedSlugs()
        let isNew = false
        if (slug !== '') {
          if (!existsSync(site.toolDir(slug))) throw new Error(`No tool tools/${slug} in the working copy.`)
          const record = state.tools[slug]
          const approved = findApproved(state, slug)
          const live = record?.firstPublishedAt !== undefined
          if (!live && approved === undefined && !seeds.includes(slug)) throw new Error(`/${slug}/ was not approved by the owner; propose it in a shortlist first.`)
          isNew = !live && !seeds.includes(slug)
          if (isNew) {
            const refusal = paceRefusal(publishedNew(state), now, settings.timeZone(), settings.maxToolsPerWeek())
            if (refusal !== undefined) throw new Error(refusal)
          }
          if (!await testsCurrent(slug, record)) throw new Error(`${slug}'s files changed since its last passing tools_run_tests (or it never passed); run it again.`)
        }
        const all = await site.test()
        if (!all.ok) throw new Error(`Not published: a test fails.\n${all.output.slice(-3000)}`)
        // Every test just passed, so each tool's record moves to its current files.
        const tested = new Map<string, string>()
        for (const each of await site.slugs()) tested.set(each, await dirHash(site.toolDir(each)))
        const report = await site.check()
        if (!report.ok) throw new Error(`Not published: the build refuses:\n- ${report.problems.join('\n- ')}`)
        const built = await site.build()
        if (!built.ok) throw new Error(`Not published: the build failed:\n- ${built.problems.join('\n- ')}`)
        const meta = report.tools.find(t => t.slug === slug)
        const { commit, changed } = await site.commit(slug === '' ? 'Update the site' : `${isNew ? 'Add' : 'Update'} ${meta?.h1 ?? slug}`)
        const pushed = await site.push()
        const ok = pushed.startsWith('pushed')
        const deploy = ok ? await site.deploy(deps.fetch) : 'not deployed: nothing was pushed'
        const at = now.toISOString()
        await store.update((s) => {
          for (const t of report.tools) {
            const record = s.tools[t.slug] ?? { slug: t.slug, title: t.title, keyword: t.keyword, seed: seeds.includes(t.slug) }
            Object.assign(record, { title: t.title, keyword: t.keyword })
            const hash = tested.get(t.slug)
            if (hash !== undefined) record.tests = { status: 'passed', at, hash, output: 'Passed with every other test at publish.' }
            if (ok && (record.seed || t.slug === slug || record.firstPublishedAt !== undefined)) {
              record.firstPublishedAt ??= at
              record.lastPublishedAt = at
            }
            s.tools[t.slug] = record
          }
          const approved = slug === '' ? undefined : findApproved(s, slug)
          if (approved !== undefined && ok) approved.item.publishedAt = at
          s.publish = { at, version: built.version, commit, pushed, deploy }
        })
        state = await store.read()
        const url = `${settings.siteUrl()}/${slug === '' ? '' : `${slug}/`}`
        const told = ok && isNew ? await deps.notify(`Tools employee: published ${meta?.h1 ?? slug} → ${url} (live in a few minutes, after Dokploy builds it).`) : 'no message (not a new live tool)'
        return [
          `Built version ${built.version} with ${String(report.tools.length)} tools; commit ${commit}${changed ? '' : ' (nothing changed)'}.`,
          `Push: ${pushed}. Deploy: ${deploy}.`,
          ok ? `Check it with tools_site_status in a few minutes: ${url}` : 'The site stays local until the site repository and token are set (the owner\'s one-time setup); the build is kept for the preview.',
          `Owner: ${told}.`,
          `This week: ${String(publishedNew(state).filter(p => p !== '').length)} new tools published in total so far.`,
        ].join('\n')
      },
    }),
    tool({
      name: 'tools_site_status',
      description: 'Check the live site: whether tools.linkfa.de serves the latest build (or is not deployed yet), the standing pages, and AdSense readiness (published tools with passing tests, pages, Search Console traffic). Tells the owner once when it is time to apply for AdSense.',
      parameters: {},
      run: async () => {
        const state = await store.read()
        const base = settings.siteUrl()
        const check = await liveCheck(deps.fetch, base, state.publish?.version)
        let pages: Record<string, boolean> | undefined
        if (check.state === 'live' || check.state === 'outdated') {
          pages = {}
          for (const path of ['/about/', '/contact/', '/privacy/', '/terms/', '/sitemap.xml', '/robots.txt']) {
            try {
              const response = await deps.fetch(`${base}${path}`, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(15_000) })
              pages[path] = response.status === 200
            } catch {
              // A page that does not answer counts as missing.
              pages[path] = false
            }
          }
        }
        const at = deps.now().toISOString()
        const clicks = state.gsc?.totals.clicks
        const readiness = adsenseReadiness({
          site: { at, ...check }, pages, tools: Object.values(state.tools), clicks28: deps.gscProblem() === undefined ? clicks : undefined,
          clientSet: settings.adsenseClient() !== '', rules: settings.readiness(),
        })
        const notifyNow = readiness.ready && settings.adsenseClient() === '' && state.adsenseToldAt === undefined
        await store.update((s) => {
          s.siteCheck = { at, ...check }
          if (pages !== undefined) s.pages = pages
          if (notifyNow) s.adsenseToldAt = at
        })
        const told = notifyNow ? await deps.notify(`Tools employee: tools.linkfa.de is ready for AdSense. ${readiness.verdict}`) : ''
        return [
          `Site: ${check.state}. ${check.detail}`,
          pages === undefined ? '' : `Standing pages: ${Object.entries(pages).map(([p, ok]) => `${p} ${ok ? 'ok' : 'MISSING'}`).join(', ')}.`,
          `Last publish: ${state.publish === undefined ? 'never' : `${state.publish.at.slice(0, 16)} version ${state.publish.version}: ${state.publish.pushed}; ${state.publish.deploy}`}.`,
          `AdSense: ${readiness.verdict}`,
          ...readiness.checks.map(c => `- ${c.ok ? '✓' : '✗'} ${c.label}: ${c.detail}`),
          told === '' ? '' : `Owner told: ${told}.`,
        ].filter(line => line !== '').join('\n')
      },
    }),
    tool({
      name: 'tools_gsc_review',
      description: 'The weekly Search Console review of the live tools: striking-distance queries (positions 5–20: improve the page for them), queries with many impressions but few clicks for their position (rewrite the title and description), and tools with no impressions months after launch (improve substantially or prune). Says so plainly when Search Console is not connected.',
      parameters: {},
      run: async (_args, exec) => {
        const problem = deps.gscProblem()
        if (problem !== undefined) return `Search Console is not connected: ${problem}. Skip the review and say so in the report.`
        const state = await store.read()
        const base = settings.siteUrl()
        const tools = Object.values(state.tools).map(t => ({ slug: t.slug, url: `${base}/${t.slug}/`, ...t.firstPublishedAt === undefined ? {} : { publishedAt: t.firstPublishedAt } }))
        const rows = await deps.searchConsole(exec.signal)
        const result = review({
          property: rows.property, queryPages: rows.queryPages, pages90: rows.pages90, tools, now: deps.now(), rules: settings.review(),
        })
        await store.update((s) => {
          s.gsc = result.review
          for (const [slug, numbers] of result.perTool) {
            const record = s.tools[slug]
            if (record === undefined) continue
            const { clicks, impressions, ctr, position } = numbers
            record.gsc = { at: result.review.at, clicks, impressions, ctr, position }
            if (numbers.flag === undefined) delete record.flag
            else record.flag = numbers.flag
          }
        })
        const r = result.review
        return [
          `Search Console ${r.property}, last 28 days: ${String(r.totals.clicks)} clicks, ${String(r.totals.impressions)} impressions.`,
          r.striking.length === 0 ? 'Striking distance: none yet.' : 'Striking distance (positions 5–20): add what the query asks for to that page — a section, an FAQ, an input:',
          ...r.striking.slice(0, 15).map(s => `- "${s.query}" → ${s.page}: position ${String(s.position)}, ${String(s.impressions)} impressions`),
          r.lowCtr.length === 0 ? 'Low click-through: none.' : 'Low click-through for the position (rewrite the title and description to match the query):',
          ...r.lowCtr.slice(0, 10).map(s => `- "${s.query}" → ${s.page}: position ${String(s.position)}, CTR ${(s.ctr * 100).toFixed(1)}% over ${String(s.impressions)} impressions`),
          r.prune.length === 0 ? 'Pruning: no tool is old enough without impressions.' : `Flag for pruning (no impressions after ${String(settings.review().pruneAfterDays)} days): ${r.prune.join(', ')}. Tell the owner; do not delete without approval.`,
        ].join('\n')
      },
    }),
    tool({
      name: 'tools_report',
      description: 'Finish the run: send the owner a short WhatsApp summary (shortlist sent, tools built and published, Search Console findings or that it is not connected, AdSense readiness, anything blocked) and close the run. Call it last, once.',
      parameters: { summary: { type: 'string', required: true, description: 'What this run did and found, in 3–8 short lines, with numbers.' } },
      run: async (args) => {
        const summary = str(args['summary'])
        if (summary.length < 40) throw new Error('Write the summary (at least 40 characters).')
        const now = deps.now()
        const state = await store.read()
        const run = state.runs.at(-1)
        const gsc = deps.gscProblem()
        const text = [
          `Tools employee, ${localTime(now, settings.timeZone()).date}:`,
          summary,
          gsc === undefined ? '' : `Search Console: not connected (${gsc}).`,
          state.siteCheck === undefined ? '' : `Site: ${state.siteCheck.state}.`,
        ].filter(line => line !== '').join('\n')
        const sent = await deps.notify(text)
        await store.update((s) => {
          const live = s.runs.find(r => r.id === run?.id)
          if (live !== undefined && live.finishedAt === undefined) live.finishedAt = now.toISOString()
        })
        return `Report sent: ${sent}. The run is finished. Stop here.`
      },
    }),
  ]
}
