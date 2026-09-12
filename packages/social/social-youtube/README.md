---
description: "YouTube provider for the social seam: an OAuth sign-in that keeps a refresh token, and a post that is a resumable video upload titled from the first line of its text."
kind: "package-reference"
---

# @deepseek-ai/dsh-social-youtube

## Summary

Posts to YouTube through the social seam, where a post is a video upload. One target exists per channel the authorized Google account owns, named `youtube:channel:<channel id>`, and it accepts video only — `{ text: false, image: false, video: true }` — so the seam refuses a text-only or image post before this package is reached.

The sign-in is Google's OAuth 2.0 web-server flow asked for offline access, so Google issues a **refresh token**. That token is the whole stored credential, written through the credential seam as the `grant` record `social-youtube/oauth`; access tokens are minted from it as they are needed and held in memory only, which is why this credential renews itself and the human signs in once.

Two limits are stated up front rather than discovered: uploads are capped per day by Google's quota, and `youtube.upload` is a sensitive scope whose unverified clients have their uploads restricted to private. Both appear on every target's `reason`, and in the error or the result notes of the upload they affect.

## Use this package

Mount it beside the social seam, the credential store, and the authorization seam:

```yaml
social-youtube:
  clientIdRef: GOOGLE_CLIENT_ID
  clientSecretRef: GOOGLE_CLIENT_SECRET
  redirectUri: http://localhost
  privacyStatus: private
```

`clientId` and `clientSecret` can also be given inline, and win over the environment variables when they are. Everything else has a default: `categoryId` (`22`, People & Blogs), `madeForKids` (`false`), `notifySubscribers` (`false`, where YouTube's own default is true), `chunkBytes` (8 MiB, and a multiple of 262144 or the plugin refuses to load), `uploadRetries`, `timeoutMs`, `chunkTimeoutMs`, and the four Google origins, which exist so a test or a proxy can stand in.

### Setting up the Google client

1. Enable **YouTube Data API v3** on a Google Cloud project.
2. Create an OAuth client of type **Web application**, and add exactly the `redirectUri` this plugin is configured with to its authorized redirect URIs — Google matches it byte for byte, scheme, case, and trailing slash included. The default `http://localhost` is a page that will not load, which is fine: the sign-in asks the human to copy the address they land on.
3. Add the scopes `https://www.googleapis.com/auth/youtube.upload` and `https://www.googleapis.com/auth/youtube.readonly` to the consent screen, and add the humans who will sign in as test users while the client is unverified.
4. Put the client id and secret in the environment variables named by `clientIdRef` and `clientSecretRef`.

### Signing in

Authorize the credential `social-youtube/oauth` from any surface that runs authorization flows. The flow opens Google's consent page with `access_type=offline` and `prompt=consent`, asks for the address the browser was redirected to, exchanges the code, and stores the refresh token together with the granted scopes and the channel it belongs to. A sign-in that comes back without a refresh token is refused rather than stored, because a credential that cannot renew itself would fail silently an hour later; the fix is to remove the application under `myaccount.google.com/permissions` and sign in again.

### How a post becomes a video

The seam's request is a text post with attachments. This provider maps it:

| Request | Video |
|---|---|
| the attachment with `kind: 'video'` | the file that is uploaded |
| the **first line** of `text` | `snippet.title` — at most 100 characters |
| everything after the first line | `snippet.description` — at most 5000 bytes of UTF-8 |
| `privacyStatus` from config | `status.privacyStatus`, `private` unless raised |
| `alt` on the attachment | nothing; YouTube has no field for it |

A post with no video is refused with a message saying exactly that, before any HTTP call. A first line too long to be a title is refused too, rather than cut to 100 characters, because a caller who did not know about the mapping would otherwise get a title made of the first sentence of their paragraph. The same mapping is on every ready target's `reason`.

### What the upload does

`videos.insert` is a resumable media upload. The provider POSTs the metadata to `/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status` with `X-Upload-Content-Length` and `X-Upload-Content-Type`, takes the session URI from the response's `Location` header, and PUTs the file to it in `chunkBytes` pieces under `Content-Range`. A chunk that is interrupted — a dropped connection, or a `500`, `502`, `503`, or `504` — is not re-sent blindly: the session is asked how much it holds with `Content-Range: bytes */<size>`, and the next PUT starts exactly there, up to `uploadRetries` times.

The result carries the video id, its `https://www.youtube.com/watch?v=<id>` URL, and `notes` stating what YouTube actually did: the `status.privacyStatus` it set, which is not always the one requested, and the `status.uploadStatus` — a video answered as `uploaded` is still being processed and is not watchable yet, and one answered as `rejected` or `failed` will not be published at all.

## Model Experience

This package contributes no tool of its own. What reaches a model is what the social seam's tool renders: the target list, where every YouTube target carries the post-to-video mapping, the daily upload ceiling, and the verification restriction in its `reason`; and the post result, whose `notes` state the privacy and processing state YouTube actually set. Refusals are written the same way — a post with no video, a first line too long to be a title, and a spent quota each say what happened and what to do instead, so the model does not retry something that cannot work.

#### KV Cache effect

No invalidation of its own. Target text enters a request only when the seam's tool is called, and it is stable between calls for a given channel and credential.

## Known Limitations and Deferred Work

- **About six uploads a day, and the ceiling is Google's.** Google publishes two accountings and a project is on one of them: the current quota table gives `videos.insert` its own bucket of 100 calls a day, while a project still on the shared 10,000-unit day spends about 1600 units per upload — roughly six. Whichever applies, the quota resets at midnight Pacific Time, nothing in this package raises it, and more is a separate YouTube API Services audit application to Google. A `quotaExceeded`, `dailyLimitExceeded`, `rateLimitExceeded`, or `userRateLimitExceeded` refusal is reported as that fact rather than as a bare 403.
- **An unverified client's uploads are private whatever was asked for.** `youtube.upload` is a sensitive scope. Google restricts every `videos.insert` upload from an unverified API project created after 28 July 2020 to private viewing, and lifting that takes a compliance audit; a consent screen still in Testing additionally caps the client at 100 users and expires its refresh tokens after seven days, after which the human must sign in again. The provider reads `status.privacyStatus` back and reports what YouTube set, so nothing here claims a video is public that nobody can see — but it cannot make it public.
- **A post is a video, and the text is split to fit.** The seam's `post(text, media)` has no title field, so the first line of the text is the title and the rest is the description. This is a convention, not something the request expresses; a caller that does not know it is refused with a message that explains it rather than being given a truncated title. If the seam ever grows a structured payload, this mapping is what should be replaced.
- **A resume does not survive the process.** An interrupted chunk resumes within the same `post()` call, because the session URI lives in that call's memory. A harness that restarts mid-upload starts the upload again; keeping session URIs would need a durable store this package does not have. `Retry-After` on a `308` is likewise not honored — the retry is immediate.
- **One video per post, and nothing else about it.** Tags, localizations, `publishAt` scheduling, thumbnails, captions, and playlists are not set; a second video attachment is refused rather than uploaded separately. `alt` text is accepted by the seam and dropped here, as YouTube has no field for it.
- **Only the channels `channels.list?mine=true` returns.** A content-owner (`onBehalfOfContentOwner`) or brand-account channel the signed-in user administers but does not own is not listed, so it cannot be posted to.
- **Signing out is local.** Deleting the `social-youtube/oauth` record forgets the refresh token without telling Google; revoking the grant is done at `myaccount.google.com/permissions`. The authorization seam has no place to declare a server-side revoke.
