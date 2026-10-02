/**
 * The PSD tools against a stand-in Photopea: argument checks, the scripts they
 * post, where results land, and how Photopea's answers reach the model. No test
 * starts a browser; the engine seam stands in for Photopea.
 */

import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { buildPsdTools, checkEdits, dataUrl, describeDoc, workspacePath } from '../src/index.ts'
import type { Config, DocInfo, PhotopeaEngine, PhotopeaJob } from '../src/index.ts'
import { customScripts, editScripts, INSPECT_MARK, RETRY_MARK } from '../src/scripts.ts'

const exec = { signal: new AbortController().signal } as ToolRunContext
const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'psd-spec-'))
  dirs.push(dir)
  return dir
}

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')

const DOC: DocInfo = {
  name: 'post.psd',
  width: 1080,
  height: 1350,
  resolution: 72,
  layers: [
    { ref: '@0', path: 'Copy', name: 'Copy', kind: 'group', visible: true, opacity: 100, bounds: [0, 0, 0, 0] },
    {
      ref: '@0/0', path: 'Copy/Headline', name: 'Headline', kind: 'text', visible: true, opacity: 100, bounds: [80, 900, 1000, 1010],
      text: { contents: 'Old\rheadline', font: 'MyriadPro-Bold', size: 64, color: 'A9241E', fontMissing: true },
    },
    { ref: '@1', path: 'Photo', name: 'Photo', kind: 'smartobject', visible: false, opacity: 80, bounds: [100, 100, 980, 600] },
  ],
}

/** A Photopea stand-in that records jobs and answers with an inspection and files. */
type Answer = { echoes: string[]; files: Uint8Array[] }

function fakeEngine(answer: (job: PhotopeaJob) => Answer): PhotopeaEngine & { jobs: PhotopeaJob[] } {
  const jobs: PhotopeaJob[] = []
  return {
    jobs,
    run(job) {
      jobs.push(job)
      return Promise.resolve(answer(job))
    },
    close: () => Promise.resolve(),
  }
}

/** The shipped defaults, spelled out. */
const CONFIG: Config = {
  browserPath: '',
  photopeaUrl: 'https://www.photopea.com',
  loadTimeoutMs: 90_000,
  stepTimeoutMs: 120_000,
  idleCloseMs: 300_000,
  maxFileBytes: 200_000_000,
  previewMaxPx: 1600,
  maxLayersListed: 300,
  fallbackDir: '.outputs',
}

const inspected = (doc: DocInfo = DOC): string => `${INSPECT_MARK}${JSON.stringify(doc)}`

function tools(cwd: string, engine: PhotopeaEngine): Map<string, ToolDefinition> {
  const built = buildPsdTools(CONFIG, { engine, resolveCwd: () => cwd })
  return new Map(built.map(t => [t.name, t]))
}

type Result = { text: string; files: { location: string }[] }

async function call(map: Map<string, ToolDefinition>, name: string, args: Record<string, unknown>): Promise<Result> {
  const tool = map.get(name)
  if (tool === undefined) throw new Error(`no tool ${name}`)
  return await tool.execute(args, exec) as Result
}

describe('edit checks', () => {
  it('names every invalid edit and changes nothing', () => {
    expect(() => checkEdits([
      { op: 'text', layer: 'Headline' },
      { op: 'opacity', layer: 'Photo', opacity: 140 },
      { op: 'image', layer: 'Photo' },
      { op: 'spin', layer: 'Photo' },
    ])).toThrow(/edit 1[\s\S]*edit 2[\s\S]*edit 3[\s\S]*edit 4/u)
  })

  it('collects picture paths in edit order and normalises colours', () => {
    const { edits, images } = checkEdits([
      { op: 'image', layer: 'Photo', image: 'a.png' },
      { op: 'text', layer: 'Headline', color: '#a9241e' },
      { op: 'image', layer: 'Logo', image: 'b.jpg', fit: 'contain' },
    ])
    expect(images).toEqual(['a.png', 'b.jpg'])
    expect(edits[1]?.color).toBe('A9241E')
    expect(edits[0]?.fit).toBe('cover')
    expect(edits[2]?.fit).toBe('contain')
  })
})

