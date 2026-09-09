# Fork state

What this fork is, what runs in production, and what is still open. Written so
that a lost chat session costs minutes rather than an afternoon.

`README.md` next to this file is the runbook — how to deploy, what each
environment variable does, how to recover agy's login. This file is the
opposite: it does not tell you how to operate the deployment, it tells you
**where the work stands**. Update it when a thread opens or closes, not when a
line of code changes.

Last reviewed: 2026-09-09, at `6059bb3585`.

## 1. Repository and branches

`origin` is `github.com/ibro1/harness`, a fork of `deepseek-ai/deepseek-harness`
(`upstream`). Three branches, each with a job:

| Branch | What it is |
| --- | --- |
| `master` | Untouched mirror of upstream. Never commit here — it is what makes GitHub's *Sync fork* a one-click operation. |
| `deploy` | Upstream plus this fork's ~90 commits. **This is what Dokploy builds.** |
| `checkpoint-rc8` | Snapshot of the pre-rebase `0.1.2-rc.8` state, kept for comparison. |

Current base is `dsh-v0.1.2-rc.1`. To take new upstream work: sync `master`,
then rebase `deploy` onto it.

> **Always `pnpm run clean` before building after a large upstream jump.** A
> stale root `.tsbuildinfo` makes `tsc -b` skip regenerating `.d.ts` files, and
> the stale declarations produce convincing `MISSING_EXPORT` errors for symbols
> that were merely renamed. That failure cost an hour once and looked exactly
> like upstream being broken.

Almost all fork-local work lives in `deploy/` and in three client packages
(`packages/client/ui-mobile`, `ui-composer-tools`, `ui-whatsapp`), plus the two
bridge scripts at the repository root. The single upstream file this fork
rewrites is `packages/host/webserver/src/auth.ts`; keeping the blast radius
that small is what makes each rebase cheap.

## 2. Runtime shape

One container, several processes, and only one way in.

```
Traefik ──▶ :3080  socat ──▶ :3081  dsh --profile web   (the harness)
                                     :8001  agy-bridge.mjs      (loopback only)
                                     :8002  opencode-bridge.mjs (loopback only)
                                     :8003  wa-svc               (loopback only)
                                     :3082  GitHub webhook, republished on :3083
```

The harness binds loopback because upstream refuses `--host 0.0.0.0` outright —
it would expose remote code execution to the network. That guard is worth
keeping, so `socat` republishes the port on the container interface instead.
Same exposure, upstream's safety check intact.

Consequences worth holding on to:

- **`DSH_TRUST_PROXY=1` matters.** Every connection arrives from the forwarder,
  so `X-Forwarded-For` is the only true client identity — and it is what keeps
  login rate limiting per-client rather than global.
- **Never give 8001/8002/8003 a Dokploy domain.** They have no authentication
  of their own. `docker-compose.yml` deliberately declares no `ports:` mapping.
- **Sessions are in-memory**, so every redeploy logs everyone out. Expected.

Four named volumes (`dsh-state`, `agy-state`, `opencode-config`,
`opencode-state`) plus two host bind mounts (`/opt/harness/bin` for the agy and
opencode binaries, `/opt/harness/workspace` for agent work). The one that
really matters is `agy-state` → `/home/node/.gemini`, which holds
`antigravity-cli/antigravity-oauth-token`. Lose it and every deploy costs
another browser login through an SSH tunnel — see README §4.

## 3. What is built

`.env.example` is the authoritative list of environment variables; this is the
map of features to the code that implements them.

