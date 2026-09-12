/**
 * The honest part of fitting a video onto a text-post seam.
 *
 * The seam's `post(text, media)` describes a text post with attachments;
 * `videos.insert` describes a video with a title and a description. The mapping
 * is fixed and stated everywhere a caller can see it: the video is the `video`
 * attachment, the first line of `text` is the title, and the rest is the
 * description. A caller who does not know that writes a paragraph and gets a
 * title YouTube cuts at 100 characters, so a first line too long to be a
 * title is refused here rather than quietly cut.
 *
 * @module @deepseek-ai/dsh-social-youtube/mapping
 */

import { MAPPING_MESSAGE, VERIFICATION_MESSAGE } from './errors.ts'
import type { UploadedVideo } from './types.ts'

/** YouTube's limit on `snippet.title`, in characters. */
export const TITLE_LIMIT = 100

/** YouTube's limit on `snippet.description`, in bytes of UTF-8 — not characters. */
export const DESCRIPTION_LIMIT_BYTES = 5000

/** YouTube rejects these in a title or a description outright. */
const FORBIDDEN = /[<>]/u

/** What one post's text became. */
export interface VideoText {
  /** The first line of the post. */
  title: string
  /** Everything after the first line. */
  description: string
}

/**
 * Split one post's text into the video's title and description.
 *
 * @param text - the post body as the caller wrote it.
 * @returns the title and the description.
 * @throws when the first line cannot be a title — empty, longer than YouTube's
 *   100 characters, or carrying a character YouTube rejects — or when the
 *   description is longer than YouTube's 5000 bytes. Every message states the mapping,
 *   because a caller meeting it for the first time is usually a caller who did
 *   not know a video was being described.
 */
export function splitPost(text: string): VideoText {
  const lines = text.split(/\r?\n/u)
  const title = (lines[0] ?? '').trim()
  const description = lines.slice(1).join('\n').replace(/^\n+/u, '').trimEnd()
  if (title === '') {
    throw new Error(`The post has no first line to use as the video title. ${MAPPING_MESSAGE}`)
  }
  if (title.length > TITLE_LIMIT) {
    throw new Error(`The first line of the post is ${String(title.length)} characters, and YouTube cuts a video title `
      + `at ${String(TITLE_LIMIT)}. ${MAPPING_MESSAGE} Put a short title on the first line and the rest after it.`)
  }
  const descriptionBytes = Buffer.byteLength(description, 'utf8')
  if (descriptionBytes > DESCRIPTION_LIMIT_BYTES) {
    throw new Error(`The post is ${String(descriptionBytes)} bytes after its first line, and YouTube cuts a video `
      + `description at ${String(DESCRIPTION_LIMIT_BYTES)} bytes of UTF-8. ${MAPPING_MESSAGE}`)
  }
  if (FORBIDDEN.test(title) || FORBIDDEN.test(description)) {
    throw new Error(`YouTube rejects "<" and ">" in a video title or description, and the post contains one. ${MAPPING_MESSAGE}`)
  }
  return { title, description }
}

/**
 * State what YouTube did with the upload, as against what was asked for.
 *
 * `status.privacyStatus` and `status.uploadStatus` are read as facts rather
 * than assumed from the request: an unverified OAuth client's uploads can be
 * held at private whatever privacy was asked for, and a video YouTube is still
 * processing — or has rejected — is not one anybody can watch yet. Reporting
 * "published" about either would be the one failure worth avoiding most.
 * @param video - the resource `videos.insert` answered with.
 * @param requestedPrivacy - the `privacyStatus` that was asked for.
 * @returns one note per fact worth telling, most important first.
 */
export function describeOutcome(video: UploadedVideo, requestedPrivacy: string): readonly string[] {
  const notes: string[] = []
  switch (video.uploadStatus) {
    case 'rejected':
      notes.push(`YouTube rejected the video${video.rejectionReason === undefined ? '' : ` (${video.rejectionReason})`}; `
        + 'it will not be published, and nobody can watch it.')
      break
    case 'failed':
      notes.push(`YouTube could not process the video${video.failureReason === undefined ? '' : ` (${video.failureReason})`}; `
        + 'it is not watchable.')
      break
    case 'deleted':
      notes.push('YouTube reports the video as deleted.')
      break
    case 'uploaded':
      notes.push('YouTube has the whole file and is still processing it, so the video is not watchable yet.')
      break
    case 'processed':
      notes.push('YouTube has finished processing the video.')
      break
    default:
      // uploadStatus is an open set: a value this build does not know is still
      // worth repeating verbatim rather than dropping.
      if (video.uploadStatus !== undefined) notes.push(`YouTube reports uploadStatus "${video.uploadStatus}".`)
  }
  if (video.privacyStatus === undefined) {
    notes.push(`YouTube did not report the video's privacy, so treat "${requestedPrivacy}" as requested rather than set.`)
  } else if (video.privacyStatus === requestedPrivacy) {
    notes.push(`The video is ${video.privacyStatus} on YouTube, as requested.`)
  } else {
    notes.push(`The video is ${video.privacyStatus} on YouTube, although ${requestedPrivacy} was requested. `
      + VERIFICATION_MESSAGE)
  }
  return notes
}
