/**
 * The tools employee against stand-ins: the SERP extraction and verdict on saved Google result pages, answer-widget
 * detection, the keyword gate, the weekly pace, approval replies, Keyword Planner and Search Console parsing,
 * AdSense readiness, and the tools end to end on a copy of the site framework with a local git remote. Google,
 * WhatsApp and the SEO employee are fakes; git and node run for real.
 */

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it } from 'vitest'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  adsenseReadiness, answerWidget, buildEmployeeTools, decide, demandScore, EXTRACT_SERP, isoWeek, keywordGate, paceRefusal, parseApproval,
  parseVolumes, peopleAsk, review, rpmBand, SiteRepo, serpVerdict, spikeReason, ToolsStore, weeklyDue,
} from '../src/index.ts'
import type { SerpExtract, ToolsDeps } from '../src/index.ts'

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url))
const SITE = fileURLToPath(new URL('../../../../sites/tools-linkfa/', import.meta.url))
const NOW = new Date('2026-10-03T12:00:00Z')
const exec = { signal: new AbortController().signal } as ToolRunContext
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tle-'))
  dirs.push(dir)
  return dir
}

function extract(name: string): SerpExtract {
  const dom = new JSDOM(readFileSync(join(FIXTURES, `serp-${name}.html`), 'utf8'), { runScripts: 'outside-only' })
  try {
    return dom.window.eval(`${EXTRACT_SERP}(document)`) as SerpExtract
  } finally {
    dom.window.close()
  }
}

describe('reading Google\'s first page', () => {
  it('reads organic results, People also ask and related searches from a saved page', () => {
    const page = extract('inherit')
    expect(page.blocked).toBe(false)
    expect(page.results.map(r => r.host).slice(0, 4)).toEqual(['inheritance.ilmsummit.org', 'islamicaid.com', 'darulyasin.org.uk', 'lubnaa.com'])
    expect(page.questions).toContain('How much inheritance does a daughter get in Islam?')
    expect(page.related).toContain('Islamic inheritance calculator Hanafi')
    expect(peopleAsk(extract('zakat-business'), 'Zakat calculator business stock')).toEqual([
      'How do I calculate Zakat on my stocks?', 'Is Zakat applicable on stocks?', 'How do I calculate Zakat in 2026?',
    ])
  })

  it('names a forum that a discussion result shows instead of an address', () => {
    expect(extract('unit').results.map(r => r.host)).toContain('quora.com')
  })

  it('rejects queries Google answers with its own currency or unit converter', () => {
    const currency = serpVerdict(extract('currency'))
    expect([currency.verdict, currency.widget]).toEqual(['reject', 'currency converter'])
    const unit = serpVerdict(extract('unit'))
    expect([unit.verdict, unit.widget]).toEqual(['reject', 'unit converter'])
  })

  it('finds room where small sites and an app store rank, and less where tools crowd the page', () => {
    const inherit = serpVerdict(extract('inherit'))
    expect(inherit.verdict).toBe('open')
    expect(inherit.platforms).toBe(1)
    const trap = serpVerdict(extract('tax-trap'))
    expect(trap.verdict).toBe('contested')
    expect(trap.room).toBeLessThan(inherit.room)
    expect(serpVerdict(extract('zakat-business')).reasons.join(' ')).toMatch(/islamic-relief\.org/u)
  })

  it('detects answer widgets by heading, control label or answer box', () => {
    expect(answerWidget({ headings: ['Calculator'], controls: [], boxes: [] })).toBe('calculator')
    expect(answerWidget({ headings: [], controls: [], boxes: ['wob_wc'] })).toBe('weather')
    expect(answerWidget({ headings: ['Timer'], controls: [], boxes: [] })).toBe('timer or stopwatch')
    expect(answerWidget({ headings: [], controls: ['Source text'], boxes: [] })).toBe('translation')
    expect(answerWidget({ headings: ['People also ask', 'AI Overview'], controls: [], boxes: [] })).toBeUndefined()
  })

  it('treats a robot check, or a consent page with no results, as unread', () => {
    const robot = new JSDOM('<html><body><h1>Our systems have detected unusual traffic</h1></body></html>', { runScripts: 'outside-only' })
    expect(serpVerdict(robot.window.eval(`${EXTRACT_SERP}(document)`) as SerpExtract).verdict).toBe('unknown')
    const consent = new JSDOM('<html><body><h1>Before you continue to Google</h1></body></html>', { runScripts: 'outside-only' })
    expect((consent.window.eval(`${EXTRACT_SERP}(document)`) as SerpExtract).blocked).toBe(true)
  })
})

