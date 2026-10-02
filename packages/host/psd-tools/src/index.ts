/**
 * PSD tools: open, edit and export Photoshop files through Photopea running in
 * the harness's own headless Chromium.
 *
 * No library both edits a PSD and redraws it: `ag-psd` and its kind read and
 * write layers but cannot re-render changed text, so a changed headline would
 * keep its old pixels. Photopea is a full editor with a script interface, so it
 * changes text, swaps pictures and draws the result the way Photoshop would.
 *
 * Files come from, and go to, the session's workspace: a path must sit inside
 * the session cwd, and every result (the edited file and a preview PNG) is
 * delivered through the `outputs` capability when it is mounted. The preview is
 * how the model sees its work, so every change returns one.
 *
 * @module @deepseek-ai/dsh-host-psd-tools
 */

import { readFile, realpath, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolRunContext, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import { deliverFile, isOutputsCapability, resolveBrowserPath } from '@deepseek-ai/dsh-host-capture'
import type { ImageRecord, OutputsCapability } from '@deepseek-ai/dsh-host-capture'
import { createPhotopeaEngine } from './photopea.ts'
import type { PhotopeaEngine } from './photopea.ts'
import { customScripts, ECHO_MARK, editScripts, exportScript, INSPECT_MARK, inspectScript, wrapScript } from './scripts.ts'
import { gateTools, mountSwitch } from '@deepseek-ai/dsh-host-plugin-switch'
import type { DocInfo, ExportFormat, LayerInfo, PsdEdit } from './scripts.ts'

export { createPhotopeaEngine } from './photopea.ts'
export type { PhotopeaEngine, PhotopeaJob, PhotopeaResult } from './photopea.ts'
export type { DocInfo, LayerInfo, PsdEdit } from './scripts.ts'

/** The plugin name, for the Loader. */
export const name = 'psd-tools'

/** The services this plugin reads. `outputs` is optional and read per call. */
export const inject = ['agents']

/** Composition config. */
export interface Config {
  /** Explicit browser path; empty searches PATH the way the capture plugin does. */
  browserPath: string
  /** Photopea's address. */
  photopeaUrl: string
  /** Longest wait for Photopea to load, in milliseconds. */
  loadTimeoutMs: number
  /** Longest wait for one opened file or script, in milliseconds. */
  stepTimeoutMs: number
  /** Close the browser after this long without a call, in milliseconds. */
  idleCloseMs: number
  /** Largest file a call may open, in bytes. */
  maxFileBytes: number
  /** Longest side of a preview PNG, in pixels. */
  previewMaxPx: number
  /** Most layers one result lists. */
  maxLayersListed: number
  /** Directory under the session cwd that receives files when no `outputs` capability is mounted. */
  fallbackDir: string
}

/** Composition config. */
export const Config: z<Config> = z.object({
  browserPath: z.string().default(''),
  photopeaUrl: z.string().default('https://www.photopea.com'),
  loadTimeoutMs: z.natural().min(5000).default(90_000),
  stepTimeoutMs: z.natural().min(5000).default(120_000),
  idleCloseMs: z.natural().min(10_000).default(300_000),
  maxFileBytes: z.natural().min(1_000_000).default(200_000_000),
  previewMaxPx: z.natural().min(200).default(1600),
  maxLayersListed: z.natural().min(10).default(300),
  fallbackDir: z.string().default('.outputs'),
})

/** What the tools need from outside; every field has a real default. */
export interface PsdDeps {
  /** Photopea. Tests pass a stand-in. */
  engine?: PhotopeaEngine
  /** Reads the optional `outputs` capability at call time. */
  readOutputs?: () => OutputsCapability | undefined
  /** The session working directory; defaults to the calling agent's. */
  resolveCwd?: (exec: ToolRunContext) => string
}

/** Formats a document can be saved or exported in. */
const FORMATS: readonly ExportFormat[] = ['psd', 'png', 'jpg', 'webp', 'pdf', 'svg']

/** Edit operations, as the model names them. */
const OPS = ['text', 'visible', 'opacity', 'move', 'image', 'delete', 'rename'] as const

/** The value every PSD tool returns. */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string', required: true, description: 'The result summarized for reading.' },
    files: {
      type: 'array',
      required: true,
      description: 'Files written, in order.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          bytes: { type: 'integer', required: true },
          published: { type: 'boolean', required: true },
          location: { type: 'string', required: true, description: 'Path relative to the session cwd.' },
        },
      },
    },
  },
} as const satisfies ValueSchemaSpec

