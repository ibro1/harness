/**
 * Phrasing that marks a message as machine-written. A pitch goes out under a
 * person's account to a creator who gets many of them; a comment that reads
 * like a template is ignored, and Google's spam filters look for the same
 * patterns. `scout_pitch` refuses text that has any of these, naming each, so
 * the model rewrites it plainly before anything is sent.
 *
 * The list is narrow on purpose: each entry is a phrase people rarely use in a
 * quick note to a stranger, not ordinary words that also appear in AI text.
 */

/** One tell: what to look for and what to do instead. */
interface Tell {
  pattern: RegExp
  name: string
  instead: string
}

const TELLS: readonly Tell[] = [
  { pattern: /[—–]/u, name: 'a long dash (— or –)', instead: 'use a comma or a full stop' },
  { pattern: /\bhope (?:this|my) (?:message|email|note|comment) finds you\b/iu, name: '"hope this finds you well"', instead: 'start with the point' },
  { pattern: /\bsuch an? (?:inspiring|amazing|incredible|powerful|insightful|beautiful|great|wonderful|fantastic)\b/iu, name: '"such an inspiring/amazing…"', instead: 'say what you liked in plain words' },
  { pattern: /\b(?:truly|incredibly|absolutely|genuinely) (?:inspiring|insightful|amazing|powerful|fascinating|incredible)\b/iu, name: 'stacked praise ("truly inspiring")', instead: 'drop the adverb, or name the moment' },
  { pattern: /\blet me know if you(?:'d| would) (?:like|be interested)\b/iu, name: '"let me know if you would like…"', instead: 'ask directly, e.g. "want it?"' },
  { pattern: /\b(?:resonated|resonates) with\b/iu, name: '"resonated with"', instead: 'say what stood out' },
  { pattern: /\blife[- ]changing\b|\bgame[- ]changer\b/iu, name: '"life-changing" / "game-changer"', instead: 'describe what actually happened' },
  { pattern: /\b(?:delve|tapestry|testament to|in today's (?:world|fast-paced)|navigate the complexities|unlock (?:the|your) (?:full )?potential|elevate your)\b/iu, name: 'stock AI wording (delve, testament to, elevate…)', instead: 'use everyday words' },
  { pattern: /\b(?:valuable|key) (?:insights|takeaways)\b|\bthought-provoking\b/iu, name: '"valuable insights" / "thought-provoking"', instead: 'name the actual point' },
  { pattern: /\bI (?:came across|stumbled upon) your\b/iu, name: '"I came across your…"', instead: 'skip the preamble' },
  { pattern: /\bkeep up the (?:great|amazing|good) work\b/iu, name: '"keep up the great work"', instead: 'leave it out' },
]

/**
 * The machine-writing tells in a text.
 * @param text - the pitch.
 * @returns each tell found, with what to do instead; empty when the text reads as written by a person.
 */
export function styleProblems(text: string): string[] {
  const found = TELLS.filter(tell => tell.pattern.test(text)).map(tell => `${tell.name}: ${tell.instead}`)
  const exclamations = (text.match(/!/gu) ?? []).length
  if (exclamations > 1) found.push(`${String(exclamations)} exclamation marks: one at most`)
  return found
}
