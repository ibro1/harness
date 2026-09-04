#!/usr/bin/env bash
# Starts the two OpenAI-protocol bridges on loopback, then the harness web
# server in the foreground. All three live in one container on purpose: the
# bridges shell out to `agy`/`opencode` and carry no authentication of their
# own, so they must never be reachable off-host.
set -euo pipefail

: "${DSH_PUBLIC_HOST:?set DSH_PUBLIC_HOST to the domain this instance is served on}"

PORT="${DSH_PORT:-3080}"
# The harness itself only ever binds loopback: upstream refuses `--host 0.0.0.0`
# outright ("it would expose remote code execution to the network"), and that
# guard is worth keeping. socat republishes it on the container interface so
# Traefik can reach it, with the password gate and Traefik in front.
INTERNAL_PORT="${DSH_INTERNAL_PORT:-3081}"
# The port Traefik routes /github to. Named rather than derived: it was once
# PORT+1, which is INTERNAL_PORT on the default ports, so socat raced the
# harness for the same socket and lost. Keep it in step with the
# harness-webhook Traefik label in docker-compose.yml.
WEBHOOK_PUBLIC_PORT="${DSH_GITHUB_WEBHOOK_PUBLIC_PORT:-3083}"
# Overridable so the script can be exercised outside the image.
APP_DIR="${DSH_APP_DIR:-/app}"

# Four ports share this container and two of them are published by socat, which
# fails at bind time and in the background. Refuse to start on a collision
# rather than lose one listener quietly.
for port_pair in \
  "PORT:$PORT:INTERNAL_PORT:$INTERNAL_PORT" \
  "PORT:$PORT:WEBHOOK_PUBLIC_PORT:$WEBHOOK_PUBLIC_PORT" \
  "INTERNAL_PORT:$INTERNAL_PORT:WEBHOOK_PUBLIC_PORT:$WEBHOOK_PUBLIC_PORT" \
  "PORT:$PORT:DSH_GITHUB_WEBHOOK_PORT:${DSH_GITHUB_WEBHOOK_PORT:-3082}" \
  "INTERNAL_PORT:$INTERNAL_PORT:DSH_GITHUB_WEBHOOK_PORT:${DSH_GITHUB_WEBHOOK_PORT:-3082}" \
  "WEBHOOK_PUBLIC_PORT:$WEBHOOK_PUBLIC_PORT:DSH_GITHUB_WEBHOOK_PORT:${DSH_GITHUB_WEBHOOK_PORT:-3082}"; do
  IFS=: read -r left_name left_value right_name right_value <<<"$port_pair"
  if [[ "$left_value" == "$right_value" ]]; then
    echo "[entrypoint] FATAL: $left_name and $right_name are both $left_value; every port in this container must differ." >&2
    exit 1
  fi
done

if [[ -z "${DSH_AUTH_PASSWORD_HASH:-}" && -z "${DSH_AUTH_PASSWORD:-}" ]]; then
  echo "[entrypoint] WARNING: no DSH_AUTH_PASSWORD_HASH / DSH_AUTH_PASSWORD set." >&2
  echo "[entrypoint] A random password will be printed below and will change on every restart." >&2
fi

# Seed provider configuration on a fresh volume. Without this the agy and
# opencode providers simply do not exist in the UI after a first deploy.
mkdir -p "$HOME/.dsh" "$HOME/.gemini/antigravity-cli"
if [[ ! -f "$HOME/.dsh/settings.yaml" ]]; then
  echo "[entrypoint] seeding ~/.dsh/settings.yaml"
  cp "$APP_DIR/deploy/settings.seed.yaml" "$HOME/.dsh/settings.yaml"
fi
if [[ ! -f "$HOME/.dsh/.credentials.yaml" ]]; then
  cp "$APP_DIR/deploy/credentials.seed.yaml" "$HOME/.dsh/.credentials.yaml"
  chmod 600 "$HOME/.dsh/.credentials.yaml"
fi