/** A delivered file, as the result lists it. */
interface FileRecord {
  name: string
  bytes: number
  published: boolean
  location: string
}

/** The value of one call. */
interface PsdValue {
  text: string
  files: FileRecord[]
}

/** The model's arguments for one edit. */
interface EditArgs {
  op: string
  layer: string
  text?: string
  font?: string
  size?: number
  color?: string
  visible?: boolean
  opacity?: number
  dx?: number
  dy?: number
  image?: string
  fit?: string
  name?: string
}

/**
 * Resolve a model-given path inside the session cwd.
 * @param cwd - the session working directory.
 * @param path - absolute, or relative to `cwd`.
 * @returns the absolute path, symlinks resolved.
 * @throws when the file is missing or lies outside `cwd`.
 */
export async function workspacePath(cwd: string, path: string): Promise<string> {
  const root = await realpath(cwd)
  let full: string
  try {
    full = await realpath(isAbsolute(path) ? path : resolve(cwd, path))
  } catch (error) {
    throw new Error(`${path}: no such file in the session workspace`, { cause: error })
  }
  if (full !== root && !full.startsWith(root + sep)) throw new Error(`${path} is outside the session workspace; only files in it can be opened`)
  return full
}

/**
 * Validate the model's edits.
 * @param edits - the model's arguments.
 * @returns the edits, and the picture path of each `image` edit in order; the caller fills in `imageData`.
 * @throws naming every invalid edit.
 */