| Feature | Where it lives | State |
| --- | --- | --- |
| Hardened auth gate | `packages/host/webserver/src/auth.ts` | Live. scrypt digest, `timingSafeEqual`, server-side revoke on logout, session TTL, `Secure` cookie derived from `X-Forwarded-Proto`, 10 failures / 15 min per client, 8 KB body cap, separate bearer token. A malformed digest **fails the boot** rather than silently 400-ing every request. |
| Dokploy deployment | `deploy/Dockerfile`, `deploy/entrypoint.sh`, `docker-compose.yml` | Live on `harness.linkfa.de`. The entrypoint seeds `~/.dsh/settings.yaml` once on a fresh volume, so providers and models exist before first login. |
| agy + opencode providers | `agy-bridge.mjs`, `opencode-bridge.mjs` | Live, at parity. Both expose session id, heartbeat (no idle-timeout retries) and streamed tool progress. |
| Browser control | `packages/host/browser-bridge`, `deploy/browser-extension/`, `deploy/plugins/browser.cordis.yml` | Connection works. See open thread 4.2. |
| DeerFlow remote browser | `deploy/plugins/deerflow-browser.cordis.yml` | Live. Configuration only — the harness's own `@deepseek-ai/dsh-mcp-client` speaks the protocol; nothing hand-rolled. 23 tools as `mcp__deerflow__*`. |
| video-use skill | `deploy/skills/video-use/` | Live, verified in-app. Provider-agnostic transcription (Groq default, Deepgram/AssemblyAI/ElevenLabs available), Gemini TTS, URL download, background render with completion notify. |
| Composer tools | `deploy/plugins/composer-tools.mjs`, `packages/client/ui-composer-tools` | Live. File upload into the *session's own* workspace (path resolved host-side from the session store, never client-supplied), voice prompting via Groq Whisper, output download and preview. |
| Background job notify | `deploy/plugins/bg-notify.mjs` | Live. A finished background job wakes the session instead of blocking it. |
| Mobile layer | `packages/client/ui-mobile` | Live. Off-canvas sidebar, full-screen settings, right-side details drawer, no tooltips on touch. |
| WhatsApp | `deploy/whatsapp-svc/` (Go), `deploy/plugins/whatsapp.mjs`, `deploy/mcp/whatsapp-mcp.mjs`, `packages/client/ui-whatsapp` | Code complete, pairing blocked. See open thread 4.1. |
| GitHub webhook ingress | `deploy/webhook/` | Live. README §"GitHub webhook ingress". |
| Dokploy control plugin | `deploy/plugins/dokploy.cordis.yml`, `deploy/mcp/dokploy-mcp.mjs` | Live. |

WhatsApp send policy, as chosen: the agent drafts and queues; you approve
either in chat (`whatsapp_approve`) or by clicking **Approve** on the settings
card. A per-session take-over (`send_now`) lets the agent send directly once
you have told it to, until you tell it to stop. The card's pending list is the
one hard, visual gate and always shows what is queued.

## 4. Open threads

### 4.1 WhatsApp pairing — blocked outside the code

**Status:** the code is clean and the diagnosis is conclusive. Do not go
looking for a bug here.

Every socket call was traced: `/status` is a pure read, `/login` is idempotent
and guarded, one connection and one QR channel per attempt, and the card's 2 s
poll never touches the socket. Two real defects were found and fixed —
`5d2f8514f8` surfaces the true reason as `pairError` on `GET /whatsapp/status`
(it was previously swallowed by an `Info` log that `WA_LOG=WARN` suppressed,
leaving only a bare socket EOF) and presents as a named CHROME desktop client;
`6059bb3585` clears the dead QR on a terminal failure, so an expired code no
longer lures you into rescanning and deepening the throttle.

The remaining `try again later` is WhatsApp rate-limiting the account after
many manual attempts. Recovery, in order — **each retry re-arms the limit, so
do not test whether it is back**:

1. Leave it alone for one to two hours, ideally overnight.
2. Phone → WhatsApp → Linked Devices. Maximum is four; remove stale entries.
3. Clean slate: delete `/home/node/.dsh/whatsapp/store.db` on the volume and
   restart the container. The sidecar recreates a fresh device identity.
4. Scan **once**, promptly, and leave it. If it fails, read `/whatsapp/status`
   for the named reason before trying again.

A whatsmeow version bump is not the answer — the pin is already at the exact
upstream tip.

### 4.2 The browser extension has never actually driven a page

