import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { creatorEmail } from '../src/podcasts.ts'
import { ownShow } from '../src/contacts.ts'
import { aboutLinks, checkComments, emailsIn, followUpsDue, lookUpComment, nextVisibility, outreachStats, apply, backfillCovers, bestCandidate, KliparaError, buildScoutTools, finishSample, leadsPage, localTime, parseShiftTime, ScoutStore, shiftDue, type Config, type KliparaApi, type ScoutDeps, type YtDlpRunner } from '../src/index.ts'

const exec = { signal: new AbortController().signal } as ToolRunContext

/** A live-settings stand-in: each field reads its value. */
function live<T>(value: T): { get: () => T } {
  return { get: () => value }
}

function config(overrides: Partial<Record<keyof Config, unknown>> = {}): Config {
  const base = {
    enabled: live(true), shiftTime: live('09:00'), timeZone: live('Africa/Lagos'),
    samplesPerDay: live(2), pitchesPerDay: live(2), replyCheckMinutes: live(15), topics: live(['podcast']),
    podcastCountry: live('ng'), podcastActiveDays: live(60),
    commentsPerDay: live(2), followUpDays: live(6), youtubeApiKey: live(''), commentCheckMinutes: live(180), commentHeldHours: live(24), heldCommentsPause: live(2),
    minSubscribers: live(1000), maxSubscribers: live(500_000), maxShorts: live(10),
    kliparaApiKey: live('klp_sk_test_x'), sampleBaseUrl: live('https://klipara.test/s'), sampleTtlDays: live(30), outreachBrowser: live('outreach'), notifyTo: live('Me'), provider: live(''), model: live(''),
    sampleHeadline: live('A clip'), sampleNote: live('note'),
    dataDir: '', kliparaApi: 'http://klipara.test/api/v1', publicBaseUrl: 'https://h.test', path: '/scout', token: '', freeClipSecret: live(''), envFreeClipSecret: '',
    workspacePath: '/tmp/ws', agentPreset: 'standard', permissionPreset: 'workspace-write', shiftPrompt: 'go',
    ytDlp: 'yt-dlp', timeoutMs: 5000, sampleCheckMs: 120_000, whatsappUrl: '', whatsappToken: '', forbiddenBrowser: 'deerflow',
  }
  return { ...base, ...overrides } as Config
}

/** A fake yt-dlp: search results, then one channel page per channel. */
const ytDlp: YtDlpRunner = (args) => {
  const url = args[0] ?? ''
  if (url.includes('/results?')) {
    return Promise.resolve(JSON.stringify({ entries: [
      { id: 'v1', title: 'Episode one', duration: 3600, channel: 'Small Pod', channel_id: 'UC_small' },
      { id: 'v2', title: 'Episode two', duration: 5400, channel: 'Big Pod', channel_id: 'UC_big' },
      { id: 'v3', title: 'Shorts heavy', duration: 4000, channel: 'Shorty', channel_id: 'UC_shorts' },
    ] }))
  }
  if (url.includes('UC_small')) return Promise.resolve(JSON.stringify({ channel: 'Small Pod', channel_follower_count: 12_000, description: 'Business: hi@small.pod', entries: [] }))
  if (url.includes('UC_big')) return Promise.resolve(JSON.stringify({ channel: 'Big Pod', channel_follower_count: 2_000_000, entries: [] }))
  return Promise.resolve(JSON.stringify({ channel: 'Shorty', channel_follower_count: 50_000, entries: Array.from({ length: 11 }, (_, i) => ({ id: `s${String(i)}` })) }))
}

let server: Server | undefined
afterEach(async () => {
  if (server !== undefined) {
    await new Promise<void>(resolve => server?.close(() => { resolve() }))
    server = undefined
  }
})

/** Serve a fake clip file and return its URL. */
/** A designed cover as Klipara serves it: JPEG bytes. */
const COVER = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.from('designed-cover')])

