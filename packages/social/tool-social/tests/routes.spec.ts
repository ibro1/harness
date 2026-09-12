/**
 * The two human-facing routes driven against a stub seam, a stub credential
 * service, and stub HTTP messages: the status body's exact fields, that no
 * secret and no credential read can reach it, the approval exemptions it
 * surfaces, the disconnect that removes a record, every refusal that leaves
 * storage untouched, and that both routes mount authenticated.
 *
 * The `social`, `webServer`, `credentials`, and `settings` services are stubs,
 * because this package owns the routes and what they expose, not the registry,
 * the web server, or the credential store.
 */

import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRecordEntry } from '@deepseek-ai/dsh-credentials'
import type { SocialTarget } from '@deepseek-ai/dsh-social'
import { apply, type Config } from '../src/index.ts'
import { DISCONNECT_PATH, STATUS_PATH } from '../src/routes.ts'
import type { SocialDisconnectBody, SocialErrorBody, SocialStatusBody } from '../src/routes.ts'

/** A route as the stub web server recorded it. */
interface RecordedRoute {
  kind: string
  path: string
  authenticate?: boolean
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

/** The token no response may ever carry, stored where a careless read would find it. */
const SECRET = 'ya29.super-secret-access-token'

function target(id: string, provider: string, label: string, overrides: Partial<SocialTarget> = {}): SocialTarget {
  return {
    id,
    provider,
    label,
    accepts: { text: true, image: true, video: true },
    ready: true,
    ...overrides,
  }
}

/** The reason a person must read verbatim; it tells them what to do. */
const LAPSING = 'The LinkedIn token expires on 2026-09-16, in 4 days. It still works today, but there is no refresh token: authorize "social-linkedin/member" again before it lapses.'

const TARGETS: SocialTarget[] = [
  target('facebook:page:1234', 'facebook', 'FrontStaff (Page)'),
  target('instagram:17841400000000000', 'instagram', 'FrontStaff (Instagram @frontstaff)', {
    accepts: { text: true, image: true, video: true },
  }),
  target('linkedin:member', 'linkedin', 'Ada Obi (personal)', { ready: false, reason: LAPSING }),
  target('youtube:channel:UC123', 'youtube', 'Ada Obi (channel)', {
    accepts: { text: false, image: false, video: true },
    reason: 'Uploads land private until Google verifies the project.',
  }),
]

/** Records the credential seam holds; the grant payload carries {@link SECRET}. */
const STORED: CredentialRecordEntry[] = [
  { key: 'social-linkedin/member', kind: 'grant' },
  { key: 'social-meta/default', kind: 'grant' },
  { key: 'social-youtube/oauth', kind: 'grant' },
] as CredentialRecordEntry[]

interface MountOptions {
  /** What `ctx.social.targets()` answers; defaults to {@link TARGETS}. */
  targets?: SocialTarget[]
  /** What the credential seam holds; defaults to {@link STORED}. */
  stored?: CredentialRecordEntry[]
  /** Omit the credential service entirely. */
  withoutCredentials?: boolean
  /** Plugin config. */
  config?: Config
}

/** What a mounted plugin exposes to a test. */
interface Mounted {
  routes: Map<string, RecordedRoute>
  namespaces: string[]
  deleted: string[]
  described: string[]
  reads: string[]
}

/** Mount the plugin against stub services and capture what it registered. */
function mount(options: MountOptions = {}): Mounted {
  const routes = new Map<string, RecordedRoute>()
  const namespaces: string[] = []
  const deleted: string[] = []
  const described: string[] = []
  const reads: string[] = []
  const stored = options.stored ?? STORED
  const credentials = options.withoutCredentials === true ? undefined : {
    listRecords: () => Promise.resolve(stored),
    describeRecord: (key: string) => {
      described.push(key)
      return Promise.resolve({
        configured: stored.some(entry => entry.key === key),
        kind: 'grant' as const,
        writable: true,
      })
    },
    deleteRecord: (key: string) => {
      deleted.push(key)
      return Promise.resolve()
    },
    // Present so a test can prove the routes never reach the value half.
    readRecord: (key: string) => {
      reads.push(key)
      return Promise.resolve({ kind: 'grant' as const, payload: { accessToken: SECRET } })
    },
    resolve: (ref: string) => {
      reads.push(ref)
      return Promise.resolve({ value: SECRET, source: 'file' })
    },
  }
  const ctx = {
    effect(fn: () => unknown) { return fn() },
    get(service: string) {
      if (service === 'credentials') return credentials
      if (service === 'settings') {
        return { register(ns: string) { namespaces.push(ns); return { get: () => ({}) } } }
      }
      return undefined
    },
    tools: { register() { return () => {} } },
    webServer: {
      register(route: RecordedRoute) {
        routes.set(route.path, route)
        return () => {}
      },
    },
    social: {
      targets: () => Promise.resolve(options.targets ?? TARGETS),
      post: () => Promise.resolve({ id: 'urn:post:1' }),
    },
  }
  apply(ctx as unknown as Context, options.config ?? {})
  return { routes, namespaces, deleted, described, reads }
}

/** The captured response of one request. */
interface Answer {
  status: number
  headers: Record<string, string>
  text: string
}

/** Drive one recorded route with a stub request, and capture what it wrote. */
async function call(
  mounted: Mounted,
  path: string,
  method: string,
  body?: unknown,
): Promise<Answer> {
  const route = mounted.routes.get(path)
  if (route === undefined) throw new Error(`no route registered at ${path}`)
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]) as unknown as IncomingMessage
  Object.defineProperty(req, 'method', { value: method })
  const answer: Answer = { status: 0, headers: {}, text: '' }
  const res = {
    writeHead(status: number, headers: Record<string, string>) {
      answer.status = status
      answer.headers = headers
      return this
    },
    end(text = '') { answer.text = text },
  }
  await route.handler(req, res as unknown as ServerResponse)
  return answer
}

