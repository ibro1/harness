---
description: "Fork-local library shared by the harness's AI employees (Klipara Scout, the SEO employee): the daily shift Session, the fallback model for shift turns, and owner alerts over WhatsApp."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-employee-kit

## Summary

The parts every AI employee in this fork needs, kept in one place so a fix reaches all of them: deciding in the owner's time zone whether today's shift is due and starting it as a root Session, moving an employee's turns to a fallback model when its own model fails for a provider reason, and sending the owner a WhatsApp alert. It is a library: employees import it; it registers nothing by itself.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

- `localTime(now, timeZone)`, `parseShiftTime('09:00')` and `shiftDue(now, minutes, lastShiftDate)` decide whether a shift starts; `startShift(ctx, request, signal)` starts it as a root Session whose id begins with `request.sessionPrefix` (the employee recognises its own Sessions by it) and whose opening message has the source `request.source(summary)`, a kind the employee declares in `MessageSourceMap`.
- `FallbackRouter` and `installFallback(ctx, router, applies)` move the turns of Sessions for which `applies(agent)` holds to the configured fallback model when the shift's model fails for a provider reason, benching it until its stated quota reset or a cooldown; `router.onFallback(sessionId)` lets an employee hold outward-facing tools while a turn runs on the fallback.
- `whatsAppNotifier({ url, token, to })` returns `notify(text)`, which posts `whatsapp_send` to the WhatsApp plugin's command route and returns what happened (`sent to …`, `not sent (…)`, `failed: …`) without throwing.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`shift.ts` resolves the agent and permission presets, creates the workspace, attaches the Session, names it and hands it the prompt, undoing the attach and disposing the handle if any step fails. `fallback.ts` listens on `agent/request` (route choice) and `agent/request-error` (bench and retry on the fallback) with prepended waterfall listeners; a spent quota moves at once, other provider failures first get the harness's own retries, and a watchdog stop is not treated as a provider failure. `notify.ts` reads the recipient at send time, so a settings change applies without a restart.

</details>

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the fallback router, which changes which model serves an employee's turn after a provider failure; the library adds nothing to a request itself.

#### KV Cache effect

A turn moved to the fallback model starts a new provider cache; the next turn back on the shift model reuses that model's cache if it is still warm.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **One process.** The fallback bench is in memory; a restart forgets it, and the next failure benches the model again.
- **Runtime invariant:** No companion is published; the library owns no relation another observation could contradict.
