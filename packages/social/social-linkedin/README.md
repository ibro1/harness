---
description: "LinkedIn provider for the social seam: member-feed posting with text, one image, or one video, authorized through an authorization flow and stored as a credential record."
kind: "package-reference"
---

# @deepseek-ai/dsh-social-linkedin

## Summary

Posts to LinkedIn through `ctx.social`. The provider is named `linkedin` and emits one target per place it can post to:

| Target id | What it is | When it appears |
|---|---|---|
| `linkedin:member` | The signed-in person's own feed | Always — ready or not, the target is listed so its `reason` can say what to do |
| `linkedin:org:<id>` | One organization page the signed-in person administers | Only when the stored token actually carries `w_organization_social` |

Every target accepts `{ text: true, image: true, video: true }`, and LinkedIn takes one attachment per post.

Signing in is an authorization flow (`ctx.authorization`) keyed `social-linkedin/member`, offering one method, `oauth`. The flow sends the human to LinkedIn's authorization page with the scopes `openid profile w_member_social`, takes back whatever their browser landed on — the whole redirect URL or the bare `code` from it — exchanges it for an access token, reads the member id from `GET /v2/userinfo`, and commits the result through `ctx.credentials` as a `grant` record. There is no callback route and no token store here: the authorization seam owns the conversation and the credential seam owns the storage.

The application's own credentials are named rather than carried: `clientIdRef` and `clientSecretRef` hold the environment-variable names (`LINKEDIN_CLIENT_ID` and `LINKEDIN_CLIENT_SECRET` by default) and are resolved through the credential seam on each sign-in, so no secret is ever written into settings. `redirectUri` must be the URI registered on the LinkedIn application; LinkedIn compares it byte-for-byte between the two OAuth legs, and sign-in refuses to start while it is empty.

All posting goes through the versioned REST API: every call carries `LinkedIn-Version` (the `apiVersion` config field, `202608` by default) and `X-Restli-Protocol-Version: 2.0.0`. Media bytes are the exception — they go to pre-signed upload URLs that take the bytes and nothing else.

### The 60-day credential

LinkedIn's self-serve tier issues an access token that lasts about 60 days and grants **no refresh token**. The credential therefore expires and a human has to sign in again; nothing in this package can renew it unattended.

So the expiry is a first-class stored fact. The grant record holds `expiresAt` as absolute epoch milliseconds — `expires_in` seconds cannot answer "how long is left" once the process that received it is gone — alongside `obtainedAt`, the granted `scopes`, and the member id and name. `targets()` decides readiness from that stored number and never from an API call, and reports `ready: false` **before** the token lapses: inside the `reauthWarningDays` window (7 days by default) the reason names the expiry date and the days remaining, while the token still works. Posting is refused only once the token is genuinely past its expiry, and that refusal too is decided locally, so a post never fails by discovering the expiry at LinkedIn.

### Posting

- **Text** — `POST /rest/posts` with the `commentary`, `PUBLIC` visibility, and `MAIN_FEED` distribution. The created post's URN comes back on the `x-restli-id` response header and becomes the result's `id`, with `url` pointing at `https://www.linkedin.com/feed/update/<urn>/`.
- **Image** — three steps in a fixed order: `POST /rest/images?action=initializeUpload` with `{initializeUploadRequest:{owner}}` answers `{value:{uploadUrl, image}}`; the raw bytes are `PUT` to that `uploadUrl`; the returned `urn:li:image:…` is attached as `content.media.id`.
- **Video** — `POST /rest/videos?action=initializeUpload` with `{initializeUploadRequest:{owner, fileSizeBytes}}` answers `{value:{video, uploadToken, uploadInstructions:[{uploadUrl, firstByte, lastByte}]}}`; each part's byte range is `PUT` to its own `uploadUrl` in the order given, and each response's `etag` is kept; `POST /rest/videos?action=finalizeUpload` with `{finalizeUploadRequest:{video, uploadToken, uploadedPartIds}}` completes it. The file is read one part at a time, because LinkedIn accepts videos far larger than this process should buffer.

**Alt text.** LinkedIn takes it on an image attachment as `content.media.altText`, and `media.alt` is sent there when present. When an image arrives without it the post still goes out — it is a real post somebody wanted — but the result's `notes` says the image is undescribed, and the same sentence is logged. A video attachment has no alt-text field; `media.alt` becomes the attachment's `title`, which is where LinkedIn's own video sample puts a description.

`notes` is an optional field this provider adds to the seam's `SocialPostResult`; a result carrying it still satisfies `{ id, url? }`. It exists for things worth saying about a post that succeeded — the undescribed image above, or a second attachment that LinkedIn had no room for.

## Model Experience

None. This package registers a social provider and an authorization flow; no tool, prompt, or result from it reaches a model request. A Consumer that puts posting in front of a model owns that surface and its own presentation.

#### KV Cache effect

No invalidation; no LinkedIn state enters a request prefix.

## Known Limitations and Deferred Work

- **The credential expires every 60 days and only a human can renew it.** LinkedIn's self-serve tier issues no refresh token, so there is no unattended renewal to build: someone must run the `social-linkedin/member` flow again. `targets()` reports unready inside the `reauthWarningDays` window to make that a scheduled chore rather than a failed post, which means a target can read `ready: false` while its token still works. A caller that posts only to ready targets will therefore stop posting up to a week early, by design.
- **No organization targets, because this account cannot have them.** Posting to a company page needs `w_organization_social` through LinkedIn's Community Management API, which is an approval the account this package was written against does not hold. Rather than list pages that would refuse every post, organization targets appear only when the stored grant's `scopes` actually contain that scope; with a member-only token the list is just `linkedin:member`. The organization path is written but has never run against a real approved token, so treat the ACL listing (`/rest/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED`) and the page-name lookup as unproven.
- **One attachment per post.** LinkedIn's `content.media` takes a single item, so a request carrying more attaches the first and says so in `notes`. Multi-image posts need LinkedIn's multi-image content type, which is a different request body and is not implemented.
- **A finalized video may not be ready the instant it is posted.** LinkedIn processes video asynchronously, and a post created immediately after `finalizeUpload` can land while the video is still processing. This package does not poll `GET /rest/videos/{urn}` for `status: AVAILABLE` first, because that GET is not reliably permitted to a `w_member_social`-only token; the post is created straight after finalize.
- **`apiVersion` has to be raised by hand.** LinkedIn supports each `YYYYMM` version for about a year and then answers 426. The version is a config field so a deployment can move it without a release, but nothing here notices the sunset approaching.
- **Sign-in is a paste, not a redirect.** The authorization seam's vocabulary is notices and prompts, so the human copies the redirect URL out of their browser rather than being caught by a local callback route. The flow accepts the whole URL or the bare code, and checks the `state` parameter when the pasted URL carries one — a bare pasted code cannot be checked against it.
- **Nothing revokes.** Signing out is `ctx.credentials.deleteRecord('social-linkedin/member')`, which forgets the token locally; LinkedIn's self-serve tier offers no revocation this package can call.
