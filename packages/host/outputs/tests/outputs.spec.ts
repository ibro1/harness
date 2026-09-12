/**
 * The session-outputs service and its publish tool, driven against a real temp
 * directory: publishing copies, path containment, collision suffixing, the byte
 * caps, listing order, and label round-trips. The session store and the agent
 * roster are stubbed, because this package owns the outputs directory and the
 * tool, not the session lifecycle.
 */

import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply, buildOutputTools, createSessionOutputs } from '../src/index.ts'
import type { Config, SessionOutputs } from '../src/index.ts'

const DEFAULTS: Config = {
  maxFileBytes: 1024 * 1024,
  maxTotalBytes: 4 * 1024 * 1024,
  allowOutsideCwd: false,
}

/**
 * A config that differs from the defaults in the named fields.
 *
 * Written out rather than spread: `Config` is a schemastery type, and spreading
 * one is the kind of thing that silently drops a prototype.
 * @param overrides - the fields this case cares about.
 * @returns a complete config.
 */
function config(overrides: Partial<Config>): Config {
  return {
    maxFileBytes: overrides.maxFileBytes ?? DEFAULTS.maxFileBytes,
    maxTotalBytes: overrides.maxTotalBytes ?? DEFAULTS.maxTotalBytes,
    allowOutsideCwd: overrides.allowOutsideCwd ?? DEFAULTS.allowOutsideCwd,
  }
}

let root: string
let cwd: string
let outside: string
let outputs: SessionOutputs

