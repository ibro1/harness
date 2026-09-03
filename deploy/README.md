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
fresh volume the entrypoint seeds `~/.dsh/settings.yaml` from
`deploy/settings.seed.yaml`, so the providers are registered before you ever
open the UI; edit them in the UI afterwards and the volume keeps your changes.

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

## Model catalogue

The entrypoint runs `deploy/sync-models.mjs` on every boot: it reads
`agy models` and `opencode models`, rewrites those providers' lists in
`~/.dsh/settings.yaml`, and writes `~/.dsh/.model-catalogue.json` for the
bridges to serve. An id the file already describes keeps its tuned limits and
name; a new one gets limits inferred from its family; a retired one is dropped.
If the configured default names a model that is gone, it is repointed at a
surviving one.

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
