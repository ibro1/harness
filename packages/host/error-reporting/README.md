---
description: "Fork-local production error reporting to a Sentry-compatible server (GlitchTip), set up on its own Plugins page: scrubbed server, plugin, session, scout and Web UI errors, with the SDK loaded only once a DSN is set."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-error-reporting

## Summary

Reports the harness's production errors to a Sentry-compatible server (the self-hosted GlitchTip at bug.linkfa.de) with the official Sentry SDKs, pinned to 10.75.3. It is set up on its own page, **Plugins → Error reporting**; until a DSN is saved there (or `SENTRY_DSN` is set) it stays idle and the SDK is not loaded. Every report passes a privacy scrubber first: the harness holds outreach data, and a report keeps only what locates a fault.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Open **Plugins → Error reporting**, paste the DSN of the GlitchTip project (GlitchTip: project → Settings → Client Keys; it holds the server address, `https://<key>@bug.linkfa.de/<project>`) and save. Within a few seconds, without a restart, the status line reads **On. Reports go to https://bug.linkfa.de · project N · production**; **Send test error** sends one event and shows its id, and the event appears in GlitchTip as "Harness error-reporting test event", tagged `test=true`. The DSN is write-only (`role('secret')`): it never returns to the browser, the field stays blank, and a blank field keeps the saved DSN; **Remove DSN** turns reporting off. The page also sets the browser DSN (empty uses the DSN), environment (default `production`), release, and trace sample rate (0, tracing off). Any `SENTRY_DSN`, `SENTRY_PUBLIC_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE` or `SENTRY_TRACES_SAMPLE_RATE` set in the deployment's environment wins over the page field it matches, and the page says so. `DSH_ERROR_REPORTING=0` leaves the plugin out. The log says `sentry_enabled` (with the source, host and project) or `sentry_disabled`, never the key. Without the page: `curl -s -X POST -H "Authorization: Bearer $DSH_AUTH_API_TOKEN" http://127.0.0.1:3081/api/monitor/test`.

What is reported, each through the scrubber:

| Source | Tags |
|---|---|
| a plugin that failed to start or crashed (its Cordis fiber FAILED) | `source=plugin`, `plugin=<name>` |
| error-level log lines, at most one per logger per 5 minutes and 30 a minute overall | `source=log`, `logger`, `plugin` |
| uncaught exceptions and unhandled rejections, flushed while the harness shuts down | `source=process`, `mechanism` |
| a route handler that threw (`webserver/request-error`) | `source=request`, `method`, `route` (path only) |
| a failed agent turn, as the error message and stack only | `source=session`, `provider`, `model`, `session_id`, `plugin` |
| a Klipara Scout failure (`klipara-scout/failure`) | `source=scout`, `plugin=klipara-scout`, `stage` (discover, sample, pitch, reply-check), `lead_id` or `sample_id` |
| Web UI window errors, unhandled rejections and error-boundary crashes | `runtime=browser`, `route`, `slot` |

Not reported: 401/403/404, aborts and cancellations, spent quotas and rate limits, failures the harness says it will retry, and in the browser "Failed to fetch" and "Load failed". The user on a report is a 12-character hash of the account name, nothing else.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`index.ts` re-reads its settings every `checkEveryMs` (5 s; volatile fields carry no change signal) and on each status or test request; a changed DSN, browser DSN, environment, release or rate closes the running client and starts a new one, and an empty DSN closes it. `GET /api/monitor/status` answers the page's status line (on or off, source, host, project, environment; never the key). Each client is `@sentry/node` with no default integrations (so no sessions, console, HTTP or local-variable capture), `linkedErrors`, `dedupe` and `functionToString` only, no breadcrumbs, no client reports, and OpenTelemetry set up only when `tracesSampleRate` is above 0. Tags ride each `captureException` call, not a scope: the SDK runs without async context here, and a scope would carry one report's tags into the next. Failed plugins are found by scanning the registry at start and by `internal/status`, and their error read from `fiber.await()`. The process listeners only report; the harness's own fatal handler still decides the exit, and its shutdown disposes this plugin, whose disposer flushes (`Sentry.close(2000)`).

`scrub.ts` is dependency-free and shared with the browser. It drops cookies, headers, request bodies, query-string values, breadcrumbs, local variables and every user field but `id`; replaces the value of any key naming people, outreach content, model traffic or credentials (`email`, `name`, `handle`, `pitch`, `reply`, `comment`, `title`, `prompt`, `messages`, `transcript`, `output`, `args`, `token`, …) at any depth; redacts email addresses, phone numbers, API keys, bearer tokens, JWTs and OAuth codes in every string; keeps only the allowed tags; and removes caller-named strings (a lead's channel name, address and video title) wherever they appear.

The Web UI gets `globalThis.__DSH_SENTRY__` (the public DSN in canonical form, the tunnel path, environment, release, user id) through `webserver/index-inject` on every page render, so no DSN is built into the client, and a `<script src="/api/monitor/sdk.js">` that esbuild bundles from `browser.ts` on first request. The browser SDK posts to the tunnel (`tunnel.ts`): same-origin and behind the password gate like every `/api/` route, it forwards only an envelope whose header DSN equals the public DSN, to `https://<host>/api/<projectId>/envelope/?sentry_key=<publicKey>&sentry_version=7` (GlitchTip answers 403 without `sentry_key`), with a 1 MB cap, a per-address rate limit (60 a minute), a 5 s timeout, no caller cookie or header, and no body logged. A mismatched DSN gets 403.

</details>

-----

<a id="model-experience"></a>
## Model Experience

None, as the reporter observes failures and sends scrubbed reports and registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Names in free text.** A creator's name inside an error message is only removed when the caller names it (scout failures pass the lead's own strings). The browser has no such list, so a UI error message that quotes a channel name would carry it; addresses, phone numbers and keys are still redacted by pattern.
- **Signed-in pages only.** The tunnel sits behind the password gate, so the login page's own errors and reports from an expired session are not delivered.
- **Log lines written straight to stderr** (the fork's plugins log progress with `process.stderr.write`) are not log records and are not reported; their failures reach reporting through the events above.
- **Runtime invariant:** No companion is published; the reporter observes other packages' failures and owns no relation another observation could contradict.
