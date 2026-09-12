/**
 * The Meta provider driven against a stub Graph API: registration and disposal,
 * target discovery and its readiness reasons, and each publishing path. The
 * credential seam, the authorization seam and the social registry are stubbed,
 * because this package owns the Graph calls and the targets it derives from
 * them, not the stores those seams keep.
 */

import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { AuthorizationFlow } from '@deepseek-ai/dsh-authorization'
import type { CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { apply, type Config } from '../src/index.ts'
import type { SocialProvider } from '../src/types.ts'

/** One request the stub Graph API received. */
interface Recorded {
  method: string
  /** The path with the version prefix removed, such as `me/accounts`. */
  path: string
  query: URLSearchParams
  body: string
  headers: IncomingHttpHeaders
}

/** What a stub route answers with. */
interface Reply { status?: number; body: unknown }

let server: Server | undefined
let recorded: Recorded[] = []
let scratch: string | undefined

afterEach(async () => {
  if (server !== undefined) {
    await new Promise<void>(resolve => server?.close(() => { resolve() }))
    server = undefined
  }
  recorded = []
  if (scratch !== undefined) {
    await rm(scratch, { recursive: true, force: true })
    scratch = undefined
  }
})

/** Start a Graph API stand-in, recording every request it answers. */
async function stubGraph(reply: (request: Recorded) => Reply): Promise<string> {
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://stub')
      const request: Recorded = {
        method: req.method ?? 'GET',
        path: decodeURIComponent(url.pathname).replace(/^\/v[0-9.]+\//u, ''),
        query: url.searchParams,
        body: Buffer.concat(chunks).toString('utf8'),
        headers: req.headers,
      }
      recorded.push(request)
      const { status, body } = reply(request)
      res.writeHead(status ?? 200, { 'Content-Type': 'application/json' })
      res.end(typeof body === 'string' ? body : JSON.stringify(body))
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return `http://127.0.0.1:${String(address.port)}`
}

/** The Pages the default stub reports, one of them with a linked Instagram account. */
const PAGES = [
  { id: '1001', name: 'Mall Suleiman', access_token: 'page-token-1001', instagram_business_account: { id: '17841', username: 'mallsuleiman' } },
  { id: '1002', name: 'Side Project', access_token: 'page-token-1002' },
]

/** Every permission a fully reviewed app has. */
const ALL_SCOPES = [
  'pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'instagram_basic', 'instagram_content_publish',
]

/** Build a stub Graph handler: permissions and Pages by default, plus named routes. */
function graphHandler(options: {
  scopes?: string[]
  pages?: unknown[]
  routes?: Record<string, (request: Recorded) => Reply>
} = {}): (request: Recorded) => Reply {
  return (request) => {
    const route = options.routes?.[`${request.method} ${request.path}`]
    if (route !== undefined) return route(request)
    if (request.path === 'me/permissions') {
      return { body: { data: (options.scopes ?? ALL_SCOPES).map(permission => ({ permission, status: 'granted' })) } }
    }
    if (request.path === 'me/accounts') return { body: { data: options.pages ?? PAGES } }
    return { status: 404, body: { error: { message: `no stub route for ${request.method} ${request.path}` } } }
  }
}

/** A stored grant with a token that is still good for thirty days. */
function grantRecord(overrides: Record<string, unknown> = {}): CredentialRecord {
  return {
    kind: 'grant',
    payload: {
      version: 1,
      userToken: 'long-lived-user-token',
      expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
      obtainedAt: Date.now(),
      grantedScopes: ALL_SCOPES,
      ...overrides,
    },
  }
}

/** Config for a mount pointed at the stub, with the Instagram waits shortened. */
function config(base: string, overrides: Partial<Config> = {}): Config {
  return {
    account: 'default',
    appIdRef: 'META_APP_ID',
    appSecretRef: 'META_APP_SECRET',
    redirectUri: 'https://example.test/meta',
    instagram: true,
    publicMediaBaseUrl: '',
    graphVersion: 'v25.0',
    graphBaseUrl: base,
    graphVideoBaseUrl: base,
    loginBaseUrl: base,
    timeoutMs: 5000,
    containerPollIntervalMs: 5,
    containerTimeoutMs: 200,
    tokenExpiryWarningDays: 14,
    ...overrides,
  }
}

/** One mounted plugin: what it registered, and the handle that disposes it. */
interface Mounted {
  providers: SocialProvider[]
  flows: AuthorizationFlow[]
  stored: () => CredentialRecord | undefined
  dispose: () => void
}

/** Mount the plugin against stub seams. */
function mount(options: { config: Config; record?: CredentialRecord }): Mounted {
  const providers: SocialProvider[] = []
  const flows: AuthorizationFlow[] = []
  const disposers: Array<() => void> = []
  let stored = options.record
  const ctx = {
    credentials: {
      resolve: (ref: string) => Promise.resolve({ value: `secret-for-${ref}`, source: 'env' }),
      readRecord: () => Promise.resolve(stored),
      async modifyRecord(_key: string, mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>) {
        stored = await mutate(stored)
        return stored
      },
    },
    authorization: {
      registerFlow(flow: AuthorizationFlow) {
        flows.push(flow)
        return () => { flows.splice(flows.indexOf(flow), 1) }
      },
    },
    // A property, not `get('social')`: the seam declares `Context.social` and
    // the plugin declares it in `inject`, so it is a declared injection and the
    // house rule reserves `ctx.get` for optional services.
    social: {
      register(provider: SocialProvider) {
        providers.push(provider)
        return () => { providers.splice(providers.indexOf(provider), 1) }
      },
    },
    effect(fn: () => () => void) {
      const disposer = fn()
      disposers.push(disposer)
      return disposer
    },
  }
  apply(ctx as unknown as Context, options.config)
  return {
    providers,
    flows,
    stored: () => stored,
    dispose: () => { for (const disposer of disposers.reverse()) disposer() },
  }
}

/** One registered provider by name. */
function named(mounted: Mounted, provider: 'facebook' | 'instagram'): SocialProvider {
  const found = mounted.providers.find(candidate => candidate.name === provider)
  if (found === undefined) throw new Error(`no ${provider} provider was registered on the social seam`)
  return found
}

describe('social-meta registration', () => {
  it('registers both providers and one shared authorization flow, and withdraws them on disposal', async () => {
    const base = await stubGraph(graphHandler())
    const mounted = mount({ config: config(base) })
    expect(mounted.providers.map(p => p.name)).toEqual(['facebook', 'instagram'])
    expect(mounted.flows.map(f => String(f.key))).toEqual(['social-meta/default'])
    expect(mounted.flows[0]?.methods[0]?.id).toBe('facebook-login')
    mounted.dispose()
    expect(mounted.providers).toEqual([])
    expect(mounted.flows).toEqual([])
  })

  it('refuses an account id that cannot address a credential record', async () => {
    const base = await stubGraph(graphHandler())
    expect(() => mount({ config: config(base, { account: 'Not Valid' }) }))
      .toThrow('account "Not Valid" must be lowercase letters, digits and hyphens')
  })
})

describe('social-meta authorization', () => {
  it('exchanges a pasted code for a long-lived token and commits the grant', async () => {
    const base = await stubGraph(graphHandler({
      routes: {
        'GET oauth/access_token': request => request.query.get('grant_type') === 'fb_exchange_token'
          ? { body: { access_token: 'long-token', token_type: 'bearer', expires_in: 5_184_000 } }
          : { body: { access_token: 'short-token' } },
      },
    }))
    const mounted = mount({ config: config(base) })
    const flow = mounted.flows[0]
    if (flow === undefined) throw new Error('no authorization flow was registered')
    const notices: Array<{ message: string; url?: string }> = []
    await flow.run({
      method: 'facebook-login',
      signal: new AbortController().signal,
      notify: (notice) => { notices.push(notice) },
      prompt: () => Promise.resolve('the-code'),
    })
    const dialog = new URL(notices[0]?.url ?? '')
    expect(dialog.searchParams.get('scope')).toContain('instagram_content_publish')
    expect(dialog.searchParams.get('redirect_uri')).toBe('https://example.test/meta')
    const stored = mounted.stored()
    expect(stored?.kind).toBe('grant')
    const payload = (stored as { payload: Record<string, unknown> }).payload
    expect(payload['userToken']).toBe('long-token')
    expect(payload['grantedScopes']).toContain('pages_manage_posts')
    expect(Number(payload['expiresAt'])).toBeGreaterThan(Date.now() + 5_183_000_000)
    expect(notices.at(-1)?.message).toContain('Mall Suleiman')
  })

  it('reports a paste that carries no code rather than exchanging nothing', async () => {
    const base = await stubGraph(graphHandler())
    const mounted = mount({ config: config(base) })
    const flow = mounted.flows[0]
    if (flow === undefined) throw new Error('no authorization flow was registered')
    await expect(flow.run({
      method: 'facebook-login',
      signal: new AbortController().signal,
      notify: () => {},
      prompt: () => Promise.resolve('https://example.test/meta?error=access_denied'),
    })).rejects.toThrow('Meta refused the sign-in: access_denied')
    expect(mounted.stored()).toBeUndefined()
  })
})

describe('social-meta targets', () => {
  it('reports one Page target per Page, each id prefixed with the provider that lists it', async () => {
    const base = await stubGraph(graphHandler())
    const mounted = mount({ config: config(base), record: grantRecord() })
    const targets = await named(mounted, 'facebook').targets()
    expect(targets.map(t => t.id)).toEqual(['facebook:page:1001', 'facebook:page:1002'])
    expect(targets.map(t => t.provider)).toEqual(['facebook', 'facebook'])
    expect(targets[0]?.label).toBe('Mall Suleiman')
    expect(targets[0]?.accepts).toEqual({ text: true, image: true, video: true })
    expect(targets[0]?.ready).toBe(true)
  })

  it('reports an Instagram target only for a Page with a linked business account', async () => {
    const base = await stubGraph(graphHandler())
    const mounted = mount({ config: config(base), record: grantRecord() })
    const targets = await named(mounted, 'instagram').targets()
    expect(targets.map(t => t.id)).toEqual(['instagram:17841'])
    expect(targets[0]?.provider).toBe('instagram')
    expect(targets[0]?.label).toBe('Mall Suleiman (Instagram @mallsuleiman)')
    expect(targets[0]?.accepts).toEqual({ text: false, image: true, video: true })
  })

  it('registers no Instagram provider while instagram is off', async () => {
    const base = await stubGraph(graphHandler())
    const mounted = mount({ config: config(base, { instagram: false }), record: grantRecord() })
    expect(mounted.providers.map(p => p.name)).toEqual(['facebook'])
  })

  it('reports a Page as not ready, naming App Review, when pages_manage_posts is not granted', async () => {
    const base = await stubGraph(graphHandler({ scopes: ['pages_show_list', 'pages_read_engagement', 'instagram_basic'] }))
    const mounted = mount({ config: config(base), record: grantRecord() })
    const page = (await named(mounted, 'facebook').targets()).find(t => t.id === 'facebook:page:1001')
    expect(page?.ready).toBe(false)
    expect(page?.reason).toContain('pages_manage_posts')
    expect(page?.reason).toContain('App Review')
    const instagram = (await named(mounted, 'instagram').targets()).find(t => t.id === 'instagram:17841')
    expect(instagram?.ready).toBe(false)
    expect(instagram?.reason).toContain('instagram_content_publish')
  })

  it('refuses to publish to a target that is not ready, with the same reason it listed', async () => {
    const base = await stubGraph(graphHandler({ scopes: ['pages_show_list'] }))
    const mounted = mount({ config: config(base), record: grantRecord() })
    await expect(named(mounted, 'facebook').post({ target: 'facebook:page:1001', text: 'hi' }))
      .rejects.toThrow('App Review')
    expect(recorded.some(request => request.path.endsWith('/feed'))).toBe(false)
  })

  it('warns on a ready target while the user token is close to expiring', async () => {
    const base = await stubGraph(graphHandler())
    const soon = Date.now() + 3 * 24 * 60 * 60 * 1000
    const mounted = mount({ config: config(base), record: grantRecord({ expiresAt: soon }) })
    const targets = await named(mounted, 'facebook').targets()
    expect(targets[0]?.ready).toBe(true)
    expect(targets[0]?.reason).toContain('expires on')
  })

  it('reports an expired user token from the stored expiry, without calling the Graph API', async () => {
    const base = await stubGraph(graphHandler())
    const mounted = mount({ config: config(base), record: grantRecord({ expiresAt: Date.now() - 1000 }) })
    await expect(named(mounted, 'facebook').targets()).rejects.toThrow('expired on')
    expect(recorded).toEqual([])
  })

  it('surfaces a Graph error body verbatim', async () => {
    const body = '{"error":{"message":"(#100) Tried accessing nonexisting field","type":"OAuthException","code":100}}'
    const base = await stubGraph(graphHandler({ routes: { 'GET me/accounts': () => ({ status: 400, body }) } }))
    const mounted = mount({ config: config(base), record: grantRecord() })
    await expect(named(mounted, 'facebook').targets()).rejects.toThrow(body)
  })
})

describe('social-meta facebook publishing', () => {
  it('posts text to the Page feed with the Page access token', async () => {
    const base = await stubGraph(graphHandler({
      routes: { 'POST 1001/feed': () => ({ body: { id: '1001_55' } }) },
    }))
    const mounted = mount({ config: config(base), record: grantRecord() })
    const result = await named(mounted, 'facebook').post({ target: 'facebook:page:1001', text: 'hello world' })
    expect(result).toEqual({ id: '1001_55', url: 'https://www.facebook.com/1001_55' })
    const feed = recorded.find(request => request.path === '1001/feed')
    const form = new URLSearchParams(feed?.body ?? '')
    expect(form.get('message')).toBe('hello world')
    expect(form.get('access_token')).toBe('page-token-1001')
  })

  it('posts a local image to the photos edge as an upload, and reports the story id', async () => {
    const base = await stubGraph(graphHandler({
      routes: { 'POST 1001/photos': () => ({ body: { id: '900', post_id: '1001_900' } }) },
    }))
    scratch = await mkdtemp(join(tmpdir(), 'dsh-social-meta-'))
    const file = join(scratch, 'poster.png')
    await writeFile(file, 'PNGBYTES')
    const mounted = mount({ config: config(base), record: grantRecord() })
    const result = await named(mounted, 'facebook').post({
      target: 'facebook:page:1001',
      text: 'the caption',
      media: [{ path: file, kind: 'image' }],
    })
    expect(result.id).toBe('1001_900')
    const photos = recorded.find(request => request.path === '1001/photos')
    expect(String(photos?.headers['content-type'])).toContain('multipart/form-data')
    expect(photos?.body).toContain('the caption')
    expect(photos?.body).toContain('PNGBYTES')
    expect(photos?.body).toContain('poster.png')
  })
})

describe('social-meta instagram publishing', () => {
  /** Routes for a container that finishes after one IN_PROGRESS check. */
  function instagramRoutes(statuses: string[]): Record<string, (request: Recorded) => Reply> {
    let checks = 0
    return {
      'POST 17841/media': () => ({ body: { id: 'container-7' } }),
      'GET container-7': () => {
        const status = statuses[Math.min(checks, statuses.length - 1)] ?? 'IN_PROGRESS'
        checks += 1
        return { body: { status_code: status } }
      },
      'POST 17841/media_publish': () => ({ body: { id: 'media-42' } }),
    }
  }

  it('creates a container, waits for it, then publishes it, in that order', async () => {
    const base = await stubGraph(graphHandler({ routes: instagramRoutes(['IN_PROGRESS', 'FINISHED']) }))
    const mounted = mount({ config: config(base), record: grantRecord() })
    const result = await named(mounted, 'instagram').post({
      target: 'instagram:17841',
      text: 'a caption',
      media: [{ path: 'https://cdn.example.test/photo.jpg', kind: 'image', alt: 'a poster on a wall' }],
    })
    expect(result).toEqual({ id: 'media-42' })
    const order = recorded.map(request => request.path).filter(path => path.startsWith('17841/') || path === 'container-7')
    expect(order).toEqual(['17841/media', 'container-7', 'container-7', '17841/media_publish'])
    const create = new URLSearchParams(recorded.find(request => request.path === '17841/media')?.body ?? '')
    expect(create.get('image_url')).toBe('https://cdn.example.test/photo.jpg')
    expect(create.get('caption')).toBe('a caption')
    expect(create.get('alt_text')).toBe('a poster on a wall')
    const publish = new URLSearchParams(recorded.find(request => request.path === '17841/media_publish')?.body ?? '')
    expect(publish.get('creation_id')).toBe('container-7')
  })

  it('reports a container that never finishes as a timeout, and publishes nothing', async () => {
    const base = await stubGraph(graphHandler({ routes: instagramRoutes(['IN_PROGRESS']) }))
    const mounted = mount({ config: config(base, { containerTimeoutMs: 60 }), record: grantRecord() })
    await expect(named(mounted, 'instagram').post({
      target: 'instagram:17841',
      text: 'a caption',
      media: [{ path: 'https://cdn.example.test/photo.jpg', kind: 'image' }],
    })).rejects.toThrow(/still IN_PROGRESS after 60ms; nothing was published/u)
    expect(recorded.some(request => request.path === '17841/media_publish')).toBe(false)
  })

  it('refuses a local file while no public base URL is configured, rather than posting nothing', async () => {
    const base = await stubGraph(graphHandler())
    const mounted = mount({ config: config(base), record: grantRecord() })
    await expect(named(mounted, 'instagram').post({
      target: 'instagram:17841',
      text: 'a caption',
      media: [{ path: '/tmp/photo.jpg', kind: 'image' }],
    })).rejects.toThrow('publicMediaBaseUrl')
  })

  it('refuses a text-only Instagram post', async () => {
    const base = await stubGraph(graphHandler())
    const mounted = mount({ config: config(base), record: grantRecord() })
    await expect(named(mounted, 'instagram').post({ target: 'instagram:17841', text: 'just words' }))
      .rejects.toThrow('Instagram has no text-only post')
  })
})
