---
description: "Fork-local settings pages on the dsh web client's Plugins page for the Dokploy, Cloudflare and Postgres plugins: the servers, zones, accounts and databases an agent may act on."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-operations

English | [中文](README.zh.md)

## Summary

Open **Plugins** in the sidebar and select **Dokploy**, **Postgres** or **Cloudflare** in the Official group to edit what that plugin may act on: Dokploy servers, Postgres databases, and Cloudflare zones and accounts. Each is one JSON list, checked as it is typed, and written only on save. A page exists while the Host serves its plugin's namespace, so a deployment that leaves a plugin out shows no page for it.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Each field is a JSON array, and each entry supplies its secret one of two ways: the name of an environment variable holding it (`apiKeyEnv`, `apiTokenEnv`, `dsnEnv`), which keeps it out of settings, or the value itself (`apiKey`, `apiToken`, `dsn`), which is stored in settings and shown on the page. An entry with neither is refused as it is typed, since it could never authenticate. A draft that is not a list the plugin accepts disables **Save** and says what is wrong; emptying a field and saving clears it.

- **Dokploy — Servers:** a `name`, a `url`, and a key.
- **Postgres — Databases:** a `name` and a connection string, plus an optional boolean `readOnly` (true unless set to false) and a positive `statementTimeoutMs`.
- **Cloudflare — Zones:** a `name`, a `zoneId`, and a token scoped to that zone.
- **Klipara Scout:** the daily outreach shift's switch, start time and time zone, sample and pitch caps, search topics, channel limits, Klipara API key (shown with all but its kind and last four characters hidden until **Change key**), WhatsApp alert recipient, the shift and fallback models (each chosen from the Host's model catalog with a searchable list, and flagged when a saved model is not in it), the fallback pitch switch and sample-page text, with a **View leads** button opening a separate **Klipara Scout leads** page that lists every lead and refreshes every 15 seconds.
- **SEO employee:** the daily shift's switch, start time, time zone and WhatsApp recipient; the shift, fallback and editor models (chosen from the same model catalog as Klipara Scout); the fallback cooldown, research reuse and answer wait; the Google OAuth client id and write-only secret, with the connection status, the redirect address to register and **Connect Google** / **Disconnect**; and the Keyword Planner's write-only developer token, manager and account ids and API version. **Open SEO sites** opens a separate **SEO sites** page, read from the Host's `/seo/status` every 30 seconds, that pauses and resumes the employee, adds, edits, tests and deletes sites (publisher credentials are write-only), answers the employee's open questions, and lists drafts waiting, published articles with their latest Search Console reading and unpublish link, and the content map.
- **Ads employee:** the ads shift's switch and start time; the monthly spend ceiling, largest daily budget, largest cost per click and largest cost per conversion, as whole numbers in the Google Ads account's currency; and whether new campaigns require conversion tracking. The card names the Ads account from `/seo/status`, which the SEO employee's Google settings choose. **Open Ads proposals** opens a separate **Ads proposals** page, read every 30 seconds, that pauses and resumes all ads, shows each waiting proposal with its full campaign (budget, click ceiling, markets, keywords, negatives, final URL, every headline and description), approves it after a confirmation naming the daily spend and shows the Host's outcome, rejects it, and lists the employee's campaigns and decided proposals.
- **Switch cards:** one card for each deployment plugin that answers `GET /plugin-switch/<id>` (PSD tools, page capture, session outputs, composer uploads, the session-tools and agent-tools routes for agy and opencode, the background-job notifier, the LLM gateway): an on/off switch saved through `POST /plugin-switch/<id>`, whether the plugin can work and why not, the facts it reports, and **Test** when the plugin has a check. The Host half is `@deepseek-ai/dsh-host-plugin-switch`.
- **Cloudflare — Accounts (optional):** a `name`, an account `id`, and a token scoped to the whole account. With one configured, the agent reaches every domain on the account by domain name, so **Zones** need only list domains that should use a narrower token of their own. The token needs DNS Edit and Cache Purge across the account, plus Zone Edit to add domains.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Host half is an empty `apply`, present only so the package holds a Loader row the client module system serves the browser half for. The browser half binds the `dokploy`, `postgres` and `cloudflare` namespaces through `ctx.configForms.get` and keeps each page's staged form in its controller over the shared `SettingsFormModel` of `ui-primitives`. Each field's spec parses the draft as JSON and applies the same entry rules the plugin enforces, so a list the plugin would refuse at its first call is refused here instead. The pages register into the Plugins page's `plugins.item` slot through `ctx.configForms.whileServed`, one watch per namespace.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [ui-plugin-manager](../ui-plugin-manager/README.md) — the Plugins page and the `plugins.item` slot the pages register into.
- [ui-settings](../ui-settings/README.md) — the settings scope and the served-namespace watch the pages ride.
- [ui-primitives](../ui-primitives/README.md) — the settings form model and fields the pages render.
- `dsh-host-dokploy`, `dsh-host-postgres`, `dsh-host-cloudflare` — the plugins that register the namespaces, under `packages/host/`.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side settings surface that registers no model surface.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **One JSON block per field** — entries are edited as JSON text rather than as a form per entry.
- **Inline secrets are visible** — a key, token or connection string entered inline is stored in settings and shown on the page; the environment-variable form keeps it out of both.
- **Runtime invariant:** No companion is published. The pages hold no owned relationship of their own: what they show derives from the settings mirror, and what they write the Host validates.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The pages lived in `ui-settings-plugins` until upstream moved its own official pages into one companion package each; they moved here so that package stays identical to upstream. The Cloudflare page edited a single `account` object after the plugin had moved to an `accounts` list, so an account saved from it never reached the plugin; the move corrected the field.

</details>
