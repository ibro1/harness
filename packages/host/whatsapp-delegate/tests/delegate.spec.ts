/**
 * The WhatsApp delegate against a stand-in WhatsApp service, Session driver and clock: when a burst is handed over,
 * when the owner has taken a conversation, what reaches the contact, what waits for the owner, and what never goes.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  chatJid, contactFrom, contactOfSession, DelegateEngine, DelegateStore, digestText, findSecrets, parseOwnerCommand, planBatch, splitReply,
  withinRateLimit, wrongContact, type Contact, type EngineSettings, type QueuedRow, type WaRow, type WhatsAppClient,
} from '../src/index.ts'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const HELLEN_CHAT = '2348000000001@s.whatsapp.net'
const HELLEN_OTHER = '2348000000002@s.whatsapp.net'
const OWNER_CHAT = '2348099999999@s.whatsapp.net'
const TIMING = { quietMs: 90_000, maxWaitMs: 240_000, ownerActiveMs: 600_000 }

function row(id: number, change: Partial<WaRow> = {}): WaRow {
  return {
    id, waId: `W${String(id)}`, chat: HELLEN_CHAT, sender: HELLEN_CHAT, senderName: 'Hellen', fromMe: false, viaApi: false,
    ts: 1_000 + id, kind: 'text', body: `message ${String(id)}`, replyTo: '', hasMedia: false, ...change,
  }
}

function queued(id: number, seenAt: number, change: Partial<WaRow> = {}): QueuedRow {
  return { ...row(id, change), seenAt }
}

describe('planBatch', () => {
  it('waits for the contact to stop typing, then hands over every message of the burst', () => {
    const queue = [queued(1, 0), queued(2, 30_000)]
    expect(planBatch(queue, new Set(), 0, 100_000, TIMING)).toEqual({ action: 'wait', dueAt: 120_000 })
    expect(planBatch(queue, new Set(), 0, 120_000, TIMING)).toMatchObject({ action: 'process', messages: [{ id: 1 }, { id: 2 }] })
  })

  it('hands a burst over after the longest wait however the contact keeps typing', () => {
    const queue = [queued(1, 0), queued(2, 200_000), queued(3, 230_000)]
    expect(planBatch(queue, new Set(), 0, 239_000, TIMING).action).toBe('wait')
    expect(planBatch(queue, new Set(), 0, 240_000, TIMING).action).toBe('process')
  })

  it('stays out when the owner answered after the contact\'s latest message', () => {
    const queue = [queued(1, 0), queued(2, 1000, { fromMe: true, ts: 2_000 })]
    expect(planBatch(queue, new Set(), 0, 1_000_000, TIMING)).toEqual({ action: 'handoff', reason: 'the owner answered in the chat himself' })
  })

  it('does not count its own or another employee\'s sends as the owner answering', () => {
    const queue = [queued(1, 0), queued(2, 1000, { fromMe: true, ts: 2_000, waId: 'MINE' }), queued(3, 1000, { fromMe: true, viaApi: true, ts: 2_000 })]
    expect(planBatch(queue, new Set(['MINE']), 0, 1_000_000, TIMING).action).toBe('process')
  })

  it('leaves the conversation to the owner for a while after he typed in it', () => {
    // The owner wrote at 1500 s; the contact answered him at 1501 s.
    const queue = [queued(501, 0)]
    const plan = planBatch(queue, new Set(), 1_500, 200_000, TIMING)
    expect(plan).toEqual({ action: 'wait', dueAt: 1_500_000 + 600_000 })
    expect(planBatch(queue, new Set(), 1_500, 2_100_000, TIMING).action).toBe('process')
  })

  it('is idle when only the owner wrote', () => {
    expect(planBatch([queued(1, 0, { fromMe: true })], new Set(), 0, 1_000_000, TIMING)).toEqual({ action: 'idle' })
  })
})

describe('owner commands', () => {
  it('reads approvals, edits, rejections, pause and instructions', () => {
    expect(parseOwnerCommand('ok 7')).toEqual({ kind: 'approve', code: 7 })
    expect(parseOwnerCommand('  OK #12 ')).toEqual({ kind: 'approve', code: 12 })
    expect(parseOwnerCommand('yes 3')).toEqual({ kind: 'approve', code: 3 })
    expect(parseOwnerCommand('no 7')).toEqual({ kind: 'reject', code: 7 })
    expect(parseOwnerCommand('edit 7: Sure, Monday works.\nThanks')).toEqual({ kind: 'edit', code: 7, text: 'Sure, Monday works.\nThanks' })
    expect(parseOwnerCommand('edit 7 - fine')).toEqual({ kind: 'edit', code: 7, text: 'fine' })
    expect(parseOwnerCommand('pause delegate')).toEqual({ kind: 'pause' })
    expect(parseOwnerCommand('Resume the delegate')).toEqual({ kind: 'resume' })
    expect(parseOwnerCommand('@hellen tell her Monday')).toEqual({ kind: 'instruct', name: 'hellen', text: 'tell her Monday' })
  })

  it('ignores ordinary messages', () => {
    for (const text of ['ok', 'no problem', 'ok thanks 7 days', 'edit 7:', 'I said no 7 times', '']) expect(parseOwnerCommand(text)).toBeUndefined()
  })
})

describe('limits and checks', () => {
  it('allows replies up to the limit in the window', () => {
    const now = 1_000_000
    const sent = [now - 1000, now - 2000, now - 700_000]
    expect(withinRateLimit(sent, now, 3, 600_000)).toBe(true)
    expect(withinRateLimit(sent, now, 3, 600_000, 2)).toBe(false)
    expect(withinRateLimit(sent, now, 2, 600_000)).toBe(false)
  })

  it('finds secrets in outgoing text', () => {
    expect(findSecrets('Fixed in abc1234, please refresh https://app.example.com/login')).toEqual([])
    expect(findSecrets('use ghp_abcdefghijklmnopqrstuvwxyz0123456789AB')).toContain('a GitHub token')
    expect(findSecrets('DATABASE_URL=postgres://app:hunter22@db:5432/app')).toEqual(['a password in a connection string'])
    expect(findSecrets('JWT_SECRET: s3cr3tvalue')).toContain('a secret setting')
    expect(findSecrets('key sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv')).toContain('an API key')
    expect(findSecrets('https://x.example.com/reset?token=abcdef123456')).toContain('a secret in a link')
    expect(findSecrets('the value is Zq8vN3kLp0Wx7Rt2Yb5Hc9Jd4Mf6Gs1Ae8Ku3Ln0Po2')).toContain('a long key-like string')
    expect(findSecrets('your code is 4821-SECRETVALUEHERE', ['SECRETVALUEHERE'])).toContain('a value from the server\'s secret settings')
  })

  it('splits long replies at paragraph boundaries', () => {
    const parts = splitReply(`${'a'.repeat(150)}\n\n${'b'.repeat(150)}\n\n${'c'.repeat(50)}`, 220)
    expect(parts).toEqual(['a'.repeat(150), `${'b'.repeat(150)}\n\n${'c'.repeat(50)}`])
    expect(splitReply('  short  ', 220)).toEqual(['short'])
    expect(splitReply('x'.repeat(500), 200).every(p => p.length <= 200)).toBe(true)
  })

  it('reads contacts and numbers the way the owner types them', () => {
    expect(chatJid('+234 800 000 0001')).toBe(HELLEN_CHAT)
    expect(chatJid('12345@lid')).toBe('12345@lid')
    expect(chatJid('call me')).toBeUndefined()
    expect(contactFrom({ id: 'hellen', name: 'Hellen', numbers: ['+2348000000001', 'nonsense'] })).toMatchObject({ numbers: ['+2348000000001'], enabled: true })
    expect(contactFrom({ id: 'x', numbers: [] })).toBeUndefined()
  })

  it('knows a delegate Session and its contact from the id', () => {
    expect(contactOfSession('wad-hellen-2-0f8fad5b-d9cb-469f-a165-70867728950e')).toBe('hellen-2')
    expect(contactOfSession('tts-0f8fad5b-d9cb-469f-a165-70867728950e')).toBeUndefined()
    expect(wrongContact('hellen', ['hellen', 'Hellen'], 'Hellen')).toBeUndefined()
    expect(wrongContact('hellen', ['hellen', 'Hellen'], 'Musa')).toMatch(/only Hellen/u)
  })
})

/** A WhatsApp service in memory, with the sidecar's read semantics. */
class FakeWhatsApp implements WhatsAppClient {
  configured = true
  rows: WaRow[] = []
  sends: { to: string; text: string; quote?: string }[] = []
  fail = false
  private next = 1

