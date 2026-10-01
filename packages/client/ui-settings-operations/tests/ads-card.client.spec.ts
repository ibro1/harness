/** The ads employee card: it writes only the ads fields of seo-employee, and reads the Ads account from the Host. */

import { describe, expect, it, vi } from 'vitest'
import { stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { AdsCardController, type AdsSettings } from '../src/client/ads-card-controller.ts'

/** Every path edit the card wrote, in order. */
function ops(form: ReturnType<typeof stubConfigForm<AdsSettings>>) {
  return form.mutate.mock.calls.flatMap(call => call[0])
}

async function card(value: AdsSettings = {}) {
  const form = stubConfigForm<AdsSettings>()
  const request = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(new Response(JSON.stringify({
    google: { adsAccount: { source: 'configured', id: '1234567890', name: '', error: null, seen: '' } },
  }), { status: 200 })))
  const opened: string[] = []
  const controller = new AdsCardController(form.scope, request)
  const face = controller.inject(() => { opened.push('proposals') })
  form.publish({ status: 'ready', writable: true, value: { shiftTime: '10:00', ...value } as AdsSettings, base: {}, user: {} })
  await vi.waitFor(() => { expect(face.hooks.adsAccount.getSnapshot().account).toBeDefined() })
  return { form, face, request, opened, state: () => face.hooks.adsCard.getSnapshot() }
}

describe('the ads employee card', () => {
  it('reads the Ads account the SEO employee settings chose from /seo/status', async () => {
    const { face, request } = await card()
    expect(request).toHaveBeenCalledWith('/seo/status', expect.objectContaining({ credentials: 'same-origin' }))
    expect(face.hooks.adsAccount.getSnapshot()).toEqual({ account: { source: 'configured', id: '1234567890', name: '', error: null, seen: '' }, failed: false })
  })

  it('shows the Host defaults: off, conversion tracking required', async () => {
    const { state } = await card({ adsEnabled: false, adsRequireConversionTracking: true, adsMonthlyCeiling: 0 })
    expect(state().switches.adsEnabled.text).toBe('false')
    expect(state().switches.adsRequireConversionTracking.text).toBe('true')
    expect(state().numbers.adsMonthlyCeiling.text).toBe('0')
  })

  it('writes the switch, the shift time and the limits as typed, and nothing of the SEO fields', async () => {
    const { form, face } = await card()
    face.edit('adsEnabled', 'true')
    face.edit('adsShiftTime', '09:30')
    face.edit('adsMonthlyCeiling', '150000')
    face.edit('adsMaxDailyBudget', '5000')
    face.edit('adsMaxCpc', '200')
    face.edit('adsMaxCostPerConversion', '3000')
    face.edit('adsRequireConversionTracking', 'false')
    face.save()
    await vi.waitFor(() => { expect(form.mutate.mock.calls.length).toBeGreaterThan(0) })
    expect(ops(form)).toEqual(expect.arrayContaining([
      { op: 'set', path: ['adsEnabled'], value: true },
      { op: 'set', path: ['adsShiftTime'], value: '09:30' },
      { op: 'set', path: ['adsMonthlyCeiling'], value: 150000 },
      { op: 'set', path: ['adsMaxDailyBudget'], value: 5000 },
      { op: 'set', path: ['adsMaxCpc'], value: 200 },
      { op: 'set', path: ['adsMaxCostPerConversion'], value: 3000 },
      { op: 'set', path: ['adsRequireConversionTracking'], value: false },
    ]))
    expect(ops(form).every(op => String(op.path[0]).startsWith('ads'))).toBe(true)
  })

  it('refuses a limit that is not a whole number, which blocks the save', async () => {
    const { face, state } = await card()
    face.edit('adsMaxCpc', '2.5')
    expect(state().numbers.adsMaxCpc.invalid).toBe(true)
    expect(state().invalid).toBe(true)
    face.edit('adsMaxCpc', '-1')
    expect(state().numbers.adsMaxCpc.invalid).toBe(true)
  })

  it('opens the proposals page', async () => {
    const { face, opened } = await card()
    face.openProposals()
    expect(opened).toEqual(['proposals'])
  })
})
