/**
 * The TikTok Shop employee's tools. The model picks products and writes
 * scripts; the plugin owns everything that must hold whatever the model does:
 * which products may be promoted, what a script may claim, the daily cap,
 * the pause switch, and the render itself.
 */

import { randomBytes } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ParameterSchemaSpec, ToolDefinition, ToolRunContext, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { ScriptLine } from './render.ts'
import { blockedWord, finalCaption, scriptProblems } from './rules.ts'
import type { SourcedAnswer } from './direct.ts'
import type { ShopProduct } from './socialcrawl.ts'
import type { ShopState, ShopStore, TrackedProduct, VideoRecord } from './store.ts'

/** What the tools read and call. */
export interface ShopDeps {
  store: ShopStore
  /** Product data: TikTok directly through the proxy when one is set, SocialCrawl otherwise or when that fails. */
  data: {
    search: (query: string, signal: AbortSignal) => Promise<SourcedAnswer<ShopProduct[]>>
    product: (ref: string, signal: AbortSignal) => Promise<SourcedAnswer<ShopProduct | undefined>>
  }
  /** Words that keep a product out. */
  blockedWords: () => string[]
  videosPerDay: () => number
  /** Local date, `YYYY-MM-DD`, in the owner's time zone. */
  today: () => string
  now: () => Date
  /** Start rendering a reserved video in the background; it reports to the owner when done. */
  startRender: (videoId: string) => void
  /** Tell the owner something on WhatsApp; never throws. */
  notify: (text: string) => Promise<string>
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { text: { type: 'string', required: true, description: 'What happened.' } },
} as const satisfies ValueSchemaSpec

/** Most spoken lines in one video: about 15–40 seconds at TikTok's pace. */
const MAX_LINES = 6
/** Fewest and most spoken words in one video. */
const MIN_WORDS = 20
const MAX_WORDS = 95
/** Most words in the hook headline. */
const MAX_HOOK_WORDS = 9
/** Most words in an on-screen caption. */
const MAX_CAPTION_WORDS = 7

/** The listing price as written in a script. */
export function priceText(product: Pick<TrackedProduct, 'price' | 'currency'>): string {
  const symbol = product.currency === 'GBP' ? '£' : product.currency === 'USD' ? '$' : product.currency === 'EUR' ? '€' : `${product.currency} `
  return `${symbol}${product.price.toFixed(2)}`
}

function words(text: string): number {
  return text.trim() === '' ? 0 : text.trim().split(/\s+/u).length
}

function describe(p: TrackedProduct, state: ShopState): string {
  const made = state.videos.filter(v => v.productId === p.id && v.status !== 'failed').length
  const facts = [
    priceText(p),
    p.sold === undefined ? undefined : `${String(Math.round(p.sold))} sold`,
    p.rating === undefined ? undefined : `${p.rating.toFixed(1)}★${p.reviews === undefined ? '' : ` (${String(Math.round(p.reviews))})`}`,
    `${String(p.images.length)} image${p.images.length === 1 ? '' : 's'}`,
    p.video === undefined ? undefined : 'demo video',
    made === 0 ? undefined : `${String(made)} video${made === 1 ? '' : 's'} made`,
    p.rejected === undefined ? undefined : `REJECTED: ${p.rejected.why}`,
  ].filter(v => v !== undefined).join(', ')
  return `- ${p.id}: ${p.title} (${facts})`
}

/**
 * Build the tools.
 * @param deps - store, data client, caps and the render starter.
 * @returns the tool definitions.
 */