The bridge connection is solved (`5225ca0f30` — the empty bridge path that
Compose was eating), the tools reach agy and opencode, and the socket holds.
But roughly 2,000 lines of the extension's page-driving code — the snapshot
walker, the click sequence, the React value setter — have never executed once.
Expect a round of fixes the first time a real task runs through it. The
connection was the first gate, not the last.

### 4.3 The build reports no commit

The UI header shows `0.1.2-rc.1-0000000`. The build arg already exists —
`DSH_CLIENT_COMMIT_HASH`, declared in `deploy/Dockerfile` and passed through
`docker-compose.yml`, defaulting to `0000000`. Nothing supplies the real value,
so image staleness is invisible; that already cost one full diagnostic round
trip where the image was suspected and turned out to be current.

### 4.4 `start-harness.sh` is public and stale

It carries the old ngrok hostname. Not a secret, but obsolete and visible.

### 4.5 `DSH_WHATSAPP` is undocumented

The entrypoint reads `DSH_WHATSAPP` (default on) to decide whether to start the
sidecar, but the switch appears in neither `.env.example` nor
`docker-compose.yml`. Anyone wanting to disable WhatsApp has to read the shell.

## 5. Verifying a deployment

These are the checks that actually settled arguments, not hypothetical ones.
Substitute the container name from `docker ps`.

```bash
# What is deployed, and did the optional pieces come up?
docker logs $(docker ps -qf name=harness) 2>&1 | grep -iE "entrypoint|browser|whatsapp|video-use"

# Is a route really mounted? Test inside the container to isolate dsh from
# socat from Traefik: 3081 is dsh itself, 3080 is after the socat hop.
docker exec -it $(docker ps -qf name=harness) sh -lc '
curl -sS -i --http1.1 --max-time 5 \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  "http://127.0.0.1:3081/browser-bridge?token=$DSH_BROWSER_BRIDGE_TOKEN" | head -3'

# Is a secret actually present and the right length? A trailing newline in a
# Dokploy value is invisible in the UI and silently breaks comparisons.
docker exec $(docker ps -qf name=harness) sh -c 'printf %s "$GROQ_API_KEY" | wc -c'
```

Local gates before pushing (the pre-push hook runs the first):

```bash
pnpm run typecheck
node_modules/.bin/tsx scripts/run-oxlint.ts packages/host/webserver
pnpm run build          # after `pnpm run clean` if upstream moved
```

## 6. Traps this deployment has already sprung

Each of these cost real time. They are recorded so they cost none the next
time.

- **Compose expands `$name` inside `.env` values.** The original
  `scrypt$salt$hash` digest format arrived at the container truncated to
  `scrypt`, with no visible cause. `deploy/hash-password.mjs` now emits
  dot-separated digests; the `$` form still parses for compatibility.
- **Compose also defeats `??` in a variable default**, which is how the browser
  bridge ended up mounted at an empty path and every upgrade returned 502.
- **The cordis logger does not reach stdout here.** A missing log line proves
  nothing about whether code ran. Do not diagnose by absence of logging.
- **Reproduce locally before theorising.** The 502 hunt went through three
  wrong theories — package resolution, loader paths, tool scoping — and one
  local boot of the real profile settled it immediately.
- **A stale `.tsbuildinfo` fakes upstream breakage.** See §1.
- **Upstream ships its own auth** (`browser-auth.ts`, rc.1): a per-launch token
  in `?token=`, exchanged once for an HMAC-signed cookie. There is no knob to
  disable it. This fork's password gate runs *in front* of it; both were
  verified to coexist. README §5 covers pulling that token from the logs.

## 7. Related work outside this repository

**Rainmaker** (`/mnt/shared/rainmaker`) — a marketing-automation product, seven
commits, complete create → plan → render → deploy → capture → nurture loop,
seven channel connectors, vendored asset skills and a self-contained
Dockerfile. Its `DEPLOY.md` holds the go-live checklist and the boundaries that
are still open.

It calls the harness's WhatsApp sidecar for messaging, which is the only
coupling between the two. **It has no git remote and has never been pushed** —
it exists on one box only.
