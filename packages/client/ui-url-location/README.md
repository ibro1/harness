---
description: "Fork-local: keeps the open panel and Plugins page in the address bar, so a refresh, the back button and a copied link return to the same page."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-url-location

## Summary

The app keeps the selected main panel and the Plugins page's view in memory only, so a refresh always opened the default screen. This browser plugin writes them into the address bar's hash (`#/plugins`, `#/plugins/item/<id>`, `#/plugins/package/<name>`, `#/<panel>`; none for a Session) and reopens them on load. Each move is a history entry, so back and forward walk through it, and a copied link opens the same page.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

The web-app bundle inserts it; there is nothing to configure. It follows `ctx.layout.panelInfo` and the Plugins panel's view through `pluginNavigation.view()` / `subscribe()`, and applies an address with `ctx.layout.selectPanel` or `pluginNavigation.show()`. Panels and plugin pages register while the app starts, some after a request to the Host, so an address is retried every 200 ms for up to 20 s; nothing is written to the address bar until it is showing or abandoned.

The sign-in page's redirect drops the hash. The sign-in page saves a `#/` hash to `sessionStorage` (`dsh-url-location`) before the form is sent, every move in the app records the tab's current address there too, and the app opens that address when it starts with no hash. A move back to a Session records an empty address, so refreshing a Session stays on it.

-----

<a id="model-experience"></a>
## Model Experience

### Address bar

#### What the model sees

Nothing: the plugin changes only the browser's address and history.

#### Token effect

None.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The open Session is not in the address.** A refresh on a Session shows the app's default Session view; putting the Session id in the address is a separate change.
- **Runtime invariant:** No companion is published; the plugin owns no state beyond the address bar and one `sessionStorage` key.
