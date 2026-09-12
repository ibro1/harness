---
description: "Social posting for both audiences: the model's target catalog and approval-gated post tool, plus the authenticated status and disconnect routes the Settings card reads."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-social

## Summary

The Consumer role of the social capability seam, for both of its audiences. It injects `ctx.social` and puts two tools in front of the model — `social_targets`, which lists the accounts, Pages and channels the harness can post to, and `social_post`, which publishes one post to one of them — and mounts two HTTP routes in front of a person, which the [social card](../../client/ui-social/README.md) in Settings → Plugins reads.

**Why both live here.** The routes consume exactly what the tools consume: `ctx.social.targets()` and this plugin's own `postWithoutApproval`. A separate package could only re-derive both from here, and would then own a second copy of the rule about which targets skip the approval gate. What the two audiences do *not* share is the vocabulary they are written in — the tool descriptions speak to a model about publishing, the routes answer a person asking what is connected and what is about to lapse — and that difference lives in the two surfaces, not in two packages.

`social_post` is the first tool in this harness that speaks publicly under the operator's name. Everything shipped before it either read data or acted on the operator's own infrastructure; a wrong deploy can be rolled back, and a wrong post cannot. So it asks a human first, through the `interaction` approval seam (`ctx.approval`), and it shows that person the whole thing they are approving: the target's label, the post text **verbatim**, and every attachment by filename, kind and size. A summary would not be an approval of anything.

The ask lives inside the tool's `execute` — the only code path in this package that reaches `ctx.social.post()`. It is not a wrapper, a listener, or a schema omission that a different caller could go around. The test suite denies at the executor and asserts the provider's `post` was never called.

### What the approval prompt says

```
Publish publicly to Ada Obi (personal) (linkedin:member) on linkedin.

--- the post, exactly as it will be published ---
Doors open at nine.
--- end of post ---

Attachments:
- shot.png — image, 128.4 KB — alt: The wall at dusk
```

Anything but an explicit grant refuses and publishes nothing: a rejection, a cancellation, an unreachable approval channel, a composition with no approval service, and a call with no agent to route the question through each raise a distinct message that reaches the model as the call's error.

### Attachments

Media paths come from a model, so they are resolved against the session working directory and refused if they leave it. The check canonicalizes both sides with `realpath` and compares with `path.relative`, so a symlink out of the workspace and a `..` walk are both refused; a string prefix would have accepted `/workspace-elsewhere` for a workspace `/workspace`. Files are resolved *before* the prompt, so nobody is asked to approve a post that cannot be published, and the sizes shown are the sizes on disk.


## The human surface

Two routes, both `kind: 'exact'`, both authenticated: neither passes `authenticate`, so both take the web server's default and sit behind the deployment's password gate. One reads the state of every connected account and the other deletes a credential; neither has any business answering an anonymous caller.

**No secret crosses either route.** `GET /social/status` builds every target view field by field from `SocialTarget`, so a provider that later adds a field to its listing cannot leak it here, and the credential seam's value half is never called — not `resolve`, not `readRecord`. Only the enumeration (`listRecords`) and presence (`describeRecord`) halves are. There is no token, no fragment of one, and nothing masked, because there is nothing here a person needs a secret for.

### `GET /social/status`

```json
{
  "targets": [
    {
      "id": "linkedin:member",
      "provider": "linkedin",
      "label": "Ada Obi (personal)",
      "accepts": { "text": true, "image": true, "video": true },
      "ready": false,
      "state": "blocked",
      "reason": "The LinkedIn token expires on 2026-09-16, in 4 days. …"
    }
  ],
  "providers": [
    {
      "name": "linkedin",
      "targets": 1,
      "disconnectable": true,
      "credentialKey": "social-linkedin/member",
      "sharedWith": []
    }
  ],
  "postWithoutApproval": ["youtube:channel:UC123"]
}
```

`targets` is the seam's own list, ordered by id, ready or not. `reason` is the provider's sentence verbatim whenever it gave one — **including on a `ready: true` target**, which is how a credential that works today and lapses shortly is reported. `state` names that case: `ready` is ready with nothing to say, `warning` is ready with a reason, `blocked` is not ready. A warning whose reason had been dropped would be indistinguishable from being fine, which is the failure this accounting exists to prevent.

`providers` carries one entry per provider currently listing targets. `credentialKey` is a record *address* (`<scope>/<id>`), never a value, and `sharedWith` names the other providers one disconnect would also disconnect.

`postWithoutApproval` is this plugin's own exemption list. A target that publishes without asking is the one thing on this surface somebody might not expect, so it is reported rather than left discoverable only by reading a cordis.yml.

### `POST /social/disconnect`

Body `{"provider": "linkedin"}`. Removes that provider's stored credential record through `ctx.credentials.deleteRecord`, so an account is disconnected without editing a file.

```json
{
  "provider": "linkedin",
  "credentialKey": "social-linkedin/member",
  "removed": true,
  "alsoDisconnected": []
}
```

`removed: false` reports that no record was stored — a no-op, not a failure, because "nothing is connected" is the state the caller asked for.

Every refusal happens before `deleteRecord`, and each names what the caller needs to proceed:

