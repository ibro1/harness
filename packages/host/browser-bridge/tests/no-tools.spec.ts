/**
 * The bridge mounts at the host root, beside the webserver, where the agent's
 * `tools` service does not exist. Its upgrade route must not depend on that
 * service: an unsatisfied injection leaves the whole plugin inactive, and the
 * only symptom is a 502 on the WebSocket handshake.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { WebSocket } from 'ws'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import BrowserBridge from '../src/index.ts'

it('serves the upgrade route with no tools service present', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-no-tools-'))
  const configPath = join(root, 'cordis.yml')
  // Deliberately no tools row: this is the host root as production composes it.
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 19791',
    '    authenticate: false',
    "- name: '@deepseek-ai/dsh-host-browser-bridge'",
    '  config:',
    "    path: '/browser-bridge'",
    "    token: 'a-token'",
    '',
  ].join('\n'))

  const context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', HttpServer],
    ['@deepseek-ai/dsh-host-browser-bridge', BrowserBridge],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await context.loader.await()

  const socket = new WebSocket('ws://127.0.0.1:19791/browser-bridge?token=a-token')
  const outcome = await Promise.race([
    once(socket, 'open').then(() => 'open' as const),
    once(socket, 'error').then(([e]) => `error: ${(e as Error).message}` as const),
  ])
  expect(outcome).toBe('open')

  socket.close()
  await context.fiber.dispose()
  await rm(root, { recursive: true, force: true })
})