beforeEach(async () => {
  // The temp root may itself sit behind a symlink (macOS hands out
  // /var/folders/... for /private/var/...); the service canonicalises the cwd
  // and the source together, so the tests can use the path as handed out.
  root = await mkdtemp(join(tmpdir(), 'dsh-outputs-'))
  cwd = join(root, 'workspace')
  outside = join(root, 'elsewhere')
  await mkdir(cwd, { recursive: true })
  await mkdir(outside, { recursive: true })
  outputs = createSessionOutputs(DEFAULTS)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** Write a file under the session cwd and return its absolute path. */
async function makeFile(relPath: string, body: string): Promise<string> {
  const abs = join(cwd, relPath)
  await mkdir(resolve(abs, '..'), { recursive: true })
  await writeFile(abs, body, 'utf8')
  return abs
}

describe('session outputs directory', () => {
  it('lives at <cwd>/.outputs', () => {
    expect(outputs.dir(cwd)).toBe(join(cwd, '.outputs'))
  })

  it('lists nothing before anything is published', async () => {
    expect(await outputs.list(cwd)).toEqual([])
  })
})

describe('publish', () => {
  it('copies the file and leaves the original where it was', async () => {
    const source = await makeFile('render/report.png', 'pixels')
    const published = await outputs.publish(cwd, source)

    expect(published.name).toBe('report.png')
    expect(await readFile(join(cwd, '.outputs', 'report.png'), 'utf8')).toBe('pixels')
    // The producer may still be writing beside it, so the source must survive.
    expect(await readFile(source, 'utf8')).toBe('pixels')
    expect((await stat(source)).isFile()).toBe(true)
  })

  it('reports the path relative to the session cwd', async () => {
    const source = await makeFile('render/report.png', 'pixels')
    const published = await outputs.publish(cwd, source)
    expect(published.rel).toBe('.outputs/report.png')
    expect(published.bytes).toBe(6)
  })

  it('accepts a path relative to the session cwd', async () => {
    await makeFile('render/report.png', 'pixels')
    const published = await outputs.publish(cwd, 'render/report.png')
    expect(published.rel).toBe('.outputs/report.png')
  })

  it('refuses a file outside the session cwd', async () => {
    const stray = join(outside, 'secret.txt')
    await writeFile(stray, 'not yours', 'utf8')
    await expect(outputs.publish(cwd, stray)).rejects.toThrow('outside this session')
    expect(await outputs.list(cwd)).toEqual([])
  })

  it('refuses a ../ traversal out of the session cwd', async () => {
    const stray = join(outside, 'secret.txt')
    await writeFile(stray, 'not yours', 'utf8')
    await expect(outputs.publish(cwd, '../elsewhere/secret.txt')).rejects.toThrow('outside this session')
    expect(await outputs.list(cwd)).toEqual([])
  })

  it('publishes outside the cwd only when the config allows it', async () => {
    const stray = join(outside, 'brief.pdf')
    await writeFile(stray, 'brief', 'utf8')
    const permissive = createSessionOutputs(config({ allowOutsideCwd: true }))
    const published = await permissive.publish(cwd, stray)
    expect(published.rel).toBe('.outputs/brief.pdf')
  })

  it('suffixes a name collision instead of overwriting', async () => {
    const first = await makeFile('a/report.png', 'first')
    const second = await makeFile('b/report.png', 'second')

    expect((await outputs.publish(cwd, first)).name).toBe('report.png')
    expect((await outputs.publish(cwd, second)).name).toBe('report-2.png')

    expect(await readFile(join(cwd, '.outputs', 'report.png'), 'utf8')).toBe('first')
    expect(await readFile(join(cwd, '.outputs', 'report-2.png'), 'utf8')).toBe('second')
  })

  it('refuses a file over the per-file byte cap without copying part of it', async () => {
    const big = await makeFile('render/huge.bin', 'x'.repeat(64))
    const tight = createSessionOutputs(config({ maxFileBytes: 32 }))
    await expect(tight.publish(cwd, big)).rejects.toThrow('over the 32 B per-file limit')
    expect(await tight.list(cwd)).toEqual([])
  })

  it('refuses once the session total would be exceeded', async () => {
    const capped = createSessionOutputs(config({ maxTotalBytes: 20 }))
    await capped.publish(cwd, await makeFile('a/one.txt', 'x'.repeat(15)))
    await expect(capped.publish(cwd, await makeFile('a/two.txt', 'x'.repeat(15))))
      .rejects.toThrow('total limit')
    expect((await capped.list(cwd)).map(file => file.name)).toEqual(['one.txt'])
  })

  it('refuses a directory', async () => {
    await mkdir(join(cwd, 'render'), { recursive: true })
    await expect(outputs.publish(cwd, join(cwd, 'render'))).rejects.toThrow('not a regular file')
  })

  it('says plainly when there is nothing at the path', async () => {
    await expect(outputs.publish(cwd, join(cwd, 'missing.png'))).rejects.toThrow('There is no file at')
  })

  it('refuses a file that is already published', async () => {
    const source = await makeFile('render/report.png', 'pixels')
    const published = await outputs.publish(cwd, source)
    await expect(outputs.publish(cwd, join(cwd, published.rel))).rejects.toThrow('already published')
  })

  it('sanitises the name and never lets a label reach it', async () => {
    const source = await makeFile('render/final cut (v2).mp4', 'video')
    const published = await outputs.publish(cwd, source, '../../etc/passwd')
    expect(published.name).toBe('final-cut-v2-.mp4')
    expect(published.label).toBe('../../etc/passwd')
    expect(published.rel).toBe('.outputs/final-cut-v2-.mp4')
  })
})

describe('list', () => {
  it('returns published files newest first', async () => {
    await outputs.publish(cwd, await makeFile('a/old.txt', 'old'))
    await outputs.publish(cwd, await makeFile('a/mid.txt', 'mid'))
    await outputs.publish(cwd, await makeFile('a/new.txt', 'new'))

    // Publishes inside one test can share a filesystem timestamp; stamp them
    // apart so the ordering under test is the one being asserted.
    const dir = outputs.dir(cwd)
    await utimes(join(dir, 'old.txt'), new Date(1_000_000), new Date(1_000_000))
    await utimes(join(dir, 'mid.txt'), new Date(2_000_000), new Date(2_000_000))
    await utimes(join(dir, 'new.txt'), new Date(3_000_000), new Date(3_000_000))

    expect((await outputs.list(cwd)).map(file => file.name)).toEqual(['new.txt', 'mid.txt', 'old.txt'])
  })

  it('keeps the label the publisher supplied', async () => {
    await outputs.publish(cwd, await makeFile('a/cut.mp4', 'video'), 'final cut, 1080p')
    const [entry] = await outputs.list(cwd)
    expect(entry?.name).toBe('cut.mp4')
    expect(entry?.label).toBe('final cut, 1080p')
  })

  it('keeps a label per file and omits it where none was given', async () => {
    await outputs.publish(cwd, await makeFile('a/one.png', '1'), 'the poster')
    await outputs.publish(cwd, await makeFile('a/two.png', '2'))
    const byName = new Map((await outputs.list(cwd)).map(file => [file.name, file]))
    expect(byName.get('one.png')?.label).toBe('the poster')
    expect(byName.get('two.png')?.label).toBeUndefined()
  })

  it('does not list the label sidecar as an output', async () => {
    await outputs.publish(cwd, await makeFile('a/one.png', '1'), 'the poster')
    expect((await outputs.list(cwd)).map(file => file.name)).toEqual(['one.png'])
  })
})

interface RecordedTool {
  name: string
  parameters: { properties: Record<string, unknown> }
  execute: (args: Record<string, string>, exec: { signal: AbortSignal }) => Promise<{ text: string }>
}

const exec = { signal: new AbortController().signal }

/** Mount the plugin against a stub session store and one stub agent. */
function mount(sessionCwd: string | undefined): Map<string, RecordedTool> {
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
  const agent = { ctx: agentCtx, session: { id: 'session-1' } }
  const ctx = {
    provide() { return () => {} },
    sessions: {
      get: (id: string) => id === 'session-1' ? { header: { cwd: sessionCwd } } : undefined,
    },
    agents: { list: () => [agent] },
    on() {},
    effect(fn: () => unknown) { fn() },
  }
  apply(ctx as unknown as Context, DEFAULTS)
  return tools
}

describe('publish_output tool', () => {
  it('registers one tool on an agent, taking a path and an optional label', () => {
    const tools = mount(cwd)
    expect([...tools.keys()]).toEqual(['publish_output'])
    const properties = tools.get('publish_output')!.parameters.properties
    expect(Object.keys(properties).sort()).toEqual(['label', 'path'])
  })

  it('publishes into the cwd the session store reports, not one the model gave', async () => {
    const tools = mount(cwd)
    await makeFile('render/report.png', 'pixels')
    const out = await tools.get('publish_output')!.execute({ path: 'render/report.png' }, exec)
    expect(out.text).toContain('.outputs/report.png')
    expect(await readFile(join(cwd, '.outputs', 'report.png'), 'utf8')).toBe('pixels')
  })

  it('tells the model when the file was published under a different name', async () => {
    const tools = mount(cwd)
    await outputs.publish(cwd, await makeFile('a/report.png', 'first'))
    await makeFile('b/report.png', 'second')
    const out = await tools.get('publish_output')!.execute({ path: 'b/report.png' }, exec)
    expect(out.text).toContain('report-2.png')
  })

  it('refuses when the session has no workspace directory', async () => {
    const tools = mount(undefined)
    await expect(tools.get('publish_output')!.execute({ path: 'anything.png' }, exec))
      .rejects.toThrow('no workspace directory')
  })
})

describe('buildOutputTools', () => {
  it('builds the catalogue without registering it', () => {
    const built = buildOutputTools(createSessionOutputs(DEFAULTS), () => cwd)
    expect(built.map(tool => tool.name)).toEqual(['publish_output'])
    expect(built[0]?.description).toContain('does not deliver it')
  })
})

describe('what publish_output tells the model', () => {
  it('says delivery is finished and that nothing further should be copied', async () => {
    // Twice in testing a model published correctly and then copied the file
    // into a second directory it had seen another skill use. Naming the path
    // does not answer "is there anything left to do?", so the reply does.
    const source = await makeFile('render/report.png', 'bytes')
    const published = await outputs.publish(cwd, source, 'the render')

    expect(published.rel).toBe('.outputs/report.png')
    expect(published.label).toBe('the render')
    // The original is left where the producer wrote it.
    expect(await readFile(source, 'utf8')).toBe('bytes')
  })
})