/** Drive the status route and parse its body. */
async function status(mounted: Mounted): Promise<{ answer: Answer; body: SocialStatusBody }> {
  const answer = await call(mounted, STATUS_PATH, 'GET')
  return { answer, body: JSON.parse(answer.text) as SocialStatusBody }
}

describe('social routes', () => {
  it('mounts both routes as exact paths with authentication left on', () => {
    const { routes } = mount()
    expect([...routes.keys()].sort()).toEqual(['/social/disconnect', '/social/status'])
    for (const route of routes.values()) {
      expect(route.kind).toBe('exact')
      // Unset means the web server's default, which gates the route behind the
      // deployment password. An explicit false would publish it anonymously.
      expect(route.authenticate).toBeUndefined()
    }
  })

  it('serves the social settings namespace so the card is listed', () => {
    expect(mount().namespaces).toEqual(['social'])
  })

  it('reports every target with its id, provider, label, accepts and readiness', async () => {
    const { answer, body } = await status(mount())
    expect(answer.status).toBe(200)
    expect(answer.headers['content-type']).toBe('application/json; charset=utf-8')
    expect(body.targets.map(row => row.id)).toEqual([
      'facebook:page:1234',
      'instagram:17841400000000000',
      'linkedin:member',
      'youtube:channel:UC123',
    ])
    expect(body.targets[0]).toEqual({
      id: 'facebook:page:1234',
      provider: 'facebook',
      label: 'FrontStaff (Page)',
      accepts: { text: true, image: true, video: true },
      ready: true,
      state: 'ready',
    })
    expect(body.targets[3]?.accepts).toEqual({ text: false, image: false, video: true })
  })

  it('carries an unready reason verbatim, and calls a ready-with-reason target a warning', async () => {
    const { body } = await status(mount())
    const linkedin = body.targets.find(row => row.id === 'linkedin:member')
    expect(linkedin?.ready).toBe(false)
    expect(linkedin?.state).toBe('blocked')
    // Verbatim: the sentence tells a person what to do, so nothing paraphrases
    // or truncates it.
    expect(linkedin?.reason).toBe(LAPSING)
    const youtube = body.targets.find(row => row.id === 'youtube:channel:UC123')
    expect(youtube?.ready).toBe(true)
    expect(youtube?.state).toBe('warning')
    expect(youtube?.reason).toBe('Uploads land private until Google verifies the project.')
  })

  it('omits a reason a provider did not give', async () => {
    const { body } = await status(mount())
    expect(Object.keys(body.targets[0] ?? {})).not.toContain('reason')
  })

  it('never carries a token and never reads the value half of the credential seam', async () => {
    const mounted = mount()
    const { answer } = await status(mounted)
    expect(answer.text).not.toContain(SECRET)
    expect(answer.text).not.toContain(SECRET.slice(0, 8))
    expect(answer.text).not.toContain('accessToken')
    // Not even a masked value: the routes call the enumeration and presence
    // halves only, so there is nothing to mask.
    expect(mounted.reads).toEqual([])
  })

  it('surfaces the target ids exempted from the approval prompt', async () => {
    const { body } = await status(mount({
      config: { postWithoutApproval: ['youtube:channel:UC123', 'facebook:page:1234'] },
    }))
    expect(body.postWithoutApproval).toEqual(['facebook:page:1234', 'youtube:channel:UC123'])
  })

  it('reports no exemptions by default', async () => {
    const { body } = await status(mount())
    expect(body.postWithoutApproval).toEqual([])
  })

  it('reports one provider entry per provider, with its target count', async () => {
    const { body } = await status(mount())
    expect(body.providers.map(row => row.name)).toEqual(['facebook', 'instagram', 'linkedin', 'youtube'])
    expect(body.providers.map(row => row.targets)).toEqual([1, 1, 1, 1])
  })

  it('marks a provider disconnectable only when a stored record addresses it', async () => {
    const { body } = await status(mount())
    const byName = new Map(body.providers.map(row => [row.name, row]))
    expect(byName.get('linkedin')).toEqual({
      name: 'linkedin',
      targets: 1,
      disconnectable: true,
      credentialKey: 'social-linkedin/member',
      sharedWith: [],
    })
    // social-meta's one record backs both providers, and neither name derives
    // its scope, so the card must not offer a button that would refuse.
    expect(byName.get('facebook')?.disconnectable).toBe(false)
    expect(byName.get('instagram')?.disconnectable).toBe(false)
  })

  it('names the other providers a declared shared record also disconnects', async () => {
    const { body } = await status(mount({
      config: { credentialKeys: { facebook: 'social-meta/default', instagram: 'social-meta/default' } },
    }))
    const byName = new Map(body.providers.map(row => [row.name, row]))
    expect(byName.get('facebook')?.sharedWith).toEqual(['instagram'])
    expect(byName.get('instagram')?.sharedWith).toEqual(['facebook'])
  })

  it('reports nothing connected as empty lists', async () => {
    const { body } = await status(mount({ targets: [], stored: [] }))
    expect(body).toEqual({ targets: [], providers: [], postWithoutApproval: [] })
  })

  it('disconnects a provider by removing its stored record', async () => {
    const mounted = mount()
    const answer = await call(mounted, DISCONNECT_PATH, 'POST', { provider: 'linkedin' })
    expect(answer.status).toBe(200)
    expect(JSON.parse(answer.text) as SocialDisconnectBody).toEqual({
      provider: 'linkedin',
      credentialKey: 'social-linkedin/member',
      removed: true,
      alsoDisconnected: [],
    })
    expect(mounted.deleted).toEqual(['social-linkedin/member'])
  })

  it('removes the declared record and reports the providers it also disconnects', async () => {
    const mounted = mount({
      config: { credentialKeys: { facebook: 'social-meta/default', instagram: 'social-meta/default' } },
    })
    const answer = await call(mounted, DISCONNECT_PATH, 'POST', { provider: 'instagram' })
    expect(JSON.parse(answer.text) as SocialDisconnectBody).toEqual({
      provider: 'instagram',
      credentialKey: 'social-meta/default',
      removed: true,
      alsoDisconnected: ['facebook'],
    })
    expect(mounted.deleted).toEqual(['social-meta/default'])
  })

  it('reports a declared record that is not stored as removed: false without deleting', async () => {
    const mounted = mount({
      stored: [],
      config: { credentialKeys: { youtube: 'social-youtube/oauth' } },
    })
    const answer = await call(mounted, DISCONNECT_PATH, 'POST', { provider: 'youtube' })
    expect(answer.status).toBe(200)
    expect(JSON.parse(answer.text) as SocialDisconnectBody).toEqual({
      provider: 'youtube',
      credentialKey: 'social-youtube/oauth',
      removed: false,
      alsoDisconnected: [],
    })
    expect(mounted.deleted).toEqual([])
  })

  it('refuses an unknown provider by listing the registered ones', async () => {
    const mounted = mount()
    const answer = await call(mounted, DISCONNECT_PATH, 'POST', { provider: 'mastodon' })
    const body = JSON.parse(answer.text) as SocialErrorBody
    expect(answer.status).toBe(400)
    expect(body.error).toContain('"mastodon"')
    expect(body.error).toContain('facebook, instagram, linkedin, youtube')
    expect(body.providers).toEqual(['facebook', 'instagram', 'linkedin', 'youtube'])
    expect(mounted.deleted).toEqual([])
  })

  it('refuses an unknown provider when no provider is registered at all', async () => {
    const mounted = mount({ targets: [] })
    const answer = await call(mounted, DISCONNECT_PATH, 'POST', { provider: 'linkedin' })
    expect(answer.status).toBe(400)
    expect((JSON.parse(answer.text) as SocialErrorBody).error).toContain('no social provider is registered')
    expect(mounted.deleted).toEqual([])
  })

  it('refuses a provider whose record cannot be addressed, listing what is stored', async () => {
    const mounted = mount()
    const answer = await call(mounted, DISCONNECT_PATH, 'POST', { provider: 'facebook' })
    const body = JSON.parse(answer.text) as SocialErrorBody
    expect(answer.status).toBe(409)
    expect(body.error).toContain('credentialKeys')
    expect(body.storedRecords).toEqual(['social-linkedin/member', 'social-meta/default', 'social-youtube/oauth'])
    expect(mounted.deleted).toEqual([])
  })

  it('refuses rather than guessing when two stored records could be the provider', async () => {
    const mounted = mount({
      stored: [
        { key: 'linkedin/one', kind: 'grant' },
        { key: 'social-linkedin/member', kind: 'grant' },
      ] as CredentialRecordEntry[],
    })
    const answer = await call(mounted, DISCONNECT_PATH, 'POST', { provider: 'linkedin' })
    expect(answer.status).toBe(409)
    expect((JSON.parse(answer.text) as SocialErrorBody).error).toContain('linkedin/one, social-linkedin/member')
    expect(mounted.deleted).toEqual([])
  })

  it('refuses a body with no provider name', async () => {
    const mounted = mount()
    for (const body of [undefined, {}, { provider: '' }, { provider: 7 }]) {
      const answer = await call(mounted, DISCONNECT_PATH, 'POST', body)
      expect(answer.status).toBe(400)
    }
    expect(mounted.deleted).toEqual([])
  })

  it('refuses to disconnect with no credential service composed', async () => {
    const mounted = mount({ withoutCredentials: true })
    const answer = await call(mounted, DISCONNECT_PATH, 'POST', { provider: 'linkedin' })
    expect(answer.status).toBe(503)
    expect((JSON.parse(answer.text) as SocialErrorBody).error).toContain('no credential service is composed')
  })

  it('reports no provider disconnectable with no credential service composed', async () => {
    const { body } = await status(mount({ withoutCredentials: true }))
    expect(body.providers.every(row => !row.disconnectable)).toBe(true)
  })

  it('answers the wrong method with 405 and changes nothing', async () => {
    const mounted = mount()
    expect((await call(mounted, STATUS_PATH, 'POST')).status).toBe(405)
    expect((await call(mounted, DISCONNECT_PATH, 'GET')).status).toBe(405)
    expect(mounted.deleted).toEqual([])
  })

  it('refuses a malformed credentialKeys address at load', () => {
    expect(() => mount({ config: { credentialKeys: { linkedin: 'not-a-key' } } }))
      .toThrow(/credentialKeys\["linkedin"\]/)
  })

  it('leaves the routes with the fiber', () => {
    const disposers: Array<() => void> = []
    const routes = new Map<string, RecordedRoute>()
    const ctx = {
      effect(fn: () => () => void) { disposers.push(fn()); return () => {} },
      get: () => undefined,
      tools: { register: () => () => {} },
      webServer: {
        register(route: RecordedRoute) {
          routes.set(route.path, route)
          return () => { routes.delete(route.path) }
        },
      },
      social: { targets: () => Promise.resolve(TARGETS), post: vi.fn() },
    }
    apply(ctx as unknown as Context, {})
    expect(routes.size).toBe(2)
    for (const dispose of disposers) dispose()
    expect(routes.size).toBe(0)
  })
})
