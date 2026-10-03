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

State is one JSON file, `<DSH home>/tiktok-shop-employee/state.json` (mode 0600), with writes serialized; finished videos are in `media/`. Product data comes from TikTok directly when a proxy is set (`directProxy` on the page, else `TTS_PROXY_URL` or `HTTPS_PROXY`): `direct.ts` opens the search or product page in the harness's own headless Chromium (never the DeerFlow browser) through the proxy, collects the page's inline JSON and every JSON response it loads from TikTok, and walks them for objects that read as products, so no one page layout is assumed; the page addresses are settings (`directSearchUrl`, default `https://www.tiktok.com/shop/s/{slug}`, whose market follows the proxy's country; `directProductUrl`). A security check, no products or a failure falls back to SocialCrawl (`withFallback`), and the tool's reply says which source answered and why the direct read was not used. The SocialCrawl key is `socialCrawlApiKey` on the page, else `SOCIALCRAWL_API_KEY` in the deployment. `socialcrawl.ts` reads SocialCrawl's search and product endpoints (`data.items[].product`, as its openapi.json documents); its product endpoint does not serve GB at present (503), so `tts_product` then works from the search result. From this server's own address TikTok's pages answer automated readers with a security check, which is why the direct read needs a proxy.

`render.ts` makes the video with ffmpeg: per spoken line one 1080×1920 segment of one product image over a blurred, darkened copy of itself, slowly zooming in or out, with the caption (and the hook on the first segment, the price on the last) drawn from text files in DejaVu Sans Bold; segments last as long as their voice line plus a short gap, are encoded alike and joined without re-encoding. The whole script is spoken in one request, read with a pause between paragraphs, and cut into lines at the longest pauses (`lineSpans`); when a boundary has no clear pause, each line is spoken on its own. `voice.ts` with the default `auto` tries every Gemini key in the environment (`GEMINI_API_KEY`, then `_1` to `_9`), then Groq as the last resort (the saved key, `GROQ_API_KEY`, then `_1` to `_9`). A key that is rate-limited rests for the delay Google gives (a spent free-tier day is hours), any other failure rests it ten minutes, and the next key takes the request; when every key rests but one frees within 90 seconds, the request waits for it. Gemini's free tier allows 10 speech requests a day per Google Cloud project, so keys add capacity only when they come from different projects. Gemini and Groq are called directly; `elevenlabs` goes through video-use's `speak.py`. The deployment's compose file forwards `GEMINI_API_KEY_1` to `_9` and `GROQ_API_KEY_1` to `_9`. Renders run one at a time in the background; a restart resumes any left `rendering`. A finished or failed render is announced on WhatsApp.

The review page `GET <path>/v/<id>?sig=` (HMAC of the video id with a key in the state file) works without the harness sign-in: the video with range requests, a download, the caption, posting steps, and buttons that record posted, skipped and the owner's views and sales. `GET <path>/status` and `POST <path>/action` (pause, resume, run-now) are signed-in only. `tts-` Sessions may not use the DeerFlow browser.

`tiktok-browser.ts` is the owner's TikTok account in its own persistent Chromium profile (`<data dir>/tiktok-profile`), always through the proxy and never shared with the DeerFlow browsers. **Connect TikTok** on the settings page opens TikTok's QR login headless and shows the code (refreshed as it expires) until the owner scans it with the app, within 3 minutes; the session is the `sessionid` cookie in the profile, and **Disconnect** deletes the profile. On a ready video's review page **Prepare** runs the posting script without pressing Post and **Post now** presses it: open the upload page (`tiktokUploadUrl`), upload the file, type the caption, tag the product (Add link, Products, search by id then title), switch on the AI-generated and disclosure labels, and screenshot the page. Controls are found by their visible words; each step is recorded, posting refuses unless sign-in, upload, caption and product tag all worked, and the owner gets the steps and screenshot on WhatsApp. The model never posts.

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

- **Posting drives TikTok's web page.** TikTok does not document its upload page, so a change there breaks a step until the words the script looks for are updated; the step list and screenshot show which. TikTok's Content Posting API publishes publicly only for audited apps and may not tag Shop products.
- **Results are typed in.** Views and sales come from the owner on the review page; TikTok's analytics are not read.
- **Product data is a paid third party.** SocialCrawl's field names are not published, so a change on their side can empty searches; its product-details endpoint may not cover GB, in which case scripts work from the search result alone.
- **Only the listing's still images.** No product video footage, stock clips or AI-generated scenes yet.
- **Runtime invariant:** No companion is published; the state file is the only record and nothing else observes it independently.
