---
description: "Fork-local YouTube niche scout: a weekly shift that researches YouTube niches, outlier channels and long-tail keywords for a faceless long-form commentary channel, scores 5–8 niches and sends the owner a report with one recommendation."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-youtube-niche-scout

## Summary

A weekly research run that decides which YouTube niche the owner's new faceless, AI-hosted long-form channel (8–15 minute, 16:9 commentary) should enter. It finds outlier videos and young channels with the YouTube Data API, expands seed topics into long-tail searches with YouTube and Google autocomplete, scores niches on demand, outlier evidence, RPM, competition, policy risk and production fit, and sends the owner a signed report link on WhatsApp with the recommendation. Reports are kept, so weeks can be compared.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

The web-app bundle inserts it when `DSH_DEPLOY=1` (`DSH_YOUTUBE_NICHE_SCOUT=0` leaves it out); it runs nothing until switched on at **Plugins → YouTube niche scout**, where the owner saves a YouTube Data API v3 key (or the deployment sets `YOUTUBE_API_KEY`), the WhatsApp recipient, the weekly day and time, seed topics, markets and languages, and the quota limits. **Run research now** starts a run at once; a second start within 15 minutes of the last is refused.

Each week a root Session (id `yns-…`) runs the `youtube-niche-scout` skill (`deploy/skills/youtube-niche-scout/`). Tools, on `yns-` Sessions only and to agy and opencode over `deploy/mcp/yns-mcp.mjs`:

| Tool | What it does and refuses |
|---|---|
| `yns_status` | seeds, markets, languages, quota used today, this run's searches and saved niches, earlier reports |
| `yns_search_outliers` | `search.list` (most viewed, `videoDuration` medium or long, `publishedAfter`) plus `videos.list` and `channels.list`: outlier videos and young outlier channels, and how crowded the topic is; 102 units, free when cached; refused past the day's quota or the run's search cap |
| `yns_channel` | one channel by id, handle or address, with its latest 50 uploads: cadence, median views, length mix, best videos; 3 units |
| `yns_keywords` | YouTube (`ds=yt`) and Google autocomplete for a seed, alone, with question words, or with a–z; no quota |
| `yns_save_niche` | saves a scored niche; sets RPM from the category table and markets, raises policy risk to the category floor (7 when the format needs others' footage), computes the score; refuses example channels the tools never read and an outlier score of 4+ without one |
| `yns_write_report` | needs 5+ saved niches (shows the top 8), a recommendation among them and 10–20 distinct titles of at most 100 characters for each of the top three and the recommended niche; publishes the page and sends the WhatsApp message |
| `yns_reports` | earlier reports with rank changes and links |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

State is one JSON file, `<DSH home>/youtube-niche-scout/state.json` (mode 0600), with writes serialized: runs and the niches saved in each, reports (kept), quota units per Pacific day, caches of searches, channels and suggestions (reused for `cacheDays`, default 6, so each weekly run reads fresh data), and the key that signs report links. Every YouTube call is charged before it is made (`quotaCharger`): the call is refused when it would pass `dailyQuota` (default 10,000 units, YouTube's default per key per day, reset at midnight Pacific) or, for `search.list` (100 units), the run's `searchesPerRun` (default 20). A run opens when a shift starts; a tool call outside one opens one, and a run left open for two days or superseded by a new start is marked abandoned.

`scoring.ts` holds the arithmetic. A video is a **strong** outlier when its channel is at most `maxChannelAgeMonths` (default 12) old and the video has at least 3× the channel's subscribers (floored at 1,000) and 20,000 views; **moderate** at 2× and 10,000 on a channel under twice that age, or 5× and 50,000 on a channel under 100,000 subscribers (5× its average views when the count is hidden). A channel is an outlier when young, with at most 60 videos averaging 10,000 views and 100,000 views per month of its life. The RPM table gives a creator-RPM band per category for tier-1 audiences, scaled by 0.55 for tier-2 and 0.2 for other countries; its score is 2 plus the band's midpoint over $2.50, capped at 10. The niche score is demand 20%, outliers 25%, RPM 20%, room 15%, safety (10 − policy risk) 10%, production fit 10%, out of 100.

The weekly timer checks each minute: a run is due when the latest slot (`weekday` at `shiftTime` in `timeZone`) has passed and no scheduled run started on or after that date, so a slot missed while the server was down runs when it returns. Runs need a key and `enabled`. The report page `GET <path>/r/<id>?sig=` (HMAC of the id) works without the harness sign-in. `GET <path>/status` and `POST <path>/action` (`run-now`) are signed-in only; `<path>/command` serves the tools to the CLIs with the bearer token. WhatsApp messages go through the WhatsApp plugin's command route and read its `{ result: { error } }` refusals. `yns-` Sessions may not use the DeerFlow browser.

</details>

-----

<a id="model-experience"></a>
## Model Experience

### Research tools

#### What the model sees

Seven `yns_*` tools on `yns-` Sessions only. Each answers in one text block; a refusal is a tool error naming every rule broken.

#### Token effect

The schemas ride every request of a run; a search lists at most 15 outlier videos, 8 young channels and 5 other results, and autocomplete at most 80 suggestions per source.

#### KV Cache effect

The tool set is fixed for a Session's life, so the prefix stays cacheable.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No search volumes.** Keyword Planner lives with the SEO employee behind per-site Google Ads sign-in and is not called here; Google Trends' explore endpoint answers this server with HTTP 429. Demand rests on autocomplete breadth, view counts and outliers.
- **Channel age is creation date.** The first upload date would cost a page per 50 uploads; an old channel relaunched in a new niche reads as old.
- **RPM is a maintained table**, not the owner's analytics; it moves with season and audience.
- **Runtime invariant:** No companion is published; the state file is the only record and nothing else observes it independently.
