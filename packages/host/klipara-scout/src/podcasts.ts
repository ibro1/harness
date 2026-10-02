/**
 * Podcast discovery. Most podcast RSS feeds publish the owner's contact email
 * (`<itunes:owner><itunes:email>`), which YouTube channels usually hide, so a
 * podcast found here is pitched by email rather than by comment. Shows come
 * from Apple's public podcast search (no key); each show's feed is read for
 * the address and its latest episode. The sample is still cut from the show's
 * video on YouTube: a feed has no video, and Klipara clips need one.
 */

/** One show from the podcast directory. */
export interface Podcast {
  title: string
  author: string
  feedUrl: string
  directoryUrl: string
  episodeCount: number
  /** ISO date of the newest episode, when the directory gives one. */
  lastRelease?: string
}

/** What a show's feed says about reaching it. */
export interface FeedFacts {
  email?: string
  ownerName?: string
  latestEpisodeTitle?: string
  /** YouTube channel ids the feed links to, if any. */
  youtubeChannelIds: string[]
}

/** Largest feed read; big shows publish multi-megabyte feeds, and only the channel header and first item are needed. */
const MAX_FEED_BYTES = 3 * 1024 * 1024
const EMAIL = /^[^@\s<>"]+@[^@\s<>"]+\.[A-Za-z]{2,}$/u

/** Local parts that are placeholders or a feed's own address, not a person. */
const PLACEHOLDER = /^(?:no-?reply|donotreply|example|test|your|name|email|user|feeds?|podcasts?-?feeds?)@/iu

/** Domains of page furniture: error trackers, site builders, template text. */
const FURNITURE = /@(?:example\.|sentry|wixpress\.com|domain\.com|email\.com|godaddy\.com)/iu

/** Image and asset names that look like addresses (`logo@2x.png`). */
const FILE_NAME = /\.(?:png|jpe?g|gif|webp|svg|avif|ico|css|js)$/iu

/** Podcast hosts and platforms: their address in a feed reaches the host, not the creator. */
const PLATFORMS = [
  'spreaker.com', 'soundcloud.com', 'anchor.fm', 'libsyn.com', 'buzzsprout.com', 'podbean.com', 'megaphone.fm', 'simplecast.com',
  'transistor.fm', 'acast.com', 'captivate.fm', 'redcircle.com', 'rss.com', 'audioboom.com', 'omnystudio.com', 'iheart.com', 'spotify.com', 'apple.com',
]

/**
 * Whether an address can reach the creator: not a placeholder, not a hosting platform's feed address
 * (`feeds@spreaker.com`), not an image name that looks like one (`logo@2x.png`).
 * @param address - a lower-case address.
 * @returns true when it is worth pitching.
 */
export function creatorEmail(address: string): boolean {
  const domain = address.slice(address.lastIndexOf('@') + 1)
  return !PLACEHOLDER.test(address) && !FURNITURE.test(address) && !FILE_NAME.test(address)
    && !PLATFORMS.some(platform => domain === platform || domain.endsWith(`.${platform}`))
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * Search Apple's podcast directory.
 * @param fetcher - HTTP.
 * @param term - search words.
 * @param country - two-letter store country, for example `ng`.
 * @param limit - shows to return, 1 to 50.
 * @param signal - cancels the call.
 * @returns the shows that have a feed.
 */
export async function searchPodcasts(
  fetcher: typeof fetch, term: string, country: string, limit: number, signal: AbortSignal,
): Promise<Podcast[]> {
  const url = new URL('https://itunes.apple.com/search')
  url.search = new URLSearchParams({ media: 'podcast', entity: 'podcast', term, country, limit: String(limit) }).toString()
  const response = await fetcher(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) })
  if (!response.ok) throw new Error(`The podcast directory answered HTTP ${String(response.status)} for "${term}".`)
  const body = record(await response.json())
  const results = Array.isArray(body['results']) ? body['results'] : []
  return results.map(record).flatMap((row) => {
    const feedUrl = text(row['feedUrl'])
    if (feedUrl === '') return []
    const release = text(row['releaseDate'])
    return [{
      title: text(row['collectionName']) || text(row['trackName']),
      author: text(row['artistName']),
      feedUrl,
      directoryUrl: text(row['collectionViewUrl']),
      episodeCount: typeof row['trackCount'] === 'number' ? row['trackCount'] : 0,
      ...release === '' ? {} : { lastRelease: release },
    }]
  })
}

