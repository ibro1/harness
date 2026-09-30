---
description: "Fork-local Klipara outreach employee: a daily shift Session that finds YouTube creators, makes each a free Klipara sample clip, pitches it by email or comment through the DeerFlow browser, and records replies, under code-enforced caps and a pause switch."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-klipara-scout

## Summary

Once a day this plugin starts a shift Session that works Klipara's outreach: it searches YouTube for creators posting long videos who do not clip them yet, has Klipara cut each one a free sample, pitches the sample by email or a context-aware comment, and records replies, alerting the owner on WhatsApp. The plugin enforces the daily sample and pitch caps, the pause switch, duplicate-pitch refusal and sample hosting in code; the model only chooses whom to pitch and what to say.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Configure it on **Plugins → Klipara Scout**: switch the shift on, set the start time and time zone, the daily caps, search topics, channel size and Shorts limits, the Klipara API key (created on Klipara's API keys page), the WhatsApp chat that hears about replies and pauses, optionally the model the shift runs on, and the fallback model (default `opencode` / `big-pickle`) a turn moves to when the shift's model fails. The leads, with their stage, sample, pitch and replies, are on their own page, **Plugins → Klipara Scout leads**, which the settings page links with **View leads**; it reads `/scout/leads.json` and refreshes every 15 seconds. Samples finish without anyone asking: every two minutes the plugin checks Klipara for finished jobs, exports and hosts each finished sample, and sends the latest shift Session a message listing them so it pitches them; when that Session is no longer live they wait for the next shift. While any pitch awaits an answer, the plugin also asks the shift to check Gmail and YouTube notifications every `replyCheckMinutes` (default 15; 0 leaves replies to the daily shift), starting one reply Session for the day when the shift is gone; no check runs with nothing pitched, while the shift is busy, or while paused.

