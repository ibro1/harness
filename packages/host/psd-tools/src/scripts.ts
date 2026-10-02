/**
 * The Photopea scripts the PSD tools run. Photopea executes a posted string as
 * JavaScript against its Photoshop-style document model and answers with the
 * strings passed to `app.echoToOE` and the files passed to `saveToOE`, then the
 * string `done`. Everything a tool needs is built here as plain text, so the
 * scripts can be read and tested without a browser.
 *
 * Every value from a model is embedded with `JSON.stringify`, never spliced
 * into code.
 *
 * Photopea runs scripts in its own interpreter, which differs from JavaScript
 * in ways these scripts depend on. `try`/`catch` catches nothing: `throw` ends
 * the script silently as if it had succeeded, and a runtime error (reading a
 * property of null) stops it without `done`. `a || b` evaluates `b` even when
 * `a` is true (`&&` and `?:` do short-circuit), so no `||` here has a side
 * effect or guards a property read. So a script reports a problem by
 * calling `__fail`, which echoes {@link ERROR_MARK} and clears `__ok`, and
 * every later step of the script runs only while `__ok` is set.
 *
 * @module @deepseek-ai/dsh-host-psd-tools/src/scripts
 */

/** Prefix of the echo that reports a failed script. */
export const ERROR_MARK = '__psd_error__'

/** Prefix of the echo that carries the document inspection as JSON. */
export const INSPECT_MARK = '__psd_inspect__'

/** Echo that asks the engine to post the same script again shortly, because Photopea has not finished earlier work. */
export const RETRY_MARK = '__psd_retry__'

/** Prefix of an echo from a raw script, so it is told apart from the plugin's own echoes. */
export const ECHO_MARK = '__psd_echo__'

/** Formats {@link exportCall} writes. */
export type ExportFormat = 'png' | 'jpg' | 'webp' | 'pdf' | 'svg' | 'psd'

/** One change to a document. Fields other than `op` and `layer` belong to particular operations. */
export interface PsdEdit {
  /** What to change. */
  op: 'text' | 'visible' | 'opacity' | 'move' | 'image' | 'delete' | 'rename'
  /** The layer: a name, a path of group names (`Promo/Headline`), or an index path from the inspection (`@1/0`). */
  layer: string
  /** `text`: the new contents; `\n` breaks a line. */
  text?: string
  /** `text`: a font's PostScript name, such as `Montserrat-Bold`. */
  font?: string
  /** `text`: the size in points. */
  size?: number
  /** `text`: the colour as six hex digits. */
  color?: string
  /** `visible`: show or hide. */
  visible?: boolean
  /** `opacity`: 0 to 100. */
  opacity?: number
  /** `move`: horizontal shift in pixels. */
  dx?: number
  /** `move`: vertical shift in pixels. */
  dy?: number
  /** `image`: the picture as a `data:` URL, filled in by the tool from the model's path. */
  imageData?: string
  /** `image`: how the picture fills the layer's box. */
  fit?: 'cover' | 'contain' | 'stretch'
  /** `rename`: the new name. */
  name?: string
}

/** The inspection of one layer, as the inspect script reports it. */
export interface LayerInfo {
  /** Index path from the top of the document, such as `@1/0`. */
  ref: string
  /** Names from the top group down, joined with `/`. */
  path: string
  name: string
  /** `group`, `text`, `smartobject`, `normal` (pixels), or another Photoshop layer kind in lower case. */
  kind: string
  visible: boolean
  opacity: number
  /** Left, top, right, bottom in pixels; all zero for an empty layer. */
  bounds: [number, number, number, number]
  /** Present on text layers. */
  text?: {
    contents: string
    font: string
    size: number
    color: string
    /** True when Photopea has no font of that name and draws a substitute. */
    fontMissing: boolean
  }
}

/** The inspection of a document. */
export interface DocInfo {
  name: string
  width: number
  height: number
  resolution: number
  layers: LayerInfo[]
}

