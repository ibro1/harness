/** The Error reporting card: the DSN written blind, the status line, and the test button. */

import { describe, expect, it, vi } from 'vitest'
import { stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { ErrorReportingCardController, type ErrorReportingSettings } from '../src/client/error-reporting-card-controller.ts'

/** A Host that answers the status and test routes. */
function host(status: object, test: { status: number; body: object } = { status: 200, body: { eventId: 'e1', sent: true } }) {
  return vi.fn((url: string) => Promise.resolve(url.endsWith('/test')
    ? new Response(JSON.stringify(test.body), { status: test.status })
    : new Response(JSON.stringify(status), { status: 200 })))
}

/** Every path edit the card wrote, in order. */
function ops(form: ReturnType<typeof stubConfigForm<ErrorReportingSettings>>) {
  return form.mutate.mock.calls.flatMap(call => call[0])
}

async function card(status: object, test?: { status: number; body: object }) {
  const form = stubConfigForm<ErrorReportingSettings>()
  const request = host(status, test)
  const controller = new ErrorReportingCardController(form.scope, request)
  const face = controller.inject()
  form.publish({ status: 'ready', writable: true, value: { environment: 'production' }, base: {}, user: {} })
  await vi.waitFor(() => { expect(face.hooks.errorReportingLive.getSnapshot().status).toBeDefined() })
  return { form, face, request, live: () => face.hooks.errorReportingLive.getSnapshot() }
}

describe('the Error reporting card', () => {
  it('shows where reports go without ever holding the key', async () => {
    const { live } = await card({ enabled: true, source: 'settings', host: 'https://bug.linkfa.de', projectId: '3', environment: 'production' })
    expect(live().status).toMatchObject({ enabled: true, host: 'https://bug.linkfa.de', projectId: '3' })
    expect(JSON.stringify(live())).not.toContain('@')
  })

  it('writes the DSN as its own mutation on save, and leaves it alone when blank', async () => {
    const { form, face } = await card({ enabled: false, source: 'none' })
    face.edit('dsn', ' https://abc@bug.linkfa.de/3 ')
    face.save()
    await vi.waitFor(() => { expect(ops(form)).toContainEqual({ op: 'set', path: ['dsn'], value: 'https://abc@bug.linkfa.de/3' }) })

    const blank = await card({ enabled: true, source: 'settings' })
    blank.face.edit('environment', 'staging')
    blank.face.save()
    await vi.waitFor(() => { expect(blank.form.mutate.mock.calls.length).toBeGreaterThan(0) })
    expect(ops(blank.form).some(op => op.path[0] === 'dsn')).toBe(false)
  })

  it('sends a test event and reports the outcome, or why it was not sent', async () => {
    const ok = await card({ enabled: true, source: 'settings' })
    ok.face.sendTest()
    await vi.waitFor(() => { expect(ok.live().test).toEqual({ state: 'sent', eventId: 'e1' }) })

    const off = await card({ enabled: false, source: 'none' }, { status: 409, body: { sent: false, error: 'Error reporting is off: save a DSN first.' } })
    off.face.sendTest()
    await vi.waitFor(() => { expect(off.live().test).toEqual({ state: 'failed', message: 'Error reporting is off: save a DSN first.' }) })
  })

  it('removes a saved DSN', async () => {
    const { form, face } = await card({ enabled: true, source: 'settings' })
    face.removeDsn()
    await vi.waitFor(() => { expect(ops(form)).toContainEqual({ op: 'unset', path: ['dsn'] }) })
  })
})