| Status | Case | The body carries |
| --- | --- | --- |
| 400 | no provider name in the body | what the body must be |
| 400 | a provider name no registered provider carries | `providers`, the names that exist |
| 503 | no credential service composed | why there is nothing to remove |
| 409 | the provider's record address cannot be chosen | `providers` and `storedRecords`, the addresses that are stored |

### Resolving a provider's credential record

The social seam publishes no provider-to-record lookup — a record's scope is its *owning plugin's* name, and only that plugin knows which social providers it registers. So the route resolves the address in two steps, and never invents one:

1. The `credentialKeys` config, if it names the provider.
2. Otherwise, a stored record whose scope is the provider's own name or `social-<provider>`, which is how the providers shipped beside this package are packaged (`social-linkedin` registers `linkedin`; `social-youtube` registers `youtube`). The candidates come from `listRecords()`, so only an address the seam already reports as stored can be selected.

It fails closed. No match and more than one match both refuse with the stored addresses listed, rather than deleting a credential on a guess. `social-meta` is the case that needs step 1: its single record authorizes both `facebook` and `instagram`, so neither name derives, and that composition must name the address to disconnect either one.

### Configuration

- `postWithoutApproval` — target ids that may publish without asking, one exact id at a time. Empty by default. There is deliberately no global "approval off" switch: exempting a staging channel must not exempt a real account.
- `credentialKeys` — social provider name to the credential record address (`<scope>/<id>`) holding its grant, for `POST /social/disconnect`. Empty by default, and only needed where the address cannot be derived from the provider name. A malformed address throws at load rather than when somebody presses Disconnect.

### Composition

`inject` is `tools`, `social`, and `webServer`. The web server is required because the human surface is half of what this package is for, and mounting it without one would silently ship a card nobody can reach. `credentials`, `settings`, and `approval` are resolved with `ctx.get(...)` where they are used, so a composition missing one fails that one operation closed with a legible refusal instead of keeping the whole plugin — including the harmless catalog — unmounted. With no settings service the routes still serve; only the card stops being listed, because the Settings → Plugins tab dispatches one card per served namespace and this plugin serves an empty `social` namespace for exactly that purpose.

## Model Experience

- `social_targets` — the available targets: id, human label, owning provider, what each accepts, and for anything unready, why. It reads the seam's catalog only; it never touches a credential, so no token or part of one can reach the transcript through it.
- `social_post` — `target` (an exact id from `social_targets`), `text` (published byte for byte), and optional `media` (`path`, `kind`, `alt`). The description tells the model the post is public, permanent, and gated on a human.

Neither HTTP route is model-visible: they contribute no tool, no prompt text, and no session event, so adding them changed nothing a model reads.

Token cost is proportional to the number of connected targets, which is a handful. Both tools are registered on the shared tool registry at mount, so the schemas sit in the stable prefix of the request and do not disturb the KV cache; neither tool contributes prompt text of its own, and neither publishes a session-durable catalog message.

The post text is model-authored and goes out under a person's name, so this package never trims, reflows, or otherwise cleans it: what the human approved is what `ctx.social.post()` receives.

## Known Limitations and Deferred Work

- **The approval prompt is a text blob.** The seam's `ApprovalRequest.reason` is a string, so a UI renders the post as prose rather than as a preview with thumbnails. A structured approval payload would need the approval seam to carry one.
- **No pre-flight platform validation.** Length limits, aspect ratios, and per-platform media rules are not checked before the ask. A post can be approved and still be refused by the platform; the model then sees the provider's error.
- **Approval cannot be re-asked for an edit.** A rejected post is simply a failed call. There is no "approve with changes" path, because the approval seam's outcome vocabulary has no such member.
- **`postWithoutApproval` is matched by exact id.** No patterns and no per-provider wildcards, deliberately — a wildcard is how a staging exemption becomes a production one.
- **Nothing is logged beyond the approval audit pair.** The seam's `approval/asked` + `approval/decided` events record that this post was asked about and decided; the published id and URL live only in the tool result. A durable "what this agent published" record needs a session event of its own.
- **Disconnect cannot always find the record.** The seam has no provider-to-record lookup, so a provider whose credential scope is neither its own name nor `social-<provider>` must be named in `credentialKeys`. `social-meta` is that case today. A seam operation letting a provider declare the record backing it would remove the config field entirely.
- **Disconnect removes the grant, not the platform's authorization.** `deleteRecord` deletes the harness's copy of the token; nothing is revoked at LinkedIn, Meta, or Google, and the app stays listed in the person's account there. Revocation would need each provider to implement it.
- **A missing redirect URI is not reported.** Each provider takes its `redirectUri` as plugin config and refuses only when a sign-in starts, so it never reaches `targets()` and `GET /social/status` has nothing to say about it. The card therefore names no redirect-URI environment variable. Reporting one needs the providers to publish their own configuration readiness through the seam.
- **The status route is unpaged and uncached.** Every read re-asks every provider, because `ready` is a live fact about a credential and a cached "ready" would be a stale observation. With a handful of targets that is the right trade; a deployment with many accounts would feel each provider's listing latency on every poll.
- **A disconnect is not logged.** `removed` reaches the caller and nothing else. A durable "the operator disconnected this account" fact needs a session event of its own, the same gap the published post id has.
- **No `./invariant` companion.** There is no second observation of the tool registry, the approval decision, or the route table that could diverge from this package's own; the enforcement point is a single operation, and its test denies through the executor.
