---
description: "Browser control through an operator-installed extension: one authenticated WebSocket the browser holds open, and the six tools that drive the page through it."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-browser-bridge

## Summary

`dsh-host-browser-bridge` lets an agent drive a real browser that this process cannot reach. A companion extension in the operator's browser dials in and holds one WebSocket open; the bridge sends commands over it and awaits correlated replies. It drives the browser the operator already uses — signed-in sessions, saved passkeys, corporate SSO — rather than a clean automation profile, which is the point and also the risk.

The extension owns page semantics: what a snapshot ref denotes, how far a scroll moves, when a page has settled. This package owns transport, authentication, correlation, and the six model-facing tools.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

```yaml
- name: '@deepseek-ai/dsh-host-browser-bridge'
  config:
    path: /browser-bridge
    token: !!js process.env.DSH_BROWSER_BRIDGE_TOKEN ?? ''
    commandTimeoutMs: 30000
```

`token` is required: the bridge refuses to mount with an empty one rather than exposing an unauthenticated command channel. Load `deploy/browser-extension/` as an unpacked extension and give it the same token and the `wss://` URL of `path`.

### Authentication

The token travels in the upgrade query string, because a browser cannot set request headers on a WebSocket. Two consequences the operator owns:

- The route registers with `authenticate: false`. It is not covered by the deployment's password gate; the token is its whole authentication.
- Query strings are the part of a URL most likely to reach a proxy or access log. Treat the token as a credential that may be written down somewhere, and rotate it accordingly.

A presented token is compared against the configured one in constant time over SHA-256 digests. A mismatch destroys the socket with no response, so the endpoint tells an unauthenticated caller nothing about whether it exists.

### Behavior under failure

Every command settles. A command with no connected browser, one the extension reports as failed, one the extension never answers within `commandTimeoutMs`, and one in flight when the browser disconnects all reject with text naming the cause, and that text reaches the model.

<a id="understand-the-implementation"></a>
## Understand the implementation

One connection per profile label, which the extension sends as `?label=` and which defaults to `default`. A second browser connecting under the same label replaces the first; under a different label it joins alongside. Replacement is not a disconnect: commands in flight stay pending and are answered by the new connection, which matters because MV3 service workers are evicted and restarted routinely. A disconnect fails only the commands sent to that profile.

Two browsers are two targets, not a race. When several are connected and a tool names none, the call is refused with the labels listed rather than sent to whichever socket happens to be there — a snapshot read from one browser and a click sent to another is the failure this prevents.

Commands carry a UUID; replies are matched to it, so concurrent commands settle independently of arrival order.

<a id="model-experience"></a>
## Model Experience

Seven tools reach the model: `browser_profiles`, `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_scroll`, `browser_wait`. All but the first take an optional `profile`, needed only when more than one browser is connected; `browser_profiles` lists the labels. All six share one output value — the extension's reply as text — because the commands differ in what they do to the page, not in what they report.

`browser_snapshot` dominates token cost. It renders the viewport as an indented outline of the page's interactive elements and its text: each control carries a `[ref]` the click and type tools take, and quoted lines with no ref are what the page says. Page text is bounded separately from the controls, so a prose-heavy page cannot push the controls out of the snapshot; and is capped at roughly 100 elements and 8000 characters with an explicit truncation footer; `full: true` renders the whole page. Values of password and secret-looking fields are masked. A snapshot is a fresh observation each time and is not cached, so a loop of act-then-snapshot grows the context by roughly one snapshot per step.

Refs are stable across consecutive snapshots of the same page, so a model that re-snapshots after scrolling does not have to relearn numbering. A ref whose element has left the document reports that it is stale rather than acting on whatever now occupies its position.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **The extension is the trust boundary, and it is wide.** The bridge drives the operator's own signed-in browser with `<all_urls>` host permissions. Anything the operator is authenticated to, an agent holding this channel can act as. There is no per-origin allowlist; a dedicated browser profile is the only isolation currently offered, and it is advisory.
- **The profile label is operator-assigned.** Chrome cannot reliably report which profile an extension runs in, so the label is typed into the extension's options. Two browsers given the same label displace each other, silently, exactly as one browser reconnecting does.
- **Only http and https, only the active tab.** `navigate` refuses other schemes, and commands act on the active tab of the last-focused normal window. There is no tab management, no window targeting, and no download or file-chooser handling.
- **Text is bounded, and the bound is arbitrary.** Page text stops at roughly 3000 characters with a note saying so, chosen to leave room for controls rather than from any measurement of what a model needs.
- **The snapshot cannot see event listeners.** An isolated content script cannot read `addEventListener` handlers, so a clickable element with no role, no `tabindex`, and no pointer cursor is invisible to it. Closed shadow roots, cross-origin iframes, and canvas-rendered UIs expose nothing.
- **Change detection after a click is heuristic** — a fixed settle window over URL, title, and mutation count. A slow navigation can be reported as no change.
- **No REAL-composition coverage of the extension.** The bridge's tests boot a real composition and drive it with a WebSocket client standing in for the extension; the extension's own page semantics are unrun code until exercised in a browser.
