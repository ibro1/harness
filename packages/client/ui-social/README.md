---
description: "Social plugin card for Settings → Plugins: what the agent can post to, which credentials are about to lapse, which targets skip the approval gate, and one Disconnect per provider."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-social

## Summary

The browser half of the social capability's human surface: one card in Settings → Plugins that answers two questions without a conversation — **what can this thing post to, and is any of it about to stop working** — and carries the forms for the platform applications it posts through.

Two different things get called credentials here, and the card keeps them apart. The **account** credential is the token a post is published as; there is no field for it, and that is the design. Each provider obtains it through the authorization seam and stores it through the credential seam, so an account is connected by asking the agent to sign in, never by pasting a token into a form. The **application** credentials — a LinkedIn client id, a Meta app id, a Google OAuth client — identify the operator's own app and are ordinary configuration; before these forms they could only be set in the deployment's environment, which made correcting a pasted value a redeploy.

The other thing the card adds is that **state is not configuration**: before it, the only way to learn that a LinkedIn token lapses in four days was to ask the agent to list targets, and that is a fact somebody should be able to see.

The card reads `GET /social/status` and posts to `POST /social/disconnect`, both served by [`dsh-tool-social`](../../social/tool-social/README.md) behind the web server's password gate. The application forms read and write each provider's own settings namespace through `ctx.settingsScope`, and write secrets through the credentials domain.

## Use this package

Mount it alongside `ui-settings-plugins`. It registers one card into `settings.plugin.item` keyed `social`, and the tab lists a card only while the Host serves a settings namespace of the same name — `tool-social` serves an empty `social` namespace for exactly that reason. Nothing appears if only one half is composed.

### What the card shows

- **One row per target**: the human label, the target id in a muted mono style, and what it accepts (text, images, video, or nothing).
- **Readiness, as the loudest thing on the row.** Three states: `Ready`, `Expiring`, and `Not ready`. `Expiring` is the state the card exists for — a provider reporting `ready: true` *and* a reason is describing a credential that works today and lapses shortly, and rendering that as fine defeats the point.
- **The provider's reason, verbatim.** Those sentences name the record to authorize and the date it lapses; the card never paraphrases, reflows, or truncates one.
- **Disconnect, per provider, behind a confirmation.** The confirmation names the provider, and names the other providers when the host reports that one credential record backs several (Meta's one record authorizes both `facebook` and `instagram`). A provider whose record the host cannot address gets an explanation instead of a button that would refuse.
- **The exempt target ids**, whenever the composition sets `postWithoutApproval`. A target that publishes without asking is the one thing here somebody might not expect, so it is called out rather than left discoverable only by reading a YAML file.
- **An empty state** saying how to connect: ask the agent in chat to sign in.
- **One application block per platform**, with the public id, the redirect URI, the name the secret is stored under, and a write-only box for the secret. Meta's block also carries the public media base URL Instagram needs. A block whose provider this deployment does not compose is not rendered at all, and the section disappears entirely when none is — an empty form for a plugin that is not there is worse than no form.

The application blocks render in every state, including `error` and `empty`. A deployment with nothing connected usually has nothing connected *because* these were never set, and a failed status read is no reason to hide the one thing on the card a person can act on.

### States

`loading` → `error` (with Retry) → `empty` (nothing connected) or the target list. Disconnect adds `confirming`, `disconnecting`, and a result line reporting the record that was removed, that there was nothing to remove, or the host's refusal as the host wrote it.

## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`SocialCard.tsx` holds its own state and `fetch`es the two routes directly, following `ui-whatsapp`: the status half shows live host state rather than editing a settings blob.

The application half is the opposite kind of thing and uses the opposite machinery: `app-credentials-controller.ts` builds one `CardForm` per provider namespace, re-exported from `ui-settings-plugins` so this card stages and saves exactly as the shipped plugin cards do rather than inventing a second answer to what Save means. The **secret** is not a section field at all — a secret written into a settings document rides every read of that section back to the browser and sits in the form. Each section names the environment variable or credential record instead, and the secret is written through `ctx.remote.credentials.set`, which reports only whether one is configured and never hands one back. That is the split the web-search card uses for its API key.

`APP_CREDENTIAL_SPECS` names the three namespaces statically, as `ui-settings-plugins` names its seven cards: a fourth provider joins by adding an entry. While the card is open it re-reads the status every 30 seconds — expiry moves in days, so a fast poll would only add noise. Row classes carry the host's `state` discriminant, and the readiness colour comes from that one field rather than from any arithmetic in the browser: the warning window is the provider's own policy (`reauthWarningDays` on LinkedIn, for instance), and recomputing it here would let the card and the seam disagree.

Every string routes through the typed `social` dictionary in `locales.ts`, with the `zh` key set as the source of truth and `en` checked complete against it.

</details>

## Model Experience

None. This package contributes no tool, no prompt text, and no session event, and nothing it renders reaches a model request. Its token and KV-cache effect is zero. The model-facing half of the same capability is `dsh-tool-social`'s `social_targets` and `social_post`.

## Known Limitations and Deferred Work

- **The card cannot connect an account.** Sign-in is an authorization-seam flow that the agent walks in conversation, and there is no browser entry point to it. The empty state says so; a person with no connected account still has to leave the card to get one.
- **A missing or wrong redirect URI is editable here but not diagnosable here.** The field is on the card, and saving it takes effect without a redeploy. What the card cannot say is whether the value matches what the platform has registered: a provider only refuses when a sign-in starts, so a mismatch never appears in `targets()` and the status route has nothing to report. Reporting it needs the providers to publish their own configuration readiness through the seam.
- **The application blocks do not say whether a value works.** They report what is stored — set here, inherited, secret configured or not — and no block ever shows `ready`. Proving an application id and secret go together means starting a sign-in, which is a conversation with the agent rather than a button here.
- **A provider composed with no settings service loses its block, silently.** The block renders only while its namespace is served, and a deployment mounting the providers without a settings service gets no application forms and no line saying why. That deployment can still set everything through the environment, which is why it is a limitation rather than a defect.
- **Disconnect depends on the host resolving a credential address.** The social seam publishes no provider-to-record lookup, so a provider whose record cannot be addressed shows an explanation instead of a button — see `tool-social`'s `credentialKeys` config. The card cannot offer to fix that from here, because writing plugin config is not this card's job.
- **No per-target disconnect.** A credential authorizes a provider, not one Page or channel, so the smallest thing this card can remove is a provider's whole grant. Removing one Page would need a provider-level operation the seam does not have.
- **The result line is not a log.** What a disconnect removed is shown until the next action and then gone; there is no durable record of it in the session. A durable "the operator disconnected this account" fact needs a session event of its own.
- **Failures arrive as host prose.** A refusal from `POST /social/disconnect` is rendered as the host wrote it, in English, because it names the records that are stored or the providers that are registered. Only the frame around it is localized.
- **No `./invariant` companion.** This package holds no owned relation that a second observation could diverge from: the card renders exactly what one HTTP read returned.
