/**
 * Machine-writing tells in a long-form article. Articles auto-publish under the
 * owner's name, so `draftProblems` refuses a body with any of these and the
 * writer rewrites the named passages before anything goes live.
 *
 * Two kinds of check. Hard tells are phrases and marks a careful human editor
 * cuts on sight, so one occurrence is a problem. Pattern tells are habits that
 * are fine once and suspicious in bulk (three-item lists, uniform sentence
 * lengths, bold-led bullets), so they are measured over the whole text and
 * reported only past a threshold.
 *
 * The lists stay narrow on purpose: each entry is something an editor would
 * cut from a published article, not ordinary words that also appear in AI text.
 * Code blocks, inline code, URLs and `::clip[id]` lines are removed before any
 * check runs.
 */

/** One place where an article reads as machine-written. */
export interface StyleProblem {
  /** Stable rule id, for example `long-dash` or `sentence-uniformity`. */
  rule: string
  /** The offending text (at most 80 characters) or, for whole-text measures, the measurement. */
  found: string
  /** What is wrong and what to write instead, in plain words. */
  fix: string
}

/** More than one Oxford-comma list of exactly three items per this many words is a problem. */
export const TRICOLON_WORDS_PER_ALLOWED = 400
/** Sentence lengths whose coefficient of variation is below this read as metronomic. */
export const MIN_SENTENCE_LENGTH_CV = 0.35
/** Sentence-length variation is only judged over at least this many prose sentences. */
export const SENTENCE_CV_MIN_SENTENCES = 15
/** Paragraph lengths whose coefficient of variation is below this read as templated. */
export const MIN_PARAGRAPH_LENGTH_CV = 0.25
/** Paragraph-length variation is only judged over at least this many prose paragraphs. */
export const PARAGRAPH_CV_MIN_PARAGRAPHS = 6
/** More than this share of bullets opening with bold text is a problem. */
export const MAX_BOLD_BULLET_RATIO = 0.5
/** The bold-bullet share is only judged over at least this many bullets. */
export const BOLD_BULLET_MIN_BULLETS = 3
/** More than this share of section headings phrased as questions is a problem. */
export const MAX_QUESTION_HEADING_RATIO = 0.6
/** The question-heading share is only judged over at least this many headings. */
export const QUESTION_HEADING_MIN_HEADINGS = 3
/** More than one exclamation mark per this many words (and always more than one) is a problem. */
export const EXCLAMATION_WORDS_PER_ALLOWED = 1000
/** At most this many findings are listed per hard tell; the rest are counted in one extra finding. */
export const MAX_FINDINGS_PER_RULE = 5

const MAX_EXCERPT = 80

interface Tell {
  rule: string
  pattern: RegExp
  fix: string
}

const INTENSIFIERS = 'really|truly|very|incredibly|deeply|genuinely|absolutely|highly|extremely|fundamentally|remarkably|'
  + 'seamlessly|effortlessly|completely|totally|utterly|simply|actually|literally|particularly|especially|significantly|'
  + 'undeniably|exceptionally|profoundly|vastly|super'

/** "Leverage" used as a verb; the noun ("financial leverage", "a leveraged buyout") is left alone. */
const LEVERAGE_VERB = new RegExp([
  String.raw`\bleverag(?:ing|es)\b`,
  String.raw`\bleveraged (?!buy-?outs?\b|loans?\b|ETFs?\b|funds?\b|positions?\b)`,
  String.raw`\bleverage (?:the|your|our|their|this|these|those|its|my|it|them|AI|data)\b`,
  String.raw`\b(?:to|can|could|will|should|must|we|you|they|I) leverage\b`,
].join('|'), 'giu')