async function clipServer(): Promise<string> {
  server = createServer((req, res) => {
    if (req.url === '/cover.jpg') { res.writeHead(200, { 'Content-Type': 'image/jpeg' }); res.end(COVER); return }
    if (req.url === '/gone.jpg') { res.writeHead(403); res.end(); return }
    res.writeHead(200, { 'Content-Type': 'video/mp4' }); res.end(Buffer.from('fake-mp4'))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return `http://127.0.0.1:${String(address.port)}/clip.mp4`
}

function klipara(downloadUrl: string, state = 'succeeded', cover: string | null = null): KliparaApi & { exports: string[] } {
  const exports: string[] = []
  return {
    exports,
    startJob: () => Promise.resolve({ id: 'job_1', state: 'queued' }),
    getJob: () => Promise.resolve({ id: 'job_1', state }),
    candidates: () => Promise.resolve([
      { clipId: 'clp_gated', rank: 1, totalScore: 0.9, gatedOut: true, startMs: 0, endMs: 30_000, thumbnailUrl: null },
      { clipId: 'clp_good', rank: 2, totalScore: 0.8, gatedOut: false, startMs: 60_000, endMs: 105_000, thumbnailUrl: cover },
    ]),
    exportClip: (clipId) => { exports.push(clipId); return Promise.resolve({ downloadUrl, thumbnailUrl: cover, charged: '1' }) },
  }
}

function setup(overrides: Partial<ScoutDeps> = {}, cfg = config()) {
  const dir = mkdtempSync(join(tmpdir(), 'scout-'))
  const notes: string[] = []
  const deps: ScoutDeps = {
    store: new ScoutStore(join(dir, 'leads.json')),
    config: cfg,
    ytDlp,
    klipara: klipara('http://127.0.0.1:1/none'),
    samplesDir: join(dir, 'samples'),
    sampleBase: () => 'https://h.test/scout/s',
    notify: (text) => { notes.push(text); return Promise.resolve('sent') },
    now: () => new Date('2026-09-29T10:00:00Z'),
    ...overrides,
  }
  const tools = new Map(buildScoutTools(deps).map((t: ToolDefinition) => [t.name, t]))
  const run = async (name: string, args: Record<string, unknown> = {}): Promise<string> =>
    ((await tools.get(name)!.execute(args, exec)) as { text: string }).text
  return { deps, run, notes, dir }
}

describe('klipara scout', () => {
  it('saves only channels inside the size and Shorts limits, with any public email', async () => {
    const { run, deps } = setup()
    const text = await run('scout_search', { topic: 'nigerian podcast' })
    expect(text).toContain('1 saved as leads')
    expect(text).toContain('Big Pod: 2000000 subscribers')
    expect(text).toContain('Shorty: already posts 11+ Shorts')
    const state = await deps.store.read()
    expect(state.leads.map(l => [l.channelId, l.stage, l.email])).toEqual([
      ['UC_small', 'found', 'hi@small.pod'], ['UC_big', 'skipped', undefined], ['UC_shorts', 'skipped', undefined],
    ])
    expect(await run('scout_search', { topic: 'nigerian podcast' })).toContain('0 new channels')
  })

  it('makes a sample from the best standalone clip, hosts it, and counts the cap', async () => {
    const url = await clipServer()
    const api = klipara(url)
    const { run, deps } = setup({ klipara: api })
    await run('scout_search')
    expect(await run('scout_make_sample', { channel_id: 'UC_small' })).toContain('job job_1')
    const ready = await run('scout_check_sample', { channel_id: 'UC_small' })
    expect(api.exports).toEqual(['clp_good'])
    const lead = (await deps.store.read()).leads.find(l => l.channelId === 'UC_small')!
    expect(lead.stage).toBe('sampled')
    expect(ready).toContain(lead.samplePageUrl)
    expect(readFileSync(join(deps.samplesDir, `${lead.sampleId ?? ''}.mp4`), 'utf8')).toBe('fake-mp4')
    expect((await deps.store.read()).days['2026-09-29']).toEqual({ samples: 1, pitches: 0 })
  })

  it('finishes a sample without the model once Klipara is done, and waits while it is not', async () => {
    const url = await clipServer()
    const { run, deps } = setup({ klipara: klipara(url, 'running') })
    await run('scout_search')
    await run('scout_make_sample', { channel_id: 'UC_small' })
    expect((await finishSample(deps, 'UC_small', exec.signal)).outcome).toBe('waiting')
    deps.klipara = klipara(url)
    const check = await finishSample(deps, 'UC_small', exec.signal)
    expect(check.outcome).toBe('ready')
    expect((await deps.store.read()).leads.find(l => l.channelId === 'UC_small')!.stage).toBe('sampled')
  })

  it('uses Klipara\'s designed cover as the poster, and a frame when the cover cannot be fetched', async () => {
    const url = await clipServer()
    const cover = url.replace('clip.mp4', 'cover.jpg')
    const { run, deps } = setup({ klipara: klipara(url, 'succeeded', cover) })
    await run('scout_search')
    await run('scout_make_sample', { channel_id: 'UC_small' })
    await run('scout_check_sample', { channel_id: 'UC_small' })
    const id = (await deps.store.read()).leads[0]!.sampleId ?? ''
    expect(readFileSync(join(deps.samplesDir, `${id}.jpg`))).toEqual(COVER)
    expect(JSON.parse(readFileSync(join(deps.samplesDir, `${id}.meta.json`), 'utf8'))).toMatchObject({ clipId: 'clp_good', poster: 'cover' })

    const second = setup({ klipara: klipara(url, 'succeeded', url.replace('clip.mp4', 'gone.jpg')) })
    await second.run('scout_search')
    await second.run('scout_make_sample', { channel_id: 'UC_small' })
    expect(await second.run('scout_check_sample', { channel_id: 'UC_small' })).toContain('Sample ready')
    const other = (await second.deps.store.read()).leads[0]!.sampleId ?? ''
    expect(JSON.parse(readFileSync(join(second.deps.samplesDir, `${other}.meta.json`), 'utf8'))).toMatchObject({ poster: 'frame' })
  })

  it('backfills the cover onto a sample made before covers, and leaves one without a cover alone', async () => {
    const url = await clipServer()
    const { run, deps } = setup({ klipara: klipara(url) })
    await run('scout_search')
    await run('scout_make_sample', { channel_id: 'UC_small' })
    await run('scout_check_sample', { channel_id: 'UC_small' })
    const id = (await deps.store.read()).leads[0]!.sampleId ?? ''
    expect(await backfillCovers(deps, exec.signal)).toBe(0)
    deps.klipara = klipara(url, 'succeeded', url.replace('clip.mp4', 'cover.jpg'))
    expect(await backfillCovers(deps, exec.signal)).toBe(1)
    expect(readFileSync(join(deps.samplesDir, `${id}.jpg`))).toEqual(COVER)
    expect(await backfillCovers(deps, exec.signal)).toBe(0)
  })

  it('backfills a sample stored before samples had a record', async () => {
    const url = await clipServer()
    const { run, deps } = setup({ klipara: klipara(url) })
    await run('scout_search')
    await run('scout_make_sample', { channel_id: 'UC_small' })
    await run('scout_check_sample', { channel_id: 'UC_small' })
    const id = (await deps.store.read()).leads[0]!.sampleId ?? ''
    rmSync(join(deps.samplesDir, `${id}.meta.json`))
    deps.klipara = klipara(url, 'succeeded', url.replace('clip.mp4', 'cover.jpg'))
    expect(await backfillCovers(deps, exec.signal)).toBe(1)
    expect(readFileSync(join(deps.samplesDir, `${id}.jpg`))).toEqual(COVER)
    expect(JSON.parse(readFileSync(join(deps.samplesDir, `${id}.meta.json`), 'utf8'))).toMatchObject({ id, poster: 'cover' })
  })

  it('waits, without failing, when the same export is already running', async () => {
    const url = await clipServer()
    const api = klipara(url)
    api.exportClip = () => Promise.reject(new KliparaError('Klipara refused POST /clips/clp_good/export (HTTP 409): still running', 409, 'idempotency_in_progress'))
    const { run, deps } = setup({ klipara: api })
    await run('scout_search')
    await run('scout_make_sample', { channel_id: 'UC_small' })
    expect(await finishSample(deps, 'UC_small', exec.signal)).toMatchObject({ outcome: 'waiting' })
    expect((await deps.store.read()).leads[0]!.stage).toBe('sampling')
  })

  it('refuses a sample past the daily cap', async () => {
    const { run, deps } = setup({}, config({ samplesPerDay: live(0) }))
    await run('scout_search')
    await expect(run('scout_make_sample', { channel_id: 'UC_small' })).rejects.toThrow('sample cap (0) is reached')
    expect((await deps.store.read()).leads[0]!.stage).toBe('found')
  })

  it('skips a lead whose job failed', async () => {
    const { run, deps } = setup({ klipara: klipara('x', 'failed') })
    await run('scout_search')
    await run('scout_make_sample', { channel_id: 'UC_small' })
    expect(await run('scout_check_sample', { channel_id: 'UC_small' })).toContain('is skipped')
    expect((await deps.store.read()).leads[0]!.stage).toBe('skipped')
  })

  it('reserves a pitch only with the sample link, within the cap, and not a near-copy', async () => {
    const url = await clipServer()
    const { run, deps } = setup({ klipara: klipara(url) })
    await run('scout_search')
    await run('scout_make_sample', { channel_id: 'UC_small' })
    await run('scout_check_sample', { channel_id: 'UC_small' })
    const link = (await deps.store.read()).leads[0]!.samplePageUrl ?? ''
    await expect(run('scout_pitch', { channel_id: 'UC_small', via: 'email', to: 'hi@small.pod', text: 'no link here' })).rejects.toThrow('email pitch must contain the sample link')
    await expect(run('scout_pitch', { channel_id: 'UC_small', via: 'comment', to: 'https://www.youtube.com/watch?v=v1', text: 'I clipped your landlord story, want it?' }))
      .rejects.toThrow('pitch by email, which carries the clip')
    await expect(run('scout_pitch', { channel_id: 'UC_small', via: 'email', to: 'not-an-address', text: link })).rejects.toThrow('needs an email address')
    await expect(run('scout_pitch', { channel_id: 'UC_small', via: 'email', to: 'hi@small.pod', text: `Such an inspiring episode! I clipped a truly insightful moment. Let me know if you would like it! ${link}` }))
      .rejects.toThrow('reads as machine-written')
    expect((await deps.store.read()).leads[0]!.stage).toBe('sampled')
    await expect(run('scout_pitch', { channel_id: 'UC_small', via: 'email', to: 'hi@small.pod', text: `Subject: Re: your Lagos rent episode\n\nI clipped the landlord story: ${link}` }))
      .rejects.toThrow('may not open with a "Re:"')
    expect(await run('scout_pitch', { channel_id: 'UC_small', via: 'email', to: 'hi@small.pod', text: `Loved the episode about Lagos rent, I clipped the landlord story: ${link}` })).toContain('Pitch 1/2 reserved')
    const state = await deps.store.read()
    expect(state.leads[0]!.stage).toBe('pitched')
    await deps.store.update((s) => {
      s.leads.push({ ...s.leads[0]!, channelId: 'UC_two', stage: 'sampled', samplePageUrl: 'https://h.test/scout/s/two' })
    })
    await expect(run('scout_pitch', { channel_id: 'UC_two', via: 'email', to: 'two@pod.test', text: 'Loved the episode about Lagos rent, I clipped the landlord story: https://h.test/scout/s/two' }))
      .rejects.toThrow('same words as an earlier one')
  })

  it('sends nothing while no outreach browser is configured', async () => {
    const { run, deps } = setup({}, config({ outreachBrowser: live('') }))
    await run('scout_search')
    await deps.store.update((s) => { s.leads[0]!.stage = 'sampled'; s.leads[0]!.samplePageUrl = 'https://klipara.test/s/abc' })
    await expect(run('scout_pitch', { channel_id: 'UC_small', via: 'comment', to: 'https://www.youtube.com/watch?v=v1', text: 'I clipped the landlord story, reply if you want it' }))
      .rejects.toThrow('No outreach account is configured')
  })

  it('accepts a link-free comment pitch only after an email search found nothing, within the comment cap', async () => {
    const { run, deps } = setup({}, config({ commentsPerDay: live(1), pitchesPerDay: live(5) }))
    await run('scout_search')
    await deps.store.update((s) => {
      for (const [i, lead] of s.leads.entries()) {
        lead.stage = 'sampled'
        lead.samplePageUrl = `https://klipara.test/s/${String(i)}`
        delete lead.email
      }
    })
    const comment = 'The bit where he explains Lagos rent deposits is gold. I cut it into a vertical clip; reply and I will send it over.'
    await expect(run('scout_pitch', { channel_id: 'UC_small', via: 'comment', to: 'https://www.youtube.com/watch?v=v1', text: comment }))
      .rejects.toThrow('Call scout_find_email')
    await deps.store.update((s) => { for (const lead of s.leads) lead.contactSearch = { at: 'x', tried: ['About page: 0 links'] } })
    await expect(run('scout_pitch', { channel_id: 'UC_small', via: 'comment', to: 'https://www.youtube.com/watch?v=v1', text: 'Clipped your landlord story: https://klipara.test/s/0' }))
      .rejects.toThrow('must contain no link')
    expect(await run('scout_pitch', { channel_id: 'UC_small', via: 'comment', to: 'https://www.youtube.com/watch?v=v1', text: comment }))
      .toContain('using only the "outreach" browser tools')
    expect((await deps.store.read()).leads.find(l => l.channelId === 'UC_small')?.pitch?.visibility?.state).toBe('pending')
    const second = (await deps.store.read()).leads.find(l => l.channelId !== 'UC_small' && l.stage === 'sampled')
    await expect(run('scout_pitch', { channel_id: second!.channelId, via: 'comment', to: 'https://www.youtube.com/watch?v=v2', text: 'Your take on side hustles at 31:10 made me laugh. I made a short clip of it, want it?' }))
      .rejects.toThrow("Today's comment cap (1)")
  })

  it('pauses outreach, alerts the owner, and refuses samples and pitches until resumed', async () => {
    const { run, notes } = setup()
    await run('scout_search')
    expect(await run('scout_pause', { reason: 'captcha on YouTube' })).toContain('Outreach paused')
    expect(notes[0]).toContain('captcha on YouTube')
    await expect(run('scout_make_sample', { channel_id: 'UC_small' })).rejects.toThrow('Outreach is paused (captcha on YouTube)')
    expect(await run('scout_status')).toContain('PAUSED')
    expect(await run('scout_resume')).toContain('resumed')
    expect(await run('scout_make_sample', { channel_id: 'UC_small' })).toContain('job job_1')
  })

  it('records a reply, moves the lead to replied, and tells the owner', async () => {
    const { run, deps, notes } = setup()
    await run('scout_search')
    await deps.store.update((s) => { s.leads[0]!.stage = 'pitched'; s.leads[0]!.pitch = { via: 'comment', to: 'x', text: 't', at: 'a' } })
    expect(await run('scout_record_reply', { channel_id: 'UC_small', where: 'comment', text: 'How much for 10 clips?' })).toContain('now replied')
    expect(notes[0]).toContain('Small Pod replied')
    expect(notes[0]).toContain('How much for 10 clips?')
  })

  it('renders the leads page with stage and escaped text', async () => {
    const { run, deps } = setup()
    await run('scout_search')
    await deps.store.update((s) => { s.leads[0]!.channelName = '<b>Pod</b>' })
    const page = leadsPage(await deps.store.read(), '2026-09-29', config())
    expect(page).toContain('&lt;b&gt;Pod&lt;/b&gt;')
    expect(page).toContain('samples 0/2')
  })

  it('picks the best-ranked clip that stands alone', () => {
    expect(bestCandidate([
      { clipId: 'a', rank: 1, totalScore: 1, gatedOut: true, startMs: 0, endMs: 1, thumbnailUrl: null },
      { clipId: 'b', rank: 3, totalScore: 0.5, gatedOut: false, startMs: 0, endMs: 1, thumbnailUrl: null },
      { clipId: 'c', rank: 2, totalScore: 0.6, gatedOut: false, startMs: 0, endMs: 1, thumbnailUrl: null },
    ])?.clipId).toBe('c')
    expect(bestCandidate([{ clipId: 'a', rank: 1, totalScore: 1, gatedOut: true, startMs: 0, endMs: 1, thumbnailUrl: null }])).toBeUndefined()
  })

  it('runs the shift once per local day, after the start time, in the configured zone', () => {
    const lagos = localTime(new Date('2026-09-29T08:30:00Z'), 'Africa/Lagos')
    expect(lagos).toEqual({ date: '2026-09-29', minutes: 9 * 60 + 30 })
    expect(parseShiftTime('09:00')).toBe(540)
    expect(parseShiftTime('25:00')).toBeUndefined()
    expect(shiftDue(lagos, 540, null)).toBe(true)
    expect(shiftDue(lagos, 540, '2026-09-29')).toBe(false)
    expect(shiftDue(lagos, 600, '2026-09-28')).toBe(false)
  })

  it('refuses the DeerFlow browser in scout Sessions and leaves other Sessions alone', async () => {
    const hooks = new Map<string, (exec: unknown, next: () => Promise<unknown>) => Promise<unknown>>()
    const ctx = {
      agents: { list: () => [] },
      on(name: string, fn: (exec: unknown, next: () => Promise<unknown>) => Promise<unknown>) { hooks.set(name, fn) },
      effect() {},
      webServer: { register: () => () => {} },
    }
    apply(ctx as never, config({ dataDir: mkdtempSync(join(tmpdir(), 'scout-apply-')), enabled: live(false) }))
    const gate = hooks.get('tools/pre-execute')!
    const allow = () => Promise.resolve({ kind: 'allow' })
    const agent = (id: string) => ({ session: { id } })
    expect(await gate({ name: 'mcp__deerflow__browser_click', agent: agent('scout-1') }, allow)).toMatchObject({ kind: 'deny' })
    expect(await gate({ name: 'mcp__outreach__browser_click', agent: agent('scout-1') }, allow)).toEqual({ kind: 'allow' })
    expect(await gate({ name: 'mcp__deerflow__browser_click', agent: agent('session-9') }, allow)).toEqual({ kind: 'allow' })
  })
})

/** A fetch stand-in answering from a table of URL prefixes. */
function fakeFetch(pages: Record<string, { status?: number; body: string; type?: string }>, seen: string[] = []): typeof fetch {
  const answer = (input: string | URL | Request): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input)
    seen.push(url)
    const hit = Object.entries(pages).find(([prefix]) => url.startsWith(prefix))
    if (hit === undefined) return Promise.resolve(new Response('not found', { status: 404 }))
    const [, page] = hit
    return Promise.resolve(new Response(page.body, { status: page.status ?? 200, headers: { 'content-type': page.type ?? 'text/html' } }))
  }
  return answer
}