describe('the keyword gate', () => {
  const open = serpVerdict(extract('inherit'))
  const base = {
    keyword: 'islamic inheritance calculator',
    demand: { suggestions: ['islamic inheritance calculator', 'islamic inheritance calculator hanafi', 'islamic inheritance calculator uk'] },
    serp: open, serpAt: '2026-10-01T00:00:00Z', evergreen: { lasting: true, why: 'Estates are divided every day; the rules do not change.' },
    niche: 'islamic-finance' as const, markets: ['GB', 'US'], differentiator: 'Shows every heir\'s share as an exact fraction with the verse behind it.',
    now: NOW, serpMaxAgeDays: 14,
  }

  it('passes a searched, open, evergreen keyword with a tier-1 audience', () => {
    const result = keywordGate(base)
    expect(result.failures).toEqual([])
    expect(result.pass).toBe(true)
    expect(result.rpm).toEqual([6, 15])
  })

  it('fails without demand evidence, with a stale or widget page, a spike, a low-value audience or no differentiator', () => {
    expect(keywordGate({ ...base, demand: { suggestions: ['something else'] } }).failures.join()).toMatch(/autocomplete does not suggest/u)
    expect(keywordGate({ ...base, demand: { suggestions: [], volume: 10 } }).failures.join()).toMatch(/under 30 a month/u)
    expect(keywordGate({ ...base, serpAt: '2026-09-01T00:00:00Z' }).failures.join()).toMatch(/not inspected in the last two weeks/u)
    expect(keywordGate({ ...base, serp: serpVerdict(extract('currency')) }).failures.join()).toMatch(/currency converter/u)
    expect(keywordGate({ ...base, keyword: 'tax calculator 2024' }).failures.join()).toMatch(/past year/u)
    expect(keywordGate({ ...base, evergreen: { lasting: false, why: 'a one-off event' } }).failures.join()).toMatch(/one-off event/u)
    expect(keywordGate({ ...base, markets: ['NG'] }).failures.join()).toMatch(/low-RPM market/u)
    expect(keywordGate({ ...base, differentiator: 'better' }).failures.join()).toMatch(/top results lack/u)
  })

  it('scores demand from autocomplete and Keyword Planner, and spots spikes', () => {
    expect(demandScore('vat calculator', { suggestions: ['vat calculator', 'vat calculator uk'], volume: 6000 }).score).toBeGreaterThan(
      demandScore('vat calculator', { suggestions: ['vat calculator'] }).score)
    expect(spikeReason('election results calculator', 2026)).toMatch(/election/u)
    expect(spikeReason('zakat calculator', 2026)).toBeUndefined()
    expect(rpmBand('finance', ['AE'])).toEqual([6, 15])
  })
})

describe('pace, schedule and approvals', () => {
  it('holds new tools to the weekly limit, capped at five whatever the setting', () => {
    const thisWeek = ['2026-09-28T10:00:00Z', '2026-10-01T10:00:00Z']
    expect(paceRefusal(thisWeek, NOW, 'Africa/Lagos', 3)).toBeUndefined()
    expect(paceRefusal(thisWeek, NOW, 'Africa/Lagos', 2)).toMatch(/limit is 2 a week/u)
    expect(paceRefusal(['2026-09-21T10:00:00Z', '2026-09-22T10:00:00Z'], NOW, 'Africa/Lagos', 2)).toBeUndefined()
    expect(paceRefusal(Array.from({ length: 5 }, () => '2026-10-02T10:00:00Z'), NOW, 'UTC', 50)).toMatch(/limit is 5/u)
    expect(isoWeek(NOW, 'UTC')).toBe('2026-W40')
  })

  it('reads build replies and ignores everything else', () => {
    expect(parseApproval('build 1,3', '#t1a2b', 4)).toEqual({ kind: 'some', numbers: [1, 3] })
    expect(parseApproval('#T1A2B Build 2 and 4.', '#t1a2b', 4)).toEqual({ kind: 'some', numbers: [2, 4] })
    expect(parseApproval('build all', '#t1a2b', 4)).toEqual({ kind: 'all' })
    expect(parseApproval('build none', '#t1a2b', 4)).toEqual({ kind: 'none' })
    expect(parseApproval('build 9', '#t1a2b', 4)).toBeUndefined()
    expect(parseApproval('Tools employee: reply "build 1,3"', '#t1a2b', 4)).toBeUndefined()
    expect(parseApproval('I will build it later', '#t1a2b', 4)).toBeUndefined()
  })

  it('runs weekly at the slot, and catches up after a missed one', () => {
    expect(weeklyDue({ date: '2026-10-06', minutes: 9 * 60 + 1 }, 2, 9 * 60, '2026-09-29')).toBe(true)
    expect(weeklyDue({ date: '2026-10-06', minutes: 8 * 60 }, 2, 9 * 60, '2026-09-29')).toBe(false)
    expect(weeklyDue({ date: '2026-10-08', minutes: 0 }, 2, 9 * 60, '2026-09-29')).toBe(true)
    expect(weeklyDue({ date: '2026-10-08', minutes: 0 }, 2, 9 * 60, '2026-10-06')).toBe(false)
  })
})

