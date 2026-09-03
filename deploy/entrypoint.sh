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
# Overridable so the script can be exercised outside the image.
APP_DIR="${DSH_APP_DIR:-/app}"

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

if [[ ! -f "$HOME/.gemini/antigravity-cli/antigravity-oauth-token" ]]; then
  echo "[entrypoint] NOTE: agy is not signed in. See deploy/README.md section 4." >&2
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
trusted_args=(--trusted-host "$DSH_PUBLIC_HOST")
for host in ${DSH_EXTRA_TRUSTED_HOSTS:-}; do
  trusted_args+=(--trusted-host "$host")
done

cd "$APP_DIR"
node --import tsx/esm apps/cli/src/bin.ts --profile web \
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

shutdown() {
  kill -TERM "$socat_pid" 2>/dev/null || true
  kill -TERM "$harness_pid" 2>/dev/null || true
  wait "$harness_pid" 2>/dev/null || true
  kill 0 2>/dev/null || true
}
trap shutdown TERM INT

wait "$harness_pid"