describe('finding an email before a comment', () => {
  it('reads addresses from mailto links and page text, and drops page furniture', () => {
    expect(emailsIn('<a href="mailto:Bookings@Show.ng?subject=hi">x</a> or hello&#64;show.ng, not noreply@show.ng or logo@2x.png')).toEqual(['bookings@show.ng', 'hello@show.ng'])
  })

  it('ignores hosting-platform and image-name addresses', () => {
    expect(creatorEmail('feeds@spreaker.com')).toBe(false)
    expect(creatorEmail('anything@soundcloud.com')).toBe(false)
    expect(creatorEmail('dashboard@2x.avif')).toBe(false)
    expect(creatorEmail('mifox87@gmail.com')).toBe(true)
  })

  it('takes a podcast as the channel\'s own only when the names match closely', () => {
    expect(ownShow(['Sweat Elite Podcast'], 'Sweat Elite - Podcast')).toBe(true)
    expect(ownShow(['Modern Girl', 'Emma'], 'Modern Girl')).toBe(true)
    expect(ownShow(['The Edge: Houston Astros'], 'The Edge')).toBe(false)
    expect(ownShow(['Confident Business English'], 'Business English Podcast')).toBe(false)
  })

  it('reads the links an About page lists', () => {
    const page = '"channelExternalLinkViewModel":{"title":{"content":"Website"},"link":{"content":"show.ng"}},"channelExternalLinkViewModel":{"title":{"content":"IG"},"link":{"content":"instagram.com/show"}}'
    expect(aboutLinks(page)).toEqual(['https://show.ng', 'https://instagram.com/show'])
  })

  it('follows the About page to the website\'s contact page, saves the address and the socials, and then allows only email', async () => {
    const about = '"channelExternalLinkViewModel":{"title":{"content":"Site"},"link":{"content":"smallpod.ng"}},"channelExternalLinkViewModel":{"title":{"content":"IG"},"link":{"content":"instagram.com/smallpod"}}'
    const seen: string[] = []
    const fetcher = fakeFetch({
      'https://www.youtube.com/channel/UC_small/about': { body: about },
      'https://smallpod.ng/contact': { body: '<p>Write to <a href="mailto:team@smallpod.ng">us</a></p>' },
      'https://smallpod.ng/': { body: '<p>Welcome</p>' },
    }, seen)
    const { run, deps } = setup({ fetch: fetcher })
    await run('scout_search')
    await deps.store.update((s) => { delete s.leads[0]!.email })
    const text = await run('scout_find_email', { channel_id: 'UC_small' })
    expect(text).toContain('Found team@smallpod.ng')
    expect(text).toContain('instagram.com/smallpod')
    expect(seen.some(u => u.includes('instagram.com'))).toBe(false)
    const lead = (await deps.store.read()).leads[0]!
    expect(lead.email).toBe('team@smallpod.ng')
    expect(lead.socials).toEqual(['https://instagram.com/smallpod'])
    expect(lead.contactSearch?.found).toBe('team@smallpod.ng')
  })

  it('records every place it looked when nothing has an address', async () => {
    const fetcher = fakeFetch({
      'https://www.youtube.com/channel/UC_small/about': { body: '' },
      'https://itunes.apple.com/search': { body: '{"results":[]}', type: 'application/json' },
    })
    const { run, deps } = setup({ fetch: fetcher })
    await run('scout_search')
    await deps.store.update((s) => { delete s.leads[0]!.email })
    const text = await run('scout_find_email', { channel_id: 'UC_small' })
    expect(text).toContain('No email found')
    expect(text).toContain('About page: 0 links')
    expect(text).toContain('podcast directory: no show named like')
    expect((await deps.store.read()).leads[0]!.contactSearch?.tried.length).toBe(2)
  })
})

