/**
 * Publishing to an Instagram professional account: create a media container,
 * wait for Meta to finish fetching and transcoding the media, then publish the
 * container.
 *
 * The wait is bounded and its timeout is reported as a timeout. A container
 * that never reaches `FINISHED` has published nothing, and a provider that
 * answered with an id anyway would be claiming a post that does not exist.
 *
 * @module @deepseek-ai/dsh-social-meta/instagram
 */

import { basename } from 'node:path'
import type { GraphEndpoint } from './graph.ts'
import { graphPostForm, graphRequest } from './graph.ts'
import { isRemote } from './facebook.ts'
import type { SocialMedia, SocialPostResult } from './types.ts'

/**
 * The URL Meta should fetch this file from.
 *
 * The Graph API takes no binary upload for Instagram: a container names a URL
 * and Meta's servers fetch it, so a local file has to be reachable from the
 * public internet before it can be posted at all. `publicBaseUrl` is the
 * operator's answer to that — the base URL the media directory is served under.
 * @param media - the attachment from the request.
 * @param publicBaseUrl - the base URL local media is served under; empty when there is none.
 * @returns the URL to hand Meta, or `undefined` when a local file has no public address.
 */
export function publicMediaUrl(media: SocialMedia, publicBaseUrl: string): string | undefined {
  if (isRemote(media.path)) return media.path
  if (publicBaseUrl === '') return undefined
  return `${publicBaseUrl.replace(/\/+$/u, '')}/${encodeURIComponent(basename(media.path))}`
}

/** Everything one Instagram post needs. */
export interface InstagramPostInput {
  /** Where the Graph API lives. */
  endpoint: GraphEndpoint
  /** The Instagram professional account's id. */
  igUserId: string
  /** The access token of the Page the account is linked to. */
  pageToken: string
  /** The caption. */
  text: string
  /** The single attachment; Instagram has no text-only post. */
  media: SocialMedia
  /** The URL Meta will fetch the media from. */
  mediaUrl: string
  /** Milliseconds between container status checks. */
  pollIntervalMs: number
  /** Milliseconds to wait for the container in total before reporting a timeout. */
  pollTimeoutMs: number
}

/** Sleep, so the poll loop does not spin. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/**
 * Wait for one container to become publishable.
 * @param input - the endpoint, the token, and the poll bounds.
 * @param containerId - the container to watch.
 * @throws when the container reports `ERROR` or `EXPIRED`, or when the bounded
 * wait runs out while it is still processing.
 */
async function awaitContainer(input: InstagramPostInput, containerId: string): Promise<void> {
  const deadline = Date.now() + input.pollTimeoutMs
  let last = 'IN_PROGRESS'
  do {
    const answer = await graphRequest(input.endpoint, containerId, {
      params: { fields: 'status_code,status', access_token: input.pageToken },
    })
    last = typeof answer['status_code'] === 'string' ? answer['status_code'] : 'IN_PROGRESS'
    if (last === 'FINISHED' || last === 'PUBLISHED') return
    if (last === 'ERROR' || last === 'EXPIRED') {
      const detail = typeof answer['status'] === 'string' ? `: ${answer['status']}` : ''
      throw new Error(`Instagram container ${containerId} reported ${last}${detail}; nothing was published`)
    }
    await sleep(input.pollIntervalMs)
  } while (Date.now() < deadline)
  throw new Error(
    `Instagram container ${containerId} was still ${last} after ${String(input.pollTimeoutMs)}ms; nothing was published`,
  )
}

/**
 * Publish one post to an Instagram professional account.
 * @param input - the endpoint, the account, the token, the caption, and the media.
 * @returns the published media's id.
 * @throws {MetaGraphError} carrying Meta's own response body when a Graph call fails.
 * @throws {Error} when the container never becomes publishable.
 */
export async function postToInstagram(input: InstagramPostInput): Promise<SocialPostResult> {
  const { media } = input
  const container = await graphPostForm(input.endpoint, `${input.igUserId}/media`, {
    ...media.kind === 'image'
      ? { image_url: input.mediaUrl }
      : { media_type: 'REELS', video_url: input.mediaUrl },
    caption: input.text,
    // Meta accepts alt text on image containers only; sending it with a reel
    // would fail the container rather than be ignored.
    ...media.alt === undefined || media.kind !== 'image' ? {} : { alt_text: media.alt },
    access_token: input.pageToken,
  })
  const containerId = container['id']
  if (typeof containerId !== 'string' || containerId === '') {
    throw new Error(`Instagram returned no container id: ${JSON.stringify(container)}`)
  }
  await awaitContainer(input, containerId)
  const published = await graphPostForm(input.endpoint, `${input.igUserId}/media_publish`, {
    creation_id: containerId,
    access_token: input.pageToken,
  })
  const id = published['id']
  if (typeof id !== 'string' || id === '') {
    throw new Error(`Instagram published container ${containerId} but returned no media id`)
  }
  return { id }
}
