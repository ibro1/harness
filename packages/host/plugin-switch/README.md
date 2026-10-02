---
description: "Fork-local on/off switches and status routes for deployment plugins that have no settings form, shown as cards on the Plugins page."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-plugin-switch

## Summary

Gives the deployment's form-less plugins a card on the Plugins page: an on/off switch, whether the plugin can work, the facts it reports, and its own test. The plugins are PSD tools, page capture, session outputs, composer uploads, the session-tools and agent-tools routes for agy and opencode, the background-job notifier and the LLM gateway. They are `--patch` overlays, composed after the profile that holds Plugins-page edits, so a settings form could not take a saved value for them; their state lives in `<DSH home>/plugin-switches.json` instead.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

A plugin calls `mountSwitch(ctx, { id, defaultEnabled, health, test? })` and reads `isOn()` at the moment it acts: when it gives a new agent its tools, and when a tool or route is called. `gateTools(tools, isOn, title)` makes tool definitions refuse while off. Another plugin reads a switch with `isSwitchedOn(id, defaultEnabled)` (the CLI session-tools route honours the outputs, capture and PSD switches this way).

Routes, behind the harness sign-in:

| Route | Answer |
|---|---|
| `GET /plugin-switch/<id>` | `{ id, enabled, healthy, facts, problem?, canTest }` |
| `POST /plugin-switch/<id>` `{"enabled": bool}` | the new status; anything else is a 400 |
| `POST /plugin-switch/<id>/test` | `{ ok, message }` from the plugin's own check |

The browser half is in `@deepseek-ai/dsh-client-ui-settings-operations` (`SwitchCard`), which shows a card for each id in its list whose status route answers JSON. A fact's `key` must be one that card names (`SWITCH_FACTS`); others are not shown.

The file is read at most once a second and only re-parsed when its modification time changes. A damaged file is logged and read as empty, so every plugin falls back to its default.

-----

<a id="model-experience"></a>
## Model Experience

### Switched-off tools

#### What the model sees

A plugin that is off gives new agents none of its tools. An agent created while it was on keeps the tool in its list, and a call returns the tool error `<plugin> is switched off on the Plugins page; ask the owner to switch it on.`

#### Token effect

Switching a tool plugin off removes its schemas from new Sessions.

#### KV Cache effect

None for existing Sessions: their tool lists do not change.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Open Sessions keep their tool lists.** Switching on does not add tools to an agent created while the plugin was off; a new Session gets them.
- **Runtime invariant:** No companion is published; the switch file has one writer, this package.
