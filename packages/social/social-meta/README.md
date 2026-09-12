---
description: "Meta social providers: Facebook Pages and linked Instagram professional accounts, published through one Graph API sign-in."
kind: "package-reference"
---

# @deepseek-ai/dsh-social-meta

## Summary

Publishes to Facebook Pages and to the Instagram professional accounts linked to them, as two providers on the social seam: `facebook` and `instagram`. Both networks are the same Meta Graph API behind one Meta app, so they share one sign-in, one credential record, and one Page discovery; only the registration is doubled. They are registered separately because they answer differently — a Page takes a text-only post and an Instagram account does not, each is gated by its own App Review permission, and only Instagram carries the public-URL constraint — so a reader of the target list sees two honest rows rather than one averaged one.

The authorization flow obtains a long-lived user token, and every Page access token and Instagram account id is derived from that token on each operation rather than stored — a Page added, renamed, or unlinked since sign-in is seen without asking anyone to sign in again.

Mount it once per Meta account. Each mount holds one credential record, `social-meta/<account>`, written by the authorization flow this package registers on `ctx.authorization` and read through `ctx.credentials`; the harness keeps no token store of its own here.

Configure the app with `appIdRef` and `appSecretRef` (environment-variable names, `META_APP_ID` and `META_APP_SECRET` by default, resolved through the credential seam on every operation) and `redirectUri`, which must be one of the Valid OAuth Redirect URIs configured on the Meta app. Signing in opens the Facebook login dialog, the human approves, their browser lands on that redirect URI, and they paste the URL back into the flow's prompt; the code in it is exchanged for a short-lived user token and then for the long-lived one.

### Targets

| provider | id | label | accepts |
| --- | --- | --- | --- |
| `facebook` | `facebook:page:<page-id>` | the Page name | text, image, video |
| `instagram` | `instagram:<ig-user-id>` | `<page name> (Instagram @<handle>)` | image, video |

Every id begins with the name of the provider that lists it, which is what the social registry requires of a target id.

The `instagram` provider is registered only while the `instagram` config field is on, and lists a target only for a Page that has a linked Instagram professional account. Instagram accepts no text-only post: a caption travels with media or not at all, which is why its `accepts.text` is `false`.

Both providers read the permissions actually granted on the token (`/me/permissions`) and the Pages (`/me/accounts`) on every `targets()` call. A target that cannot publish reports `ready: false` and a `reason` naming the missing permission and that it needs Meta App Review. `post()` resolves its target through the same computation and refuses an unready one with that same sentence, so nothing is half-uploaded before the refusal.

### Publishing

Facebook text goes to the Page's `feed` edge; an image goes to `photos`, uploaded as multipart when the path is a local file and fetched by Meta when it is an `https` URL; a video goes through the resumable Uploads API (`/{app-id}/uploads`, then the upload session, then `fbuploader_video_file_chunk` on the Page's `videos` edge on the video host).

Instagram is the two-step container model: create the container, poll `status_code` until `FINISHED`, then publish it. The wait is bounded by `containerTimeoutMs` and a container that never finishes is reported as a timeout naming the container id — never as a successful post, because nothing was published. `media.alt` is sent as the container's `alt_text`, which Meta accepts on images.

## Model Experience

This package contributes no tool, prompt text, or session event: the model reaches both providers through whichever Consumer the social seam exposes, and the only model-visible strings it authors are the target `label` and `reason` fields. Those are written to be acted on — a `reason` names the permission that is missing and what unblocks it — so a model listing targets can say why a Page cannot be posted to instead of attempting the post. Token cost is one target list per call; nothing here is cached in the prompt, so there is no KV-cache effect beyond the listing the Consumer chooses to include.

## Known Limitations and Deferred Work

- **App Review gates publishing, and cannot be worked around here.** `pages_manage_posts` and `instagram_content_publish` are granted to a Meta app only after Meta reviews it (and the Business completes verification); until then they work only for people with a role on the app. This package makes that visible rather than survivable: the permissions are read from the token on every `targets()` call, and a target missing one is listed `ready: false` with the reason. Nothing in the harness can grant them.
- **The long-lived user token lasts about sixty days.** Its expiry is stored in the credential record from the exchange's `expires_in` and checked locally: within `tokenExpiryWarningDays` a ready target carries a warning naming the date, and once past it `targets()` and `post()` refuse with that date instead of making a call that would fail with an opaque OAuth error. Page access tokens derived from it do not expire on their own but stop working when it does. There is no refresh: re-authorizing means running the flow again, and nothing here schedules or reminds about that beyond the warning on the target.
- **Instagram fetches media from a public URL and takes no upload.** A local file therefore has to be reachable from the public internet before it can be posted. Set `publicMediaBaseUrl` to the base URL that media directory is served under and the file's name is appended to it; pass media as an `https` URL and it is used as given. With neither, the Instagram target stays listed and ready but carries that constraint as its `reason`, and posting a local file to it is refused with the same explanation rather than silently posting nothing. Publishing the file — a static host, a bucket, a tunnel — is the operator's, not this package's.
- **One attachment per post.** Meta's carousel container is a different creation flow and is not implemented; a request carrying more than one media file is refused.
- **A video upload is one transfer.** The Uploads API can resume from a byte offset after an interruption; this package sends the whole file once and fails the post if that fails. Resuming is worth adding when something reports upload progress to a human who could act on it.
- **Instagram results carry no URL.** The publish response returns the media id only, and the permalink needs a further call this package does not make; `SocialPostResult.url` is therefore absent for Instagram and present for Facebook.
- **No real-composition test.** The suite drives the provider against a stub HTTP Graph API through hand-built seams. Booting a test-only `cordis.yml` through the Loader waits on the social seam itself, which is being written alongside this package.
