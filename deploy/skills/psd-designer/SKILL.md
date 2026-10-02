---
name: psd-designer
description: Edit Photoshop (PSD) files on request — social media graphics from a template, one-off text, picture and colour changes — and export them for posting. Use when someone shares a .psd or asks for a graphic built from one.
---

# PSD designer

You edit the owner's Photoshop files with the `psd_*` tools. They run Photopea, a full Photoshop-compatible editor, in the harness's own headless browser, so changed text is laid out and drawn again exactly as Photoshop would. Every result is a new file in the session outputs; the original is never changed.

## Order of work

1. Find the file. It must be in the session workspace (an upload lands there). If the person names a file you cannot find, ask for it instead of guessing.
2. `psd_open` it. Read the layer list and look at the preview. Note text layers marked MISSING: Photopea draws them in a substitute font, so the result will not look like the original.
3. Missing fonts: ask the person for the font file (.ttf or .otf) and pass it in `fonts` on every later call, or agree on a replacement font and set it with a `text` edit. Never deliver a design with a MISSING font without saying so.
4. Make the changes with `psd_edit`, all in one call where you can. Name layers as `psd_open` lists them; use the `@` reference when two layers share a name.
5. Look at the preview the tool returns, every time, before saying anything about the result. Check that new text fits its area (a longer headline can run off the canvas or over a picture), that a swapped picture shows the subject and not just its edge, and that nothing you did not mean to change has moved.
6. Fix what the preview shows (a smaller `size`, a `move`, `fit: contain`) and look again.
7. `psd_export` the finished file to what the person will post: PNG for graphics with text, JPG at quality 0.85–0.9 for photos, at the platform's size.
8. Reply with what you changed, the files (the edited PSD and the export), and anything you could not do.

## Social sizes

| Use | Size (px) |
|---|---|
| Instagram / Facebook feed, square | 1080 × 1080 |
| Instagram feed, portrait | 1080 × 1350 |
| Story, Reel or Status cover | 1080 × 1920 |
| X / LinkedIn post image | 1200 × 675 |
| YouTube thumbnail | 1280 × 720 |

To make the same design in another size, build it with `psd_script` on a blank document of that size, or ask whether the person has a template for it; stretching a square design to a story distorts it.

## Rules

- Change only what was asked. A request to change the date is not permission to restyle the headline.
- Keep the person's words exactly, including spelling and capitals, unless they ask you to edit the copy.
- Pictures you place must come from the person or the workspace. Do not download photos of people from the web.
- `image` edits hide the original layer instead of deleting it, so the PSD can be put back; mention this if the person will open the file in Photoshop.
- Use `psd_script` only for what `psd_edit` cannot do (new layers, shapes, a blank design). Its description lists how Photopea's script interpreter differs from JavaScript; follow it, or the script stops without saying why.
- Photopea loads from photopea.com. If a call fails because Photopea did not load, say so; do not try another route.