describe('scripts', () => {
  it('embeds model text as JSON string literals', () => {
    const name = 'Head"); app.documents[0].close(); ("'
    const [script] = editScripts([{ op: 'visible', layer: name, visible: false }], 'psd', 0.9, 800)
    expect(script).toContain(JSON.stringify(name))
  })

  it('handles a placed picture in a later script that asks to be posted again until the picture has loaded', () => {
    const scripts = editScripts([
      { op: 'text', layer: 'Headline', text: 'New' },
      { op: 'image', layer: 'Photo', imageData: 'data:image/png;base64,AA==', fit: 'cover' },
      { op: 'visible', layer: 'Badge', visible: false },
    ], 'psd', 0.9, 800)
    // edits up to the picture, the placed picture and the edits after it, then saving
    expect(scripts).toHaveLength(3)
    expect(scripts[0]).toContain('app.open(')
    expect(scripts[1]).toContain(RETRY_MARK)
    expect(scripts[1]).toContain('Badge')
    expect(scripts[2]).toContain('saveToOE("psd")')
  })

  it('refuses a raw script that does not parse before posting anything', () => {
    expect(() => customScripts('var x = ;', undefined, 'psd', 0.9, 800)).toThrow(/does not parse/u)
  })
})

describe('pictures', () => {
  it('reads the type from the first bytes, not the name', () => {
    expect(dataUrl(new Uint8Array(PNG), 'photo.jpg')).toMatch(/^data:image\/png;base64,/u)
    expect(dataUrl(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), 'photo.png')).toMatch(/^data:image\/jpeg;/u)
    expect(() => dataUrl(new Uint8Array(Buffer.from('<svg/>')), 'logo.png')).toThrow(/not a PNG, JPEG, WebP or GIF/u)
  })
})

describe('workspace paths', () => {
  it('refuses a file outside the session workspace, through a symlink too', async () => {
    const cwd = await workspace()
    const outside = await workspace()
    await writeFile(join(outside, 'secret.psd'), 'x')
    await symlink(join(outside, 'secret.psd'), join(cwd, 'link.psd'))
    await expect(workspacePath(cwd, join(outside, 'secret.psd'))).rejects.toThrow(/outside the session workspace/u)
    await expect(workspacePath(cwd, 'link.psd')).rejects.toThrow(/outside the session workspace/u)
    await expect(workspacePath(cwd, 'missing.psd')).rejects.toThrow(/no such file/u)
  })
})

describe('document description', () => {
  it('lists layers top first with their text and flags missing fonts', () => {
    const text = describeDoc(DOC, 300).join('\n')
    expect(text).toContain('1080 x 1350 px')
    expect(text).toContain('@0/0  "Headline"  text  box 80,900 to 1000,1010  "Old / headline" in MyriadPro-Bold (MISSING) 64pt #A9241E')
    expect(text).toContain('@1  "Photo"  smartobject  hidden  opacity 80')
    expect(text).toMatch(/Fonts Photopea does not have.*MyriadPro-Bold/u)
  })

  it('stops listing at the limit and says how many were left out', () => {
    const many: DocInfo = { ...DOC, layers: Array.from({ length: 12 }, (_, i) => ({ ref: `@${String(i)}`, path: `L${String(i)}`, name: `L${String(i)}`, kind: 'normal', visible: true, opacity: 100, bounds: [0, 0, 1, 1] as [number, number, number, number] })) }
    expect(describeDoc(many, 10).join('\n')).toContain('2 more layers not listed')
  })
})

