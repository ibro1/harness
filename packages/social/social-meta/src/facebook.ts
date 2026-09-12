/**
 * Publishing to a Facebook Page: the feed edge for text, the photos edge for an
 * image, and the resumable Uploads API followed by the video edge for a video.
 *
 * A Page post is made with the Page access token, never the user token, which
 * is why {@link postToPage} takes the whole Page rather than an id.
 *
 * @module @deepseek-ai/dsh-social-meta/facebook
 */

import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import type { GraphEndpoint } from './graph.ts'
import { graphPostForm, graphRequest } from './graph.ts'
import type { MetaPage, SocialMedia, SocialPostResult } from './types.ts'

/** Video container types Meta accepts, by file extension; anything else is declared MP4. */
const VIDEO_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
}

/**
 * Whether a media path is already published somewhere Meta can fetch it.
 * @param path - the media path from the request.
 * @returns true when the path is an `http` or `https` URL.
 */
export function isRemote(path: string): boolean {
  return /^https?:\/\//iu.test(path)
}

/** Everything one Page post needs. */
export interface FacebookPostInput {
  /** Where the Graph API lives. */
  endpoint: GraphEndpoint
  /** The Page being posted to, carrying its own access token. */
  page: MetaPage
  /** The message, or the photo and video caption. */
  text: string
  /** The single attachment, when the post carries one. */
  media?: SocialMedia
  /**
   * The Meta app id the resumable upload session is opened under, resolved only
   * when a local video is actually uploaded — a text or image post needs none.
   */
  appId: () => Promise<string>
}

/**
 * Read the id a publishing edge answered with.
 * @param answer - the Graph response.
 * @param fields - candidate id fields, most specific first.
 * @returns the first non-empty id.
 * @throws when the edge reported success without naming what it created.
 */
function publishedId(answer: Record<string, unknown>, fields: readonly string[]): string {
  for (const field of fields) {
    const value = answer[field]
    if (typeof value === 'string' && value !== '') return value
  }
  throw new Error(`Meta accepted the post but returned no id: ${JSON.stringify(answer)}`)
}

/**
 * Post text with no attachment to a Page's feed.
 * @param input - the endpoint, the Page, and the message.
 * @returns the post's id and its URL.
 */
async function postText(input: FacebookPostInput): Promise<SocialPostResult> {
  const answer = await graphPostForm(input.endpoint, `${input.page.id}/feed`, {
    message: input.text,
    access_token: input.page.accessToken,
  })
  const id = publishedId(answer, ['id'])
  return { id, url: `https://www.facebook.com/${id}` }
}

/**
 * Post an image to a Page's photos edge, uploading the bytes when the file is local.
 * @param input - the endpoint, the Page, the caption, and the image.
 * @param media - the image attachment.
 * @returns the post's id and its URL.
 */
async function postImage(input: FacebookPostInput, media: SocialMedia): Promise<SocialPostResult> {
  const path = `${input.page.id}/photos`
  const answer = isRemote(media.path)
    ? await graphPostForm(input.endpoint, path, {
      url: media.path,
      caption: input.text,
      access_token: input.page.accessToken,
    })
    : await (async () => {
      const bytes = await readFile(media.path)
      const form = new FormData()
      form.set('caption', input.text)
      form.set('access_token', input.page.accessToken)
      form.set('source', new Blob([new Uint8Array(bytes)]), basename(media.path))
      // No Content-Type header: fetch writes the multipart boundary itself.
      return graphRequest(input.endpoint, path, { method: 'POST', body: form })
    })()
  // The photos edge answers with the photo id and, separately, the id of the
  // feed story it created; the story is the thing a human opens.
  const id = publishedId(answer, ['post_id', 'id'])
  return { id, url: `https://www.facebook.com/${id}` }
}

/**
 * Upload a local video through the resumable Uploads API.
 * @param input - the endpoint, the Page, and the app id the session belongs to.
 * @param media - the local video file.
 * @returns the uploaded file handle the video edge publishes.
 */
async function uploadVideo(input: FacebookPostInput, media: SocialMedia): Promise<string> {
  const bytes = await readFile(media.path)
  const appId = await input.appId()
  const start = await graphPostForm(input.endpoint, `${appId}/uploads`, {
    file_name: basename(media.path),
    file_length: String(bytes.byteLength),
    file_type: VIDEO_TYPES[extname(media.path).toLowerCase()] ?? 'video/mp4',
    access_token: input.page.accessToken,
  })
  const session = start['id']
  if (typeof session !== 'string' || session === '') {
    throw new Error(`Meta opened no upload session for ${media.path}: ${JSON.stringify(start)}`)
  }
  // One transfer of the whole file. Resuming from a byte offset is what the
  // Uploads API adds over a plain upload, and it is worth adding here only once
  // something reports progress to a human who could act on it.
  const transfer = await graphRequest(input.endpoint, session, {
    method: 'POST',
    body: new Uint8Array(bytes),
    headers: {
      'Authorization': `OAuth ${input.page.accessToken}`,
      'file_offset': '0',
      'Content-Type': 'application/octet-stream',
    },
  })
  const handle = transfer['h']
  if (typeof handle !== 'string' || handle === '') {
    throw new Error(`Meta returned no file handle for ${media.path}: ${JSON.stringify(transfer)}`)
  }
  return handle
}

/**
 * Post a video to a Page: a remote file by URL, a local one through the
 * resumable upload.
 * @param input - the endpoint, the Page, the description, and the app id.
 * @param media - the video attachment.
 * @returns the video's id and its watch URL.
 */
async function postVideo(input: FacebookPostInput, media: SocialMedia): Promise<SocialPostResult> {
  const fields = isRemote(media.path)
    ? { file_url: media.path }
    : { fbuploader_video_file_chunk: await uploadVideo(input, media) }
  const answer = await graphPostForm(input.endpoint, `${input.page.id}/videos`, {
    ...fields,
    description: input.text,
    access_token: input.page.accessToken,
  }, 'video')
  const id = publishedId(answer, ['id'])
  return { id, url: `https://www.facebook.com/watch/?v=${id}` }
}

/**
 * Publish one post to a Facebook Page.
 * @param input - the endpoint, the Page, the text, and the optional attachment.
 * @returns the published post's id and URL.
 * @throws {MetaGraphError} carrying Meta's own response body when a Graph call fails.
 */
export function postToPage(input: FacebookPostInput): Promise<SocialPostResult> {
  const { media } = input
  if (media === undefined) return postText(input)
  return media.kind === 'image' ? postImage(input, media) : postVideo(input, media)
}