export function checkEdits(edits: readonly EditArgs[]): { edits: PsdEdit[]; images: string[] } {
  const problems: string[] = []
  const images: string[] = []
  const out: PsdEdit[] = []
  if (edits.length === 0) problems.push('give at least one edit')
  edits.forEach((e, i) => {
    const at = `edit ${String(i + 1)} (${e.op} ${JSON.stringify(e.layer)})`
    if (!(OPS as readonly string[]).includes(e.op)) { problems.push(`${at}: op must be one of ${OPS.join(', ')}`); return }
    if (e.layer.trim() === '') problems.push(`${at}: name the layer`)
    const op = e.op as PsdEdit['op']
    const edit: PsdEdit = { op, layer: e.layer }
    switch (op) {
      case 'text':
        if (e.text === undefined && e.font === undefined && e.size === undefined && e.color === undefined) problems.push(`${at}: give text, font, size or color`)
        if (e.size !== undefined && !(e.size > 0 && e.size <= 2000)) problems.push(`${at}: size must be between 0 and 2000`)
        if (e.color !== undefined && !/^#?[0-9a-f]{6}$/iu.test(e.color)) problems.push(`${at}: color must be six hex digits such as A9241E`)
        if (e.text !== undefined) edit.text = e.text
        if (e.font !== undefined) edit.font = e.font
        if (e.size !== undefined) edit.size = e.size
        if (e.color !== undefined) edit.color = e.color.replace('#', '').toUpperCase()
        break
      case 'visible':
        if (e.visible === undefined) problems.push(`${at}: give visible true or false`)
        else edit.visible = e.visible
        break
      case 'opacity':
        if (e.opacity === undefined || !(e.opacity >= 0 && e.opacity <= 100)) problems.push(`${at}: opacity must be 0 to 100`)
        else edit.opacity = e.opacity
        break
      case 'move':
        if ((e.dx ?? 0) === 0 && (e.dy ?? 0) === 0) problems.push(`${at}: give dx or dy in pixels`)
        if (!Number.isFinite(e.dx ?? 0) || !Number.isFinite(e.dy ?? 0)) problems.push(`${at}: dx and dy must be numbers`)
        edit.dx = e.dx ?? 0
        edit.dy = e.dy ?? 0
        break
      case 'image':
        if (e.image === undefined || e.image === '') { problems.push(`${at}: give image, the path of the picture`); break }
        if (e.fit !== undefined && !['cover', 'contain', 'stretch'].includes(e.fit)) problems.push(`${at}: fit must be cover, contain or stretch`)
        images.push(e.image)
        edit.fit = e.fit === 'contain' || e.fit === 'stretch' ? e.fit : 'cover'
        break
      case 'rename':
        if (e.name === undefined || e.name.trim() === '') problems.push(`${at}: give the new name`)
        else edit.name = e.name
        break
      case 'delete':
        break
    }
    out.push(edit)
  })
  if (problems.length > 0) throw new Error(`Nothing was changed:\n- ${problems.join('\n- ')}`)
  return { edits: out, images }
}

/** One layer as a line of the listing, indented by depth. */
function layerLine(l: LayerInfo): string {
  const depth = l.ref.split('/').length - 1
  const [x0, y0, x1, y1] = l.bounds.map(n => Math.round(n))
  const parts = [`${'  '.repeat(depth)}${l.ref}  ${JSON.stringify(l.name)}  ${l.kind}`]
  if (!l.visible) parts.push('hidden')
  if (l.opacity < 100) parts.push(`opacity ${String(Math.round(l.opacity))}`)
  if (l.kind !== 'group' && (x1 ?? 0) - (x0 ?? 0) > 0) parts.push(`box ${String(x0)},${String(y0)} to ${String(x1)},${String(y1)}`)
  if (l.text !== undefined) {
    const shown = l.text.contents.replace(/\r\n?|\n/gu, ' / ')
    parts.push(`${JSON.stringify(shown.length > 120 ? `${shown.slice(0, 120)}...` : shown)} in ${l.text.font}${l.text.fontMissing ? ' (MISSING)' : ''} ${String(Math.round(l.text.size * 10) / 10)}pt #${l.text.color}`)
  }
  return parts.join('  ')
}

/**
 * The document as text: size, layers top first, missing fonts.
 * @param doc - the inspection.
 * @param limit - most layers to list.
 * @returns the lines.
 */
export function describeDoc(doc: DocInfo, limit: number): string[] {
  const lines = [`${doc.name}: ${String(Math.round(doc.width))} x ${String(Math.round(doc.height))} px at ${String(doc.resolution)} ppi, ${String(doc.layers.length)} layers.`]
  if (doc.layers.length > 0) {
    lines.push('Layers, top first (name a layer by its name, its group path such as Promo/Headline, or its @ reference):')
    for (const l of doc.layers.slice(0, limit)) lines.push(layerLine(l))
    if (doc.layers.length > limit) lines.push(`... ${String(doc.layers.length - limit)} more layers not listed`)
  }
  const missing = [...new Set(doc.layers.flatMap(l => l.text?.fontMissing === true ? [l.text.font] : []))]
  if (missing.length > 0) {
    lines.push(`Fonts Photopea does not have, drawn with a substitute: ${missing.join(', ')}. Pass the font file in fonts, or set another font, before exporting.`)
  }
  return lines
}

/** Parse the inspection echo. */
function inspection(echoes: string[]): DocInfo {
  const raw = echoes.find(e => e.startsWith(INSPECT_MARK))
  if (raw === undefined) throw new Error('Photopea returned no description of the document')
  const parsed: unknown = JSON.parse(raw.slice(INSPECT_MARK.length))
  if (typeof parsed !== 'object' || parsed === null || !('layers' in parsed) || !Array.isArray(parsed.layers)) {
    throw new Error('Photopea described the document in an unexpected form')
  }
  return parsed as DocInfo
}

/**
 * A picture as a `data:` URL, its type read from the file's first bytes.
 * @param bytes - the file.
 * @param path - its path, for the error.
 * @returns the URL.
 * @throws when the file is not a PNG, JPEG, WebP or GIF.
 */
export function dataUrl(bytes: Uint8Array, path: string): string {
  const head = Buffer.from(bytes.subarray(0, 12))
  const type = head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? 'image/png'
    : head[0] === 0xff && head[1] === 0xd8 ? 'image/jpeg'
      : head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP' ? 'image/webp'
        : head.toString('latin1', 0, 4) === 'GIF8' ? 'image/gif'
          : undefined
  if (type === undefined) throw new Error(`${path} is not a PNG, JPEG, WebP or GIF picture`)
  return `data:${type};base64,${Buffer.from(bytes).toString('base64')}`
}

/** A safe file name from the model's choice or a default. */
function outputName(chosen: string | undefined, fallback: string, format: ExportFormat): string {
  const raw = chosen === undefined || chosen.trim() === '' ? fallback : basename(chosen.trim())
  const stem = raw.replace(/\.[a-z0-9]{2,4}$/iu, '').replace(/[^\w.-]+/gu, '-').replace(/^[-.]+/u, '') || 'design'
  return `${stem}.${format}`
}

/**
 * Build the PSD tools without registering them.
 * @param config - validated composition config.
 * @param deps - Photopea, the outputs reader and the cwd resolver; all default.
 * @returns the tool definitions.
 */
export function buildPsdTools(config: Config, deps: PsdDeps = {}): ToolDefinition[] {
  const engine = deps.engine ?? createPhotopeaEngine({
    resolveBrowser: () => resolveBrowserPath(config.browserPath),
    photopeaUrl: config.photopeaUrl,
    loadTimeoutMs: config.loadTimeoutMs,
    stepTimeoutMs: config.stepTimeoutMs,
    idleCloseMs: config.idleCloseMs,
  })
  const readOutputs = deps.readOutputs ?? ((): undefined => undefined)
  const resolveCwd = deps.resolveCwd ?? ((exec: ToolRunContext): string => exec.agent?.session.header.cwd ?? process.cwd())
  const timeoutMs = config.loadTimeoutMs + config.stepTimeoutMs * 4

  const load = async (cwd: string, path: string): Promise<Uint8Array> => {
    const full = await workspacePath(cwd, path)
    const info = await stat(full)
    if (!info.isFile()) throw new Error(`${path} is not a file`)
    if (info.size > config.maxFileBytes) throw new Error(`${path} is ${String(info.size)} bytes; the limit is ${String(config.maxFileBytes)}`)
    return new Uint8Array(await readFile(full))
  }
  const loadAll = async (cwd: string, paths: readonly string[] | undefined): Promise<Uint8Array[]> => {
    const out: Uint8Array[] = []
    for (const p of paths ?? []) out.push(await load(cwd, p))
    return out
  }

  const deliver = async (cwd: string, bytes: Uint8Array, fileName: string, label: string, notes: string[]): Promise<FileRecord> => {
    const record: ImageRecord = await deliverFile(bytes, fileName, cwd, readOutputs(), config.fallbackDir, notes, label)
    const location = record.rel ?? relative(cwd, record.path ?? record.name)
    return { name: record.name, bytes: record.bytes, published: record.published, location }
  }

  const fileLines = (files: FileRecord[], notes: string[]): string[] => [
    ...files.map(f => `Wrote ${f.location} (${String(f.bytes)} bytes)${f.published ? ', in the session outputs drawer' : ''}.`),
    ...notes.map(n => `Note: ${n}`),
  ]

  const previewLine = (preview: FileRecord): string =>
    `Look at the preview ${preview.location} (read it as an image) before saying the design is right; text can overflow its box or a substitute font can change the look.`

  const fontsParam = {
    type: 'array',
    items: { type: 'string' },
    description: 'Font files (.ttf, .otf, .woff2) in the workspace to load first, for fonts Photopea lacks.',
  } as const

  return [
    defineTool({
      name: 'psd_open',
      description: 'Open a PSD (or another file Photopea reads: PSB, XCF, Sketch, AI, PDF, PNG, JPG) and list its layers top first: '
        + 'name, kind, visibility, box, and for text layers the words, font, size and colour, with fonts Photopea lacks marked MISSING. '
        + 'Also writes a preview PNG. Use it before psd_edit to find the layers to change.',
      parameters: {
        path: { type: 'string', required: true, description: 'The file, relative to the session workspace.' },
        fonts: fontsParam,
      },
      timeoutMs,
      output: { schema: OUTPUT_SCHEMA, render: (_args, value) => [{ type: 'text', text: value.text }] },
      execute: async (args, exec): Promise<PsdValue> => {
        const cwd = resolveCwd(exec)
        const fonts = await loadAll(cwd, args.fonts)
        const main = await load(cwd, args.path)
        const job = { files: [...fonts, main], documents: 1, scripts: [inspectScript(config.previewMaxPx)] }
        const result = await engine.run(job, exec.signal)
        const doc = inspection(result.echoes)
        const png = result.files[0]
        if (png === undefined) throw new Error('Photopea returned no preview')
        const notes: string[] = []
        const stem = basename(args.path, extname(args.path))
        const preview = await deliver(cwd, png, outputName(undefined, `${stem}-preview`, 'png'), 'PSD preview', notes)
        return {
          text: [...describeDoc(doc, config.maxLayersListed), ...fileLines([preview], notes), previewLine(preview)].join('\n'),
          files: [preview],
        }
      },
      presentCall: args => ({ card: 'generic', title: `Open ${args.path}`, kind: 'read', rawInput: args.path }),
    }),

    defineTool({
      name: 'psd_edit',
      description: 'Change layers in a PSD and save the result as a new file, plus a preview PNG. Operations: '
        + 'text (new words, font by PostScript name, size in pt, colour as hex), visible, opacity, move (dx, dy in px), '
        + 'image (put a picture from the workspace into the layer\'s box: cover, contain or stretch; the old layer is hidden), '
        + 'rename, delete. Edits run in order; if one fails, nothing is saved. The original file is never changed.',
      parameters: {
        path: { type: 'string', required: true, description: 'The PSD, relative to the session workspace.' },
        edits: {
          type: 'array',
          required: true,
          description: 'The changes, in order.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              op: { type: 'string', enum: [...OPS], required: true },
              layer: { type: 'string', required: true, description: 'Layer name, group path (Promo/Headline) or @ reference from psd_open.' },
              text: { type: 'string', description: 'text: the new words; \\n breaks a line.' },
              font: { type: 'string', description: 'text: PostScript font name, such as Montserrat-Bold.' },
              size: { type: 'number', description: 'text: size in points.' },
              color: { type: 'string', description: 'text: colour as six hex digits.' },
              visible: { type: 'boolean', description: 'visible: show (true) or hide (false).' },
              opacity: { type: 'number', description: 'opacity: 0 to 100.' },
              dx: { type: 'number', description: 'move: pixels right (negative is left).' },
              dy: { type: 'number', description: 'move: pixels down (negative is up).' },
              image: { type: 'string', description: 'image: the picture file, relative to the session workspace.' },
              fit: { type: 'string', enum: ['cover', 'contain', 'stretch'], description: 'image: cover (default) fills and crops to the box.' },
              name: { type: 'string', description: 'rename: the new name.' },
            },
          },
        },
        output: { type: 'string', description: 'File name for the result. Default: the original name with -edited.' },
        format: { type: 'string', enum: [...FORMATS], description: 'Format of the result. Default psd, so it stays editable.' },
        fonts: fontsParam,
      },
      timeoutMs,
      output: { schema: OUTPUT_SCHEMA, render: (_args, value) => [{ type: 'text', text: value.text }] },
      execute: async (args, exec): Promise<PsdValue> => {
        const { edits, images } = checkEdits(args.edits)
        const format: ExportFormat = args.format ?? 'psd'
        const cwd = resolveCwd(exec)
        const fonts = await loadAll(cwd, args.fonts)
        const main = await load(cwd, args.path)
        const pictures = await loadAll(cwd, images)
        let next = 0
        for (const edit of edits) {
          if (edit.op !== 'image') continue
          const path = images[next] ?? ''
          edit.imageData = dataUrl(pictures[next] ?? new Uint8Array(), path)
          next++
        }
        const result = await engine.run({
          files: [...fonts, main],
          documents: 1,
          scripts: editScripts(edits, format, 0.9, config.previewMaxPx),
        }, exec.signal)
        return finish(cwd, args.path, args.output, format, result.echoes, result.files, `Applied ${String(edits.length)} edit${edits.length === 1 ? '' : 's'}.`, '-edited')
      },
      presentCall: args => ({ card: 'generic', title: `Edit ${args.path}`, kind: 'edit', rawInput: args.path }),
    }),

    defineTool({
      name: 'psd_script',
      description: 'Run your own Photopea script (Photoshop-style JavaScript: app, documents, artLayers, layerSets, textItem, SolidColor) '
        + 'on a file, or on a new blank document when path is omitted (to build a graphic from nothing). The script receives D, the document; '
        + '__find(D, "Layer name or Group/Layer") returns a layer or null, __echo(value) sends text back, __fail("why") reports a problem, '
        + 'and __num(value) turns a size or bound into a number. Saves the result and a preview. Prefer psd_edit for the changes it covers. '
        + 'Photopea\'s interpreter is not standard JavaScript: try/catch catches nothing and throw ends the script silently (use __fail and return); '
        + 'a || b evaluates b even when a is true (use if/else); a function passed to an array method (map, forEach) fails (use for loops); '
        + 'read sizes and bounds only through __num, since reading their properties stops the script; app.open finishes after the script ends.',
      parameters: {
        path: { type: 'string', description: 'The file to open, relative to the session workspace. Omit to start a blank document.' },
        width: { type: 'integer', description: 'Blank document width in px, such as 1080. Required without path.' },
        height: { type: 'integer', description: 'Blank document height in px, such as 1350. Required without path.' },
        script: { type: 'string', required: true, description: 'The script body.' },
        output: { type: 'string', description: 'File name for the result. Default: the original name with -edited, or design.psd.' },
        format: { type: 'string', enum: [...FORMATS], description: 'Format of the result. Default psd.' },
        fonts: fontsParam,
      },
      timeoutMs,
      output: { schema: OUTPUT_SCHEMA, render: (_args, value) => [{ type: 'text', text: value.text }] },
      execute: async (args, exec): Promise<PsdValue> => {
        const format: ExportFormat = args.format ?? 'psd'
        const blank = args.path === undefined || args.path === ''
        const fits = (n: number | undefined): boolean => n !== undefined && n >= 16 && n <= 10_000
        if (blank && !(fits(args.width) && fits(args.height))) {
          throw new Error('Without path, give width and height between 16 and 10000 px for the new document.')
        }
        const cwd = resolveCwd(exec)
        const fonts = await loadAll(cwd, args.fonts)
        const main = blank ? [] : [await load(cwd, args.path ?? '')]
        const create = blank ? { width: args.width ?? 0, height: args.height ?? 0, name: outputName(args.output, 'design', 'psd').replace(/\.psd$/u, '') } : undefined
        const result = await engine.run({
          files: [...fonts, ...main],
          documents: main.length,
          scripts: customScripts(args.script, create, format, 0.9, config.previewMaxPx),
        }, exec.signal)
        const echoed = result.echoes.filter(e => e.startsWith(ECHO_MARK)).map(e => `Script said: ${e.slice(ECHO_MARK.length)}`)
        return finish(cwd, blank ? 'design' : args.path ?? '', args.output, format, result.echoes, result.files, ['Ran the script.', ...echoed].join('\n'), blank ? '' : '-edited')
      },
      presentCall: args => ({ card: 'generic', title: `Photopea script on ${args.path ?? 'a new document'}`, kind: 'edit', rawInput: args.script }),
    }),

    defineTool({
      name: 'psd_export',
      description: 'Export a PSD to PNG, JPG, WebP, PDF or SVG for posting or sending, optionally at another width. The file is delivered to the session outputs.',
      parameters: {
        path: { type: 'string', required: true, description: 'The file, relative to the session workspace.' },
        format: { type: 'string', enum: FORMATS.filter(f => f !== 'psd'), required: true },
        quality: { type: 'number', description: 'jpg and webp: 0.1 to 1. Default 0.9.' },
        width: { type: 'integer', description: 'Width in px; height follows the aspect ratio. Default: the document width.' },
        output: { type: 'string', description: 'File name. Default: the original name with the new extension.' },
        fonts: fontsParam,
      },
      timeoutMs,
      output: { schema: OUTPUT_SCHEMA, render: (_args, value) => [{ type: 'text', text: value.text }] },
      execute: async (args, exec): Promise<PsdValue> => {
        const format = args.format as ExportFormat
        const quality = Math.min(1, Math.max(0.1, args.quality ?? 0.9))
        if (args.width !== undefined && !(args.width >= 16 && args.width <= 10_000)) throw new Error('width must be between 16 and 10000 px')
        const cwd = resolveCwd(exec)
        const fonts = await loadAll(cwd, args.fonts)
        const main = await load(cwd, args.path)
        const job = { files: [...fonts, main], documents: 1, scripts: [exportScript(format, quality, args.width)] }
        const result = await engine.run(job, exec.signal)
        const doc = inspection(result.echoes)
        const bytes = result.files[0]
        if (bytes === undefined) throw new Error('Photopea returned no file')
        const notes: string[] = []
        const file = await deliver(cwd, bytes, outputName(args.output, basename(args.path, extname(args.path)), format), 'PSD export', notes)
        return {
          text: [`Exported ${args.path} as ${format.toUpperCase()}, ${String(Math.round(doc.width))} x ${String(Math.round(doc.height))} px.`, ...fileLines([file], notes)].join('\n'),
          files: [file],
        }
      },
      presentCall: args => ({ card: 'generic', title: `Export ${args.path} as ${args.format}`, kind: 'other', rawInput: args.path }),
    }),
  ]

  async function finish(
    cwd: string,
    source: string,
    chosen: string | undefined,
    format: ExportFormat,
    echoes: string[],
    files: Uint8Array[],
    headline: string,
    suffix: string,
  ): Promise<PsdValue> {
    const doc = inspection(echoes)
    const [saved, png] = files
    if (saved === undefined || png === undefined) throw new Error('Photopea returned no file')
    const notes: string[] = []
    const fileName = outputName(chosen, `${basename(source, extname(source))}${suffix}`, format)
    const written = await deliver(cwd, saved, fileName, 'PSD result', notes)
    const preview = await deliver(cwd, png, outputName(undefined, `${basename(fileName, extname(fileName))}-preview`, 'png'), 'PSD preview', notes)
    return {
      text: [headline, ...describeDoc(doc, config.maxLayersListed), ...fileLines([written, preview], notes), previewLine(preview)].join('\n'),
      files: [written, preview],
    }
  }
}

