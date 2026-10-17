#!/usr/bin/env bash
# Strict vs non-strict edit A/B on a Claude model (pi #10074): 12 edits on lines
# full of non-ASCII, then scored for errors, garbled characters and correctness.
#
#   bash pi-setup/port-harness/strict-ab/run.sh <arm> [runs] [model]
#
# arms: live (as deployed), nostrict (strict stripped from every tool),
#       vanilla and vanilla-nostrict (pi's own tools; only anthropic-sub loaded).
# A run is ~15 model requests. Results go to $STRICT_AB_OUT (default /tmp/strict-ab).
set -u
arm="${1:-}"
runs="${2:-1}"
model="${3:-anthropic/claude-opus-5-5}"
here="$(cd "$(dirname "$0")" && pwd)"
out="${STRICT_AB_OUT:-/tmp/strict-ab}"

case "$arm" in
live | nostrict | vanilla | vanilla-nostrict) ;;
*)
	echo "usage: run.sh live|nostrict|vanilla|vanilla-nostrict [runs] [model]" >&2
	exit 2
	;;
esac
ext="$here/log-tools.ts"
case "$arm" in *nostrict) ext="$here/no-strict.ts" ;; esac
vanilla=()
case "$arm" in vanilla*) vanilla=(--no-extensions -e "$HOME/.pi/agent/extensions/anthropic-sub.js") ;; esac
prompt="$(cat "$here/prompt.txt")"

for i in $(seq 1 "$runs"); do
	dir="$out/$arm-$(date +%Y%m%d-%H%M%S)-$i"
	mkdir -p "$dir"
	cp "$here"/fixture/* "$dir"/
	(cd "$dir" && STRICT_AB_LOG="$dir/tools.log" pi -p --model "$model" --thinking high \
		--session-dir "$dir/sessions" ${vanilla[@]+"${vanilla[@]}"} -e "$ext" "$prompt" >"$dir/out.txt" 2>&1)
	echo "$arm run $i exit=$?  $dir"
done
python3 "$here/score.py" "$out" "$arm"
