/**
 * The meeting reminders against a stand-in clock and WhatsApp route: which day a monthly meeting falls on, the Hijri
 * and English dates, the message, and that each reminder goes once, late only within its window, and retries then
 * gives up.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  Config, DEFAULT_TEMPLATE, englishDate, hijriDate, MeetingReminders, nthWeekday, occurrences, ordinal, planReminders, ReminderStore,
  renderTemplate, ruleProblems, whatsAppGroups, whatsAppSender, whenText, type Rule,
} from '../src/index.ts'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const EXCO: Rule = {
  id: 'amya-exco',
  label: 'AMYA Exco meeting',
  chat: '120363000000000001@g.us',
  meeting: { nth: 1, weekday: 'sat' },
  time: '8:15 PM (shortly after Isha prayer)',
  venue: 'WhatsApp group call or Aso\'C Central Masjid',
  reminders: [{ daysBefore: 2, at: '09:00' }, { daysBefore: 0, at: '09:00' }],
  enabled: true,
}

/** Lagos is UTC+1 all year, so local 09:00 is 08:00Z. */
function lagos(local: string): Date {
  return new Date(new Date(`${local}:00Z`).getTime() - 3_600_000)
}

function setup(options: { rules?: Rule[]; answer?: () => unknown } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'meeting-reminders-'))
  dirs.push(dir)
  const store = new ReminderStore(join(dir, 'state.json'))
  const sends: { to: string; text: string }[] = []
  const alerts: string[] = []
  const logs: string[] = []
  let now = lagos('2026-10-01T09:00')
  const answer = options.answer ?? (() => ({ result: { sent: true } }))
  const send = whatsAppSender({ url: 'http://wa.test/command', token: 't' }, (_url, init) => {
    const body = JSON.parse(init?.body as string) as { args: { to: string; text: string } }
    sends.push({ to: body.args.to, text: body.args.text })
    return Promise.resolve(new Response(JSON.stringify(answer())))
  })
  const reminders = new MeetingReminders({
    store,
    rules: () => options.rules ?? [EXCO],
    timeZone: () => 'Africa/Lagos',
    hijriOffset: () => 0,
    template: () => DEFAULT_TEMPLATE,
    send,
    alert: (text) => { alerts.push(text); return Promise.resolve('sent to owner') },
    now: () => now,
    log: (line) => { logs.push(line) },
    lateWindowMinutes: 360,
    maxAttempts: 3,
  })
  return { store, sends, alerts, logs, reminders, dir, at: (local: string) => { now = lagos(local) } }
}

describe('config', () => {
  it('accepts rules without an override or a template, and refuses a bad weekday', () => {
    // Settings arrive as parsed JSON, so the rules are handed over untyped.
    const rules = (changes: object): never => JSON.parse(JSON.stringify([{ ...EXCO, enabled: undefined, ...changes }])) as never
    expect(() => Config({ rules: rules({}) })).not.toThrow()
    expect(() => Config({ rules: rules({ meeting: { nth: 1, weekday: 'saturday' } }) })).toThrow()
    expect(() => Config({ rules: rules({ meeting: { nth: 'last', weekday: 'fri' } }) })).not.toThrow()
  })
})

describe('nth weekday of a month', () => {
  it('finds the first Saturday and Sunday by day of month and weekday together', () => {
    expect(nthWeekday(2026, 10, 1, 'sat')).toBe('2026-10-03')
    expect(nthWeekday(2026, 10, 1, 'sun')).toBe('2026-10-04')
    expect(nthWeekday(2026, 11, 1, 'sat')).toBe('2026-11-07')
    expect(nthWeekday(2026, 11, 1, 'sun')).toBe('2026-11-01')
  })

  it('finds the last weekday and refuses a fifth that the month lacks', () => {
    expect(nthWeekday(2026, 10, 'last', 'fri')).toBe('2026-10-30')
    expect(nthWeekday(2026, 1, 'last', 'sat')).toBe('2026-01-31')
    expect(nthWeekday(2026, 2, 'last', 'fri')).toBe('2026-02-27')
    expect(nthWeekday(2026, 10, 5, 'sat')).toBe('2026-10-31')
    expect(nthWeekday(2026, 10, 5, 'mon')).toBeUndefined()
  })

  it('lists meetings from a day on, skipping an overridden month and applying a changed venue', () => {
    expect(occurrences(EXCO, '2026-10-04', 2).map(o => o.date)).toEqual(['2026-11-07', '2026-12-05'])
    expect(occurrences(EXCO, '2026-10-03', 1).map(o => o.date)).toEqual(['2026-10-03'])
    const skipped = occurrences({ ...EXCO, override: { month: '2026-11', skip: true } }, '2026-10-04', 1)
    expect(skipped.map(o => o.date)).toEqual(['2026-12-05'])
    const moved = occurrences({ ...EXCO, override: { month: '2026-11', venue: 'Islamic Centre', time: '' } }, '2026-10-04', 2)
    expect(moved.map(o => [o.date, o.venue, o.time])).toEqual([
      ['2026-11-07', 'Islamic Centre', EXCO.time], ['2026-12-05', EXCO.venue, EXCO.time],
    ])
  })
})