const HARD_TELLS: readonly Tell[] = [
  {
    rule: 'long-dash',
    pattern: /[\u2014\u2013]|\s--\s/gu,
    fix: 'Long dashes read as machine-written; use a comma, a full stop, brackets, or "to" for a range.',
  },
  { rule: 'delve', pattern: /\bdelv(?:e|es|ed|ing)\b/giu, fix: '"Delve" is a stock AI word; say "look at" or just make the point.' },
  { rule: 'tapestry', pattern: /\btapestr(?:y|ies)\b/giu, fix: '"Tapestry" is ornamental; say "mix" or name the parts.' },
  { rule: 'testament-to', pattern: /\btestament to\b/giu, fix: '"A testament to" inflates; say what the fact shows, plainly.' },
  {
    rule: 'in-todays-world',
    pattern: /\bin today's (?:[\w-]+ ){0,2}(?:world|age|era|landscape)\b/giu,
    fix: '"In today\'s ... world" is filler; start with the actual point.',
  },
  {
    rule: 'navigate-landscape',
    pattern: /\bnavigat(?:e|es|ed|ing) (?:the |this |an? )?(?:[\w-]+ ){0,2}(?:landscape|complexities|maze)\b/giu,
    fix: '"Navigate the landscape" is jargon; name the actual problem and what to do about it.',
  },
  {
    rule: 'unlock-potential',
    pattern: /\bunlock(?:s|ed|ing)? (?:the|your|its|their|our) (?:full |true )?potential\b/giu,
    fix: '"Unlock your potential" promises nothing specific; say what the reader gets.',
  },
  {
    rule: 'elevate-your',
    pattern: /\belevat(?:e|es|ed|ing) your\b/giu,
    fix: '"Elevate your ..." is marketing filler; say what changes and by how much.',
  },
  {
    rule: 'game-changer',
    pattern: /\bgame[- ]chang(?:er|ers|ing)\b/giu,
    fix: '"Game-changer" is empty praise; describe what actually changed.',
  },
  { rule: 'seamless', pattern: /\bseamless(?:ly)?\b/giu, fix: '"Seamless" is a stock AI word; say what the reader no longer has to do.' },
  {
    rule: 'robust',
    pattern: /\brobust(?:ly|ness)?\b/giu,
    fix: '"Robust" is a stock AI word; say "reliable", "strong", or what it survives.',
  },
  {
    rule: 'leverage-verb',
    pattern: LEVERAGE_VERB,
    fix: '"Leverage" as a verb is jargon; say "use".',
  },
  {
    rule: 'important-to-note',
    pattern: /\bit(?:'s| is) (?:important|worth|crucial|essential) (?:to note|noting|to remember|to mention|mentioning)\b/giu,
    fix: '"It\'s important to note" announces instead of saying; state the point.',
  },
  {
    rule: 'signposted-conclusion',
    pattern: /\b(?:in conclusion|to sum up|in summary|to summari[sz]e)\b/giu,
    fix: 'Do not announce the ending; end on the last useful point or the call to action.',
  },
  {
    rule: 'ultimately-conclusion',
    pattern: /(?:^|[.!?]["')]?\s+)(?:#+\s+)?(?:Ultimately|At the end of the day|All in all)\b/gmu,
    fix: 'A wrap-up that opens with "Ultimately" or "At the end of the day" is a stock AI ending; end on the last useful point.',
  },
  {
    rule: 'empty-transition',
    pattern: /(?:^|[.!?]["')]?\s+)(?:Moreover|Furthermore|Additionally|In addition),/gmu,
    fix: 'A sentence opened with "Moreover/Furthermore/Additionally," is an empty transition; start with the point.',
  },
  {
    rule: 'weak-intro',
    pattern: new RegExp([
      "in this (?:article|post|guide|blog post),? (?:we|I)(?:'ll| will| are going to)",
      'have you ever wondered',
      'are you looking for (?:a|an|the|ways)',
      'look no further',
    ].map(p => `\\b${p}\\b`).join('|'), 'giu'),
    fix: 'Announcing the article or asking the reader a setup question is a stock intro; answer the query in the first line.',
  },
  {
    rule: 'ever-evolving',
    pattern: /\bever-(?:evolving|changing|growing) (?:landscape|world|industry|space)\b/giu,
    fix: '"Ever-evolving landscape" is stock filler; name what actually changed.',
  },
  {
    rule: 'whether-youre-a',
    pattern: /\bwhether you(?:'re| are) an? [^.?!;\n]{1,50}?\bor (?:an? )?\w/giu,
    fix: '"Whether you\'re a X or a Y" is a stock opener; write for the one reader the article is for.',
  },
  {
    rule: 'not-just-but',
    pattern: /\bnot (?:just|only|merely|simply) [^.?!;:\n]{1,80}?\bbut\b/giu,
    fix: 'The "not just X, but Y" contrast is a stock AI move; state Y directly.',
  },
  {
    rule: 'not-x-its-y',
    pattern: /(?:\b(?:is|was|are)(?:n't| not)|'s not) [^.?!;:\n]{1,60}?[,;.]\s+(?:it|this|that|they)(?:'s| is| was|'re| are)\b/giu,
    fix: 'The "it\'s not X, it\'s Y" reveal is a stock AI move; say what it is.',
  },
  {
    rule: 'lets-dive-in',
    pattern: /\blet(?:'s| us) (?:dive|delve|unpack|break (?:it|this|that) down)\b/giu,
    fix: '"Let\'s dive in" is throat-clearing; start with the first useful thing.',
  },
  { rule: 'embark', pattern: /\bembark(?:s|ed|ing)?\b/giu, fix: '"Embark" is inflated; say "start".' },
  { rule: 'realm', pattern: /\brealms?\b/giu, fix: '"Realm" is inflated; say "field", "area", or name it.' },
  {
    rule: 'harness-the-power',
    pattern: /\bharness(?:es|ed|ing)? the (?:full )?power\b/giu,
    fix: '"Harness the power of" is filler; say "use".',
  },
  {
    rule: 'stacked-hedge',
    pattern: /\b(?:may|might|could|can) (?:potentially|possibly|perhaps|conceivably)\b/giu,
    fix: 'A double hedge ("may potentially") says nothing; pick one word, or state what is known.',
  },
  {
    rule: 'stacked-adverbs',
    pattern: new RegExp(`\\b(?:${INTENSIFIERS}) (?:${INTENSIFIERS})\\b`, 'giu'),
    fix: 'Two intensifiers in a row is padding; cut both and let the fact carry the weight.',
  },
  {
    rule: 'imagine-opener',
    pattern: /(?:^|[.!?]["')]?\s+)(?:#+\s+|[-*+]\s+)?\**Imagine\b/gmu,
    fix: '"Imagine ..." openers are a stock setup; describe a real case instead.',
  },
  {
    rule: 'rhetorical-question',
    pattern: /(?:^|[.!?]\s+)(?:The|Your|Our|My|And the|But the) [\w' ]{1,30}\?[ \t]+(?=\S)/gmu,
    fix: 'A question answered in the next breath ("The result? ...") is a stock AI move; make the statement.',
  },
  {
    rule: 'emoji',
    pattern: /(?![\u00a9\u00ae\u2122])\p{Extended_Pictographic}/gu,
    fix: 'Remove emoji and pictographic symbols from the article text.',
  },
]

type BlockKind = 'heading' | 'list' | 'prose' | 'other'

interface Block {
  kind: BlockKind
  text: string
}

/**
 * The article text the style checks read: curly quotes straightened, code,
 * images, URLs, link targets, HTML comments and `::clip[id]` lines removed;
 * link text, headings, lists and emphasis markers kept.
 */
function proseOf(markdown: string): string {
  return markdown
    .replace(/[\u2018\u2019]/gu, '\'')
    .replace(/[\u201c\u201d]/gu, '"')
    .replace(/\r\n?/gu, '\n')
    .replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$/gmu, '')
    .replace(/^(?:`{3,}|~{3,})[\s\S]*$/mu, '')
    .replace(/`[^`\n]*`/gu, '')
    .replace(/<!--[\s\S]*?-->/gu, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/<(?:https?|mailto):[^>\s]*>/giu, '')
    .replace(/\b(?:https?:\/\/|www\.)[^\s)>\]]+/giu, '')
    .replace(/^[ \t]*::clip\[[^\]\n]*\][ \t]*$/gmu, '')
}

function wordsIn(text: string): string[] {
  return text.match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ?? []
}

/**
 * Words a reader sees in an article: code blocks, inline code, URLs, image
 * syntax and `::clip[id]` lines do not count; link text does.
 * @param markdown - the article body.
 * @returns the number of words.
 */
export function wordCount(markdown: string): number {
  return wordsIn(proseOf(markdown)).length
}

const BULLET = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/u

function blocksOf(prose: string): Block[] {
  const blocks: Block[] = []
  let paragraph: string[] = []
  const flush = (): void => {
    if (paragraph.length > 0) blocks.push({ kind: 'prose', text: paragraph.join(' ') })
    paragraph = []
  }
  for (const line of prose.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') flush()
    else if (/^#{1,6}\s/u.test(trimmed)) {
      flush()
      blocks.push({ kind: 'heading', text: trimmed })
    } else if (BULLET.test(line)) {
      flush()
      blocks.push({ kind: 'list', text: trimmed })
    } else if (/^(?:\||>|[-*_]{3,}$|=+$)/u.test(trimmed)) {
      flush()
      blocks.push({ kind: 'other', text: trimmed })
    } else paragraph.push(trimmed)
  }
  flush()
  return blocks
}

function plain(text: string): string {
  return text.replace(/[*_]+/gu, '').replace(/\s+/gu, ' ').trim()
}

function sentencesOf(paragraph: string): string[] {
  return plain(paragraph).split(/(?<=[.!?])["')\]]*\s+(?=["'(\[]?[\p{Lu}\p{N}])/u).filter(s => wordsIn(s).length > 0)
}

function excerpt(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 20)
  const end = Math.min(text.length, index + length + 20)
  let out = text.slice(start, end).replace(/\s+/gu, ' ').trim()
  if (out.length > MAX_EXCERPT) out = text.slice(index, index + length).replace(/\s+/gu, ' ').trim().slice(0, MAX_EXCERPT)
  return out
}

function coefficientOfVariation(values: readonly number[]): number {
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length
  if (mean === 0) return 0
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length
  return Math.sqrt(variance) / mean
}

/** Oxford-comma lists of exactly three short items ("speed, price, and support") in one sentence. */
function tricolonsIn(sentence: string): number {
  const fragments = sentence.split(/,\s+/u)
  let count = 0
  for (let i = 0; i + 2 < fragments.length; i++) {
    const first = fragments[i] ?? ''
    const middle = fragments[i + 1] ?? ''
    const last = fragments[i + 2] ?? ''
    if (!/^(?:and|or) \S/iu.test(last) || /^(?:and|or)\b/iu.test(middle)) continue
    const middleWords = wordsIn(middle).length
    if (middleWords < 1 || middleWords > 4) continue
    const before = fragments[i - 1]
    if (before !== undefined && wordsIn(first).length <= 2 && wordsIn(before).length <= 3) continue
    count++
  }
  return count
}

function hardTellProblems(prose: string): StyleProblem[] {
  const problems: StyleProblem[] = []
  for (const tell of HARD_TELLS) {
    const matches = [...prose.matchAll(tell.pattern)]
    for (const match of matches.slice(0, MAX_FINDINGS_PER_RULE)) {
      problems.push({ rule: tell.rule, found: excerpt(prose, match.index, match[0].length), fix: tell.fix })
    }
    if (matches.length > MAX_FINDINGS_PER_RULE) {
      problems.push({ rule: tell.rule, found: `${String(matches.length - MAX_FINDINGS_PER_RULE)} more like this`, fix: tell.fix })
    }
  }
  return problems
}

function questionOpenerProblems(blocks: readonly Block[]): StyleProblem[] {
  const problems: StyleProblem[] = []
  for (const block of blocks) {
    if (block.kind !== 'prose') continue
    const first = sentencesOf(block.text)[0]
    if (first?.endsWith('?') !== true) continue
    problems.push({
      rule: 'rhetorical-question',
      found: first.slice(0, MAX_EXCERPT),
      fix: 'Opening a paragraph with a question is a stock setup; open with the answer.',
    })
  }
  return problems
}

function ratio(part: number, whole: number): string {
  return `${String(part)} of ${String(whole)}`
}

function patternProblems(blocks: readonly Block[], totalWords: number): StyleProblem[] {
  const problems: StyleProblem[] = []
  const paragraphs = blocks.filter(b => b.kind === 'prose')
  const sentences = paragraphs.flatMap(p => sentencesOf(p.text))
  const listItems = blocks.filter(b => b.kind === 'list')

  const tricolons = [...sentences, ...listItems.map(b => plain(b.text))].reduce((sum, s) => sum + tricolonsIn(s), 0)
  if (tricolons > Math.max(1, totalWords / TRICOLON_WORDS_PER_ALLOWED)) {
    problems.push({
      rule: 'tricolon-density',
      found: `${String(tricolons)} three-item lists in ${String(totalWords)} words`,
      fix: `Lists of exactly three read as formula; use two items or one (at most one per ${String(TRICOLON_WORDS_PER_ALLOWED)} words).`,
    })
  }

  if (sentences.length >= SENTENCE_CV_MIN_SENTENCES) {
    const cv = coefficientOfVariation(sentences.map(s => wordsIn(s).length))
    if (cv < MIN_SENTENCE_LENGTH_CV) {
      problems.push({
        rule: 'sentence-uniformity',
        found: `sentence-length variation ${cv.toFixed(2)} over ${String(sentences.length)} sentences`,
        fix: 'Sentences are all about the same length; vary sentence length, mixing short sentences with long ones '
          + `(variation ${String(MIN_SENTENCE_LENGTH_CV)} or more).`,
      })
    }
  }

  if (paragraphs.length >= PARAGRAPH_CV_MIN_PARAGRAPHS) {
    const cv = coefficientOfVariation(paragraphs.map(p => wordsIn(p.text).length))
    if (cv < MIN_PARAGRAPH_LENGTH_CV) {
      problems.push({
        rule: 'paragraph-uniformity',
        found: `paragraph-length variation ${cv.toFixed(2)} over ${String(paragraphs.length)} paragraphs`,
        fix: 'Paragraphs are all about the same size; let each one be as long as its idea needs.',
      })
    }
  }

  if (listItems.length >= BOLD_BULLET_MIN_BULLETS) {
    const bold = listItems.filter(b => /^(?:[-*+]|\d+[.)])\s+(?:\*\*|__)\S/u.test(b.text)).length
    if (bold / listItems.length > MAX_BOLD_BULLET_RATIO) {
      problems.push({
        rule: 'bold-first-bullets',
        found: `${ratio(bold, listItems.length)} bullets open with bold text`,
        fix: 'Bullets that each open with a bold label are a machine-formatting habit; drop the bold leads.',
      })
    }
  }

  const headings = blocks.filter(b => b.kind === 'heading' && /^#{2,6}\s/u.test(b.text))
  if (headings.length >= QUESTION_HEADING_MIN_HEADINGS) {
    const questions = headings.filter(h => plain(h.text).endsWith('?')).length
    if (questions / headings.length > MAX_QUESTION_HEADING_RATIO) {
      problems.push({
        rule: 'question-headings',
        found: `${ratio(questions, headings.length)} headings are questions`,
        fix: 'Most headings are questions; phrase sections as statements and keep questions for the FAQ.',
      })
    }
  }

  const exclamations = blocks.filter(b => b.kind !== 'other').reduce((sum, b) => sum + (b.text.match(/!/gu) ?? []).length, 0)
  if (exclamations > Math.max(1, totalWords / EXCLAMATION_WORDS_PER_ALLOWED)) {
    problems.push({
      rule: 'exclamations',
      found: `${String(exclamations)} exclamation marks in ${String(totalWords)} words`,
      fix: `Too many exclamation marks; keep at most one per ${String(EXCLAMATION_WORDS_PER_ALLOWED)} words.`,
    })
  }
  return problems
}

/**
 * The machine-writing tells in an article.
 * @param markdown - the article body (or any article text, such as a dek or an FAQ answer).
 * @returns each problem with an excerpt and what to write instead; empty when the text reads as written by a person.
 */
export function articleStyleProblems(markdown: string): StyleProblem[] {
  const prose = proseOf(markdown)
  const blocks = blocksOf(prose)
  return [
    ...hardTellProblems(prose),
    ...questionOpenerProblems(blocks),
    ...patternProblems(blocks, wordsIn(prose).length),
  ]
}
