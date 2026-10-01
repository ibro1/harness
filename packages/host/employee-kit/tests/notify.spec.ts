import { describe, expect, it } from 'vitest'
import { whatsAppNotifier } from '../src/notify.ts'

describe('owner alerts over WhatsApp', () => {
  it('sends through the command route with the recipient read at send time', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    let to = 'Owner'
    const notify = whatsAppNotifier({ url: 'http://wa.test/command', token: 't0k', to: () => to }, (url, init) => {
      calls.push({ url: url instanceof Request ? url.url : url.toString(), init: init ?? {} })
      return Promise.resolve(Response.json({ ok: true }))
    })
    expect(await notify('hello')).toBe('sent to Owner')
    to = 'Other'
    expect(await notify('again')).toBe('sent to Other')
    expect(calls[0]!.init.headers).toMatchObject({ Authorization: 'Bearer t0k' })
    expect(JSON.parse(typeof calls[1]!.init.body === 'string' ? calls[1]!.init.body : '')).toEqual({ name: 'whatsapp_send', args: { to: 'Other', text: 'again', send_now: true } })
  })

  it('reports rather than throws when it cannot send', async () => {
    expect(await whatsAppNotifier({ url: '', token: 't', to: () => 'Owner' })('x')).toBe('not sent (no WhatsApp recipient or route configured)')
    const refused = whatsAppNotifier({ url: 'http://wa.test', token: 't', to: () => 'Owner' }, () => Promise.resolve(Response.json({ error: 'not paired' })))
    expect(await refused('x')).toBe('failed: not paired')
    const down = whatsAppNotifier({ url: 'http://wa.test', token: 't', to: () => 'Owner' }, () => Promise.reject(new Error('ECONNREFUSED')))
    expect(await down('x')).toBe('failed: ECONNREFUSED')
  })
})
