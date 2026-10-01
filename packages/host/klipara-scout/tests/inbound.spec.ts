import { createHmac } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { once } from 'node:events'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { parseEvent, recordEvent, verifySignature } from '../src/inbound.ts'
import { apply, buildScoutTools, finishSample, ScoutStore, type Config, type KliparaApi, type ScoutDeps } from '../src/index.ts'
import { emptyState, type Lead } from '../src/store.ts'

const SECRET = 'test-secret'
const CHANNEL = 'UCabcdefghijklmnopqrstuv'
const exec = { signal: new AbortController().signal } as ToolRunContext

function live<T>(value: T): { get: () => T } {
  return { get: () => value }
}

function body(status: 'confirmed' | 'sent', extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    channel_id: CHANNEL, channel_url: `https://www.youtube.com/channel/${CHANNEL}`, email: 'Host@Show.fm',
    source_url: 'https://www.youtube.com/watch?v=abc', sample_url: status === 'sent' ? 'https://klipara.linkfa.de/s/fc_abc' : null,
    status, occurred_at: '2026-10-01T05:00:00.000Z', ...extra,
  })
}

function sign(raw: string, ts: number, secret = SECRET): string {
  return `v1=${createHmac('sha256', secret).update(`${String(ts)}.${raw}`).digest('hex')}`
}

function lead(stage: Lead['stage'], extra: Partial<Lead> = {}): Lead {
  return { channelId: CHANNEL, channelName: 'The Show', channelUrl: 'u', stage, source: 'scout', replies: [], history: [], createdAt: 'x', updatedAt: 'x', ...extra }
}

describe('free-clip signatures', () => {
  const now = 1_790_000_000
  it('accepts Klipara\'s signature and refuses a wrong secret, an edited body or an old timestamp', () => {
    const raw = body('sent')
    expect(verifySignature(SECRET, String(now), sign(raw, now), raw, now + 10)).toBe('ok')
    expect(verifySignature(SECRET, String(now), sign(raw, now, 'other'), raw, now)).toBe('bad signature')
    expect(verifySignature(SECRET, String(now), sign(raw, now), raw.replace('abc', 'xyz'), now)).toBe('bad signature')
    expect(verifySignature(SECRET, String(now), sign(raw, now), raw, now + 301)).toBe('stale')
    expect(verifySignature('', String(now), sign(raw, now, ''), raw, now)).toBe('bad signature')
  })
})

describe('recording a free-clip request', () => {
  it('takes a stranger as a replied lead with their address, and Klipara\'s retry changes nothing', () => {
    const state = emptyState()
    const event = parseEvent(body('confirmed'))
    if (typeof event === 'string') throw new Error(event)
    const first = recordEvent(state, 'fce_1', event, '2026-10-01T05:00:01Z')
    expect(first).toMatchObject({ created: true, duplicate: false })
    expect(state.leads[0]).toMatchObject({ stage: 'replied', source: 'free-clip', email: 'host@show.fm', inbound: { status: 'confirmed' } })
    expect(recordEvent(state, 'fce_1', event, '2026-10-01T05:00:02Z').duplicate).toBe(true)
    expect(state.leads[0]!.replies).toHaveLength(1)
  })

  it('takes a lead out of the pitch line at any stage, but leaves won and lost alone', () => {
    const event = parseEvent(body('sent'))
    if (typeof event === 'string') throw new Error(event)
    for (const stage of ['found', 'sampling', 'sampled', 'pitched', 'skipped'] as const) {
      const state = { ...emptyState(), leads: [lead(stage)] }
      recordEvent(state, 'fce_2', event, 'now')
      expect(state.leads[0]).toMatchObject({ stage: 'replied', inbound: { status: 'sent', sampleUrl: 'https://klipara.linkfa.de/s/fc_abc' } })
    }
    const won = { ...emptyState(), leads: [lead('won')] }
    recordEvent(won, 'fce_3', event, 'now')
    expect(won.leads[0]!.stage).toBe('won')
  })

  it('accepts a request without an address, and refuses a body that is not a request', () => {
    const event = parseEvent(body('confirmed', { email: null }))
    expect(typeof event === 'string' ? event : event.email).toBeUndefined()
    expect(parseEvent(body('confirmed', { channel_id: 'not-a-channel' }))).toBe('channel_id is not a YouTube channel id')
    expect(parseEvent(body('sent', { sample_url: null }))).toBe('a sent request has no sample_url')
    expect(parseEvent('[]')).toBe('the body is not a JSON object')
  })
})

function deps(store: ScoutStore, klipara: Partial<KliparaApi> = {}): ScoutDeps {
  return {
    store,
    config: { outreachBrowser: live('outreach'), pitchesPerDay: live(5), samplesPerDay: live(5), timeZone: live('Africa/Lagos') } as Config,
    ytDlp: () => Promise.reject(new Error('offline')),
    klipara: klipara as KliparaApi,
    samplesDir: join(mkdtempSync(join(tmpdir(), 'scout-in-')), 'samples'),
    sampleBase: () => 'https://klipara.test/s',
    notify: () => Promise.resolve('sent'),
    now: () => new Date('2026-10-01T06:00:00Z'),
  }
}

