/**
 * The YouTube niche scout against stand-ins: outlier scoring, the quota budget, autocomplete parsing, the weekly
 * schedule and the run-now gap, the report page, and what the tools refuse and record. YouTube and autocomplete are
 * fakes; nothing leaves the process.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  buildScoutTools, channelIsOutlier, expansionQueries, monetization, nicheScore, parseChannel, parseDuration, parseSuggestions,
  parseWeekday, policyRisk, quotaCharger, quotaDay, quotaRefusal, rankChanges, reportMessage, reportPage, runNowRefusal, ScoutStore,
  videoOutlier, weeklyDue, youTube, QuotaExhausted,
} from '../src/index.ts'
import type { ChannelInfo, NicheRecord, ReportRecord, VideoInfo } from '../src/index.ts'

const exec = { signal: new AbortController().signal } as ToolRunContext
const NOW = new Date('2026-10-03T12:00:00Z')
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function tempStore(): ScoutStore {
  const dir = mkdtempSync(join(tmpdir(), 'yns-'))
  dirs.push(dir)
  return new ScoutStore(join(dir, 'state.json'))
}

const YOUNG: ChannelInfo = { id: 'UCyoungyoungyoungyoung01', title: 'Young Explainers', createdAt: '2026-05-01T00:00:00Z', subscribers: 12_000, videos: 20, views: 2_400_000 }
const OLD: ChannelInfo = { id: 'UColdoldoldoldoldoldold1', title: 'Big Old Channel', createdAt: '2015-01-01T00:00:00Z', subscribers: 2_000_000, videos: 900, views: 400_000_000 }
const video = (id: string, channel: ChannelInfo, views: number, seconds = 600): VideoInfo => ({
  id, title: `Video ${id}`, channelId: channel.id, channelTitle: channel.title, publishedAt: '2026-09-20T00:00:00Z', seconds, views,
})

describe('outlier scoring', () => {
  it('marks a young channel\'s video with many times its subscribers as strong, and a big channel\'s ordinary hit as none', () => {
    expect(videoOutlier(video('a', YOUNG, 300_000), YOUNG, NOW).tier).toBe('strong')
    expect(videoOutlier(video('b', YOUNG, 15_000), YOUNG, NOW).tier).toBe('none')
    expect(videoOutlier(video('c', OLD, 900_000), OLD, NOW).tier).toBe('none')
    expect(videoOutlier(video('a', YOUNG, 300_000), YOUNG, NOW).ratio).toBe(25)
  })

  it('reads a channel with a hidden count against its own average', () => {
    const { subscribers: _subscribers, ...shown } = OLD
    const hidden: ChannelInfo = { ...shown, videos: 100, views: 1_000_000 }
    const o = videoOutlier(video('h', hidden, 80_000), hidden, NOW)
    expect([o.ratio, o.vsAverage, o.tier]).toEqual([undefined, 8, 'moderate'])
  })

  it('counts a whole channel as an outlier only when young, small and fast', () => {
    expect(channelIsOutlier(YOUNG, NOW)).toBe(true)
    expect(channelIsOutlier(OLD, NOW)).toBe(false)
    expect(channelIsOutlier({ ...YOUNG, views: 100_000 }, NOW)).toBe(false)
  })
})

describe('money, risk and the score', () => {
  it('adjusts the RPM band for the audience\'s countries', () => {
    expect(monetization('personal-finance', ['US']).rpm).toEqual([12, 30])
    expect(monetization('personal-finance', ['US']).score).toBe(10)
    expect(monetization('personal-finance', ['NG']).rpm).toEqual([2.4, 6])
    expect(monetization('entertainment', ['US']).score).toBe(3)
  })

  it('raises policy risk to the category floor and to 7 for others\' footage', () => {
    expect(policyRisk('kids', 2, false)).toBe(9)
    expect(policyRisk('tech', 2, false)).toBe(2)
    expect(policyRisk('tech', 2, true)).toBe(7)
  })

  it('weighs the parts into a score out of 100', () => {
    expect(nicheScore({ demand: 10, outliers: 10, rpm: 10, competition: 10, policyRisk: 0, productionFit: 10 })).toBe(100)
    expect(nicheScore({ demand: 0, outliers: 0, rpm: 0, competition: 0, policyRisk: 10, productionFit: 0 })).toBe(0)
    expect(nicheScore({ demand: 5, outliers: 5, rpm: 5, competition: 5, policyRisk: 5, productionFit: 5 })).toBe(50)
  })
})

describe('quota', () => {
  it('refuses past the day\'s units and past the run\'s search cap, but lets 1-unit reads through the cap', () => {
    const base = { method: 'search' as const, cost: 100, usedToday: 0, dailyLimit: 10_000, searchesThisRun: 0, searchesPerRun: 20 }
    expect(quotaRefusal(base)).toBeUndefined()
    expect(quotaRefusal({ ...base, usedToday: 9950 })).toMatch(/50 of 10000/u)
    expect(quotaRefusal({ ...base, searchesThisRun: 20 })).toMatch(/20 topic searches/u)
    expect(quotaRefusal({ ...base, method: 'videos', cost: 1, searchesThisRun: 20 })).toBeUndefined()
  })

  it('uses the Pacific day', () => {
    expect(quotaDay(new Date('2026-10-03T06:00:00Z'))).toBe('2026-10-02')
    expect(quotaDay(new Date('2026-10-03T08:00:00Z'))).toBe('2026-10-03')
  })

  it('records spent units and refuses without writing when over budget', async () => {
    const store = tempStore()
    const charge = quotaCharger(store, { dailyQuota: () => 150, searchesPerRun: () => 5 }, () => NOW)
    await charge(100, 'search')
    await charge(1, 'videos')
    await expect(charge(100, 'search')).rejects.toBeInstanceOf(QuotaExhausted)
    const state = await store.read()
    expect(state.quota[quotaDay(NOW)]).toBe(101)
    expect([state.runs.length, state.runs[0]?.searches, state.runs[0]?.units]).toEqual([1, 1, 101])
  })

  it('charges before calling YouTube, so a refused call is never made', async () => {
    let calls = 0
    const client = youTube({
      key: () => 'k',
      charge: () => Promise.reject(new QuotaExhausted('no room')),
      fetch: () => { calls++; return Promise.resolve(new Response('{}')) },
    })
    await expect(client.search({ query: 'x', duration: 'medium', publishedAfter: NOW.toISOString() }, exec.signal)).rejects.toThrow('no room')
    expect(calls).toBe(0)
  })
})

describe('YouTube answers', () => {
  it('reads durations and channels', () => {
    expect([parseDuration('PT12M3S'), parseDuration('PT1H'), parseDuration('P1DT1S'), parseDuration('nonsense')]).toEqual([723, 3600, 86_401, 0])
    expect(parseChannel({
      id: 'UCx', snippet: { title: 'X', publishedAt: '2026-01-01T00:00:00Z', customUrl: '@x' },
      statistics: { hiddenSubscriberCount: true, subscriberCount: '0', videoCount: '12', viewCount: '3400' },
      contentDetails: { relatedPlaylists: { uploads: 'UUx' } },
    })).toEqual({ id: 'UCx', title: 'X', handle: '@x', createdAt: '2026-01-01T00:00:00Z', videos: 12, views: 3400, uploads: 'UUx' })
  })

  it('names YouTube\'s refusal reason', async () => {
    const client = youTube({
      key: () => 'k',
      charge: () => Promise.resolve(),
      fetch: () => Promise.resolve(new Response(JSON.stringify({ error: { message: 'quota', errors: [{ reason: 'quotaExceeded' }] } }), { status: 403 })),
    })
    await expect(client.videos(['a'], exec.signal)).rejects.toMatchObject({ status: 403, reason: 'quotaExceeded' })
  })
})

describe('autocomplete', () => {
  it('reads both the JSON and the JSONP answers', () => {
    expect(parseSuggestions('["ai news",["ai news today","AI News Today","ai news funny"],[],{}]')).toEqual(['ai news today', 'ai news funny'])
    expect(parseSuggestions('window.google.ac.h(["ai news",[["ai news",0,[512]],["ai news anchor",0,[512]]],{"k":1}])')).toEqual(['ai news', 'ai news anchor'])
    expect(parseSuggestions('<html>blocked</html>')).toEqual([])
  })

  it('expands a seed', () => {
    expect(expansionQueries('  AI  Tools ', 'basic')).toEqual(['ai tools'])
    expect(expansionQueries('ai tools', 'questions')[1]).toBe('how ai tools')
    expect(expansionQueries('ai tools', 'alphabet')).toHaveLength(27)
  })
})

describe('schedule and run-now gap', () => {
  it('is due once the week\'s slot has passed and no run started since', () => {
    // 2026-10-05 is a Monday.
    expect(parseWeekday('Mon')).toBe(1)
    expect(weeklyDue({ date: '2026-10-05', minutes: 8 * 60 }, 1, 9 * 60, '2026-09-28')).toBe(false)
    expect(weeklyDue({ date: '2026-10-05', minutes: 9 * 60 }, 1, 9 * 60, '2026-09-28')).toBe(true)
    expect(weeklyDue({ date: '2026-10-05', minutes: 10 * 60 }, 1, 9 * 60, '2026-10-05')).toBe(false)
    expect(weeklyDue({ date: '2026-10-07', minutes: 0 }, 1, 9 * 60, '2026-09-28')).toBe(true)
    expect(weeklyDue({ date: '2026-10-07', minutes: 0 }, 1, 9 * 60, null)).toBe(true)
  })

  it('refuses a second run within the gap', () => {
    const gap = 15 * 60_000
    expect(runNowRefusal(1_000_000, 0, gap)).toBeUndefined()
    expect(runNowRefusal(1_000_000 + 5 * 60_000, 1_000_000, gap)).toMatch(/5 minutes ago.*10 minutes/u)
    expect(runNowRefusal(1_000_000 + gap, 1_000_000, gap)).toBeUndefined()
  })
})

function niche(name: string, score: number): NicheRecord {
  return {
    name, category: 'tech', keywords: [name], markets: ['US'], parts: { demand: 5, outliers: 5, rpm: 7, competition: 5, policyRisk: 2, productionFit: 7 },
    evidence: { demand: 'd', outliers: 'o', rpm: 'r', competition: 'c', policyRisk: 'p', productionFit: 'f' },
    rpm: [8, 18], score, examples: [{ id: YOUNG.id, title: YOUNG.title, note: '25× subs' }], reliesOnOthersFootage: false, gaps: '', savedAt: NOW.toISOString(),
  }
}

describe('report', () => {
  it('lists what moved since last week', () => {
    expect(rankChanges(undefined, [])).toEqual(['First report: nothing to compare with yet.'])
    expect(rankChanges([niche('A', 70), niche('B', 60), niche('C', 50)], [niche('B', 72), niche('A', 70), niche('D', 40)])).toEqual([
      'B: #2 → #1, score 60 → 72.', 'A: #1 → #2, score 70 → 70.', 'New: D at #3 (40).', 'Dropped: C (was 50).',
    ])
  })

  it('renders the page escaped, with the pick, the evidence and the ideas', () => {
    const report: ReportRecord = {
      id: 'abcdef12', runId: 'r', createdAt: NOW.toISOString(), summary: 'Tech <b>wins</b>.',
      recommendation: { niche: 'AI tools', why: 'Young channels get 25× their subscribers.', firstSteps: ['Make ten scripts'] },
      niches: [niche('AI tools', 74), niche('History', 60)], ideas: [{ niche: 'AI tools', titles: ['5 AI tools that replace a VA'] }],
      risks: '', method: 'autocomplete and outlier searches', changes: [], searches: 3, units: 306,
    }
    const page = reportPage(report, [{ createdAt: '2026-09-26T00:00:00Z', niche: 'History', link: '/yns/r/x?sig=y' }])
    expect(page).toContain('Tech &lt;b&gt;wins&lt;/b&gt;.')
    expect(page).toContain('Recommendation: AI tools')
    expect(page).toContain('https://www.youtube.com/channel/UCyoungyoungyoungyoung01')
    expect(page).toContain('5 AI tools that replace a VA')
    expect(page).toContain('$8–18')
    expect(reportMessage(report, 'https://h/yns/r/abcdef12?sig=s')).toMatch(/Recommendation: AI tools \(score 74\/100, RPM \$8–18\)[\s\S]*https:\/\/h\/yns\/r\/abcdef12\?sig=s/u)
  })
})

describe('tools', () => {
  function setup() {
    const store = tempStore()
    const announced: ReportRecord[] = []
    const calls: string[] = []
    const fake = {
      search: () => { calls.push('search'); return Promise.resolve({ videoIds: ['v1', 'v2'], totalResults: 12_345 }) },
      videos: () => { calls.push('videos'); return Promise.resolve([video('v1', YOUNG, 300_000), video('v2', OLD, 500_000, 1500)]) },
      channels: () => { calls.push('channels'); return Promise.resolve([YOUNG, OLD]) },
      uploads: () => Promise.resolve([]),
    }
    const tools = new Map(buildScoutTools({
      store,
      youtube: fake,
      suggest: ({ query }) => Promise.resolve([`${query} 2026`, `${query} explained`]),
      settings: {
        seeds: () => ['ai tools'], markets: () => ['US'], languages: () => ['en'], dailyQuota: () => 10_000, searchesPerRun: () => 20,
        windowDays: () => 90, maxChannelAgeMonths: () => 12, cacheDays: () => 6,
      },
      now: () => NOW,
      reportLink: id => `https://h/yns/r/${id}?sig=s`,
      announce: (report) => { announced.push(report); return Promise.resolve('sent to owner') },
    }).map((t: ToolDefinition) => [t.name, t]))
    const run = async (name: string, args: Record<string, unknown> = {}): Promise<string> => {
      const tool = tools.get(name)
      if (tool === undefined) throw new Error(`no ${name}`)
      return (await tool.execute(args, exec) as { text: string }).text
    }
    return { store, run, announced, calls }
  }

  const part = (score: number) => ({ score, why: 'evidence with numbers from the tools' })
  const save = (name: string, extra: Record<string, unknown> = {}) => ({
    name, category: 'tech', keywords: [name], demand: part(6), outliers: part(3), competition: part(5), policy_risk: part(2), production_fit: part(8),
    relies_on_others_footage: false, ...extra,
  })

  it('marks outliers in a search and reuses the cached search for free', async () => {
    const { run, calls } = setup()
    const first = await run('yns_search_outliers', { seed: 'AI tools' })
    expect(first).toMatch(/\[strong\] "Video v1" — 300k views \(25\.0× subs/u)
    expect(first).toContain('Young Explainers (UCyoungyoungyoungyoung01)')
    expect(first).toContain('50% are 8–15 minutes')
    const second = await run('yns_search_outliers', { seed: 'ai tools' })
    expect(second).toContain('no quota spent')
    expect(calls.filter(c => c === 'search')).toHaveLength(1)
  })

  it('expands keywords from autocomplete', async () => {
    const { run } = setup()
    expect(await run('yns_keywords', { seed: 'ai tools', expansion: 'basic' })).toContain('YouTube: 2 distinct suggestions.\n- ai tools 2026')
  })

  it('refuses a niche citing a channel the tools never read, and scores one that cites a real one', async () => {
    const { run, store } = setup()
    await expect(run('yns_save_niche', save('AI tools', { outliers: part(8) }))).rejects.toThrow(/needs at least one example channel/u)
    await expect(run('yns_save_niche', save('AI tools', { example_channels: [{ id: 'UCmadeupmadeupmadeupmad', note: 'x' }] }))).rejects.toThrow(/was not read/u)
    await run('yns_search_outliers', { seed: 'ai tools' })
    const saved = await run('yns_save_niche', save('AI tools', { outliers: part(8), example_channels: [{ id: YOUNG.id, note: '300k views on 12k subs' }] }))
    expect(saved).toMatch(/Saved "AI tools": \d+(\.\d)?\/100/u)
    const run0 = (await store.read()).runs.at(-1)
    expect(run0?.niches[0]?.examples[0]?.title).toBe('Young Explainers')
  })

  it('refuses a thin report and announces a complete one', async () => {
    const { run, announced, store } = setup()
    for (const name of ['A', 'B', 'C', 'D']) await run('yns_save_niche', save(name))
    const ideas = (n: string, k = 10) => ({ niche: n, titles: Array.from({ length: k }, (_, i) => `${n} idea ${String(i)}`) })
    const args = { summary: 's', recommendation: 'A', why: 'A has the best demand and room of the five niches.', method: 'm', ideas: [ideas('A'), ideas('B'), ideas('C')] }
    await expect(run('yns_write_report', args)).rejects.toThrow(/Only 4 niches/u)
    await run('yns_save_niche', save('E', { demand: part(9) }))
    await expect(run('yns_write_report', args)).rejects.toThrow(/"E" needs 10–20 distinct titles/u)
    const text = await run('yns_write_report', { ...args, ideas: [ideas('A'), ideas('B'), ideas('E')] })
    expect(text).toContain('WhatsApp: sent to owner.')
    expect(announced[0]?.niches[0]?.name).toBe('E')
    expect(announced[0]?.changes).toEqual(['First report: nothing to compare with yet.'])
    const state = await store.read()
    expect(state.runs.at(-1)?.reportId).toBe(announced[0]?.id)
    expect(await run('yns_reports')).toContain('→ A — https://h/yns/r/')
  })
})
