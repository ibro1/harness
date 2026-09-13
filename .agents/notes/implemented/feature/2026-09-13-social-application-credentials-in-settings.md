# Agent Note: Application credentials belong in the card; the secret does not

Status: implemented

English | [中文](2026-09-13-social-application-credentials-in-settings.zh.md)

## Problem

The social providers could only be told which application to sign in with through the deployment's environment. Correcting a pasted client id meant editing the environment and redeploying, and nothing in the product said where the value went. The operator asked the obvious question: why is there no UI for this?

There was no principled answer. The rationale in the code — *"a secret in settings would be a secret in a configuration UI"* — is sound for a secret, and the three providers had generalised it to every application value. Meanwhile the harness does not hold that line anywhere else: `cloudflare` accepts an `apiToken` outright and documents the trade in its own schema description, and `social-youtube` already accepted a `clientId` and `clientSecret` inline. Of the three social providers only LinkedIn and Meta were reference-only, and the three had been written in parallel, which is the actual explanation.

An argument that would have settled it — that the agent can edit settings but not the environment — does not hold either: no tool writes settings.

## Decision

Split the word "credential", and treat the two halves differently.

**Application credentials** — a client id, an app id, a redirect URI, Instagram's public media base — are configuration. Each provider now serves a settings namespace named after itself (`social-linkedin`, `social-meta`, `social-youtube`), and the social card carries a form per application.

**The account credential** — the token a post is published as — remains untouched: obtained through the authorization seam, stored through the credential seam, never in a form.

**The application secret sits between them and follows neither.** It is not a settings field. A secret written into a settings section rides every read of that section back to the browser and sits in the form; instead each section names the environment variable or credential record holding it, and the card writes the secret through the credentials domain, which reports only whether one is configured and never hands one back. `SecretField` and `CardSecretSpec` already existed for exactly this — the web-search card's API key — so the card reuses them rather than inventing a second answer.

Precedence is fixed once, in `resolveAppCredential` in the registry package: settings, then composition config, then the named environment variable, with blank treated as absent at every layer. Settings wins because it is the layer a person can change without a redeploy, and a value typed into a form and then ignored is worse than one that was never offered.

### What this forced

Meta captured `redirectUri` and `publicMediaBaseUrl` at `apply`. Made lazy, because a Save that needs a restart to take effect is a Save that lies.

`ctx.inject(['settings'], …)` rather than `ctx.get('settings')`, for the reason the [settings-namespace note](2026-09-13-social-settings-namespace-await.md) records: the service resolves after a plugin composed alongside it applies. `settings` stays out of `inject` — a composition without it keeps the tools and loses only the forms.

The form machinery (`CardForm`, `textField`, `ValueField`, `SecretField`) is now exported from `ui-settings-plugins`. `PluginCard` deliberately is not: its props are locale keys of that package's own dictionary, so a foreign card cannot title itself through it.

`tsconfig.base.json` gained ten hand-written path aliases. `gen-tsconfig-paths` cannot derive an alias for a package whose npm name carries a `client-`/`host-` prefix its directory does not, so it had been failing since those packages landed — and with no alias, a runtime import of one resolves through `node_modules` to its built `lib/`. The social packages' first runtime cross-package import is what exposed it: the test was exercising a stale bundle.

## Alternatives considered

**One `social` namespace holding every provider's credentials.** One card, one namespace, no `settingsScope.bind` per provider. Rejected because `tool-social` would then own provider-specific fields, and a fourth provider could not add its own without editing the consumer.

**Put the secret in settings, as `cloudflare` does for its token.** The shortest change, and the one the precedent argues for. Rejected because the machinery for doing better already exists and costs one extra field: the write-only control is strictly better than a secret rendered back into a form, and matching a weaker precedent is not a reason to reproduce it.

**Discover the blocks from `/social/status` instead of naming them statically.** Would let a provider join the card without touching it, but binding a settings scope per provider at render time fights the slot architecture, which builds injected faces at registration. `ui-settings-plugins` names its seven cards statically; this names three.

## Consequences

- Application credentials are set and corrected in the browser, and take effect on the next operation rather than the next deploy. `DSH_SOCIAL=1` stays environment-only: it decides whether there is a card at all.
- A secret can be replaced but never read. The box is blank even when one is set, and blank means "keep what you have" — which has to be said in the copy, because a blank box otherwise reads as "not set".
- The forms report what is *stored*, never that a value *works*. Proving an id and secret go together requires starting a sign-in.
- A deployment that mounts the providers without a settings service gets no forms and no line saying why. It can still use the environment, which is why this is a documented limitation rather than a defect.