  add(change: Partial<WaRow>): WaRow {
    const r = row(this.next++, change)
    r.ts = Math.max(r.ts, ...this.rows.map(x => x.ts + 1))
    if (change.ts !== undefined) r.ts = change.ts
    this.rows.push(r)
    return r
  }

  read = async (chat: string, options: { after?: number; limit: number }): Promise<WaRow[]> => {
    const mine = this.rows.filter(r => r.chat === chat)
    if (options.after !== undefined) return mine.filter(r => r.id > options.after!).slice(0, options.limit)
    return [...mine].reverse().slice(0, options.limit)
  }

  media = async (rowId: number): Promise<{ mime: string; data: Buffer }> => {
    if (!this.rows.some(r => r.id === rowId && r.hasMedia)) throw new Error('no media')
    return { mime: 'audio/ogg', data: Buffer.from('voice') }
  }

  send = async (to: string, text: string, quote?: string) => {
    if (this.fail) return { ok: false as const, error: 'offline' }
    this.sends.push({ to, text, ...quote === undefined ? {} : { quote } })
    const r = this.add({ chat: to, fromMe: true, viaApi: true, body: text, sender: 'me' })
    return { ok: true as const, waId: r.waId }
  }
}

function bench(change: Partial<EngineSettings> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wad-'))
  dirs.push(dir)
  const store = new DelegateStore(join(dir, 'state.json'))
  const whatsapp = new FakeWhatsApp()
  const clock = { now: 10_000_000 }
  const prompts: { contact: string; sessionId: string | undefined; prompt: string }[] = []
  let idle: () => void = () => undefined
  const contacts: Contact[] = [{
    id: 'hellen', name: 'Hellen', numbers: ['+2348000000001', '2348000000002'], workspacePath: '/srv/zenith', repoUrl: 'git@x:zenith.git',
    deployBranch: 'deploy', liveUrl: 'https://zenith.example.com', notes: 'Client on Zenith Carex; English, friendly.', enabled: true, paused: false,
  }]
  const settings: EngineSettings = {
    enabled: true, notifyTo: '+2348099999999', timeZone: 'Africa/Lagos', timing: TIMING, contextMessages: 30, maxReplies: 3,
    rateWindowMs: 600_000, maxReplyChars: 1500, digest: true, skillPath: '/skills/whatsapp-delegate/SKILL.md', ...change,
  }
  const engine = new DelegateEngine({
    store, whatsapp, contacts: () => contacts, settings: () => settings,
    driver: {
      deliver: async (contact, sessionId, prompt) => {
        prompts.push({ contact: contact.id, sessionId, prompt })
        return { sessionId: sessionId ?? `wad-${contact.id}-0f8fad5b-d9cb-469f-a165-70867728950e`, idle: new Promise<void>((resolve) => { idle = resolve }) }
      },
    },
    transcribe: async audio => `transcript of ${audio.data.toString()}`,
    mediaDir: join(dir, 'media'),
    secrets: () => ['TOPSECRETVALUE1'],
    now: () => clock.now,
    warn: () => undefined,
  })
  // Seed both chats so the first poll starts after them.
  whatsapp.add({ body: 'old history' })
  whatsapp.add({ chat: OWNER_CHAT, sender: OWNER_CHAT, fromMe: true, body: 'old owner note' })
  const finishIdle = async (): Promise<void> => {
    idle()
    await new Promise(r => setTimeout(r, 20))
  }
  return { engine, store, whatsapp, clock, prompts, settings, contacts, finishIdle }
}

