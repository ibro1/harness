---
description: "Fork-local TikTok Shop employee: finds UK TikTok Shop products, writes short honest videos about them under code-enforced rules, renders them from the products' own images with an AI voiceover, and sends the owner a review link to post."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-tiktok-shop-employee

## Summary

A daily shift that earns TikTok Shop affiliate commission on the owner's UK account without filming. It searches UK TikTok Shop for products that sell (SocialCrawl data), reads each listing, writes 15–40 second videos in proven formats (showcase, problem-fix, reasons, comparison, gift idea), and the plugin renders each one from the listing's images with an AI voiceover and burned-in captions. The owner gets a review link on WhatsApp, posts the video from their own TikTok with the product tagged, and reports views and sales on the same page; the shift reads those results and makes more of what sells.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

The web-app bundle inserts it when `DSH_DEPLOY=1` (`DSH_TIKTOK_SHOP_EMPLOYEE=0` leaves it out); it does nothing until switched on at **Plugins → TikTok Shop employee**, where the owner saves a SocialCrawl API key (socialcrawl.dev; one credit per search or listing read), the WhatsApp recipient, the shift time, videos per day, themes, blocked words, the voice and the models. **Run a shift now** starts one at once.

Each day at the shift time a root Session (id `tts-…`) runs the `tiktok-shop-employee` skill (`deploy/skills/tiktok-shop-employee/`). Tools, on `tts-` Sessions only and to agy and opencode over `deploy/mcp/tts-mcp.mjs`:

| Tool | What it does and refuses |
|---|---|
| `tts_status` | today's videos against the cap, pause, videos waiting for the owner, and posted results by format and hook |
| `tts_search` | UK product search; saves products not matching the owner's blocked words (whole words in title, category or description) |
| `tts_product` | the full listing: description and images; every claim must come from it |
| `tts_products` | products found, best sellers first |
| `tts_make_video` | reserves one video and starts rendering it; refused while paused, over `videosPerDay`, for a rejected, blocked or imageless product, or for a script that claims anyone used the product, makes a health or guaranteed-result claim, names a price other than the listing's, or breaks the length limits (hook ≤ 9 words, 2–6 lines, 20–95 spoken words, captions ≤ 7 words) |
| `tts_videos` | videos by status, with results |
| `tts_reject_product`, `tts_pause` | rule a product out; stop and alert the owner (only the owner resumes) |

The post caption always starts with `#ad`; the review page tells the owner to tag the product and switch on TikTok's AI-generated and promotional-content labels.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

State is one JSON file, `<DSH home>/tiktok-shop-employee/state.json` (mode 0600), with writes serialized; finished videos are in `media/`. `socialcrawl.ts` reads SocialCrawl's search and product endpoints; its fields are documented by meaning only, so the parser accepts the usual names for each and drops rows without an id, title and price. TikTok's own pages answer automated readers with a security check, so the shop is never read directly.

`render.ts` makes the video with ffmpeg: per spoken line one 1080×1920 segment of one product image over a blurred, darkened copy of itself, slowly zooming in or out, with the caption (and the hook on the first segment, the price on the last) drawn from text files in DejaVu Sans Bold; segments last as long as their voice line plus a short gap, are encoded alike and joined without re-encoding. The whole script is spoken in one request, read with a pause between paragraphs, and cut into lines at the longest pauses (`lineSpans`); when a boundary has no clear pause, each line is spoken on its own. `voice.ts` with the default `auto` tries every Gemini key in the environment (`GEMINI_API_KEY`, then `_1` to `_9`), then Groq as the last resort (the saved key, `GROQ_API_KEY`, then `_1` to `_9`). A key that is rate-limited rests for the delay Google gives (a spent free-tier day is hours), any other failure rests it ten minutes, and the next key takes the request; when every key rests but one frees within 90 seconds, the request waits for it. Gemini's free tier allows 10 speech requests a day per Google Cloud project, so keys add capacity only when they come from different projects. Gemini and Groq are called directly; `elevenlabs` goes through video-use's `speak.py`. The deployment's compose file forwards `GEMINI_API_KEY_1` to `_9` and `GROQ_API_KEY_1` to `_9`. Renders run one at a time in the background; a restart resumes any left `rendering`. A finished or failed render is announced on WhatsApp.

The review page `GET <path>/v/<id>?sig=` (HMAC of the video id with a key in the state file) works without the harness sign-in: the video with range requests, a download, the caption, posting steps, and buttons that record posted, skipped and the owner's views and sales. `GET <path>/status` and `POST <path>/action` (pause, resume, run-now) are signed-in only. `tts-` Sessions may not use the DeerFlow browser.

</details>

-----

<a id="model-experience"></a>
## Model Experience

### Shift tools

#### What the model sees

Eight `tts_*` tools on `tts-` Sessions only. Each answers in one text block; a refusal is a tool error naming every rule broken.

#### Token effect

The schemas ride every request of a shift; search results list at most what one search returns, and `tts_products` at most 60 rows.

#### KV Cache effect

The tool set is fixed for a Session's life, so the prefix stays cacheable.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Posting is manual.** TikTok's Content Posting API publishes publicly only for apps TikTok has audited; until then the owner posts from the review page's download.
- **Results are typed in.** Views and sales come from the owner on the review page; TikTok's analytics are not read.
- **Product data is a paid third party.** SocialCrawl's field names are not published, so a change on their side can empty searches; its product-details endpoint may not cover GB, in which case scripts work from the search result alone.
- **Only the listing's still images.** No product video footage, stock clips or AI-generated scenes yet.
- **Runtime invariant:** No companion is published; the state file is the only record and nothing else observes it independently.
