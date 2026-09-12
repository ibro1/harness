---
description: "Social-posting provider registry: one addressable target namespace across every platform provider, and the router that refuses rather than guesses."
kind: "package-reference"
---

# @deepseek-ai/dsh-social

## Summary

The Service Definition role of the social capability seam. It registers `ctx.social`, keeps the provider roster, merges every provider's targets into one namespace the model can address, and routes a post to the provider that owns the requested target id. Platform providers (LinkedIn, Meta, Google) supply the targets and do the publishing; `@deepseek-ai/dsh-tool-social` is the Consumer that puts the capability in front of a model behind human approval.

Nothing in this package names a platform. There is no provider-specific field and no per-platform branch; a provider speaks through a target id, the three `accepts` flags, and the `ready`/`reason` pair, and that is the whole vocabulary. A per-platform condition appearing here means the seam is in the wrong place.

### One id, one provider

A provider name is unique in the registry and contains no `:`. Every target id a provider lists must start with `<name>:` and carry something after it. Two providers therefore cannot claim one id, and a bare id resolves to exactly one registration. The registry enforces the rule on every listing instead of trusting providers to follow it: a target with the wrong prefix, a target whose `provider` field does not match the registration, and a target id listed twice are all dropped from the addressable namespace and reported as one unready diagnostic entry under the provider's bare name.

### Refuse, never guess

`post()` resolves every refusal before a provider is called:

- **Unknown target** — refuses and lists the ids that exist (or says no provider is registered).
- **Unready target** — refuses with the provider's own `reason`, rather than attempting the call and surfacing a platform error.
- **Unaccepted content** — a body sent to a target that takes no text, or an attachment of a kind the target does not accept, fails here, naming the target and the attachment.
- **Empty post** — a request with neither text nor media refuses.

A provider that throws while listing targets does not remove the others from the listing: it contributes one unready target whose `reason` carries the error, so the fault is visible in the catalog beside the working targets.

Reads are never cached. `ready` is a live fact about a credential, and a cached "ready" would publish under a person's name on the strength of a stale observation.

## Model Experience

No model-visible surface of its own: this package registers no tool, contributes no prompt text, and consumes no tokens. `@deepseek-ai/dsh-tool-social` owns everything the model sees. The refusal messages raised here do reach the model, through that Consumer's tool results.

## Known Limitations and Deferred Work

- **Listing fans out on every read, including every post.** `targets()` and `post()` both ask every registered provider. With several providers doing network round-trips, a post pays the whole fan-out before it publishes. A freshness window is not the fix on its own — a cached `ready` is the one value that must not go stale — so any future caching has to keep the pre-publish check live.
- **No change notification.** Consumers that want a fresh catalog re-read it; there is no `social/change` event, because no current consumer holds a derived catalog across turns. Add one with the consumer that needs it.
- **`accepts` is three booleans.** It says a target takes images; it does not say how many, how large, or in what format. A provider still refuses at publish time for a limit this registry cannot express, and that refusal reaches the model as a platform error rather than a pre-dispatch refusal.
- **No scope layering.** Unlike `ctx.skills` and `ctx.tools`, the roster is flat and global: a provider registered by an agent preset is visible to every agent. Per-agent accounts need the layered shape those registries use.
- **No `./invariant` companion.** The registry is the only observer of its own roster; there is no independent observation of the provider set that could diverge from it, so there is nothing for an invariant to check.
