/**
 * UK TikTok Shop product data through SocialCrawl
 * (https://www.socialcrawl.dev/docs/tiktokshop): keyword search and product
 * details, one credit per request. TikTok's own pages answer automated
 * readers with a security check, so a data service is the reliable route.
 *
 * SocialCrawl documents its fields by meaning, not by exact name, so the
 * parser reads each field under the names such services use (`sold_count`,
 * `soldCount`, `sold`) and keeps a product only when it has an id, a title and
 * a price. The raw answer of the last call is kept for diagnosis.
 */

/** A product as the employee keeps it. */
export interface ShopProduct {
  id: string
  title: string
  /** In the listing's currency, as a number. */
  price: number
  currency: string
  /** Lifetime units sold, when the listing shows it. */
  sold?: number
  rating?: number
  reviews?: number
  seller?: string
  /** Product image URLs, primary first. */
  images: string[]
  /** The product page. */
  url?: string
  /** Category path, when given. */
  category?: string
  description?: string
}

/** SocialCrawl's base address. */
const BASE = 'https://www.socialcrawl.dev'

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function pick(row: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    const value = name.split('.').reduce<unknown>((at, key) => record(at)[key], row)
    if (value !== undefined && value !== null && value !== '') return value
  }
  return undefined
}

function number(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    // "1.2K sold", "£12.99", "10,000+"
    const match = /([\d.,]+)\s*([kKmM])?/u.exec(value.replace(/,/gu, ''))
    if (match?.[1] === undefined) return undefined
    const base = Number.parseFloat(match[1])
    if (!Number.isFinite(base)) return undefined
    const scale = match[2] === undefined ? 1 : /k/iu.test(match[2]) ? 1_000 : 1_000_000
    return base * scale
  }
  if (typeof value !== 'object' || value === null) return undefined
  const nested = record(value)
  const inner = nested['amount'] ?? nested['value'] ?? nested['sale_price'] ?? nested['min']
  return typeof inner === 'object' ? undefined : number(inner)
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : typeof value === 'number' ? String(value) : undefined
}

function images(row: Record<string, unknown>): string[] {
  const out: string[] = []
  const add = (value: unknown): void => {
    if (typeof value === 'string' && /^https?:\/\//u.test(value)) out.push(value)
    else if (Array.isArray(value)) value.forEach(add)
    else if (typeof value === 'object' && value !== null) {
      const nested = record(value)
      add(nested['url'] ?? nested['url_list'] ?? nested['src'] ?? nested['thumb_url_list'])
    }
  }
  for (const name of ['images', 'image_urls', 'imageUrls', 'image', 'image_url', 'imageUrl', 'cover', 'cover_url', 'thumbnail', 'main_image']) add(row[name])
  return [...new Set(out)]
}

/**
 * Read one product from a SocialCrawl row.
 * @param raw - a search result or the product of a details answer.
 * @param fallbackCurrency - the region's currency when the row names none.
 * @returns the product, or undefined when it lacks an id, title or price.
 */
export function parseProduct(raw: unknown, fallbackCurrency = 'GBP'): ShopProduct | undefined {
  const row = record(raw)
  const id = text(pick(row, 'id', 'product_id', 'productId', 'item_id'))
  const title = text(pick(row, 'title', 'name', 'product_name', 'productName'))
  const price = number(pick(row, 'price', 'sale_price', 'salePrice', 'price.amount', 'min_price'))
  if (id === undefined || title === undefined || price === undefined) return undefined
  const sold = number(pick(row, 'sold_count', 'soldCount', 'sold', 'sales', 'sold_count_text'))
  const rating = number(pick(row, 'rating', 'rating_average', 'ratingAverage', 'star'))
  const reviews = number(pick(row, 'review_count', 'reviewCount', 'reviews'))
  const seller = text(pick(row, 'seller.name', 'seller', 'shop_name', 'shop.name', 'shopName'))
  const url = text(pick(row, 'url', 'product_url', 'productUrl', 'link', 'deep_link'))
  const category = pick(row, 'category', 'category_path', 'categories', 'breadcrumb')
  const description = text(pick(row, 'description', 'desc'))
  return {
    id, title, price,
    currency: text(pick(row, 'currency', 'price.currency')) ?? fallbackCurrency,
    images: images(row),
    ...sold === undefined ? {} : { sold },
    ...rating === undefined ? {} : { rating },
    ...reviews === undefined ? {} : { reviews },
    ...seller === undefined ? {} : { seller },
    ...url === undefined ? {} : { url },
    ...Array.isArray(category) ? { category: category.map(c => text(record(c)['name']) ?? text(c) ?? '').filter(c => c !== '').join(' > ') } : text(category) === undefined ? {} : { category: text(category) ?? '' },
    ...description === undefined ? {} : { description: description.slice(0, 2000) },
  }
}

/** The client. */
export interface SocialCrawl {
  /**
   * Search UK products.
   * @param query - keywords.
   * @param signal - cancels the call.
   * @returns the products found, in the service's order.
   */
  search(query: string, signal: AbortSignal): Promise<ShopProduct[]>
  /**
   * One product's details.
   * @param ref - the product id, or its TikTok Shop URL.
   * @param signal - cancels the call.
   * @returns the product, or undefined when the service has none.
   */
  product(ref: string, signal: AbortSignal): Promise<ShopProduct | undefined>
}

/**
 * Create the client.
 * @param apiKey - read per call, so a key saved on the settings page applies at once.
 * @param region - two-letter market, `GB` for the United Kingdom.
 * @param fetcher - HTTP.
 * @returns the client.
 */
export function socialCrawl(apiKey: () => string, region: () => string, fetcher: typeof fetch = fetch): SocialCrawl {
  const call = async (path: string, params: Record<string, string>, signal: AbortSignal): Promise<Record<string, unknown>> => {
    const key = apiKey().trim()
    if (key === '') throw new Error('No SocialCrawl API key is saved: add one on Plugins → TikTok Shop employee (100 free credits at socialcrawl.dev).')
    const url = new URL(path, BASE)
    url.search = new URLSearchParams({ ...params, region: region().trim().toUpperCase() || 'GB' }).toString()
    const response = await fetcher(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(45_000)]), headers: { 'x-api-key': key, 'Accept': 'application/json' } })
    const body = record(await response.json().catch(() => ({})))
    if (!response.ok) throw new Error(`SocialCrawl answered HTTP ${String(response.status)}: ${text(pick(body, 'error.message', 'message', 'error')) ?? 'no detail'}`)
    return body
  }
  const list = (body: Record<string, unknown>): unknown[] => {
    for (const name of ['data', 'results', 'products', 'items']) {
      const value = body[name]
      if (Array.isArray(value)) return value
      const nested = record(value)
      for (const inner of ['products', 'items', 'results']) if (Array.isArray(nested[inner])) return nested[inner] as unknown[]
    }
    return []
  }
  return {
    async search(query, signal) {
      const body = await call('/v1/tiktokshop/search', { query }, signal)
      return list(body).map(row => parseProduct(row)).filter((p): p is ShopProduct => p !== undefined)
    },
    async product(ref, signal) {
      const body = await call('/v1/tiktokshop/product', /^\d+$/u.test(ref) ? { product_id: ref } : { url: ref }, signal)
      return parseProduct(body['product'] ?? record(body['data'])['product'] ?? body['data'] ?? body)
    },
  }
}
