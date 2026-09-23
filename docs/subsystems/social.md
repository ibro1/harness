# Social

English | [中文](social.zh.md)

Publishing under the operator's own name, owned by the [social package group](../../packages/social/README.md): a registry merges the targets every mounted provider offers — a LinkedIn member, a Facebook Page, an Instagram business account, a YouTube channel — and routes one post to whichever provider owns the target's id. A model never names a platform; it reads a catalog of targets and publishes to one of them.

This is the only capability in the harness that speaks publicly under a person's name, and a post cannot be recalled. `social_post` therefore asks a human through the [approval seam](approval.md) inside the executing operation — the one code path that reaches `ctx.social.post()` — so no other caller and no listener order arrives at a publication that skipped the ask.

## Ownership

| Owner | Responsibility |
|---|---|
| [social](../../packages/social/social/README.md) | `ctx.social`: the registry, the merged target catalog, and routing a post to the owning provider |
| [social-linkedin](../../packages/social/social-linkedin/README.md) | LinkedIn member posts, its OAuth flow, and its application credentials |
| [social-meta](../../packages/social/social-meta/README.md) | Facebook Pages and Instagram business accounts, and the public media base a Meta upload needs |
| [social-youtube](../../packages/social/social-youtube/README.md) | YouTube channel uploads and the Google OAuth client behind them |
| [tool-social](../../packages/social/tool-social/README.md) | `social_targets` and `social_post`, the approval gate, and the `/social/*` routes the Settings card reads |
| [ui-social](../../packages/client/ui-social/README.md) | The Plugins page: what is connected, what is about to lapse, and the application-credential forms |

## Targets, posts, and credentials

A `SocialTarget` is one place a post can go: an id the model quotes back, a human label, which media the platform accepts there, and whether the credential behind it still works. `ctx.social.targets()` merges every mounted provider's answer; an id is unique across providers, which is what lets `post` route without the caller naming a platform.

Two different things are called a credential here, and the card keeps them apart. The **application** — a client id, a client secret, and a redirect URI — identifies this deployment to the platform and is configuration: it is set once, from the Plugins page or the environment, and is the same for every account. The **account grant** is the token a person's sign-in produces; it is never typed into a form. An account is connected by asking the agent, which walks the provider's authorization flow and stores the grant through the [credentials seam](credentials.md).

A provider that holds a working credential can still explain itself. `SocialTarget.state` separates `ready` from `warning` — the case the card exists for, a token that works today and lapses shortly — and from `blocked`, and the provider's own sentence reaches the reader verbatim, because it names what to do.

## Approval

`postWithoutApproval` exempts target ids one at a time, never as a global switch: turning the ask off for a staging channel cannot silently turn it off for the operator's own page. The approval request shows the whole thing being approved — the target's label, the post text verbatim, and every attachment by filename, kind and size — because an approval that hides its subject is not one.

Sources: [`packages/social/social/src/types.ts`](../../packages/social/social/src/types.ts), [`packages/social/tool-social/src/routes.ts`](../../packages/social/tool-social/src/routes.ts)

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxsocial--socialregistry"></a>

### `ctx.social` — `SocialRegistry`

Registry of social-posting providers and the router in front of them.

`register()` files each provider into the calling context's fiber, so a disposed provider plugin removes its targets from every later listing. Reads re-ask every provider: `ready` is a live fact about a credential, and a cached "ready" would publish under someone's name on the strength of a stale observation.

```ts cordis-catalog
/**
 * Register one borrowed same-process provider. The name must be unique and
 * free of `:` and whitespace, because it is the prefix that makes every
 * target id this provider lists resolve to exactly this registration.
 * @param provider - the platform implementation to register.
 * @returns the exact Cordis effect disposer that unregisters it; disposing
 *   the registering fiber does the same.
 */
register(provider: SocialProvider): () => void

/**
 * Every target across every registered provider, ready or not.
 * @returns the merged targets, ordered by id so the catalog is stable.
 */
async targets(): Promise<readonly SocialTarget[]>

/**
 * Publish one post through the provider owning `request.target`.
 *
 * Every refusal happens here, before the provider is called: an unknown id
 * lists the ids that exist, an unready target carries the provider's own
 * reason, and an attachment or a body the target does not accept fails
 * naming the target rather than surfacing a platform error from inside a
 * provider.
 * @param request - the target id, the text to publish verbatim, and any attachments.
 * @returns what the owning provider created.
 * @throws when the target is unknown, unready, or does not accept what the
 *   request carries.
 */
async post(request: SocialPostRequest): Promise<SocialPostResult>
```

Source: [`packages/social/social/src/index.ts`](../../packages/social/social/src/index.ts)
<!-- END GENERATED cordis-surface -->
