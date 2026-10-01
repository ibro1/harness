import { describe, expect, it } from 'vitest'
import {
  articleStyleProblems,
  EXCLAMATION_WORDS_PER_ALLOWED,
  MAX_FINDINGS_PER_RULE,
  type StyleProblem,
} from '../src/quality/style.ts'
import { draftProblems, wordCount, type DraftContext, type DraftProblem } from '../src/quality/draft.ts'
import { editorPrompt, MIN_DIMENSION, parseEditorReply, PASS_TOTAL } from '../src/quality/editor.ts'
import type { ArticleDraft, RemoteArticle, Site } from '../src/types.ts'
import { BASE, BODY, FAQ_ANSWER, NATURAL, SOURCE_URL, baseDraft, section } from './fixtures.ts'

const rules = (problems: readonly StyleProblem[]): string[] => problems.map(p => p.rule)

describe('article style tells', () => {
  it('passes ordinary first-person prose', () => {
    expect(wordCount(NATURAL)).toBeGreaterThan(230)
    expect(articleStyleProblems(NATURAL)).toEqual([])
  })

  it.each([
    ['long-dash', 'The tool is fast \u2014 faster than most.'],
    ['long-dash', 'Prices rose 2020\u20132024 in Abuja.'],
    ['long-dash', 'It works -- mostly.'],
    ['delve', 'We delved into the transcript.'],
    ['tapestry', 'A rich tapestry of voices.'],
    ['testament-to', 'The growth is a testament to good editing.'],
    ['in-todays-world', 'In today\u2019s fast-paced world, clips win.'],
    ['in-todays-world', 'In today\'s digital landscape, attention is short.'],
    ['navigate-landscape', 'Creators must navigate the complex landscape of short video.'],
    ['unlock-potential', 'Clips unlock the full potential of a podcast.'],
    ['elevate-your', 'Elevate your channel with captions.'],
    ['game-changer', 'Auto captions were a game-changer for us.'],
    ['seamless', 'The export works seamlessly.'],
    ['robust', 'A robust workflow for editors.'],
    ['leverage-verb', 'You can leverage AI to find moments.'],
    ['leverage-verb', 'We are leveraging the transcript.'],
    ['important-to-note', 'It\'s important to note that Shorts are vertical.'],
    ['signposted-conclusion', 'In conclusion, clip the arguments.'],
    ['ultimately-conclusion', 'Captions help. Ultimately, the clip has to say something.'],
    ['ultimately-conclusion', 'At the end of the day, views follow good moments.'],
    ['empty-transition', 'Clips travel. Moreover, they cost little.'],
    ['empty-transition', 'Additionally, captions help muted viewers.'],
    ['weak-intro', 'In this article, we will show how to clip a podcast.'],
    ['weak-intro', 'Have you ever wondered why some clips spread?'],
    ['weak-intro', 'Look no further than Klipara.'],
    ['ever-evolving', 'Creators work in an ever-evolving landscape.'],
    ['whether-youre-a', 'Whether you\'re a beginner or a pro, this helps.'],
    ['not-just-but', 'Clips are not just shorter, but sharper.'],
    ['not-x-its-y', 'The hook isn\'t the problem. It\'s the captions.'],
    ['not-x-its-y', 'It\'s not a tool, it\'s a habit.'],
    ['lets-dive-in', 'Let\'s dive in.'],
    ['embark', 'Before you embark on clipping, pick an episode.'],
    ['realm', 'In the realm of short video, speed matters.'],
    ['harness-the-power', 'Harness the power of transcripts.'],
    ['stacked-hedge', 'This may potentially help your channel.'],
    ['stacked-hedge', 'It could possibly double views.'],
    ['stacked-adverbs', 'The results were really truly good.'],
    ['rhetorical-question', 'Want more views? Clip the arguments.'],
    ['rhetorical-question', 'We tried it. The result? Twice the views.'],
    ['imagine-opener', 'Imagine a channel that grows while you sleep.'],
    ['emoji', 'Clip the arguments \u{1F680} and post daily.'],
  ])('flags %s in %j', (rule, text) => {
    expect(rules(articleStyleProblems(text))).toContain(rule)
  })

  it('reports an excerpt of at most 80 characters and a fix', () => {
    const [problem] = articleStyleProblems(`${'word '.repeat(40)}we delve here ${'word '.repeat(40)}`)
    expect(problem?.rule).toBe('delve')
    expect(problem?.found.length).toBeLessThanOrEqual(80)
    expect(problem?.found).toContain('delve')
    expect(problem?.fix).not.toBe('')
  })

  it('caps findings per rule and counts the rest', () => {
    const problems = articleStyleProblems('a \u2014 b. '.repeat(MAX_FINDINGS_PER_RULE + 3)).filter(p => p.rule === 'long-dash')
    expect(problems).toHaveLength(MAX_FINDINGS_PER_RULE + 1)
    expect(problems.at(-1)?.found).toBe('3 more like this')
  })

  it('ignores code, URLs, and clip lines', () => {
    const text = 'Run this:\n\n```\nconst robust = a \u2014 b // delve\n```\n\n'
      + 'See `leverage()` and https://x.example/robust\u2014delve.\n\n::clip[abc123]'
    expect(articleStyleProblems(text)).toEqual([])
  })

  it('leaves ordinary uses of nearby words alone', () => {
    const text = 'Leverage in a negotiation comes from options. The landscape photos sold well. She asked whether you are coming or not.'
    expect(articleStyleProblems(text)).toEqual([])
  })
})

