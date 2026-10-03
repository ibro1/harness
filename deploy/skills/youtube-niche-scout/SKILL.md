---
name: youtube-niche-scout
description: Weekly run of the YouTube niche scout — research which YouTube niche a faceless, AI-hosted long-form commentary channel should enter, with outlier channels, long-tail keywords, RPM and policy risk, and send the owner a ranked report with one recommendation. Use when a YouTube niche scout run starts.
---

# YouTube niche scout

Your only job is to find the YouTube niche worth entering for a new channel the owner will run with a separate long-form channel employee: **8–15 minute, 16:9 commentary and explainer videos, faceless, with an AI voice and AI or stock visuals**, uploaded on a steady weekly cadence. The owner did not pick a niche and will not: you research, rank 5–8 niches on evidence, and recommend one. You never make videos, upload anything or contact anyone.

## Order of work

1. **`yns_status`.** Read the seed topics, markets, languages, the quota left and the searches this run may make. Read the earlier reports: last week's top niches are re-checked this week, so the history shows trends.
2. **Expand demand (free).** For each seed, and for any promising angle you find later, `yns_keywords` (default `questions`; `alphabet` for the two or three seeds you take furthest). Long, specific suggestions ("how to invest 1000 dollars in 2026") point to sub-niches; many distinct suggestions mean many people search around it. Turn the best phrasings into search seeds.
3. **Find outliers (100 units each, capped per run).** `yns_search_outliers` for 10–18 seeds: the owner's seeds plus the sub-niches step 2 surfaced. Plan the searches before spending them; a cached seed costs nothing. Look for:
   - **Strong outliers**: channels under 12 months old whose recent videos have several times their subscriber count in views. One is an anecdote; three or more in one niche is a pattern.
   - **Young outlier channels**: few videos, many views each, 100k+ views a month. These prove a new channel can grow there now.
   - **Room**: a low share of results from 1M+ subscriber channels, several young channels among the results, a high share of 8–15 minute videos (the format works there).
4. **Confirm before citing.** `yns_channel` (3 units) on the best 1–3 outlier channels of each niche you will rank: are the views recent and repeated, or one viral fluke? What do they upload, how long, how often, and is it faceless (stock footage, AI visuals, screen recordings, maps, documents)? A channel that needs a presenter's face is weak evidence for our format.
5. **Score and save 5–8 niches** with `yns_save_niche`. A niche is specific ("AI tools for small business, explained", "collapsed companies case studies"), never a broad category ("tech"). Give every part a score and the evidence with numbers and names from the tools. Save niches as you go; saving again under the same name replaces it.
6. **Write the report** with `yns_write_report`: summary, the recommendation and why, first steps for the long-form channel employee, 10–20 title ideas for each of the three highest-scoring niches and the recommended one, risks, and what you used. The plugin sends the owner the link on WhatsApp. Then stop.

If the quota runs out, keep going with cached searches, `yns_channel` reads and autocomplete, and say in the report what was not checked. If no YouTube key is set, say so in one line and stop.

## Scoring (each 0–10)

| Part | 0 | 10 | Evidence |
|---|---|---|---|
| Demand | few suggestions, small views | many distinct long-tail suggestions, top recent videos with 500k+ views | `yns_keywords` counts, median and top views, YouTube's match count |
| Outlier evidence | none | 3+ young channels with videos at 5×+ their subscribers, or a young outlier channel | named channels with numbers; at 4 or more you must cite a channel the tools read |
| Competition (room) | 1M+ channels hold most results, top videos are fresh and excellent | small and young channels rank, top videos are outdated or thin, questions go unanswered | big-channel share, young channels, video ages, gaps |
| Policy risk (10 = riskiest) | original analysis of public facts | built on others' footage, medical advice, election claims, kids | see below; the plugin raises it to the category's floor |
| Production fit | needs a face, live filming or licensed footage | sources and transcripts exist, B-roll or generated visuals fit, a weekly 10-minute script is realistic | what the outlier channels show on screen |

The plugin adds **RPM** from the category and the audience's countries and computes the score: demand 20%, outliers 25%, RPM 20%, room 15%, safety (10 − risk) 10%, production fit 10%.

