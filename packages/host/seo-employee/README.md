---
description: "Fork-local SEO employee: a daily shift that researches keywords for the owner's sites (Search Console, Google Ads Keyword Planner, Google suggestions), plans one page per search intent, gets first-hand material from the owner, writes articles under code-enforced checks and an editor model's recorded verdict, publishes them to Klipara or WordPress within a weekly cap, and reports how they rank."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-seo-employee

## Summary

Grows search traffic for the owner's sites with a few articles each week that are the best answer to a real search. Each site (Klipara, a WordPress site such as linkfa.de) carries its own profile: business, readers, offer, voice, call to action, markets, seed topics, Search Console property, weekly cap and author. Google punishes mass AI pages, so the plugin keeps the pace low and forces each article through the owner's first-hand input, strict draft checks and a second model's review before anything is published.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

The web-app bundle inserts it when `DSH_DEPLOY=1` (`DSH_SEO_EMPLOYEE=0` leaves it out); it does nothing until switched on at **Plugins → SEO employee**.

1. **Google, recommended: a service account.** In Google Cloud create a service account and a JSON key, paste the key into **Service account key** on the settings page, then add the service account's email as a user in Google Ads (**Admin → Access and security**, Standard) and in Search Console (**Settings → Users and permissions**, Full, which allows sitemap submission). Google Ads grants service accounts direct access, so there is no consent screen, no "unverified app" warning and no token for Google to expire. Create the service account in the Cloud project that holds the Google Ads API access level: since Google retired developer tokens (2026-09-09), the access level comes from the Cloud project behind the credentials, and the optional developer-token header is ignored (the plugin sends it only when one is saved). With a key saved, the OAuth fields are not used.

   **Or OAuth.** In Google Cloud (the project where the Google Ads API is enabled), create a Web application OAuth client and add the redirect URI the page shows (`https://<this host>/seo/oauth/callback`). Set the consent screen to *In production*: in *Testing*, Google expires the connection after 7 days. Enter the client id and secret, then press **Connect Google**: one consent covers Google Ads (`adwords`) and Search Console (`webmasters`, which also lets the employee resubmit sitemaps). For Keyword Planner, add the Ads customer id to plan with and the manager account id when the Ads account sits under one; the OAuth client's Cloud project must hold Basic access or above.
   **Per site.** Each site chooses how it reaches Google (**Google access** on its form). *Shared* uses the access above: the owner's own sites, and a client who added the service account's email as a user in their Search Console and either added it in Google Ads or linked their Ads account under the owner's manager account. *The site owner's own sign-in*: the page shows a signed link (`/seo/connect/<site>?sig=…`) the owner sends the client; it works without a harness login, shows a button first (so a link preview starts nothing), and stores that client's sign-in for that site alone. The OAuth return address answers without the harness login; its single-use state and PKCE verifier tie each answer to a flow the harness started. A site can also name its own Ads account and manager account for Keyword Planner. Until Google verifies the OAuth app's scopes, a client signing in sees Google's unverified-app screen.
2. **Sites.** On **Plugins → SEO sites**, add each site: address, publisher (Klipara content API key with the `content:write` scope, or a WordPress user with an application password), profile, markets, seeds, Search Console property, articles a week and author. **Test connection** reads the site's article list.
3. **Turn it on** and set the shift time, the WhatsApp recipient, and the shift, fallback and editor models.

Each day at the shift time a root Session (id `seo-…`) runs the `seo-employee` skill (`deploy/skills/seo-employee/`). The employee's questions arrive on WhatsApp with a tag such as `#q7k2`; reply starting with the tag, or answer on the SEO sites page. Each published article is announced on WhatsApp with a one-tap unpublish link; opening it shows a button, so link previews cannot unpublish anything.

Tools, on `seo-` Sessions only (and to agy and opencode over `deploy/mcp/seo-mcp.mjs`):