/**
 * Helpers every script starts with: layer lookup, bounds as numbers, font
 * lookup and the inspection walk.
 *
 * Photopea reports sizes and bounds as `UnitValue` objects. Reading a property
 * of one (`.value`, `.n`) stops the script without `done`; converting it to a
 * string is safe, so `__num`
 * reads numbers only that way. Layer objects behave the same: `.layers` is read
 * only on a group (`__group`). A function passed to a built-in (`[].map(fn)`)
 * fails, and a recursive search by name missed layers inside groups, so the
 * helpers use loops and an explicit stack.
 *
 * `app.fonts.getByName` returns null for every name, and reading the 10,000
 * font names one by one takes over ten seconds, so `__fontAt` binary-searches
 * the list, which Photopea keeps in code-unit order; fonts loaded from files
 * are appended, so `__hasFont` also checks the end of the list.
 */
const PRELUDE = String.raw`
var __ok = true;
function __fail(m){ if (__ok) app.echoToOE(${JSON.stringify(ERROR_MARK)} + m); __ok = false; return null }
function __num(v){ var n = parseFloat('' + v); if (!isNaN(n)) return n; var s = JSON.stringify(v); if (typeof s === 'string' && s.charAt(0) === '{') { var j = JSON.parse(s); if (typeof j.n === 'number') return j.n } return 0 }
function __fontAt(name){ var F = app.fonts, lo = 0, hi = F.length - 1; while (lo <= hi) { var m = (lo + hi) >> 1, p = String(F[m].postScriptName); if (p === name) return m; if (p < name) lo = m + 1; else hi = m - 1 } return -1 - lo }
function __hasFont(name){ if (__fontAt(name) >= 0) return true; var F = app.fonts; for (var i = Math.max(0, F.length - 100); i < F.length; i++) if (String(F[i].postScriptName) === name) return true; return false }
function __nearFonts(name){ var F = app.fonts, stem = name.split('-')[0], at = __fontAt(stem), out = []; if (at < 0) at = -1 - at; for (var i = Math.max(0, at - 2); i < F.length && out.length < 12; i++) { var p = String(F[i].postScriptName); if (p.slice(0, 4) === stem.slice(0, 4)) out.push(p); else if (out.length > 0) break } return out }
function __b(l){ var b = l.bounds; return [__num(b[0]), __num(b[1]), __num(b[2]), __num(b[3])] }
function __group(l){ return l.typename === 'LayerSet' }
function __layers(c){ var out = []; for (var i = 0; i < c.layers.length; i++) out.push(c.layers[i]); return out }
function __find(D, spec){
  if (spec.charAt(0) === '@') {
    var cur = D, idx = spec.slice(1).split('/');
    for (var i = 0; i < idx.length; i++) {
      var n = Number(idx[i]);
      if (cur !== D && !__group(cur)) return __fail('no layer at ' + spec + '; use psd_open to list the layers');
      if (!(n >= 0 && n < cur.layers.length)) return __fail('no layer at ' + spec + '; use psd_open to list the layers');
      cur = cur.layers[n];
    }
    return cur;
  }
  var parts = spec.split('/'), level = [D];
  for (var k = 0; k < parts.length && level.length > 0; k++) {
    var next = [];
    for (var c = 0; c < level.length; c++) {
      if (level[c] !== D && !__group(level[c])) continue;
      var ls = __layers(level[c]);
      for (var i = 0; i < ls.length; i++) if (ls[i].name === parts[k]) next.push(ls[i]);
    }
    level = next;
  }
  var hit = level.length > 0 ? level[0] : null, stack = __layers(D).reverse();
  while (!hit && stack.length > 0) {
    var l = stack.pop();
    if (l.name === spec) hit = l;
    else if (__group(l)) { var kids = __layers(l); for (var j = kids.length - 1; j >= 0; j--) stack.push(kids[j]) }
  }
  if (hit === null) return __fail('no layer named "' + spec + '"; use psd_open to list the layers');
  return hit;
}
function __kinds(){ var m = {}; for (var k in LayerKind) m[LayerKind[k]] = k.toLowerCase(); return m }
function __inspect(D){
  var kinds = __kinds(), out = [], stack = [], top = __layers(D);
  for (var i = top.length - 1; i >= 0; i--) stack.push({ l: top[i], ref: '@' + i, path: top[i].name });
  while (stack.length > 0) {
    var e = stack.pop(), l = e.l, group = __group(l);
    var info = { ref: e.ref, path: e.path, name: l.name, kind: group ? 'group' : (kinds[l.kind] || String(l.kind)), visible: l.visible, opacity: __num(l.opacity), bounds: group ? [0, 0, 0, 0] : __b(l) };
    if (!group && l.kind === LayerKind.TEXT) {
      var t = l.textItem;
      info.text = { contents: String(t.contents), font: String(t.font), size: __num(t.size), color: String(t.color.rgb.hexValue), fontMissing: !__hasFont(String(t.font)) };
    }
    out.push(info);
    if (group) { var kids = __layers(l); for (var j = kids.length - 1; j >= 0; j--) stack.push({ l: kids[j], ref: e.ref + '/' + j, path: e.path + '/' + kids[j].name }) }
  }
  return { name: D.name, width: __num(D.width), height: __num(D.height), resolution: __num(D.resolution), layers: out };
}
function __echo(s){ app.echoToOE(${JSON.stringify(ECHO_MARK)} + String(s)) }
`