describe('article pattern tells', () => {
  it('flags three-item lists past one per 400 words, not a single one', () => {
    expect(rules(articleStyleProblems('We tested speed, price, and support on the new plan.'))).not.toContain('tricolon-density')
    const dense = 'We tested speed, price, and support. Musa liked the captions, the cuts, and the export. '
      + 'Ada wanted clips, quotes, and stills.'
    expect(rules(articleStyleProblems(dense))).toContain('tricolon-density')
  })

  it('does not count longer lists as three-item lists', () => {
    expect(rules(articleStyleProblems('We tested speed, price, support, and uptime. Then captions, cuts, export, and stills.')))
      .not.toContain('tricolon-density')
  })

  it('flags metronomic sentence lengths over 15 sentences', () => {
    const uniform = Array.from({ length: 16 }, (_, i) => `Editor number ${String(i)} cut seven clips from the episode.`).join(' ')
    expect(rules(articleStyleProblems(uniform))).toContain('sentence-uniformity')
    const short = Array.from({ length: 14 }, (_, i) => `Editor number ${String(i)} cut seven clips from the episode.`).join(' ')
    expect(rules(articleStyleProblems(short))).not.toContain('sentence-uniformity')
  })

  it('flags paragraphs of the same size', () => {
    const para = 'We cut the clip at the argument. Musa added captions before lunch. The channel posted it the next morning.'
    const problems = rules(articleStyleProblems(Array.from({ length: 6 }, () => para).join('\n\n')))
    expect(problems).toContain('paragraph-uniformity')
  })

  it('flags bold-first bullets past half, not at half', () => {
    const over = '- **Speed**: fast\n- **Price**: low\n- **Support**: kind\n- plain item'
    expect(rules(articleStyleProblems(over))).toContain('bold-first-bullets')
    const half = '- **Speed**: fast\n- **Price**: low\n- plain one\n- plain two'
    expect(rules(articleStyleProblems(half))).not.toContain('bold-first-bullets')
  })

  it('flags mostly-question headings', () => {
    const qs = '## Why clip?\n\nBecause.\n\n## What length?\n\nShort.\n\n## Which tool?\n\nAny.'
    expect(rules(articleStyleProblems(qs))).toContain('question-headings')
    const mixed = '## Why clip?\n\nBecause.\n\n## Length\n\nShort.\n\n## Tools\n\nAny.'
    expect(rules(articleStyleProblems(mixed))).not.toContain('question-headings')
  })

  it('allows one exclamation mark per 1000 words', () => {
    expect(EXCLAMATION_WORDS_PER_ALLOWED).toBe(1000)
    expect(rules(articleStyleProblems('That clip did well! We cut more.'))).not.toContain('exclamations')
    expect(rules(articleStyleProblems('That clip did well! We cut more!'))).toContain('exclamations')
  })
})

