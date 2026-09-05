/**
 * The Dokploy tools, driven against a stub HTTP server standing in for a real
 * Dokploy: tool registration on an agent, server resolution by name, the
 * project listing, and a deploy round-trip. The settings service and the agent
 * roster are stubbed, because this package owns the tools and the API calls,
 * not the settings store or the agent lifecycle.
 */

import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.ts'

interface RecordedTool {
  name: string
  execute: (args: Record<string, unknown>, exec: { signal: AbortSignal }) => Promise<{ text: string }>
}

let server: Server | undefined

afterEach(async () => {
  if (server !== undefined) {
    await new Promise<void>(resolve => server?.close(() => { resolve() }))
    server = undefined
  }
})

/** A Dokploy stand-in answering the two endpoints the tools call. */
async function stubDokploy(handler: (endpoint: string, body: string) => { status?: number; json: unknown }): Promise<string> {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    req.on('end', () => {
      const endpoint = (req.url ?? '').replace(/^\/api\//u, '')
      const { status, json } = handler(endpoint, body)
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

/**
 * Mount the plugin against a stub settings roster and a single stub agent, and
 * return that agent's registered tools by name.
 */
function mount(servers: { name: string; url: string; apiKeyEnv: string }[]): Map<string, RecordedTool> {
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
        return { get: () => ({ servers }), watch: () => () => {}, patch: () => Promise.resolve() }
      },
    },
    agents: { list: () => [{ ctx: agentCtx }] },
    on() {},
    effect(fn: () => unknown) { fn() },
  }
  apply(ctx as unknown as Context, { timeoutMs: 5000, path: '/dokploy', token: '' })
  return tools
}

process.env.DOKPLOY_KEY_TEST = 'the-real-key'
const exec = { signal: new AbortController().signal }

describe('dokploy tools', () => {
  it('registers the four tools on an agent', () => {
    const tools = mount([])
    expect([...tools.keys()].sort()).toEqual(['dokploy_deploy', 'dokploy_projects', 'dokploy_servers', 'dokploy_status'])
  })

  it('lists configured servers without revealing keys', async () => {
    const tools = mount([{ name: 'prod', url: 'https://d.example', apiKeyEnv: 'DOKPLOY_KEY_TEST' }])
    const out = await tools.get('dokploy_servers')!.execute({}, exec)
    expect(out.text).toContain('prod')
    expect(out.text).toContain('https://d.example')
    expect(out.text).not.toContain('the-real-key')
  })

  it('refuses to guess when several servers are configured', async () => {
    const tools = mount([
      { name: 'prod', url: 'https://a', apiKeyEnv: 'DOKPLOY_KEY_TEST' },
      { name: 'staging', url: 'https://b', apiKeyEnv: 'DOKPLOY_KEY_TEST' },
    ])
    await expect(tools.get('dokploy_projects')!.execute({}, exec))
      .rejects.toThrow('Several Dokploy servers are configured (prod, staging); pass server to choose one')
  })

  it('reports an unknown server name with the ones that exist', async () => {
    const tools = mount([{ name: 'prod', url: 'https://a', apiKeyEnv: 'DOKPLOY_KEY_TEST' }])
    await expect(tools.get('dokploy_projects')!.execute({ server: 'nope' }, exec))
      .rejects.toThrow('No Dokploy server named "nope"; configured: prod')
  })

  it('lists projects and their applications from the API', async () => {
    const seen: { key?: string } = {}
    const url = await stubDokploy((endpoint, _body) => {
      if (endpoint === 'project.all') {
        return { json: [{ projectId: 'p1', name: 'Site', applications: [{ applicationId: 'a1', name: 'web', applicationStatus: 'done' }] }] }
      }
      return { status: 404, json: { message: 'not found' } }
    })
    const tools = mount([{ name: 'prod', url, apiKeyEnv: 'DOKPLOY_KEY_TEST' }])
    const out = await tools.get('dokploy_projects')!.execute({}, exec)
    expect(out.text).toContain('Site')
    expect(out.text).toContain('web')
    expect(out.text).toContain('a1')
    expect(out.text).toContain('done')
    void seen
  })

  it('lists applications nested under environments, the real Dokploy shape', async () => {
    const url = await stubDokploy((endpoint) => {
      if (endpoint === 'project.all') {
        return { json: [{
          projectId: 'p1',
          name: 'databes local dev',
          environments: [{
            name: 'production',
            applications: [
              { applicationId: 'KMf5', name: 'docku', applicationStatus: 'idle' },
              { applicationId: 'h1UC', name: 'chbox', applicationStatus: 'done' },
            ],
            compose: [{ composeId: 'c1', name: 'stack', composeStatus: 'done' }],
          }],
        }] }
      }
      return { status: 404, json: {} }
    })
    const tools = mount([{ name: 'main', url, apiKeyEnv: 'DOKPLOY_KEY_TEST' }])
    const out = await tools.get('dokploy_projects')!.execute({}, exec)
    expect(out.text).toContain('docku')
    expect(out.text).toContain('KMf5')
    expect(out.text).toContain('chbox')
    expect(out.text).toContain('done')
    expect(out.text).toContain('stack')
    expect(out.text).not.toContain('(no applications)')
  })

  it('sends the api key and the application id on a deploy', async () => {
    let receivedKey = ''
    let receivedBody = ''
    const url = await stubDokploy((endpoint, body) => {
      if (endpoint === 'application.deploy') { receivedBody = body; return { json: { ok: true } } }
      return { status: 404, json: {} }
    })
    // Capture the header by wrapping the handler is awkward; assert via a second stub.
    server?.on('request', (req) => { receivedKey = String(req.headers['x-api-key'] ?? '') })
    const tools = mount([{ name: 'prod', url, apiKeyEnv: 'DOKPLOY_KEY_TEST' }])
    const out = await tools.get('dokploy_deploy')!.execute({ applicationId: 'a1' }, exec)
    expect(out.text).toContain('Started a deployment of application a1 on prod')
    expect(receivedBody).toContain('a1')
    expect(receivedKey).toBe('the-real-key')
  })

  it('uses an inline apiKey when no apiKeyEnv is named', async () => {
    let receivedKey = ''
    const url = await stubDokploy(() => ({ json: [] }))
    server?.on('request', (req) => { receivedKey = String(req.headers['x-api-key'] ?? '') })
    // No apiKeyEnv; the key is inline. mount()'s fixture uses apiKeyEnv, so build
    // a server object directly here.
    const tools = (() => {
      const map = new Map<string, RecordedTool>()
      const agentCtx = {
        inject(_n: string[], fn: (s: unknown) => void) {
          fn({
            effect: (f: () => unknown) => f(),
            tools: { register(t: RecordedTool) { map.set(t.name, t); return () => {} } },
          })
          return { dispose: () => Promise.resolve() }
        },
      }
      const ctx = {
        settings: { register: () => ({ get: () => ({ servers: [{ name: 'main', url, apiKey: 'inline-key' }] }), watch: () => () => {}, patch: () => Promise.resolve() }) },
        agents: { list: () => [{ ctx: agentCtx }] }, on() {}, effect(f: () => unknown) { f() },
      }
      apply(ctx as unknown as Context, { timeoutMs: 5000, path: '/dokploy', token: '' })
      return map
    })()
    await tools.get('dokploy_projects')!.execute({}, exec)
    expect(receivedKey).toBe('inline-key')
  })

  it('surfaces a Dokploy error status as the tool failing', async () => {
    const url = await stubDokploy(() => ({ status: 401, json: { message: 'Unauthorized' } }))
    const tools = mount([{ name: 'prod', url, apiKeyEnv: 'DOKPLOY_KEY_TEST' }])
    await expect(tools.get('dokploy_projects')!.execute({}, exec))
      .rejects.toThrow('answered 401')
  })
})


describe('dokploy MCP surface', () => {
  it('builds a catalogue of the four tools with their schemas', async () => {
    const { buildDokployTools } = await import('../src/index.ts')
    const tools = buildDokployTools(() => [{ name: 'main', url: 'https://x', apiKeyEnv: 'K' }], 5000)
    expect(tools.map(t => t.name)).toEqual(['dokploy_servers', 'dokploy_projects', 'dokploy_deploy', 'dokploy_status'])
    const deploy = tools.find(t => t.name === 'dokploy_deploy')
    expect((deploy?.parameters as { properties: object }).properties).toHaveProperty('applicationId')
  })
})
