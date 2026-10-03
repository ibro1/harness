---
description: "Fork-local tools employee: a weekly shift that picks small web tools by keyword evidence, proposes a shortlist to the owner, and builds, tests and publishes the approved ones to the static site tools.linkfa.de."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-tools-employee

## Summary

A weekly employee that grows tools.linkfa.de, a static site of calculators, converters and checkers meant to earn display-ad revenue later. It researches keywords for free (Google autocomplete, Keyword Planner volumes borrowed from the SEO employee, and Google's first page read in the harness's own Chromium), puts each keyword through a gate enforced in code, sends the owner a signed shortlist on WhatsApp, and builds only the tools the owner approves: known-answer tests, sourced content and JSON-LD, published at a capped weekly pace by pushing the site's working copy to the repository a Dokploy app builds from. It reviews Search Console weekly and says when the site is ready for AdSense.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

The web-app bundle inserts it when `DSH_DEPLOY=1` (`DSH_TOOLS_EMPLOYEE=0` leaves it out). The card at **Plugins → Tools employee** shows the site's state, the shortlist awaiting approval, the published tools with their tests and Search Console numbers, AdSense readiness, and the settings: weekly day and time, WhatsApp recipient, seed topics and markets (row by row), new tools a week (capped at 5), results pages a day (capped at 20), the AdSense client id, the Search Console property and service-account key, the SEO employee site whose Keyword Planner access to borrow, the site repository and an optional Dokploy deploy hook. **Run now** starts a research run (refused within 15 minutes of the last start); **Publish site now** republishes the site as it is; **Check site** reads the live `build.json`.

Runs are root Sessions (id `tle-…`) on the `tools-employee` skill (`deploy/skills/tools-employee/`). An approval on the review page or a WhatsApp reply `build 1,3` starts a build run at once. Tools, on `tle-` Sessions only and to agy and opencode over `deploy/mcp/tle-mcp.mjs`:

| Tool | What it does and refuses |
|---|---|
| `tools_status` | seeds, markets, approved backlog, waiting shortlist, pace, results-page budget, site tools and their tests |
| `tools_research_seed` | Google autocomplete for a seed (alone, with question words or a–z) and, when the SEO employee site is set, Keyword Planner volumes through `seo_keyword_volumes`; cached |
| `tools_inspect_serp` | Google's first page in headless Chromium through `TTS_PROXY_URL` when set: answer-widget rejection, forums, platforms, big sites, dedicated tools, People also ask; at most `serpPerDay` (≤20) live pages a day, `serpGapSeconds` apart, cached `cacheDays`; six hours off after a robot check |
| `tools_score_keyword` | the gate: autocomplete or 30+ monthly searches, a page inspected in the last 14 days that is open or contested, evergreen, tier-1/2 audience, a 40+ character differentiator; sets RPM band, difficulty and score |
| `tools_list_candidates` | the last 30 days' candidates |
| `tools_propose_shortlist` | 1–6 passing candidates as a signed review page and WhatsApp message; refused while another shortlist waits (it expires after 14 days) |
| `tools_build_scaffold` | `tools/<slug>/` from the templates, only for an approved tool |
| `tools_run_tests` | the tool's `node --test` and the build's checks; records the result against a hash of the tool's files |
| `tools_publish` | framework refresh, every test and check, build, commit, push, deploy hook; refuses stale or failing tests, unapproved tools, and new tools over the weekly pace |
| `tools_site_status` | live `build.json` against the latest build, standing pages, AdSense readiness (tells the owner once) |
| `tools_gsc_review` | striking distance (positions 5–20), low click-through for the position, no impressions after `pruneAfterDays` |
| `tools_report` | WhatsApp summary; closes the run |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

State is one JSON file, `<DSH home>/tools-employee/state.json` (mode 0600), with writes serialized: runs, candidates with their evidence and gate result, shortlists and decisions, tool records (seed flag, first and last publish, test record with file hash, Search Console numbers and flag), results-page and autocomplete caches, the live-read log the daily cap counts, the last publish and site check, and the key that signs review links.

The site's framework ships in `sites/tools-linkfa` (build script, templates, standing pages, styles, nginx Dockerfile). The working copy is a git repository at `<workspacePath>/site`: cloned from `siteRepo` with `TOOLS_SITE_GIT_TOKEN` (sent as an `http.extraHeader`, never in a URL), or initialised fresh. Every publish copies the shipped framework over it, adds missing seed tools, merges `site.config.json` with the card's AdSense client, runs every tool's tests and `build.mjs --check`, builds the preview into `<DSH home>/tools-employee/preview` (served signed-in at `<path>/preview/`), commits, pushes to `siteBranch` and posts the deploy hook. The Dokploy app's Dockerfile runs the tests again and fails the deploy on any failure. The live check reads `<siteUrl>/build.json` and compares its source hash with the latest build's; a redirect or a page without it means the app is not deployed.

`serp.ts` reads the page with one script (`EXTRACT_SERP`) that runs in the browser and in tests on saved pages (`tests/fixtures`). The verdict starts at 5: up to +3 for forum and platform results, up to +2 for ordinary sites in the top five, −1.25 per government or big-brand site in the top five, +2 with no dedicated tool, −1 with seven or more, −0.5 under an AI Overview; 6+ is open, 4+ contested. `gate.ts` holds the RPM table (page RPM for tool pages with a tier-1 audience, ×0.5 tier 2, ×0.15 elsewhere), the weekly pace (ISO week in the owner's time zone, hard cap 5) and the approval reply parser. Search Console goes through the SEO employee's client and service-account token grant; Keyword Planner through the SEO employee's command route.

The weekly timer checks each minute: a research run is due at the latest `weekday`/`shiftTime` slot not yet run (when `enabled`); a build run is due when approved tools are unbuilt and no run started since the approval. WhatsApp is read every `approvalCheckMs` while a shortlist waits. `tle-` Sessions may not use the DeerFlow browser.

</details>

-----

<a id="model-experience"></a>
## Model Experience

### Employee tools

#### What the model sees

Twelve `tools_*` tools on `tle-` Sessions only. Each answers in one text block; a refusal is a tool error naming the rule.

#### Token effect

The schemas ride every request of a run; a results page lists at most ten results plus People also ask, autocomplete at most 100 suggestions, test output at most 3,500 characters.

#### KV Cache effect

The tool set is fixed for a Session's life, so the prefix stays cacheable.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Reading Google is best effort.** Google may show a robot check to the server's address; without `TTS_PROXY_URL` the employee pauses six hours and works from caches. The extraction follows Google's current markup and needs new fixtures when it changes.
- **RPM is a maintained table**, not AdSense data; it is labelled as an estimate everywhere.
- **Deployment needs the owner's one-time setup** (site repository, token, Dokploy app on `tools.linkfa.de`); until then builds stay local and the card says the site is not deployed.
- **Runtime invariant:** No companion is published; the state file is the only record and nothing else observes it independently.
