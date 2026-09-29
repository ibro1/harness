/**
 * YouTube discovery through `yt-dlp`, reading only listing pages: a search
 * results page and a channel's Shorts tab. Both load without a signed-in
 * session from a server address, where a watch page is refused as a bot, so
 * discovery never touches the cookie jar the Klipara ingest depends on.
 */

import { execFile } from 'node:child_process'

/** Runs `yt-dlp` with arguments and resolves its stdout. */
export type YtDlpRunner = (args: readonly string[], signal: AbortSignal) => Promise<string>

/** One long video a search found. */
export interface FoundVideo {
  videoId: string
  videoUrl: string
  title: string
  durationMinutes: number
  channelId: string
  channelName: string
}

/** What a channel's Shorts tab says about the channel. */
export interface ChannelFacts {
  channelId: string
  channelName: string
  channelUrl: string
  subscribers: number | undefined
  /** Shorts listed, counted up to the probe limit. */
  shortsCount: number
  /** The first address in the channel description, when there is one. */
  email: string | undefined
}

/** YouTube's own filter: uploaded this month, longer than 20 minutes. */
const LONG_THIS_MONTH = 'EgQIBBgC'

/**
 * The `yt-dlp` runner used in production.
 * @param binary - the `yt-dlp` executable.
 * @param timeoutMs - abandon one run after this long.
 * @returns the runner.
 */
export function execYtDlp(binary: string, timeoutMs: number): YtDlpRunner {
  return (args, signal) => new Promise((resolve, reject) => {
    execFile(binary, [...args], { signal, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`yt-dlp failed: ${(stderr || error.message).trim().split('\n').slice(-1)[0] ?? error.message}`))
      else resolve(stdout)
    })
  })
}

/** Best-effort string field. */
function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** The entries array of a `yt-dlp -J` playlist dump. */
function entries(dump: unknown): Record<string, unknown>[] {
  const list = typeof dump === 'object' && dump !== null ? (dump as Record<string, unknown>)['entries'] : undefined
  return Array.isArray(list) ? list.filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null) : []
}

/**
 * Search for long videos uploaded this month.
 * @param run - the `yt-dlp` runner.
 * @param query - the search words.
 * @param limit - most results to read.
 * @param signal - cancels the run.
 * @returns the videos, in YouTube's order, each with its channel.
 */
export async function searchLongVideos(run: YtDlpRunner, query: string, limit: number, signal: AbortSignal): Promise<FoundVideo[]> {
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=${LONG_THIS_MONTH}`
  const out = await run([url, '--flat-playlist', '-J', '--playlist-end', String(limit), '--no-warnings'], signal)
  return entries(JSON.parse(out) as unknown).flatMap((row) => {
    const videoId = text(row['id'])
    const channelId = text(row['channel_id'])
    if (videoId === '' || channelId === '') return []
    return [{
      videoId,
      videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
      title: text(row['title']),
      durationMinutes: Math.round((typeof row['duration'] === 'number' ? row['duration'] : 0) / 60),
      channelId,
      channelName: text(row['channel']),
    }]
  })
}

/**
 * Read a channel's subscriber count, how many Shorts it already posts, and any
 * address in its description.
 * @param run - the `yt-dlp` runner.
 * @param channelId - the channel id.
 * @param probe - count Shorts up to this many.
 * @param signal - cancels the run.
 * @returns what the Shorts tab shows.
 */
export async function channelFacts(run: YtDlpRunner, channelId: string, probe: number, signal: AbortSignal): Promise<ChannelFacts> {
  const channelUrl = `https://www.youtube.com/channel/${channelId}`
  let dump: Record<string, unknown> = {}
  try {
    const out = await run([`${channelUrl}/shorts`, '--flat-playlist', '-J', '--playlist-end', String(probe), '--no-warnings'], signal)
    dump = JSON.parse(out) as Record<string, unknown>
  } catch (error) {
    // A channel with no Shorts tab at all fails the listing; that is zero Shorts.
    if (!/does not have a shorts tab|This channel does not have/i.test(error instanceof Error ? error.message : String(error))) throw error
  }
  const followers = dump['channel_follower_count']
  const email = /[\w.+-]+@[\w-]+\.[\w.-]+/u.exec(text(dump['description']))?.[0]
  return {
    channelId,
    channelName: text(dump['channel']),
    channelUrl,
    subscribers: typeof followers === 'number' ? followers : undefined,
    shortsCount: entries(dump).length,
    email,
  }
}
