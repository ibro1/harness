---
description: "The social group map: publishing a post to an account the operator owns, through a registry that merges platform providers and one approval-gated tool, for users and maintainers navigating the group."
kind: "package-group"
---

# social/ — social posting capability family

## Summary

The social group lets an agent publish to accounts the operator owns. A registry merges the targets every mounted provider offers — a LinkedIn member, a Facebook Page, an Instagram business account, a YouTube channel — and routes a post to whichever provider owns the target's id. One consumer publishes the model-facing tools, so what a model sees does not change with the platform. Mount the packages you need: the registry, at least one provider, and the consumer for model access.

This is the first capability in the harness that speaks publicly under a person's name. Every other tool reads data or acts on infrastructure the operator controls, where a mistake can be undone. A post cannot be recalled, so `social_post` asks for approval before it publishes and shows the text verbatim in the request.

## Table of Contents

- [Packages](#packages)
- [What a provider owes the registry](#what-a-provider-owes-the-registry)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`social/`](social/README.md) | Registry that merges targets from any provider and routes a post to the one that owns it | `ctx.social` |
| [`tool-social/`](tool-social/README.md) | Publishes `social_targets` and `social_post`, and enforces approval before publishing | registers on `ctx.tools` |
| [`social-linkedin/`](social-linkedin/README.md) | LinkedIn member posts: text, images, video | registers on `ctx.social` |
| [`social-meta/`](social-meta/README.md) | Facebook Pages and Instagram business accounts, from one Meta app | registers on `ctx.social` |
| [`social-youtube/`](social-youtube/README.md) | YouTube channel uploads | registers on `ctx.social` |

-----

<a id="what-a-provider-owes-the-registry"></a>
## What a provider owes the registry

Two rules the registry enforces rather than trusts, because a target that silently fails to appear is worse than one that refuses loudly:

- A provider's `name` carries no `:`, and **every target id it lists starts with `<name>:`** and has something after it. An id that does not, an id whose `provider` field disagrees, and a duplicate id are dropped from the addressable namespace and reported as one unready diagnostic target.
- `ready` is a live fact about the credential, not a cached one. A provider decides it from what it has stored — an expiry it can read, a scope it can check — and never by making a call that fails.

The third rule is a matter of honesty rather than mechanism. Platforms do things the request did not ask for: YouTube makes a video private when the project is unverified, an image goes out with no alt text, a caption is truncated. A provider reports those in `SocialPostResult.notes`, and the consumer prints them. A tool that says "published" about a post nobody can see is worse than one that says nothing.

-----

<a id="related-documentation"></a>
## Related documentation

- [Capability seams](../../docs/capability-seams.md) — the Service Definition / Provider / Consumer split this group follows.
- [`credentials/`](../credentials/README.md) — where every provider's tokens live. None of them stores a credential of its own, and none puts one in settings.
- [`interaction/`](../interaction/README.md) — the approval seam `social_post` publishes through.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Each provider carries an external limit that is not a bug and cannot be coded around, only surfaced early: LinkedIn's self-serve tier issues 60-day tokens with no refresh; Meta gates `pages_manage_posts` and `instagram_content_publish` behind App Review; YouTube caps uploads by daily quota and restricts unverified projects. Each package's Known Limitations section owns the detail. The shared design rule is that all three report the limit when targets are listed, not when a post fails.

</details>
