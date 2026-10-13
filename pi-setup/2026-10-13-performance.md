# 2026-10-13 — performance: 180 ms keystrokes, 1.1 s starts

Source: session `01a13484` (700k tokens, 583 entries, 5.6 MB) felt "ultra heavy"
on an M4 Pro with 48 GB. RAM was never the limit: pi renders on one thread.

## Results

Measured with a tmux harness (`pi` in a 160x48 pane; keystroke = send one char,
poll the pane until it shows; 43 keys) and `node --cpu-prof`. The keystroke
number bottoms out at ~10 ms, the harness's own polling floor, so the CPU per
key column is the real cost.

| | before | after |
|---|---|---|
| boot (`pi --list-models`; also each sub-agent's start) | 1135 ms | 443 ms |
| ready, empty / 700k session | 1276 / 1283 ms | 568 / 578 ms |
| keystroke median, 700k session (p90) | 180 ms (297) | 10 ms (11) |
| CPU per keystroke, 700k session | ~180 ms | 1.6 ms |
| idle CPU, 700k session | 3.4% | 0.0% |
| RSS, empty / 700k | 257 / 462 MB | 167 / 265 MB |

Bare pi with no extensions boots in ~350 ms; the remaining ~90 ms is
claude-code-use, codex-goal, mcp-adapter, herdr's extension and ours (13 ms).
Model latency was not a factor: short replies took 3–6 s at every context size
in that session.

## Causes

1. **The diff renderer re-cut every line of every diff on every frame.**
   pi-tui's fullscreen layout builds a fresh render cache per frame
   (`layout.js` `renderLayoutFrame`) and calls `render()` on the whole
   transcript. `shiki-diff.ts` cached pi-diff's output but ran
   `truncateToWidth` over all of it on each call: 115 diffs, 3,267 lines,
   66.6 ms per frame, 62.6% of all CPU while typing. Its 128-entry LRU was also
   one session away from evicting and re-highlighting through Shiki's WASM.
2. **Rows that returned new strings broke `Box`'s cache.** `Box` reuses its
   padded output only when child lines come back unchanged; `TruncatedText`
   (sub-agent tool lines) and `renderCallLine` rebuilt theirs every frame.
3. **jiti resolved every TypeScript import at boot**: ~550 ms with packages,
   most of it `statSync` probes and the `NodeError`s they throw, repeated per
   extension.
4. **Three packages cost 594 ms of every start**: pi-sub-bar +324 ms (every
   provider disabled, so it drew nothing), pi-token-burden +143 ms (eager
   tokenizer for one command), pi-tool-display +127 ms (plus a `context` hook
   that spliced the whole message list on every request and a
   `message_update` hook on every streamed token).
5. Small: `html-to-md.ts` loaded cheerio at import (38 ms), and
   `install-pi-server.sh` checked a file pi 1.2.0 deleted.

## Changes

- `shiki-diff.ts` and `@heyhuynhgiabuu/pi-diff` (51 packages) removed. Diffs use
  `boxRendererWindowed`, cached per width, `+`/`-` lines in the theme's
  `toolDiffAdded` / `toolDiffRemoved`.
- `sub-agent-render.ts` `Line` and `renderCallLine` cache per width.
  `render-cache.test.ts` fails if any of the three returns new lines on a
  repeat render.
- `build-extensions.ts` bundles each extension with Bun (npm packages external,
  pi's packages forced external by a plugin because `stats/tsconfig.json` maps
  them to files, which inlined a second pi). `install.sh` deploys the bundles;
  `settings.json` lists `.js`; `verify-patches.sh` fails on a stray `.ts`.
- `lib/tui.ts` imports pi-tui statically (a bundled `require()` would bypass
  pi's module aliases); cheerio loads on first use.
- pi-sub-bar, pi-token-burden, pi-tool-display uninstalled with their configs,
  patches and checks; added to the removed list.

## Checked and left alone

- Node's compile cache (`NODE_COMPILE_CACHE`): 17 ms, not worth a core patch.
- psst's `tool_result` scrub: 1.4 ms per 90 KB result.
- mentions' `context` hook: an O(n) filter, sub-millisecond.
- Sub-agent transcripts in `details.messages` (2.96 MB of that session file):
  `stats` counts child tool calls from them and the inspector shows them, so
  they stay.
- Idle CPU on an empty session reads ~0.9% by `ps`; a profile of the same
  window shows 20 ms of work in 10 s, nearly all GC after startup.
