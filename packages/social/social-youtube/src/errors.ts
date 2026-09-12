/**
 * Google's error envelope, restated for whoever called the tool.
 *
 * Two of YouTube's refusals are facts about the account rather than about the
 * request, and a caller who sees only `403 Forbidden` will retry a thing that
 * cannot work: the daily quota, which is spent for the rest of the Pacific day,
 * and the channel's own upload limit. Both are named here in words, with what
 * to do about them.
 *
 * @module @deepseek-ai/dsh-social-youtube/errors
 */

/**
 * What the daily quota means for uploading, in the caller's terms.
 *
 * Google publishes two accountings for `videos.insert` and projects are on one
 * or the other: the current quota table gives uploads their own bucket of 100
 * calls a day at 1 unit each, while the older shared model charges about 1600
 * units of a 10,000-unit day — roughly six uploads. Both ceilings are stated,
 * because a caller that plans against the wrong one runs out mid-day, and
 * neither is a number this harness can change.
 */
export const QUOTA_MESSAGE = 'YouTube refused this for quota, not for anything about the video: '
  + 'uploads are capped per day — Google\'s current table gives videos.insert its own bucket of 100 calls a day, '
  + 'and a project still on the shared 10,000-unit day spends about 1600 units per upload, which is about six a day. '
  + 'Either way the quota resets at midnight Pacific Time, and raising it is a separate YouTube API Services audit '
  + 'application to Google, not a setting in this harness.'

/** The same ceiling stated before it is hit, for a target's `reason`. */
export const QUOTA_NOTICE = 'Uploading is capped per day: Google\'s current quota table gives videos.insert its own '
  + 'bucket of 100 calls a day, and a project still on the shared 10,000-unit day spends about 1600 units per upload, '
  + 'which is about six a day. The quota resets at midnight Pacific Time.'

/** What an account-level upload limit means, in the caller's terms. */
export const UPLOAD_LIMIT_MESSAGE = 'YouTube refused this because the channel has reached the number of videos it may '
  + 'upload for now. This is a limit on the channel, not on the API quota; unverified and new channels have a low one, '
  + 'and it lifts on its own after a while.'

/** What the sensitive-scope verification means for what a caller can expect to see. */
export const VERIFICATION_MESSAGE = 'youtube.upload is a sensitive scope: Google restricts every videos.insert upload '
  + 'from an unverified API project created after 28 July 2020 to private viewing, whatever privacy was asked for, '
  + 'and lifting that takes a compliance audit. A consent screen still in Testing also caps the client at 100 users '
  + 'and expires its refresh tokens after seven days.'

/** How this provider maps a text post onto a video, stated wherever a caller can see it. */
export const MAPPING_MESSAGE = 'A YouTube post is a video upload: attach the file as media with kind "video", '
  + 'put the video title on the first line of text, and the description in the lines after it. '
  + 'YouTube caps the title at 100 characters and the description at 5000 bytes.'

/** One parsed Google error body. */
export interface GoogleError {
  /** `error.errors[].reason` values, or the OAuth `error` string, in the order given. */
  reasons: readonly string[]
  /** `error.message`, `error_description`, or the raw body when neither is present. */
  message: string
}

/**
 * Read Google's error body, whichever of its two envelopes it used.
 *
 * The Data API answers `{ error: { code, message, errors: [{ reason, ... }], status } }`;
 * the OAuth endpoints answer `{ error, error_description }`. Anything else is
 * kept as text, because an HTML error page from a proxy is still the useful
 * part of the answer.
 * @param body - the response body as text.
 * @returns the reasons and the message.
 */
export function parseGoogleError(body: string): GoogleError {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return { reasons: [], message: body.slice(0, 300) }
  }
  const root = asRecord(parsed)
  const error = root['error']
  if (typeof error === 'string') {
    const description = root['error_description']
    return { reasons: [error], message: typeof description === 'string' ? description : error }
  }
  const detail = asRecord(error)
  const list = Array.isArray(detail['errors']) ? detail['errors'] : []
  const reasons = list
    .map(entry => asRecord(entry)['reason'])
    .filter((reason): reason is string => typeof reason === 'string')
  const message = detail['message']
  const status = detail['status']
  return {
    reasons: reasons.length > 0 ? reasons : typeof status === 'string' ? [status] : [],
    message: typeof message === 'string' ? message : body.slice(0, 300),
  }
}

/**
 * Restate one failed Google call as the error a caller should read.
 *
 * The quota and upload-limit refusals are replaced by what they mean, because
 * the raw `403` on them says nothing a caller can act on; everything else keeps
 * Google's own message, which is the useful part.
 * @param what - the call that failed, named for the caller ("the upload", "channels.list").
 * @param status - the HTTP status.
 * @param body - the response body as text.
 * @returns the error to throw.
 */
export function googleFailure(what: string, status: number, body: string): Error {
  const { reasons, message } = parseGoogleError(body)
  if (reasons.some(reason => QUOTA_REASONS.has(reason))) {
    return new Error(`${QUOTA_MESSAGE} (Google said: ${message})`)
  }
  if (reasons.includes('uploadLimitExceeded')) {
    return new Error(`${UPLOAD_LIMIT_MESSAGE} (Google said: ${message})`)
  }
  if (reasons.includes('youtubeSignupRequired')) {
    return new Error('The signed-in Google account has no YouTube channel, so there is nowhere to upload to. '
      + 'Create a channel on youtube.com with that account and authorize again.')
  }
  if (status === 401 || reasons.includes('authError') || reasons.includes('invalid_grant')) {
    return new Error(`Google rejected the credential on ${what}: ${message}. Authorize the YouTube provider again.`)
  }
  if (status === 403 && reasons.includes('insufficientPermissions')) {
    return new Error(`The stored YouTube grant does not carry the scope ${what} needs: ${message}. `
      + 'Authorize again and approve both the upload and the read-only permission.')
  }
  const reasonText = reasons.length === 0 ? '' : ` [${reasons.join(', ')}]`
  return new Error(`Google answered ${String(status)} on ${what}${reasonText}: ${message}`)
}

/** The reasons that all mean "the daily quota is spent or you are going too fast". */
const QUOTA_REASONS = new Set([
  'quotaExceeded',
  'dailyLimitExceeded',
  'rateLimitExceeded',
  'userRateLimitExceeded',
])

/** Read one unknown as a record, so a missing or misshapen field reads as absent. */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}
