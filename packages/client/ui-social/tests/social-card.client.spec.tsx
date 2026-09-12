// @vitest-environment jsdom

/**
 * The social card against a stubbed host: the four states it can be in, that a
 * credential which still works but lapses shortly reads as a warning rather
 * than as fine, that a provider's sentence reaches the reader verbatim, that
 * the exempt target ids are called out, and that Disconnect posts only after
 * the confirmation step.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SocialCard } from '../src/client/SocialCard.tsx'
import type { SocialCardProps } from '../src/client/SocialCard.tsx'
import { en } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** The shipped English copy, with the same `{name}` substitution the runtime does. */
function t(key: keyof typeof en, params?: Record<string, string>): string {
  const text = en[key]
  return params === undefined
    ? text
    : text.replace(/\{(\w+)\}/g, (whole, name: string) => params[name] ?? whole)
}

/** The reason a person must read unchanged; it tells them what to do. */
const LAPSING = 'The LinkedIn token expires on 2026-09-16, in 4 days. It still works today, but there is no refresh token: authorize "social-linkedin/member" again before it lapses.'

const STATUS = {
  targets: [
    {
      id: 'linkedin:member',
      provider: 'linkedin',
      label: 'Ada Obi (personal)',
      accepts: { text: true, image: true, video: true },
      ready: true,
      state: 'warning',
      reason: LAPSING,
    },
    {
      id: 'facebook:page:9',
      provider: 'facebook',
      label: 'Dormant (Page)',
      accepts: { text: true, image: true, video: false },
      ready: false,
      state: 'blocked',
      reason: 'The Page token expired; reconnect it.',
    },
    {
      id: 'youtube:channel:UC123',
      provider: 'youtube',
      label: 'Ada Obi (channel)',
      accepts: { text: false, image: false, video: true },
      ready: true,
      state: 'ready',
    },
  ],
  providers: [
    { name: 'facebook', targets: 1, disconnectable: false, sharedWith: [] },
    {
      name: 'linkedin',
      targets: 1,
      disconnectable: true,
      credentialKey: 'social-linkedin/member',
      sharedWith: [],
    },
    {
      name: 'youtube',
      targets: 1,
      disconnectable: true,
      credentialKey: 'social-youtube/oauth',
      sharedWith: [],
    },
  ],
  postWithoutApproval: ['youtube:channel:UC123'],
}

/** One recorded request. */
interface Sent {
  path: string
  init?: RequestInit
}

/** Stub `fetch` with one status body and one disconnect answer. */
function stubHost(options: {
  status?: unknown
  statusFails?: boolean
  disconnect?: { ok: boolean; body: unknown }
} = {}): Sent[] {
  const sent: Sent[] = []
  vi.stubGlobal('fetch', (path: string, init?: RequestInit) => {
    // `exactOptionalPropertyTypes`: an absent init is an absent key, not
    // a key holding undefined.
    sent.push(init === undefined ? { path } : { path, init })
    if (path === '/social/status') {
      return options.statusFails === true
        ? Promise.reject(new Error('offline'))
        : Promise.resolve({ ok: true, json: () => Promise.resolve(options.status ?? STATUS) })
    }
    const answer = options.disconnect ?? { ok: true, body: { provider: 'linkedin', credentialKey: 'social-linkedin/member', removed: true, alsoDisconnected: [] } }
    return Promise.resolve({ ok: answer.ok, status: answer.ok ? 200 : 409, json: () => Promise.resolve(answer.body) })
  })
  return sent
}

/** Render the card and expand it, letting the first status read settle. */
async function open(): Promise<void> {
  render(<SocialCard {...({ t } as unknown as SocialCardProps)} />)
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: `${en.expand}: ${en.title}` }))
  })
}

/**
 * Index where the test's own setup guarantees the element.
 *
 * `noUncheckedIndexedAccess` is on, and a bare `at(sent, 0)` is `T | undefined`
 * everywhere. Throwing names the missing element instead of failing later on a
 * property of undefined.
 * @param items - the array to read. @param index - the position expected to exist.
 * @returns the element. @throws when the array is shorter than the index.
 */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index]
  if (item === undefined) throw new Error(`expected an element at index ${String(index)}`)
  return item
}

