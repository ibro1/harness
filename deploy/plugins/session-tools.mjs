// Session tools for the CLIs: `publish_output`, `capture_page` and the PSD tools over one
// token-guarded command route, for the agy and opencode CLIs' MCP clients.
//
// Those CLIs run their own agent loop and drop the harness's tools, so a model
// reached through them never sees the two tools a direct-provider agent gets
// from the `outputs` and `capture` plugins. Unlike the Cloudflare or Postgres
// tools, these act on one session's workspace, and a command route has no
// agent to read it from. The CLI's MCP server sends the DSH_SESSION_ID the
// bridge set for the request; this route resolves the directory from the
// session store with it, the same store the agent tools read. A call without a
// live session is refused rather than written anywhere else.
//
// The tool definitions are the plugins' own, so a schema or a safety check
// (capture's address screening, outputs' containment) cannot drift between the
// two paths. `publish_output` is offered only while the `outputs` service is
// mounted; `capture_page` delivers through it when it is, and beside the
// session cwd when it is not, exactly as the agent tool does.
//
// Called by a process inside the container, not the browser, so the route is
// not behind the password gate; the token is its auth. Every connection
// arrives from the socat forwarder on loopback, so the peer address proves
// nothing here, and the token is generated per boot by the entrypoint.

import { createHash, timingSafeEqual } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import { isSwitchedOn, mountSwitch } from '../../packages/host/plugin-switch/lib/index.js'
import { buildOutputTools } from '../../packages/host/outputs/lib/index.js'
import { buildCaptureTools, Config as CaptureConfig, resolveBrowserPath } from '../../packages/host/capture/lib/index.js'
import { buildPsdTools, Config as PsdConfig, createPhotopeaEngine } from '../../packages/host/psd-tools/lib/index.js'

export const name = 'session-tools'
export const inject = ['webServer', 'sessions']

export const Config = z.object({
  path: z.string().default('/session-tools'),
  token: z.string().default(''),
  capture: z.boolean().default(true),
  psd: z.boolean().default(true),
})

/** Largest command body accepted: a tool call's arguments, never a file. */
const MAX_COMMAND_BODY_BYTES = 64 * 1024

/** @param {string} message - one line for the container log. */
function announce(message) { process.stderr.write(`session-tools: ${message}\n`) }

