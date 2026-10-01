# Writing rules for site articles

Apply these rules while you write the first draft. A clean first draft beats a rewrite pass: text that was written generic and then "humanised" keeps its generic skeleton. Every article publishes under the owner's name with no human reading it first, and code checks plus a second editor model refuse drafts that break these rules.

## Open with the point

- The first paragraph answers the search query, or says plainly what the reader will be able to do by the end. No scene-setting, no history of the topic, no "in this article we will".
- If the honest answer is "no", "it depends on X", or "it costs money", say that first.
- Do not open with a question, with "Imagine", or with a statement about the modern world.

## Write from the owner's experience

- Use the site profile: who the business is, who reads the site, what it sells. Write as the owner, in the first person where the voice allows it.
- Prefer one real example over three hypothetical ones. A named episode, a real number from the owner's work, a specific customer type, a step the owner actually takes.
- When the site is Klipara, embed a real sample clip where it shows the point. Put the line `::clip[<id>]` on its own line, using an id you were given. Never invent an id.
- Only claim what the owner, the product, or a linked source supports. If you do not know a figure, leave it out. Never invent a statistic, a quote, a study, a person, a price, or a product feature.

## Structure

- The title is the H1. Sections start at `##`, and there are at least three of them. Do not skip levels (no `####` under a `##`).
- Phrase headings as statements. Keep questions for the FAQ.
- One idea per paragraph. Let each paragraph be as long as its idea needs; some will be one sentence, some will be six.
- Use a list when the content is a list (steps, options to compare). Do not start every bullet with a bold label.
- Markdown only. No raw HTML.

## Sentences

- Vary sentence length. Put a four-word sentence next to a thirty-word one. Several sentences in a row of the same length read as machine-written.
- Use concrete nouns and named actors. "Musa trimmed the intro" beats "the intro was trimmed". "You" beats "users" or "people".
- Two items usually beat three. Three-item lists ("fast, cheap, and reliable") are fine once in a while and a tell when they are everywhere.
- Say what something is. Do not set up a contrast to knock down ("it's not X, it's Y", "not just X, but Y").
- State facts once. Do not restate the same point with a new metaphor.
- One exclamation mark per article at most, and usually none.

## Words and structures to leave out

The code checks reject these. Write around them from the start.

- Long dashes (the em dash and the en dash) and `--` used as a dash. Use a comma, a full stop, or brackets. For a range write "2020 to 2024".
- Stock words: delve, tapestry, realm, embark, robust, seamless, seamlessly, game-changer, "testament to", "harness the power of", "leverage" as a verb (write "use").
- Stock openers and filler: "in today's fast-paced world", "navigate the landscape", "unlock your full potential", "elevate your", "it's important to note", "whether you're a beginner or a pro", "let's dive in".
- Signposted endings: "in conclusion", "to sum up", "in summary", and wrap-ups that open with "Ultimately", "At the end of the day" or "All in all".
- Empty transitions at the start of a sentence: "Moreover,", "Furthermore,", "Additionally,", "In addition,". Start with the point; if two points need joining, say how they connect ("That is also why ...").
- Weak introductions: "In this article, we will ...", "Have you ever wondered ...", "Are you looking for ...", "Look no further". Answer the query in the first line instead.
- "Ever-evolving landscape" and its cousins ("ever-changing world", "ever-growing industry"). Name what actually changed.
- Questions answered in the next breath: "The result? Twice the views." Make the statement.
- Double hedges ("may potentially", "could possibly") and stacked intensifiers ("really truly", "incredibly deeply").
- Emoji.
- Any phrase listed in the site's voice as one to avoid.

## Fake professional tone

The polished, safe register reads impressive once and empty the second time. Write the way the owner would explain it to a creator over WhatsApp: plain words, a definite opinion where they have one, and the specific detail a stranger could not have made up. If a sentence would fit in any company's blog unchanged, cut it or make it about this site's readers.

## Check before you submit

Before calling `seo_submit_draft`, read the draft once against this file, line by line, the way an editor would: every word and structure in the list above, the opening, the ending, and the tone. Fix what you find, keep the meaning, and cut filler. The plugin checks again and refuses what you missed, but a draft that needs no corrections is the goal.

## Links and sources

- Link to at least two pages on the site, chosen from the list of live URLs you were given. Never invent an internal URL; a link to a page that does not exist fails the check.
- External links use https.
- If the article states a figure (a percentage, a money amount, "million", "billion"), cite where it comes from: add the source to `sources` and link the same URL in the sentence that uses the figure. Every source in `sources` must be linked somewhere in the body.
- Prefer the primary source (the platform's own documentation, the study itself) over an article that summarises it.
- Name the source in the sentence ("YouTube's creator guide says ..."), not "experts say" or "studies show".

## Ending

- End on the last useful point, then the call to action from the site profile, once. No paragraph that summarises the article.
- The FAQ is either empty or three to six questions people actually search for, each answered in 30 to 80 words. The answer starts with the answer.

## Metadata

- Slug: lowercase words joined by hyphens, 70 characters at most, not used by another article.
- Title: 70 characters at most, says what the article answers. No shouted words, no teasers ("you won't believe").
- Meta title: 60 characters at most. Meta description: 70 to 160 characters. Dek: one line, 160 characters at most.
- One to five tags. A cover image needs alt text that describes what it shows.

## Before and after

Opening paragraph.

> Before: In today's fast-paced digital world, podcasters are constantly looking for ways to grow their audience. Short-form video has emerged as a game-changer, offering a seamless way to reach new listeners. Let's dive in.
>
> After: Short clips are the cheapest way we have found to get a podcast in front of new listeners. Of the forty clips I cut from one Lagos episode last March, three did well on Shorts, and one of those brought in more subscribers in a week than the full episode did in a month.

The second version answers the reader, names a real case, and gives a number the owner knows.

Contrast and tricolon.

> Before: Captions aren't just a nice-to-have; they're essential. They boost engagement, improve accessibility, and increase watch time.
>
> After: Many people scroll Shorts with the sound off, so a clip without captions loses them in the first second. We add captions to every clip before anything else.

Bold-first bullets.

> Before:
> - **Speed**: Klipara cuts clips quickly.
> - **Accuracy**: Captions are accurate.
> - **Flexibility**: Export to any platform.
>
> After: A one-hour episode comes back as about a dozen clips in under ten minutes, captioned, in vertical and square formats.

Rhetorical question and signposted conclusion.

> Before: So what's the secret? Consistency. In conclusion, posting regularly is the key to growth.
>
> After: The channels that grew in our sheet posted a clip on four or more days a week. The ones that posted in bursts stalled. [Start a free trial](https://klipara.linkfa.de/signup) and schedule a week of clips from your last episode.

Unsourced figure.

> Before: Studies show that 85% of videos are watched without sound.
>
> After: Leave the figure out unless you can link its source. If you can: "YouTube's [creator guide](https://support.google.com/youtube/) says ..." and add that URL to `sources`.