describe('comment visibility', () => {
  const posted = 'The bit where he explains Lagos rent deposits is gold. I cut it into a vertical clip; reply and I will send it over.'

  it('finds a published comment signed out, and reports a missing one', async () => {
    const answer = (texts: string[]) => fakeFetch({ 'https://www.googleapis.com/youtube/v3/commentThreads': { type: 'application/json', body: JSON.stringify({ items: texts.map(t => ({ snippet: { topLevelComment: { snippet: { textOriginal: t } } } })) }) } })
    const signal = new AbortController().signal
    expect((await lookUpComment(answer([posted]), 'key', 'v1', posted, signal)).state).toBe('visible')
    expect((await lookUpComment(answer(['great episode']), 'key', 'v1', posted, signal)).state).toBe('missing')
    const off = fakeFetch({ 'https://www.googleapis.com/': { status: 403, type: 'application/json', body: '{"error":{"errors":[{"reason":"commentsDisabled"}]}}' } })
    expect(await lookUpComment(off, 'key', 'v1', posted, signal)).toEqual({ state: 'unknown', detail: 'YouTube API HTTP 403 (commentsDisabled)' })
  })

  it('calls a comment held only once it is still missing after the held window', () => {
    expect(nextVisibility('pending', 'missing', 3, 24)).toBe('unseen')
    expect(nextVisibility('unseen', 'missing', 25, 24)).toBe('held')
    expect(nextVisibility('unseen', 'visible', 25, 24)).toBe('visible')
    expect(nextVisibility('unseen', 'unknown', 25, 24)).toBe('unseen')
  })

  it('marks held comments, tells the owner, and stops comment pitches after two in a row', async () => {
    const fetcher = fakeFetch({ 'https://www.googleapis.com/youtube/v3/commentThreads': { type: 'application/json', body: '{"items":[]}' } })
    const { deps, notes, run } = setup({ fetch: fetcher }, config({ youtubeApiKey: live('key') }))
    await run('scout_search')
    await deps.store.update((s) => {
      const base = s.leads[0]!
      s.leads = ['A', 'B'].map(id => ({ ...base, channelId: `UC_${id}`, channelName: `Pod ${id}`, stage: 'pitched' as const, videoId: `v${id}`,
        pitch: { via: 'comment' as const, to: `https://www.youtube.com/watch?v=v${id}`, text: `clip for ${id}`, at: '2026-09-28T08:00:00Z', visibility: { state: 'unseen' as const, checkedAt: '2026-09-28T12:00:00Z' } } }))
    })
    const lines = await checkComments(deps, new AbortController().signal)
    expect(lines).toContain('Comment pitches stopped.')
    const state = await deps.store.read()
    expect(state.leads.map(l => l.pitch?.visibility?.state)).toEqual(['held', 'held'])
    expect(state.commentsPaused?.reason).toContain('held the last 2')
    expect(notes.filter(n => n.includes('YouTube is holding it'))).toHaveLength(2)
    expect(notes.some(n => n.includes('comment pitches are STOPPED'))).toBe(true)
    expect(await run('scout_status')).toContain('Comment pitches are STOPPED')
    expect(await run('scout_resume')).toContain('Comment pitches resumed')
  })

  it('retries a comment the API could not check for a passing reason, and settles one on a video with comments off', async () => {
    const answer = (reason: string) => fakeFetch({ 'https://www.googleapis.com/': { status: 403, type: 'application/json', body: JSON.stringify({ error: { errors: [{ reason }] } }) } })
    for (const [reason, expected] of [['quotaExceeded', 'pending'], ['commentsDisabled', 'unknown']] as const) {
      const { deps, run } = setup({ fetch: answer(reason) }, config({ youtubeApiKey: live('key') }))
      await run('scout_search')
      await deps.store.update((s) => {
        const l = s.leads[0]!
        l.stage = 'pitched'
        l.videoId = 'v1'
        l.pitch = { via: 'comment', to: 'https://www.youtube.com/watch?v=v1', text: 'clip for you', at: '2026-09-29T05:00:00Z', visibility: { state: 'pending' } }
      })
      await checkComments(deps, new AbortController().signal)
      expect((await deps.store.read()).leads[0]!.pitch?.visibility?.state).toBe(expected)
    }
  })

  it('checks nothing without an API key', async () => {
    const { deps } = setup()
    expect(await checkComments(deps, new AbortController().signal)).toEqual([])
  })
})