/**
 * Mount the PSD tools on every agent created while they are switched on
 * (Plugins → PSD tools), sharing one Photopea browser.
 * @param ctx - the plugin context, injecting `agents`.
 * @param config - validated composition config.
 */
export function apply(ctx: Context, config: Config): void {
  const readOutputs = (): OutputsCapability | undefined => {
    const service: unknown = ctx.get('outputs')
    return isOutputsCapability(service) ? service : undefined
  }
  const engine = createPhotopeaEngine({
    resolveBrowser: () => resolveBrowserPath(config.browserPath),
    photopeaUrl: config.photopeaUrl,
    loadTimeoutMs: config.loadTimeoutMs,
    stepTimeoutMs: config.stepTimeoutMs,
    idleCloseMs: config.idleCloseMs,
  })
  ctx.effect(() => () => { void engine.close() }, 'psd-tools: Photopea browser')

  // The last call, for the Plugins page: when, which tool, and how it ended.
  let lastCall: { at: string; tool: string; error?: string } | undefined
  const recorded = buildPsdTools(config, { engine, readOutputs }).map(tool => ({
    ...tool,
    execute: async (args: unknown, exec: ToolRunContext): Promise<unknown> => {
      try {
        const value = await tool.execute(args, exec)
        lastCall = { at: new Date().toISOString(), tool: tool.name }
        return value
      } catch (error) {
        lastCall = { at: new Date().toISOString(), tool: tool.name, error: error instanceof Error ? error.message : String(error) }
        throw error
      }
    },
  }))
  const toggle = mountSwitch(ctx, {
    id: 'psd-tools',
    defaultEnabled: true,
    health: () => {
      const facts = [
        { key: 'photopea', value: config.photopeaUrl },
        { key: 'lastCall', value: lastCall === undefined ? '' : `${lastCall.at} ${lastCall.tool}${lastCall.error === undefined ? '' : `: ${lastCall.error}`}` },
      ]
      try {
        return { healthy: true, facts: [{ key: 'browser', value: resolveBrowserPath(config.browserPath) }, ...facts] }
      } catch (error) {
        return { healthy: false, facts, problem: error instanceof Error ? error.message : String(error) }
      }
    },
    // Loads Photopea in the browser the tools use, the step that fails when photopea.com is unreachable.
    test: async () => {
      const started = Date.now()
      const signal = AbortSignal.timeout(config.loadTimeoutMs + config.stepTimeoutMs)
      const result = await engine.run({ files: [], documents: 0, scripts: [wrapScript(`app.echoToOE(${JSON.stringify(ECHO_MARK)} + app.fonts.length)`)] }, signal)
      const fonts = result.echoes.find(e => e.startsWith(ECHO_MARK))?.slice(ECHO_MARK.length) ?? '?'
      return { ok: true, message: `Photopea answered in ${String(Date.now() - started)} ms with ${fonts} fonts available.` }
    },
  })
  const tools = gateTools(recorded, () => toggle.isOn(), 'PSD tools')

  const installed = new Map<Agent, { dispose: () => Promise<void> }>()
  const install = (agent: Agent): void => {
    // Switched off: a new agent is not given the tools at all.
    if (installed.has(agent) || !toggle.isOn()) return
    installed.set(agent, agent.ctx.inject(['tools'], (scope) => {
      for (const tool of tools) scope.effect(() => scope.tools.register(tool), `psd-tools: ${tool.name}`)
    }))
  }
  const remove = (agent: Agent): void => {
    const fiber = installed.get(agent)
    if (fiber === undefined) return
    installed.delete(agent)
    void fiber.dispose().catch(() => {
      // The agent is gone; its registry went with it.
    })
  }
  for (const agent of ctx.agents.list()) install(agent)
  ctx.on('agent/created', ({ agent }) => { install(agent) })
  ctx.on('agent/disposed', ({ agent }) => { remove(agent) })
}