describe('Google data', () => {
  it('reads the SEO employee\'s Keyword Planner answer', () => {
    const text = 'United Kingdom:\n- zakat calculator: ~2900/mo, ad competition low 12/100\n- zakat on gold: volume unknown, ad competition unspecified\nNo data: faraid app.'
    const { market, volumes } = parseVolumes(text, ['zakat calculator', 'zakat on gold', 'faraid app'])
    expect(market).toBe('United Kingdom')
    expect([...volumes]).toEqual([['zakat calculator', 2900], ['zakat on gold', null], ['faraid app', null]])
  })

  it('finds striking-distance queries, weak titles and tools to prune', () => {
    const page = 'https://tools.linkfa.de/zakat-calculator/'
    const result = review({
      property: 'sc-domain:linkfa.de',
      queryPages: [
        { query: 'zakat on business stock', page, clicks: 2, impressions: 400, ctr: 0.005, position: 8.2 },
        { query: 'zakat calculator uk', page, clicks: 1, impressions: 300, ctr: 0.003, position: 3.1 },
      ],
      pages90: [{ page, clicks: 3, impressions: 700, ctr: 0.004, position: 6 }],
      tools: [{ slug: 'zakat-calculator', url: page, publishedAt: '2026-05-01T00:00:00Z' }, { slug: 'old-tool', url: 'https://tools.linkfa.de/old-tool/', publishedAt: '2026-03-01T00:00:00Z' }],
      now: NOW,
      rules: { minImpressions: 20, pruneAfterDays: 120 },
    })
    expect(result.review.striking.map(s => s.query)).toEqual(['zakat on business stock'])
    expect(result.review.lowCtr.map(s => s.query)).toContain('zakat calculator uk')
    expect(result.review.prune).toEqual(['old-tool'])
    expect(result.perTool.get('zakat-calculator')?.flag).toMatch(/^retitle/u)
    expect(result.review.totals).toEqual({ clicks: 3, impressions: 700 })
  })

  it('says when to apply for AdSense, and why not yet', () => {
    const tool = { slug: 'a', title: 'A', keyword: 'a', seed: false, firstPublishedAt: '2026-09-01', tests: { status: 'passed' as const, at: '', hash: '', output: '' } }
    const site = { at: '', state: 'live' as const, detail: 'live', liveVersion: 'v' }
    const pages = { '/about/': true, '/privacy/': true }
    const rules = { minTools: 2, minClicks28: 50 }
    const notYet = adsenseReadiness({ site, pages, tools: [tool], clicks28: undefined, clientSet: false, rules })
    expect(notYet.ready).toBe(false)
    expect(notYet.verdict).toMatch(/^Missing: /u)
    expect(notYet.checks.find(c => c.label.startsWith('Search traffic'))?.detail).toMatch(/not connected/u)
    const ready = adsenseReadiness({ site, pages, tools: [tool, { ...tool, slug: 'b' }], clicks28: 80, clientSet: false, rules })
    expect(ready.ready).toBe(true)
    expect(ready.verdict).toMatch(/apply with linkfa\.de/u)
  })
})

