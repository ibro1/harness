/**
 * The YouTube provider driven against a stub HTTP server standing in for
 * Google: what it registers and what disposal removes, what an unauthorized
 * listing says, minting an access token from the stored refresh token and
 * reusing it, the resumable initiate-then-PUT sequence and the metadata it
 * carries, the refusals that never reach the network, and the two things
 * YouTube can answer that a caller has to be told about — a spent quota and a
 * video held at private.
 *
 * The credential and authorization seams are stubbed: this package owns the
 * provider and the Google calls, not the record store or the sign-in lifecycle.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply, type Config } from '../src/index.ts'
import type { SocialPostResult, SocialProvider, SocialTarget, YouTubeGrant } from '../src/types.ts'

/** One request the stub server took, for asserting what was actually sent. */
interface Recorded {
  method: string
  path: string
  headers: Record<string, string>
  body: string
}

/** What a stub route answers with. */
interface Reply {
  status?: number
  headers?: Record<string, string>
  body?: unknown
}

let server: Server | undefined
let workspace: string | undefined

afterEach(async () => {
  if (server !== undefined) {
    await new Promise<void>(resolve => server?.close(() => { resolve() }))
    server = undefined
  }
  if (workspace !== undefined) {
    await rm(workspace, { recursive: true, force: true })
    workspace = undefined
  }
})

