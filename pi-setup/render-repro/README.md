# render-repro — TUI desync regression harness

Reproduces and verifies the fix for the "smeared TUI on heavy output" bug
(2026-07-04, two rounds). See the "TUI Width Desync Fix" section in AGENTS.md
for the full root-cause analysis.

## What it contains

| file | purpose |
|------|---------|
| `harness.mjs` | round 1: renders the production tool-box path (box-format via jiti + pi-tui) in tmux, streams heavy content, dumps pi-tui's internal line model |
| `run.sh` + `compare.mjs` | run harness in tmux, diff model vs `tmux capture-pane` ground truth |
| `harness2.mjs` | round 2: **DSR cursor verification** — after every frame, queries the terminal's real cursor position (CSI 6n) and compares with pi-tui's model. Works in ANY terminal incl. Ghostty. Includes pi core `Markdown` (assistant message path) |
| `run-dsr-tmux.sh` | run harness2 in tmux |
| `dsr-widths.mjs` | measure ACTUAL per-token cursor advance in the current terminal via DSR — run inside Ghostty to get Ghostty's real width behavior |
| `width-test.mjs` | pi-tui width vs tmux cursor_x per test token |
| `find-bad-clusters.mjs` | fuzz: finds grapheme clusters where the terminal advances MORE than pi-tui's width (fatal undercounts) |

## Usage

Scripts assume they live in `/tmp/pi-render-repro/` and read the repo's tools
sources from `PI_TOOLS` (the live dir holds bundles, not `.ts`):

```bash
export PI_TOOLS="$PWD/pi-setup/extensions/tools"
mkdir -p /tmp/pi-render-repro && cp pi-setup/render-repro/* /tmp/pi-render-repro/
chmod +x /tmp/pi-render-repro/*.sh

# visual model-vs-capture phases in tmux
# (A=ascii, B=mixed unicode, N0..N5=class bisect, C=tabs, F=fuzz)
/tmp/pi-render-repro/run.sh B 145 40 && node /tmp/pi-render-repro/compare.mjs B

# DSR cursor-drift phases in tmux (A=ascii box, M=markdown code,
# MU=markdown+unicode, X=combined). expect "desyncs=0"
/tmp/pi-render-repro/run-dsr-tmux.sh MU

# DSR phases in a real Ghostty window (opens briefly, ~15s)
/Applications/Ghostty.app/Contents/MacOS/ghostty -e bash -c \
  'clear; PHASE=MU OUT=/tmp/pi-render-repro/dsr-ghostty-MU.txt node /tmp/pi-render-repro/harness2.mjs'
head -1 /tmp/pi-render-repro/dsr-ghostty-MU.txt

# measure Ghostty's actual per-token widths
/Applications/Ghostty.app/Contents/MacOS/ghostty -e bash -c \
  'OUT=/tmp/pi-render-repro/dsr-widths-ghostty.txt node /tmp/pi-render-repro/dsr-widths.mjs'
grep MISMATCH /tmp/pi-render-repro/dsr-widths-ghostty.txt   # undercounts = fatal

# fuzz for fatal undercount clusters (expect "bad: 0")
node /tmp/pi-render-repro/find-bad-clusters.mjs
```

## When to re-run

After a pi update (the pi-tui-utils.js core patch gets wiped — re-apply first,
see AGENTS.md), or after editing `extensions/tools/lib/box-format.ts`
normalization or `pi-core-patches/pi-tui-utils.js`. Green = all DSR phases
`desyncs=0` in both tmux and Ghostty, visual phases `MATCH`, find-bad-clusters
`bad: 0`.

## The invariant

pi-tui's grapheme width may OVERCOUNT the terminal's real cursor advance
(benign: lines pad a column short) but must NEVER UNDERCOUNT (fatal: the
padded line exceeds terminal width → hard-wrap → unexpected scroll → the
differential renderer smears everything until SIGWINCH). When extending
`clusterAdvance` in the pi-tui patch: when in doubt, count MORE.
