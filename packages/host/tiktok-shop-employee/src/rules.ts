/**
 * What a script may say, and which products may be promoted at all.
 *
 * The narrator never used the product, so a line that claims personal use
 * ("I've been using this", "my skin") is a fake testimonial: unlawful in UK
 * advertising (DMCC Act 2024, CAP Code testimonials rules) and grounds for
 * TikTok Shop to penalise an affiliate. Health cures, guaranteed results and
 * prices other than the listing's are refused for the same reason.
 */

/** One rule a script line broke. */
export interface ScriptProblem {
  line: number
  text: string
  why: string
}

const FIRST_PERSON_USE = [
  /\bI(?:'ve| have)?\s+(?:been\s+)?(?:using|used|tried|tested|bought|ordered|wear|wore|own)\b/iu,
  /\bI\s+(?:love|swear by|can'?t live without|use|recommend)\b/iu,
  /\bmy\s+(?:skin|hair|lips|face|body|kids?|children|husband|wife|partner|home|kitchen|routine|car|dog|cat|baby|nails|teeth)\b/iu,
  /\b(?:changed|saved)\s+my\s+life\b/iu,
  /\bmy\s+(?:new\s+)?(?:favou?rite|go-?to|holy grail|obsession)\b/iu,
  /\bwe\s+(?:tried|tested|use|love|bought)\b/iu,
]

const MEDICAL = [
  /\b(?:cures?|cured|heals?|healed)\b/iu,
  /\b(?:eczema|psoriasis|acne|arthritis|diabetes|anxiety|depression|insomnia|cancer|infection)\b/iu,
  /\blose\s+\d+\s*(?:kg|kilos?|lbs?|pounds|stone)\b/iu,
  /\bguarantee[ds]?\b/iu,
  /\bclinically\s+proven\b/iu,
]

/**
 * The problems in a script.
 * @param lines - the spoken lines, the on-screen captions and the hook, as written.
 * @param price - the listing's price, as written on screen and in speech (`£12.99`).
 * @returns every problem found; empty when the script may be rendered.
 */
export function scriptProblems(lines: readonly string[], price: string): ScriptProblem[] {
  const problems: ScriptProblem[] = []
  const priceValue = Number.parseFloat(price.replace(/[^\d.]/gu, ''))
  lines.forEach((text, line) => {
    for (const rule of FIRST_PERSON_USE) {
      if (rule.test(text)) { problems.push({ line, text, why: 'claims the narrator used or owns the product; nobody here did. Describe what the product does, from the listing.' }); break }
    }
    for (const rule of MEDICAL) {
      if (rule.test(text)) { problems.push({ line, text, why: 'makes a health, cure or guaranteed-result claim, which UK advertising rules forbid without evidence.' }); break }
    }
    for (const match of text.matchAll(/£\s?(\d+(?:\.\d{1,2})?)/gu)) {
      const value = Number.parseFloat(match[1] ?? '')
      if (Number.isFinite(priceValue) && Math.abs(value - priceValue) > 0.005) {
        problems.push({ line, text, why: `names £${match[1] ?? ''}, but the listing price is ${price}.` })
      }
    }
  })
  return problems
}

/** Default words that keep a product out: things the owner does not promote. */
export const DEFAULT_BLOCKED_WORDS = [
  'alcohol', 'wine', 'beer', 'vodka', 'whisky', 'gin', 'cocktail', 'vape', 'e-cig', 'cigarette', 'tobacco', 'shisha',
  'pork', 'bacon', 'ham', 'gelatin', 'casino', 'betting', 'gambling', 'poker', 'lingerie', 'erotic', 'adult toy', 'sex',
  'tarot', 'horoscope', 'crystal healing', 'cbd', 'kratom',
]

/**
 * Whether a product may be promoted.
 * @param product - its title, category and description.
 * @param blocked - words that keep a product out, matched as whole words, ignoring case.
 * @returns the blocked word found, or undefined when the product is allowed.
 */
export function blockedWord(
  product: { title: string; category?: string; description?: string }, blocked: readonly string[],
): string | undefined {
  const haystack = `${product.title} ${product.category ?? ''} ${product.description ?? ''}`.toLowerCase()
  return blocked.find(word => word.trim() !== '' && new RegExp(`(?:^|[^\\p{L}])${word.trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?:$|[^\\p{L}])`, 'u').test(haystack))
}

/**
 * The post caption: the advertising label first (UK rules want it up front on affiliate posts, not among the
 * hashtags), then the model's text and the hashtags.
 * @param caption - the model's caption.
 * @param hashtags - without `#`.
 * @returns the caption to paste into TikTok.
 */
export function finalCaption(caption: string, hashtags: readonly string[]): string {
  const tags = hashtags.map(t => t.replace(/^#/u, '').replace(/\s+/gu, '')).filter(t => t !== '' && t.toLowerCase() !== 'ad')
  const body = caption.trim().replace(/^#ad\b\s*/iu, '')
  return `#ad ${body}${tags.length === 0 ? '' : `\n\n${[...new Set(tags)].slice(0, 5).map(t => `#${t}`).join(' ')}`}`
}
