import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { readFeed, sameShow } from '../src/podcasts.ts'
import { buildScoutTools, ScoutStore, type Config, type ScoutDeps, type YtDlpRunner } from '../src/index.ts'

const exec = { signal: new AbortController().signal } as ToolRunContext

/** A feed the way podcast hosts publish one: owner block, CDATA, entities, many items. */
function feed(email: string | null, channelLink = ''): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
<channel>
  <title><![CDATA[The Small Pod Show]]></title>
  <link>https://smallpod.fm${channelLink}</link>
  <itunes:author>Small Pod &amp; Friends</itunes:author>
  ${email === null ? '' : `<itunes:owner><itunes:name>Tunde Bakare</itunes:name><itunes:email>${email}</itunes:email></itunes:owner>`}
  <item><title><![CDATA[Ep 42: Why landlords want two years upfront]]></title></item>
  ${'<item><title>older</title></item>'.repeat(500)}
</channel>
</rss>`
}

function fakeFetch(shows: object[], feeds: Record<string, string>): typeof fetch {
  return (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : input.toString()
    if (url.startsWith('https://itunes.apple.com/search')) return Promise.resolve(Response.json({ resultCount: shows.length, results: shows }))
    const body = feeds[url]
    return Promise.resolve(body === undefined ? new Response('gone', { status: 404 }) : new Response(body, { headers: { 'Content-Type': 'application/rss+xml' } }))
  }
}

const ytDlp: YtDlpRunner = (args) => {
  const url = args[0] ?? ''
  if (url.includes('/results?')) {
    return Promise.resolve(JSON.stringify({ entries: [
      { id: 'v1', title: 'Ep 42 full video', duration: 3600, channel: 'Small Pod', channel_id: 'UC_small' },
      { id: 'v9', title: 'Unrelated', duration: 4000, channel: 'Random Vlogs', channel_id: 'UC_random' },
    ] }))
  }
  return Promise.resolve(JSON.stringify({ channel: 'Small Pod', channel_follower_count: 12_000, entries: [] }))
}

function live<T>(value: T): { get: () => T } {
  return { get: () => value }
}

function setup(shows: object[], feeds: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'scout-pod-'))
  const config = {
    enabled: live(true), shiftTime: live('09:00'), timeZone: live('Africa/Lagos'), samplesPerDay: live(2), pitchesPerDay: live(2),
    replyCheckMinutes: live(15), topics: live(['podcast']), minSubscribers: live(1000), maxSubscribers: live(300_000), maxShorts: live(10),
    podcastCountry: live('ng'), podcastActiveDays: live(60), kliparaApiKey: live('k'), notifyTo: live(''), provider: live(''), model: live(''),
    fallbackProvider: live(''), fallbackModel: live(''), fallbackPitches: live(false), fallbackCooldownMinutes: live(15),
    sampleBaseUrl: live('https://klipara.test/s'), sampleTtlDays: live(30), outreachBrowser: live('outreach'), sampleHeadline: live('h'), sampleNote: live('n'),
    dataDir: '', kliparaApi: 'http://klipara.test/api/v1', publicBaseUrl: 'https://h.test', path: '/scout', token: '', freeClipSecret: '',
    workspacePath: '/tmp/ws', agentPreset: 'standard', permissionPreset: 'workspace-write', shiftPrompt: 'go',
    ytDlp: 'yt-dlp', timeoutMs: 5000, sampleCheckMs: 120_000, whatsappUrl: '', whatsappToken: '', forbiddenBrowser: 'deerflow',
  } as Config
  const deps: ScoutDeps = {
    store: new ScoutStore(join(dir, 'leads.json')),
    config,
    ytDlp,
    klipara: {} as ScoutDeps['klipara'],
    samplesDir: join(dir, 'samples'),
    sampleBase: () => 'https://klipara.test/s',
    notify: () => Promise.resolve('sent'),
    now: () => new Date('2026-09-30T10:00:00Z'),
    fetch: fakeFetch(shows, feeds),
  }
  const tools = new Map(buildScoutTools(deps).map((t: ToolDefinition) => [t.name, t]))
  const run = async (args: Record<string, unknown> = {}): Promise<string> =>
    ((await tools.get('scout_search_podcasts')!.execute(args, exec)) as { text: string }).text
  return { deps, run }
}

const show = (title: string, feedUrl: string, lastRelease = '2026-09-25T06:00:00Z') => ({
  collectionName: title, artistName: 'Small Pod & Friends', feedUrl, collectionViewUrl: `https://podcasts.apple.com/${title}`, trackCount: 42, releaseDate: lastRelease,
})

describe('reading a podcast feed', () => {
  it('takes the owner email, the owner name and the newest episode, and stops early on long feeds', async () => {
    const facts = await readFeed(fakeFetch([], { 'https://f/1': feed('Hello@SmallPod.fm') }), 'https://f/1', exec.signal)
    expect(facts).toMatchObject({ email: 'hello@smallpod.fm', ownerName: 'Tunde Bakare', latestEpisodeTitle: 'Ep 42: Why landlords want two years upfront' })
  })

  it('finds a linked YouTube channel and reports no email when the feed has none', async () => {
    const facts = await readFeed(fakeFetch([], { 'https://f/2': feed(null, '/watch https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv') }), 'https://f/2', exec.signal)
    expect(facts.email).toBeUndefined()
    expect(facts.youtubeChannelIds).toEqual(['UCabcdefghijklmnopqrstuv'])
  })

  it('matches a show to its channel by name, not to an unrelated one', () => {
    expect(sameShow({ title: 'The Small Pod Show', author: 'x' }, 'Small Pod')).toBe(true)
    expect(sameShow({ title: 'The Small Pod Show', author: 'x' }, 'Random Vlogs')).toBe(false)
  })
})

describe('scout_search_podcasts', () => {
  it('saves an active show with an email and a YouTube video as a lead, and passes over the rest', async () => {
    const { run, deps } = setup(
      [show('The Small Pod Show', 'https://f/small'), show('Quiet Show', 'https://f/quiet'), show('Old Show', 'https://f/old', '2025-01-01T00:00:00Z')],
      { 'https://f/small': feed('hello@smallpod.fm'), 'https://f/quiet': feed(null) },
    )
    const text = await run({ topic: 'nigerian business podcast' })
    expect(text).toContain('1 saved as leads with an email')
    expect(text).toContain('Quiet Show: no contact email in its feed')
    expect(text).toContain('Old Show: no episode in 60 days')
    const [lead] = (await deps.store.read()).leads
    expect(lead).toMatchObject({ channelId: 'UC_small', email: 'hello@smallpod.fm', source: 'podcast', stage: 'found', podcast: { feedUrl: 'https://f/small' } })

    // A second search does not read the same feeds again.
    expect(await run({ topic: 'nigerian business podcast' })).toContain('0 not read before')
  })

  it('adds the feed email to an existing lead that had none', async () => {
    const { run, deps } = setup([show('The Small Pod Show', 'https://f/small')], { 'https://f/small': feed('hello@smallpod.fm') })
    await deps.store.update((s) => {
      s.leads.push({ channelId: 'UC_small', channelName: 'Small Pod', channelUrl: 'https://www.youtube.com/channel/UC_small', stage: 'sampled', source: 'scout', replies: [], history: [], createdAt: 'x', updatedAt: 'x' })
    })
    expect(await run()).toContain('Email added to existing leads: Small Pod: email hello@smallpod.fm')
    const leads = (await deps.store.read()).leads
    expect(leads).toHaveLength(1)
    expect(leads[0]).toMatchObject({ email: 'hello@smallpod.fm', stage: 'sampled' })
  })
})