/** A tool that passes the site's checks, with a known-answer test. */
function writeTool(root: string, slug: string, passing: boolean): void {
  const today = new Date().toISOString().slice(0, 10)
  const dir = join(root, 'tools', slug)
  mkdirSync(dir, { recursive: true })
  const words = Array.from({ length: 420 }, (_, i) => `${slug.replace(/-/gu, '')}${String(i)}`).join(' ')
  writeFileSync(join(dir, 'tool.json'), JSON.stringify({
    slug, title: `Doubling calculator for ${slug}`, h1: `Doubling ${slug}`, description: `Double any number for ${slug}. `.padEnd(90, '.'),
    intro: 'Type a number and see it doubled, with the working shown step by step for you to check.', category: 'money',
    keyword: `double ${slug}`, differentiator: 'Shows the working that the other results on the first page leave out.',
    related: [], published: today, updated: today,
    sources: [{ title: 'Arithmetic', url: 'https://example.org/', checked: today }],
    faqs: [1, 2, 3].map(n => ({ q: `Question ${String(n)} about ${slug}?`, a: 'An answer long enough to count as a real answer to the question.' })),
  }))
  writeFileSync(join(dir, 'content.html'), `<h2 id="what">What</h2><p>${words}</p><h2 id="how">How</h2><p>x</p><h2 id="example">Example</h2><p>y</p>`)
  writeFileSync(join(dir, 'form.html'), '<form id="calc"><label for="n">N</label><input id="n" type="number"><div id="result" aria-live="polite"></div></form>')
  writeFileSync(join(dir, 'logic.mjs'), 'export function double(n) { return n * 2 }\n')
  writeFileSync(join(dir, 'ui.mjs'), 'import { double } from \'./logic.mjs\'\nvoid double\n')
  writeFileSync(join(dir, 'logic.test.mjs'), `import assert from 'node:assert/strict'\nimport { test } from 'node:test'\nimport { double } from './logic.mjs'\n${
    [1, 2, 3].map(n => `test('doubles ${String(n)}', () => { assert.equal(double(${String(n)}), ${String(passing ? n * 2 : n * 3)}) })`).join('\n')}\n`)
}