/**
 * Put the helpers in front of a script.
 * @param body - the script, which may use the prelude's helpers.
 * @returns the complete script to post.
 */
export function wrapScript(body: string): string {
  return `${PRELUDE}\n${body}\n`
}

/** Join script steps so each runs only while no earlier step has called `__fail`. */
function guarded(steps: readonly string[]): string {
  return steps.map(step => `if (__ok) {\n${step}\n}`).join('\n')
}

/** Close every open document without saving, so each job starts empty. */
export const RESET_SCRIPT = wrapScript('while (app.documents.length > 0) app.documents[0].close(SaveOptions.DONOTSAVECHANGES);')

/** Report how many documents are open. */
export const COUNT_SCRIPT = wrapScript(`app.echoToOE(${JSON.stringify(ECHO_MARK)} + app.documents.length);`)

/**
 * The `saveToOE` argument for a format.
 * @param format - the file format.
 * @param quality - 0 to 1 for jpg and webp.
 * @returns the argument string.
 */
export function exportCall(format: ExportFormat, quality: number): string {
  return format === 'jpg' || format === 'webp' ? `${format}:${String(quality)}` : format
}

/**
 * Script lines that shrink the active document so its longer side is at most
 * `maxPx`, for a preview. Run them after the full-size files are saved.
 * @param maxPx - the longest side of the preview.
 * @returns the script lines.
 */
function shrinkTo(maxPx: number): string {
  return `(function(){ var D = app.activeDocument, w = __num(D.width), h = __num(D.height), s = Math.min(1, ${String(maxPx)} / Math.max(w, h));
  if (s < 1) D.resizeImage(Math.round(w * s), Math.round(h * s)); })();`
}

/**
 * Inspect the main document (the first opened) and save a preview.
 * @param previewMaxPx - the longest side of the preview PNG.
 * @returns the script; its echoes carry one {@link INSPECT_MARK} JSON and its only file is the PNG.
 */
export function inspectScript(previewMaxPx: number): string {
  return wrapScript(`var D = app.documents[0]; app.activeDocument = D;
app.echoToOE(${JSON.stringify(INSPECT_MARK)} + JSON.stringify(__inspect(D)));
${shrinkTo(previewMaxPx)}
D.saveToOE("png");`)
}

/** Marks where one edit's steps continue in a new script. */
const NEXT_SCRIPT = '\u0000next-script'