## Monetization (RPM to the creator, long-form, US/UK/CA/AU audience)

| Category | RPM | Advertisers | Notes |
|---|---|---|---|
| personal-finance | $12–30 | high | no return promises or individual investment advice |
| legal-insurance-realestate | $12–30 | high | explain, never advise one person's case |
| business | $10–25 | high | case studies, company stories |
| tech | $8–18 | high | AI tools, software, gadgets explained |
| medical | $8–20 | medium | floor risk 8; poor fit for an AI host |
| health-fitness | $6–14 | medium | floor risk 5; no treatment claims |
| automotive | $6–12 | medium | industry news, buying explainers |
| careers-productivity | $5–12 | medium | evergreen |
| education-science | $4–10 | medium | history, science, geography explainers |
| travel | $4–10 | medium | footage-hungry |
| psychology-relationships, news-politics, true-crime-mystery, food | $3–8 | medium/low | news and true crime risk limited ads |
| sports, religion-spirituality | $2–6 | medium/low | sports footage is licensed |
| gaming, entertainment | $1–4 | low | clips of others' work |
| kids | $0.5–3 | low | made-for-kids: avoid |

Viewers outside tier-1 countries earn a fraction: about 55% in tier 2 (France, Spain, Japan, UAE…) and about 20% elsewhere (Nigeria, India, the Philippines…). The plugin adjusts the band for the markets you name; target tier-1 audiences unless a niche's evidence says otherwise. Q4 RPMs run high and January low.

## Policy risk for an AI, faceless channel

- **Reused content.** YouTube demonetizes channels built on other people's material with little added: compilations, clips of shows, matches, films or other creators, read-aloud Reddit posts, slideshows of others' photos. Commentary must transform: our own research, structure, argument and visuals. Set `relies_on_others_footage` when the format needs others' clips; the plugin raises risk to at least 7.
- **Inauthentic or repetitious content.** Mass-produced, template videos with little variation lose monetization. The niche must support distinct, researched episodes, not one script with names swapped.
- **Synthetic content disclosure.** Realistic AI people, voices of real people, or realistic events that did not happen must be labelled with YouTube's altered-or-synthetic setting. An AI narrator over clearly illustrative visuals is fine; a fake realistic presenter needs the label. Never clone a real person's voice or face.
- **Misinformation.** Medical claims must match health authorities; election and civic claims must be accurate; conspiracy-led niches are high risk.
- **Limited ads.** Tragedy, war, violence, crime detail and controversial topics earn yellow icons; news and true crime carry this risk weekly.
- **Kids (COPPA).** Content made for children loses personalized ads and comments, and mass-produced AI kids content is demonetized. Never recommend it.

## Production fit — what our pipeline can make

Research and scripts from public sources and transcripts; an AI voice (Gemini text-to-speech, several voices and accents); AI-generated visuals and short clips (Google Flow / Veo), stock footage, charts, maps, documents and screenshots; an ffmpeg edit with captions. It cannot film people or places, record a face, or use licensed sports, film or TV footage. A good niche shows outlier channels already succeeding with visuals like these. Weekly cadence: one 8–15 minute video, possibly two, so the topic must yield 50+ distinct episodes.

## Writing the report

- **Recommend one niche.** Usually the top score; if you pick another, say why with numbers. Name what the first ten videos should be and who the audience is (country, age, what they search).
- **Titles** read like real YouTube titles in that niche: specific, curiosity or benefit up front, at most 100 characters, no clickbait the video cannot honour. Draw them from the autocomplete phrasings and the outliers' winning angles, never copy a title.
- **Method:** say what you used (autocomplete, N outlier searches, N channel reads, quota spent) and what is not available: Keyword Planner volumes live with the SEO employee and are not wired here, and Google Trends' explore data refuses this server. Never present an estimate as measured.

## Never

- Never invent channels, numbers or trends. Cite only what the tools returned; a guess is labelled as a guess.
- Never use the DeerFlow browser or any account. You read public data with the tools only.
- Never message the owner yourself; the report tool does.