describe('psd tools', () => {
  it('psd_edit sends the file and pictures, writes a new file and a preview, and leaves the original alone', async () => {
    const cwd = await workspace()
    await writeFile(join(cwd, 'post.psd'), 'original')
    await mkdir(join(cwd, 'img'))
    await writeFile(join(cwd, 'img', 'face.png'), PNG)
    const engine = fakeEngine(() => ({ echoes: [inspected()], files: [new Uint8Array(Buffer.from('edited')), new Uint8Array(PNG)] }))
    const result = await call(tools(cwd, engine), 'psd_edit', {
      path: 'post.psd',
      edits: [{ op: 'text', layer: 'Headline', text: 'New' }, { op: 'image', layer: 'Photo', image: 'img/face.png' }],
    })
    expect(engine.jobs[0]?.documents).toBe(1)
    expect(engine.jobs[0]?.files.map(f => Buffer.from(f).toString())).toEqual(['original'])
    expect(engine.jobs[0]?.scripts.join('\n')).toContain(`data:image/png;base64,${PNG.toString('base64')}`)
    expect(result.files.map(f => f.location)).toEqual([join('.outputs', 'post-edited.psd'), join('.outputs', 'post-edited-preview.png')])
    expect(await readFile(join(cwd, '.outputs', 'post-edited.psd'), 'utf8')).toBe('edited')
    expect(await readFile(join(cwd, 'post.psd'), 'utf8')).toBe('original')
    expect(result.text).toContain('Applied 2 edits.')
    expect(result.text).toContain('Look at the preview')
  })

  it('psd_edit refuses invalid edits without starting Photopea', async () => {
    const cwd = await workspace()
    await writeFile(join(cwd, 'post.psd'), 'original')
    const engine = fakeEngine(() => ({ echoes: [], files: [] }))
    await expect(call(tools(cwd, engine), 'psd_edit', { path: 'post.psd', edits: [{ op: 'move', layer: 'Photo' }] })).rejects.toThrow(/give dx or dy/u)
    expect(engine.jobs).toHaveLength(0)
  })

  it('psd_open loads font files before the document', async () => {
    const cwd = await workspace()
    await writeFile(join(cwd, 'post.psd'), 'doc')
    await writeFile(join(cwd, 'Brand.otf'), 'font')
    const engine = fakeEngine(() => ({ echoes: [inspected()], files: [new Uint8Array(PNG)] }))
    const result = await call(tools(cwd, engine), 'psd_open', { path: 'post.psd', fonts: ['Brand.otf'] })
    expect(engine.jobs[0]?.files.map(f => Buffer.from(f).toString())).toEqual(['font', 'doc'])
    expect(engine.jobs[0]?.documents).toBe(1)
    expect(result.text).toContain('"Headline"')
    expect(await readdir(join(cwd, '.outputs'))).toEqual(['post-preview.png'])
  })

  it('psd_script without a file needs a size, and creates a blank document with one', async () => {
    const cwd = await workspace()
    const engine = fakeEngine(() => ({ echoes: [inspected(), '__psd_echo__hello'], files: [new Uint8Array(Buffer.from('psd')), new Uint8Array(PNG)] }))
    const map = tools(cwd, engine)
    await expect(call(map, 'psd_script', { script: 'D.flatten();' })).rejects.toThrow(/give width and height/u)
    const result = await call(map, 'psd_script', { script: '__echo("hello")', width: 1080, height: 1350, output: 'story' })
    expect(engine.jobs[0]?.documents).toBe(0)
    expect(engine.jobs[0]?.scripts[0]).toContain('app.documents.add(1080, 1350, 72, "story")')
    expect(result.text).toContain('Script said: hello')
    expect(result.files[0]?.location).toBe(join('.outputs', 'story.psd'))
  })

  it('psd_export writes the requested format under a safe name', async () => {
    const cwd = await workspace()
    await writeFile(join(cwd, 'post.psd'), 'doc')
    const engine = fakeEngine(() => ({ echoes: [inspected({ ...DOC, width: 540, height: 675 })], files: [new Uint8Array(Buffer.from('jpg'))] }))
    const result = await call(tools(cwd, engine), 'psd_export', { path: 'post.psd', format: 'jpg', width: 540, output: '../../etc/x.png' })
    expect(result.files[0]?.location).toBe(join('.outputs', 'x.jpg'))
    expect(result.text).toContain('540 x 675 px')
  })

  it('passes Photopea\'s own error through to the model', async () => {
    const cwd = await workspace()
    await writeFile(join(cwd, 'post.psd'), 'doc')
    const engine: PhotopeaEngine = {
      run: () => Promise.reject(new Error('Photopea: no layer named "Nope"; use psd_open to list the layers')),
      close: () => Promise.resolve(),
    }
    await expect(call(tools(cwd, engine), 'psd_edit', { path: 'post.psd', edits: [{ op: 'visible', layer: 'Nope', visible: false }] }))
      .rejects.toThrow(/no layer named "Nope"/u)
  })
})