/** Compare two secrets in constant time, whatever their lengths. */
function secretEquals(a, b) {
  const digest = value => createHash('sha256').update(value).digest()
  return timingSafeEqual(digest(a), digest(b))
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** Read the request body, or undefined when it exceeds the limit. */
async function readBody(req, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) return undefined
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export function apply(ctx, config) {
  // Mounted before the token check, so the Plugins page can say the route is missing its token.
  const toggle = mountSwitch(ctx, {
    id: 'session-tools',
    defaultEnabled: true,
    health: () => config.token === ''
      ? { healthy: false, facts: [{ key: 'token', flag: false }], problem: 'No token was generated for this route at boot, so the CLIs cannot reach it.' }
      : { healthy: true, facts: [{ key: 'token', flag: true }, { key: 'route', value: `${config.path}/command` }, { key: 'tools', value: toolsFor(() => '').map(t => t.name).join(', ') }] },
  })
  if (config.token === '') {
    announce('no token configured — route not mounted')
    return
  }

  // Read per call: another plugin provides it, and it may mount later.
  const readOutputs = () => {
    const service = ctx.get('outputs')
    return service !== undefined && typeof service.publish === 'function' ? service : undefined
  }
  const captureConfig = CaptureConfig({})
  // One Photopea browser for every CLI call, closed when idle and on dispose.
  const psdConfig = PsdConfig({})
  const psdEngine = createPhotopeaEngine({
    resolveBrowser: () => resolveBrowserPath(psdConfig.browserPath),
    photopeaUrl: psdConfig.photopeaUrl,
    loadTimeoutMs: psdConfig.loadTimeoutMs,
    stepTimeoutMs: psdConfig.stepTimeoutMs,
    idleCloseMs: psdConfig.idleCloseMs,
  })
  ctx.effect(() => () => { void psdEngine.close() }, 'session-tools: Photopea browser')

  /**
   * The session's working directory, from the session store only.
   * @param {unknown} session - the id the CLI's MCP server sent.
   * @returns {string} the absolute cwd.
   */
  const sessionCwd = (session) => {
    if (typeof session !== 'string' || session === '') {
      throw new Error('This tool acts on a session workspace, and the call named no session. It works only inside a harness session.')
    }
    const cwd = ctx.sessions.get(session)?.header?.cwd
    if (typeof cwd !== 'string' || cwd === '') {
      throw new Error(`Session ${session} is not live in the harness or has no workspace directory, so there is nowhere to deliver to.`)
    }
    return cwd
  }

  /**
   * The tools this route serves, bound to one call's session.
   * @param {() => string} resolveCwd - reads that session's cwd.
   * @returns {Array<object>} the tool definitions.
   */
  const toolsFor = (resolveCwd) => {
    const outputs = readOutputs()
    // Each plugin's own switch on the Plugins page applies here too.
    return [
      ...(outputs === undefined || !isSwitchedOn('outputs', true) ? [] : buildOutputTools(outputs, resolveCwd)),
      ...(config.capture && isSwitchedOn('capture', true) ? buildCaptureTools(captureConfig, { readOutputs, resolveCwd: () => resolveCwd() }) : []),
      ...(config.psd && isSwitchedOn('psd-tools', true) ? buildPsdTools(psdConfig, { engine: psdEngine, readOutputs, resolveCwd: () => resolveCwd() }) : []),
    ]
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${config.path}/command`,
    authenticate: false,
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://x')
      const header = req.headers.authorization ?? ''
      const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : url.searchParams.get('token') ?? ''
      if (!secretEquals(presented, config.token)) {
        res.writeHead(404)
        res.end()
        return
      }
      if (!toggle.isOn()) {
        // Switched off on the Plugins page: the CLI lists no tools and every call is refused.
        if (req.method === 'GET') json(res, 200, { tools: [] })
        else json(res, 200, { error: 'Session tools for the CLIs is switched off on the Plugins page; ask the owner to switch it on.' })
        return
      }
      if (req.method === 'GET') {
        const listed = toolsFor(() => { throw new Error('catalogue only') })
        json(res, 200, { tools: listed.map(t => ({ name: t.name, description: t.description, parameters: t.parameters })) })
        return
      }
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Allow': 'GET, POST' })
        res.end()
        return
      }
      const body = await readBody(req, MAX_COMMAND_BODY_BYTES)
      if (body === undefined) { json(res, 413, { error: 'the command body is too large' }); return }
      let request
      try {
        request = JSON.parse(body)
      } catch {
        json(res, 400, { error: 'the command body is not JSON' })
        return
      }
      // Resolved before the tool runs, so a call with no live session is refused
      // before a capture launches a browser for a file with nowhere to go.
      let cwd
      try {
        cwd = sessionCwd(request.session)
      } catch (error) {
        json(res, 200, { error: error instanceof Error ? error.message : String(error) })
        return
      }
      const tool = toolsFor(() => cwd).find(t => t.name === request.name)
      if (tool === undefined) { json(res, 400, { error: `no such tool: ${String(request.name)}` }); return }
      // A capture can run for a minute and a half; stop it if the CLI goes away.
      const abort = new AbortController()
      res.on('close', () => { if (!res.writableEnded) abort.abort() })
      try {
        const args = typeof request.args === 'object' && request.args !== null ? request.args : {}
        const result = await tool.execute(args, { signal: abort.signal })
        json(res, 200, { result })
      } catch (error) {
        // A refused URL or a missing session is the answer the model reads.
        json(res, 200, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), `session-tools: ${config.path}/command`)
  announce(`command route ${config.path}/command (token)`)
}
