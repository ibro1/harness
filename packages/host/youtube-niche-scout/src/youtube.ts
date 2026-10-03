/**
 * The YouTube Data API v3 calls the scout makes, with an API key: recent
 * videos for a topic (`search.list`, 100 quota units), their statistics and
 * lengths (`videos.list`, 1 unit), their channels (`channels.list`, 1 unit)
 * and a channel's latest uploads (`playlistItems.list`, 1 unit). Every call
 * is charged to the quota budget before it is made, so a run cannot spend
 * what the key's day does not have.
 */

/** Units each method costs, from Google's quota calculator. */
export const QUOTA_COST = { search: 100, videos: 1, channels: 1, playlistItems: 1 } as const

/** A video as the scout reads it. */
export interface VideoInfo {
  id: string
  title: string
  channelId: string
  channelTitle: string
  publishedAt: string
  /** Length in seconds; 0 when YouTube gave none (live, premiere). */
  seconds: number
  views: number
  likes?: number
  comments?: number
}

/** A channel as the scout reads it. */
export interface ChannelInfo {
  id: string
  title: string
  /** `@handle`, when the channel has one. */
  handle?: string
  /** When the channel was created. */
  createdAt: string
  country?: string
  /** Undefined when the channel hides its count. */
  subscribers?: number
  videos: number
  views: number
  /** The uploads playlist, for the channel's latest videos. */
  uploads?: string
}

/** What `search.list` answered for one topic. */
export interface SearchPage {
  videoIds: string[]
  /** YouTube's rough count of matches; a crowding signal, never exact. */
  totalResults: number
}

/** The options of one topic search. */
export interface SearchOptions {
  query: string
  /** `medium` is 4–20 minutes, `long` over 20. */
  duration: 'medium' | 'long'
  publishedAfter: string
  regionCode?: string
  relevanceLanguage?: string
  order?: 'viewCount' | 'relevance' | 'date'
  maxResults?: number
}

/** The key's day has no room for a call. */
export class QuotaExhausted extends Error {
  /** @param message - what the budget refused and why. */
  constructor(message: string) {
    super(message)
    this.name = 'QuotaExhausted'
  }
}

/** YouTube refused a call. */
export class YouTubeError extends Error {
  /**
   * @param message - YouTube's own words.
   * @param status - the HTTP status.
   * @param reason - `quotaExceeded`, `keyInvalid` and the like, when YouTube gave one.
   */
  constructor(message: string, readonly status: number, readonly reason: string) {
    super(message)
    this.name = 'YouTubeError'
  }
}

/** The client's injectable parts. */
export interface YouTubeDeps {
  /** The API key; empty refuses every call. */
  key: () => string
  /** Reserve units before a call; throws `QuotaExhausted` when the budget has no room. */
  charge: (units: number, method: keyof typeof QUOTA_COST) => Promise<void>
  fetch?: typeof fetch
  /** API root, for tests. */
  base?: string
}

/**
 * Read an ISO 8601 duration such as `PT12M3S` or `P1DT2H`.
 * @param value - the duration.
 * @returns the seconds, 0 for anything unreadable.
 */
export function parseDuration(value: string): number {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/u.exec(value)
  if (match === null) return 0
  const [, d = '0', h = '0', m = '0', s = '0'] = match
  return Number(d) * 86_400 + Number(h) * 3600 + Number(m) * 60 + Number(s)
}

function num(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : Number.NaN
  return Number.isFinite(n) ? n : undefined
}

