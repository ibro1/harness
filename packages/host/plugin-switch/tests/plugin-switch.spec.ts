/**
 * The switch file, the status a card reads, and tools refusing while their
 * plugin is off.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { gateTools, isSwitchedOn, saveSwitch, switchStatus } from '../src/index.ts'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function switchPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'plugin-switch-'))
  dirs.push(dir)
  return join(dir, 'nested', 'plugin-switches.json')
}

describe('switch file', () => {
  it('uses the default until a state is saved, and keeps other plugins\' states', async () => {
    const path = await switchPath()
    expect(isSwitchedOn('psd-tools', true, path)).toBe(true)
    saveSwitch('psd-tools', false, path)
    saveSwitch('capture', true, path)
    expect(isSwitchedOn('psd-tools', true, path)).toBe(false)
    expect(isSwitchedOn('capture', false, path)).toBe(true)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ 'psd-tools': false, capture: true })
  })

  it('falls back to defaults when the file is damaged', async () => {
    const path = await switchPath()
    saveSwitch('outputs', false, path)
    await writeFile(path, '{ not json')
    // Past the read cache, so the damaged file is read.
    await new Promise(resolve => setTimeout(resolve, 1100))
    expect(isSwitchedOn('outputs', true, path)).toBe(true)
  })
})

describe('status', () => {
  it('reports the saved state, the health and whether a test exists', async () => {
    const path = await switchPath()
    saveSwitch('capture', false, path)
    const status = await switchStatus({
      id: 'capture', defaultEnabled: true, health: () => ({ healthy: true, facts: [{ key: 'browser', value: '/usr/bin/chromium' }] }),
      test: () => Promise.resolve({ ok: true, message: 'fine' }),
    }, path)
    expect(status).toEqual({ id: 'capture', enabled: false, canTest: true, healthy: true, facts: [{ key: 'browser', value: '/usr/bin/chromium' }] })
  })

  it('reports a health check that throws as not working, with its message', async () => {
    const path = await switchPath()
    const status = await switchStatus({ id: 'capture', defaultEnabled: true, health: () => { throw new Error('no browser on PATH') } }, path)
    expect(status.healthy).toBe(false)
    expect(status.problem).toBe('no browser on PATH')
  })
})

describe('gated tools', () => {
  it('refuses calls while off and passes them through while on', async () => {
    let on = false
    const [tool] = gateTools([{ name: 'psd_open', execute: (value: number) => Promise.resolve(value * 2) }], () => on, 'PSD tools')
    await expect(tool?.execute(2)).rejects.toThrow(/PSD tools is switched off on the Plugins page/u)
    on = true
    await expect(tool?.execute(2)).resolves.toBe(4)
  })
})
