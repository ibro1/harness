/** The Klipara Scout card's free-clip hand-off: the secret written blind, and the Host's status. */

import { describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { ScoutCardController, type ScoutSettings } from '../src/client/scout-card-controller.ts'
import type { ScoutModelCatalogState } from '../src/client/scout-model-catalog.ts'

function ops(form: ReturnType<typeof stubConfigForm<ScoutSettings>>) {
  return form.mutate.mock.calls.flatMap(call => call[0])
}

async function card(status: object) {
  const form = stubConfigForm<ScoutSettings>()
  const request = vi.fn(() => Promise.resolve(new Response(JSON.stringify(status), { status: 200 })))
  const controller = new ScoutCardController(form.scope, request)
  const face = controller.inject(() => {}, createSnapshotStore({} as ScoutModelCatalogState), () => {})
  form.publish({ status: 'ready', writable: true, value: { shiftTime: '09:00' }, base: {}, user: {} })
  await vi.waitFor(() => { expect(face.hooks.scoutHandOff.getSnapshot().status).toBeDefined() })
  return { form, face, request, handOff: () => face.hooks.scoutHandOff.getSnapshot() }
}

describe('the free-clip hand-off on the Klipara Scout card', () => {
  it('shows whether a secret is in force and where Klipara posts, from the Host\'s status route', async () => {
    const { handOff, request } = await card({ source: 'settings', path: '/scout/inbound/free-clip', url: 'https://harness.linkfa.de/scout/inbound/free-clip' })
    expect(request).toHaveBeenCalledWith('/scout/inbound/status', expect.anything())
    expect(handOff().status).toEqual({ source: 'settings', path: '/scout/inbound/free-clip', url: 'https://harness.linkfa.de/scout/inbound/free-clip' })
  })

  it('writes the secret as its own mutation on save, and leaves it alone when blank', async () => {
    const { form, face } = await card({ source: 'none', path: '/scout/inbound/free-clip', url: null })
    face.edit('freeClipSecret', ' abc123 ')
    face.save()
    await vi.waitFor(() => { expect(ops(form)).toContainEqual({ op: 'set', path: ['freeClipSecret'], value: 'abc123' }) })

    const blank = await card({ source: 'settings', path: '/scout/inbound/free-clip', url: null })
    blank.face.edit('shiftTime', '10:00')
    blank.face.save()
    await vi.waitFor(() => { expect(blank.form.mutate.mock.calls.length).toBeGreaterThan(0) })
    expect(ops(blank.form).some(op => op.path[0] === 'freeClipSecret')).toBe(false)
  })

  it('removes a saved secret', async () => {
    const { form, face } = await card({ source: 'settings', path: '/scout/inbound/free-clip', url: null })
    face.removeFreeClipSecret()
    await vi.waitFor(() => { expect(ops(form)).toContainEqual({ op: 'unset', path: ['freeClipSecret'] }) })
  })
})