When a scout Session's model request fails for a provider reason, the request moves to the fallback model and the shift's model is benched for every scout Session: until its quota resets when the failure says when ("Resets in 1h56m", or the provider's retry-after), otherwise for `fallbackCooldownMinutes` (default 15). A spent quota moves at once, skipping the harness's retries, which would only repeat the refusal; a server error or broken stream gets those retries first. While the model is benched, scout turns go straight to the fallback; the first turn after the bench ends tries it again. The owner hears once per outage on WhatsApp, with the time the shift's model is tried again. A failure another model would not fix is not moved: a context overflow, a cancel, or a run the CLI bridge's watchdog stopped because the page it drove hung. While a turn runs on the fallback, `scout_pitch` is refused unless **Pitch on the fallback model** is on, so pitches wait for the shift's model; reply checks and samples go on.

A lead moves `found → sampling → sampled → pitched → replied`, then `won` or `lost`; `skipped` records a channel passed over and why, so no later search reads it again.

The shift reads its instructions from the `klipara-scout` skill (`deploy/skills/klipara-scout/SKILL.md`). The tools:

| Tool | What it does |
|---|---|
| `scout_status` | today's caps and what is left, whether outreach is paused, leads per stage |
| `scout_search` | YouTube search for long videos from this month; checks each new channel's subscribers, Shorts count and public email; saves fits as `found`, the rest as `skipped` |
| `scout_search_podcasts` | searches Apple's podcast directory (in `podcastCountry`, default `ng`) for shows with an episode in the last `podcastActiveDays` (default 60), reads each new feed for the owner's contact email, finds the show's recent long video on YouTube, and saves fits as `found` leads with that email (`source: podcast`); adds the email to an existing lead of the same channel that had none; never reads a feed twice |
| `scout_leads` | lists leads, optionally one stage |
| `scout_make_sample` | starts a Klipara analysis job for a `found` lead (free); counts against the sample cap |
| `scout_check_sample` | when the job is done, exports the best standalone clip (one Klip), hosts it and records the public link |
| `scout_pitch` | reserves one pitch and records the exact text; refused without an outreach browser, when paused, on the fallback model unless allowed, over the cap, for an email without the sample link or with a "Re:"/"Fwd:" subject, a comment with any link, or at 60% word overlap with an earlier pitch |
| `scout_record_reply` | records a reply and alerts the owner on WhatsApp |
| `scout_update_lead` | closes a lead as won, lost or skipped |
| `scout_pause` / `scout_resume` | stops all outreach and alerts the owner / resumes it when the owner asks |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

State is one JSON file under `<DSH home>/klipara-scout`, replaced atomically with writes serialized; samples sit beside it. Discovery runs `yt-dlp` on listing pages only (a search results page filtered to long videos from this month, and a channel's Shorts tab), which load from a server address without cookies, so it never uses the cookie jar Klipara's ingest depends on. Podcast discovery reads Apple's public search API and the start of each show's RSS feed (stopping at the second episode, at most 3 MB) for `<itunes:owner><itunes:email>`; the sample is still cut from the show's YouTube video, matched by a channel link in the feed or by name, since a feed has no video. Klipara's export link expires within the hour, so each exported clip is copied at once, with a poster and a small record; the poster is Klipara's designed cover for the clip (`thumbnail_url`, a link as short-lived, so it is copied too), or a frame cut by `ffmpeg` one second in when the clip has no cover or it cannot be fetched. Once per start the plugin puts the cover on earlier samples that still show a frame, reading fresh cover links from the job's candidates (free). Each sample is served under `/scout/s/<id>`: the page, `.mp4` (range requests), `.jpg`, and `.json`, a public read-only record `{ id, title, creatorName, sourceVideoUrl, videoUrl, posterUrl, createdAt }` for the page Klipara serves at the sample link base (`sampleBaseUrl`, default `https://klipara.linkfa.de/s`), readable cross-origin from that base's origin. An id is 11 base64url characters, 64 random bits; a sample past `sampleTtlDays` (default 30) answers 404 like an unknown id. A one-minute timer starts at most one shift per local day, after the configured time and while outreach is not paused, as a root Session with id prefix `scout-`, the same sequence the webhook ingress uses; a start that fails is retried after 30 minutes and reported on stderr and WhatsApp. Unexpected failures (a shift or reply check that did not start, a search, Klipara call or sample copy that failed, an outreach pause) are emitted as `klipara-scout/failure` with the stage (`discover`, `sample`, `pitch`, `reply-check`), the lead or sample id, and the lead's own strings for redaction; error reporting (`@deepseek-ai/dsh-host-error-reporting`) reports them when it is loaded. Rule refusals are not failures. The tools are registered only on `scout-` Sessions and served to the agy and opencode CLIs over the token-guarded `/scout/command` route.

</details>

-----

<a id="model-experience"></a>
## Model Experience

Shift Sessions see the eleven `scout_*` tools and the opening message naming the skill file; other Sessions see none of them. Each tool returns one text block.

#### KV Cache effect

The tool definitions join a shift Session's prompt prefix once and stay stable across its turns.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The download browser is refused.** Calls to `mcp__<forbiddenBrowser>__*` (default `deerflow`) from a scout Session are denied at `tools/pre-execute`; the CLIs are kept off it by the deploy's relay.
- **Outreach needs its own account.** Nothing is pitched and no reply check runs until `outreachBrowser` names a browser tool server signed in to a dedicated outreach Google account: the DeerFlow browser's Google account is the one Klipara downloads YouTube videos with. The plugin refuses pitches without it, but which browser the model drives is only instructed, not enforced.
- **Sending is the model's job.** Emails go through Gmail and comments through YouTube in the DeerFlow browser, driven by the shift; the plugin reserves and records each pitch but cannot see the send itself.
- **Samples accumulate.** Hosted samples are kept until deleted by hand.
- **Runtime invariant:** No companion is published; the lead file is the only record and nothing else observes it independently.
