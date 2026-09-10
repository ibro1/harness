---
name: campaign-assets
description: Produce marketing campaign assets for any product from one content file — LinkedIn-sized comparison graphics plus a matching lead capture page, with optional per-brand voice rules. Use when the user asks for an infographic, LinkedIn graphic, campaign visual, social image, comparison graphic, lead magnet, landing page or capture page, or wants marketing assets for an outreach campaign.
license: MIT
allowed-tools:
  - bash
  - read_file
  - write_file
---

# Campaign assets

One JSON content file produces three LinkedIn-sized graphics and a lead capture
page that share the same headline. Rendering is headless Chromium against an
HTML template — no Node project, no `npm install`, no Puppeteer, no build step.

## Start with the brand, not the graphic

**Before generating anything, establish the brand.** A graphic in invented
colours with a letter where the logo goes looks fine in isolation and wrong
next to the real site — which is exactly how this skill failed its first real
test: the brand was purple (#4c1fb8) with a wordmark logo, and it produced cyan
graphics with an "F" in a box.

If `brands/<name>.json` does not already exist:

```bash
python3 scripts/brandinit.py https://theirsite.com brands/<name>.json
```

That reads the live site for the name, logo, palette and positioning line. Then
**show the user what it found and confirm it** — the colour ranking is
frequency-based and can pick a heavily used UI colour over the real brand one.

If there is no website, ask for: logo file or URL, primary colour, and any
words the brand does not use. Three questions, once per brand.

Ask about the **content** too. The copy in `content/*.json` is an example, not
a starting point — real numbers, real customer objections and the product's
actual differentiator are what make the graphic worth posting. Offer to read
their site, docs or positioning notes rather than inventing claims.

## Build

```bash
S=/mnt/shared/skills/custom/campaign-assets
bash $S/scripts/build.sh <content.json> <out-dir> [brand.json] [shape ...]
```

**Product-agnostic.** The brand file is optional and defaults to a neutral
preset with no voice rules, so this works for any product out of the box.
`brands/rainmaker.json` is one preset, not the point of the skill.

Writes the three graphics, `capture/index.html`, and **a preview PNG of the
capture page**, then runs the mode and brand checks.

The page preview is not decoration. Theming was once added to the infographic
template and not to the capture page, and nothing caught it: the build printed
three PNGs to look at and an HTML file nobody opened, so the page shipped with
white text on a brand's near-white background. Every build now shows all four
surfaces.

A **mode check** runs before rendering and refuses to stay quiet when
`bg_from` is light while `mode` is dark, or the reverse — the exact
contradiction behind that bug, and knowable from the config without rendering
anything. An earlier attempt measured pixel contrast in the render instead; it
passed a deliberately broken build, because a card and a logo keep the overall
luminance range wide even when the text is invisible.

Restrict shapes by naming them: `build.sh content.json out/ landscape square`.

**Add `WITH_GIF=on` whenever the request mentions animation, a GIF, movement,
or "for the feed"** — and offer it otherwise, because most people asking for a
LinkedIn graphic do not know it is available:

```bash
WITH_GIF=on bash scripts/build.sh content.json out/ brands/rainmaker.json
```

That produces the PNGs and the animated GIF in one run. It is off by default
because the GIF triples render time, and it was previously reachable only by
remembering a second script — which meant it never got produced.

Tune with `REVEAL=off` (a pulse rather than a progressive reveal),
`GIF_SHAPE=landscape`, `GIF_FRAMES=24`.

Output filenames and the badge letter derive from the brand name, so assets
for different products do not collide or carry someone else's initial.

Start from `content/missed-chats.json` — copy it, rewrite the copy, keep the
keys. `headline`, `left_title`, `right_title`, `left_items` and `right_items`
are required; everything else has a sensible default.

## Sizes, and why these

| Shape | Pixels | Use |
| --- | --- | --- |
| landscape | 1200 × 627 | Link shares, articles, sponsored content |
| square | 1200 × 1200 | Feed posts |
| portrait | 1080 × 1350 | Mobile-first feed, carousel slides |

LinkedIn rejects images over 5MB; the build prints each file's size and flags
any that exceed it rather than silently recompressing something about to be
published.

**Landscape deliberately carries less.** At 1.91:1 there is no room for a
headline, a subhead, eight bullets, two stats and a footer — the first attempt
clipped half of it and painted the footer over the cards. It now drops the
subhead and shows two bullets per side. One content file, three genuinely
different crops, not one layout squeezed three ways.

## Brand presets

A preset in `brands/` carries the palette, the badge letter and any voice
rules. With no preset, nothing is enforced.

```json
{
  "name": "Rainmaker", "badge": "R",
  "accent": "#22D3EE", "accent_2": "#3B82F6",
  "forbid": [
    { "pattern": "\\bAI[ -]agents?\\b", "why": "the product is an \"AI Employee\"" }
  ],
  "require": { "pattern": "\\bAI Employee\\b", "why": "that phrase is the positioning" }
}
```

`forbid` fails the build; `require` only notes its absence, because copy can be
right without hitting an exact phrase and a hard failure there is a style tax.

**Rules belong in the preset, never in the checker.** An earlier version
hardcoded one brand's — including a ban on dollar prices, which would have
rejected a perfectly good graphic for any product priced in dollars or euros.
A checker that fails correct work trains you to skip it.

Non-ASCII currency glyphs (₦, €) render correctly in the sandbox fonts —
verified, because a missing glyph ships as a tofu box in a price.

## The capture page

Built from the **same content file** as the graphics, so the headline in the
feed and the headline on the page cannot drift apart. That drift is the
ordinary way a funnel stops converting: someone edits the ad, nobody edits the
landing page.

One field. The bundled example defaults to a **WhatsApp number** rather than
email, which suits a Nigerian SME audience — they will give a number long
before an inbox. Change `field_*` in the content file for email or anything
else.

**Set `form_endpoint` before it goes anywhere near an ad.** Left blank, the
page refuses submissions and says so on screen. That is deliberate: a lead form
that appears to work and quietly drops submissions is worse than one that is
obviously broken, because the campaign runs, the impressions accrue, and the
leads are simply gone. A failed POST names the status rather than swallowing
it, so "nobody signed up" is distinguishable from "the form is down".

One product this ran for, for example, had `web/src/routes/api/leads/export.ts` but **no
capture route** — you would need to add one, or point `form_endpoint` at an
external collector.

`og_image` should be the public URL of the landscape PNG once uploaded, so the
share card is the graphic itself.

## Deploying the page

It is a single self-contained HTML file — no build, no dependencies. Either:

- Drop `capture/index.html` into a static host or the `public/` of an existing
  app, or
- Serve the directory from a container and point a Dokploy domain at it. Use
  the **dokploy** skill for the deploy itself rather than improvising commands

## Rendering notes

Worth knowing before changing `build.sh`:

**Chromium paints into a viewport ~87px shorter than the window it screenshots
at full size**, in both `--headless` and `--headless=new`. Asking for the
target height and trusting the result leaves a dead band along the bottom of
every graphic. The build renders into a taller window and crops to the exact
canvas, and the template gives `.frame` fixed pixel dimensions rather than
`inset:0` so the crop is exact.

**Verify renders by looking at them.** Measuring "is the bottom row non-black"
passed while the graphic was visibly broken, because the dead band renders
white. The build checks dimensions and a blank bottom edge, but neither catches
overlapping text or a clipped list. Open the PNG.

## Animated GIF

```bash
bash scripts/animate.sh <content.json> <out-dir> [brand.json] [shape] [frames]
```

Defaults to `square` and 20 frames over a 2s loop (a pulse). Roughly 17s.

For the **progressive reveal** — messages arriving in sequence, question then
answer, rather than a pulse drawing the eye:

```bash
REVEAL=on bash scripts/animate.sh <content.json> <out-dir> [brand.json] square 40
```

40 frames over a 4s loop, ~34s to build, measured at **0.61MB** for 1200x1200.
Needs message-card content (object `left_items`/`right_items`); with plain
string bullets there is nothing to reveal.

Each item has its OWN keyframe rather than a shared one with staggered delays.
Staggering a shared keyframe produces a rolling wave: by the time the loop
restarts, items 2-6 are still visible from the previous iteration, so only the
first ever appears to arrive. Measured — everything was on screen by 0.4s of a
4s loop. Per-item keyframes make all six reset together.

LinkedIn animates a GIF **only under 5MB and under 400 frames** — breach
either and it is shown as a still with no warning, which looks like it worked.
The script reports size and frame count and flags both.

Frames are captured by stepping the animation, not by waiting on it: a
headless screenshot always renders an animation at t=0, so every animated rule
is `animation-play-state:paused` with a negative `animation-delay` that places
it exactly where the frame needs it. Deterministic, and no timing races.

Two ffmpeg passes: `palettegen` builds a 256-colour palette from these frames,
then `paletteuse` with a bayer dither. The default palette bands a gradient
badly; this keeps it acceptable. A flat background bands less if you need
headroom.

Verify a GIF by counting changed pixels between frames, not by trusting the
frame count — twenty identical frames still report as twenty.

## After editing a template

```bash
python3 scripts/brandcoverage.py content/missed-chats.json landscape
```

Renders the same content with two wildly different accents and reports any
saturated colour that came out identical in both — those are hardcoded and
will stay cyan on a purple brand.

It also asserts the **canvas keeps the brand hue**. Pass the brand file as a
third argument to enable that:

```bash
python3 scripts/brandcoverage.py content/rainmaker-one-sentence.json square brands/rainmaker.json
```

The render-diff check cannot catch a bad DERIVED colour: a background computed
from the accent does change with it, correctly by its own logic — it just
changes to the wrong thing. An accent of #4c1fb8 (spread 153) produced a canvas
of #0d0a14 (spread 10): brand-derived, and visually near-black. The graphic
shipped looking like it had no background.

Both gradient stops must keep a colour spread of at least max(22, 14% of the
accent's). Near-neutral brands are skipped — there is no hue to preserve.

Run it after touching either template. This exact bug shipped three times:
the palette swap left a lighter cyan tint behind, the capture page kept
dark-mode text on a light background, and the eyebrow label stayed sky-blue
next to a purple dot. Every one was found by a person looking at a picture,
and every one takes this check about a second.

The red "problem" column is deliberately not brand-coloured and is listed as
expected, so the report stays short enough to read.

## Scope

This makes a comparison graphic and a capture page. It is not a general design
tool: for a different layout, add a template beside `comparison.html` and a
shape block in the CSS, rather than bending this one.

## Numbers need a source

`brandcheck.py` fails the build on any figure with a unit — `9 hours`, `73%`,
`₦3,500`, `2x` — that has no entry in the content file's `sources` map:

```json
"sources": {
  "9 hours to first reply": "illustrative",
  "34% of chats go unanswered": "https://example.com/report-2026"
}
```

A value of `"illustrative"` passes, loudly. The point is not to ban worked
examples, it is to stop a placeholder quietly becoming a claim.

This exists because earlier drafts shipped "9 hours to first reply" and a
₦3,500 Lekki price that the drafting agent invented. The risk grew as the
design improved: a guess set in the brand's real typeface on the brand's real
purple reads as measured fact.

## Comparing headlines

Add `headline_variants` to the content file and build with `VARIANTS=on`:

```json
"headline_variants": ["First option", "Second option", "Third option"]
```

```bash
VARIANTS=on bash scripts/build.sh content.json out/ brands/rainmaker.json square
```

You get `variants-sheet.png` — every version rendered at the same scale, side
by side and labelled A/B/C. Judging headlines one tab at a time compares each
against your memory of the last, and the most recent always wins. Use
`VARIANT_SHAPE=landscape` to change the shape rendered.

## Typography

If the brand preset has `font_file`, that woff2 is embedded as a data URI and
used for all copy. `brandinit.py` extracts it from the site's `@font-face`
automatically. Without it everything renders in DejaVu Sans, a Linux default
that belongs to nobody — which is what every graphic did while carefully
matching the brand's purple.

## Posting to LinkedIn

`scripts/publish.py` posts a built graphic to YOUR OWN feed. This uses the
self-serve `w_member_social` scope — free, granted instantly, no partner review.

One-time setup:

1. Create an app at <https://www.linkedin.com/developers/apps>, associated with
   a LinkedIn company page you administer (LinkedIn requires one even for
   personal posting).
2. Add two products: **Sign In with LinkedIn using OpenID Connect** and
   **Share on LinkedIn**. Both are self-serve and appear immediately.
3. Under Auth, add the redirect URL `http://localhost:8000/callback`.
4. Then:

```bash
export LINKEDIN_CLIENT_ID=...  LINKEDIN_CLIENT_SECRET=...
python3 scripts/publish.py auth      # paste the redirected URL back
```

Publishing:

```bash
python3 scripts/publish.py post out/rainmaker-square.png --text-from content/rainmaker-one-sentence.json
```

It prints what it is about to post and asks for confirmation; `--yes` skips
that. Add a `post_text` field to the content file to control the caption,
otherwise it falls back to the headline and subhead.

Limits worth knowing before building on this: the token lasts 60 days and the
self-serve tier grants **no refresh token**, so you re-run `auth` roughly every
two months. Posting as the company page needs Community Management approval
(free, 1–4 weeks). No LinkedIn API at any tier sends connection requests or
DMs, so outreach stays manual.

The token is written to `~/.config/campaign-assets/linkedin.json` with mode
600, never into this repo — it is a bearer credential for your identity and
this directory has a GitHub remote.

### Unattended posting

Publishing itself is fully automated — no browser, no clicking:

```bash
python3 scripts/publish.py post out/rainmaker-square.png --text "..." --yes
```

For scheduling, queue posts and let one cron line drain them:

```bash
python3 scripts/publish.py queue out/rainmaker-square.png \
        --text-from content/missed-chats-ui.json --at "2026-09-08 09:30"
```

```cron
*/15 * * * *  cd /mnt/shared/skills/custom/campaign-assets && python3 scripts/publish.py drain
0 9 * * 1     cd /mnt/shared/skills/custom/campaign-assets && python3 scripts/publish.py check
```

`drain` exits non-zero if anything failed or the token died, and `check` exits
non-zero once the token is within a week of expiring, so cron mails you before
the feed goes quiet rather than after. A scheduled job that has silently posted
nothing for three weeks is the expensive failure here, not a rejected post.

The only manual step is re-running `auth` every 60 days. Programmatic refresh
tokens are restricted to approved Marketing Developer Platform partners, and
even those expire after a fixed 365 days without extending — so re-authorising
periodically is unavoidable on any tier.