describe('dates in the message', () => {
  it('prints the Umm al-Qura Hijri date, moved by the offset', () => {
    expect(hijriDate('2026-10-03')).toBe('22 Rabi\' al-Thani 1448 AH')
    expect(hijriDate('2026-10-03', -1)).toBe('21 Rabi\' al-Thani 1448 AH')
    expect(hijriDate('2026-10-03', 1)).toBe('23 Rabi\' al-Thani 1448 AH')
    expect(hijriDate('2027-02-08')).toBe('1 Ramadan 1448 AH')
  })

  it('prints the English date with its ordinal', () => {
    expect(englishDate('2026-10-03')).toBe('3rd October 2026')
    expect(englishDate('2026-11-01')).toBe('1st November 2026')
    expect([2, 4, 11, 12, 13, 21, 22, 23, 31].map(ordinal)).toEqual(['2nd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '31st'])
  })

  it('names the day from the sending day', () => {
    expect(whenText('2026-10-03', '2026-10-03')).toBe('today')
    expect(whenText('2026-10-02', '2026-10-03')).toBe('tomorrow')
    expect(whenText('2026-10-01', '2026-10-03')).toBe('on Saturday')
  })

  it('fills the placeholders and leaves unknown ones', () => {
    const text = renderTemplate('{label} {when} {nope}', { label: 'Exco', when: 'today', hijriDate: '', date: '', weekday: '', time: '', venue: '' })
    expect(text).toBe('Exco today {nope}')
  })

  it('renders the default message with the Hijri date first', () => {
    const { reminders, at } = setup()
    at('2026-10-01T10:00')
    const preview = reminders.preview('amya-exco')
    expect(preview.status).toBe(200)
    expect(preview.body['text']).toContain('📅 *Date:* Saturday, 22 Rabi\' al-Thani 1448 AH (3rd October 2026)')
    expect(preview.body['text']).toContain('the *AMYA Exco meeting* is on Saturday')
    expect(preview.body['text']).toContain('⏰ *Time:* 8:15 PM (shortly after Isha prayer)')
  })

  it('names what is wrong with a rule', () => {
    expect(ruleProblems(EXCO)).toEqual([])
    expect(ruleProblems({ ...EXCO, override: {} })).toEqual([])
    expect(ruleProblems({ ...EXCO, override: { skip: true } })).toEqual(['override.month must be YYYY-MM'])
    expect(ruleProblems({ ...EXCO, chat: 'Exco', reminders: [{ daysBefore: 1, at: '25:00' }] })).toEqual([
      'chat must be a WhatsApp group JID ending in @g.us', 'reminder time "25:00" is not HH:MM',
    ])
  })
})

describe('sending', () => {
  it('sends a due reminder once to the rule\'s group, and never again', async () => {
    const { reminders, sends, store, at } = setup()
    at('2026-09-30T23:59')
    await reminders.tick()
    expect(sends).toEqual([])

    at('2026-10-01T09:00')
    await reminders.tick()
    await reminders.tick()
    at('2026-10-01T09:30')
    await reminders.tick()
    expect(sends).toHaveLength(1)
    expect(sends[0]!.to).toBe(EXCO.chat)
    expect(sends[0]!.text).toContain('is on Saturday')
    const state = await store.read()
    expect(state.done['amya-exco|2026-10-03|2']?.outcome).toBe('sent')
    expect(state.sent.map(s => s.key)).toEqual(['amya-exco|2026-10-03|2'])

    at('2026-10-03T09:00')
    await reminders.tick()
    expect(sends.map(s => s.text.includes('is today'))).toEqual([false, true])
  })

  it('does not resend after a restart, even when the last run stopped mid-send', async () => {
    const first = setup()
    await first.store.update((s) => { s.done['amya-exco|2026-10-03|2'] = { outcome: 'sending', at: 'x' } })
    first.at('2026-10-01T09:05')
    await first.reminders.tick()
    expect(first.sends).toEqual([])
    const saved = JSON.parse(readFileSync(join(first.dir, 'state.json'), 'utf8')) as { done: Record<string, { outcome: string }> }
    expect(saved.done['amya-exco|2026-10-03|2']?.outcome).toBe('sending')
  })

  it('sends late within six hours of the time and not after', async () => {
    const late = setup()
    late.at('2026-10-01T15:00')
    await late.reminders.tick()
    expect(late.sends).toHaveLength(1)

    const tooLate = setup()
    tooLate.at('2026-10-01T15:01')
    await tooLate.reminders.tick()
    expect(tooLate.sends).toEqual([])
  })

  it('does not send late once the meeting day is over', async () => {
    const { reminders, sends, at } = setup({ rules: [{ ...EXCO, reminders: [{ daysBefore: 0, at: '22:00' }] }] })
    at('2026-10-04T01:00')
    await reminders.tick()
    expect(sends).toEqual([])
  })

  it('plans the next reminders with their states', () => {
    const plan = planReminders(EXCO, { date: '2026-10-02', minutes: 600 }, 1)
    expect(plan.map(p => [p.sendDate, p.sendAt, p.state])).toEqual([['2026-10-01', '09:00', 'missed'], ['2026-10-03', '09:00', 'upcoming']])
  })

  it('retries a failed send on the next tick, then gives up and alerts the owner', async () => {
    const { reminders, sends, alerts, store, at } = setup({ answer: () => ({ result: { error: 'not linked' } }) })
    at('2026-10-01T09:00')
    await reminders.tick()
    at('2026-10-01T09:01')
    await reminders.tick()
    at('2026-10-01T09:02')
    await reminders.tick()
    at('2026-10-01T09:03')
    await reminders.tick()
    expect(sends).toHaveLength(3)
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toContain('AMYA Exco meeting')
    const state = await store.read()
    expect(state.done['amya-exco|2026-10-03|2']?.outcome).toBe('gave-up')
    expect(state.sent.every(s => !s.ok && s.outcome === 'failed: not linked')).toBe(true)
  })

  it('leaves disabled rules and rules with problems alone', async () => {
    const { reminders, sends, at } = setup({ rules: [{ ...EXCO, enabled: false }, { ...EXCO, id: 'b', chat: 'not-a-group' }] })
    at('2026-10-01T09:00')
    await reminders.tick()
    expect(sends).toEqual([])
  })

  it('sends by hand under the next pending reminder\'s key, so the scheduled one does not repeat', async () => {
    const { reminders, sends, at } = setup()
    at('2026-10-01T08:00')
    const manual = await reminders.sendNow({ ruleId: 'amya-exco' })
    expect(manual.status).toBe(200)
    expect(manual.body['key']).toBe('amya-exco|2026-10-03|2')
    at('2026-10-01T09:00')
    await reminders.tick()
    expect(sends).toHaveLength(1)
    expect((await reminders.sendNow({ ruleId: 'amya-exco', daysBefore: 2 })).status).toBe(409)
    expect((await reminders.sendNow({ ruleId: 'amya-exco', daysBefore: 2, force: true })).status).toBe(200)
    expect(sends).toHaveLength(2)
  })

  it('reports each rule\'s next meeting and reminders in the status', async () => {
    const { reminders, at } = setup()
    at('2026-10-02T10:00')
    const status = await reminders.status()
    expect(status['today']).toEqual({ date: '2026-10-02', hijri: '21 Rabi\' al-Thani 1448 AH', english: '2nd October 2026' })
    const [rule] = status['rules'] as { next: { date: string; hijri: string }; reminders: { state: string }[] }[]
    expect(rule!.next.date).toBe('2026-10-03')
    expect(rule!.reminders.map(r => r.state)).toEqual(['missed', 'upcoming'])
  })

  it('reads a top-level route error and an unexpected answer as failures', async () => {
    const fail = (body: unknown) => whatsAppSender({ url: 'u', token: 't' }, () => Promise.resolve(new Response(JSON.stringify(body))))
    expect(await fail({ error: 'bad token' })('x@g.us', 'hi')).toBe('failed: bad token')
    expect(await fail({ result: { queued: true } })('x@g.us', 'hi')).toMatch(/^failed: unexpected answer/u)
    expect(await whatsAppSender({ url: '', token: '' })('x@g.us', 'hi')).toMatch(/^not sent/u)
  })

  it('lists groups by name, and falls back to group ids from recent chats when the tool is missing', async () => {
    const route = { url: 'u', token: 't' }
    const answer = (byTool: Record<string, unknown>) => whatsAppGroups(route, (_url, init) => {
      const { name } = JSON.parse(init?.body as string) as { name: string }
      return Promise.resolve(new Response(JSON.stringify(byTool[name])))
    })
    const named = answer({ whatsapp_groups: { result: { groups: [{ jid: 'b@g.us', name: 'Exco' }, { jid: 'a@g.us', name: 'AMYA General' }] } } })
    expect(await named()).toEqual([{ jid: 'a@g.us', name: 'AMYA General' }, { jid: 'b@g.us', name: 'Exco' }])
    const old = answer({
      whatsapp_groups: { result: { error: 'no such tool: whatsapp_groups' } },
      whatsapp_chats: { result: { messages: [{ chat: 'a@g.us' }, { chat: '234@s.whatsapp.net' }, { chat: 'a@g.us' }] } },
    })
    expect(await old()).toEqual([{ jid: 'a@g.us', name: '' }])
    await expect(answer({ whatsapp_groups: { result: { error: 'not linked; scan the QR first' } } })()).rejects.toThrow('not linked')
  })
})
