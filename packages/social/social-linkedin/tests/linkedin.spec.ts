/**
 * The LinkedIn provider driven against a stub HTTP server standing in for
 * LinkedIn: provider registration and disposal, the readiness a stored expiry
 * decides, the sign-in that stores it, and the three posting paths — text, the
 * three-step image upload, and the initialize/upload/finalize video upload.
 *
 * The social seam and the credential store are stubbed, because this package
 * owns the LinkedIn calls and the expiry accounting, not the registry it
 * contributes to or the store it writes through. Nothing here reaches the real
 * LinkedIn.
 */

import { createServer, type IncomingMessage, type Server } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { AuthorizationFlow, AuthorizationNotice, AuthorizationPrompt } from '@deepseek-ai/dsh-authorization'
import type { CredentialKey, CredentialRecord, CredentialRef } from '@deepseek-ai/dsh-credentials'
import { apply, type Config } from '../src/index.ts'
import type { LinkedInGrant, SocialProvider } from '../src/types.ts'

/** The credential record this plugin writes, as a plain key for the stub store. */
const KEY = 'social-linkedin/member'

/** One request the stub server received. */
interface Recorded {
  method: string
  /** Path with its query string, as LinkedIn would see it. */
  url: string
  /** Path alone, for asserting call order without the query noise. */
  path: string
  headers: Record<string, string>
  body: Buffer
}

/** What a stub handler answers with. */
interface Reply {
  status?: number
  headers?: Record<string, string>
  /** An object is sent as JSON; a string is sent verbatim. */
  body?: unknown
}

let server: Server | undefined
let workspace = ''

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'dsh-social-linkedin-'))
})

afterEach(async () => {
  if (server !== undefined) {
    const closing = server
    server = undefined
    // fetch keeps its sockets alive, and `close()` waits for every one of them;
    // dropping them is what keeps a finished spec from holding the port.
    closing.closeAllConnections()
    await new Promise<void>(resolve => closing.close(() => { resolve() }))
  }
  if (workspace !== '') {
    await rm(workspace, { recursive: true, force: true })
    workspace = ''
  }
})

/** Drain one request body. */
async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

/** A LinkedIn stand-in that records every call it answers. */
async function stubLinkedIn(handler: (call: Recorded) => Reply): Promise<{ base: string; calls: Recorded[] }> {
  const calls: Recorded[] = []
  server = createServer((req, res) => {
    void (async () => {
      const url = req.url ?? '/'
      const call: Recorded = {
        method: req.method ?? 'GET',
        url,
        path: url.split('?')[0] ?? url,
        headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v ?? '')])),
        body: await readBody(req),
      }
      calls.push(call)
      const reply = handler(call)
      const isText = typeof reply.body === 'string'
      res.writeHead(reply.status ?? 200, {
        'Content-Type': isText ? 'text/plain' : 'application/json',
        ...reply.headers,
      })
      res.end(reply.body === undefined ? '' : isText ? reply.body as string : JSON.stringify(reply.body))
    })()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the stub server bound no port')
  return { base: `http://127.0.0.1:${String(address.port)}`, calls }
}

/** The mounted plugin, with the seams it contributed to. */
interface Mounted {
  providers: Map<string, SocialProvider>
  flows: Map<string, AuthorizationFlow>
  records: Map<string, CredentialRecord>
  /** Run every disposer the registrations returned, as a fiber teardown would. */
  disposeAll: () => void
}