/** Decode the XML entities feeds use in text. */
function decode(value: string): string {
  return value
    .replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/u, '$1')
    .replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&quot;/gu, '"').replace(/&apos;|&#39;/gu, '\'')
    .replace(/&#(\d+);/gu, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/gu, '&')
    .trim()
}

function first(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'iu').exec(xml)
  return match?.[1] === undefined ? undefined : decode(match[1])
}

/**
 * Read the start of a show's feed: the owner's address and name, the newest
 * episode's title, and any YouTube channels it links to.
 * @param fetcher - HTTP.
 * @param feedUrl - the RSS feed.
 * @param signal - cancels the read.
 * @returns what the feed says.
 */
export async function readFeed(fetcher: typeof fetch, feedUrl: string, signal: AbortSignal): Promise<FeedFacts> {
  const response = await fetcher(feedUrl, { signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]), headers: { Accept: 'application/rss+xml, application/xml, text/xml' } })
  if (!response.ok || response.body === null) throw new Error(`The feed answered HTTP ${String(response.status)}.`)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let xml = ''
  // Stop at the second <item>: the header and the newest episode are all that is read.
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    xml += decoder.decode(value, { stream: true })
    if (xml.length > MAX_FEED_BYTES || (xml.match(/<item[\s>]/giu)?.length ?? 0) >= 2) {
      await reader.cancel()
      break
    }
  }
  const header = xml.split(/<item[\s>]/iu)[0] ?? xml
  const owner = first(header, 'itunes:owner') ?? ''
  const candidates = [first(owner, 'itunes:email'), first(header, 'itunes:email'), first(header, 'managingEditor')?.split(/[\s(]/u)[0]]
  const email = candidates.find((value): value is string => value !== undefined && EMAIL.test(value) && creatorEmail(value.toLowerCase()))
  const ownerName = first(owner, 'itunes:name') ?? first(header, 'itunes:author')
  const item = xml.split(/<item[\s>]/iu)[1]
  const latestEpisodeTitle = item === undefined ? undefined : first(item, 'title')
  const youtubeChannelIds = [...new Set([...xml.matchAll(/youtube\.com\/channel\/(UC[\w-]{22})/giu)].map(m => m[1] ?? ''))].filter(Boolean)
  return {
    ...email === undefined ? {} : { email: email.toLowerCase() },
    ...ownerName === undefined || ownerName === '' ? {} : { ownerName },
    ...latestEpisodeTitle === undefined || latestEpisodeTitle === '' ? {} : { latestEpisodeTitle },
    youtubeChannelIds,
  }
}

/** Words of a name, for matching a show to a channel. */
function nameWords(value: string): Set<string> {
  return new Set(value.toLowerCase().replace(/\bpodcast\b|\bshow\b|\bthe\b|\bofficial\b|\btv\b/gu, ' ').split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 1))
}

/**
 * Whether a YouTube channel is this show's, by name: most of the show's
 * distinctive words appear in the channel's name, or the other way round.
 * @param podcast - the show.
 * @param channelName - the channel.
 * @returns true when the names match.
 */
export function sameShow(podcast: Pick<Podcast, 'title' | 'author'>, channelName: string): boolean {
  const channel = nameWords(channelName)
  if (channel.size === 0) return false
  return [podcast.title, podcast.author].some((name) => {
    const show = nameWords(name)
    if (show.size === 0) return false
    const shared = [...show].filter(w => channel.has(w)).length
    return shared / Math.min(show.size, channel.size) >= 0.6
  })
}
