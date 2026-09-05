---
description: "Fork-local responsive layer: a mobile stylesheet that adapts the desktop-only web GUI layout and settings modal to small screens."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-mobile

## Summary

The web GUI ships desktop-only widths — a JavaScript-driven three-column grid with no CSS breakpoints — so on a phone the sidebar keeps a desktop rail and the settings modal keeps its two-column panel and clips. This plugin injects one global stylesheet, active below 768px, that lets the content take the full width, turns an expanded sidebar into an overlay drawer instead of a squeezing column, and makes the settings modal full-screen and scrollable.

It changes no component: it targets stable `data-*` hooks on the layout frame (`data-shell-frame`, `data-shell-sidebar`, `data-shell-center`, `data-shell-details`) and the settings panel (`data-settings-panel`, `data-settings-content`), overriding the inline widths the base layout sets.

## Known Limitations and Deferred Work

- **The collapsed sidebar rail stays in flow on mobile**, so its existing toggle button remains reachable to open the drawer. A fully off-canvas rail with its own hamburger control is deferred, because that control needs a localized label and lives outside this CSS-only plugin.
- **Breakpoint is a fixed 768px**, not configurable.
- **Presentation only**: the plugin injects a stylesheet and holds no state, no services, and no copy.