/** Mount the plugin against stub seams, with a stored record when one is given. */
function mount(overrides: Partial<Config>, stored?: CredentialRecord): Mounted {
  const providers = new Map<string, SocialProvider>()
  const flows = new Map<string, AuthorizationFlow>()
  const records = new Map<string, CredentialRecord>()
  const refs = new Map<string, string>([['LINKEDIN_CLIENT_ID', 'client-1'], ['LINKEDIN_CLIENT_SECRET', 'secret-1']])
  const disposers: (() => void)[] = []
  if (stored !== undefined) records.set(KEY, stored)

  const ctx = {
    effect(run: () => unknown) {
      const disposer = run()
      if (typeof disposer === 'function') disposers.push(disposer as () => void)
      return () => {}
    },
    logger: { warn() {}, info() {}, debug() {} },
    credentials: {
      readRecord: (key: CredentialKey) => Promise.resolve(records.get(key)),
      async modifyRecord(
        key: CredentialKey,
        mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
      ) {
        const next = await mutate(records.get(key))
        if (next !== undefined) records.set(key, next)
        return next
      },
      resolve(ref: CredentialRef) {
        const value = refs.get(ref)
        return Promise.resolve(value === undefined ? undefined : { value, source: 'env' })
      },
    },
    authorization: {
      registerFlow(flow: AuthorizationFlow) {
        flows.set(flow.key, flow)
        return () => { flows.delete(flow.key) }
      },
    },
    social: {
      register(provider: SocialProvider) {
        providers.set(provider.name, provider)
        return () => { providers.delete(provider.name) }
      },
    },
  }

  const config: Config = {
    clientIdRef: 'LINKEDIN_CLIENT_ID',
    clientSecretRef: 'LINKEDIN_CLIENT_SECRET',
    redirectUri: 'https://harness.example/oauth/linkedin',
    apiVersion: '202608',
    reauthWarningDays: 7,
    apiBaseUrl: 'https://api.linkedin.com',
    authBaseUrl: 'https://www.linkedin.com',
    timeoutMs: 5000,
    ...overrides,
  }
  apply(ctx as unknown as Context, config)
  return {
    providers,
    flows,
    records,
    disposeAll: () => { for (const dispose of disposers.reverse()) dispose() },
  }
}

/** A grant that is live for `days` more days. */
function grantFor(days: number, scopes: readonly string[] = ['openid', 'profile', 'w_member_social']): CredentialRecord {
  const payload: LinkedInGrant = {
    accessToken: 'token-1',
    expiresAt: Date.now() + days * 24 * 60 * 60 * 1000,
    obtainedAt: Date.now(),
    scopes,
    memberId: 'mem-1',
    memberName: 'Ada Lovelace',
  }
  return { kind: 'grant', payload }
}

/** Write one attachment into the per-test workspace. */
async function attachment(name: string, contents: Buffer | string): Promise<string> {
  const path = join(workspace, name)
  await writeFile(path, contents)
  return path
}

describe('social-linkedin registration', () => {
  it('registers one linkedin provider and one sign-in flow', () => {
    const mounted = mount({})

    expect([...mounted.providers.keys()]).toEqual(['linkedin'])
    expect([...mounted.flows.keys()]).toEqual([KEY])
    expect(mounted.flows.get(KEY)?.methods.map(method => method.id)).toEqual(['oauth'])
  })

  it('removes both registrations when their disposers run', () => {
    const mounted = mount({})

    mounted.disposeAll()

    expect(mounted.providers.size).toBe(0)
    expect(mounted.flows.size).toBe(0)
  })
})

describe('social-linkedin targets', () => {
  it('reports the member target unready, naming the sign-in, when nothing is stored', async () => {
    const mounted = mount({})

    const targets = await mounted.providers.get('linkedin')!.targets()

    expect(targets).toHaveLength(1)
    const [member] = targets
    expect(member?.id).toBe('linkedin:member')
    expect(member?.provider).toBe('linkedin')
    expect(member?.accepts).toEqual({ text: true, image: true, video: true })
    expect(member?.ready).toBe(false)
    expect(member?.reason).toContain('No LinkedIn credential is stored')
    expect(member?.reason).toContain('social-linkedin/member')
  })

  it('reports the member target unready, naming the date, once the stored token is past its expiry', async () => {
    const mounted = mount({}, grantFor(-1))

    const [member] = await mounted.providers.get('linkedin')!.targets()

    expect(member?.ready).toBe(false)
    expect(member?.reason).toContain('expired on')
    expect(member?.reason).toContain(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10))
    expect(member?.reason).toContain('no refresh token')
  })

  it('reports the member target unready before the token lapses, not after', async () => {
    const mounted = mount({ reauthWarningDays: 7 }, grantFor(3))

    const [member] = await mounted.providers.get('linkedin')!.targets()

    expect(member?.ready).toBe(false)
    expect(member?.reason).toContain('expires on')
    expect(member?.reason).toContain('3 days')
  })

  it('reports the member target ready, labelled with the member, while the token has life left', async () => {
    const mounted = mount({}, grantFor(50))

    const [member] = await mounted.providers.get('linkedin')!.targets()

    expect(member?.ready).toBe(true)
    expect(member?.reason).toBeUndefined()
    expect(member?.label).toBe('LinkedIn — Ada Lovelace')
  })

  it('lists no organization targets while the stored token lacks w_organization_social', async () => {
    const { base, calls } = await stubLinkedIn(() => ({ status: 500, body: { message: 'the roster must not be asked for' } }))
    const mounted = mount({ apiBaseUrl: base }, grantFor(50))

    const targets = await mounted.providers.get('linkedin')!.targets()

    expect(targets.map(target => target.id)).toEqual(['linkedin:member'])
    expect(calls).toHaveLength(0)
  })

  it('lists an organization target once the stored token carries w_organization_social', async () => {
    const { base } = await stubLinkedIn((call) => {
      if (call.path === '/rest/organizationAcls') {
        return { body: { elements: [{ organizationalTarget: 'urn:li:organization:987' }] } }
      }
      if (call.path === '/rest/organizations/987') return { body: { localizedName: 'Analytical Engines Ltd' } }
      return { status: 404, body: {} }
    })
    const mounted = mount(
      { apiBaseUrl: base },
      grantFor(50, ['openid', 'profile', 'w_member_social', 'w_organization_social']),
    )

    const targets = await mounted.providers.get('linkedin')!.targets()

    expect(targets.map(target => target.id)).toEqual(['linkedin:member', 'linkedin:org:987'])
    expect(targets[1]?.label).toBe('LinkedIn — Analytical Engines Ltd')
  })
})