describe('the tools on a working copy', () => {
  interface Bench { deps: ToolsDeps; tools: Map<string, ToolDefinition>; sent: string[]; remote: string; work: string; store: ToolsStore }
  function bench(): Bench {
    const root = temp()
    const template = join(root, 'template')
    const skip = /[/\\](?:tools|dist|node_modules)(?:[/\\]|$)/u
    cpSync(SITE, template, { recursive: true, filter: src => !skip.test(src.slice(SITE.length - 1)) })
    mkdirSync(join(template, 'tools'))
    writeTool(template, 'seed-tool', true)
    const remote = join(root, 'remote.git')
    execFileSync('git', ['init', '--bare', '-b', 'main', remote])
    const work = join(root, 'work')
    const store = new ToolsStore(join(root, 'state.json'))
    const sent: string[] = []
    const site = new SiteRepo({
      templateDir: template, workDir: work, previewDir: join(root, 'preview'), repo: () => remote, token: () => 'test-token', branch: 'main',
      deployHook: () => '', siteUrl: () => 'https://tools.example.com', adsenseClient: () => '',
    })
    const deps: ToolsDeps = {
      store, site,
      suggest: () => Promise.resolve(['islamic inheritance calculator', 'islamic inheritance calculator hanafi', 'islamic inheritance calculator uk']),
      readSerp: () => Promise.resolve(extract('inherit')),
      volumes: () => Promise.resolve({ ok: false, reason: 'no SEO employee site is chosen' }),
      searchConsole: () => Promise.reject(new Error('not connected')),
      gscProblem: () => 'no service account key is saved',
      settings: {
        seeds: () => ['islamic inheritance calculator'], markets: () => ['GB'], maxToolsPerWeek: () => 2, serpPerDay: () => 2, serpGapMs: () => 0, cacheDays: () => 14,
        timeZone: () => 'UTC', siteUrl: () => 'https://tools.example.com', adsenseClient: () => '',
        readiness: () => ({ minTools: 15, minClicks28: 50 }), review: () => ({ minImpressions: 20, pruneAfterDays: 120 }),
      },
      now: () => new Date(),
      sleep: () => Promise.resolve(),
      notify: (text) => { sent.push(text); return Promise.resolve('sent to owner') },
      shortlistLink: id => `https://h/tools/r/${id}?sig=x`,
      seedSlugs: () => ['seed-tool'],
      fetch: () => Promise.reject(new Error('offline')),
    }
    return { deps, tools: new Map(buildEmployeeTools(deps).map(t => [t.name, t])), sent, remote, work, store }
  }
  const call = async (tools: Map<string, ToolDefinition>, name: string, args: Record<string, unknown> = {}): Promise<string> =>
    (await tools.get(name)!.execute(args, exec) as { text: string }).text

  it('researches, gates, proposes, builds only what was approved, and refuses to publish failing tests', async () => {
    const { tools, sent, remote, work, store } = bench()
    expect(await call(tools, 'tools_research_seed', { seed: 'islamic inheritance calculator', expansion: 'basic' })).toMatch(/3 distinct suggestions/u)
    expect(await call(tools, 'tools_inspect_serp', { keyword: 'islamic inheritance calculator' })).toMatch(/OPEN/u)
    await expect(call(tools, 'tools_inspect_serp', { keyword: 'faraid calculator' })).resolves.toMatch(/OPEN/u)
    await expect(call(tools, 'tools_inspect_serp', { keyword: 'third keyword' })).rejects.toThrow(/2 Google results pages are used/u)
    const scored = await call(tools, 'tools_score_keyword', {
      keyword: 'islamic inheritance calculator', tool: 'Islamic inheritance calculator', slug: 'islamic-inheritance-calculator', niche: 'islamic-finance',
      evergreen: true, evergreen_why: 'Estates are divided all year; the rules are fixed.', differentiator: 'Exact fractions with the verse behind every share, and the working.',
    })
    expect(scored).toMatch(/^PASS/u)
    const id = /candidate (\w+)/u.exec(scored)?.[1] ?? ''
    await expect(call(tools, 'tools_build_scaffold', { slug: 'islamic-inheritance-calculator', category: 'islamic-finance' })).rejects.toThrow(/not an approved tool/u)
    expect(await call(tools, 'tools_propose_shortlist', { candidate_ids: [id], note: 'Islamic finance first.' })).toMatch(/Shortlist sent/u)
    expect(sent[0]).toMatch(/1\. Islamic inheritance calculator/u)
    await expect(call(tools, 'tools_propose_shortlist', { candidate_ids: [id] })).rejects.toThrow(/already waiting/u)
    const list = (await store.read()).shortlists[0]!
    expect(await store.update(s => decide(s, list.id, [1], 'whatsapp', new Date()))).toEqual(['Islamic inheritance calculator'])
    expect(await call(tools, 'tools_build_scaffold', { slug: 'islamic-inheritance-calculator', category: 'islamic-finance' })).toMatch(/^Created/u)
    expect(existsSync(join(work, 'tools', 'islamic-inheritance-calculator', 'logic.test.mjs'))).toBe(true)
    expect(existsSync(join(work, 'tools', 'seed-tool', 'tool.json'))).toBe(true)
    expect(await call(tools, 'tools_run_tests', { slug: 'islamic-inheritance-calculator' })).toMatch(/^FAILED/u)
    await expect(call(tools, 'tools_publish', { slug: 'islamic-inheritance-calculator' })).rejects.toThrow(/run it again/u)
    // A whole-site publish runs every tool's tests too, so the unfinished tool blocks it as well.
    await expect(call(tools, 'tools_publish')).rejects.toThrow(/a test fails/u)
    rmSync(join(work, 'tools', 'islamic-inheritance-calculator'), { recursive: true })
    writeTool(work, 'islamic-inheritance-calculator', false)
    expect(await call(tools, 'tools_run_tests', { slug: 'islamic-inheritance-calculator' })).toMatch(/^FAILED/u)
    writeTool(work, 'islamic-inheritance-calculator', true)
    expect(await call(tools, 'tools_run_tests', { slug: 'islamic-inheritance-calculator' })).toMatch(/^PASSED/u)
    const published = await call(tools, 'tools_publish', { slug: 'islamic-inheritance-calculator' })
    expect(published).toMatch(/Push: pushed to/u)
    expect(execFileSync('git', ['--git-dir', remote, 'log', '--oneline', 'main']).toString()).toMatch(/Add Doubling islamic-inheritance-calculator/u)
    const state = await store.read()
    expect(state.tools['islamic-inheritance-calculator']?.firstPublishedAt).toBeDefined()
    expect(state.tools['seed-tool']?.firstPublishedAt).toBeDefined()
    expect(state.shortlists[0]?.items[0]?.publishedAt).toBeDefined()
    expect(sent.at(-1)).toMatch(/published Doubling islamic-inheritance-calculator/u)
  }, 120_000)

  it('says Search Console is not connected instead of reviewing', async () => {
    const { tools } = bench()
    expect(await call(tools, 'tools_gsc_review')).toMatch(/^Search Console is not connected: no service account key/u)
  })
})

describe('the seed tools', () => {
  it('pass their own known-answer tests and the site build\'s checks', () => {
    const out = execFileSync(process.execPath, ['--test'], { cwd: SITE, encoding: 'utf8' })
    expect(out).toMatch(/# fail 0/u)
    expect(execFileSync(process.execPath, ['build.mjs', '--check'], { cwd: SITE, encoding: 'utf8' })).toMatch(/^OK: [3-9] tools pass/u)
  }, 120_000)
})
