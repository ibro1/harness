---
description: "Fork-local responsive layer: a mobile stylesheet and drawer scrim that adapt the desktop-only web GUI layout and settings modal to small screens."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-mobile

English | [中文](README.zh.md)

## Summary

The web GUI ships desktop-only widths — a JavaScript-driven three-column grid with no CSS breakpoints — so on a phone the sidebar keeps a desktop rail and the settings modal clips. This plugin injects one global stylesheet, active below 768px, that gives content the full width, turns an expanded sidebar into an overlay drawer, and makes the settings modal full-screen and scrollable. It mounts one scrim so the drawer closes on a tap outside it or once a session opens inside it.

## Table of Contents

- [Understand the implementation](#understand-the-implementation)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

The stylesheet changes no component: it targets stable `data-*` hooks on the layout frame (`data-shell-frame`, `data-shell-sidebar`, `data-shell-center`, `data-rightbar-col`) and the settings panel (`data-settings-panel`, `data-settings-content`), overriding the inline widths the base layout sets.

The scrim is the one element the package renders, into `shell.overlay`. CSS shows it only while a phone has the drawer open, and it closes the drawer two ways: a tap on the scrim, and the main view coming to retain a different session. The second follows the outcome rather than a tap on a row, because a row is only one of the ways a session becomes current. Both call the layout toggle, so both first check the sidebar is expanded — firing the toggle on a collapsed rail would open the drawer instead.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **The collapsed sidebar rail stays in flow on mobile**, so its existing toggle button remains reachable to open the drawer. A fully off-canvas rail with its own hamburger control is deferred, because that control needs a localized label.
- **Breakpoint is a fixed 768px**, not configurable, and the scrim repeats it in TypeScript because a media query cannot be read from the stylesheet it belongs to.
- **Presentation only**: the package holds no copy of its own and no durable state.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The stylesheet selects the layout frame by attribute, so an upstream rename of a
`data-*` hook silently drops a rule rather than failing a build. The rightbar
rename is the precedent: the details column became `data-rightbar-col` and
`data-details-collapsed` became `data-rightbar-collapsed`.

</details>

**Runtime invariant:** No companion is published. The package injects one stylesheet and renders one scrim over state the layout service owns, so no two observations of it can diverge.
