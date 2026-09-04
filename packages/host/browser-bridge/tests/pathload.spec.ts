/**
 * The deploy overlay names this plugin by relative path rather than by package
 * name, because the package is fork-local and unpublished: a profile's pnpm
 * install cannot fetch it, and a bare name resolves to nothing. A skipped row
 * is silent — the upgrade route simply never exists, and the only symptom is a
 * 502 on the WebSocket handshake — so the path form is pinned here.
 *
 * Consumes the built `lib/`, not `src/`, exactly as the overlay does; run after
 * `pnpm run build`.
 */
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import HttpServer from '@deepseek-ai/dsh-host-webserver'

class StubTools extends Service {
  readonly registered: string[] = []
  constructor(ctx: Context) { super(ctx, 'tools') }
  register(d: { name: string }): () => void { this.registered.push(d.name); return () => {} }
}

it('mounts the bridge from a relative path, the way the deploy overlay names it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pathload-'))
  const dir = join(root, 'deploy', 'plugins')
  await mkdir(dir, { recursive: true })
  const configPath = join(dir, 'browser.cordis.yml')

  // The same relative shape the real overlay uses, retargeted at this checkout.
  const built = join(dirname(new URL(import.meta.url).pathname), '..', 'lib', 'index.js')
  const rel = relative(dir, built)
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 19781',
    '    authenticate: false',
    "- name: 'stub-tools'",
    `- name: '${rel}'`,
    '  config:',
    "    path: '/browser-bridge'",
    "    token: 'a-token'",
    '',
  ].join('\n'))

  const context = new Context()
  context.baseUrl = pathToFileURL(dir).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', HttpServer],
    ['stub-tools', StubTools],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      // Anything not stubbed is resolved for real, which is the point.
      if (modules.has(specifier)) return modules.get(specifier)
      return await import(new URL(specifier, context.baseUrl).href) as unknown
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await context.loader.await()

  // The bridge only registers its tools once it has actually mounted.
  const tools = context.get('tools') as unknown as StubTools
  expect(tools.registered).toContain('browser_navigate')
  expect(tools.registered).toHaveLength(6)

  await context.fiber.dispose()
  await rm(root, { recursive: true, force: true })
})