const existing: RemoteArticle[] = [
  {
    id: 'a1',
    slug: 'podcast-clipping-guide',
    title: 'Podcast clipping guide',
    url: `${BASE}/blog/podcast-clipping-guide`,
    status: 'published',
    tags: [],
  },
  { id: 'a2', slug: 'old-draft', title: 'Old draft', url: `${BASE}/blog/old-draft`, status: 'draft', tags: [] },
]

function ctx(overrides: Partial<DraftContext> = {}): DraftContext {
  return { siteBaseUrl: BASE, existing, internalUrls: [`${BASE}/pricing/`, '/'], ...overrides }
}

const ruleIds = (problems: readonly DraftProblem[]): string[] => problems.map(p => p.rule)

function failing(change: (d: ArticleDraft) => void, context: DraftContext = ctx()): string[] {
  const draft = baseDraft()
  change(draft)
  return ruleIds(draftProblems(draft, context))
}

describe('draft checks', () => {
  it('passes the baseline draft', () => {
    expect(wordCount(BODY)).toBeGreaterThanOrEqual(900)
    expect(draftProblems(baseDraft(), ctx())).toEqual([])
  })

  it.each<[string, (d: ArticleDraft) => void]>([
    ['slug-format', (d) => { d.slug = 'Podcast_Clips' }],
    ['slug-length', (d) => { d.slug = 'a'.repeat(71) }],
    ['title-length', (d) => { d.title = 'x'.repeat(71) }],
    ['title-missing', (d) => { d.title = ' ' }],
    ['title-clickbait', (d) => { d.title = 'You won\'t believe these clips' }],
    ['title-clickbait', (d) => { d.title = 'STOP CLIPPING podcasts like this' }],
    ['title-clickbait', (d) => { d.title = 'The BEST way to clip' }],
    ['metaTitle-length', (d) => { d.metaTitle = 'x'.repeat(61) }],
    ['metaDescription-length', (d) => { d.metaDescription = 'Too short.' }],
    ['metaDescription-length', (d) => { d.metaDescription = 'x'.repeat(161) }],
    ['dek-length', (d) => { d.dek = 'x'.repeat(161) }],
    ['body-too-short', (d) => { d.bodyMarkdown = section('One', '') }],
    ['body-html', (d) => { d.bodyMarkdown += '\n\n<div class="x">hi</div>' }],
    ['body-h1', (d) => { d.bodyMarkdown = `# Title again\n\n${d.bodyMarkdown}` }],
    ['body-h1', (d) => { d.bodyMarkdown = `Title again\n===\n\n${d.bodyMarkdown}` }],
    ['body-h2-count', (d) => { d.bodyMarkdown = d.bodyMarkdown.replace('## Open', '### Open').replace('## What', '### What') }],
    ['body-heading-skip', (d) => { d.bodyMarkdown = d.bodyMarkdown.replace('## Captions', '#### Captions') }],
    ['internal-links', (d) => { d.bodyMarkdown = d.bodyMarkdown.replace('(/blog/podcast-clipping-guide)', '(https://example.org/guide)') }],
    ['link-unknown-internal', (d) => { d.bodyMarkdown += `\n\nSee [the guide](${BASE}/blog/made-up-guide).` }],
    ['link-unknown-internal', (d) => { d.bodyMarkdown += '\n\nSee [the old draft](/blog/old-draft).' }],
    ['link-relative', (d) => { d.bodyMarkdown += '\n\nSee [pricing](pricing).' }],
    ['link-not-https', (d) => { d.bodyMarkdown += '\n\nSee [a site](http://example.org/page).' }],
    ['stats-unsourced', (d) => { d.sources = [] }],
    ['source-not-https', (d) => { d.sources.push({ title: 'Old', url: 'http://example.org/study' }) }],
    ['source-not-linked', (d) => { d.sources.push({ title: 'Unlinked', url: 'https://example.org/study' }) }],
    ['faq-count', (d) => { d.faq = d.faq.slice(0, 2) }],
    ['faq-count', (d) => { d.faq = Array.from({ length: 7 }, () => ({ q: 'Why?', a: FAQ_ANSWER })) }],
    ['faq-answer-length', (d) => { d.faq = d.faq.map(f => ({ ...f, a: 'Yes.' })) }],
    ['faq-answer-length', (d) => { d.faq = d.faq.map(f => ({ ...f, a: `${FAQ_ANSWER} ${FAQ_ANSWER}` })) }],
    ['faq-question', (d) => { d.faq = d.faq.map(f => ({ ...f, q: '' })) }],
    ['tags-count', (d) => { d.tags = [] }],
    ['tags-count', (d) => { d.tags = ['a', 'b', 'c', 'd', 'e', 'f'] }],
    ['cover-alt', (d) => { d.coverAlt = '' }],
    ['cover-not-https', (d) => { d.coverImageUrl = 'http://example.org/c.png' }],
    ['clip-malformed', (d) => { d.bodyMarkdown += '\n\n::clip[bad id]' }],
    ['clip-malformed', (d) => { d.bodyMarkdown += '\n\n::clip[abc]' }],
    ['style:long-dash', (d) => { d.bodyMarkdown += '\n\nOne more thing \u2014 captions.' }],
    ['style:delve', (d) => { d.dek = 'We delve into clipping.' }],
    ['style:seamless', (d) => { d.faq = d.faq.map(f => ({ ...f, a: `${FAQ_ANSWER} It is seamless.` })) }],
    ['style:game-changer', (d) => { d.metaDescription = `${d.metaDescription.slice(0, 100)} A game-changer.` }],
  ])('flags %s', (rule, change) => {
    expect(failing(change)).toContain(rule)
  })

  it('flags a taken slug unless the draft updates that article', () => {
    expect(failing((d) => { d.slug = 'old-draft' })).toContain('slug-taken')
    expect(failing((d) => { d.slug = 'old-draft' }, ctx({ updatingId: 'a2' }))).not.toContain('slug-taken')
  })

  it('applies custom word limits', () => {
    expect(failing(() => undefined, ctx({ maxWords: 500 }))).toContain('body-too-long')
    expect(failing(() => undefined, ctx({ minWords: 5000 }))).toContain('body-too-short')
  })

  it('flags the site\'s banned phrases in any field', () => {
    const problems = draftProblems(baseDraft(), ctx({ bannedPhrases: ['eleven  PODCAST episodes'] }))
    expect(problems.filter(p => p.rule === 'banned-phrase').map(p => p.field).sort()).toEqual(['body', 'metaDescription'])
  })

  it('requires a clip only when the site asks', () => {
    const noClip = (d: ArticleDraft): void => { d.bodyMarkdown = d.bodyMarkdown.replace('::clip[lekki_rent_52]', '') }
    expect(failing(noClip, ctx({ requireClip: true }))).toContain('clip-missing')
    expect(failing(noClip)).not.toContain('clip-missing')
    expect(failing(() => undefined, ctx({ requireClip: true }))).not.toContain('clip-missing')
  })

  it('ignores HTML and headings inside code blocks', () => {
    expect(failing((d) => { d.bodyMarkdown += '\n\n```html\n# not a heading\n<div>x</div>\n```' })).toEqual([])
  })

  it('needs no sources when the body states no figures', () => {
    expect(failing((d) => {
      d.bodyMarkdown = d.bodyMarkdown.replace(/YouTube says[^\n]*/u, 'We kept a sheet of results.')
      d.sources = []
    })).toEqual([])
  })

  it('gives plain-language reasons', () => {
    const [problem] = draftProblems({ ...baseDraft(), slug: 'Bad Slug' }, ctx())
    expect(problem).toEqual({
      field: 'slug',
      rule: 'slug-format',
      reason: 'The slug must be lowercase letters and digits joined by single hyphens.',
    })
  })
})