describe('the scout and a creator who asked', () => {
  it('refuses to pitch them', async () => {
    const store = new ScoutStore(join(mkdtempSync(join(tmpdir(), 'scout-in-')), 'leads.json'))
    await store.update((s) => { s.leads.push(lead('sampled', { samplePageUrl: 'https://klipara.test/s/x', inbound: { status: 'sent', sourceUrl: '', at: 'x' } })) })
    const pitch = buildScoutTools(deps(store)).find((t: ToolDefinition) => t.name === 'scout_pitch')!
    await expect(pitch.execute({ channel_id: CHANNEL, via: 'email', to: 'host@show.fm', text: 'Subject: hi\nhttps://klipara.test/s/x' }, exec)).rejects.toThrow('never pitched')
    expect((await store.read()).leads[0]!.stage).toBe('sampled')
  })

  it('does not put them back in line when a sample finishes after they asked', async () => {
    const store = new ScoutStore(join(mkdtempSync(join(tmpdir(), 'scout-in-')), 'leads.json'))
    await store.update((s) => { s.leads.push(lead('sampling', { jobId: 'job_1' })) })
    const klipara = {
      getJob: () => Promise.resolve({ id: 'job_1', state: 'succeeded' }),
      // The creator's request lands while the sample check is reading candidates.
      candidates: async () => {
        const event = parseEvent(body('confirmed'))
        if (typeof event === 'string') throw new Error(event)
        await store.update(s => recordEvent(s, 'fce_9', event, 'now'))
        return []
      },
    } as Partial<KliparaApi>
    await finishSample(deps(store, klipara), CHANNEL, exec.signal)
    expect((await store.read()).leads[0]!.stage).toBe('replied')
  })
})

describe('the free-clip route', () => {
  let servers: Server[] = []
  afterEach(async () => {
    await Promise.all(servers.map(s => new Promise<void>(resolve => s.close(() => { resolve() }))))
    servers = []
  })

  async function listen(handler: (req: IncomingMessage, res: ServerResponse) => unknown): Promise<string> {
    const server = createServer((req, res) => { void handler(req, res) })
    servers.push(server)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    return `http://127.0.0.1:${String(typeof address === 'object' && address !== null ? address.port : 0)}`
  }

  it('records a signed request, tells the owner once the clip is sent, and refuses an unsigned one', async () => {
    const notes: string[] = []
    const whatsapp = await listen(async (req, res) => {
      let text = ''
      for await (const chunk of req) text += String(chunk)
      notes.push((JSON.parse(text) as { args: { text: string } }).args.text)
      res.end('{}')
    })
    const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => unknown>()
    const ctx = {
      agents: { list: () => [] },
      on() {},
      effect(fn: () => unknown, label?: string) { if (label?.includes('inbound') === true) fn() },
      webServer: {
        register: (r: { path: string; handler: (req: IncomingMessage, res: ServerResponse) => unknown }) => {
          routes.set(r.path, r.handler)
          return () => {}
        },
      },
    }
    const dataDir = mkdtempSync(join(tmpdir(), 'scout-route-'))
    apply(ctx as never, {
      dataDir, path: '/scout', token: '', freeClipSecret: SECRET, enabled: live(false), notifyTo: live('Me'), whatsappUrl: whatsapp, whatsappToken: 't',
      kliparaApiKey: live(''), maxShorts: live(10), ytDlp: '/bin/false', timeoutMs: 5000, kliparaApi: 'http://k', sampleBaseUrl: live('https://k/s'),
      fallbackProvider: live(''), fallbackModel: live(''), provider: live(''), model: live(''), fallbackCooldownMinutes: live(15), fallbackPitches: live(false),
      timeZone: live('Africa/Lagos'), publicBaseUrl: '',
    } as Config)
    const url = `${await listen(routes.get('/scout/inbound/free-clip')!)}/scout/inbound/free-clip`
    const post = (raw: string, headers: Record<string, string>) => fetch(url, { method: 'POST', body: raw, headers: { 'Content-Type': 'application/json', ...headers } })
    const ts = Math.floor(Date.now() / 1000)

    const unsigned = await post(body('confirmed'), { 'X-Klipara-Event-Id': 'fce_a', 'X-Klipara-Timestamp': String(ts), 'X-Klipara-Signature': 'v1=00' })
    expect(unsigned.status).toBe(401)

    for (const [id, status] of [['fce_a', 'confirmed'], ['fce_b', 'sent'], ['fce_b', 'sent']] as const) {
      const raw = body(status)
      const response = await post(raw, { 'X-Klipara-Event-Id': id, 'X-Klipara-Timestamp': String(ts), 'X-Klipara-Signature': sign(raw, ts) })
      expect(response.status).toBe(200)
    }
    await expect.poll(() => notes.length).toBe(1)
    expect(notes[0]).toContain('https://klipara.linkfa.de/s/fc_abc')
    expect(notes[0]).toContain('host@show.fm')
    const state = await new ScoutStore(join(dataDir, 'leads.json')).read()
    expect(state.leads).toHaveLength(1)
    expect(state.leads[0]).toMatchObject({ stage: 'replied', inbound: { status: 'sent' } })
    expect(state.leads[0]!.replies).toHaveLength(2)
  })
})