export function buildShopTools(deps: ShopDeps): ToolDefinition[] {
  const { store } = deps
  const iso = (): string => deps.now().toISOString()
  const tool = (spec: {
    name: string
    description: string
    parameters: ParameterSchemaSpec
    run: (args: Record<string, unknown>, exec: ToolRunContext) => Promise<string>
  }): ToolDefinition => defineTool({
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: { schema: OUTPUT_SCHEMA, render: (_args, value) => [{ type: 'text', text: value.text }] },
    execute: async (args, exec) => ({ text: await spec.run(args as Record<string, unknown>, exec) }),
    presentCall: () => ({ card: 'generic', title: spec.name.replace(/_/gu, ' '), kind: 'other', rawInput: '' }),
  })
  const findProduct = (state: ShopState, id: string): TrackedProduct => {
    const product = state.products.find(p => p.id === id)
    if (product === undefined) throw new Error(`No product ${id}; tts_search finds products and tts_products lists them.`)
    return product
  }

  return [
    tool({
      name: 'tts_status',
      description: 'Today\'s video cap and what is left, whether the employee is paused, videos waiting for the owner, and how posted videos did by format and hook. Call it first in a shift.',
      parameters: {},
      run: async () => {
        const state = await store.read()
        const made = state.days[deps.today()]?.videos ?? 0
        const waiting = state.videos.filter(v => v.status === 'ready')
        const posted = state.videos.filter(v => v.status === 'posted')
        const byFormat = new Map<string, { n: number; views: number; sales: number }>()
        for (const v of posted) {
          const row = byFormat.get(v.format) ?? { n: 0, views: 0, sales: 0 }
          row.n++
          row.views += v.results?.views ?? 0
          row.sales += v.results?.sales ?? 0
          byFormat.set(v.format, row)
        }
        const best = posted
          .filter(v => v.results?.views !== undefined)
          .sort((a, b) => (b.results?.views ?? 0) - (a.results?.views ?? 0))
          .slice(0, 3)
        return [
          `Today (${deps.today()}): ${String(made)}/${String(deps.videosPerDay())} videos made.`,
          state.paused === null ? 'Running.' : `PAUSED since ${state.paused.at}: ${state.paused.reason}. Stop the shift.`,
          `Products tracked: ${String(state.products.length)}. Videos waiting for the owner to post: ${String(waiting.length)}. Posted: ${String(posted.length)}. Skipped by the owner: ${String(state.videos.filter(v => v.status === 'skipped').length)}.`,
          ...byFormat.size === 0 ? ['No results reported yet.'] : [`By format: ${[...byFormat].map(([f, r]) => `${f} ${String(r.n)} posted, ${String(r.views)} views, ${String(r.sales)} sales`).join('; ')}.`],
          ...best.length === 0 ? [] : [`Best hooks so far: ${best.map(v => `"${v.hook}" (${String(v.results?.views ?? 0)} views, ${String(v.results?.sales ?? 0)} sales)`).join('; ')}.`],
        ].join('\n')
      },
    }),
    tool({
      name: 'tts_search',
      description: 'Search UK TikTok Shop for products on a theme (one data credit). Saves new products that are allowed (not on the owner\'s blocked list) and lists them with price, units sold, rating and image count. Prefer products with many units sold, a good rating, a price under about £30, at least two images, and a demo video (real footage makes the video far stronger).',
      parameters: { query: { type: 'string', required: true, description: 'Product search words, such as "lip balm" or "car phone holder".' } },
      run: async (args, exec) => {
        const query = String(args['query']).trim()
        if (query === '') throw new Error('Give search words.')
        const answer = await deps.data.search(query, exec.signal)
        const found = answer.value
        const blocked: string[] = []
        const allowed = found.filter((p) => {
          const word = blockedWord(p, deps.blockedWords())
          if (word !== undefined) blocked.push(`${p.title} (${word})`)
          return word === undefined
        })
        const state = await store.update((s) => {
          for (const p of allowed) {
            const known = s.products.find(x => x.id === p.id)
            if (known === undefined) s.products.push({ ...p, foundAt: iso(), query })
            else Object.assign(known, { ...p, images: known.images.length > p.images.length ? known.images : p.images })
          }
          return s
        })
        const listed = allowed.map(p => findProduct(state, p.id)).sort((a, b) => (b.sold ?? 0) - (a.sold ?? 0))
        return [
          `"${query}": ${String(found.length)} products, ${String(allowed.length)} allowed (from ${answer.source}${answer.directFailed === undefined ? '' : `; the direct read failed: ${answer.directFailed}`}).`,
          ...listed.map(p => describe(p, state)),
          ...blocked.length === 0 ? [] : [`Left out by the owner's blocked words: ${blocked.join('; ')}.`],
        ].join('\n')
      },
    }),
    tool({
      name: 'tts_product',
      description: 'Read one product\'s full listing (one data credit): description and all its images. Read it before writing a script: every claim in the script must come from this listing.',
      parameters: { product_id: { type: 'string', required: true, description: 'The product id from tts_search.' } },
      run: async (args, exec) => {
        const id = String(args['product_id'])
        const before = findProduct(await store.read(), id)
        let details: ShopProduct | undefined
        let unavailable: string | undefined
        try {
          details = (await deps.data.product(before.url ?? id, exec.signal)).value
        } catch (error) {
          // SocialCrawl's product endpoint does not serve GB at the moment (503); the search result still holds the facts.
          if (exec.signal.aborted) throw error
          unavailable = error instanceof Error ? error.message : String(error)
        }
        const product = await store.update((s) => {
          const p = findProduct(s, id)
          if (details !== undefined) {
            Object.assign(p, { ...details, id: p.id, images: details.images.length > 0 ? details.images : p.images })
          }
          return { ...p }
        })
        return [
          `${product.title}: ${priceText(product)}${product.seller === undefined ? '' : `, sold by ${product.seller}`}${product.category === undefined ? '' : `, in ${product.category}`}.`,
          `Images: ${String(product.images.length)}.`,
          details === undefined
            ? `The full listing could not be read${unavailable === undefined ? '' : ` (${unavailable})`}. Work from the search result above only: its title, price, rating and images. Make no claim it does not support.`
            : `Listing: ${product.description ?? '(no description)'}`,
        ].join('\n')
      },
    }),
    tool({
      name: 'tts_products',
      description: 'List the products found so far, best sellers first.',
      parameters: {},
      run: async () => {
        const state = await store.read()
        if (state.products.length === 0) return 'No products yet; use tts_search.'
        return [...state.products].sort((a, b) => (b.sold ?? 0) - (a.sold ?? 0)).slice(0, 60).map(p => describe(p, state)).join('\n')
      },
    }),
    tool({
      name: 'tts_make_video',
      description: 'Write one video for a product and start rendering it: the product\'s own images, a voiceover of your lines, each line\'s caption on screen, the hook as a headline, and the price at the end. Refused when paused, over today\'s cap, for a rejected or blocked product, for a product without images, or for a script that claims anyone used the product ("I\'ve been using", "my skin"), makes a health or guaranteed-result claim, names a price other than the listing\'s, or breaks the length limits. When the render finishes the owner gets a review link on WhatsApp.',
      parameters: {
        product_id: { type: 'string', required: true, description: 'The product.' },
        format: { type: 'string', required: true, enum: ['showcase', 'problem-fix', 'comparison', 'reasons', 'gift-idea'], description: 'The video\'s format.' },
        hook: { type: 'string', required: true, description: `Headline over the first second: at most ${String(MAX_HOOK_WORDS)} words, stops the scroll.` },
        lines: {
          type: 'array',
          required: true,
          description: `2 to ${String(MAX_LINES)} spoken lines, ${String(MIN_WORDS)}–${String(MAX_WORDS)} words in all. The first line is the spoken hook; the last tells viewers to tap the orange basket.`,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              voice: { type: 'string', required: true, description: 'What the voice says.' },
              caption: { type: 'string', required: true, description: `What the screen says during it: at most ${String(MAX_CAPTION_WORDS)} words.` },
            },
          },
        },
        caption: { type: 'string', required: true, description: 'The post caption: one or two short sentences. #ad is added in front by the plugin.' },
        hashtags: { type: 'array', items: { type: 'string' }, description: 'Up to 5 hashtags without #, such as tiktokmademebuyit.' },
      },
      run: async (args) => {
        const id = String(args['product_id'])
        const format = String(args['format'])
        const hook = String(args['hook']).trim()
        const rawLines = Array.isArray(args['lines']) ? args['lines'] as Record<string, unknown>[] : []
        const textOf = (value: unknown): string => typeof value === 'string' ? value.trim() : ''
        const lines: ScriptLine[] = rawLines.map(l => ({ voice: textOf(l['voice']), caption: textOf(l['caption']) }))
        const hashtags = Array.isArray(args['hashtags']) ? args['hashtags'].map(String) : []
        const videoId = randomBytes(9).toString('base64url')
        const reserved = await store.update((s) => {
          if (s.paused !== null) throw new Error(`Paused (${s.paused.reason}). Stop the shift.`)
          const product = findProduct(s, id)
          if (product.rejected !== undefined) throw new Error(`${product.title} was rejected: ${product.rejected.why}.`)
          const blocked = blockedWord(product, deps.blockedWords())
          if (blocked !== undefined) throw new Error(`${product.title} matches the owner's blocked word "${blocked}"; pick another product.`)
          if (product.images.length === 0) throw new Error(`${product.title} has no images; call tts_product, or pick a product with images.`)
          const price = priceText(product)
          const problems: string[] = []
          if (words(hook) === 0 || words(hook) > MAX_HOOK_WORDS) problems.push(`the hook must be 1–${String(MAX_HOOK_WORDS)} words`)
          if (lines.length < 2 || lines.length > MAX_LINES) problems.push(`give 2–${String(MAX_LINES)} lines`)
          const spoken = lines.reduce((n, l) => n + words(l.voice), 0)
          if (spoken < MIN_WORDS || spoken > MAX_WORDS) problems.push(`the voiceover has ${String(spoken)} words; keep it to ${String(MIN_WORDS)}–${String(MAX_WORDS)}`)
          lines.forEach((l, i) => {
            if (l.voice === '') problems.push(`line ${String(i + 1)} has no voice text`)
            if (words(l.caption) === 0 || words(l.caption) > MAX_CAPTION_WORDS) problems.push(`line ${String(i + 1)}'s caption must be 1–${String(MAX_CAPTION_WORDS)} words`)
          })
          const texts = [hook, ...lines.flatMap(l => [l.voice, l.caption]), String(args['caption'])]
          for (const p of scriptProblems(texts, price)) problems.push(`"${p.text}" ${p.why.replace(/\.$/u, '')}`)
          if (problems.length > 0) throw new Error(`Not rendered. Fix: ${problems.join('; ')}.`)
          const day = (s.days[deps.today()] ??= { videos: 0 })
          if (day.videos >= deps.videosPerDay()) throw new Error(`Today's cap of ${String(deps.videosPerDay())} videos is reached. End the shift.`)
          day.videos++
          const video: VideoRecord = {
            id: videoId, productId: id, format, hook, lines,
            endCard: `${price} · tap the orange basket`,
            caption: finalCaption(String(args['caption']), hashtags),
            status: 'rendering', createdAt: iso(),
          }
          s.videos.push(video)
          return { video, product: product.title, made: day.videos }
        })
        deps.startRender(reserved.video.id)
        return `Video ${reserved.video.id} for ${reserved.product} is rendering (${String(reserved.made)}/${String(deps.videosPerDay())} today). The owner gets a review link when it is done; you need not wait.`
      },
    }),
    tool({
      name: 'tts_videos',
      description: 'List videos with their status (rendering, failed, ready for the owner, posted with results, skipped).',
      parameters: { status: { type: 'string', enum: ['rendering', 'failed', 'ready', 'posted', 'skipped'], description: 'Only this status.' } },
      run: async (args) => {
        const state = await store.read()
        const rows = state.videos.filter(v => args['status'] === undefined || v.status === args['status']).slice(-40).reverse()
        if (rows.length === 0) return 'No videos.'
        return rows.map((v) => {
          const product = state.products.find(p => p.id === v.productId)?.title ?? v.productId
          const results = v.results === undefined ? '' : `, ${String(v.results.views ?? '?')} views, ${String(v.results.sales ?? '?')} sales`
          return `- ${v.id} [${v.status}] ${product} · ${v.format} · "${v.hook}"${v.error === undefined ? '' : ` · error: ${v.error}`}${results}`
        }).join('\n')
      },
    }),
    tool({
      name: 'tts_reject_product',
      description: 'Rule a product out for good, with the reason (poor reviews, misleading listing, nothing true to say about it).',
      parameters: {
        product_id: { type: 'string', required: true, description: 'The product.' },
        why: { type: 'string', required: true, description: 'Why.' },
      },
      run: async (args) => {
        const title = await store.update((s) => {
          const p = findProduct(s, String(args['product_id']))
          p.rejected = { why: String(args['why']), at: iso() }
          return p.title
        })
        return `${title} is rejected.`
      },
    }),
    tool({
      name: 'tts_pause',
      description: 'Stop the employee and alert the owner: call it when the data service or the voice keeps failing, or anything looks wrong. Only the owner resumes it.',
      parameters: { reason: { type: 'string', required: true, description: 'What happened.' } },
      run: async (args) => {
        const reason = String(args['reason']).trim() || 'no reason given'
        await store.update((s) => { s.paused = { reason, at: iso() } })
        const sent = await deps.notify(`TikTok Shop employee PAUSED: ${reason}\n\nResume it on Plugins → TikTok Shop employee.`)
        return `Paused. Owner alert: ${sent}. End the shift.`
      },
    }),
  ]
}