const site: Site = {
  id: 'klipara',
  name: 'Klipara',
  baseUrl: BASE,
  kind: 'klipara',
  enabled: true,
  profile: {
    business: 'Turns long podcasts into short clips',
    audience: 'Podcasters in Nigeria',
    offer: 'Clipping plans',
    voice: 'Plain and first-person',
    cta: { text: 'Try Klipara', url: `${BASE}/signup` },
  },
  markets: [],
  seeds: [],
  gscProperty: 'sc-domain:linkfa.de',
  articlesPerWeek: 2,
  author: { name: 'Dave', url: `${BASE}/about`, bio: 'Runs Klipara' },
  createdAt: '2026-10-01T00:00:00Z',
}

function reply(scores: Record<string, number>, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ scores, total: 50, mustFix: [], verdict: 'publish', ...extra })
}

const GOOD = { directness: 8, specificity: 7, voice: 7, accuracy: 8, usefulness: 7 }

describe('editorial review', () => {
  it('builds a prompt with the article, the query, and the reply format', () => {
    const prompt = editorPrompt(baseDraft(), site, 'podcast clips for shorts')
    expect(prompt).toContain('"podcast clips for shorts"')
    expect(prompt).toContain('Plain and first-person')
    expect(prompt).toContain('::clip[lekki_rent_52]')
    expect(prompt).toContain(SOURCE_URL)
    expect(prompt).toContain('"scores":{"directness"')
    for (const d of ['directness', 'specificity', 'voice', 'accuracy', 'usefulness']) expect(prompt).toContain(`${d}:`)
  })

  it('parses fenced JSON and recomputes the total', () => {
    const review = parseEditorReply(`Here you go:\n\`\`\`json\n${reply(GOOD)}\n\`\`\``)
    expect(review).toEqual({ scores: GOOD, total: 37, mustFix: [], verdict: 'publish', pass: true })
  })

  it('passes at exactly the thresholds', () => {
    expect(PASS_TOTAL).toBe(35)
    expect(MIN_DIMENSION).toBe(6)
    expect(parseEditorReply(reply({ directness: 7, specificity: 7, voice: 7, accuracy: 7, usefulness: 7 })).pass).toBe(true)
  })

  it.each([
    ['a low total', reply({ directness: 7, specificity: 7, voice: 7, accuracy: 7, usefulness: 6 })],
    ['a weak dimension', reply({ directness: 10, specificity: 10, voice: 5, accuracy: 10, usefulness: 10 })],
    ['a must-fix item', reply(GOOD, { mustFix: ['Cite the 40% figure'] })],
    ['a revise verdict', reply(GOOD, { verdict: 'revise' })],
  ])('fails with %s', (_, text) => {
    expect(parseEditorReply(text).pass).toBe(false)
  })

  it.each([
    ['no JSON', 'Looks good to me.'],
    ['broken JSON', '{"scores": {'],
    ['a missing score', reply({ directness: 8, specificity: 7, voice: 7, accuracy: 8 })],
    ['an out-of-range score', reply({ ...GOOD, voice: 11 })],
    ['a fractional score', reply({ ...GOOD, voice: 6.5 })],
    ['a bad verdict', reply(GOOD, { verdict: 'ship it' })],
    ['a non-array mustFix', reply(GOOD, { mustFix: 'none' })],
  ])('throws on %s', (_, text) => {
    expect(() => parseEditorReply(text)).toThrow(/editor reply/u)
  })
})

