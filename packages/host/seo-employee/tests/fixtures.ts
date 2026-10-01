/** Article fixtures shared by the quality and tool specs: prose and a draft that pass every check. */

import type { ArticleDraft } from '../src/types.ts'

/** About 250 words of plain first-person prose, the way a person writes a blog section. */
export const NATURAL = `Last March I cut forty clips from a two-hour podcast episode about moving back to Lagos. Most of them went nowhere. \
Three did well on Shorts, and one of those brought in more subscribers in a week than the full episode managed in a month. The \
winning clip came from minute 52, where the guest admitted she had guessed her Lekki rent at half the real figure. People filled the \
comments with their own numbers.

That pattern held across the next eleven episodes we clipped. A clip travels when a viewer can argue with it.

The first thing I look for now is a sentence someone will disagree with. I scrub the transcript for a claim or an admission and mark the \
timestamp. The clip gets thirty seconds of setup at most. If the guest needs more than that to get to the point, the moment \
probably belongs in the long video instead.

Captions matter more than the hook text. Many people who find a Short in their feed watch it with the sound off, so the words on \
screen carry the story.

Our editor Musa keeps a running sheet of every clip, its first-day views and the line it opened on. After six weeks the sheet showed \
us something we did not expect: clips that opened mid-sentence beat clips that opened on a clean start, by a wide margin, on both \
channels we tested.

We still get it wrong about a third of the time.`

export const BASE = 'https://klipara.linkfa.de'
export const SOURCE_URL = 'https://support.google.com/youtube/answer/10059070'

export function section(heading: string, extra: string): string {
  return `## ${heading}\n\n${NATURAL}\n\n${extra}`
}

export const BODY = [
  'I run the clipping side of Klipara, and this is what eleven podcast episodes taught us about which moments travel.',
  section('Find the line people will argue with', 'Our [clipping guide](/blog/podcast-clipping-guide) has the full checklist.'),
  section(
    'Captions carry muted viewers',
    `YouTube says about 40% of Shorts views in our test markets came from the feed, per [its creator guide](${SOURCE_URL}).`,
  ),
  section('Open mid-sentence', '::clip[lekki_rent_52]'),
  section('What it costs', `The [pricing page](${BASE}/pricing) lists the plans.`),
].join('\n\n')

export const FAQ_ANSWER = 'Keep most clips between twenty and fifty seconds. Shorter clips lose the setup that makes the claim land, and longer '
  + 'ones lose people who are scrolling. Cut to the sentence someone will disagree with, then stop a beat after the reaction.'

export function baseDraft(): ArticleDraft {
  return {
    slug: 'podcast-clips-that-travel',
    title: 'Which podcast moments make good Shorts',
    metaTitle: 'Which podcast moments make good Shorts',
    metaDescription: 'What eleven podcast episodes taught us about picking clips: find the arguable line, caption for mute, '
      + 'open mid-sentence.',
    dek: 'Lessons from clipping eleven episodes for Shorts.',
    bodyMarkdown: BODY,
    tags: ['podcasts', 'shorts'],
    faq: [
      { q: 'How long should a clip be?', a: FAQ_ANSWER },
      { q: 'Do captions matter?', a: FAQ_ANSWER },
      { q: 'Where should a clip start?', a: FAQ_ANSWER },
    ],
    sources: [{ title: 'YouTube creator guide', url: SOURCE_URL }],
    coverImageUrl: `${BASE}/media/cover.png`,
    coverAlt: 'A waveform with three highlighted moments',
  }
}
