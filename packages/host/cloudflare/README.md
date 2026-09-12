---
description: "Cloudflare control: a settings-configured roster of zones and the agent tools that purge cache, manage DNS, and read an edge's cache status."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-cloudflare

## Summary

Closes the edge half of the deploy loop that [dsh-host-dokploy](../dokploy/README.md) opens. A deploy can be correct at the origin and still serve stale bytes for hours, separately per edge location, because the changed assets were cached — an HTML document updates while its images do not, and the only remaining fix is a person opening the Cloudflare dashboard. Five tools reach the model: `cloudflare_zones`, `cloudflare_purge`, `cloudflare_dns_list`, `cloudflare_dns_set`, `cloudflare_cache_status`.

Zones are configured in the `cloudflare` user-settings namespace — added and edited in the settings UI the same way models are, one entry per zone. Each entry is `{ name, zoneId, ... }` plus one of two ways to give its API token: `apiTokenEnv` names an environment variable holding the token (kept out of settings; in a container, add that variable to the compose `environment:` block so it reaches the process), or `apiToken` carries the token inline (simpler, but stored in settings and shown in the card). The settings card accepts either form for the same reason the plugin does. A tool call fails with a message naming what to set when neither resolves.

The tools resolve a zone by its configured name and never take a zone id or token from the model, so a prompt cannot point them at somebody else's zone. When several zones are configured and a tool is called without naming one, it refuses and lists the names rather than guessing — purging the wrong zone costs every visitor of that site a cold cache.

`cloudflare_cache_status` is the exception: it needs no zone and no token, because reading response headers requires no credentials. Its URL comes from the model, so it is the one call that could be aimed at the harness's own network. It accepts `http` and `https` only, resolves the hostname, and refuses any answer in a loopback, private, link-local, CGNAT, multicast, or reserved range; the request it then makes is a `HEAD` with redirects unfollowed.

## Configuration

Composition config, all defaulted:

- `timeoutMs` (15000) — how long one API call may take before it is abandoned.
- `path` (`/cloudflare`) — prefix of the token-guarded MCP command route.
- `token` (empty) — the shared secret that route requires. Empty leaves the route unmounted.
- `apiBase` (`https://api.cloudflare.com/client/v4`) — root of the v4 API, for a deployment that fronts it with an egress proxy.

## Model Experience

- `cloudflare_zones` — the configured zones by name and zone id; tokens are never shown.
- `cloudflare_purge` — drop cached responses for a zone: `urls` for up to 30 absolute URLs, or `everything: true` for a full purge. One of the two is required; an empty `urls` is refused rather than widened into a full purge.
- `cloudflare_dns_list` — a zone's DNS records, optionally narrowed by `type` and exact `name`.
- `cloudflare_dns_set` — upsert one record from `type`, `name`, `content`, and optional `ttl` and `proxied`. The record is looked up by name and type; the reply says whether it was replaced or created.
- `cloudflare_cache_status` — the `cf-cache-status`, `age`, `etag`, `last-modified` and `content-length` of one absolute URL.

Every tool except `cloudflare_cache_status` takes an optional `zone`, needed only when more than one is configured.

## Known Limitations and Deferred Work

- **Cloudflare answers `200` with `success: false`** for many failures, so the HTTP status decides nothing: every response is parsed, `success` is checked, and the `errors[].message` text becomes the tool's failure message.
- **The SSRF check and the request resolve the hostname separately.** A name that answers differently between the two calls can still reach a private address. The unfollowed `HEAD` bounds what that yields to one response's headers; a deployment that needs more should route outbound traffic through a proxy that enforces the same rule.
- **No confirmation gate on a purge or a DNS write.** Both act directly; put the agent behind an approval preset when a cold cache or a DNS change would matter.
- **One record per `cloudflare_dns_set` call**, and a name and type carrying several records is resolved to the first one Cloudflare returns. Round-robin record sets are edited in the dashboard.