describe('article images', () => {
  const longBody = baseDraft().bodyMarkdown
  it('passes images copied to the site with real alt text', () => {
    const draft = { ...baseDraft(), bodyMarkdown: `${longBody}\n\n![The Klipara free-clip form on a phone](${BASE}/media/med_1.png)\n` }
    expect(draftProblems(draft, ctx()).filter(p => p.rule.startsWith('image') || p.rule.startsWith('cover'))).toEqual([])
  })

  it('refuses hotlinked images, empty alt text, a missing or off-site cover, and too many images', () => {
    const offsite = { ...baseDraft(), bodyMarkdown: `${longBody}\n\n![](https://i.imgur.com/x.png)\n` }
    expect(draftProblems(offsite, ctx()).map(p => p.rule)).toEqual(expect.arrayContaining(['image-alt', 'image-not-hosted']))
    const { coverImageUrl: _c, coverAlt: _a, ...noCover } = baseDraft()
    expect(draftProblems(noCover, ctx()).map(p => p.rule)).toContain('cover-missing')
    expect(draftProblems({ ...baseDraft(), coverImageUrl: 'https://cdn.example/cover.png' }, ctx()).map(p => p.rule)).toContain('cover-not-hosted')
    const many = { ...baseDraft(), bodyMarkdown: `${longBody}\n\n${Array.from({ length: 12 }, (_, i) => `![Step ${String(i)} of the setup](${BASE}/media/${String(i)}.png)`).join('\n\n')}\n` }
    expect(draftProblems(many, ctx()).map(p => p.rule)).toContain('images-too-many')
  })
})