/** Script steps for one edit; `D` is the main document. {@link NEXT_SCRIPT} starts a new script. */
function editSteps(edit: PsdEdit, n: number): string[] {
  const L = `L${String(n)}`
  const fail = (message: string): string => `__fail(${JSON.stringify(message)})`
  const find = `var ${L} = __find(D, ${JSON.stringify(edit.layer)});`
  switch (edit.op) {
    case 'text': {
      const T = `T${String(n)}`
      const notText = fail(`layer "${edit.layer}" is not a text layer`)
      const steps = [find, `if (__group(${L})) ${notText}; else if (${L}.kind !== LayerKind.TEXT) ${notText}; else var ${T} = ${L}.textItem;`]
      if (edit.font !== undefined) {
        steps.push(`if (!__hasFont(${JSON.stringify(edit.font)})) { var near = __nearFonts(${JSON.stringify(edit.font)});
  __fail(${JSON.stringify(`font "${edit.font}" is not available`)} + (near.length ? '; fonts with a similar name: ' + near.join(', ') : '; give a PostScript name such as Montserrat-Bold, or load the font file')); }
else ${T}.font = ${JSON.stringify(edit.font)};`)
      }
      if (edit.text !== undefined) steps.push(`${T}.contents = ${JSON.stringify(edit.text.replace(/\n/gu, '\r'))};`)
      if (edit.size !== undefined) steps.push(`${T}.size = ${String(edit.size)};`)
      if (edit.color !== undefined) steps.push(`var C${String(n)} = new SolidColor(); C${String(n)}.rgb.hexValue = ${JSON.stringify(edit.color)}; ${T}.color = C${String(n)};`)
      return steps
    }
    case 'visible':
      return [find, `${L}.visible = ${String(edit.visible === true)};`]
    case 'opacity':
      return [find, `${L}.opacity = ${String(edit.opacity ?? 100)};`]
    case 'move':
      return [find, `${L}.translate(${String(edit.dx ?? 0)}, ${String(edit.dy ?? 0)});`]
    case 'delete':
      return [find, `${L}.remove();`]
    case 'rename':
      return [find, `${L}.name = ${JSON.stringify(edit.name ?? '')};`]
    case 'image': {
      // The picture is placed as a smart object directly above the target:
      // Photopea inserts above the active layer, and copying a layer from
      // another document does nothing. `app.open` finishes only after the
      // script ends, so the placed layer is handled in the next script, which
      // asks to be posted again while the picture is still loading. There it
      // is scaled into the target's box, for `cover` turned into pixels (a
      // smart object cannot be cut) and cut to the box, and given the target's
      // name. The target is hidden rather than deleted so a clipping
      // group or effect still has it.
      const B = `B${String(n)}`
      const N = `N${String(n)}`
      const box = `var ${B} = __b(${L});`
      return [
        find,
        `if (__group(${L})) ${fail(`layer "${edit.layer}" is a group; name a layer inside it`)};`,
        `${box} if (${B}[2] - ${B}[0] < 1) ${fail(`layer "${edit.layer}" is empty, so there is no box to fill`)}; else if (${B}[3] - ${B}[1] < 1) ${fail(`layer "${edit.layer}" is empty, so there is no box to fill`)};`,
        `D.activeLayer = ${L}; app.open(${JSON.stringify(edit.imageData ?? '')}, null, true);`,
        NEXT_SCRIPT,
        `var ${N} = D.activeLayer; if (__group(${N})) __ok = false; else if (${N}.kind !== LayerKind.SMARTOBJECT) __ok = false; if (!__ok) app.echoToOE(${JSON.stringify(RETRY_MARK)});`,
        find,
        `${box}
var nb = __b(${N}), sw = nb[2] - nb[0], sh = nb[3] - nb[1], bw = ${B}[2] - ${B}[0], bh = ${B}[3] - ${B}[1];
var sx = bw / sw, sy = bh / sh, mode = ${JSON.stringify(edit.fit ?? 'cover')};
if (mode === 'cover') { sx = Math.max(sx, sy); sy = sx } else if (mode === 'contain') { sx = Math.min(sx, sy); sy = sx }
${N}.resize(sx * 100, sy * 100, AnchorPosition.TOPLEFT);`,
        `var nb2 = __b(${N});
${N}.translate(${B}[0] + (bw - (nb2[2] - nb2[0])) / 2 - nb2[0], ${B}[1] + (bh - (nb2[3] - nb2[1])) / 2 - nb2[1]);
if (mode === 'cover') {
  D.activeLayer = ${N}; ${N}.rasterize(RasterizeType.ENTIRELAYER);
  D.selection.select([[${B}[0], ${B}[1]], [${B}[2], ${B}[1]], [${B}[2], ${B}[3]], [${B}[0], ${B}[3]]]);
  D.selection.invert(); D.selection.clear(); D.selection.deselect();
}
${N}.name = ${L}.name; ${L}.visible = false;`,
      ]
    }
  }
}

