/**
 * Whether a comment pitch is visible to anyone but its author, and the reply
 * numbers by channel.
 *
 * A comment YouTube holds for review still shows to the account that posted
 * it, so a shift that checks its comment while signed in sees it either way.
 * The YouTube Data API reads comments signed out, with an API key, and returns
 * only published ones: a held comment is absent. `commentThreads.list` costs
 * one unit of the 10,000 a key gets each day.
 */

import type { CommentVisibility, Lead } from './store.ts'

/** What one lookup found. */
export interface CommentLookup {
  state: 'visible' | 'missing' | 'unknown'
  detail?: string
}

/** The fields of a `commentThreads.list` answer this module reads; every one may be missing. */
interface ThreadsAnswer {
  items?: { snippet?: { topLevelComment?: { snippet?: { textOriginal?: string; textDisplay?: string } } } }[]
  error?: { errors?: { reason?: string }[]; message?: string }
}

/** Lower-case words, for comparing a pitch with what YouTube returns. */
function normal(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

/**
 * Look a comment up on a video, signed out.
 * @param fetcher - HTTP.
 * @param apiKey - a YouTube Data API v3 key.
 * @param videoId - the video the comment was posted on.
 * @param text - the comment as it was sent.
 * @param signal - cancels the request.
 * @returns `visible` when a published top-level comment carries the text, `missing` when none does, `unknown` when the
 *   API could not answer (comments off, a bad key, the quota).
 */
export async function lookUpComment(
  fetcher: typeof fetch, apiKey: string, videoId: string, text: string, signal: AbortSignal,
): Promise<CommentLookup> {
  const wanted = normal(text)
  // The first words narrow YouTube's search; the full comparison below decides.
  const terms = wanted.split(' ').slice(0, 6).join(' ')
  const url = new URL('https://www.googleapis.com/youtube/v3/commentThreads')
  url.search = new URLSearchParams({ part: 'snippet', videoId, searchTerms: terms, maxResults: '50', textFormat: 'plainText', key: apiKey }).toString()
  let response: Response
  try {
    response = await fetcher(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) })
  } catch (error) {
    return { state: 'unknown', detail: error instanceof Error ? error.message : String(error) }
  }
  const body = await response.json().catch(() => ({})) as ThreadsAnswer
  if (!response.ok) {
    const reason = body.error?.errors?.[0]?.reason ?? body.error?.message ?? ''
    return { state: 'unknown', detail: `YouTube API HTTP ${String(response.status)}${reason === '' ? '' : ` (${reason})`}` }
  }
  const items = Array.isArray(body.items) ? body.items : []
  const head = wanted.slice(0, 60)
  const found = items.some((item) => {
    const snippet = item.snippet?.topLevelComment?.snippet
    const posted = normal(snippet?.textOriginal ?? snippet?.textDisplay ?? '')
    return posted.includes(head) || (posted.length > 20 && wanted.includes(posted.slice(0, 60)))
  })
  return { state: found ? 'visible' : 'missing' }
}

/**
 * What the next check of a comment pitch should conclude, given how old it is.
 * @param current - its visibility so far.
 * @param found - this lookup's answer.
 * @param ageHours - hours since it was posted.
 * @param heldAfterHours - hours after which a comment still missing counts as held.
 * @returns the new state.
 */
export function nextVisibility(current: CommentVisibility, found: CommentLookup['state'], ageHours: number, heldAfterHours: number): CommentVisibility {
  if (found === 'visible') return 'visible'
  if (found === 'unknown') return current === 'pending' ? 'unknown' : current
  return ageHours >= heldAfterHours ? 'held' : 'unseen'
}

/** Pitch and reply counts for one way of reaching creators. */
export interface ChannelStats {
  sent: number
  replied: number
}

/** The scout's numbers, for the owner. */
export interface OutreachStats {
  email: ChannelStats & { followUps: number; repliedAfterFollowUp: number }
  comment: ChannelStats & { visible: number; held: number; unseen: number; unchecked: number }
}

/**
 * Count pitches and replies by channel.
 * @param leads - every lead.
 * @returns emails sent and answered (and after a follow-up), comments posted, answered, and how many YouTube shows.
 */
export function outreachStats(leads: readonly Lead[]): OutreachStats {
  const stats: OutreachStats = {
    email: { sent: 0, replied: 0, followUps: 0, repliedAfterFollowUp: 0 },
    comment: { sent: 0, replied: 0, visible: 0, held: 0, unseen: 0, unchecked: 0 },
  }
  for (const lead of leads) {
    const pitch = lead.pitch
    if (pitch === undefined) continue
    const replied = lead.replies.some(r => r.at >= pitch.at)
    if (pitch.via === 'email') {
      stats.email.sent++
      if (replied) stats.email.replied++
      if (lead.followUp !== undefined) {
        stats.email.followUps++
        const after = lead.followUp.at
        if (lead.replies.some(r => r.at >= after)) stats.email.repliedAfterFollowUp++
      }
    } else {
      stats.comment.sent++
      if (replied) stats.comment.replied++
      const state = pitch.visibility?.state ?? 'pending'
      if (state === 'visible') stats.comment.visible++
      else if (state === 'held') stats.comment.held++
      else if (state === 'unseen') stats.comment.unseen++
      else stats.comment.unchecked++
    }
  }
  return stats
}

/**
 * The numbers as one line.
 * @param stats - from {@link outreachStats}.
 * @returns for example `Email: 14 sent, 2 replied (1 after a follow-up). Comments: 22 posted, 3 held by YouTube, 0 replied.`
 */
export function statsLine(stats: OutreachStats): string {
  const e = stats.email
  const c = stats.comment
  return `Email: ${String(e.sent)} sent, ${String(e.replied)} replied${e.followUps === 0 ? '' : ` (${String(e.followUps)} followed up, ${String(e.repliedAfterFollowUp)} replied after)`}. `
    + `Comments: ${String(c.sent)} posted (${String(c.visible)} visible, ${String(c.held)} held by YouTube, ${String(c.unseen + c.unchecked)} not confirmed yet), ${String(c.replied)} replied.`
}
