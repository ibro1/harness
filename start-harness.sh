#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

echo "[1/4] Starting AGY OpenAI Bridge on port 8001..."
tmux kill-session -t agy-bridge 2>/dev/null || true
tmux new-session -d -s agy-bridge "node $DIR/agy-bridge.mjs"

echo "[2/4] Starting OpenCode OpenAI Bridge on port 8002..."
tmux kill-session -t opencode-bridge 2>/dev/null || true
tmux new-session -d -s opencode-bridge "node $DIR/opencode-bridge.mjs"

echo "[3/4] Starting DeepSeek Harness Web Server on port 3080..."
pkill -9 -f "apps/cli/src/bin.ts web" 2>/dev/null || true
tmux kill-session -t harness 2>/dev/null || true
sleep 1
tmux new-session -d -s harness "bash -c 'cd $DIR && pnpm dsh web --no-open --port 3080 --host 127.0.0.1 --trusted-host produce-hatchback-feisty.ngrok-free.dev 2>&1 | tee $DIR/dsh.log'"

echo "[4/4] Checking ngrok tunnel..."
if ! tmux has-session -t ngrok 2>/dev/null; then
  tmux new-session -d -s ngrok "ngrok http 3080"
fi

sleep 2
echo "=== Services Status ==="
tmux list-sessions
echo "========================"
