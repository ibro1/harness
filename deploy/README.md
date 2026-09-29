# Deploying the harness on Dokploy

One container runs four processes: the harness web server on loopback 3081,
the two OpenAI-protocol bridges on loopback 8001 (`agy`) and 8002 (`opencode`),
and a socat forwarder republishing 3081 on the container interface as 3080.
Only 3080 is published, and only through Traefik.

The forwarder exists because upstream refuses `--host 0.0.0.0` by design — it
would expose remote code execution to the network. Keeping the harness on
loopback preserves that guard: what reaches the container interface is a port
that Traefik alone can route to, behind the password gate.

## 1. Host preparation

Do this after the first deploy, once the container exists. Both binaries are
~200 MB and not in the image; each ships an official installer, so they are
fetched in place rather than copied around.

Docker creates the bind-mounted `/opt/harness/bin` owned by root, and the
container runs as uid 1000, so grant it first — on the Dokploy host:

```sh
mkdir -p /opt/harness/bin /opt/harness/workspace
chown 1000:1000 /opt/harness/bin /opt/harness/workspace
```

Then install both inside the container and move them onto the bind mount.
Their installers target `$HOME`, which is not a volume — left there they are
lost on the next deploy:

```sh
C=$(docker ps -qf name=harness)
docker exec -it $C bash -lc 'curl -fsSL https://antigravity.google/cli/install.sh | bash'
docker exec -it $C bash -lc 'curl -fsSL https://opencode.ai/install | bash'
docker exec -it $C bash -lc 'mv ~/.local/bin/agy ~/.opencode/bin/opencode /opt/harness/bin/ && chmod 755 /opt/harness/bin/*'
docker exec $C bash -lc 'ls -l /opt/harness/bin'
```

No restart is needed: the bridges spawn `agy` and `opencode` per request, so a
binary appearing on PATH is picked up immediately.

`/opt/harness/workspace` is where agents will work. Anything you put there is
reachable by the agent, so keep unrelated repos and credentials out of it.

### Letting agents use git

Without a credential an agent can edit files it creates but cannot clone, pull
or push. There are two ways in; the first needs no secret in the environment.

**SSH key (preferred).** The container generates an ed25519 identity onto the
state volume on first boot and keeps it across deploys. Sign in and open
`/auth/git-key` to copy the public half, then add it on your forge as a **deploy
key** for one repository, or an **account key** for every repository. Clone with
the SSH form (`git@github.com:owner/repo.git`). Revoke by deleting the key on
the forge — nothing here changes. The private half never leaves the volume, and
the boot log prints the public half too.

**Token.** Set `GIT_TOKEN` to a fine-grained token and the entrypoint writes a
`credential.helper store` entry for `GIT_HOST` (default `github.com`) on every
boot. Simpler for HTTPS remotes, but the token sits in the deployment
environment, and an agent with shell access in this container can read it —
scope it to the repositories this harness should touch, never your whole
account.

## 2. Credentials

Set `DSH_AUTH_PASSWORD` to the password you want. That is all most deployments
need. Avoid `$` in it — Compose expands `$name` inside a `.env` value and would
eat part of the password.

If you would rather the plaintext never sat in Dokploy's database and backups,
leave `DSH_AUTH_PASSWORD` empty and set a digest instead:

```sh
node deploy/hash-password.mjs
# -> scrypt.<salt>.<hash>
```

Paste that whole line as `DSH_AUTH_PASSWORD_HASH`. Set one or the other, never
both. A malformed digest — the example's placeholder, or one truncated to
`scrypt` by `.env` expansion — fails the boot on purpose, rather than coming up
healthy and answering 400 to everything.

Optional API token for scripts:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

## 3. Dokploy application

Create a **Docker Compose** application pointing at this repository, compose
path `docker-compose.yml`. Fill Environment from `deploy/.env.example`, at
minimum `DSH_PUBLIC_HOST` and `DSH_AUTH_PASSWORD_HASH`.

Point the domain's DNS at the host before deploying, or Let's Encrypt will fail
its challenge. Confirm your Dokploy Traefik uses `letsencrypt` as its cert
resolver name; change the label in `docker-compose.yml` if it does not.

Deploy. First build is slow (full `pnpm install` + `pnpm run build`).

## 4. agy authentication

The harness never sees agy's identity. agy authenticates to Google on its own
and keeps the result in `~/.gemini/antigravity-cli/antigravity-oauth-token`,
which the `agy-state` volume preserves across redeploys. The access token
expires hourly and refreshes itself; you only redo this if the volume is wiped
or Google revokes the grant.

Sign in on the host, then hand the container the result. Signing in *inside*
the container does not work: agy's OAuth redirect binds a loopback port in the
container's own network namespace, which an `ssh -L` tunnel to the host cannot
reach.

```sh
# on the Dokploy host
curl -fsSL https://antigravity.google/cli/install.sh | bash
~/.local/bin/agy
```

It prints a sign-in URL containing `localhost:<PORT>`. From the machine with
the browser, open a second session forwarding that exact port, then follow the
URL there:

```sh
ssh -L <PORT>:localhost:<PORT> root@dokploy-host
```

Once it completes, copy the token in. `docker cp` writes as root, so fix the
ownership after:

