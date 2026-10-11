#!/usr/bin/env bash
# Start the llama.cpp router for local models and load the default one.
#
# pi talks to this through the `llama-local` provider in models.json
# (http://127.0.0.1:8080/v1). The built-in `llama.cpp` provider works too, but
# ONLY in the TUI — its model catalog is populated exclusively by the `/llama`
# command, so headless `pi -p` cannot see those models. models.json works in both.
#
# REQUIRES llama.cpp >= b10270. Older builds (brew shipped b8680, dated
# 2026-04-06, for months) have two fatal tool-call parser bugs for the lfm2
# architecture, both fixed upstream in June 2026:
#   - #24667 double-escaping: `\n` in a tool argument arrives as literal
#     backslash-n, so every multi-line argument is corrupt (kills every edit)
#   - #24178 parallel calls: `[f(a), f(b)]` is parsed as ONE mangled call
# Neither errors — they silently produce garbage. Check with `llama-server --version`.

set -euo pipefail

MODELS_DIR="${LLAMA_MODELS_DIR:-$HOME/models}"
PORT="${LLAMA_PORT:-8080}"
CTX="${LLAMA_CTX:-65536}"
DEFAULT_MODEL="${LLAMA_DEFAULT_MODEL:-Qwen3.8-27B-Uncensored}"
SESSION="llama"

# Auto-sleep frees the weights + KV cache after this many idle seconds
# (measured: 3.25 GB -> 0.18 GB) and wakes on the next request in ~1s.
# This is what makes leaving the server running all day cost nothing.
SLEEP_IDLE="${LLAMA_SLEEP_IDLE:-300}"

if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "tmux session '$SESSION' already running"
else
  tmux new-session -d -s "$SESSION" -x 200 -y 50 \
    "llama-server --models-dir '$MODELS_DIR' --no-models-autoload --jinja \
       --host 127.0.0.1 --port $PORT -ngl 999 -c $CTX \
       --sleep-idle-seconds $SLEEP_IDLE 2>&1 | tee /tmp/llama-server.log"
  echo "started llama-server in tmux session '$SESSION' (port $PORT, ctx $CTX, sleep after ${SLEEP_IDLE}s idle)"
fi

for _ in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then break; fi
  sleep 1
done

curl -sf -X POST "http://127.0.0.1:$PORT/models/load" \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"$DEFAULT_MODEL\"}" >/dev/null

for _ in $(seq 1 60); do
  STATUS=$(curl -sf "http://127.0.0.1:$PORT/models" \
    | python3 -c "import json,sys;d=json.load(sys.stdin);print(next((m['status']['value'] for m in d['data'] if m['id']=='$DEFAULT_MODEL'),'missing'))")
  [ "$STATUS" = "loaded" ] && break
  sleep 2
done

echo "$DEFAULT_MODEL: $STATUS"
echo "use with: pi --model llama-local/$DEFAULT_MODEL --api-key llama"
echo "stop with: tmux kill-session -t $SESSION"