/**
 * Apply edits to the main document, then save it and a preview.
 * @param edits - the changes, in order.
 * @param format - the format of the edited file.
 * @param quality - 0 to 1 for jpg and webp.
 * @param previewMaxPx - the longest side of the preview PNG.
 * @returns the scripts, edits first and saving second so Photopea lays out changed text before it is saved; their files
 *   are the edited document, then the preview.
 */
export function editScripts(edits: readonly PsdEdit[], format: ExportFormat, quality: number, previewMaxPx: number): string[] {
  return [
    ...splitScripts(edits.flatMap((edit, n) => editSteps(edit, n))),
    saveScript(format, quality, previewMaxPx),
  ]
}

/** Turn steps into scripts, starting a new one at each {@link NEXT_SCRIPT}. */
function splitScripts(steps: readonly string[]): string[] {
  const scripts: string[][] = [[]]
  for (const step of steps) {
    if (step === NEXT_SCRIPT) scripts.push([])
    else scripts.at(-1)?.push(step)
  }
  return scripts.filter(group => group.length > 0).map(group => wrapScript(`var D = app.documents[0]; app.activeDocument = D;\n${guarded(group)}`))
}

/**
 * Report the main document, save it in a format, then save a preview.
 * @param format - the format of the saved file.
 * @param quality - 0 to 1 for jpg and webp.
 * @param previewMaxPx - the longest side of the preview PNG.
 * @returns the script; its files are the saved document, then the preview.
 */
function saveScript(format: ExportFormat, quality: number, previewMaxPx: number): string {
  return wrapScript(`var D = app.documents[0]; app.activeDocument = D;
app.echoToOE(${JSON.stringify(INSPECT_MARK)} + JSON.stringify(__inspect(D)));
D.saveToOE(${JSON.stringify(exportCall(format, quality))});
${shrinkTo(previewMaxPx)}
D.saveToOE("png");`)
}

/**
 * Run a model-written script on the main document, or on a new blank one,
 * then save it and a preview.
 *
 * Photopea skips a script with a syntax error and answers as if it had run,
 * and has no working `new Function`, so the body is compiled here first and a
 * syntax error is thrown before anything is posted.
 * @param body - the script; it sees `D`, the main document, `__find(D, layer)` and `__echo(value)`.
 * @param create - the size of a new document, when there is no file to open.
 * @param format - the format of the saved file.
 * @param quality - 0 to 1 for jpg and webp.
 * @param previewMaxPx - the longest side of the preview PNG.
 * @returns the scripts; their files are the saved document, then the preview.
 * @throws SyntaxError when the body does not parse.
 */
export function customScripts(
  body: string,
  create: { width: number; height: number; name: string } | undefined,
  format: ExportFormat,
  quality: number,
  previewMaxPx: number,
): string[] {
  const open = create === undefined
    ? 'var D = app.documents[0]; app.activeDocument = D;'
    : `var D = app.documents.add(${String(create.width)}, ${String(create.height)}, 72, ${JSON.stringify(create.name)}); app.activeDocument = D;`
  try {
    // Compiled only, never called: Node checks the syntax.
    new Function('D', body)
  } catch (error) {
    throw new SyntaxError(`The script does not parse, so nothing ran: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  return [
    wrapScript(`${open}\n(function (D) {\n${body}\n})(D);`),
    saveScript(format, quality, previewMaxPx),
  ]
}

/**
 * Export the main document to one format, optionally resized.
 * @param format - the output format.
 * @param quality - 0 to 1 for jpg and webp.
 * @param width - the output width in pixels, keeping the aspect ratio; undefined keeps the size.
 * @returns the script; its only file is the export.
 */
export function exportScript(format: ExportFormat, quality: number, width: number | undefined): string {
  const resize = width === undefined
    ? ''
    : `D.resizeImage(${String(width)}, Math.round(__num(D.height) * ${String(width)} / __num(D.width)));`
  return wrapScript(`var D = app.documents[0]; app.activeDocument = D;
${resize}
app.echoToOE(${JSON.stringify(INSPECT_MARK)} + JSON.stringify({ name: D.name, width: __num(D.width), height: __num(D.height), resolution: __num(D.resolution), layers: [] }));
D.saveToOE(${JSON.stringify(exportCall(format, quality))});`)
}
