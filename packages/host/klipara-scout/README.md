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

Configure it on **Plugins → Klipara Scout**: switch the shift on, set the start time and time zone, the daily caps, search topics, channel size and Shorts limits, the Klipara API key (created on Klipara's API keys page), the WhatsApp chat that hears about replies and pauses, and optionally the model the shift runs on. The leads, with their stage, sample, pitch and replies, are on their own page, **Plugins → Klipara Scout leads**, which the settings page links with **View leads**; it reads `/scout/leads.json` and refreshes every 15 seconds. Samples finish without anyone asking: every two minutes the plugin checks Klipara for finished jobs, exports and hosts each finished sample, and sends the latest shift Session a message listing them so it pitches them; when that Session is no longer live they wait for the next shift. While any pitch awaits an answer, the plugin also asks the shift to check Gmail and YouTube notifications every `replyCheckMinutes` (default 15; 0 leaves replies to the daily shift), starting one reply Session for the day when the shift is gone; no check runs with nothing pitched, while the shift is busy, or while paused.

A lead moves `found → sampling → sampled → pitched → replied`, then `won` or `lost`; `skipped` records a channel passed over and why, so no later search reads it again.

The shift reads its instructions from the `klipara-scout` skill (`deploy/skills/klipara-scout/SKILL.md`). The tools:

| Tool | What it does |
|---|---|
| `scout_status` | today's caps and what is left, whether outreach is paused, leads per stage |
| `scout_search` | YouTube search for long videos from this month; checks each new channel's subscribers, Shorts count and public email; saves fits as `found`, the rest as `skipped` |
| `scout_leads` | lists leads, optionally one stage |
| `scout_make_sample` | starts a Klipara analysis job for a `found` lead (free); counts against the sample cap |
| `scout_check_sample` | when the job is done, exports the best standalone clip (one Klip), hosts it and records the public link |
| `scout_pitch` | reserves one pitch and records the exact text; refused when paused, over the cap, without the sample link, or at 60% word overlap with an earlier pitch |
| `scout_record_reply` | records a reply and alerts the owner on WhatsApp |
| `scout_update_lead` | closes a lead as won, lost or skipped |
| `scout_pause` / `scout_resume` | stops all outreach and alerts the owner / resumes it when the owner asks |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

State is one JSON file under `<DSH home>/klipara-scout`, replaced atomically with writes serialized; samples sit beside it. Discovery runs `yt-dlp` on listing pages only (a search results page filtered to long videos from this month, and a channel's Shorts tab), which load from a server address without cookies, so it never uses the cookie jar Klipara's ingest depends on. Klipara's export link expires within the hour, so each exported clip is copied at once and served from `/scout/s/<id>` (a page) and `/scout/s/<id>.mp4`, where the id is 128 random bits. A one-minute timer starts at most one shift per local day, after the configured time and while outreach is not paused, as a root Session with id prefix `scout-`, the same sequence the webhook ingress uses; a start that fails is retried after 30 minutes and reported on stderr and WhatsApp. The tools are registered only on `scout-` Sessions and served to the agy and opencode CLIs over the token-guarded `/scout/command` route.

</details>

-----

<a id="model-experience"></a>
## Model Experience

Shift Sessions see the ten `scout_*` tools and the opening message naming the skill file; other Sessions see none of them. Each tool returns one text block.

#### KV Cache effect

The tool definitions join a shift Session's prompt prefix once and stay stable across its turns.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Sending is the model's job.** Emails go through Gmail and comments through YouTube in the DeerFlow browser, driven by the shift; the plugin reserves and records each pitch but cannot see the send itself.
- **Samples accumulate.** Hosted samples are kept until deleted by hand.
- **Runtime invariant:** No companion is published; the lead file is the only record and nothing else observes it independently.
