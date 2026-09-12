---
description: "Page capture with evidence: screenshot a URL through the DevTools Protocol and return the geometry read back from the live DOM alongside the image."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-capture

## Summary

One tool, `capture_page`, screenshots a web page and measures it. It drives Chromium over the DevTools Protocol, so the same call that produces the PNG also reads the page's geometry out of the live DOM: `scrollWidth` against the viewport width, the title and final URL after redirects, the `currentSrc` of every image that failed to load, the bounding box of an optional CSS selector, and how many elements the document holds.

What this gives you over `chromium --headless --screenshot` is the numbers. A PNG on its own cannot distinguish an element that failed to render from one the screenshotter failed to capture, and headless Chromium drops content quietly — below-the-fold lazy images most of all. A capture that reports `scrollWidth 1620 vs viewport 1280` states horizontal overflow as a measurement rather than an opinion, and `brokenImages: []` answers "is that image broken?" without anyone squinting at a picture. Prefer this tool whenever a claim about a page has to be checked rather than eyeballed.

Lazy content is forced to load before the shot: every `img[loading=lazy]` is set to eager with its `src` re-assigned, the document is scrolled in steps and returned to the top, and outstanding image loads are awaited. `captureBeyondViewport` alone does not do this — it paints a taller surface without ever requesting the images below the fold.

The PNG goes to the session's outputs drawer through the `outputs` capability when that plugin is mounted. The capability is read per call and consumed optionally: with no `outputs` service, the file is written to `<session cwd>/<fallbackDir>` (`edit` by default) and the result says where.

Chromium is resolved on PATH as `chromium-browser`, then `chromium`, then `google-chrome` and `google-chrome-stable`, matching the `campaign-assets` skill so both surfaces pick the same browser; `browserPath` overrides it. A missing browser fails the call naming every candidate tried, rather than producing a blank file.

## Safety

The URL comes from a model, so it is screened before any browser starts. Only `http` and `https` are accepted, credentials in the URL are refused, and the hostname is resolved first: every address it answers with must be publicly routable, which is why a public-looking name that resolves to `127.0.0.1` is refused. Loopback, `0.0.0.0/8`, RFC1918, CGNAT (`100.64.0.0/10`), link-local (`169.254.0.0/16`, carrying cloud instance metadata), documentation, benchmarking, multicast and reserved IPv4 ranges are all refused, as are `::`, `::1`, `fc00::/7`, `fe80::/10`, `ff00::/8`, and the IPv4-mapped, IPv4-compatible, NAT64 and 6to4 spellings of any refused IPv4 address. The screened address is pinned into the browser's own resolver with `--host-resolver-rules`, so a second lookup cannot move the capture somewhere the screen never saw. This matters because the harness runs its own web server and several bridges on loopback: a screenshot tool that can reach them is a credential-reading tool.

Every launch is one browser per call, with `--no-sandbox` (uid 1000 with no user namespaces) and `--disable-dev-shm-usage` (a small container `/dev/shm` crashes the renderer mid-capture), a private profile directory that is deleted afterwards, and a hard timeout that kills the process. The browser is killed in a `finally`, so a wedged Chromium does not outlive the tool call. `width`, `height`, `deviceScaleFactor` and `waitMs` are clamped to configured ceilings, and a bitmap over `maxPixels` loses height until it fits; every clamp is reported in the result.

## Config

| Field | Default | Meaning |
|---|---|---|
| `maxWidth` / `maxHeight` | 3840 / 4320 | Largest viewport one call may ask for, in CSS pixels. |
| `maxDeviceScaleFactor` | 3 | Largest device pixel ratio. |
| `maxWaitMs` | 15000 | Longest settle time after load. |
| `maxFullPageHeightPx` | 20000 | Tallest full-page capture; taller documents are cut here and the result says so. |
| `maxPixels` | 40000000 | Largest bitmap one call may allocate, in device pixels. |
| `launchTimeoutMs` | 20000 | Wait for the browser's DevTools endpoint. |
| `loadTimeoutMs` | 30000 | Wait for the page's load event. |
| `hardTimeoutMs` | 90000 | The browser is killed after this, whatever it is doing. |
| `scrollStepMs` | 120 | Pause after each scroll step while forcing lazy content. |
| `browserPath` | `''` | Explicit browser path; empty searches PATH. |
| `fallbackDir` | `edit` | Directory under the session cwd used when no `outputs` capability is mounted. |

## Model Experience

- `capture_page` — takes `url` (required), `width`, `height`, `fullPage`, `deviceScaleFactor`, `mobile`, `waitMs`, `selector` and `darkMode`.
- The result carries `text` (the capture summarized for reading) plus the structured fields a claim can be checked against: `finalUrl`, `title`, `image`, `viewport`, `scrollWidth`, `scrollHeight`, `horizontalOverflowPx`, `elementCount`, `paintedElementCount`, `imageCount`, `brokenImages`, `clamped`, `notes`, and `selector` when one was given.
- `elementCount` against `paintedElementCount` separates "it rendered nothing" from "it rendered off-screen"; `horizontalOverflowPx` greater than zero means the page scrolls sideways.

## What the guard does not cover

`capture_page` screens its own URL and refuses loopback, RFC1918, CGNAT, link-local and the IPv6 spellings of each, then pins the screened address into the browser. That holds for this tool.

It is not a system guard. On its first real test the agent was refused `http://127.0.0.1:3081` and immediately tried a different browser tool instead; that attempt failed only because the remote browser runs outside the container and has no route to its loopback. Network topology stopped it, not policy. Any deployment where another network-touching tool does have such a route should treat address screening as a shared seam rather than as something each plugin carries privately.

## Known Limitations and Deferred Work

- **Subresources are not screened.** The page's own address is checked and pinned, but Chromium fetches whatever that page asks for, including from private addresses. Point this tool at pages you would open in a browser, and keep the harness's own services off routable addresses.
- **`brokenImages` lists at most 50 entries** and covers `<img>` only; CSS backgrounds, `<picture>` sources that fell back, and failed `<video>` posters do not appear.
- **A full-page capture is one screenshot**, so a document taller than `maxFullPageHeightPx` is cut rather than tiled.
- **Only the first match of a selector is measured and clipped**, though `selector.count` reports how many matched.
- **No cookies, storage, or authentication.** Every capture starts from an empty profile, so a page behind a login renders as its logged-out state.
