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