# Git identity and credentials for agents working in /workspace. Rewritten on
# every boot from the environment: $HOME is not a volume, and the token must
# never be the thing that persists.
if [[ -n "${GIT_AUTHOR_NAME:-}" ]]; then git config --global user.name "$GIT_AUTHOR_NAME"; fi
if [[ -n "${GIT_AUTHOR_EMAIL:-}" ]]; then git config --global user.email "$GIT_AUTHOR_EMAIL"; fi
# /workspace is a bind mount; a repo cloned by another uid is otherwise refused
# as dubious ownership, which reads as a git bug rather than a permissions one.
git config --global --add safe.directory '*'

# An SSH identity is the credential that never enters the environment: the key
# is generated once onto the state volume, and access is granted and revoked on
# the forge by adding or removing the public half.
SSH_DIR="$HOME/.dsh/ssh"
SSH_KEY="$SSH_DIR/id_ed25519"
mkdir -p "$SSH_DIR"
chmod 700 "$SSH_DIR"
if [[ ! -f "$SSH_KEY" ]]; then
  ssh-keygen -t ed25519 -N '' -C "dsh-harness@${DSH_PUBLIC_HOST}" -f "$SSH_KEY" >/dev/null 2>&1 \
    && echo "[entrypoint] generated a new SSH identity at ~/.dsh/ssh/id_ed25519" \
    || echo "[entrypoint] WARNING: could not generate an SSH key" >&2
fi
if [[ -f "$SSH_KEY" ]]; then
  chmod 600 "$SSH_KEY"
  # accept-new records a host on first contact instead of prompting, which no
  # one is present to answer; a changed host key still fails loudly.
  git config --global core.sshCommand \
    "ssh -i $SSH_KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=$SSH_DIR/known_hosts"
  echo "[entrypoint] SSH public key (add as a deploy key or account key):"
  echo "[entrypoint]   $(cat "$SSH_KEY.pub")"
fi

if [[ -n "${GIT_TOKEN:-}" ]]; then
  git_host="${GIT_HOST:-github.com}"
  git_token_user="${GIT_TOKEN_USER:-x-access-token}"
  umask 077
  printf 'https://%s:%s@%s\n' "$git_token_user" "$GIT_TOKEN" "$git_host" > "$HOME/.git-credentials"
  chmod 600 "$HOME/.git-credentials"
  git config --global credential.helper store
  echo "[entrypoint] git credentials configured for $git_host"
else
  echo "[entrypoint] NOTE: GIT_TOKEN unset — use the SSH key above, or set a token." >&2
fi

if [[ ! -f "$HOME/.gemini/antigravity-cli/antigravity-oauth-token" ]]; then
  echo "[entrypoint] NOTE: agy is not signed in. See deploy/README.md section 4." >&2
fi

# Derive the model catalogue from what the CLIs actually serve. Both vendors
# retire ids without notice, and a stale one fails only on selection — or
# silently, when it is the configured default.
if command -v agy >/dev/null 2>&1 || command -v opencode >/dev/null 2>&1; then
  node "$APP_DIR/deploy/sync-models.mjs" || echo "[entrypoint] model sync failed; the configured lists stand" >&2
fi

for binary in agy opencode; do
  if ! command -v "$binary" >/dev/null 2>&1; then
    echo "[entrypoint] WARNING: '$binary' not on PATH — its provider will fail until /opt/harness/bin holds it." >&2
  fi
done

# Restart a bridge if it dies; a crashed bridge otherwise silently removes a
# provider from the UI with no signal beyond failing completions.
respawn() {
  local label="$1" script="$2"
  while true; do
    node "$script" || echo "[entrypoint] $label exited ($?), restarting in 3s" >&2
    sleep 3
  done
}

respawn agy-bridge "$APP_DIR/agy-bridge.mjs" &
respawn opencode-bridge "$APP_DIR/opencode-bridge.mjs" &

