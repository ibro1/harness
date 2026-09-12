/**
 * The Cloudflare tools, driven against a stub HTTP server standing in for the
 * v4 API: tool registration on an agent, zone resolution by name, a URL purge
 * and the refusal to purge everything implicitly, both branches of the DNS
 * upsert, a `success: false` body answered with HTTP 200, and the SSRF refusal
 * on `cloudflare_cache_status`. The settings service and the agent roster are
 * stubbed, because this package owns the tools and the API calls, not the
 * settings store or the agent lifecycle.
 */

import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply, type Config } from '../src/index.ts'

interface RecordedTool {
  name: string
  execute: (args: Record<string, unknown>, exec: { signal: AbortSignal }) => Promise<{ text: string }>
}

/** One request the stub API received, for assertions about method and body. */
interface SeenRequest {
  method: string
  path: string
  body: string
  authorization: string
}

let server: Server | undefined

afterEach(async () => {
  if (server !== undefined) {
    await new Promise<void>(resolve => server?.close(() => { resolve() }))
    server = undefined
  }
})

/** A Cloudflare stand-in; the handler answers by method and path. */
async function stubCloudflare(
  handler: (request: SeenRequest) => { status?: number; json: unknown },
  seen: SeenRequest[] = [],
): Promise<string> {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    req.on('end', () => {
      const request: SeenRequest = {
        method: req.method ?? 'GET',
        path: req.url ?? '',
        body,
        authorization: req.headers.authorization ?? '',
      }
      seen.push(request)
      const { status, json } = handler(request)
      res.writeHead(status ?? 200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(json))
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return `http://127.0.0.1:${String(address.port)}`
}

/** A successful Cloudflare envelope around one result. */
function ok(result: unknown): { json: unknown } {
  return { json: { success: true, errors: [], messages: [], result } }
}

/**
 * Mount the plugin against a stub zone roster and a single stub agent, and
 * return that agent's registered tools by name.
 */
function mount(
  zones: { name: string; zoneId: string; apiTokenEnv?: string; apiToken?: string }[],
  apiBase = 'http://127.0.0.1:1',
): Map<string, RecordedTool> {
  const tools = new Map<string, RecordedTool>()
  const agentCtx = {
    inject(_names: string[], fn: (scope: unknown) => void) {
      fn({
        effect(effectFn: () => unknown) { return effectFn() },
        tools: {
          register(tool: RecordedTool) { tools.set(tool.name, tool); return () => {} },
        },
      })
      return { dispose: () => Promise.resolve() }
    },
  }
  const ctx = {
    settings: {
      register() {
        return { get: () => ({ zones }), watch: () => () => {}, patch: () => Promise.resolve() }
      },
    },
    agents: { list: () => [{ ctx: agentCtx }] },
    on() {},
    effect(fn: () => unknown) { fn() },
  }
  const config: Config = { timeoutMs: 5000, path: '/cloudflare', token: '', apiBase }
  apply(ctx as unknown as Context, config)
  return tools
}

process.env.CLOUDFLARE_TOKEN_TEST = 'the-real-token'
const exec = { signal: new AbortController().signal }

describe('cloudflare tools', () => {
  it('registers the five tools on an agent', () => {
    const tools = mount([])
    expect([...tools.keys()].sort()).toEqual([
      'cloudflare_cache_status',
      'cloudflare_dns_list',
      'cloudflare_dns_set',
      'cloudflare_purge',
      'cloudflare_zones',
    ])
  })

  it('lists configured zones without revealing tokens', async () => {
    const tools = mount([{ name: 'site', zoneId: 'zone-1', apiTokenEnv: 'CLOUDFLARE_TOKEN_TEST' }])
    const out = await tools.get('cloudflare_zones')!.execute({}, exec)
    expect(out.text).toContain('site')
    expect(out.text).toContain('zone-1')
    expect(out.text).not.toContain('the-real-token')
  })

  it('refuses to guess when several zones are configured', async () => {
    const tools = mount([
      { name: 'site', zoneId: 'z1', apiTokenEnv: 'CLOUDFLARE_TOKEN_TEST' },
      { name: 'blog', zoneId: 'z2', apiTokenEnv: 'CLOUDFLARE_TOKEN_TEST' },
    ])
    await expect(tools.get('cloudflare_dns_list')!.execute({}, exec))
      .rejects.toThrow('Several Cloudflare zones are configured (site, blog); pass zone to choose one')
  })

  it('reports an unknown zone name with the ones that exist', async () => {
    const tools = mount([{ name: 'site', zoneId: 'z1', apiTokenEnv: 'CLOUDFLARE_TOKEN_TEST' }])
    await expect(tools.get('cloudflare_dns_list')!.execute({ zone: 'nope' }, exec))
      .rejects.toThrow('No Cloudflare zone named "nope"; configured: site')
  })

  it('names the token field to fix when a zone has neither form', async () => {
    const tools = mount([{ name: 'site', zoneId: 'z1' }])
    await expect(tools.get('cloudflare_dns_list')!.execute({}, exec))
      .rejects.toThrow('Cloudflare site has no API token: give this zone an apiToken')
  })

  it('purges the given URLs and sends the bearer token', async () => {
    const seen: SeenRequest[] = []
    const base = await stubCloudflare(() => ok({ id: 'z1' }), seen)
    const tools = mount([{ name: 'site', zoneId: 'z1', apiTokenEnv: 'CLOUDFLARE_TOKEN_TEST' }], base)
    const out = await tools.get('cloudflare_purge')!.execute(
      { urls: ['https://example.com/a.js', 'https://example.com/b.png'] }, exec)
    expect(out.text).toContain('Purged 2 URL(s) from site')
    expect(seen[0]?.method).toBe('POST')
    expect(seen[0]?.path).toBe('/zones/z1/purge_cache')
    expect(seen[0]?.authorization).toBe('Bearer the-real-token')
    expect(JSON.parse(seen[0]?.body ?? '{}')).toEqual({ files: ['https://example.com/a.js', 'https://example.com/b.png'] })
  })

  it('uses an inline apiToken when no apiTokenEnv is named', async () => {
    const seen: SeenRequest[] = []
    const base = await stubCloudflare(() => ok({ id: 'z1' }), seen)
    const tools = mount([{ name: 'site', zoneId: 'z1', apiToken: 'inline-token' }], base)
    await tools.get('cloudflare_purge')!.execute({ urls: ['https://example.com/a.js'] }, exec)
    expect(seen[0]?.authorization).toBe('Bearer inline-token')
  })

  it('refuses a full purge that was not asked for explicitly', async () => {
    const seen: SeenRequest[] = []
    const base = await stubCloudflare(() => ok({ id: 'z1' }), seen)
    const tools = mount([{ name: 'site', zoneId: 'z1', apiTokenEnv: 'CLOUDFLARE_TOKEN_TEST' }], base)
    await expect(tools.get('cloudflare_purge')!.execute({}, exec))
      .rejects.toThrow('Nothing to purge')
    await expect(tools.get('cloudflare_purge')!.execute({ urls: [] }, exec))
      .rejects.toThrow('Nothing to purge')
    expect(seen).toEqual([])
  })

  it('purges everything only on the explicit flag', async () => {
    const seen: SeenRequest[] = []
    const base = await stubCloudflare(() => ok({ id: 'z1' }), seen)
    const tools = mount([{ name: 'site', zoneId: 'z1', apiTokenEnv: 'CLOUDFLARE_TOKEN_TEST' }], base)
    const out = await tools.get('cloudflare_purge')!.execute({ everything: true }, exec)
    expect(out.text).toContain('Purged the entire cache of site')
    expect(JSON.parse(seen[0]?.body ?? '{}')).toEqual({ purge_everything: true })
  })

  it('refuses more URLs than Cloudflare accepts in one call', async () => {
    const tools = mount([{ name: 'site', zoneId: 'z1', apiTokenEnv: 'CLOUDFLARE_TOKEN_TEST' }])
    const urls = Array.from({ length: 31 }, (_v, i) => `https://example.com/${String(i)}.js`)
    await expect(tools.get('cloudflare_purge')!.execute({ urls }, exec))
      .rejects.toThrow('at most 30 URLs per call')
  })

  it('lists DNS records with their type, name and content', async () => {
    const seen: SeenRequest[] = []
    const base = await stubCloudflare(() => ok([
      { id: 'r1', type: 'A', name: 'app.example.com', content: '203.0.113.4', ttl: 1, proxied: true },
    ]), seen)
    const tools = mount([{ name: 'site', zoneId: 'z1', apiTokenEnv: 'CLOUDFLARE_TOKEN_TEST' }], base)
    const out = await tools.get('cloudflare_dns_list')!.execute({ type: 'A' }, exec)
    expect(out.text).toContain('A app.example.com -> 203.0.113.4')
    expect(out.text).toContain('proxied')
    expect(seen[0]?.path).toBe('/zones/z1/dns_records?type=A')
  })

  it('replaces an existing DNS record with PUT', async () => {
    const seen: SeenRequest[] = []
    const base = await stubCloudflare((request) => {
      if (request.method === 'GET') {
        return ok([{ id: 'r1', type: 'A', name: 'app.example.com', content: '203.0.113.1' }])
      }
      return ok({ id: 'r1' })
    }, seen)
    const tools = mount([{ name: 'site', zoneId: 'z1', apiTokenEnv: 'CLOUDFLARE_TOKEN_TEST' }], base)
    const out = await tools.get('cloudflare_dns_set')!.execute(
      { type: 'A', name: 'app.example.com', content: '203.0.113.9', ttl: 300 }, exec)
    expect(out.text).toContain('Replaced the A record for app.example.com on site: 203.0.113.1 -> 203.0.113.9')
    expect(seen[1]?.method).toBe('PUT')
    expect(seen[1]?.path).toBe('/zones/z1/dns_records/r1')
    expect(JSON.parse(seen[1]?.body ?? '{}')).toEqual({
      type: 'A', name: 'app.example.com', content: '203.0.113.9', ttl: 300,
    })
  })

  it('creates a missing DNS record with POST', async () => {
    const seen: SeenRequest[] = []
    const base = await stubCloudflare(request => (request.method === 'GET' ? ok([]) : ok({ id: 'r2' })), seen)
    const tools = mount([{ name: 'site', zoneId: 'z1', apiTokenEnv: 'CLOUDFLARE_TOKEN_TEST' }], base)
    const out = await tools.get('cloudflare_dns_set')!.execute(
      { type: 'CNAME', name: 'www.example.com', content: 'example.com', proxied: true }, exec)
    expect(out.text).toContain('Created a CNAME record for www.example.com on site pointing at example.com')
    expect(seen[1]?.method).toBe('POST')
    expect(seen[1]?.path).toBe('/zones/z1/dns_records')
    expect(JSON.parse(seen[1]?.body ?? '{}')).toEqual({
      type: 'CNAME', name: 'www.example.com', content: 'example.com', proxied: true,
    })
  })

  it('surfaces the Cloudflare message when a 200 carries success: false', async () => {
    const base = await stubCloudflare(() => ({
      status: 200,
      json: { success: false, errors: [{ code: 10000, message: 'Authentication error' }], result: null },
    }))
    const tools = mount([{ name: 'site', zoneId: 'z1', apiTokenEnv: 'CLOUDFLARE_TOKEN_TEST' }], base)
    await expect(tools.get('cloudflare_purge')!.execute({ urls: ['https://example.com/a.js'] }, exec))
      .rejects.toThrow('Authentication error')
  })
})

describe('cloudflare_cache_status', () => {
  it('refuses loopback, private, link-local and CGNAT addresses', async () => {
    const tools = mount([])
    for (const url of [
      'http://127.0.0.1:8080/health',
      'http://10.0.0.5/',
      'http://192.168.1.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://100.64.0.1/',
      'http://[::1]/',
    ]) {
      await expect(tools.get('cloudflare_cache_status')!.execute({ url }, exec))
        .rejects.toThrow('a private or loopback address')
    }
  })

  it('refuses a URL that is not http or https', async () => {
    const tools = mount([])
    await expect(tools.get('cloudflare_cache_status')!.execute({ url: 'file:///etc/passwd' }, exec))
      .rejects.toThrow('only reads http and https URLs')
  })

  it('refuses something that is not an absolute URL', async () => {
    const tools = mount([])
    await expect(tools.get('cloudflare_cache_status')!.execute({ url: '/assets/app.js' }, exec))
      .rejects.toThrow('Not an absolute URL')
  })
})

describe('cloudflare MCP surface', () => {
  it('builds a catalogue of the five tools with their schemas', async () => {
    const { buildCloudflareTools } = await import('../src/index.ts')
    const tools = buildCloudflareTools(
      () => [{ name: 'site', zoneId: 'z1', apiTokenEnv: 'CLOUDFLARE_TOKEN_TEST' }],
      { timeoutMs: 5000, path: '/cloudflare', token: '', apiBase: 'https://api.cloudflare.com/client/v4' },
    )
    expect(tools.map(t => t.name)).toEqual([
      'cloudflare_zones', 'cloudflare_purge', 'cloudflare_dns_list', 'cloudflare_dns_set', 'cloudflare_cache_status',
    ])
    const purge = tools.find(t => t.name === 'cloudflare_purge')
    expect((purge?.parameters as { properties: object }).properties).toHaveProperty('everything')
    const set = tools.find(t => t.name === 'cloudflare_dns_set')
    expect((set?.parameters as { required: string[] }).required.sort()).toEqual(['content', 'name', 'type'])
  })
})
