/** The SEO employee card: both credentials written blind, and the Google status read from the Host. */

import { describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { SeoCardController, type SeoSettings } from '../src/client/seo-card-controller.ts'
import type { ScoutModelCatalogState } from '../src/client/scout-model-catalog.ts'

/** The `/seo/status` answer, Google part only. */
function status(google: object) {
  return { redirectUri: 'https://harness.example.com/seo/oauth/callback', google, paused: null, lastShiftDate: null, sites: [], questions: [], topics: [], drafts: [], articles: [] }
}

/** Every path edit the card wrote, in order. */
function ops(form: ReturnType<typeof stubConfigForm<SeoSettings>>) {
  return form.mutate.mock.calls.flatMap(call => call[0])
}

async function card(google: object, action: object = { ok: true }) {
  const form = stubConfigForm<SeoSettings>()
  const request = vi.fn((url: string, _init?: RequestInit) => Promise.resolve(new Response(JSON.stringify(url === '/seo/action' ? action : status(google)), { status: 200 })))
  const opened: string[] = []
  const controller = new SeoCardController(form.scope, request, (url) => { opened.push(url) })
  const face = controller.inject(() => {}, createSnapshotStore({} as ScoutModelCatalogState), () => {})
  form.publish({ status: 'ready', writable: true, value: { shiftTime: '10:00', googleClientId: 'abc.apps.googleusercontent.com' }, base: {}, user: {} })
  await vi.waitFor(() => { expect(face.hooks.seoGoogle.getSnapshot().status).toBeDefined() })
  return { form, face, request, opened, google: () => face.hooks.seoGoogle.getSnapshot() }
}

describe('the SEO employee card', () => {
  it('reads the Google connection and the redirect address from /seo/status', async () => {
    const { google, request } = await card({
      clientSet: true, adsSet: false, clientSecretSet: true, developerTokenSet: false, connected: true, connectedAt: '2026-09-30T08:00:00.000Z',
    })
    expect(request).toHaveBeenCalledWith('/seo/status', expect.objectContaining({ credentials: 'same-origin' }))
    expect(google().status).toEqual({
      serviceAccount: null, clientSet: true, adsSet: false, clientSecretSet: true, developerTokenSet: false, connected: true, connectedAt: '2026-09-30T08:00:00.000Z',
      redirectUri: 'https://harness.example.com/seo/oauth/callback',
    })
  })

  it('writes each secret as its own mutation on save and never holds it in the snapshot', async () => {
    const { form, face } = await card({ clientSet: false, adsSet: false, connected: false, connectedAt: null })
    expect(face.hooks.seoCard.getSnapshot().secrets.googleClientSecret.text).toBe('')
    face.edit('googleClientSecret', ' GOCSPX-secret ')
    face.edit('adsDeveloperToken', 'dev-token')
    face.save()
    await vi.waitFor(() => {
      expect(ops(form)).toContainEqual({ op: 'set', path: ['googleClientSecret'], value: 'GOCSPX-secret' })
      expect(ops(form)).toContainEqual({ op: 'set', path: ['adsDeveloperToken'], value: 'dev-token' })
    })
    await vi.waitFor(() => { expect(face.hooks.seoCard.getSnapshot().saving).toBe(false) })
    expect(JSON.stringify(face.hooks.seoCard.getSnapshot())).not.toContain('GOCSPX-secret')
    expect(JSON.stringify(face.hooks.seoCard.getSnapshot())).not.toContain('dev-token')
  })

  it('leaves the secrets alone when their fields are blank', async () => {
    const { form, face } = await card({ clientSet: true, adsSet: true, connected: false, connectedAt: null })
    face.edit('shiftTime', '11:00')
    face.save()
    await vi.waitFor(() => { expect(form.mutate.mock.calls.length).toBeGreaterThan(0) })
    expect(ops(form).some(op => op.path[0] === 'googleClientSecret' || op.path[0] === 'adsDeveloperToken')).toBe(false)
  })

  it('opens Google\'s consent route in a new window and posts the disconnect', async () => {
    const { face, opened, request } = await card({ clientSet: true, adsSet: false, connected: true, connectedAt: '2026-09-30T08:00:00.000Z' })
    face.connectGoogle()
    expect(opened).toEqual(['/seo/oauth/start'])
    face.disconnectGoogle()
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith('/seo/action', expect.objectContaining({ method: 'POST', body: JSON.stringify({ action: 'disconnect-google' }) }))
    })
  })
})

describe('removing the service account key', () => {
  it('unsets the key so the employee falls back to the owner\'s Google sign-in', async () => {
    const { form, face } = await card({ clientSet: true, adsSet: false, connected: true, connectedAt: '2026-10-01T08:00:00.000Z' })
    face.removeServiceAccount()
    await vi.waitFor(() => { expect(form.mutate.mock.calls.flatMap(call => call[0])).toContainEqual({ op: 'unset', path: ['googleServiceAccountKey'] }) })
  })
})