describe('follow-ups and numbers', () => {
  it('allows one follow-up, with the sample link, on an email unanswered for the configured days', async () => {
    const { run, deps } = setup()
    await run('scout_search')
    await deps.store.update((s) => {
      const l = s.leads[0]!
      l.stage = 'pitched'
      l.samplePageUrl = 'https://h.test/scout/s/abc'
      l.pitch = { via: 'email', to: 'hi@small.pod', text: 'Loved the Lagos rent episode, I clipped the landlord story: https://h.test/scout/s/abc', at: '2026-09-20T10:00:00Z' }
    })
    expect(followUpsDue((await deps.store.read()).leads, 6, new Date('2026-09-29T10:00:00Z'))).toHaveLength(1)
    expect(await run('scout_status')).toContain('Follow-ups due (scout_follow_up): Small Pod')
    await expect(run('scout_follow_up', { channel_id: 'UC_small', text: 'checking the clip got to you, happy to cut one from your newest episode too' }))
      .rejects.toThrow('must contain the sample link')
    expect(await run('scout_follow_up', { channel_id: 'UC_small', text: 'checking the clip got to you: https://h.test/scout/s/abc happy to cut one from your newest episode too' }))
      .toContain('reply to it in the same thread')
    await expect(run('scout_follow_up', { channel_id: 'UC_small', text: 'one more time https://h.test/scout/s/abc' })).rejects.toThrow('has no follow-up due')
  })

  it('counts email and comment pitches and their replies separately', () => {
    const lead = (via: 'email' | 'comment', replied: boolean, extra: object = {}) => ({
      channelId: 'x', channelName: 'x', channelUrl: 'x', stage: 'pitched' as const, source: 'scout', history: [], createdAt: 'a', updatedAt: 'a',
      pitch: { via, to: 'x', text: 't', at: '2026-09-01T00:00:00Z', ...extra },
      replies: replied ? [{ at: '2026-09-02T00:00:00Z', where: via, text: 'yes' }] : [],
    })
    const stats = outreachStats([
      lead('email', true), lead('email', false),
      lead('comment', false, { visibility: { state: 'held' } }), lead('comment', true, { visibility: { state: 'visible' } }), lead('comment', false),
    ])
    expect(stats.email).toEqual({ sent: 2, replied: 1, followUps: 0, repliedAfterFollowUp: 0 })
    expect(stats.comment).toEqual({ sent: 3, replied: 1, visible: 1, held: 1, unseen: 0, unchecked: 1 })
  })
})