```sh
C=$(docker ps -qf name=harness)
docker cp /root/.gemini/antigravity-cli/antigravity-oauth-token \
  $C:/home/node/.gemini/antigravity-cli/antigravity-oauth-token
docker exec -u root $C chown node:node /home/node/.gemini/antigravity-cli/antigravity-oauth-token
docker exec -u root $C chmod 600 /home/node/.gemini/antigravity-cli/antigravity-oauth-token
docker exec $C agy models
```

`agy models` listing the catalogue is the confirmation; before sign-in it
answers `Please sign in to view available models`.

**This is one shared identity.** Everyone who logs into the harness uses your
Antigravity account and its quota, with no per-user attribution. The same is
true of opencode.

## 5. Two auth layers

Upstream added its own browser gate in 0.1.2-rc.1: a per-launch token exchanged
once for a signed 30-day cookie. It has no configuration to disable it, so this
fork clears it as part of signing in — the password gate's success redirect
carries the launch token, and one form submission satisfies both gates.

Nothing manual is needed. If you ever do land on the plain-text page reading
`dsh web authentication required`, that wiring is not in place: the
web-app bundle registers the target through `webServer.registerSignedInTarget`,
and it is the first thing to check.

After a redeploy you re-enter the password (sessions are in memory) and the
redirect re-issues the browser cookie against the new launch token.

## 6. Verify

```sh
curl -sI https://harness.example.com/            # 302 -> /auth/login
curl -sI https://harness.example.com/api/x       # 401
```

A `401` with `dsh web authentication required` after signing in means step 2 of
section 5 is still outstanding, not that the password gate failed.

Sign in, open Settings, and confirm the `agy` and `opencode` providers list
their models — that round-trips through the bridges to the binaries. On a
volume that has never booted, the entrypoint seeds `~/.dsh/settings.yaml` from
`deploy/settings.seed.yaml`, so the providers are registered before you ever
open the UI. The harness imports that file into the profile
(`~/.dsh/profiles/web/cordis.patch.yml`) once and renames it to
`settings.yaml.imported`; the entrypoint never seeds again once either of those
exists, so edits made in the UI stand.

## GitHub webhook ingress

A comment beginning with `/dsh` on an allowed repository starts a session in
that repository's checkout, with the rest of the comment as the prompt.

Enable it by setting `DSH_GITHUB_WEBHOOK_SECRET` and `DSH_GITHUB_REPOSITORIES`;
with no secret the endpoint does not exist. Then in each repository's Settings
&rarr; Webhooks:

- Payload URL `https://<your domain>/github`
- Content type `application/json`
- Secret: the same value as `DSH_GITHUB_WEBHOOK_SECRET`
- Events: **Issue comments** only

Clone each repository into the workspace under its own name first, using the
SSH key from `/auth/git-key`, or the run has nowhere to work:

```sh
cd /opt/harness/workspace && git clone git@github.com:ibro1/harness.git harness
```

### What stops anyone from running commands on your server

A comment body is written by whoever can comment, which on a public repository
is anyone at all. Three fences, and every one must pass:

1. The adapter verifies GitHub's HMAC signature and answers `401` without it.
2. The repository must be in `DSH_GITHUB_REPOSITORIES`.
3. The commenter's `author_association` must be in
   `DSH_GITHUB_ALLOWED_ASSOCIATIONS` — `OWNER`, `MEMBER` and `COLLABORATOR` by
   default. Never add `NONE` or `FIRST_TIME_CONTRIBUTOR`.

A signed delivery that fails fence 2 or 3 is acknowledged with `202` and
produces nothing, because a webhook endpoint that answered differently would
tell an attacker which repositories and roles it accepts. The comment text
reaches the agent quoted, and the event metadata is labelled untrusted, so a
comment cannot pose as an instruction about the agent's own rules.

The default `DSH_GITHUB_PERMISSION_PRESET` is `read-only`: runs can read and
report but not change the checkout. Raising it to `workspace-write` means a
comment from a collaborator can modify files and, with git credentials
configured, push them.

The endpoint runs on its own web server in an isolated realm — the only server
here with `authenticate: false`, since GitHub has no password to present. That
realm carries the webhook route and nothing else, so it cannot reach the UI's
`/api` surface.

## Accounts and sessions

One account comes from the environment (`DSH_AUTH_USER` with a password or
digest). For more than one person, add accounts to `users.json` on the state
volume, which supersedes the environment account entirely:

```sh
C=$(docker ps -qf name=harness)
docker exec -it $C node /app/deploy/user.mjs add jane jane@example.com
docker exec -it $C node /app/deploy/user.mjs list
docker restart $C
```

`passwd` changes a password and `remove` deletes an account; the file stores
scrypt digests only. Removing the last account is refused, because the file
would silently fall back to the environment account.

Sessions live in `.sessions.json` on the same volume, so a redeploy no longer
signs anyone out. `/auth/sessions` lists the signed-in account's own sessions
with when each began and expires, revokes any one of them, or signs out every
other browser. An account can only see and revoke its own.

**What per-account does not buy you.** Everyone shares one agy identity and its
quota, one git credential, and one filesystem — the harness runs every agent as
the same OS user, and upstream's sessions have no owner, so nothing carries
"this belongs to Jane" from the web request into tool execution. Accounts give
you separate logins, separate revocation, and a name against each session. They
do not isolate what a signed-in person can reach.

