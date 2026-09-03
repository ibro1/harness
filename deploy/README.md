# Deploying the harness on Dokploy

One container runs four processes: the harness web server on loopback 3081,
the two OpenAI-protocol bridges on loopback 8001 (`agy`) and 8002 (`opencode`),
and a socat forwarder republishing 3081 on the container interface as 3080.
Only 3080 is published, and only through Traefik.

The forwarder exists because upstream refuses `--host 0.0.0.0` by design — it
would expose remote code execution to the network. Keeping the harness on
loopback preserves that guard: what reaches the container interface is a port
that Traefik alone can route to, behind the password gate.

## 1. Host preparation (once)

The `agy` and `opencode` binaries are ~200 MB each and are not in the image.
Put them on the Dokploy host:

```sh
ssh you@dokploy-host 'mkdir -p /opt/harness/bin /opt/harness/workspace'
scp ~/.local/bin/agy      you@dokploy-host:/opt/harness/bin/
scp ~/.opencode/bin/opencode you@dokploy-host:/opt/harness/bin/
ssh you@dokploy-host 'chmod 755 /opt/harness/bin/*'
```

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

Two ways to get the token in place.

**A — copy the token you already have (fastest):**

```sh
# from the machine where agy is already logged in
scp ~/.gemini/antigravity-cli/antigravity-oauth-token you@dokploy-host:/tmp/
ssh you@dokploy-host
docker cp /tmp/antigravity-oauth-token \
  "$(docker ps -qf name=harness)":/home/node/.gemini/antigravity-cli/antigravity-oauth-token
docker exec "$(docker ps -qf name=harness)" \
  chmod 600 /home/node/.gemini/antigravity-cli/antigravity-oauth-token
rm /tmp/antigravity-oauth-token
```

**B — log in inside the container:**

agy's OAuth redirect lands on a loopback port *inside the container*, so open a
tunnel from the machine with the browser first:

```sh
ssh -L 8085:localhost:8085 you@dokploy-host
docker exec -it "$(docker ps -qf name=harness)" agy
# follow the sign-in URL it prints, in your local browser
```

If the port it picks is not 8085, re-open the tunnel on the port it names.

Verify either way:

```sh
docker exec "$(docker ps -qf name=harness)" agy models
```

**This is one shared identity.** Everyone who logs into the harness uses your
Antigravity account and its quota, with no per-user attribution. The same is
true of opencode.

## 5. Two auth layers

Upstream added its own browser gate in 0.1.2-rc.1, so a new browser passes two
checks, once:

1. The password login page (this fork's gate).
2. Upstream's launch token: visit `https://harness.example.com/?token=<token>`
   once. The token is printed in the container log at every start
   (`dsh web: http://127.0.0.1:3081/?token=...`); it is exchanged for a signed
   30-day cookie and stripped from the URL immediately.

Read the token with:

```sh
docker logs "$(docker ps -qf name=harness)" 2>&1 | grep -o 'token=[A-Za-z0-9_-]*' | tail -1
```

After a redeploy you re-enter the password (sessions are in memory) but not the
token: upstream's signing secret lives in the `dsh-state` volume, so cookies
already issued stay valid. Only a brand-new browser needs the token again.

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