describe('DelegateEngine', () => {
  it('starts after the existing history, then hands a quiet burst to the contact\'s Session with its context', async () => {
    const b = bench()
    await b.engine.poll()
    b.whatsapp.add({ body: 'The login page is blank' })
    b.whatsapp.add({ chat: HELLEN_OTHER, sender: HELLEN_OTHER, body: 'from my other phone', kind: 'audio', hasMedia: true })
    await b.engine.poll()
    expect(b.prompts).toHaveLength(0)
    b.clock.now += 91_000
    await b.engine.poll()
    expect(b.prompts).toHaveLength(1)
    const prompt = b.prompts[0]?.prompt ?? ''
    expect(prompt).toContain('read that file now')
    expect(prompt).toContain('The login page is blank')
    expect(prompt).toContain('[voice note, transcribed: "transcript of voice"]')
    expect(prompt).toContain('Earlier in the chat')
    expect(prompt).toContain('old history')
    expect(prompt).toContain('deploy branch deploy')
    const state = await b.store.read()
    expect(state.contacts['hellen']?.sessionId).toMatch(/^wad-hellen-/u)
    expect(state.batches.at(-1)?.status).toBe('running')
  })

  it('sends a routine reply to the chat the contact wrote from, once, within the rate limit', async () => {
    const b = bench()
    await b.engine.poll()
    const inbound = b.whatsapp.add({ chat: HELLEN_OTHER, sender: HELLEN_OTHER, body: 'hello?' })
    await b.engine.poll()
    b.clock.now += 91_000
    await b.engine.poll()
    expect(b.prompts).toHaveLength(1)
    expect(await b.engine.reply('hellen', { text: 'Seen, checking it now', tier: 'routine', why: 'ack', quote: inbound.id })).toBe('Sent.')
    expect(b.whatsapp.sends).toEqual([{ to: HELLEN_OTHER, text: 'Seen, checking it now', quote: inbound.waId }])
    await expect(b.engine.reply('hellen', { text: 'Seen,  checking it now', tier: 'routine', why: 'again' })).rejects.toThrow(/already sent/u)
    await b.engine.reply('hellen', { text: 'two', tier: 'routine', why: 'x' })
    await b.engine.reply('hellen', { text: 'three', tier: 'routine', why: 'x' })
    await expect(b.engine.reply('hellen', { text: 'four', tier: 'routine', why: 'x' })).rejects.toThrow(/limit/u)
    b.clock.now += 601_000
    await expect(b.engine.reply('hellen', { text: 'four', tier: 'routine', why: 'x' })).resolves.toBe('Sent.')
    // The delegate's own sends never look like the owner taking over.
    b.whatsapp.add({ chat: HELLEN_OTHER, sender: HELLEN_OTHER, body: 'thanks' })
    await b.engine.poll()
    b.clock.now += 91_000
    await b.engine.poll()
    expect(b.prompts).toHaveLength(2)
    expect((await b.store.read()).activity.some(a => a.kind === 'handoff')).toBe(false)
  })

  it('refuses text with secrets and never sends it', async () => {
    const b = bench()
    await expect(b.engine.reply('hellen', { text: 'the password is TOPSECRETVALUE1', tier: 'routine', why: 'x' })).rejects.toThrow(/secret settings/u)
    await expect(b.engine.reply('hellen', { text: 'GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789AB', tier: 'needs_approval', why: 'x' }))
      .rejects.toThrow(/GitHub token/u)
    expect(b.whatsapp.sends).toEqual([])
    expect((await b.store.read()).activity.filter(a => a.kind === 'refused')).toHaveLength(2)
  })

  it('stays out of a conversation the owner answered himself', async () => {
    const b = bench()
    await b.engine.poll()
    b.whatsapp.add({ body: 'Are you there?' })
    b.whatsapp.add({ fromMe: true, sender: 'me', body: 'Yes, one minute' })
    await b.engine.poll()
    b.clock.now += 91_000
    await b.engine.poll()
    expect(b.prompts).toHaveLength(0)
    const state = await b.store.read()
    expect(state.activity.at(-1)).toMatchObject({ kind: 'handoff' })
    expect(state.contacts['hellen']?.queue).toEqual([])
  })

  it('queues commitments for the owner and sends them on his "ok", his edit, or never on his "no"', async () => {
    const b = bench()
    await b.engine.poll()
    b.whatsapp.add({ body: 'When will it be ready?' })
    await b.engine.poll()
    b.clock.now += 91_000
    await b.engine.poll()
    expect(await b.engine.reply('hellen', { text: 'By Monday', tier: 'needs_approval', why: 'a date' })).toMatch(/draft #1/u)
    expect(await b.engine.reply('hellen', { text: 'It costs 50k', tier: 'needs_approval', why: 'price' })).toMatch(/draft #2/u)
    expect(await b.engine.reply('hellen', { text: 'Sorry for the outage', tier: 'needs_approval', why: 'apology' })).toMatch(/draft #3/u)
    expect(b.whatsapp.sends.map(s => s.to)).toEqual([OWNER_CHAT, OWNER_CHAT, OWNER_CHAT])
    expect(b.whatsapp.sends[0]?.text).toContain('Reply "ok 1" to send it')

    b.whatsapp.add({ chat: OWNER_CHAT, sender: OWNER_CHAT, fromMe: true, body: 'ok 1' })
    b.whatsapp.add({ chat: OWNER_CHAT, sender: OWNER_CHAT, fromMe: true, body: 'edit 2: We will talk about price on Monday' })
    b.whatsapp.add({ chat: OWNER_CHAT, sender: OWNER_CHAT, fromMe: true, body: 'no 3' })
    b.whatsapp.add({ chat: OWNER_CHAT, sender: OWNER_CHAT, fromMe: true, body: 'ok 1' })
    await b.engine.poll()
    const toHellen = b.whatsapp.sends.filter(s => s.to === HELLEN_CHAT).map(s => s.text)
    expect(toHellen).toEqual(['By Monday', 'We will talk about price on Monday'])
    const answers = b.whatsapp.sends.filter(s => s.to === OWNER_CHAT).slice(3).map(s => s.text)
    expect(answers).toEqual(['Sent #1 to Hellen.', 'Sent #2 to Hellen.', 'Dropped #3; nothing was sent to Hellen.', 'Draft #1 was already sent.'])
    const state = await b.store.read()
    expect(state.approvals.map(a => a.status)).toEqual(['sent', 'sent', 'rejected'])
    expect(state.contacts['hellen']?.notes).toHaveLength(3)
  })

  it('ignores commands it sent itself and messages in other chats', async () => {
    const b = bench()
    await b.engine.poll()
    await b.engine.notifyOwner('Reply "ok 1"')
    b.whatsapp.add({ chat: '2348077777777@s.whatsapp.net', sender: 'x', body: 'ok 1' })
    b.whatsapp.add({ chat: '2348077777777@s.whatsapp.net', sender: 'x', body: 'pause delegate' })
    await b.engine.poll()
    expect(b.whatsapp.sends).toHaveLength(1)
    expect((await b.store.read()).paused).toBeNull()
  })

  it('sends the owner one digest when the Session finishes a batch it acted on', async () => {
    const b = bench()
    await b.engine.poll()
    b.whatsapp.add({ body: 'The login page is blank' })
    await b.engine.poll()
    b.clock.now += 91_000
    await b.engine.poll()
    await b.engine.reply('hellen', { text: 'Fixed, please refresh', tier: 'routine', why: 'deployed and checked' })
    expect(await b.engine.tellOwner('hellen', 'Fixed the blank login in abc1234, deployed.', false)).toMatch(/digest/u)
    await b.finishIdle()
    const digest = b.whatsapp.sends.filter(s => s.to === OWNER_CHAT).at(-1)?.text
    expect(digest).toBe([
      'WhatsApp delegate · Hellen',
      'They wrote: "The login page is blank"',
      'Replied: "Fixed, please refresh"',
      'Note: Fixed the blank login in abc1234, deployed.',
    ].join('\n'))
    expect((await b.store.read()).batches.at(-1)?.status).toBe('done')
  })

  it('stays quiet for a closed "thanks" and tells the owner when no decision was made', () => {
    const base = { id: 'b', contactId: 'hellen', startedAt: '', status: 'done' as const, messages: [row(1, { body: 'thanks' })] }
    expect(digestText('Hellen', [{ ...base, actions: [{ kind: 'no-reply', text: 'closing thanks', at: '' }] }])).toBeUndefined()
    expect(digestText('Hellen', [{ ...base, actions: [] }])).toContain('without deciding')
    expect(digestText('Hellen', [{ ...base, actions: [{ kind: 'no-reply', text: 'personal', at: '', mention: true }] }])).toContain('Not answered: personal')
  })

  it('does nothing for a paused contact and starts from new messages when switched back on', async () => {
    const b = bench()
    await b.engine.poll()
    b.whatsapp.add({ body: 'before pause' })
    const contact = b.contacts[0]!
    contact.paused = true
    await b.engine.poll()
    b.clock.now += 300_000
    await b.engine.poll()
    expect(b.prompts).toHaveLength(0)
    await expect(b.engine.reply('hellen', { text: 'hi', tier: 'routine', why: 'x' })).rejects.toThrow(/paused/u)
    contact.paused = false
    await b.engine.poll()
    b.whatsapp.add({ body: 'after pause' })
    await b.engine.poll()
    b.clock.now += 91_000
    await b.engine.poll()
    expect(b.prompts[0]?.prompt).toContain('after pause')
    const prompt = b.prompts[0]?.prompt ?? ''
    expect(prompt.slice(prompt.indexOf('New messages'), prompt.indexOf('Earlier in the chat'))).not.toContain('before pause')
  })

  it('puts a batch cut short by a restart back once, unless it was answered', async () => {
    const b = bench()
    await b.engine.poll()
    b.whatsapp.add({ body: 'Is the server down?' })
    await b.engine.poll()
    b.clock.now += 91_000
    await b.engine.poll()
    await b.engine.recover()
    let state = await b.store.read()
    expect(state.batches.at(-1)?.status).toBe('interrupted')
    expect(state.contacts['hellen']?.queue.map(q => q.body)).toEqual(['Is the server down?'])
    await b.engine.poll()
    expect(b.prompts).toHaveLength(2)
    await b.engine.noReply('hellen', 'already handled', false)
    await b.engine.recover()
    state = await b.store.read()
    expect(state.contacts['hellen']?.queue).toEqual([])
  })
})