function obj(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function items(body: unknown): Record<string, unknown>[] {
  const list = obj(body)['items']
  return Array.isArray(list) ? list.map(obj) : []
}

/**
 * Read one `videos.list` item.
 * @param item - the item.
 * @returns the video, or undefined without an id.
 */
export function parseVideo(item: Record<string, unknown>): VideoInfo | undefined {
  const id = str(item['id'])
  if (id === '') return undefined
  const snippet = obj(item['snippet'])
  const stats = obj(item['statistics'])
  const likes = num(stats['likeCount'])
  const comments = num(stats['commentCount'])
  return {
    id,
    title: str(snippet['title']),
    channelId: str(snippet['channelId']),
    channelTitle: str(snippet['channelTitle']),
    publishedAt: str(snippet['publishedAt']),
    seconds: parseDuration(str(obj(item['contentDetails'])['duration'])),
    views: num(stats['viewCount']) ?? 0,
    ...likes === undefined ? {} : { likes },
    ...comments === undefined ? {} : { comments },
  }
}

/**
 * Read one `channels.list` item.
 * @param item - the item.
 * @returns the channel, or undefined without an id.
 */
export function parseChannel(item: Record<string, unknown>): ChannelInfo | undefined {
  const id = str(item['id'])
  if (id === '') return undefined
  const snippet = obj(item['snippet'])
  const stats = obj(item['statistics'])
  const hidden = stats['hiddenSubscriberCount'] === true
  const subscribers = hidden ? undefined : num(stats['subscriberCount'])
  const handle = str(snippet['customUrl'])
  const country = str(snippet['country'])
  const uploads = str(obj(obj(item['contentDetails'])['relatedPlaylists'])['uploads'])
  return {
    id,
    title: str(snippet['title']),
    ...handle === '' ? {} : { handle },
    createdAt: str(snippet['publishedAt']),
    ...country === '' ? {} : { country },
    ...subscribers === undefined ? {} : { subscribers },
    videos: num(stats['videoCount']) ?? 0,
    views: num(stats['viewCount']) ?? 0,
    ...uploads === '' ? {} : { uploads },
  }
}

/** The four calls the scout makes; each charges the quota budget first. */
export interface YouTube {
  /** Most-viewed (by default) videos on a topic: their ids and YouTube's rough match count. */
  search: (options: SearchOptions, signal: AbortSignal) => Promise<SearchPage>
  /** Up to 50 videos by id. */
  videos: (ids: string[], signal: AbortSignal) => Promise<VideoInfo[]>
  /** Up to 50 channels by id, or one by `@handle`. */
  channels: (ref: { ids: string[] } | { handle: string }, signal: AbortSignal) => Promise<ChannelInfo[]>
  /** The latest up to 50 video ids of an uploads playlist. */
  uploads: (playlistId: string, signal: AbortSignal) => Promise<string[]>
}

/**
 * Build the client.
 * @param deps - key, quota budget and HTTP.
 * @returns the four calls.
 */
export function youTube(deps: YouTubeDeps): YouTube {
  const fetcher = deps.fetch ?? fetch
  const base = deps.base ?? 'https://www.googleapis.com/youtube/v3'
  const call = async (method: keyof typeof QUOTA_COST, params: Record<string, string>, signal: AbortSignal): Promise<unknown> => {
    const key = deps.key().trim()
    if (key === '') throw new YouTubeError('No YouTube Data API key is set: the owner adds one on Plugins → YouTube niche scout.', 0, 'noKey')
    await deps.charge(QUOTA_COST[method], method)
    const url = new URL(`${base}/${method}`)
    url.search = new URLSearchParams({ ...params, key }).toString()
    const response = await fetcher(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]), headers: { Accept: 'application/json' } })
    const body: unknown = await response.json().catch(() => ({}))
    if (!response.ok) {
      const error = obj(obj(body)['error'])
      const first = Array.isArray(error['errors']) ? obj(error['errors'][0]) : {}
      const reason = str(first['reason']) || str(obj(Array.isArray(error['details']) ? error['details'][0] : undefined)['reason'])
      throw new YouTubeError(`YouTube ${method} answered HTTP ${String(response.status)}: ${str(error['message']) || 'no message'}`, response.status, reason)
    }
    return body
  }
  return {
    async search(options: SearchOptions, signal: AbortSignal): Promise<SearchPage> {
      const body = await call('search', {
        part: 'snippet',
        type: 'video',
        q: options.query,
        videoDuration: options.duration,
        publishedAfter: options.publishedAfter,
        order: options.order ?? 'viewCount',
        maxResults: String(options.maxResults ?? 50),
        ...options.regionCode === undefined || options.regionCode === '' ? {} : { regionCode: options.regionCode },
        ...options.relevanceLanguage === undefined || options.relevanceLanguage === '' ? {} : { relevanceLanguage: options.relevanceLanguage },
      }, signal)
      const videoIds = items(body).map(i => str(obj(i['id'])['videoId'])).filter(id => id !== '')
      return { videoIds, totalResults: num(obj(obj(body)['pageInfo'])['totalResults']) ?? videoIds.length }
    },
    async videos(ids: string[], signal: AbortSignal): Promise<VideoInfo[]> {
      if (ids.length === 0) return []
      const body = await call('videos', { part: 'snippet,statistics,contentDetails', id: ids.slice(0, 50).join(','), maxResults: '50' }, signal)
      return items(body).map(parseVideo).filter(v => v !== undefined)
    },
    async channels(ref: { ids: string[] } | { handle: string }, signal: AbortSignal): Promise<ChannelInfo[]> {
      const params: Record<string, string> = 'ids' in ref ? { id: ref.ids.slice(0, 50).join(',') } : { forHandle: ref.handle }
      if ('ids' in ref && ref.ids.length === 0) return []
      const body = await call('channels', { part: 'snippet,statistics,contentDetails', maxResults: '50', ...params }, signal)
      return items(body).map(parseChannel).filter(c => c !== undefined)
    },
    async uploads(playlistId: string, signal: AbortSignal): Promise<string[]> {
      const body = await call('playlistItems', { part: 'contentDetails', playlistId, maxResults: '50' }, signal)
      return items(body).map(i => str(obj(i['contentDetails'])['videoId'])).filter(id => id !== '')
    },
  }
}

/**
 * Read what the owner pasted as a channel: a channel id, an `@handle`, or a channel or video page address.
 * @param input - the text.
 * @returns the id or handle, or undefined when it is neither.
 */
export function channelRef(input: string): { ids: string[] } | { handle: string } | undefined {
  const text = input.trim()
  const id = /(UC[\w-]{22})/u.exec(text)?.[1]
  if (id !== undefined) return { ids: [id] }
  const handle = /(?:^|youtube\.com\/)(@[\w.-]{3,30})/u.exec(text)?.[1]
  return handle === undefined ? undefined : { handle }
}
