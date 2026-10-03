/**
 * Long-tail keywords from autocomplete: what people type into YouTube's and
 * Google's search boxes after a seed (`suggestqueries.google.com`, `ds=yt`
 * for YouTube). Suggestions are phrasings people use, never volumes; how many
 * distinct ones a seed yields is a rough demand signal. No key is needed.
 */

/** Where suggestions come from. */
export type SuggestSource = 'youtube' | 'google'

/** How far to expand a seed. */
export type Expansion = 'basic' | 'questions' | 'alphabet'

/** Question words put before the seed for `questions`. */
export const QUESTION_PREFIXES = ['how', 'why', 'what', 'is', 'can', 'best', 'vs'] as const

/**
 * Read an autocomplete answer. The `firefox` client answers `["q", ["s1", "s2"], …]`; the `youtube` client answers
 * JSONP, `window.google.ac.h(["q", [["s1", 0, […]], …], …])`; both are read.
 * @param body - the response text.
 * @returns the suggestions in order, without duplicates.
 */
export function parseSuggestions(body: string): string[] {
  let text = body.trim()
  const jsonp = /^[\w.]+\(([\s\S]*)\)\s*;?$/u.exec(text)
  if (jsonp?.[1] !== undefined) text = jsonp[1]
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  if (!Array.isArray(parsed) || !Array.isArray(parsed[1])) return []
  const out: string[] = []
  for (const entry of parsed[1] as unknown[]) {
    const value = typeof entry === 'string' ? entry : Array.isArray(entry) && typeof entry[0] === 'string' ? entry[0] : undefined
    const clean = value?.trim().toLowerCase()
    if (clean !== undefined && clean !== '' && !out.includes(clean)) out.push(clean)
  }
  return out
}

/**
 * The queries one expansion asks.
 * @param seed - the seed keyword.
 * @param expansion - `basic` asks the seed alone; `questions` adds question words before it; `alphabet` adds the seed
 * followed by each letter a–z.
 * @returns the queries, the seed first.
 */
export function expansionQueries(seed: string, expansion: Expansion): string[] {
  const base = seed.trim().toLowerCase().replace(/\s+/gu, ' ')
  if (base === '') return []
  if (expansion === 'questions') return [base, ...QUESTION_PREFIXES.map(p => `${p} ${base}`)]
  if (expansion === 'alphabet') return [base, ...'abcdefghijklmnopqrstuvwxyz'.split('').map(c => `${base} ${c}`)]
  return [base]
}

/** One autocomplete request. */
export interface SuggestRequest {
  query: string
  source: SuggestSource
  /** Two-letter country, lower or upper case. */
  country?: string
  language?: string
}

/**
 * Build the suggester.
 * @param fetcher - HTTP, injectable for tests.
 * @returns a function answering one query's suggestions.
 */
export function suggester(fetcher: typeof fetch = fetch): (request: SuggestRequest, signal: AbortSignal) => Promise<string[]> {
  return async (request: SuggestRequest, signal: AbortSignal): Promise<string[]> => {
    const url = new URL('https://suggestqueries.google.com/complete/search')
    url.search = new URLSearchParams({
      client: 'firefox',
      q: request.query,
      hl: request.language === undefined || request.language === '' ? 'en' : request.language,
      ...request.source === 'youtube' ? { ds: 'yt' } : {},
      ...request.country === undefined || request.country === '' ? {} : { gl: request.country.toLowerCase() },
    }).toString()
    const response = await fetcher(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) })
    if (!response.ok) throw new Error(`autocomplete answered HTTP ${String(response.status)}`)
    return parseSuggestions(await response.text())
  }
}

/**
 * Run tasks with at most `limit` at once.
 * @param inputs - the inputs.
 * @param limit - how many run together.
 * @param run - the task.
 * @returns the results in input order; a failed task gives its error.
 */
export async function pooled<I, O>(inputs: readonly I[], limit: number, run: (input: I) => Promise<O>): Promise<(O | Error)[]> {
  const out: (O | Error)[] = Array.from({ length: inputs.length })
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < inputs.length) {
      const index = next++
      try {
        out[index] = await run(inputs[index] as I)
      } catch (error) {
        out[index] = error instanceof Error ? error : new Error(String(error))
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, inputs.length) }, worker))
  return out
}
