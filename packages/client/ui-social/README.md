---
description: "Social plugin card for Settings → Plugins: what the agent can post to, which credentials are about to lapse, which targets skip the approval gate, and one Disconnect per provider."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-social

## Summary

The browser half of the social capability's human surface: one card in Settings → Plugins that answers two questions without a conversation — **what can this thing post to, and is any of it about to stop working.**

There is no credential field on this card, and that is the design, not an omission. Each provider obtains an OAuth grant through the authorization seam and stores it through the credential seam, so an account is connected by asking the agent to sign in, never by pasting a token into a form. What the card adds is that **state is not configuration**: before it, the only way to learn that a LinkedIn token lapses in four days was to ask the agent to list targets, and that is a fact somebody should be able to see.

The card reads `GET /social/status` and posts to `POST /social/disconnect`, both served by [`dsh-tool-social`](../../social/tool-social/README.md) behind the web server's password gate. This package owns the card and its copy; it holds no store, no service, and no domain type.

## Use this package

Mount it alongside `ui-settings-plugins`. It registers one card into `settings.plugin.item` keyed `social`, and the tab lists a card only while the Host serves a settings namespace of the same name — `tool-social` serves an empty `social` namespace for exactly that reason. Nothing appears if only one half is composed.

### What the card shows

- **One row per target**: the human label, the target id in a muted mono style, and what it accepts (text, images, video, or nothing).
- **Readiness, as the loudest thing on the row.** Three states: `Ready`, `Expiring`, and `Not ready`. `Expiring` is the state the card exists for — a provider reporting `ready: true` *and* a reason is describing a credential that works today and lapses shortly, and rendering that as fine defeats the point.
- **The provider's reason, verbatim.** Those sentences name the record to authorize and the date it lapses; the card never paraphrases, reflows, or truncates one.
- **Disconnect, per provider, behind a confirmation.** The confirmation names the provider, and names the other providers when the host reports that one credential record backs several (Meta's one record authorizes both `facebook` and `instagram`). A provider whose record the host cannot address gets an explanation instead of a button that would refuse.
- **The exempt target ids**, whenever the composition sets `postWithoutApproval`. A target that publishes without asking is the one thing here somebody might not expect, so it is called out rather than left discoverable only by reading a YAML file.
- **An empty state** saying how to connect: ask the agent in chat to sign in.

### States

`loading` → `error` (with Retry) → `empty` (nothing connected) or the target list. Disconnect adds `confirming`, `disconnecting`, and a result line reporting the record that was removed, that there was nothing to remove, or the host's refusal as the host wrote it.

## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`SocialCard.tsx` holds its own state and `fetch`es the two routes directly, following `ui-whatsapp`: this card shows live host state rather than editing a settings blob, so there is no settings scope, no controller, and no client store. While the card is open it re-reads the status every 30 seconds — expiry moves in days, so a fast poll would only add noise. Row classes carry the host's `state` discriminant, and the readiness colour comes from that one field rather than from any arithmetic in the browser: the warning window is the provider's own policy (`reauthWarningDays` on LinkedIn, for instance), and recomputing it here would let the card and the seam disagree.

Every string routes through the typed `social` dictionary in `locales.ts`, with the `zh` key set as the source of truth and `en` checked complete against it.

</details>

## Model Experience

None. This package contributes no tool, no prompt text, and no session event, and nothing it renders reaches a model request. Its token and KV-cache effect is zero. The model-facing half of the same capability is `dsh-tool-social`'s `social_targets` and `social_post`.

## Known Limitations and Deferred Work

- **The card cannot connect an account.** Sign-in is an authorization-seam flow that the agent walks in conversation, and there is no browser entry point to it. The empty state says so; a person with no connected account still has to leave the card to get one.
- **A missing redirect URI is invisible here.** Each provider takes its `redirectUri` as plugin config and only refuses when a sign-in starts, so it never appears in `targets()` and the status route has nothing to report. The card therefore names no redirect-URI environment variable. Surfacing one needs the providers to report their own configuration readiness through the seam.
- **Disconnect depends on the host resolving a credential address.** The social seam publishes no provider-to-record lookup, so a provider whose record cannot be addressed shows an explanation instead of a button — see `tool-social`'s `credentialKeys` config. The card cannot offer to fix that from here, because writing plugin config is not this card's job.
- **No per-target disconnect.** A credential authorizes a provider, not one Page or channel, so the smallest thing this card can remove is a provider's whole grant. Removing one Page would need a provider-level operation the seam does not have.
- **The result line is not a log.** What a disconnect removed is shown until the next action and then gone; there is no durable record of it in the session. A durable "the operator disconnected this account" fact needs a session event of its own.
- **Failures arrive as host prose.** A refusal from `POST /social/disconnect` is rendered as the host wrote it, in English, because it names the records that are stored or the providers that are registered. Only the frame around it is localized.
- **No `./invariant` companion.** This package holds no owned relation that a second observation could diverge from: the card renders exactly what one HTTP read returned.