describe('SocialCard', () => {
  it('shows only the header until it is expanded', () => {
    stubHost()
    render(<SocialCard {...({ t } as unknown as SocialCardProps)} />)
    expect(screen.getByText(en.title)).toBeDefined()
    expect(screen.queryByText(en.targetsHeading)).toBeNull()
  })

  it('reads the status when opened and lists every target', async () => {
    const sent = stubHost()
    await open()
    expect(at(sent, 0).path).toBe('/social/status')
    expect(screen.getByText(en.targetsHeading)).toBeDefined()
    expect(screen.getByText('Ada Obi (personal)')).toBeDefined()
    expect(screen.getByText('linkedin:member')).toBeDefined()
    expect(screen.getByText('Dormant (Page)')).toBeDefined()
    // Twice, and correctly so: once as the target's own row, once in the
    // exempt callout naming the targets that post without asking. The fixture
    // exempts this id, and a reader needs to see it in both places.
    expect(screen.getAllByText('youtube:channel:UC123')).toHaveLength(2)
  })

  it('reads a credential that lapses shortly as a warning, not as fine', async () => {
    stubHost()
    await open()
    expect(screen.getByText(en.stateWarning)).toBeDefined()
    expect(screen.getByText(en.stateReady)).toBeDefined()
    expect(screen.getByText(en.stateBlocked)).toBeDefined()
  })

  it("shows a provider's reason verbatim", async () => {
    stubHost()
    await open()
    expect(screen.getByText(LAPSING)).toBeDefined()
    expect(screen.getByText('The Page token expired; reconnect it.')).toBeDefined()
  })

  it('says what each target accepts', async () => {
    stubHost()
    await open()
    expect(screen.getByText(`${en.acceptsLabel} ${en.acceptsText}, ${en.acceptsImage}, ${en.acceptsVideo}`)).toBeDefined()
    expect(screen.getByText(`${en.acceptsLabel} ${en.acceptsVideo}`)).toBeDefined()
  })

  it('calls out the targets that publish without asking', async () => {
    stubHost()
    await open()
    expect(screen.getByText(en.exemptHeading)).toBeDefined()
    expect(screen.getByText(en.exemptHint)).toBeDefined()
  })

  it('hides the exempt callout when nothing is exempt', async () => {
    stubHost({ status: { ...STATUS, postWithoutApproval: [] } })
    await open()
    expect(screen.queryByText(en.exemptHeading)).toBeNull()
  })

  it('says how to connect when nothing is connected', async () => {
    stubHost({ status: { targets: [], providers: [], postWithoutApproval: [] } })
    await open()
    expect(screen.getByText(en.emptyTitle)).toBeDefined()
    expect(screen.getByText(en.emptyHow)).toBeDefined()
  })

  it('offers a retry when the status cannot be read', async () => {
    stubHost({ statusFails: true })
    await open()
    expect(screen.getByText(en.statusError)).toBeDefined()
    expect(screen.getByRole('button', { name: en.retry })).toBeDefined()
  })

  it('explains why a provider cannot be disconnected from here', async () => {
    stubHost()
    await open()
    expect(screen.getByText(en.disconnectUnavailable)).toBeDefined()
    // Two providers are disconnectable; facebook is not, so it gets no button.
    expect(screen.getAllByRole('button', { name: en.disconnect })).toHaveLength(2)
  })

  it('asks for confirmation before disconnecting, and posts nothing until it is given', async () => {
    const sent = stubHost()
    await open()
    fireEvent.click(at(screen.getAllByRole('button', { name: en.disconnect }), 0))
    expect(screen.getByText(t('disconnectAsk', { provider: 'linkedin' }))).toBeDefined()
    expect(sent.filter(one => one.path === '/social/disconnect')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
    expect(screen.queryByText(t('disconnectAsk', { provider: 'linkedin' }))).toBeNull()
    expect(sent.filter(one => one.path === '/social/disconnect')).toHaveLength(0)
  })

  it('posts the provider name once the disconnect is confirmed, and reports what went', async () => {
    const sent = stubHost()
    await open()
    fireEvent.click(at(screen.getAllByRole('button', { name: en.disconnect }), 0))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: en.confirm }))
    })
    const posted = sent.filter(one => one.path === '/social/disconnect')
    expect(posted).toHaveLength(1)
    expect(at(posted, 0).init?.method).toBe('POST')
    expect(at(posted, 0).init?.body).toBe(JSON.stringify({ provider: 'linkedin' }))
    expect(screen.getByText(t('disconnectDone', {
      provider: 'linkedin',
      key: 'social-linkedin/member',
    }))).toBeDefined()
  })

  it("surfaces the host's refusal when a disconnect fails", async () => {
    stubHost({ disconnect: { ok: false, body: { error: 'no stored credential record is addressed to it' } } })
    await open()
    fireEvent.click(at(screen.getAllByRole('button', { name: en.disconnect }), 0))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: en.confirm }))
    })
    expect(screen.getByText(t('disconnectFailed', {
      reason: 'no stored credential record is addressed to it',
    }))).toBeDefined()
  })

  it('reports a provider that had nothing stored as a no-op', async () => {
    stubHost({
      disconnect: {
        ok: true,
        body: { provider: 'linkedin', credentialKey: 'social-linkedin/member', removed: false, alsoDisconnected: [] },
      },
    })
    await open()
    fireEvent.click(at(screen.getAllByRole('button', { name: en.disconnect }), 0))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: en.confirm }))
    })
    expect(screen.getByText(t('disconnectNothing', { provider: 'linkedin' }))).toBeDefined()
  })

  it('warns that a shared credential disconnects the other providers too', async () => {
    stubHost({
      status: {
        ...STATUS,
        providers: [
          {
            name: 'facebook',
            targets: 1,
            disconnectable: true,
            credentialKey: 'social-meta/default',
            sharedWith: ['instagram'],
          },
        ],
      },
    })
    await open()
    fireEvent.click(screen.getByRole('button', { name: en.disconnect }))
    expect(screen.getByText(t('disconnectShared', { providers: 'instagram' }))).toBeDefined()
  })
})