describe('social-linkedin sign-in', () => {
  it('exchanges the pasted redirect for a token and stores it with an absolute expiry', async () => {
    const { base, calls } = await stubLinkedIn((call) => {
      if (call.path === '/oauth/v2/accessToken') {
        return { body: { access_token: 'fresh-token', expires_in: 5_184_000, scope: 'openid profile w_member_social' } }
      }
      if (call.path === '/v2/userinfo') return { body: { sub: 'mem-9', name: 'Ada Lovelace' } }
      return { status: 404, body: {} }
    })
    const mounted = mount({ apiBaseUrl: base, authBaseUrl: base })
    const notices: AuthorizationNotice[] = []
    let asked: AuthorizationPrompt | undefined

    await mounted.flows.get(KEY)!.run({
      method: 'oauth',
      signal: new AbortController().signal,
      notify: (notice) => { notices.push(notice) },
      prompt: (prompt) => {
        asked = prompt
        const state = new URL(notices[0]?.url ?? '').searchParams.get('state') ?? ''
        return Promise.resolve(`https://harness.example/oauth/linkedin?code=the-code&state=${state}`)
      },
    })

    expect(notices[0]?.url).toContain('/oauth/v2/authorization')
    expect(notices[0]?.url).toContain('scope=openid+profile+w_member_social')
    expect(asked?.kind).toBe('text')
    const exchange = calls.find(call => call.path === '/oauth/v2/accessToken')
    expect(exchange?.body.toString('utf8')).toContain('code=the-code')
    expect(exchange?.body.toString('utf8')).toContain('redirect_uri=https%3A%2F%2Fharness.example%2Foauth%2Flinkedin')

    const stored = mounted.records.get(KEY)
    expect(stored?.kind).toBe('grant')
    const grant = (stored as { payload: LinkedInGrant }).payload
    expect(grant.accessToken).toBe('fresh-token')
    expect(grant.memberId).toBe('mem-9')
    expect(grant.scopes).toEqual(['openid', 'profile', 'w_member_social'])
    // Stored absolutely, so "how long is left" is answerable in a later process.
    expect(grant.expiresAt).toBeGreaterThan(Date.now() + 59 * 24 * 60 * 60 * 1000)
    expect(notices[1]?.message).toContain('expires on')
  })

  it('refuses a redirect from a different sign-in attempt', async () => {
    const mounted = mount({})

    await expect(mounted.flows.get(KEY)!.run({
      method: 'oauth',
      signal: new AbortController().signal,
      notify: () => {},
      prompt: () => Promise.resolve('https://harness.example/oauth/linkedin?code=the-code&state=somebody-elses'),
    })).rejects.toThrow('a different sign-in attempt')
  })
})