| Tool | What it does and refuses |
|---|---|
| `seo_status` | sites and profiles, this week's count against each cap, Google connection, pause, open questions, unpassed drafts |
| `seo_search_console` | striking-distance queries (best page at positions 5–20, 50+ impressions), top queries, top pages, cannibalization; cached a day |
| `seo_keyword_ideas`, `seo_keyword_volumes` | Keyword Planner ideas and exact-keyword metrics for one market (rounded volumes, ad competition); cached `researchCacheDays`; marks keywords live topics already cover |
| `seo_autocomplete` | Google's suggestions for a phrase in a market; cached |
| `seo_site_pages` | the site's sitemap URLs and its articles, the only valid internal-link targets |
| `seo_topics`, `seo_save_topic`, `seo_reject_topic` | the content map; a topic whose keyword or cluster another live topic covers is refused (one page per query), except a refresh of that same article |
| `seo_ask_owner`, `seo_check_answers` | 1–3 questions on WhatsApp; answers by tagged reply or on the page |
| `seo_add_image` | one image from a real source, copied into the site's media library: `clip-cover` (a Klipara sample's cover), `screenshot` (the site's own public pages only, optionally cropped and phone-sized), or `graphic` (`cover`, `steps`, or `chart` of numbers with a required source), drawn in the site's colours and fonts; refuses other sites' pages and alt text that says nothing |
| `seo_submit_draft` | refuses while the owner's answer is due (up to `answerWaitHours`), and refuses a draft with any problem: lengths, slug, headings, internal links to unknown URLs, statistics without linked sources, raw HTML, a `::clip` the owner has not listed under **Clips you may feature** (or without its credit line), a missing or off-site cover, images not copied to the site or without alt text, no picture in a long article, more than one image per 300 words, banned phrases from the site's voice (`Avoid:` lines), and AI-writing tells |
| `seo_review_draft` | the plugin asks the editor model and records its scores; a pass needs 35/50, every dimension 6+, no must-fix items and a `publish` verdict |
| `seo_publish` | only a recorded pass, within the weekly cap, not while paused; copies the cover, publishes or updates, resubmits the sitemap, tells the owner |
| `seo_articles` | per-article Search Console clicks, impressions and position, recorded; flags refreshes |
| `seo_pause`, `seo_resume` | pause and alert the owner; resume only when the owner asks |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

State is one JSON file, `<DSH home>/seo-employee/state.json`, mode 0600 because it holds the Google refresh token and the sites' publisher credentials; writes are serialized and atomic. It also keeps a research log (500 entries) so the same Keyword Planner or Search Console question is not asked twice inside the cache window, and the key that signs unpublish links.

`google/` holds plain-`fetch` clients: a service account's JWT bearer grant (RS256 with `node:crypto`), OAuth with PKCE and a cached access token (`invalid_grant` becomes "press Connect Google again"), Google Ads REST (`generateKeywordIdeas`, `generateKeywordHistoricalMetrics`, version from `adsApiVersion`, default v25) behind a per-customer queue that keeps keyword-planning calls at most one per 1.1 s and retries `RESOURCE_EXHAUSTED` after Google's stated delay, and Search Console (`searchAnalytics.query` with paging, striking distance and cannibalization ported from open-seo, sitemap submission, URL inspection). `publishers/` implements the Klipara content API and the WordPress REST API with application passwords, including a small Markdown-to-HTML converter that escapes all raw HTML. `quality/` holds the style checker, the draft checks and the editor prompt and parser. The editor call (`editor-call.ts`) goes through the harness LLM service on the configured editor model, so its verdict is recorded by the plugin, not claimed by the writing model; the prompt is built from the draft the tool call carries, so it is reconstructable from the session log.

Images come from `images.ts`. Screenshots and template graphics are rendered by the capture plugin's headless Chromium driver: a screenshot opens a URL that passed the same public-address screen `capture_page` uses, and a graphic is a self-contained HTML card (fonts from Google Fonts) rendered from a `data:` URL and cropped to the card. The PNG is written to `<data dir>/media` and served without login at `/seo/media/<24 hex>.png`, only for names the plugin wrote, so the site's publisher can copy it; the article links the site's copy. A site's colours and fonts come from its form, or else from its own stylesheets: the `theme-color`, then its design tokens (`--color-paper`, `--color-ink`, `--color-accent`, `--font-display`, `--font-body`, preferred over generic `--background`-style names), light-mode values chosen by lightness.

The shift timer, the fallback model for shift turns and WhatsApp alerts come from `@deepseek-ai/dsh-host-employee-kit`. Every 15 minutes the plugin collects tagged WhatsApp answers without a model turn and wakes the latest shift (or starts a short one) when an answer lands for a topic still waiting. `seo-` Sessions cannot use the DeerFlow browser, whose Google account Klipara downloads with: the plugin refuses `mcp__deerflow__*` calls, and the relay shows those Sessions no DeerFlow tools.

Credits: striking distance and the deslop writing rules are adapted from open-seo (MIT); see `NOTICE.open-seo.md`.

</details>

-----

<a id="model-experience"></a>
## Model Experience

### Shift tools

#### What the model sees

`seo-` Sessions get the 18 `seo_*` tools; other Sessions see none. The opening message names the skill file, and an owner answer arrives as a user message naming the answered tags. Each tool returns one text block sized to the request: keyword lists at most 100 rows, Search Console at most 100, site pages at most 300. A refusal is a tool error that names every problem to fix.

#### Token effect

The tool schemas ride every request of a shift Session. Research results, drafts and editor verdicts stay in that Session until compaction; the research log keeps repeat questions to a short cached answer.

#### KV Cache effect

The tool set is fixed for a Session's life, so the prefix stays cacheable across its turns; an owner-answer wake-up appends to the latest shift instead of starting a new Session while it is loaded.

### Editor review

#### What the model sees

`seo_review_draft` makes one model call outside the Session, on the configured editor model, with the draft, the site's profile and the target query; the Session sees only the recorded scores and must-fix list.

#### Token effect

One editor call per review; its prompt is the draft plus the profile.

#### KV Cache effect

None on the Session; the editor call has no shared prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Keyword Planner policy.** Google's API policy lists campaign creation and management as the approved uses; using its ideas to pick article topics is outside them. The owner chose to use it as is. Calls are few and cached, and volumes never appear in articles.
- **Volumes may be ranges.** An Ads account with no recent spend can get coarse volumes from Keyword Planner.
- **WordPress meta.** Yoast and Rank Math do not expose their title and description fields over REST by default, so on WordPress the meta title and description may be dropped unless the site registers them. The post author is the application-password user, not the site profile's author.
- **SERP reading** relies on the Session's own web search and fetch tools; the plugin has no search results API.
- **Runtime invariant:** No companion is published; the plugin's state is one file it alone writes.