/** A Google stand-in: one handler over the token, channel, and upload routes. */
async function stubGoogle(handler: (request: Recorded, origin: string) => Reply): Promise<{ origin: string; taken: Recorded[] }> {
  const taken: Recorded[] = []
  let origin = ''
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    req.on('end', () => {
      const headers: Record<string, string> = {}
      for (const [key, value] of Object.entries(req.headers)) headers[key] = String(value ?? '')
      const request: Recorded = {
        method: req.method ?? 'GET',
        path: req.url ?? '/',
        headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }
      taken.push(request)
      const reply = handler(request, origin)
      res.writeHead(reply.status ?? 200, { 'Content-Type': 'application/json', ...reply.headers })
      res.end(reply.body === undefined ? '' : JSON.stringify(reply.body))
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  origin = `http://127.0.0.1:${String(address.port)}`
  return { origin, taken }
}

/** A stored grant, as this package writes it. */
function storedGrant(refreshToken = 'refresh-1'): { kind: 'grant'; payload: YouTubeGrant } {
  return {
    kind: 'grant',
    payload: {
      version: 1,
      refreshToken,
      scopes: ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly'],
      obtainedAt: 0,
      channelId: 'UC123',
      channelTitle: 'Test Channel',
    },
  }
}

/** What one mounted plugin exposes to a test. */
interface Mounted {
  provider: SocialProvider
  providers: SocialProvider[]
  flows: { key: string; label: string; run: (session: never) => Promise<void> }[]
  dispose: () => void
}

/** Mount the plugin on a stubbed context and hand back what it registered. */
function mount(origin: string, record: unknown, overrides: Partial<Config> = {}): Mounted {
  const config: Config = {
    clientId: 'client-id',
    clientSecret: 'client-secret',
    clientIdRef: 'GOOGLE_CLIENT_ID',
    clientSecretRef: 'GOOGLE_CLIENT_SECRET',
    redirectUri: 'http://localhost',
    privacyStatus: 'private',
    categoryId: '22',
    madeForKids: false,
    notifySubscribers: false,
    chunkBytes: 256 * 1024,
    uploadRetries: 3,
    timeoutMs: 5000,
    chunkTimeoutMs: 5000,
    authBaseUrl: origin,
    tokenBaseUrl: origin,
    apiBaseUrl: origin,
    uploadBaseUrl: origin,
    ...overrides,
  }
  const providers: SocialProvider[] = []
  const flows: Mounted['flows'] = []
  const disposers: (() => void)[] = []
  const ctx = {
    effect(fn: () => () => void) {
      disposers.push(fn())
      return () => {}
    },
    on() { return () => {} },
    credentials: {
      readRecord: () => Promise.resolve(record),
      modifyRecord: () => Promise.resolve(record),
      resolve: () => Promise.resolve(undefined),
    },
    authorization: {
      registerFlow(flow: Mounted['flows'][number]) {
        flows.push(flow)
        return () => { flows.splice(flows.indexOf(flow), 1) }
      },
    },
    social: {
      register(provider: SocialProvider) {
        providers.push(provider)
        return () => { providers.splice(providers.indexOf(provider), 1) }
      },
    },
  }
  apply(ctx as unknown as Context, config)
  const provider = providers[0]
  if (provider === undefined) throw new Error('the plugin registered no provider')
  return { provider, providers, flows, dispose: () => { for (const d of disposers) d() } }
}

/** A video file on disk for the upload to send. */
async function videoFile(bytes = 1000): Promise<string> {
  workspace = await mkdtemp(join(tmpdir(), 'dsh-youtube-'))
  const path = join(workspace, 'clip.mp4')
  await writeFile(path, Buffer.alloc(bytes, 7))
  return path
}

/** The routes a successful upload needs, with the answers a test overrides. */
function googleRoutes(options: {
  videoStatus?: Record<string, string>
  initiate?: Reply
} = {}): (request: Recorded, origin: string) => Reply {
  return (request, origin) => {
    if (request.path.startsWith('/token')) {
      return { body: { access_token: 'access-1', expires_in: 3600, scope: 'a b', token_type: 'Bearer' } }
    }
    if (request.path.startsWith('/youtube/v3/channels')) {
      return { body: { items: [{ id: 'UC123', snippet: { title: 'Test Channel' } }] } }
    }
    if (request.path.startsWith('/upload/youtube/v3/videos')) {
      return options.initiate ?? { headers: { Location: `${origin}/session/one` }, body: {} }
    }
    if (request.path.startsWith('/session/')) {
      return {
        status: 201,
        body: { id: 'VID9', status: { uploadStatus: 'uploaded', privacyStatus: 'private', ...options.videoStatus } },
      }
    }
    return { status: 404, body: { error: { code: 404, message: 'no such route' } } }
  }
}

describe('social-youtube registration', () => {
  it('registers one provider and one authorization flow, and disposal removes both', async () => {
    const { origin } = await stubGoogle(googleRoutes())
    const mounted = mount(origin, undefined)
    expect(mounted.providers).toHaveLength(1)
    expect(mounted.provider.name).toBe('youtube')
    expect(mounted.flows.map(flow => flow.key)).toEqual(['social-youtube/oauth'])
    mounted.dispose()
    expect(mounted.providers).toHaveLength(0)
    expect(mounted.flows).toHaveLength(0)
  })
})

describe('social-youtube targets', () => {
  it('reports one unready target naming the credential when nothing is authorized', async () => {
    const { origin, taken } = await stubGoogle(googleRoutes())
    const { provider } = mount(origin, undefined)
    const targets = await provider.targets()
    expect(targets).toHaveLength(1)
    const target = targets[0] as SocialTarget
    expect(target.ready).toBe(false)
    expect(target.accepts).toEqual({ text: false, image: false, video: true })
    expect(target.reason).toContain('No YouTube account is authorized')
    expect(target.reason).toContain('social-youtube/oauth')
    expect(taken).toHaveLength(0)
  })

  it('mints an access token from the refresh token and reuses it while it lasts', async () => {
    const { origin, taken } = await stubGoogle(googleRoutes())
    const { provider } = mount(origin, storedGrant())
    const first = await provider.targets()
    const second = await provider.targets()
    expect((first[0] as SocialTarget).id).toBe('youtube:channel:UC123')
    expect((first[0] as SocialTarget).ready).toBe(true)
    expect((first[0] as SocialTarget).reason).toContain('first line of text')
    expect((second[0] as SocialTarget).id).toBe('youtube:channel:UC123')

    const tokenCalls = taken.filter(request => request.path.startsWith('/token'))
    expect(tokenCalls).toHaveLength(1)
    expect(tokenCalls[0]?.body).toContain('grant_type=refresh_token')
    expect(tokenCalls[0]?.body).toContain('refresh_token=refresh-1')
    expect(taken.filter(request => request.path.startsWith('/youtube/v3/channels'))).toHaveLength(2)
    expect(taken.find(request => request.path.startsWith('/youtube/v3/channels'))?.headers['authorization'])
      .toBe('Bearer access-1')
  })
})

describe('social-youtube upload', () => {
  it('opens a resumable session with the title and description split from the text, then PUTs the bytes', async () => {
    const { origin, taken } = await stubGoogle(googleRoutes())
    const { provider } = mount(origin, storedGrant())
    const path = await videoFile(1000)
    const result = await provider.post({
      target: 'youtube:channel:UC123',
      text: 'Launch day\n\nWhat we shipped, and why it took two months.',
      media: [{ path, kind: 'video' }],
    })

    const initiate = taken.find(request => request.path.startsWith('/upload/youtube/v3/videos'))
    expect(initiate?.method).toBe('POST')
    expect(initiate?.path).toContain('uploadType=resumable')
    expect(initiate?.path).toContain('part=snippet%2Cstatus')
    expect(initiate?.headers['x-upload-content-length']).toBe('1000')
    expect(initiate?.headers['x-upload-content-type']).toBe('video/mp4')
    const metadata = JSON.parse(initiate?.body ?? '{}') as {
      snippet: { title: string; description: string; categoryId: string }
      status: { privacyStatus: string; selfDeclaredMadeForKids: boolean }
    }
    expect(metadata.snippet.title).toBe('Launch day')
    expect(metadata.snippet.description).toBe('What we shipped, and why it took two months.')
    expect(metadata.status.privacyStatus).toBe('private')

    const put = taken.find(request => request.path.startsWith('/session/'))
    expect(put?.method).toBe('PUT')
    expect(put?.headers['content-range']).toBe('bytes 0-999/1000')
    expect(put?.headers['authorization']).toBe('Bearer access-1')
    expect(put?.body).toHaveLength(1000)

    expect(result.id).toBe('VID9')
    expect(result.url).toBe('https://www.youtube.com/watch?v=VID9')
  })

  it('refuses a post with no video before reaching Google', async () => {
    const { origin, taken } = await stubGoogle(googleRoutes())
    const { provider } = mount(origin, storedGrant())
    await expect(provider.post({ target: 'youtube:channel:UC123', text: 'Just some words' }))
      .rejects.toThrow(/A YouTube post must carry the video to upload/u)
    await expect(provider.post({
      target: 'youtube:channel:UC123',
      text: 'Just some words',
      media: [{ path: '/tmp/poster.png', kind: 'image' }],
    })).rejects.toThrow(/kind "video"/u)
    expect(taken).toHaveLength(0)
  })

  it('says what a spent quota means instead of surfacing the 403', async () => {
    const { origin } = await stubGoogle(googleRoutes({
      initiate: {
        status: 403,
        body: {
          error: {
            code: 403,
            message: 'The request cannot be completed because you have exceeded your quota.',
            errors: [{ domain: 'youtube.quota', reason: 'quotaExceeded', message: 'quota' }],
          },
        },
      },
    }))
    const { provider } = mount(origin, storedGrant())
    const path = await videoFile(512)
    await expect(provider.post({
      target: 'youtube:channel:UC123',
      text: 'Launch day\nThe description.',
      media: [{ path, kind: 'video' }],
    })).rejects.toThrow(/midnight Pacific Time/u)
  })

  it('reports the privacy YouTube actually set, not the one that was asked for', async () => {
    const { origin } = await stubGoogle(googleRoutes({ videoStatus: { privacyStatus: 'private' } }))
    const { provider } = mount(origin, storedGrant(), { privacyStatus: 'public' })
    const path = await videoFile(512)
    const result = await provider.post({
      target: 'youtube:channel:UC123',
      text: 'Launch day\nThe description.',
      media: [{ path, kind: 'video' }],
    }) as SocialPostResult & { notes?: readonly string[] }
    const notes = (result.notes ?? []).join(' ')
    expect(notes).toContain('The video is private on YouTube, although public was requested')
    expect(notes).toContain('unverified API project')
    expect(notes).toContain('still processing it')
    expect(result.id).toBe('VID9')
  })
})
