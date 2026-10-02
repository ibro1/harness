---
description: "Fork-local PSD tools: open, edit and export Photoshop files through Photopea running in the harness's headless Chromium, with a preview after every change."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-psd-tools

## Summary

Four tools edit Photoshop files on request: `psd_open` lists a file's layers and draws a preview, `psd_edit` changes text, fonts, colours, pictures, visibility, opacity and position, `psd_script` runs a Photopea script (or builds a design on a blank canvas), and `psd_export` writes PNG, JPG, WebP, PDF or SVG. They drive Photopea, a Photoshop-compatible editor, loaded from photopea.com into the harness's own headless Chromium. Libraries that read and write PSD layers (`ag-psd` and similar) cannot lay out changed text again, so an edited headline would keep its old pixels; Photopea redraws it.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

The deploy entrypoint layers `deploy/plugins/psd-tools.cordis.yml` over the Web composition unless `DSH_PSD_TOOLS=0`, and links the `psd-designer` skill (`deploy/skills/psd-designer/`). The tools are on every Session; agy and opencode reach them through the session-tools route (`deploy/plugins/session-tools.mjs`). The box needs `chromium` on PATH (the image installs it for page capture) and outbound HTTPS to www.photopea.com.

Files must be inside the Session's working directory. Results go through the `outputs` capability when it is mounted, otherwise to `<cwd>/.outputs`; the original file is never written.

| Tool | What it does and refuses |
|---|---|
| `psd_open` | lists layers top first (index reference, name, kind, hidden, opacity, box, and for text the words, font, size and colour), marks fonts Photopea lacks as MISSING, writes a preview PNG |
| `psd_edit` | applies `text`, `visible`, `opacity`, `move`, `image`, `rename` and `delete` edits in order and saves a new file (PSD by default) plus a preview; refuses invalid edits before starting Photopea, an unknown font (naming fonts with a similar name), and a layer it cannot find; if one edit fails nothing is saved |
| `psd_script` | runs a model-written script on a file or a blank document of a given size; refuses a script that does not parse before posting it |
| `psd_export` | writes one format, optionally at another width |

A layer is named by its name, its group path (`Promo/Headline`) or its index reference from `psd_open` (`@1/0`). `image` places a workspace picture (PNG, JPEG, WebP, GIF, by its first bytes) over the target layer's box with `cover` (fill and crop, the default), `contain` or `stretch`, names it like the target and hides the target. `fonts` on any tool loads font files first.

### Config

| Field | Default | Meaning |
|---|---|---|
| `browserPath` | `''` | Chromium path; empty searches PATH the way `dsh-host-capture` does |
| `photopeaUrl` | `https://www.photopea.com` | where Photopea loads from |
| `loadTimeoutMs` | 90000 | longest wait for Photopea to load |
| `stepTimeoutMs` | 120000 | longest wait for one opened file or script |
| `idleCloseMs` | 300000 | close the browser after this long without a call |
| `maxFileBytes` | 200000000 | largest file a call opens |
| `previewMaxPx` | 1600 | longest side of a preview |
| `maxLayersListed` | 300 | most layers one result lists |
| `fallbackDir` | `.outputs` | where results go without the `outputs` capability |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`photopea.ts` launches Chromium through `playwright-core` with SwiftShader WebGL, loads a local page that frames Photopea with an empty JSON configuration (`#{}`; without it Photopea shows its landing page) and calls `addPP()` in the frame, after which Photopea posts `done` to the parent. A posted `ArrayBuffer` opens as a document (or installs as a font); a posted string runs as a script; Photopea answers with `echoToOE` strings, `saveToOE` buffers and `done`. Files cross the CDP connection as base64. One browser serves all calls, jobs run one at a time, each job first closes every open document, and the browser closes after `idleCloseMs`, on a timeout, and on plugin dispose. An error Photopea throws from inside its own code during a step (seen as a page error) fails that step at once instead of after the timeout.

`scripts.ts` builds every script as text, embedding model values with `JSON.stringify`. Photopea's script interpreter differs from JavaScript, and the scripts depend on the differences found while building this:

- `try`/`catch` catches nothing: `throw` ends the script silently and Photopea still answers `done`, and a runtime error stops it without `done`. Scripts report problems with `__fail`, which echoes an error mark, and each later step runs under `if (__ok)`.
- `a || b` evaluates `b` even when `a` is true; `&&` and `?:` short-circuit.
- A function passed to an array method fails, and a recursive search by name missed layers inside groups; the helpers use loops and an explicit stack.
- Reading a property of a size or bound (`UnitValue.value`) stops the script; `__num` converts through a string.
- `app.fonts.getByName` returns null for every font, and reading all 10,000 font names takes over ten seconds; `__fontAt` binary-searches the list, which is in code-unit order, and the last 100 entries (fonts loaded from files) are checked one by one.
- Copying a layer to another document does nothing, so a picture is placed with `app.open(dataUrl, null, true)`, which inserts a smart object above the active layer but finishes only after the script ends; the next script handles the placed layer and echoes a retry mark until it exists, and the engine posts it again every 250 ms within the step timeout. A smart object cannot be cut, so `cover` turns it into pixels before cutting it to the box.
- Photopea skips a script with a syntax error and answers as if it ran, so `psd_script` compiles the body in Node first.

Edits run in one script per picture placement and a final script that inspects the document and saves the file and the preview, so changed text has been laid out before it is saved.

Delivery and browser lookup come from `@deepseek-ai/dsh-host-capture` (`deliverFile`, `resolveBrowserPath`).

</details>

-----

<a id="model-experience"></a>
## Model Experience

### Tools

#### What the model sees

Four tools on every Session. Each result is one text block: the document size, the layer list (at most `maxLayersListed` lines), missing fonts, the files written and an instruction to look at the preview. Errors are tool errors that name the layer, font or edit at fault; an unknown font lists fonts with a similar name.

#### Token effect

The four schemas ride every request, `psd_script`'s description the longest because it lists the interpreter's differences. Results are a few hundred tokens for a typical social template; the preview costs image tokens only when the model reads it.

#### KV Cache effect

The tool set is fixed for a Session's life, so the prefix stays cacheable.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Photopea is a third-party service.** The tools load photopea.com through its public embedding interface on each browser start; if it is down or changes that interface, the tools fail.
- **Fonts.** Photopea has about 10,000 free fonts; commercial fonts in a PSD (Adobe's, for example) are MISSING until the font file is supplied.
- **Smart-object contents** are not replaced inside the smart object: `image` places a new layer over the old one's box, which suits flat templates but not mockups with a perspective transform.
- **Layer effects** (shadows, strokes) stay on the original layer; a replacement picture does not inherit them.
- **Runtime invariant:** No companion is published; the plugin keeps no state beyond the browser it may close at any time.
