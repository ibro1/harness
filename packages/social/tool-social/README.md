---
description: "Model-facing social posting: the target catalog, and one post tool that a human must approve before anything is published."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-social

## Summary

The Consumer role of the social capability seam. It injects `ctx.social` and puts two tools in front of the model: `social_targets`, which lists the accounts, Pages and channels the harness can post to, and `social_post`, which publishes one post to one of them.

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

### Configuration

- `postWithoutApproval` — target ids that may publish without asking, one exact id at a time. Empty by default. There is deliberately no global "approval off" switch: exempting a staging channel must not exempt a real account.

## Model Experience

- `social_targets` — the available targets: id, human label, owning provider, what each accepts, and for anything unready, why. It reads the seam's catalog only; it never touches a credential, so no token or part of one can reach the transcript through it.
- `social_post` — `target` (an exact id from `social_targets`), `text` (published byte for byte), and optional `media` (`path`, `kind`, `alt`). The description tells the model the post is public, permanent, and gated on a human.

Token cost is proportional to the number of connected targets, which is a handful. Both tools are registered on the shared tool registry at mount, so the schemas sit in the stable prefix of the request and do not disturb the KV cache; neither tool contributes prompt text of its own, and neither publishes a session-durable catalog message.

The post text is model-authored and goes out under a person's name, so this package never trims, reflows, or otherwise cleans it: what the human approved is what `ctx.social.post()` receives.

## Known Limitations and Deferred Work

- **The approval prompt is a text blob.** The seam's `ApprovalRequest.reason` is a string, so a UI renders the post as prose rather than as a preview with thumbnails. A structured approval payload would need the approval seam to carry one.
- **No pre-flight platform validation.** Length limits, aspect ratios, and per-platform media rules are not checked before the ask. A post can be approved and still be refused by the platform; the model then sees the provider's error.
- **Approval cannot be re-asked for an edit.** A rejected post is simply a failed call. There is no "approve with changes" path, because the approval seam's outcome vocabulary has no such member.
- **`postWithoutApproval` is matched by exact id.** No patterns and no per-provider wildcards, deliberately — a wildcard is how a staging exemption becomes a production one.
- **Nothing is logged beyond the approval audit pair.** The seam's `approval/asked` + `approval/decided` events record that this post was asked about and decided; the published id and URL live only in the tool result. A durable "what this agent published" record needs a session event of its own.
- **No `./invariant` companion.** There is no second observation of the tool registry or the approval decision that could diverge from this package's own; the enforcement point is a single operation, and its test denies through the executor.