describe('social-linkedin posting', () => {
  it('publishes a text post as the member, under the versioned API headers', async () => {
    const { base, calls } = await stubLinkedIn(call => call.path === '/rest/posts'
      ? { status: 201, headers: { 'x-restli-id': 'urn:li:share:111' }, body: {} }
      : { status: 404, body: {} })
    const mounted = mount({ apiBaseUrl: base }, grantFor(50))

    const result = await mounted.providers.get('linkedin')!.post({ target: 'linkedin:member', text: 'Hello, feed.' })

    expect(result.id).toBe('urn:li:share:111')
    expect(result.url).toBe('https://www.linkedin.com/feed/update/urn:li:share:111/')
    const posted = calls[0]
    expect(posted?.headers['linkedin-version']).toBe('202608')
    expect(posted?.headers['x-restli-protocol-version']).toBe('2.0.0')
    expect(posted?.headers['authorization']).toBe('Bearer token-1')
    const body = JSON.parse(posted?.body.toString('utf8') ?? '{}') as Record<string, unknown>
    expect(body['author']).toBe('urn:li:person:mem-1')
    expect(body['commentary']).toBe('Hello, feed.')
    expect(body['lifecycleState']).toBe('PUBLISHED')
    expect(body).not.toHaveProperty('content')
  })

  it('refuses a post on the stored expiry alone, without calling LinkedIn', async () => {
    const { base, calls } = await stubLinkedIn(() => ({ status: 500, body: { message: 'LinkedIn must not be asked' } }))
    const mounted = mount({ apiBaseUrl: base }, grantFor(-1))

    await expect(mounted.providers.get('linkedin')!.post({ target: 'linkedin:member', text: 'Too late.' }))
      .rejects.toThrow('expired on')
    expect(calls).toHaveLength(0)
  })

  it('uploads an image in three steps, putting the bytes at the url the registration returned', async () => {
    const bytes = Buffer.from('the image bytes')
    const { base, calls } = await stubLinkedIn((call) => {
      if (call.path === '/rest/images') {
        return { body: { value: { uploadUrl: `${base}/dms-uploads/image-1`, image: 'urn:li:image:IMG1' } } }
      }
      if (call.path === '/dms-uploads/image-1') return { status: 201, body: {} }
      if (call.path === '/rest/posts') return { status: 201, headers: { 'x-restli-id': 'urn:li:share:222' }, body: {} }
      return { status: 404, body: {} }
    })
    const mounted = mount({ apiBaseUrl: base }, grantFor(50))
    const path = await attachment('shot.png', bytes)

    const result = await mounted.providers.get('linkedin')!.post({
      target: 'linkedin:member',
      text: 'With a picture.',
      media: [{ path, kind: 'image', alt: 'A plotted curve.' }],
    })

    expect(result.id).toBe('urn:li:share:222')
    expect(result.notes).toBeUndefined()
    expect(calls.map(call => `${call.method} ${call.path}`)).toEqual([
      'POST /rest/images',
      'PUT /dms-uploads/image-1',
      'POST /rest/posts',
    ])
    expect(calls[0]?.url).toBe('/rest/images?action=initializeUpload')
    expect(JSON.parse(calls[0]?.body.toString('utf8') ?? '{}')).toEqual({
      initializeUploadRequest: { owner: 'urn:li:person:mem-1' },
    })
    // The bytes went to the returned uploadUrl, not to the API origin.
    expect(calls[1]?.body.equals(bytes)).toBe(true)
    const body = JSON.parse(calls[2]?.body.toString('utf8') ?? '{}') as { content?: { media?: unknown } }
    expect(body.content?.media).toEqual({ id: 'urn:li:image:IMG1', altText: 'A plotted curve.' })
  })

  it('reports an image posted without alt text instead of letting it pass unremarked', async () => {
    const { base, calls } = await stubLinkedIn((call) => {
      if (call.path === '/rest/images') {
        return { body: { value: { uploadUrl: `${base}/dms-uploads/image-2`, image: 'urn:li:image:IMG2' } } }
      }
      if (call.path === '/rest/posts') return { status: 201, headers: { 'x-restli-id': 'urn:li:share:333' }, body: {} }
      return { status: 201, body: {} }
    })
    const mounted = mount({ apiBaseUrl: base }, grantFor(50))
    const path = await attachment('undescribed.png', 'bytes')

    const result = await mounted.providers.get('linkedin')!.post({
      target: 'linkedin:member',
      text: 'No description for this one.',
      media: [{ path, kind: 'image' }],
    })

    expect(result.id).toBe('urn:li:share:333')
    expect(result.notes?.join(' ')).toContain('without alt text')
    expect(result.notes?.join(' ')).toContain(path)
    const body = JSON.parse(calls[2]?.body.toString('utf8') ?? '{}') as { content?: { media?: object } }
    expect(body.content?.media).toEqual({ id: 'urn:li:image:IMG2' })
  })

  it('uploads a video as initialize, then every part, then finalize', async () => {
    const bytes = Buffer.from('0123456789ab')
    const { base, calls } = await stubLinkedIn((call) => {
      if (call.path === '/rest/videos' && call.url.includes('initializeUpload')) {
        return {
          body: {
            value: {
              video: 'urn:li:video:VID1',
              uploadToken: 'the-token',
              uploadInstructions: [
                { uploadUrl: `${base}/dms-uploads/video-part-0`, firstByte: 0, lastByte: 5 },
                { uploadUrl: `${base}/dms-uploads/video-part-1`, firstByte: 6, lastByte: 11 },
              ],
            },
          },
        }
      }
      if (call.path === '/dms-uploads/video-part-0') return { status: 200, headers: { etag: '"part-a"' }, body: {} }
      if (call.path === '/dms-uploads/video-part-1') return { status: 200, headers: { etag: 'part-b' }, body: {} }
      if (call.path === '/rest/videos') return { status: 200, body: {} }
      if (call.path === '/rest/posts') return { status: 201, headers: { 'x-restli-id': 'urn:li:share:444' }, body: {} }
      return { status: 404, body: {} }
    })
    const mounted = mount({ apiBaseUrl: base }, grantFor(50))
    const path = await attachment('clip.mp4', bytes)

    const result = await mounted.providers.get('linkedin')!.post({
      target: 'linkedin:member',
      text: 'With a clip.',
      media: [{ path, kind: 'video', alt: 'A short clip.' }],
    })

    expect(result.id).toBe('urn:li:share:444')
    expect(calls.map(call => `${call.method} ${call.url}`)).toEqual([
      'POST /rest/videos?action=initializeUpload',
      'PUT /dms-uploads/video-part-0',
      'PUT /dms-uploads/video-part-1',
      'POST /rest/videos?action=finalizeUpload',
      'POST /rest/posts',
    ])
    expect(JSON.parse(calls[0]?.body.toString('utf8') ?? '{}')).toEqual({
      initializeUploadRequest: { owner: 'urn:li:person:mem-1', fileSizeBytes: bytes.length },
    })
    // Each part carries exactly its own byte range, in order.
    expect(calls[1]?.body.toString('utf8')).toBe('012345')
    expect(calls[2]?.body.toString('utf8')).toBe('6789ab')
    // The etags come back in part order, with the quoted form's quotes stripped.
    expect(JSON.parse(calls[3]?.body.toString('utf8') ?? '{}')).toEqual({
      finalizeUploadRequest: {
        video: 'urn:li:video:VID1',
        uploadToken: 'the-token',
        uploadedPartIds: ['part-a', 'part-b'],
      },
    })
    const body = JSON.parse(calls[4]?.body.toString('utf8') ?? '{}') as { content?: { media?: object } }
    expect(body.content?.media).toEqual({ id: 'urn:li:video:VID1', title: 'A short clip.' })
  })

  it('surfaces the LinkedIn error body rather than swallowing it', async () => {
    const { base } = await stubLinkedIn(() => ({
      status: 403,
      body: { message: 'Not enough permissions to access: POST /rest/posts', serviceErrorCode: 100, status: 403 },
    }))
    const mounted = mount({ apiBaseUrl: base }, grantFor(50))

    await expect(mounted.providers.get('linkedin')!.post({ target: 'linkedin:member', text: 'Refused.' }))
      .rejects.toThrow('Not enough permissions to access: POST /rest/posts')
  })

  it('refuses an organization target while the stored token lacks the scope for it', async () => {
    const mounted = mount({}, grantFor(50))

    await expect(mounted.providers.get('linkedin')!.post({ target: 'linkedin:org:987', text: 'For the page.' }))
      .rejects.toThrow('w_organization_social')
  })

  it('refuses a target id it does not emit', async () => {
    const mounted = mount({}, grantFor(50))

    await expect(mounted.providers.get('linkedin')!.post({ target: 'twitter:me', text: 'Wrong network.' }))
      .rejects.toThrow('is not a LinkedIn target')
  })
})