# --trusted-host restores the DNS-rebinding / cross-site fence for the public
# authority. Additional authorities (a second domain, a LAN IP) go in
# DSH_EXTRA_TRUSTED_HOSTS, space separated.
# The GitHub ingress is opt-in: without a secret there is nothing to verify a
# delivery against, and an unauthenticated endpoint must not exist by default.
patch_args=()
WEBHOOK_PORT="${DSH_GITHUB_WEBHOOK_PORT:-3082}"
if [[ -n "${DSH_GITHUB_WEBHOOK_SECRET:-}" ]]; then
  if [[ -z "${DSH_GITHUB_REPOSITORIES:-}" ]]; then
    echo "[entrypoint] WARNING: DSH_GITHUB_WEBHOOK_SECRET set but DSH_GITHUB_REPOSITORIES empty — every delivery will be ignored." >&2
  fi
  patch_args=(--patch "$APP_DIR/deploy/webhook/cordis.yml")
  echo "[entrypoint] GitHub webhook ingress enabled on /github for: ${DSH_GITHUB_REPOSITORIES:-<none>}"
fi

# Browser control is opt-in on its token, for the same reason: the bridge
# authenticates its caller with that token alone, so mounting the route without
# one would publish an unauthenticated command channel into the operator's
# browser. The plugin itself also refuses to start on an empty token; this keeps
# the route absent rather than merely failing.
if [[ -n "${DSH_BROWSER_BRIDGE_TOKEN:-}" ]]; then
  patch_args+=(--patch "$APP_DIR/deploy/plugins/browser.cordis.yml")
  echo "[entrypoint] Browser bridge enabled on ${DSH_BROWSER_BRIDGE_PATH:-/browser-bridge}"
fi

trusted_args=(--trusted-host "$DSH_PUBLIC_HOST")
for host in ${DSH_EXTRA_TRUSTED_HOSTS:-}; do
  trusted_args+=(--trusted-host "$host")
done

cd "$APP_DIR"
# --patch is a launcher flag: it must precede the app's own flags, which the
# launcher hands through verbatim.
node --import tsx/esm apps/cli/src/bin.ts --profile web ${patch_args[@]+"${patch_args[@]}"} \
  --no-open \
  --host 127.0.0.1 \
  --port "$INTERNAL_PORT" \
  "${trusted_args[@]}" &
harness_pid=$!

# Wait for the loopback listener before publishing it, so Traefik never sees a
# refused connection during boot.
for _ in $(seq 1 180); do
  if curl -fsS -o /dev/null "http://127.0.0.1:$INTERNAL_PORT/auth/login" 2>/dev/null; then break; fi
  if ! kill -0 "$harness_pid" 2>/dev/null; then
    echo "[entrypoint] harness exited during startup" >&2
    wait "$harness_pid"
    exit 1
  fi
  sleep 1
done

socat "TCP-LISTEN:$PORT,fork,reuseaddr" "TCP:127.0.0.1:$INTERNAL_PORT" &
socat_pid=$!

# The ingress realm binds loopback like the UI; republish it on its own port so
# Traefik can route /github to it without that route reaching the UI server.
webhook_socat_pid=""
if [[ -n "${DSH_GITHUB_WEBHOOK_SECRET:-}" ]]; then
  socat "TCP-LISTEN:$WEBHOOK_PUBLIC_PORT,fork,reuseaddr" "TCP:127.0.0.1:$WEBHOOK_PORT" &
  webhook_socat_pid=$!
  # socat reports a failed bind by exiting, and it is in the background: without
  # this the only symptom is Traefik answering /github with 502.
  sleep 1
  if ! kill -0 "$webhook_socat_pid" 2>/dev/null; then
    echo "[entrypoint] FATAL: could not publish the webhook on $WEBHOOK_PUBLIC_PORT." >&2
    exit 1
  fi
fi

shutdown() {
  [[ -n "$webhook_socat_pid" ]] && kill -TERM "$webhook_socat_pid" 2>/dev/null || true
  kill -TERM "$socat_pid" 2>/dev/null || true
  kill -TERM "$harness_pid" 2>/dev/null || true
  wait "$harness_pid" 2>/dev/null || true
  kill 0 2>/dev/null || true
}
trap shutdown TERM INT

wait "$harness_pid"