## Browser control

An agent can drive your browser: read the page, click, type, scroll. The
harness holds one WebSocket that a Chrome extension dials into, so the browser
does not need to be reachable from the server.

Enable it by setting `DSH_BROWSER_BRIDGE_TOKEN`; with no token the endpoint
does not exist. Then load the extension from `deploy/browser-extension/` in
Chrome (`chrome://extensions` → Developer mode → Load unpacked) and set the
bridge URL and the same token in its options.

The bridge authenticates its own caller, because a browser cannot set request
headers on a WebSocket: the token rides the upgrade URL, is compared in
constant time, and a wrong or missing token gets the socket destroyed with no
response. That is why its route opts out of the password gate — it is the one
route in this deployment that does.

**Run it against a dedicated Chrome profile.** The agent acts in whatever
browser holds that extension, with your sessions and cookies. In your daily
profile that reaches every tab you are signed into; in a profile that only
knows your test app, the blast radius is the test app.

## DeerFlow remote browser (MCP)

A second, unrelated way to give an agent a browser: attach an external
[DeerFlow](https://deer.linkfa.de) headless browser as an MCP tool server.
Unlike the extension bridge above — which drives *your* Chrome — this drives a
remote headless browser the operator runs elsewhere. Its 23 tools attach
through the harness's own MCP client (`@deepseek-ai/dsh-mcp-client`) and appear
to the model as `mcp__deerflow__browser_navigate`, `…_get_markdown`, and so on,
discovered at startup.

Enable it by setting **`DEERFLOW_BROWSER_MCP_TOKEN`** (operator-supplied, never
committed) in the Dokploy environment; with no token the tools do not attach.
Override the endpoint with `DEERFLOW_BROWSER_MCP_URL` (default
`https://deer.linkfa.de/mcp/browser`). The config lives in
`deploy/plugins/deerflow-browser.cordis.yml`.

**Two provider paths, because the CLIs drop native tools.** A direct-provider
model sees the tools as `mcp__deerflow__*` through the native registration
above. The agy and opencode CLIs run their own agent loop and ignore the
harness's tools, so — exactly like the browser bridge — the entrypoint also
registers DeerFlow *with them*: agy via `agy mcp add --header … deerflow <url>`,
opencode via a `type: remote` entry in `opencode.jsonc`
(`deploy/mcp/register-opencode-remote.mjs`). Reached that way the tools are
named `deerflow_browser_navigate`, etc. Set `DEERFLOW_BROWSER_MCP=0` to withhold
them from the CLIs; direct providers keep the native tools regardless. As with
the browser bridge, agy is run with `--dangerously-skip-permissions` while these
tools are enabled (headless agy otherwise auto-denies MCP calls) — which also
admits agy's own file and shell tools inside the container.

**It cannot hang the agent.** DeerFlow's CDP link can wedge (observed after
~8 days' uptime): `initialize` and `tools/list` keep answering while every tool
call blocks forever. Each call carries a 45s timeout, so a wedged browser
produces a clear tool error, not a hang — and the client logs it at warn
(`mcp-client(deerflow): <tool> → failed in <ms>ms`); successful calls log at
info. Recovery is operator-side: restart **both** the DeerFlow browser and its
MCP server — restarting the MCP server alone does not clear it.

**Logged-in sessions do not survive a DeerFlow restart on their own.** The
browser runs a dedicated profile; a YouTube (or any) login persists across
container restarts only if DeerFlow's *own* deployment mounts its Chrome
profile directory on a persistent volume. That is a property of DeerFlow, not
of this plugin — the harness drives the browser but cannot make it persist its
profile.

## video-use skill (conversation-driven video editing)

The image bakes in [video-use](https://github.com/browser-use/video-use) — an
agent skill for editing footage by conversation (transcribe, cut, grade, burn
subtitles, overlay animations). It ships in the image (repo at `/opt/video-use`,
`ffmpeg` and its Python deps installed) because the container FS is ephemeral
and uid 1000 cannot install packages at runtime; the entrypoint symlinks it into
`~/.dsh/skills/video-use` (on the state volume) so the harness skill catalog
discovers it. An agent loads it like any other skill and follows `SKILL.md`;
outputs land in `<footage>/edit/`, never in the skill directory.

**Transcription is provider-agnostic** (a fork-local overlay of `transcribe.py`,
kept in `deploy/skills/video-use/`). Set at least one key in the environment:

| Key | Backend | Diarization | Notes |
|---|---|---|---|
| `DEEPGRAM_API_KEY` | Deepgram nova-2 | yes | Word timestamps + speakers + fillers; generous free credit |
| `ASSEMBLYAI_API_KEY` | AssemblyAI | yes | Word timestamps + speakers + disfluencies |
| `ELEVENLABS_API_KEY` | ElevenLabs Scribe | yes | Word timestamps + speakers + audio-event/filler tags |
| `GROQ_API_KEY` | Groq Whisper | no | Free, generous; single speaker |
| `OPENAI_API_KEY` | OpenAI Whisper | no | Single speaker |

It auto-selects diarizing providers first —
deepgram → assemblyai → elevenlabs → groq → openai — or force one with
`TRANSCRIBE_PROVIDER`. Every backend is normalized to the same transcript JSON
the skill reads (word/spacing entries, per-word `speaker_id`), so the pipeline
is unchanged. Only the diarizing providers label speakers; Whisper is fine for
single-speaker footage. Whisper uploads are capped near 25MB (~70 min of mono
audio); use a diarizing provider for long single files (they take the lossless
wav and handle large uploads).

To use it: set a key, redeploy, then in a session point the agent at a folder of
footage ("edit these into a launch video"). Nothing is transcribed until you
ask — transcription spends API credits.

## Social posting (LinkedIn, Facebook Pages, Instagram, YouTube)

Posting as you, to accounts you own. Off unless `DSH_SOCIAL=1`: it is the one
capability in the harness that speaks publicly under your name, and a post
cannot be recalled. Even enabled, every post asks you first — the request shows
the target, the full text verbatim, and each attachment — so the switch is belt
and braces on top of a gate that already stops.

The entrypoint prints one line when it mounts, directly above the session-outputs
line. **If that line is absent, the plugin is not loaded**, whatever the
Environment tab says — every variable has to be passed through in
`docker-compose.yml` as well, and one that is not reaches nothing:

```
[entrypoint] Social posting enabled (social_targets, social_post); connect accounts by asking the agent to sign in
```

### Two different things get called credentials

| | What it is | Where it goes |
|---|---|---|
| **Application** credentials — a client id, an app id, a secret, a redirect URI | Identifies *your registered app* to the platform. Set once. | Plugins → Social accounts, or the environment below |
| **Account** credential — the access token | Identifies *you*, and is what a post is published as | Obtained by the sign-in flow, kept in the credential store. **Never typed anywhere.** |

Only the first kind is configuration. The rest of this section is about it.

### Setting the application credentials

The card is the shorter road: open Plugins → Social accounts, fill in the
application block for each platform, and press Save. Nothing needs a redeploy,
and a mistyped value is corrected in place.

`DSH_SOCIAL=1` is still an environment variable and still required — it decides
whether the plugin is mounted at all, which has to be settled before there is a
card to open.

The environment remains available for everything else, and is the better choice
when a deployment is built from a script rather than clicked. A value typed into
the card wins over the same value in the environment; an empty field falls back
to it.

| Variable | Value |
|---|---|
| `DSH_SOCIAL` | `1` — required, and only settable here |
| `SOCIAL_LINKEDIN_REDIRECT_URI` | e.g. `https://<host>/social/callback/linkedin` |
| `SOCIAL_META_REDIRECT_URI` | e.g. `https://<host>/social/callback/meta` |
| `SOCIAL_YOUTUBE_REDIRECT_URI` | e.g. `https://<host>/social/callback/youtube` |
| `LINKEDIN_CLIENT_ID` / `LINKEDIN_CLIENT_SECRET` | LinkedIn app → Auth |
| `META_APP_ID` / `META_APP_SECRET` | Meta app → Settings → Basic |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google Cloud → Credentials, type Web application |
| `SOCIAL_META_PUBLIC_MEDIA_BASE_URL` | optional; see Instagram below |

**No user token is ever set here.** Access and refresh tokens are obtained by
the sign-in flow and kept in the credential store, never in settings and never
in this file.

**A secret is never stored in settings either.** The card writes a secret to the
credential store and does not read it back, which is why its box stays blank
even once one is set and why leaving it blank keeps the secret you already have.
What the settings document holds is the *name* the secret is kept under — the
`…_SECRET` variable above by default.

### Where the card's values are written

Both files live under `/home/node/.dsh`, which `docker-compose.yml` mounts as
the named volume `dsh-state`. **They survive a redeploy**; they do not survive
deleting that volume.

| What | File |
|---|---|
| Client ids, app ids, redirect URIs, media base | `/home/node/.dsh/profiles/web/cordis.patch.yml` |
| Secrets written from the card | `/home/node/.dsh/.credentials.yaml` |
| Account tokens from a sign-in | `/home/node/.dsh/.credentials.yaml` |

**One trap worth knowing.** For a *secret*, the inherited process environment
outranks that credential store — deliberately, so that launching the harness
with a variable set is never silently overridden by something stored earlier.
The consequence here is that **while `LINKEDIN_CLIENT_SECRET` (or either of the
others) is set in the Dokploy environment, the card cannot change that secret.**
The card does not pretend otherwise: it disables the box and names the variable
that is shadowing it. To edit a secret from the card, remove the variable from
the deployment environment first.

This applies to secrets only. A client id or redirect URI typed into the card
wins over the environment, because those resolve settings-first.

Each redirect URI must be registered byte-for-byte with the app it belongs to.
After consent the browser lands on a page that does not exist, which is
expected: the address bar carries the code, and you paste that back to the
agent.

### Connecting an account

Ask the agent — "connect my LinkedIn account". It returns the consent URL, you
sign in, you paste the redirected address back. Plugins → Social accounts then
shows what each account can post to and whether its credential is about to
lapse.

### What will not work immediately, and why it is not a misconfiguration

- **LinkedIn** posts as soon as it is connected; `w_member_social` is self-serve.
  Its token lasts 60 days and the tier grants no refresh, so it has to be
  reconnected — the card warns a week ahead.
- **LinkedIn company Pages** need `w_organization_social` through the Community
  Management API, which is a separate LinkedIn approval. Organisation targets
  appear only when the token actually carries that scope.
- **Facebook and Instagram** need Meta App Review for `pages_manage_posts` and
  `instagram_content_publish`. Until then the app works only for people with a
  role on it, and the targets list themselves as not ready with the missing
  permission named.
- **Instagram** takes no binary upload — media is fetched from a public URL. Set
  `SOCIAL_META_PUBLIC_MEDIA_BASE_URL` to a base a local file's name can be
  appended to, or Instagram targets carry that constraint as their reason.
- **YouTube** needs the YouTube Data API v3 enabled on the project and you added
  as a test user while the app is unverified. `videos.insert` is quota-heavy —
  roughly six uploads a day on the default allowance — and an unverified project
  can have uploads forced private regardless of what was requested, which the
  tool reports as what actually happened.

## campaign-assets skill (marketing graphics and a capture page)

The image bakes in `campaign-assets` — an agent skill that turns **one JSON
content file** into three social-sized comparison graphics (1200×627 landscape,
1200×1200 square, 1080×1350 portrait), an optional animated GIF of the same
artwork revealing line by line, and a matching lead-capture page that carries
the identical headline. Rendering is headless Chromium against an HTML template:
no Node project, no `npm install`, no Puppeteer, no build step.

It has no upstream — the source of record is `deploy/skills/campaign-assets/`.
It is baked for the same reason video-use is (ephemeral FS, uid 1000 cannot
install at runtime) at `/opt/campaign-assets`, and the entrypoint symlinks it
into `~/.dsh/skills/campaign-assets` on the state volume so the catalog
discovers it.

**It needs no keys and no configuration.** Everything it depends on is already
in the image: Pillow, `ffmpeg` for the GIF's `palettegen` and stitch, and
`chromium` plus `fonts-dejavu-core`/`fonts-liberation`, which joined the apt
list for this skill. The renderer resolves the browser with `command -v
chromium-browser || chromium || google-chrome` and always passes `--no-sandbox`,
which is required under uid 1000 without user namespaces. The fonts matter more
than they look: bookworm-slim ships neither family, and the templates fall back
to them whenever a brand supplies no font of its own — without them every
graphic renders in a substitute face.

### Start with the brand

The skill's own first rule, and the failure it was written from: a graphic in
invented colours with a letter where the logo goes looks fine alone and wrong
beside the real site.

```sh
python3 scripts/brandinit.py https://theirsite.com brands/<name>.json
```

That reads the live site for name, logo, palette and positioning, and the
colour ranking is frequency-based — it can pick a heavily used UI colour over
the real brand one, so confirm what it found before building on it.

Two presets ship as references: `brands/generic.json` (neutral, no voice rules)
and `brands/rainmaker.json` (a **light-ground** brand — it demonstrates
`accent_light` for the slots where the accent is used as text, and `css_file`
for a stylesheet that overrides the template's geometry and embeds its own
fonts). Both templates carry a `{{BRAND_CSS}}` hook, last in `<style>`, so a
brand can override anything without forking the template.

### Build

```sh
bash scripts/build.sh <content.json> <out-dir> [brand.json] [shape ...]
WITH_GIF=on bash scripts/build.sh content.json out/ brands/rainmaker.json
```

A brand may declare `forbid` patterns and a `require` pattern; a violation
**fails the build** rather than shipping and waiting to be spotted.

### Posting to LinkedIn (optional, and the only part that needs keys)

`scripts/publish.py` can post a rendered graphic to LinkedIn. It is the one
part of the skill that is credentialed, and it is off unless you set
`LINKEDIN_CLIENT_ID` and `LINKEDIN_CLIENT_SECRET` (plus `LINKEDIN_REDIRECT_URI`
for the auth round trip). The access token it obtains is written **outside the
repo**, under `XDG_CONFIG_HOME`, on purpose: it is a 60-day bearer credential
for your identity, and a token committed to a repo with a remote is a published
token. Rendering never touches this path.

To use it: nothing to enable for rendering. In a session, ask for an
infographic, a LinkedIn graphic, a campaign visual or a capture page, and the
agent loads the skill and follows `SKILL.md`.

## Plugins the entrypoint mounts

Besides the sections above, the deployment runs these plugins. Each prints one
`[entrypoint]` line at boot saying it is on, so the container log is the
quickest way to see what a given deploy runs.

Cloudflare, Postgres, Dokploy and the social providers have settings you edit
on the Plugins page, so they are inserted by the web-app bundle
(`packages/bundle/web-app/cordis.patch.yml`) and switched on by the
`DSH_DEPLOY=1` the entrypoint exports. The rest are `--patch` overlays in
`deploy/plugins/`. The difference matters: the profile file that holds
Plugins-page edits composes after bundles and before `--patch` overlays, so a
plugin an overlay inserts can never take a saved edit.

| Plugin | On by default | Turn off with | Model tools reach agy/opencode |
|---|---|---|---|
| Session outputs | yes | `DSH_OUTPUTS=0` | yes, unless `DSH_SESSION_TOOLS_MCP=0` |
| Page capture | yes | `DSH_CAPTURE=0` | yes, unless `DSH_SESSION_TOOLS_MCP=0` |
| Agent Teams tools route | yes; lists tools only while Agent Teams is enabled under Plugins | `DSH_AGENT_TOOLS_MCP=0` | yes, unless `DSH_AGENT_TOOLS_MCP=0` |
| Cloudflare | yes | `DSH_CLOUDFLARE=0` | yes, unless `DSH_CLOUDFLARE_MCP=0` |
| Postgres | yes | `DSH_POSTGRES=0` | yes, unless `DSH_POSTGRES_MCP=0` |
| Dokploy control | yes | `DSH_DOKPLOY=0` | only with `DSH_DOKPLOY_TOKEN` |
| WhatsApp | when `wa-svc` is in the image | `DSH_WHATSAPP=0` | yes |
| Composer tools | always | — | not a tool |
| Background-job notifier | always | — | not a tool |
| LLM gateway | only with `DSH_LLM_GATEWAY_TOKEN` | leave the token unset | not a tool |

**The last column matters more than it looks.** The agy and opencode CLIs run
their own agent loop and discard the tools the harness offers, so a model
reached through them sees a plugin's tools only if the entrypoint also
registers them with that CLI over MCP. It does for every plugin in the table
with a tool: each gets a token-guarded command route on the harness and a
small MCP server in `deploy/mcp/` that forwards to it. The route tokens for
Cloudflare, Postgres, the session tools and the Agent Teams tools are
generated at each boot unless you set them, so there is nothing to configure.
Other harness plugins switched on from the Plugins page have no such bridge
and reach direct-provider models only.

Headless agy refuses every MCP tool call unless it runs with
`--dangerously-skip-permissions`, and that switch also lets agy use its own
file and shell tools inside the container. The bridge passes it whenever at
least one MCP server is registered, which with these defaults is always.
Setting every `*_MCP` switch to `0` (and leaving the browser, DeerFlow,
Dokploy and WhatsApp tokens unset) is what turns it off.

**Session outputs and page capture over MCP** act on one session's
workspace, which a command route cannot see. The agy and opencode providers
set `sessionHeader: x-dsh-session-id`, so every model request carries the
calling session's id; the bridges hand it to each CLI run as
`DSH_SESSION_ID`, the CLIs pass it on to the MCP servers they start, and the
route looks the session's working directory up from the harness's session
store. `deploy/sync-models.mjs` adds the setting at boot to a profile seeded
before it existed; without it no session-scoped tool can find its session. A call with no live session is refused
rather than written anywhere else.

**Agent Teams over MCP.** The team tools (`spawn_teammate`, `send_message`,
`list_agents`, `wait_agent`, `interrupt_agent`, `team_task_*`) are registered
on each team member's agent and act as that agent, so they cannot be rebuilt
beside a route. `deploy/plugins/agent-tools.mjs` looks up the live agent for
the CLI's `DSH_SESSION_ID` and runs the named tool through the harness tool
pipeline with it, so approvals and hooks apply as for any other call. A
teammate of an agy Lead runs on agy too, in its own session, and reaches its
own team tools the same way. `wait_agent` may block for up to an hour; the
route sends a space every 20 s so the connection never idles out. The tool
calls themselves appear in the agy/opencode reply, not as tool rows in the
session log, like every other MCP tool here.

**Credentials for these plugins.** Cloudflare, Postgres and Dokploy each take
a secret either inline in the settings card or as the *name* of an
environment variable (`apiTokenEnv`, `dsnEnv`, `apiKeyEnv`). Compose forwards
only the variables it lists, so a name you choose yourself cannot reach the
container that way. Put such variables in `~/.dsh/plugin-env` on the state
volume instead, one `NAME=value` per line; the entrypoint exports that file
at boot, and nothing else is read from it. A restart picks up a change.

### Session outputs

`publish_output` copies a finished file into `<session cwd>/.outputs`, which
the composer's Session outputs drawer lists and downloads. Writing a file
somewhere in the workspace does not deliver it; publishing does. Files are
copied, never moved, a name that is taken gets a suffix rather than being
overwritten, and a file outside the session's working directory is refused.
Nothing is ever removed, so a long-lived workspace grows until it is cleared
by hand.

### Page capture

`capture_page` screenshots a URL with headless Chromium and measures it:
horizontal overflow, broken images, the box of a CSS selector. The PNG lands
in Session outputs. It needs Chromium in the image; without it the boot line
is a warning and every capture fails. Loopback and private addresses are
refused, because the harness's own services and bridges listen on loopback.
Each capture starts from an empty browser profile, so a page behind a login
renders logged out.

### Cloudflare

Zone tools for purging cache and reading, setting and deleting DNS records,
plus, when an account is configured, adding a zone and checking whether it is
active. Configure it under **Plugins → Cloudflare**:

- **`zones`**: one entry per zone, `{ name, zoneId }` plus a token scoped to
  that zone (Zone → DNS → Edit and Zone → Cache Purge → Purge). The model
  names a zone; it never supplies a zone id or a token.
- **`accounts`** (optional): a name, the account id (the hex string in
  `dash.cloudflare.com/<id>/home`) and an account-wide token. With one
  configured, the agent reaches every domain on the account by its domain
  name, so `zones` need only list domains that should use a narrower token of
  their own. Give the token DNS Edit and Cache Purge on all zones in the
  account, and Zone Edit as well if the agent should add domains.

With several zones or accounts configured, a tool called without naming one
refuses and lists them instead of guessing. `cloudflare_dns_set` refuses an MX
with no priority, and refuses to pick when several records share a name and
type; `cloudflare_dns_delete` removes one record and refuses to guess the same
way. Neither asks for confirmation, and a deleted record is not recoverable
from here. SRV records can be deleted but not created. The zone's **Zone ID**
is on its Overview page, not the Account ID beside it.

### Postgres

`postgres_databases`, `postgres_tables`, `postgres_query` and
`postgres_execute` against databases configured under **Plugins → Postgres**,
one entry per database with a connection string inline (`dsn`) or by variable
name (`dsnEnv`). Every entry is read-only by default, and the database server
enforces it: queries run in a read-only transaction that is rolled back, so a
write hidden in a CTE still fails. `postgres_execute` works only on an entry
that sets `readOnly: false`, and commits with no undo. The model names a
database and never sees its connection string. Results are capped at 200 rows.

### Dokploy control

`dokploy_servers`, `dokploy_projects`, `dokploy_status` and `dokploy_deploy`
against servers configured under **Plugins → Dokploy**, one entry per server
with a URL and an API key inline or by variable name. `dokploy_deploy` starts
a real deployment with no confirmation. Unlike the others, its command route
and its MCP registration (`dsh-dokploy`) need `DSH_DOKPLOY_TOKEN` set by you;
without it, only DeepSeek models get the tools.

### WhatsApp

A whatsmeow sidecar (`wa-svc`, loopback 8003) holds the linked device; its
session lives in `~/.dsh/whatsapp/store.db` on the state volume, so a scanned
link survives redeploys. Link a phone by scanning the QR code under
**Plugins → WhatsApp**. The agent can read chats freely, but
`whatsapp_send` only queues a draft: nothing is sent until you press Approve
in that card, and an unapproved draft is dropped on restart. The tools reach
agy and opencode over MCP as `dsh-whatsapp`.

Two optional doors for other services on the box, each with its own token so
neither holds the harness's:

- **`WA_EXTERNAL_TOKEN`**: `/whatsapp/api/*` lets a service drive its *own*
  WhatsApp sessions. It must name a session, and it can never name `default`,
  which is yours.
- **`WA_ANNOUNCE_TOKEN`** with **`WA_ANNOUNCE_CHATS`** (`Label=jid,…`):
  `/whatsapp/announce` posts to those chats on your account with no approval.
  The allowlist, not the token, is what limits it, and each chat is rate
  limited by `WA_ANNOUNCE_COOLDOWN_SECONDS`.

### Composer tools

Routes behind the password gate that the web composer uses:
`/workspace-upload` streams a file into the current session's working
directory (2 GiB cap), `/workspace-files` and `/workspace-download` list and
download what a session produced (`.outputs/` and the older `edit/`), and
`/voice-transcribe` turns a voice note into text through Groq Whisper. Voice
needs `GROQ_API_KEY`; without it that route answers 503 and the rest work.

### Background-job notifier

Lets a long job the agent starts in the background wake the session when it
finishes, instead of the agent blocking a turn or polling. The entrypoint
generates `DSH_BG_TOKEN` at each boot and exports `DSH_NOTIFY_URL` to the
CLIs; a job ends with a `curl -XPOST "$DSH_NOTIFY_URL&session=…"`, and the
session gets a new turn to report the result. The route accepts loopback
callers with that token only, so it is not reachable from outside the
container.

### LLM gateway

Lets another service on the box use the harness's agy and opencode models
through the OpenAI protocol, at `/llm/agy/v1` and `/llm/opencode/v1`, with
`Authorization: Bearer $DSH_LLM_GATEWAY_TOKEN`. The bridges have no
authentication of their own, which is why they must never get a domain; this
is the one authenticated way in. The token is deliberately separate from
`DSH_AUTH_API_TOKEN`: a leaked gateway token spends model quota, not the
harness. Leave the token unset and the routes do not exist.

A caller that reaches the gateway through the public domain goes through
Cloudflare, which cuts any request whose response has not started within 100
seconds with a 524, and a CLI-backed completion often takes longer. Such a
caller should call the gateway from inside the box, or start the work and
poll for it, rather than hold one request open for a long generation.

## Profile repair

Plugins installed from the Plugins page live in `~/.dsh/profiles/web` on the
state volume, so they outlive every image. Below 1.0 a caret range never
crosses a minor version, so an installed plugin never updates itself across an
upstream API change; it just shows a **Problem** badge. On every boot the
entrypoint runs `deploy/repair-profile.mjs`, which removes profile bundles
upstream has retired (the Agent Teams Web UI bundle, folded into Agent Teams in
0.1.7) and reinstalls plugins below the first release that works on this
harness (`dsh-mnemon` below 0.5.16). With nothing to repair it prints nothing;
`--dry-run` shows what it would change.

## Mnemon memory

The image carries the `mnemon` CLI (`@mnemon-dev/mnemon`, pinned in
`deploy/Dockerfile`), which the `dsh-mnemon` plugin's Native provider runs for
Memory Spaces. `MNEMON_DATA_DIR=/home/node/.dsh/mnemon` puts the plugin's
global store — runtime memory, documents and Memory Spaces — on the `dsh-state`
volume; the default, `~/.mnemon`, is not a volume and was lost on every
redeploy.

## How the CLI bridges are steered and measured

Both bridges append a short `[Bridge Notes]` block after the harness's system
prompt: call the `dsh-*` MCP tools directly, do not inspect the harness to
work around a tool, and end the reply to receive a teammate's message (the
harness delivers inbox messages between steps, which for a CLI is after its
reply). Measured on a Lead spawning one teammate: agy went from 2 m 50 s /
167K tokens to 34–48 s, and opencode from a dozen shell steps hunting for the
reply to team-tool calls only, in about 31 s at a 99% cache hit.
`AGY_BRIDGE_NOTES=0` / `OPENCODE_BRIDGE_NOTES=0` remove them.

Each finished run logs its tool steps and tokens:
`[AGY proc closed] … tools=7 in=46841 out=3016 context=20866 [view_file …]`,
and for opencode also `cached=`. `in` is the run's total input across the
CLI's internal steps (cost); `context` is the largest single call, which is
what the bridges report to the harness as the prompt size, since the harness
checks it against the model's context window.

**A hung run is stopped.** The bridges keep the harness's stream alive with
heartbeats so a long, busy run is never cut off, which would also let a hung
run (a browser call that never returns, a page waiting on a captcha) spin
forever. `bridge-watchdog.mjs` watches the CLI's own output instead: no event
for `BRIDGE_STALL_MINUTES` (default 10), or a run past `BRIDGE_MAX_RUN_MINUTES`
(default 45), kills the CLI and ends the turn with an error naming the last
action, for example *agy made no progress for 10 minutes (last action:
browser_click)*. That error is not one the harness retries on its own, so the
turn stops and waits for you. `0` turns either check off.

The opencode bridge also passes opencode's own failures through as a stream
error (a refused key, a locked state database) rather than an empty answer,
and runs `opencode models` once at start so opencode's state database exists
before two runs can race to create it.

## Klipara Scout

An outreach employee for Klipara (`packages/host/klipara-scout`), inserted by
the web-app bundle and off until switched on at **Plugins → Klipara Scout**.
Each day at the configured time it starts a shift Session that finds YouTube
creators posting long videos, has Klipara cut each a free sample (one Klip per
sample), pitches it by email through Gmail or a comment on YouTube in the
DeerFlow browser, and records replies, alerting the WhatsApp recipient set on
the page. The daily caps, duplicate-pitch refusal and the pause switch are
enforced by the plugin, not the model; the shift pauses itself and alerts you
on any YouTube or Gmail warning, because the browser's YouTube account is the
one Klipara's ingest downloads with. Leads are at `/scout/leads` (signed in);
samples are public at `/scout/s/<random id>`. `DSH_KLIPARA_SCOUT=0` leaves it
out; `DSH_SCOUT_MCP=0` keeps its tools from agy and opencode.

## Model catalogue

The entrypoint runs `deploy/sync-models.mjs` on every boot: it reads
`agy models` and `opencode models`, compares them with those providers' lists
in the profile (`~/.dsh/profiles/web/cordis.patch.yml`), and writes `~/.dsh/.model-catalogue.json` for the
bridges to serve. An id the file already describes keeps its tuned limits and
name; a new one gets limits inferred from its family; a retired one is dropped.
If the configured default names a model that is gone, it is repointed at a
surviving one. A change is written as a `~/.dsh/settings.yaml` holding only the
changed lists (and the default, when it moved), which the harness imports into
the profile as it starts; with nothing to change it writes no such file.

A CLI that cannot answer — not installed, not signed in — leaves the configured
list untouched rather than emptying it. Run it by hand with `--dry-run` to see
what it would change:

```sh
docker exec $(docker ps -qf name=harness) node /app/deploy/sync-models.mjs --dry-run
```

## Operational notes

- **Sessions live in memory.** Every redeploy signs everyone out. Expected.
- **The bridges have no authentication.** They are safe only because they bind
  container loopback and no port is published. Do not give them a domain, and
  do not split them into separate compose services without adding auth.
- **`DSH_TRUST_PROXY=1` is set** because Traefik terminates TLS. It makes the
  app believe `X-Forwarded-For` (login rate limiting) and `X-Forwarded-Proto`
  (the cookie `Secure` flag). Only correct behind a proxy you control. It is
  also what keeps rate limiting per real client: every connection arrives from
  the socat forwarder, so the socket address is always 127.0.0.1 and
  `X-Forwarded-For` is the only true client identity.
- **Updating a binary:** replace the file in `/opt/harness/bin` and restart the
  container. No rebuild needed.
- **Local development** now needs `DSH_AUTH_PASSWORD` (or the hash) in the
  environment, or `start-harness.sh` will print a fresh random password to
  `dsh.log` on every start.
- **The harness executes shell tools as the container user.** The password is
  the boundary. Consider putting Cloudflare Access or a Traefik IP allowlist in
  front of it, or serving it over Tailscale instead of a public domain.

## Two-factor authentication (optional)

Any signed-in account can add a TOTP second factor at `/auth/totp` — scan the
secret into Google Authenticator, Authy or 1Password, confirm one code, and save
the one-time backup codes shown once. After that, signing in asks for a code
after the password. Turn it off from the same page by proving a current code or
a backup code.

The secret and the hashed backup codes live in `~/.dsh/.totp.json` on the state
volume, apart from `users.json`, so enrolling never rewrites the password store
and the factor survives redeploys. There is nothing to configure; the routes are
part of the gate.
