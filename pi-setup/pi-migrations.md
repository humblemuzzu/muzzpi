# pi version migrations

One entry per `pi update`. AGENTS.md carries only the *current* state and the
re-patch procedure; this file carries the per-version record — specifically
**which patched core file drifted and how the patch was re-derived**, because
that is the part that is easy to get wrong and expensive to discover late.

The standing rule, proven three times now: **never blind-copy a stored patch
file over a new pi release.** Diff stock-old vs stock-new first. Every release
so far has changed something *outside* our patch region, and copying the old
file would have silently reverted an upstream feature or fix.

---

## DeepSeek V4.1 Flash 1017 (2026-10-17)

- DeepSeek's API serves DeepSeek-V4.1-Flash-1017 under `deepseek-flash` (its
  pricing page; OpenRouter's model description says the same), so sub-agents
  moved on their own. `/models` lists only `deepseek-flash` and `deepseek-v4-pro`.
- pi 1.3.0 ships both in its DeepSeek provider. Our full re-declaration of
  `deepseek-flash` (2026-09-10) became a cost-only `modelOverrides`: it had set
  `"off": null`, which hid thinking-off that DeepSeek and stock pi support.
  Costs are DeepSeek's off-peak rates (peak is 2x, 7 weekday hours UTC).
- OpenRouter's DeepSeek entry left the picker: it pins snapshots (its
  `deepseek/deepseek-v4.1-flash` is the original, 1017 has its own id) and was
  never used once. River lists only `deepseek-ai/DeepSeek-V4.1-Flash`.

## pi runs our bundle of the patched files (2026-10-17)

- `pi` → `dist/muzzpi-bundle/cli.js`, built by `pi-bundle/build-pi-bundle.mjs`:
  pi's `scripts/build-coding-agent-bundle.mjs` at v1.3.0 (sha256 `bb8134c8…`,
  unchanged since v1.2.0) with esbuild 0.28.2, pi's root devDependency. Changes
  from upstream: paths of an npm install; OAuth flows read from pi-ai's compiled
  `load.js` (npm ships no `src/`); output staged, swapped in file by file, and
  the previous build's chunks kept; a smoke test with every extension loaded.
- Measured on 1.3.0 (median of 11–15, interleaved): editor on screen 447 → 274
  ms; full start 376 → 212; sub-agent 350 → 187; `--version` 271 → 111 (pi's
  own bundle 110); peak RSS 163 → 138 MB. Prompt and tool declarations
  byte-identical, `--export` HTML and the TUI render identical; the width patch
  is live (pi's unpatched bundle wraps `्र्` later). pi's own bundle with this
  setup takes 730 ms to start (likely its eager MCP connects; not isolated).
- Fidelity: stock 1.3.0 through our builder gives 75 of 80 files byte-identical
  to pi's `dist/bundle`; the other 5 trace to dependencies npm resolved newer
  than pi's lockfile (`lru-cache` 11.4.0 → 11.5.3, `@smithy/core` 3.33.3 →
  3.36.0, `gaxios` 7.1.4 → 7.3.1), which the modular install runs as well.
- Editor paste: under a bundle `dirname(argv[1])/utils/clipboard-image.js` does
  not exist, so pastes inserted the raw temp path. `tools/lib/pi-package-dir.ts`
  finds it now, and it loads on the first paste (13–36 ms; 0 under `dist/cli.js`).
- Trap: a lookup of `esbuild` from the repo finds `~/node_modules/esbuild`
  0.27.0, and Node caches the lookup across the install that follows.
- For other people's machines: the builder finds pi-ai in npm-global, hoisted
  npm/bun and pnpm layouts (tested on all four); `install.sh` refuses, before
  writing anything, a pi whose stock patched files differ from `base-version`'s
  (pi 1.0.3: 3 files; 1.2.0: none, so it installs); `verify-patches.sh` reports a
  provider with no listed models as a login to do (WARN), not a FAIL.
- On each pi update: the builder fetches the new tag's recipe and root
  `package.json` and refuses any change (pi stays on `dist/cli.js`, WARN). Then
  diff upstream's recipe from v1.3.0, mirror it in `runRecipe`, bump `UPSTREAM`,
  and run `node pi-setup/port-harness/bundle-fidelity.mjs <version>`: only
  dependency drift may differ.

## edit/write sent non-strict (2026-10-17)

- pi 0.86.0 made its built-in tools `strict: "prefer"`, and every Claude model
  has `supportsStrictTools: true`. When `edit-write.ts` started wrapping pi's
  tools (`da254fb`) it copied that, so Edit and Write went out `strict: true`.
  Anthropic's strict decoding cannot emit `\u`: Claude's non-ASCII arrived as
  `\b2014`, `\ndash`, `\ttt`, a literal `\u2014`, or was dropped (pi #10074).
- Measured: 32 of 131 failed edit/write calls since the swap, plus 54 edits only
  rescued by our escape decoder, and four lines of this file written with a
  literal `\u2014`. Same task on Opus 5.5, strict on vs off: ours 11 errors +
  28 rescued in 63 calls vs 0 in 48; vanilla pi 2 in 38 vs 0 in 36.
- Strict buys nothing now: pi's edit schema accepts invented keys (the #6278
  reason for strict), Claude's 22,834 non-strict calls since 2026-09-23 had no
  structural schema failure, and Claude Code sends its Edit tool non-strict.
- Both tools also refuse a control character the file never had (U+0000 to
  U+001F except tab, LF, CR, and U+007F), named by code point. None of 61,486
  recorded changes ever added one.
- On each pi update: if pi drops `strict: "prefer"` for Claude upstream, the
  override can go; the assertion in `edit-write.test.ts` shows pi's value.
  Prove it first: `bash pi-setup/port-harness/strict-ab/run.sh vanilla 3` must
  score 0 garbled. Error rates and causes on real sessions:
  `python3 pi-setup/edit-scoreboard.py --since <date> [--list]`.

## Setup on pi 1.3.0 (2026-10-16): built-in MCP, a 4th core patch, psst and goal in-house

- `pi-codex-goal` 0.6.1 vendored as `extensions/goal` and bundled (it was 40
  TypeScript files through jiti on every start). Changed: model text (no
  `pi__` bridge naming, audit rules said once: guidelines 2,068 to 905 chars,
  compact continuation ~1,294 to 728), unsent `promptSnippet`s dropped, timer
  callbacks guarded. Logic and the stored entry type are upstream's, so a
  future upstream release is merged by diffing its `src/` against 0.6.1.

- `pi-mcp-adapter` removed for pi's built-in client. **New core patch
  `mcp-index.js`** (stock `dist/extensions/mcp/index.js` of 1.3.0, every change
  marked `LOCAL PATCH: lazy MCP connect`): servers connect when a call needs
  them, not at session start; a script that only describes the namespaces it
  names starts only those; `reachesServer` matches the namespace exactly (stock
  `includes` made `mcp__cloudflare_docs` reach `mcp__cloudflare`); a failed
  server is retried by the next call that needs it; `/mcp` connects what it
  shows. Re-derive by re-applying those hunks to the new stock file;
  `update-pi.sh` lists it as `extensions/mcp/index.js=mcp-index.js`.
- Config moved to `~/.pi/agent/mcp.json`: `auth`, `protocolVersion` and the
  adapter's `settings` block dropped, a `description` per server, 13 rarely used
  Cloudflare servers `enabled: false`. OAuth tokens: sign in again with
  `/mcp login <server>`; the adapter's Keychain entries are unused.
- `psst-cli` (and `better-sqlite3`, its native addon) removed from the tools
  extension: `lib/psst.ts` reads the vault with `node:sqlite` + `node:crypto`
  and writes through the `psst` CLI. `muzzpi-computer` must be rebuilt after
  this (its bundle imported `psst-cli`).

## Packages on pi 1.3.0 (2026-10-16): goal 0.6.1, mcp-adapter 5.3.1, chrome-devtools-mcp 1.11.0

- `pi-codex-goal` 0.6.0 → 0.6.1: one guard in `before_agent_start` for
  custom-message starts (0.6.0 read `event.prompt`, undefined there, and threw).
  Tool schemas and prompt text byte-identical.
- `pi-mcp-adapter` 5.1.0 → 5.3.1: MCP SDK 2.3.1 (GHSA-6qxp-vccf-f47h); a server
  URL that redirects to another host is no longer followed. `scriptMode === true`
  gate, `namespaceProxyTools === false`, the `mcp` tool's parameters and the
  skill list unchanged; peers and engines identical.
- `chrome-devtools-mcp` 1.7.0 → 1.11.0: our three flags unchanged (launch
  checked against a flagless control). New: ambient `~/.config/cd4a/config.json`
  discovery (off via `CHROME_DEVTOOLS_MCP_NO_CONFIG_DISCOVERY=1`), unknown flags
  are warned about, page-scoped tools require `pageId`, 7 new tools.

## 1.3.0 (2026-10-16) — from 1.2.0, no patch drift

**Patch drift (stock 1.2.0 vs stock 1.3.0, registry tarballs):** none.
`resource-loader.js`, `session-selector.js`, `keybindings.js` byte-identical,
copied. pi-tui, pi-agent-core and pi-mcp dist unchanged; width patcher clean.
`system-prompt.js` and every `core/tools/*` definition unchanged, so the
prompt and tool schemas (cache prefix) are identical.

**Changes checked against our setup:**
- `--model` resolver rewritten (#10160): a `provider/id` whose provider has
  that literal id resolves to it. All our ids are qualified; only
  `deepseek/deepseek-v4-pro` is also a raw id (openrouter, vercel-ai-gateway),
  and the named provider still wins while it has auth. `enabledModels` scope
  resolves it to `deepseek` only, no ambiguity warning.
- Resume restores the transcript's tools only when `--tools` is absent or
  `+/-` modifiers (`usesDefaultTools`). Children pass an explicit list, so
  `continueId` resumes are unchanged.
- Codemode admits at most 2 live workers per process, counted until the
  worker exits (Bun can trail the result). A 3rd parallel call errors;
  `codemode-harness.ts` retries admission for the back-to-back test scripts.
- Overlay `done()` hides its own overlay, not the topmost: a fix for us.
- Malformed final tool-call JSON now fails validation (`argumentsError`)
  instead of running with a parsed prefix.
- Thinking from another model is dropped on a model switch, not sent as text.
- pi-ai no longer exports `AssistantMessageFrame*`; we never imported it.
- `kimi-coding` moved to Chat Completions at `/coding/v1`; we override nothing.
- `/share` defaults to `sessionShareDestination: "auto"` (Radius when logged in).
- Verified: staged 1.3.0 in /tmp (boot, smoke, real `finder` child on
  `deepseek/deepseek-flash · high`, canary 4/4), then `update-pi.sh`:
  `verify-patches.sh` 16/16 PASS, smoke reply, canary 4/4, `bun test`.

---

## pi-claude-code-use → `anthropic-sub.ts` (2026-10-16)

Measured on Claude Max OAuth with extra usage off (a 400 "You're out of extra
usage" = classed third-party, a 200 with `representative-claim: five_hour` =
plan): flat tool names pass; the trigger is pi's docs block, the lowercase
phrases `pi itself` + `pi .md files` + `pi packages` together (rewriting one
still 400s; all three, capitalising them, or dropping the block passes). The
identity line is still required (bare 429 without it).

Replacement: `piDocs()` writes the cli wording; `anthropic-sub.ts` scrubs the
same phrases (bytes identical to the shim's output), warns on a refusal via
`message_end` (`after_provider_response` does not fire on a 400), and logs
payloads under `PI_ANTHROPIC_PAYLOAD_LOG`. Prototype runs (parent haiku/opus,
child, resume): every turn 200 on the plan, system and tools hashes constant,
first write 43.2k vs 43.4k with the shim, then +25 to +230 per turn.

**Old sessions:** pi recorded the shim's 29 alias tools in each session's
initial tool list. Resumed without the shim they still ship (65 tools, ~16k
cached tokens) next to a persisted `toolsRemoved: 29`; one cache rewrite on the
first resumed turn. Start fresh sessions after the switch.

**Rollback:** `git revert` the change, `bash pi-setup/install.sh` (pi reinstalls
the pinned 2.2.1; needs network), then trash the leftover
`~/.pi/agent/extensions/anthropic-sub.js` (install.sh keeps files it does not own).

---

## Packages + deploy (2026-10-13): 3 packages out, extensions bundled

Removed `pi-token-burden`, `@marckrenn/pi-sub-bar` (+ pi-sub-core) and
`pi-tool-display` with `pi remove`; trashed their configs, `pi-sub-patches/`
and `install-pi-server.sh`. Extensions now deploy as Bun bundles
(`build-extensions.ts`); `settings.json` lists `.js`. Boot 1135 to 443 ms,
keystroke at 700k 180 to 10 ms.
Backup: `~/.pi/agent/extensions.backup-20261013-180008`.

---

## 1.2.0 (2026-10-13) — from 1.1.0, `resource-loader.js` + `keybindings.js` re-derived

**Patch drift (stock 1.1.0 vs stock 1.2.0, registry tarballs):**
- `resource-loader.js`: upstream changed the AGENTS.md shadow check (symlinked
  worktree fix, #10681), outside our hunk. Re-derived: stock 1.2.0 + our
  conflict-diagnostics hunk only.
- `keybindings.js`: restructured (`APP_KEYBINDINGS` table, per-value
  `KeybindingValueSchema` check in `toKeybindingsConfig`, `$schema` skipped).
  Re-derived: stock 1.2.0 + `app.session.pin` + `pinSession` mapping. Our
  `isRecord` guard is dropped: `loadRawConfig` rejects non-objects and
  `migrateKeybindingsConfig` always returns a plain object.
- `session-selector.js`: byte-identical, copied.
- pi-tui 1.2.0: `utils.js` changed only in segment extraction (APC markers
  kept at slice boundaries); width patcher applied clean.

**Changes checked against our setup:**
- `before_agent_start` now also fires for `sendMessage(..., { triggerTurn })`
  runs (`messageType: "custom"`, no `prompt`). Our four handlers (system-prompt,
  psst, skill, local-model) only touch `systemPromptOptions`/`ctx.model`, so
  `agent-message` runs now get our sections instead of losing them mid-run.
- Busy-while-starting: `sendUserMessage` needs `deliverAs` during run start
  too. command-palette sends from the idle editor; you-should-know passes it.
- Themes now validated at startup: all 4 pass `ThemeJsonSchema`; `$schema`
  moved to `https://pi.dev/schemas/theme.schema.json`.
- Settings/models schemas: settings schema not enforced at runtime, defaults
  unchanged; models.json loads; all 8 `enabledModels` listed, OpenRouter ones
  included under the new per-key catalog.
- `-p` exit 1 on `stopReason: "length"` is text mode only; children run json.
- pi-ai Anthropic: `onPayload` now inside a loop that retries once with
  `strict: "prefer"` tools non-strict on a grammar-size 400; the shim still
  transforms each attempt. Payload diff 1.1.0 vs 1.2.0 (shim debug log): same
  36 tools and aliases, same keys, system prompt identical; only upstream's
  codemode description sentence changed.
- `~` expansion in `!`/`+`/`-` resource patterns: we have none.
- Verified: staged 1.2.0 in /tmp first (boot, payload diff, `finder`), then
  `update-pi.sh`: `verify-patches.sh` 17/17 PASS, smoke reply, `bun test`
  tools 1647 pass / 0 fail + 212 other extension tests, real write/edit/failed
  edit, `chad` with `touch` blocked, TUI in tmux (Indic/CJK border aligned,
  `/resume` shows `ctrl+b pin`).
- Backup: `~/pi-update-backup-1.1.0-20261013-170759`.

---

## pi-autoresearch removed; tool honesty pass (2026-10-08)

- **pi-autoresearch deleted**, not just disabled: the git checkout under
  `~/.pi/agent/git/github.com/davebcn87/` and `extensions/pi-autoresearch.json`
  (live + repo) went to the trash. Its 3 skills had still been loadable through
  `skill`, which walked every package dir on disk. It is now on the removed
  list, and `verify-patches.sh` fails on any trace of it. Earlier entries in
  this file that mention it are history.
- **`skill` serves pi's resolved list** (`systemPromptOptions.skills`); it had
  missed `~/.agents/skills/` and exposed `mcp-scripting`.
- Full list of fixed tools, each pinned by a test: `format_file` (gitignored or
  unparsable files reported as errors, home-dir prettier no longer used), bash
  (codemode `structuredContent`, full-output spill, 50k-char cap, signal deaths
  are errors), read-only bash (write forms were allowed: `sort -oX`, `sed '1wout'`,
  `sed --expression`, `curl --remote-name-all`…; `git -C` refused),
  `read_web_page` (middle of long pages dropped, `objective` was a no-op),
  `grep` (`context`/`limit` ignored), `search_github` (file `path` matched
  nothing), `commit_search` (`query` only filtered 50 commits; `offset` was a
  page number), `list_repositories` (same `offset`), `screenshot` list (system
  overlays), undo diff labels, output-buffer dedupe (dropped repeated lines).
- **Found by the live re-test:** `find`/`grep` passed rg an absolute path, so
  any glob containing `/` (the documented `src/**/*.ts`) matched nothing; rg
  now runs from the search dir on `.`. And `OutputBuffer.preview()` pushed the
  streaming partial line into the buffer itself, so a line split across chunks
  came back duplicated in bash output; `dedupe()` returns copies now.
- **Found in the restarted session:** `apply_patch` and `format_file` called
  from a codemode script crashed with ENOENT. Nested calls get the id
  `<parent>/<n>`, and the `/` turned the undo record path into a missing dir.
  Records are now filed under the parent call (`ownerId` in file-tracker.ts), so
  undo/redo treat a script's edits as one change: newest-first on undo,
  oldest-first on redo. Envelope hunks that miss now carry the same
  "closest match" hint as `old_string`.

---

## Packages (2026-10-08) — pi-mcp-adapter 5.0.0 → 5.1.0, tools deps

pi core 1.1.0 was already latest; every other loaded pi package was current.

- **pi-mcp-adapter 5.0.0 → 5.1.0.** Additive (Pi 1.0 compat, opt-in Tavily
  setup, `openUi: false`, `pi -p` hang fix). Pin bumped in live + repo
  `settings.json` and `install.sh`, object form kept. `pi update
  npm:pi-mcp-adapter@5.1.0` printed "Updated" and installed nothing;
  `pi install npm:pi-mcp-adapter@5.1.0` did it. The mcpScript gate is now
  opt-in (`scriptMode === true`). Headless boot: `mcp` yes, `mcpScript` no,
  `mcp-scripting` no. No new pi-tui copy on disk.
- **tools extension deps:** `@heyhuynhgiabuu/pi-diff` 0.7.6 → 0.9.2 (pi-tui now
  a peer, resolves to the patched host copy; `__testing` API unchanged),
  `diff` 8 → 9 (`createPatch` unchanged for our call), `psst-cli` 0.6.6 → 0.7.1.
  **psst 0.7 made `Vault.listSecrets` async**; without the `await` in
  `lib/psst.ts` the iteration threw inside a try/catch and every vault secret
  silently stopped loading. Verified `SSH_KEY` loads after the change.

---

## Jev out of `web_search`, in as the `jev` skill (2026-10-08)

`lib/jev-judge.ts` (added 10-02, ported from GaganSD/pi-extensions) is gone;
`web_search` returns plain Parallel results. The calling model already judges
relevance and sufficiency, and better, since it knows the real task. The
judge's own verdicts were wrong in a pattern: compound objectives ("founders,
funding, traction of X") got "not sufficient — consider another search", and
legit pages got "held — safety unverified" from a 5-way safety Choice. A
per-passage rebuild on TypeSafe's RAG-passage cookbook fixed both (planted
injection 0.99 on 6/6 sets, legit pages ≤ 0.11) but still only duplicated the
model's own judgement, so it was dropped rather than kept.

Jev is now a codemode decision tool, documented in `config-skills/jev/SKILL.md`:
exact `models.classify` call, pi's `bool`/`choice`/`score` shapes (pi rejects
TypeSafe's `noul`), the batch pattern, and the jev-1.13 accuracy rules. The
skill exists so a model does not read `codemode.md` + `models.md` (~26k chars)
and TypeSafe's docs every time it needs a decision.

---

## 1.1.0 (2026-10-08) — from 1.0.3 (via 1.0.4), `resource-loader.js` re-derived

**Patch drift (stock 1.0.3 vs stock 1.1.0, registry tarballs):**
- `resource-loader.js` drifted: upstream added `disabledBuiltinExtensions`
  (field, constructor line, a `.filter` on `extensionPaths`) for `--no-mcp`.
  None of it overlaps our conflict-diagnostics hunk. Re-derived by applying
  upstream's three hunks to the stored patch; `diff stock-1.1.0 stored` now
  shows only our hunk.
- `session-selector.js`, `keybindings.js`: byte-identical, copied.
- pi-tui 1.1.0: `utils.js` unchanged, width patcher applied clean.

**Changes checked against our setup:**
- `--tools` (1.0.4 + 1.1.0): plain names stay a strict allowlist; `*` patterns
  and `+name`/`-name` lists are new; an allowlist without an `mcp__` entry now
  keeps `mcp__*` tools registered for codemode. `pi-spawn.ts:482` sends plain
  names only, built-in MCP is off, and the adapter's tool is `mcp`, so
  sub-agent surfaces are unchanged. Mixing `+x` with plain names is now an error.
- OSC 7501 program status: interactive mode only, written only after the
  terminal answers a `7501;?` query. Cannot reach `--mode json` stdout.
  `PI_PROGRAM_STATUS=0|1` overrides.
- `outputPad` defaults to 1, the padding tool boxes already had, so tool
  renderer widths are unchanged. `durationMs` and `agent_settled.aborted` are
  additive.
- pi-ai: Anthropic OAuth login falls back to a free callback port; request
  path untouched, so pi-claude-code-use is unaffected. Haiku 5.5 added.
- Verified: `verify-patches.sh` 14/14 PASS, headless smoke reply, `finder` ran
  on 1.1.0, headless session lists 38 tools incl. `codemode` + `mcp`, no
  `mcpScript`.
- Backup: `~/pi-update-backup-1.0.3-20261008-113647`.

---

## 1.0.3 (2026-10-05) — from 1.0.2, via `update-pi.sh`

No patch drift: stock `resource-loader.js`, `session-selector.js` and
`keybindings.js` are byte-identical between 1.0.0 and 1.0.3, so the stored
patches were copied as-is and `base-version` moved to 1.0.3.

- **Breaking, not ours:** Azure provider renamed `azure-openai-responses` →
  `azure`. No azure entry in settings, models or auth.
- `Home`/`End` now always move the editor cursor; transcript top/bottom moved to
  `Ctrl+Home`/`Ctrl+End`. `keybindings.json` and `editor/` reference neither.
- 1.0.1 dropped `npm-shrinkwrap.json` (transitive deps no longer pinned) and
  1.0.1 made `pi update` on global npm installs recommend the installer; we
  keep using `update-pi.sh`.
- Verified: `verify-patches.sh` all PASS, headless smoke reply, `finder` ran.
- Backup: `~/pi-update-backup-1.0.2-20261005-195420`.

---

## Jev + theme studio (2026-10-02)

- `web_search` judges Parallel results with a Jev classifier (`lib/jev-judge.ts`,
  logic from GaganSD/pi-extensions `pi-web-search/src/jev`, MIT). Auto-picks
  `typesafe/jev-latest`, else `openrouter/typesafe/jev-1.13`; any failure leaves
  results unchanged plus one `jev:` line. Verified: with the key,
  `jev: sufficient`, classifier cost 0; pinned to a missing model,
  `jev: judging failed — no available classifier for typesafe/does-not-exist`,
  results intact. The upstream repo ships no web-search skill (its only skill is
  `pi-ask/skills/ask-user`), so none was added.
- `theme-studio/` extension. Verified in tmux against a copied Ghostty config:
  preview writes the key, Esc restores it, Enter keeps it; Pi tab persists
  `theme` in `settings.json`. Not verified: the visible effect of a live reload
  on the real Ghostty window.
- Themes added: `catppuccin-mocha`, `black-metal` (from pi-slate, schema-checked
  by pi at load).

---

## Packages (2026-10-02) — pi-mcp-adapter 3.3.0 → 5.0.0, pi-codex-goal 0.4.1 → 0.6.0; 1.0 TUI on

Installed with explicit versions from `/tmp` (`pi install npm:<name>@<ver>`).
Backup: `~/pi-update-backup-pkgs-20261002-200439`.

- **pi-mcp-adapter 5.0.0** defaults `settings.namespaceProxyTools` to true
  (`types.ts:626`), which registered `mcp__chrome_devtools` and
  `mcp__cloudflare_agents_docs` next to `mcp` (42 tools). Set it `false` in
  `mcp.json`; surface back to 37. `scriptMode` is now opt-in upstream, still
  `false` here. 5.0 also reads `~/.pi/agent/mcp.json` again; that file stays
  absent. It writes `-builtin:mcp` into settings on first start; already present.
- **pi-codex-goal 0.6.0** qualifies against pi 1.0.0. Declares node >=24 like
  0.4.1 did; loads under node 22.23.1, goal tools present.
- **TUI:** `tuiMode: "fullscreen"`, `quietStartup: "header"`. Captured in tmux
  at 120x40: logo + `v1.0.0` + key hints, editor/footer/sub-bar intact.

---

## 1.0.0 (2026-10-02) — from 0.99.2; patched files unchanged, copied

**EBADDEVENGINES root cause.** pi's package.json has had no `devEngines` since
at least 0.99.2. npm's `checkDevEngines` (`npm/lib/base-cmd.js:135`) normalizes
`localPrefix`, the nearest `package.json` above cwd, and `~/package.json` is a
bun project with `devEngines.packageManager: bun`. Any npm command run inside
`~` fails, `npm view` included; the same command from `/tmp` works. Fix: run npm
outside `~`. `--force` is no longer needed. `~/package.json` was left alone
because it belongs to another project.

**`pi update --self` is not safe here** even with that fixed: it runs
`npm --prefix /opt/homebrew install -g` (`config.js:121-136`), which repoints
`bin/pi` at `dist/bundle/cli.js`. `update-pi.sh` replaces the manual procedure:
diff stock base vs target for the 3 patched files, backup, install, re-pin,
copy patches, width patcher, verify, headless smoke.

**Patch drift (stock 0.99.2 vs stock 1.0.0, registry tarballs):**
- resource-loader.js, session-selector.js, keybindings.js, compaction.js,
  model-resolver.js: byte-identical. Stored patches copied clean.
- args.js: help text only. main.js now errors on `--provider` without
  `--model`; pi-spawn passes only a qualified `--model` (`pi-spawn.ts:454`).
- settings-manager.js: `tuiMode` default flipped to fullscreen. Set
  `"tuiMode": "regular"` to keep scrollback.
- user-message.js: `Box` wrapper removed, Markdown pads itself. pi-tool-display
  0.5.0's `findMarkdownChild` walks children recursively, so the bordered
  user box still renders (rendered at width 60 under jiti before and after).
- pi-tui 1.0.0: width patcher anchors intact, applied.

**Bug found by the smoke test:** `notify.ts` wrote OSC 777 to stdout in
`--mode json`, corrupting the first JSON line of every headless run (sub-agents
included). Now gated on `ctx.hasUI`; 17/17 lines parse after the fix.

**Not updated:** pi-mcp-adapter 5.0.0 (3.3.0 kept; first version declaring
pi-ai 0.99, none declares 1.0) and pi-codex-goal 0.6.0 (0.4.1 kept). Separate
jumps, each needs its own check.

verify-patches.sh 14/14 PASS. Headless replied `UPDATE_100` as xai/grok-4.6.
37 tools, `mcp` present, `mcpScript`/`codemode` absent. A `finder` sub-agent
spawned on 1.0 and returned cited lines. Rollback:
`~/pi-update-backup-0.99.2-20261002-190854`.

---

## 0.99.2 (2026-10-01) — from 0.99.1; patched files unchanged, copied

Install is still
`npm install --prefix /opt/homebrew -g --force --ignore-scripts
@earendil-works/pi-coding-agent@0.99.2` then re-pin `pi` → `dist/cli.js`.
Do **not** `pi update` (EBADDEVENGINES) and do **not** `pi update --extensions`.
`install.sh` copies patches and runs the width patcher; it does **not** install
the npm package and does **not** re-pin the bin.

**Patch drift (stock 0.99.1 vs stock 0.99.2, registry tarballs):**
- resource-loader.js, session-selector.js, keybindings.js, args.js,
  compaction.js — byte-identical → stored 0.99.1 patches copied clean.
- dist/cli.js still 169 bytes (`setupCli(); main()`). bin still
  dist/bundle/cli.js → re-pinned. npm install pointed the bin at the bundle;
  verify-patches.sh:23-28 FAILS if that is left in place.
- loader.js — three added guards (registerCommand name/handler, MCP namespace
  clash for `-` vs `_`). Our extensions register named handlers; we do not
  call `pi.registerMcpServer`.
- compaction.js still has `getSummarizationFailure` and no `toolChoice`.
- pi-tui 0.99.2 — width patcher applied to the fresh
  `/opt/homebrew/.../pi-tui@0.99.2` copy; anchors intact.
- Changelog is MCP exposure (codemode listing, `mcp_servers` section,
  `oauth.clientName`, `auth.provider`). Built-in mcp stays off (`-builtin:mcp`);
  the new section lives in `dist/extensions/mcp/` and is not loaded.

verify-patches.sh 14/14 PASS. Headless `pi --mode json -p --model grok-4.6
--provider xai` replied `UPDATE_0992` as `provider: xai`, `model: grok-4.6`.
Rollback: `~/pi-update-backup-0.99.1-20261001-173545`.

**leftover `~/.pi/agent/mcp.json` boot warning.** adapter 3.x
`getLegacyMcpMigrationNotices` (`config.ts:229`) warns whenever that file has
content and built-in MCP is off (`-builtin:mcp`). the suggested `mv` to
`mcp-adapter.json` would duplicate `~/.config/mcp/mcp.json` (byte-identical, 19
servers). retired the leftover; `install.sh` now removes it. do not recreate it
as a built-in-MCP fallback.

**anthropic extra-usage banner.** pi core
`maybeWarnAboutAnthropicSubscriptionAuth` (`interactive-mode.js:4277`) fires on
every switch to an anthropic model with OAuth (`sk-ant-oat`).
`warnings.anthropicExtraUsage: false` is the upstream suppress
(`docs/settings.md`). pi-claude-code-use already remaps custom tools so the
banner is not a billing signal.

---

## pi-claude-code-use 1.0.5 → 2.2.1 (2026-10-01)

`pi install npm:@benvargas/pi-claude-code-use@2.2.1` only. Not `pi update --extensions`.
Pin `@2.2.1` in settings.json and install.sh. `PI_CLAUDE_CODE_USE_DISABLE_TOOL_FILTER`
removed from `~/.zshrc`, `pi-spawn.ts`, e2e/github tests. Must stay unset: 2.x
auto-aliases non-core tools; that env skips remap and dual-names them.

---

## 0.99.1 (2026-09-30) — from 0.87.1; patches re-derived, not copied

**There is no 0.88–0.98.** The registry jumps straight from 0.87.1 to 0.99.0, so
0.99.0's changelog *is* the whole delta and 0.99.1 only adds `gpt-6.1-sol` as the
OpenAI Codex default. One jump, not twelve.

### New from upstream in this jump

- Built-in extensions: `codemode`, `tool-search`, `mcp`, `llama.cpp`
  (`dist/extensions/`, registered by name as `builtin:<name>`).
- Extension tool APIs: `exposure` (`direct`/`model-only`/`codemode`/`deferred`/`hidden`),
  `namespace`, `annotations`, `outputSchema`, `prepareLoadout()`, `ctx.executeTool()`.
- `defaultTools` gained `+name` / `-name` entries; `extensions` gained `-builtin:<name>`.
- Built-in `read`/`bash`/`edit`/`write` now declare
  `constrainedSampling: { type: "json_schema", strict: "prefer" }`. Inactive for us
  then: our replacements set none. Since the edit/write swap (`da254fb`) ours wrap
  pi's, and they set `constrainedSampling: false` (see the 2026-10-17 entry).
- Theme engine gained `system` (new default), OKHSL colors and an `appearance` field;
  additive, so the gruvbox theme file is untouched.
- Node requirement is now `>=22.19.0` (machine runs 22.23.1).

### Install

```bash
npm install --prefix /opt/homebrew -g --force --ignore-scripts \
  @earendil-works/pi-coding-agent@0.99.1
ln -sfn ../lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js /opt/homebrew/bin/pi
```

The npm install repoints `/opt/homebrew/bin/pi` at `dist/bundle/cli.js` (the
package's declared `bin`), which silently disables every core patch — re-pin it
every time. `pi update` still fails with EBADDEVENGINES.

### Patch drift (stock 0.87.1 vs stock 0.99.1, registry tarballs)

- **session-selector.js — byte-identical** between the two stocks. The stored
  patch copied clean; nothing to re-derive.
- **keybindings.js — 2 lines** (one upstream `app.clipboard.pasteImage`
  description string). Re-derived onto 0.99.1 stock: `app.session.pin`,
  `pinSession` mapping, `isRecord` guard in `toKeybindingsConfig`.
- **resource-loader.js — 196 changed lines**, but none inside our hunk;
  `addExtensionConflictDiagnostics` still sits at :578 with the same conflict
  loop. Re-derived onto 0.99.1 stock. The delta is now **code only** — the
  4-line why-comment was dropped (the comment gate refuses changes that are
  mostly commentary, and AGENTS.md already carries the reason).
- **pi-tui 0.99.1** — `graphemeWidth` gained an upstream
  `terminalSpacingMarkRegex` early return (some of what our patch had been doing).
  Both patcher anchors survived (`zeroWidthRegex` → `return 0`; final `return width`)
  and `eastAsianWidth` is still present, so the patcher applied to the fresh
  `pi-tui@0.99.1` copy. Overcount stays smear-safe.

### Extension surface

- Built-in `mcp` is `replaceable: true`; pi-mcp-adapter registers `/mcp`, so the
  built-in was skipped and pi warned about it. `-builtin:mcp` added to
  `settings.json` `extensions` to make that deliberate and silence the warning.
- Declared surface after the jump: **37 tools**, `mcp` present, `mcpScript` absent.
- `pi-spawn.ts` passes `--mode/--model/--thinking/--tools` with values and folds the
  provider into a qualified model id, so 0.99's CLI-argument changes miss us.

### Verified

`verify-patches.sh` 14/14 PASS. Headless `pi --mode json -p --model grok-4.6
--provider xai` replied `UPDATE_0991` as `provider: xai`, `model: grok-4.6`.
A `finder` sub-agent spawned a real child on 0.99.1 and returned cited line numbers.

### Packages updated after the core jump

A bare `pi install npm:<name>` cannot cross a caret boundary. `~/.pi/agent/npm/
package.json` held `pi-codex-goal ^0.3.1` (a 0.x caret pins the minor) and
`pi-mcp-adapter ^2.38.0` (a 2.x caret pins the major), so `pi install` landed
2.38.0 and reported codex-goal as "up to date". Explicit versions are required:

```bash
pi install npm:pi-codex-goal@0.4.1
pi install npm:pi-mcp-adapter@3.3.0
```

**pi-mcp-adapter 3.x moved its global config and no longer reads Pi's path.**
`config.ts:16` resolves the generic global config to `~/.config/mcp/mcp.json`, and
`state.ts:48` tracks "legacy mcp.json files the adapter ignores" — so
`~/.pi/agent/mcp.json` is dead config to 3.x, and without the migration the `mcp`
tool comes back with **zero servers, silently**. The body was copied verbatim: the
`{ mcpServers, settings? }` shape is unchanged and `scriptMode` still exists
(`types.ts:638`, still gates `mcpScript` at `index.ts:1529`). Only the path moved.
`~/.pi/agent/mcp.json` was deliberately left in place as a fallback for the
built-in extension. `install.sh` now deploys to `~/.config/mcp/mcp.json`.

`directTools` still defaults **off** (`mcp-references.ts:72` needs an explicit
`true`/`"search"`), so the one-`mcp`-proxy design and the 37-tool surface survive.

Adapter 3.3.0 peer-declares `@earendil-works/pi-ai: ^0.84.1 || … || ^0.87.0` — that
is, not 0.99. Nothing failed, but support is undeclared.

Verified: 37 declared tools with `mcp` present and `mcpScript` absent,
`mcp-scripting` absent from the loaded skills, and all 19 servers listed through
3.3.0 at the new path. `pi install` did not disturb the pi-sub grok patch or the
stale-ctx guard (verify-patches still 14/14), and the width patcher was re-run for
the fresh package copies. `pi-claude-code-use` is still pinned `@1.0.5`.

---

## 0.87.1 (2026-09-23) — from 0.87.0; patched files unchanged, copied

Catalog + default release. Install is still
`npm install --prefix /opt/homebrew -g --force --ignore-scripts
@earendil-works/pi-coding-agent@0.87.1` then re-pin `pi` → `dist/cli.js`.
Do **not** `pi update` (EBADDEVENGINES) and do **not** `pi update --extensions`.

**Patch drift (stock 0.87.0 vs stock 0.87.1, registry tarballs):**
- resource-loader.js, session-selector.js, keybindings.js — byte-identical →
  stored 0.87.0-derived patches copied clean.
- args.js — `--mode` now errors on missing/invalid value. `pi-spawn.ts:406-407`
  already passes `--mode json` / `--mode rpc` with a real value next to the flag.
- model-resolver.js — one line: `xai: "grok-4.6"` → `xai: "grok-4.7"`.
  settings.json still pins `defaultModel: grok-4.6`; catalog still lists 4.6.
- compaction.js — turn-prefix summarization prompt only. `compaction.enabled: true`.
- pi-tui 0.87.1 `dist/` byte-identical to 0.87.0. Width patcher applied to the
  fresh `/opt/homebrew/.../pi-tui@0.87.1` copy; anchor intact.
- pi-agent-core / chord — package.json only.
- bin still dist/bundle/cli.js stock → re-pinned to dist/cli.js.

**Not installed this jump:** `pi-codex-goal` 0.3.0→0.3.1 (docs/CI only, runtime
unchanged) and `pi-mcp-adapter` 2.33.0→2.37.0 (scriptMode gate still
`earlyConfig.settings?.scriptMode !== false` at index.ts:1507, `mcp` proxy still
index.ts:1782; 2.35 also hides `mcp-scripting` when scriptMode is false). Check
landed, packages left at current versions.

verify-patches.sh 14/14 PASS. Headless `pi --mode json -p --model grok-4.6
--provider xai --thinking high --tools read,grep,find,ls` replied
`UPDATE_OK_0871` with `provider: xai`, `model: grok-4.6` (not 4.7).

---

## 0.87.0 (2026-09-22) — from 0.85.1; patches re-derived, not copied

Jump is 0.85.1 → 0.87.0 (through 0.86.0 / 0.86.1). Install is still
`npm install --prefix /opt/homebrew -g --force --ignore-scripts
@earendil-works/pi-coding-agent@0.87.0` then re-pin `pi` → `dist/cli.js`.
Do **not** `pi update` (EBADDEVENGINES) and do **not** copy the stored 0.85.1
patch files over 0.87.

**Patch drift (stock 0.85.1 vs stock 0.87.0, registry tarballs):**
- resource-loader.js — DIFFERS outside our hunk: prompt-template load now keeps
  diagnostics (`loaded.templates` / `deduped.diagnostics`). Conflict loop still
  at `for (const conflict of conflicts)`. Re-derived: 0.87 stock + conflict
  suppression only (detect, do not push to `errors`).
- session-selector.js — LARGE: `selectionTouched`, progressive `--resume`
  loading, `toggleScope` rewrite. Re-derived: 0.87 stock + pin helpers, hint,
  `applyPinning`, 📌 prefix, Ctrl+B handler, `onTogglePin`. Copying the 0.85.1
  stored file would wipe resume loading.
- keybindings.js — one upstream string (`app.message.copy` description) plus
  our three hunks (`app.session.pin`, `pinSession` mapping, `isRecord` guard).
- args.js — `META_API_KEY` doc only. `--model` / `--provider` / `--tools` /
  `--thinking` / `--mode` unchanged → pi-spawn fine.
- bin still `dist/bundle/cli.js` → re-pin to `dist/cli.js`.
- pi-tui 0.87.0 `graphemeWidth` still has our anchors (`zeroWidthRegex` return
  0, `return width`) and also added spacing-mark / Indic counting. Width
  patcher still applies (overcount is smear-safe). Dry-run on install.
- pi-server still not imported. compaction still has `getSummarizationFailure`
  and no `toolChoice`.

**Extension changes in this jump (in-repo, before install):**
- editor clipboard: `@mariozechner/clipboard` is gone. load
  `dist/utils/clipboard-image.js` `readClipboardImage` from the running
  `dist/cli.js`; keep `[image #N]`. unset `onPasteImage` if it cannot load.
- editor `embedWorkingStatus: true` so compaction/retry status reaches
  `super.render()`; `LabeledEditor` pulls it into the top border via
  `workingStatusIndicator.renderInBorder`.
- llama: keep `/local` + `llama-local`. gate `llama.cpp` too so `/llama`
  cannot dump the amp prompt on a local model.
- `cacheWarming: "off"` in settings.json (0.86 default is `streaming`).

**Not done until the live install:** npm install, bin re-pin, copy the three
re-derived files onto `$PI/dist`, width-patcher, deploy extensions, verify-patches,
headless boot + one sub-agent spawn. Do **not** `pi update --extensions`.

---

## pi-sub-core stale-ctx guard (2026-09-12)

No version changed. `/resume` exited pi with "This extension ctx is stale after
session replacement or reload", thrown from `pi-sub-core/index.ts:120` under
`controller.ts:143` — the emit *after* a usage fetch resolved.

Chain: the 60s usage timer (or `turn_end`) starts a fetch → pi tears the outgoing
session down (`agent-session-runtime.js:102-113`: abort → `session_shutdown` →
dispose) → `dispose()` calls `_extensionRunner.invalidate()
(`agent-session.js:595`) → the fetch resolves after that → `pi.events.emit` →
`loader.js:367` `assertActive` → throw. `session_shutdown` clears the timers but
cannot cancel a fetch already in flight, and the timer caller is a bare
`void refresh(lastContext)` (`index.ts:215`), so the throw is an unhandled
rejection → `uncaughtCrash` → `process.exit(1)`.

Upstream is 1.5.0 (2026-03-25) with no fix, so it is ours:
`pi-sub-patches/apply-sub-core-stale-guard.mjs` routes all 5 `pi.events.emit`
sites in `index.ts` through a guarded `emitEvent` that no-ops once the runtime is
stale and stops the refresh timers. `install.sh` applies it; `verify-patches.sh`
audits it with `--check`.

`pi-sub-bar` is not exposed to this path — its async session work compares
`lastContext !== sessionContext` before every emit (`index.ts:1062-1082`).

Do not vendor `pi-sub-core/index.ts` wholesale: upstream changes it every
release and a stored copy would silently revert their fixes. The patcher fails
loudly when the anchors move (it expects exactly 5 emit call sites).

---

## Packages (2026-09-12) — pi-mcp-adapter 2.32.1 → 2.33.0

Updated only this package (`pi update --extension npm:pi-mcp-adapter`, never
`--extensions` — pi-claude-code-use stays held at 1.0.5):

- **pi-mcp-adapter 2.32.1 → 2.33.0.** OAuth/reliability plus `mcp({ action:
  "install" })`, optional `directTools: "search"`, and opt-in `claudePlugins`.
  Both suppressions survive: the mcpScript gate is still
  `earlyConfig.settings?.scriptMode !== false` (index.ts:1124) and the `mcp`
  proxy is still the second registration (index.ts:1380). mcp.json keeps
  scriptMode:false and settings.json keeps the `{source, skills:[]}` object form
  (same sha as before the update), so the tool surface is `mcp` + no
  `mcpScript`, and `mcp-scripting` stays filtered. No `claudePlugins` in
  mcp.json, so the new plugin-bundle loader is inert. Adapter ships no pi-tui.

Width patcher: no fresh unpatched pi-tui. verify-patches.sh all PASS; headless
boot replied PKG_OK with mcp yes / mcpScript no / mcp-scripting no. Nothing
else moved (token-burden 0.6.5, tool-display 0.5.0, codex-goal 0.3.0, sub-bar
1.5.0, claude-code-use 1.0.5).

---

## Packages (2026-09-08) — pi-autoresearch 1.7.0 → 1.8.1, pi-codex-goal 0.2.1 → 0.3.0

Updated only the two packages with newer releases (`pi update --extension`, never
`--extensions` — pi-claude-code-use stays held at 1.0.5):

- **pi-autoresearch 1.7.0 → 1.8.1** (git, main @703a8f1). 1.8.0 adds discard
  revisit nudges + `asi.revisits_run` transcript badge; 1.8.1 fixes
  `/autoresearch <goal>` kickoff so `sendUserMessage` expands the skill
  (`expandPromptTemplates: true`, needs pi ≥ 0.84.2). Shortcut config
  (`pi-autoresearch.json` → `ctrl+shift+r`) untouched by the git update.
- **pi-codex-goal 0.2.1 → 0.3.0.** New explicit `token_budget` must be an integer
  ≥ 500_000 (rejected, not raised); omitted budgets still unlimited; existing
  saved budgets unchanged. Declares `engines.node: >=24.0.0` — installs under
  node 22 with an EBADENGINE warning only; headless boot still fine.

Width patcher: no fresh unpatched pi-tui. verify-patches.sh all PASS; headless
boot replied PKG_OK. Nothing else had a newer release.

---

## 0.85.1 (2026-09-06) — from 0.85.0; experimental server removed, keybindings re-derived

Install (same devEngines workaround): `npm install --prefix /opt/homebrew -g
--force --ignore-scripts @earendil-works/pi-coding-agent@0.85.1`.

**Patch drift (stock 0.85.0 vs stock 0.85.1, registry tarballs):**
- resource-loader.js, session-selector.js — byte-identical → stored patches copied clean.
- keybindings.js — DIFFERS: upstream added `app.thinking.save` (ctrl+s) near
  line 38. Our three hunks (`app.session.pin` block, `pinSession` mapping,
  `isRecord` guard) untouched. Re-derived: inserted the upstream block into the
  stored patch; diff vs stock 0.85.1 shows exactly our hunks, nothing else.
- args.js — two env-var doc lines removed (PI_SERVER_DIR/PI_SERVER_ID) only;
  no --tools/--model/--provider change → pi-spawn unaffected.

**pi-server landmine RETIRED.** 0.85.1 removed the whole experimental server
layer: dist/experimental/ is gone, modular dist/cli.js is `setupCli(); main()`,
and nothing imports `@earendil-works/pi-server`. install-pi-server.sh is
0.85.0-only now; verify-patches auto-reports "not needed".

pi-tui 0.85.1 — utils.js byte-identical to 0.85.0, width-patch anchor present;
re-applied. bin still dist/bundle/cli.js stock → re-pinned to dist/cli.js.

**Verified:** pi --version 0.85.1 · verify-patches.sh all PASS · headless boot
replied UPDATED_OK. Rollback: ~/pi-update-backup-0.85.0-20260906-194608.

Packages (same run): pi-codex-goal 0.2.0 → 0.2.1 (`pi update --extension
npm:pi-codex-goal`) — packaging only (npm artifact ships precompiled
dist/index.js; git installs still load src/index.ts; tools/prompts unchanged).
pi-claude-code-use untouched at 1.0.5 (held deliberately).

---

## 0.85.0 (2026-09-04) — from 0.84.4; fable 5.1 official, client-version patch retired

Install (same devEngines workaround): `npm install --prefix /opt/homebrew -g
--force --ignore-scripts @earendil-works/pi-coding-agent@0.85.0`.

**New landmine: `@earendil-works/pi-server` is undeclared.** 0.85.0's modular
`dist/cli.js` statically imports `dist/experimental/server.js`, which imports
`@earendil-works/pi-server` (lines 10-11) — a package upstream ships on npm
(0.85.0, devEngines null) but forgets to list in package.json (deps, optional,
peer all absent). The bundle inlines it; our modular re-pin crashes every command
with ERR_MODULE_NOT_FOUND. npm install into the package dir fails here (arborist
"Cannot read properties of null (reading 'edgesOut')"), so the fix is a new
`pi-core-patches/install-pi-server.sh` that curls the matching-version tarball into
`$PI/node_modules/@earendil-works/pi-server` (its deps chord/pi-agent-core/pi-protocol
are already pi's own). verify-patches guards on `dist/experimental/server.js` — NOT
cli.js, which references it only as `./experimental/server.js`.

**Patch drift (stock 0.84.4 vs stock 0.85.0, registry tarballs):**
- resource-loader.js, keybindings.js, session-selector.js — byte-identical.
- args.js — two added env-var doc lines (PI_SERVER_DIR/PI_SERVER_ID) only;
  --tools/--model/--provider untouched → pi-spawn.ts unaffected.
- bin = dist/bundle/cli.js again → re-pin to dist/cli.js (verify-patches guards).
- pi-tui 0.85.0 — width-patch anchors present; re-applied.

**fable 5.1 is official now.** pi-ai 0.85.0 `dist/providers/data/anthropic.json`
carries claude-fable-5-1: 1M ctx, 128k maxTokens, thinkingLevelMap off/xhigh/max,
cost 10/50/0.25/12.5, compat + `supportsMidConvoEffort` (the new persistent-effort
feature) — i.e. our old custom models.json entry plus the new flag. claudeCodeVersion
also bumped upstream 2.1.75 → 2.1.251.

**Retired the anthropic client-version patch.** `apply-anthropic-client-version.mjs`
deleted; its install.sh/verify-patches.sh/AGENTS.md wiring removed. Dropped the
custom fable block from models.json (modelOverrides kept); enabledModels entry stays.
Two vendored tools copies reverted to stock 2.1.75 (backed up).

**Verified:** `pi --version` 0.85.0 · verify-patches.sh all PASS · headless
`--provider anthropic --model claude-fable-5-1` replied OFFICIAL_0850 (official
catalog + stock 2.1.251 on Max OAuth — the old patch's whole reason is gone).
Rollback: ~/pi-update-backup-20260904_1818.

---

## Packages (2026-09-04) — post-0.85.0, pi-mcp-adapter 2.27.0 → 2.32.1, pi-autoresearch 1.6.2 → 1.7.0

Updated the two packages with newer releases (`pi update --extension`, never
`--extensions` — pi-claude-code-use stays held at 1.0.5):

- **pi-mcp-adapter 2.27.0 → 2.32.1.** Big restructure (TS source at package root,
  new UI/app-bridge layer). Both suppressions survive: the mcpScript gate is still
  `earlyConfig.settings?.scriptMode !== false` (index.ts:971) and the `mcp` proxy
  is still the second registration (index.ts:1020). mcp.json keeps scriptMode:false
  and settings.json keeps the `{source, skills:[]}` object form, so the tool surface
  is `mcp` + no `mcpScript`, and `mcp-scripting` stays filtered.
- **pi-autoresearch 1.6.2 → 1.7.0** (git, main @4182079). The ctrl+shift+r shortcut
  config (pi-autoresearch.json) is untouched by the git update.

Width patcher found no fresh unpatched pi-tui in either. verify-patches.sh all
PASS; headless boot replied PKG_OK. Nothing else had a newer release (token-burden
0.6.5, tool-display 0.5.0, codex-goal 0.2.0, sub-bar 1.5.0 all current).

---

## 0.84.4 (2026-08-30) — from 0.84.3; upstream fixed the /compact bug, patch retired

**`pi update` is broken on this machine.** The npm package declares
`devEngines: { packageManager: bun }`; npm 10.9.4 hard-fails install/view/pack
with EBADDEVENGINES, and `pi update` shells out to plain
`npm install -g --ignore-scripts --min-release-age=0` (no `--force`), so it
dies the same way. Working install (dry-run verified first):

```bash
npm install --prefix /opt/homebrew -g --force --ignore-scripts @earendil-works/pi-coding-agent@0.84.4
```

`--prefix /opt/homebrew` is required: `npm root -g` here is the nvm root, not
the homebrew root pi runs from. `--force` is what bypasses the devEngines
check.

**Patch drift (stock 0.84.3 vs stock 0.84.4):**
- `resource-loader.js`, `keybindings.js`, `session-selector.js`,
  `dist/cli/args.js` — byte-identical. Stored patches re-applied as-is.
- `compaction/compaction.js` — CHANGED: upstream REMOVED the
  `toolChoice: "none"` we patched around in 0.84.3 (pi-mono #8649/#8638) and
  added `getSummarizationFailure` (rejects incomplete `length` stops). The
  stored patch is RETIRED and deleted from `pi-core-patches/` (recoverable from
  git history and `~/pi-update-backup-20260830_0843`). Compaction is now STOCK;
  verify-patches gained a guard that FAILS if `toolChoice` reappears in that
  file or `getSummarizationFailure` goes missing. Do NOT copy a stored file
  over compaction.js.
- pi-tui bundled `^0.84.4` — width patch anchors present; re-applied to the
  new copy (all other copies were already patched).

**Also on 0.84.4:** terminal capability overrides, `ui_prompt_start`/`_end`
extension events, RPC `clear_queue`, fullscreen selection copy, DeepSeek V4
Flash Vision exp. Spawn CLI flags unchanged. `@mariozechner/*` compat aliases
still present. `pi update` does not touch extensions; pi-mcp-adapter stayed
2.27.0 and pi-claude-code-use stayed 1.0.5 (still held).

**Verified live, not just by import audit:** `pi --version` 0.84.4 · modular
bin re-pinned to `dist/cli.js` (npm relinks bin to the bundle on install) ·
headless session replied `UPDATE_OK_0844` · one real sub-agent spawn
(`--tools read,grep,find,ls --model grok-4.5 --provider xai`) exit 0 with
session JSON streaming · tool surface has `mcp`, no `mcpScript` ·
`verify-patches.sh` all PASS. Rollback: `~/pi-update-backup-20260830_0843`
(3 patched 0.84.3 dist files, package.json, settings.json, mcp.json, auth.json,
bin link).

---

## 0.84.3 (2026-08-24) — from 0.84.2; the bundled-runtime release

**The one that changed the update procedure, not just the patches.** 0.84.3's
`bin` field points at `dist/bundle/cli.js` (0.84.2's pointed at the modular
`dist/cli.js`). The bundle inlines its own copies of resource-loader,
keybindings, session-selector and pi-tui, and loads **zero** on-disk
`dist/core/*` or `dist/modes/*` files — so after `pi update`, npm relinks the
bin to the bundle and every core patch goes silently inert while
`verify-patches.sh` still passes (it greps files that exist but are never
loaded).

**Fix, adopted as the standing procedure:** re-pin the bin to the modular
entrypoint after every update —

```bash
ln -sfn ../lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js /opt/homebrew/bin/pi
```

`dist/cli.js` still ships in 0.84.3 and loads the modular core, so all three
patches + the width patch keep working; the only loss is the bundle's
startup-speed win. `verify-patches.sh` gained an entrypoint check that FAILS
loudly if the bin ever resolves to `dist/bundle/cli.js`.

**Patch drift (stock 0.84.2 vs stock 0.84.3):**
- `session-selector.js` — byte-identical. Deployed as-is.
- `resource-loader.js` — added `stripBom` import + two call sites, **outside**
  our patch region. RE-DERIVED onto fresh stock (suppression edit re-applied).
- `keybindings.js` — added `stripBom` + `useWindowsKeybindings`/`windowsKeybindings`
  machinery (macOS branches identical to 0.84.2 defaults), and `loadRawConfig`
  now strips BOM + inline-guards (equivalent to our `isRecord` there). RE-DERIVED:
  only the pin entry, `pinSession` migration and `toKeybindingsConfig` guard
  re-added; upstream's stripBom/windowsKeybindings kept.
- pi-tui bundled `^0.84.3` — width patch anchors all present; re-applied.
  Post-patch `patched >= stock` verified on 28 tokens (never lowers a width);
  the 6 DSR-measured vectors (हिंदी 4, क्त्र 3, বাংলা 5, 🖐 2, 日本語 6,
  👨👩👧👦 2) match exactly.

**Extension-migration verdict (asked for, investigated, answered):** the three
core patches **cannot** be moved to extensions — no API seam. The loader's
conflict diagnostics run during extension loading before any extension exists;
the session picker (`SessionSelectorComponent`, constructed directly at
`interactive-mode.js:4303`) has no override hook; pi-tui's `graphemeWidth` is a
non-exported function inside the module. A tool-name conflict scan found zero
live conflicts, so the resource-loader patch is a dormant safety net. Do not
re-attempt this migration; the pin above is the supported path.

**Also on 0.84.3:** `args.js` adds `--` end-of-options parsing and a
Windows-only `powershell` tool — none of `--tools/--model/--provider/--mode/
--thinking/--append-system-prompt` changed, so `pi-spawn.ts` is unaffected.
`@mariozechner/*` compat aliases intact. No new macOS keybinding conflicts.
`pi update` does not touch extensions, so pi-mcp-adapter stayed 2.27.0 and
pi-claude-code-use stayed 1.0.5 (still held).

**Verified live, not just by import audit:** `pi --version` 0.84.3 · headless
session replied `UPDATE_OK_0843` · one real sub-agent spawn (`--tools
read,grep,find,ls --model grok-4.5 --provider xai`) exit 0 with session JSON
streaming · tool surface has `mcp`, no `mcpScript` · `verify-patches.sh`
11/11 PASS. Rollback: `~/pi-update-backup-20260824_0842` (3 patched 0.84.2
dist files, VERSION, auth.json, settings.json, mcp.json).

**Post-install regression found same day — /compact 400s on xAI/OpenAI.**
0.84.3 added `toolChoice: "none"` unconditionally to every compaction
summarization request (`completeSummarization`, `dist/core/compaction/
compaction.js`), but the summarization context carries no tools, and the
Responses adapter serializes `toolChoice` → `tool_choice` whenever set
(`pi-ai/dist/api/openai-responses.js:239-240`). xAI and OpenAI reject
`tool_choice` without `tools` ("Invalid request content: A tool_choice was
set on the request but no tools were specified."), so `/compact` died with
"Compaction failed: Summarization failed: OpenAI API error (400)". Reproduced
live against `api.x.ai` before fixing. **Fix: fourth core patch**
(`pi-setup/pi-core-patches/compaction.js`) — `toolChoice` is now only set when
`context.tools?.length` is non-empty, which is never for summarization.
Deployed, module-verified (no toolChoice in requestOptions for a tool-less
context), and `verify-patches.sh` gained a guard for it (now 12 checks).
When upstream fixes this, drop the patch and re-verify /compact.

---

## 2026-08-14 — duplicate-copy cleanup (~3.0 GB), same day as 0.84.2

Not a version migration, but it belongs here because it changes **where packages
may live** and it fixed a latent hazard that a future update could have tripped.

**Three npm roots held the same pi packages at different versions.** pi loads
`npm:` packages only from `~/.pi/agent/npm/node_modules`
(`getManagedNpmInstallPath`, `dist/core/package-manager.js:1710-1719`). The other
two — `/opt/homebrew/lib/node_modules` (which also holds the pi binary) and
`~/.nvm/versions/node/v22.22.0/lib/node_modules` (what a bare `npm root -g`
resolves to) — held 18 stale pi packages between them, some ancient
(`pi-context@1.1.4` against the live 2.1.2).

**The hazard was not disk.** `getNpmInstallPath` (`package-manager.js:1728-1735`)
falls back to `join(npm root -g, name)` when a package is **missing** from the
managed store, and our `packages` entries pin no version. The nvm root held
`@benvargas/pi-claude-code-use@2.2.0` — the exact version AGENTS.md deliberately
holds at 1.0.5 — so one missing managed copy would have silently loaded it. An
earlier note in this repo claiming "no fallback to any global root" was **wrong**;
the fallback is real and was read at the call site to confirm.

**Second finding: 8 of those copies bundled UNPATCHED pi-tui** while
`verify-patches.sh` reported "ALL copies patched", because
`apply-pi-tui-width-patch.mjs` only searched `/opt/homebrew` and `~/.pi/agent`
— never `npm root -g`. Grepped each: no `__clusterAdvance`. So the audit was
blind exactly where the loadable-fallback root was.

Removed: 11 pi packages from the homebrew root (keeping
`@earendil-works/pi-coding-agent`, the binary), 7 from the nvm root
(`npm uninstall -g pi-mcp-adapter` for the one with a bin link, `trash` for the
rest), and **5** dangling symlinks in `~/.pi/agent/node_modules/` — four
`@mariozechner/*` plus `@sinclair/typebox`, all pointing at the pre-rename
`@mariozechner/pi-coding-agent` path. The whole `node_modules` dir is gone; pi
never constructs `join(agentDir, "node_modules")`.

pi-tui copies: **24 → 4**, all patched, all actually loaded.

**Two fixes so it cannot regress:**
- `apply-pi-tui-width-patch.mjs` now also scans `npm root -g` and the running
  pi's own root. **Verified by sabotage**: a fake unpatched copy planted in the
  nvm root is now found and flagged (exit 1); the old script saw nothing.
- `install.sh`'s `pi-claude-bridge` block is gone. It had been **broken for
  months**: `npm list -g` / `npm install -g` hit the nvm root while the patch
  block hardcoded `/opt/homebrew/...`, so the check always failed, the install
  went to one root and the patch was applied to a copy in another. Reinstall
  commands are preserved as comments.

**Verified after each step** (not just at the end): `pi --version`; a live
headless run asserting `mcp` + `context_compact` + `get_goal` still resolve —
deliberately three tools from three *different* packages whose duplicates had
just been deleted; then `apply_patch` + `screenshot` + `web_search` + `chad` to
prove the custom extension tools (which import `@mariozechner/pi-tui`, the
specifier those dead symlinks pretended to serve) still load; clean stderr; no
dangling bin symlinks in either root; `verify-patches.sh` 9/9 PASS.

One scare worth recording: `netlify` was missing from PATH afterwards. It was
**pre-existing and unrelated** — netlify-cli 24.4.0 is intact, but its bin links
are npm's *temporary* names (`.netlify-3lxmSHT1`, `.ntl-egPpTo9E`) from an
install interrupted on 5 Mar. Check timestamps before blaming your own change.

**Second pass, same day — stale artifacts (~5.1 GB more).** Eight backup dirs
from earlier migrations (2.6 GB `~/.pi/agent-backup-20260517`, 2.2 GB
`~/.pi-backup-20260423-204604`, `pi-cleanup-`, `pi-port-`, four `pi-update-`),
`~/.pi/agent/extensions-disabled/`, a Feb `agent/backups/` settings snapshot, one
stale md-export file, and an empty untracked `pi-setup/extensions/tools/.pi/todos`.

Each was **proved** redundant rather than assumed: the two large backups' session
files were diffed by name against the live store — 2,235 and 619 sessions,
**zero unique to either**; every extension inside them was confirmed in git
history (`git log --all -- <path>`). `pi-sessions-extracted/` was kept as a
directory because `md-export.ts:584` uses it as a fallback output dir.

**A third hazard surfaced in that pass:** the repo's own
`pi-setup/extensions/tools/node_modules` held 3 **unpatched** pi-tui copies, and
install.sh copies that directory straight into the loaded path (`:102`). It
re-patches at `:250`, so ordering saved it — but correctness depending on step
order inside one script is fragile, and a manual `cp -R` deploy would have
installed unpatched copies into the live path. `apply-pi-tui-width-patch.mjs`
now also scans its own repo checkout, so the deployment SOURCE is patched.
Final count: **7 copies, all patched** (4 loaded + 3 deployment-source).

Verified afterwards: repo vs deployed is byte-identical for extensions, themes,
agent prompts, config skills and every config file except `settings.json`, whose
only diff was `lastChangelogVersion` (runtime state pi writes itself; repo bumped
to match) and JSON formatting pi rewrote — the load-bearing
`{ source, skills: [] }` object form is intact.

**`@benvargas/pi-claude-code-use` was NOT updated** and is still **1.0.5**,
mtime 17 Jul. Only `pi update --extension npm:pi-mcp-adapter` was run, never
`pi update --extensions`, which would have bumped it. Exactly one copy of it now
exists on the machine.

Everything went to Trash, recoverable. Inventory snapshot:
`/tmp/pi-cleanup-baseline.txt`.

---

## 0.84.2 (2026-08-14) — from 0.84.1, + pi-mcp-adapter 2.25.0

First release with **zero drift in all three patched core files** — stock 0.84.1
and stock 0.84.2 `resource-loader.js`, `session-selector.js` and
`keybindings.js` are byte-identical, so the stored patches were copied rather
than re-derived. They were still diffed from real tarballs first; the standing
rule is unchanged.

**pi-tui 0.84.1 → 0.84.2**, so pi core brought one fresh unpatched copy. The
apply script reported `patched v0.84.2` for it and `already-patched` for the
other 15; `--check` is clean across all 16.

**Four changelog lines looked dangerous and were each read at the call site**
rather than trusted — this is the class that took out every sub-agent in 0.84.0
(#7327):

- **`defaultTools` (new setting, new tool-selection path).** `sdk.js` now reads
  `options.tools ?? (noTools ? [] : (configuredDefaultToolNames ?? defaultActiveToolNames))`.
  `--tools`, which is what `lib/pi-spawn.ts` passes, still wins outright, and we
  do not set `defaultTools`. Behaviour identical for us. **If we ever set
  `defaultTools`, re-read this line** — it sits directly upstream of every
  sub-agent's tool surface.
- **"Fixed custom system prompts concatenating the current working directory
  with later appended prompt content" (#7887).** The entire `system-prompt.js`
  diff is one trailing `\n` after `Current working directory: …`. No effect on
  our `system-prompt.ts` or on `--append-system-prompt`.
- **"Experimental strict JSON-schema constrained sampling for the default read,
  bash, edit and write tools".** Gated on `PI_EXPERIMENTAL=1`
  (`core/experimental.js`) and applied to pi's *built-ins*, which our tools
  replace. **This is not the `apply_patch` grammar trap** — that one throws in
  `resolveGrammarConstrainedSampling` for tools that declare
  `constrainedSampling` themselves, and ours still declares none.
- **"Fixed fallback rendering for extension tool results" (#7979).** Only
  touches the path for tools with no custom renderer; ours all render
  themselves.

**One regression this audit did NOT predict: a new keybinding conflict.** pi-tui
0.84.2 added `ctrl+shift+f` (fullscreen transcript search) and `ctrl+shift+g`,
and `pi-autoresearch` defaults its dashboard to `ctrl+shift+f` — so every startup
printed `Extension shortcut conflict` and the extension won, shadowing the new
built-in. The pre-install diff missed it because it compared pi **core**'s
`dist/core/keybindings.js` (byte-identical, correctly reported) while the new
binding shipped in the **pi-tui** package under the `tui.*` namespace. Lesson:
when a release adds a TUI feature with a shortcut, grep the new **pi-tui** for
`ctrl+`/`alt+` bindings too, not just pi core's keybindings map. Fixed via
autoresearch's own config file (`pi-setup/extensions/pi-autoresearch.json`,
`fullscreenDashboard: "ctrl+shift+r"`) rather than patching a git-installed
package that an update would overwrite.

Also checked because our extensions depend on them: `cli/args.js` gained
**`--use-theme` and nothing else** (`--tools`, `--model`, `--provider`,
`--mode`, `--thinking`, `--append-system-prompt` untouched), and
`interactive-mode.js` still guards with `if (!customEditor.onPasteImage)`, so
the editor's clipboard-image placeholder still wins.

**pi-mcp-adapter 2.21.0 → 2.25.0.** Both suppressions survive: the gate is
still `earlyConfig.settings?.scriptMode !== false` (`index.ts:651`), there are
still exactly two `registerTool` sites (`mcpScript`, `mcp`), and the shipped
`skills/` dir still contains only `mcp-scripting`. 2.24 added per-server
`searchKeywords`; 2.25 **changes the DEFAULT tool-result rendering** from the
boxed row to compact self-rendered rows — it measures with pi-tui's own
`truncateToWidth`/`visibleWidth`, i.e. the exact invariant our width work
requires, so it cannot reopen the smear/crash class. `settings.toolResultRendering:
"boxed"` restores the old row if the compact one is disliked.

**Verified live, not just by import audit:** `verify-patches.sh` 9/9 PASS before
and after; a headless session reports `mcpScript` absent / `mcp` present and no
`mcp-scripting` skill; and one real `finder` sub-agent was spawned against the
new binary and came back with correct cited output.

Only the two requested packages moved — `@benvargas/pi-claude-code-use` is still
**1.0.5**, and pi-context/pi-token-burden/pi-tool-display/pi-codex-goal are
unchanged (`pi update --extension npm:pi-mcp-adapter`, never `--extensions`,
which would have bumped the held-back one).

No backup dir: `install.sh` was not run, so the patches were re-applied by hand
(three `cp`s + the width script) as documented in AGENTS.md's quick re-patch
block.

**Machine note, found while auditing.** There are **three** npm global roots
here and they hold different versions of the same pi packages:
`/opt/homebrew/lib/node_modules` (where the `pi` binary itself lives),
`~/.nvm/versions/node/v22.22.0/lib/node_modules` (what a bare `npm root -g`
resolves to — it has `@benvargas/pi-claude-code-use@2.2.0`, the version we
deliberately do **not** want), and `~/.pi/agent/npm/node_modules` (the only one
pi actually loads packages from). Read package versions from the agent dir; a
bare `npm ls -g` reports the nvm root and will mislead you.

---

## 0.84.1 (2026-08-08) — from 0.83.0, + pi-codex-goal 0.2.0, pi-mcp-adapter 2.21.0

`@benvargas/pi-claude-code-use` deliberately **held at 1.0.5** (2.1.0 exists).
Audited against real tarballs before installing anything.

**Held-back package verified safe on 0.84.1.** 1.0.5 uses exactly one registry
API — `ctx.modelRegistry.isUsingOAuth(model)` — whose signature is unchanged,
so the `getApiKeyAndHeaders` → `string | null` breaking change misses it.
`before_provider_request` and the `PI_CLAUDE_CODE_USE_DISABLE_TOOL_FILTER` gate
are intact; all its imports still alias. Its `buildCaptureShim` lacks 0.84's new
`registerMarkdownTransformer`, which is harmless: `satisfies` is compile-time,
jiti does not typecheck, and the capture path only runs for exa/firecrawl
companions (not installed) or `toolAliases` in settings.json (we have none).
2.x's only ≥0.84 feature is display-only un-cloaking of `mcp__*` alias mentions
in assistant prose — it requires registered MCP aliases, which we never have.

**Breaking changes: none reach us.** Grepped our sources for every one
(`ModelsStreamTransforms`, `setRuntimeApiKey`, `modelRegistry.refresh`,
`getApiKeyAndHeaders`, `refreshToken`, `registerProvider`, `context.store`,
`JsonlSessionRepo`, `assistantMessageEvent`) — **zero hits**. The v4 lane-based
session rewrite is pi-agent-core *harness* API; the coding agent's own session
writer is untouched (`session-manager.js` diff is 6 lines, symlink discovery),
so our JSONL-parsing tools are safe. `dist/tools/` has **zero** changes, so the
nine tool overrides are safe.

**pi-core patches (verified stock 0.83.0 vs stock 0.84.1):**
- `resource-loader.js` — **RE-DERIVED.** 0.84.1 added `AGENTS.override.md` to the
  context-file candidate list (line 32) plus a comment reword, both **outside**
  our patch region (`addExtensionConflictDiagnostics`, same line numbers).
  Applied the suppression edit onto live stock 0.84.1, then copied live → repo.
  Blind-copying would have reverted the override feature.
- `keybindings.js` + `session-selector.js` — **0 upstream drift** (stock
  byte-identical). Repo copies deployed as-is; `app.session.pin` ×2,
  session-selector 7 `LOCAL PATCH`.
- pi-tui width patch — **the one to actually think about this release.** 0.84.0
  shipped #6987, upstream's own fix for Indic conjunct width, reworking
  `graphemeWidth` (new `terminalSpacingMarkRegex` early return, `followsMark`
  tracking). **All three of our anchors still match**, and since our patch is
  `max(upstream, __clusterAdvance)` it can only raise widths on the improved
  base — no new undercount, no double-count. Post-patch widths re-measured
  against the DSR vectors: हिंदी 4, क्त्र 3, বাংলা 5, 🖐 2, CJK 6, ZWJ family 2 —
  identical to patched 0.83.0. Patch is now partly redundant, not harmful; keep.

**New in 0.84 that touches us — `normalizeToolResultImages` (#7330).** pi now
runs *every* tool-returned image through Photon (max 2000×2000, 4.5MB) as it
enters history. Our images are already ≤2000px (the `MANY_IMAGE_MAX_EDGE` clamp),
so it returns `wasResized: false` and the original bytes pass through unchanged —
**no double resample, no injected dimension-hint text**. It does decode every
image in a worker to discover that, which defeats the `asis` never-decode fast
path; `images.autoResize: false` disables it if that cost ever matters.
*Correction (2026-10-08):* the pass-through held only under 4.5 MiB — pi also
re-encodes on bytes, and our cap was the API's 10 MB. `image-fit` now caps at
pi's `maxBytes`; keep `autoResize` on, since it also clamps other tools' images.

**Packages (targeted `pi update npm:<pkg>`, never `--extensions`):**
- **pi-codex-goal 0.1.39 → 0.2.0** — minor number, trivial diff: 3 imports moved
  off `@earendil-works/pi-ai/compat` to the root specifier (early compat
  migration; the root still aliases to compat), and `executionMode: "sequential"`
  added to two tool defs (field valid in both 0.83.0 and 0.84.1). Tool names,
  schemas and behaviour unchanged. Note `engines.node: ">=24.0.0"` produces an
  npm EBADENGINE warning on node 22 — **pre-existing, 0.1.39 declared the same**,
  and `/goal` works.
- **pi-mcp-adapter 2.15.0 → 2.21.0** (6 minors) — two default-on behaviour
  changes needed decisions, both taken *against* the defaults:
  - 2.19.0 made **`mcpScript` a default-registered second tool** that executes
    arbitrary JavaScript in a worker. That contradicts the reason this package
    was chosen (one ~200-token proxy tool) and adds an execution surface
    `permissions.json` does not cover. **Disabled** via `settings.scriptMode:
    false` in `mcp.json`.
  - it also ships an **`mcp-scripting` skill**, which after the above would teach
    a tool that does not exist. **Suppressed** via the object-form package entry
    `{ "source": "npm:pi-mcp-adapter", "skills": [] }`. Verified against 0.84.1's
    `collectPackageResources`: with `autoload` unset, `skills: []` filters skills
    to none while `extensions` (undefined) still loads from the pi manifest.
  - riskiest change, **still unverified**: 2.20.0 migrated the MCP client from
    SDK v1 to `@modelcontextprotocol/client`+`/core` 2.0.0 (2.16.0 had rolled
    *back* to v1, so this path has churned). Default `protocolVersion` stays
    `"legacy"`. astro/paper are localhost HTTP with `auth: false`, but **neither
    app was running**, so the transport was never exercised. Test it the next
    time either app is open.

**Also done this pass:** `@mariozechner/clipboard` pinned in
`extensions/tools/package.json`. It is **not** a declared dependency of pi
0.83.0 or 0.84.1 — it was a stale leftover in pi's `node_modules` that npm could
prune at any update, which would have silently degraded editor image paste to
pi's path-insert with no error. AGENTS.md previously asserted it was "pi's own
dep, always present"; that was false and is now corrected.

**Smoke-tested:** `pi --version` 0.84.1 · `verify-patches.sh` 8/8 PASS ·
width-patch `--check` exit 0 · clean `pi -p` boot with real Claude reply
(`UPDATE_OK_0841`) · 38 tools listed incl. all 27 ours and **no `mcpScript`** ·
29 skills and **no `mcp-scripting`** · `get_goal` responds.
Rollback: `~/pi-update-backup-20260808_020648` (auth.json, settings.json,
mcp.json, the 3 patched 0.83.0 dist files, VERSION).

### What this migration BROKE — every sub-agent, and why the audit missed it

**Symptom:** first real session after the update, `oracle` failed instantly with

```
Model "claude-opus-4-6" is ambiguous across providers: anthropic/claude-opus-4-6,
cloudflare-ai-gateway/claude-opus-4-6, opencode/claude-opus-4-6.
More than one matching provider is authenticated. Use --provider or provider/model.
```

`finder`, `code_review`, `librarian`, `read_session` and `read_web_page`'s prompt
path were broken identically — all six carry a **bare** model constant and all six
spawn through `piSpawn`. Only `delegate` was unaffected, because it inherits
`parentModel`, which is already built as `${provider}/${id}`.

**Cause: 0.84.0 #7327**, which the release notes list under *Fixed* —
"bare exact `--model` IDs shared by multiple providers choosing the first catalog
entry instead of the sole authenticated provider or a clear ambiguity error".
Before, `--model claude-opus-4-6` silently resolved to the first catalog entry
(anthropic). Now, with anthropic + cloudflare-ai-gateway + opencode +
github-copilot all authenticated on this machine, `claude-sonnet-5` matches four
providers and `claude-opus-4-6` matches three, so it is a hard error.

Nothing to do with `pi-claude-code-use` — the held-back package was never involved,
though the failure looks like an auth problem and invites that conclusion.

**Fix:** `qualifyModel()` in `lib/pi-spawn.ts`, applied at the single seam every
sub-agent passes through. Tool constants stay bare model names (`claude-opus-4-6`)
— the provider is attached at spawn time, preferring the **parent's own provider**
(the one proven to serve Claude in this session) and falling back to `anthropic`.
Already-qualified ids pass through untouched. Verified across 11 parent/child
combinations including every non-Anthropic inherit path (kimi-code, deepseek,
sakana, llama-local) and delegate's inherit-parent rule; then live in fresh
sessions: oracle, finder, delegate, librarian all return normally.

**Why the audit missed it — the lesson worth keeping.** This exact changelog line
was read, understood, and written into the pre-update report *as a free win*
("Free wins for us: … #7327"). The audit checked the compat surface, the session
format, the patch anchors, the breaking-changes list and every API our extensions
*import* — but never grepped our own code for how it *invokes* pi. A CLI-argument
behaviour change is invisible to an import-level audit.

**Added to the post-update checklist:** grep our own `--model` / `--provider` /
`--tools` call sites (`lib/pi-spawn.ts`) whenever a release touches model
resolution or CLI argument handling. `verify-patches.sh` now asserts
`qualifyModel` is present in the deployed `pi-spawn.ts`, so a stale copy fails
loudly instead of at the first sub-agent call.

---

## 0.83.0 (2026-07-30) — from 0.82.1, + pi-context 2.1.2, pi-codex-goal 0.1.39

Mostly additive, one Breaking Change (TypeBox 1.3.7) our source was clean of.

- **Breaking — TypeBox 1.3.7:** removed `Type.Base/Awaited/Promise/AsyncIterator/
  Iterator/Options` and `Value.Mutate`; fixed compiled validation of nullable
  array tool args (#7243). Grep of our `.ts` source returned zero hits (only
  vendored typebox internals matched). No migration needed.
- **Additive:** `pi auth print-api-key`/`print-bearer-token` with OAuth refresh
  (#7168), headless OpenRouter login, Claude Opus 5 on Copilot, `ctx.scopedModels`
  (#7191), per-request `fetch` injection, `"pending"` stop reason, raw provider
  stop reasons surfacing unmapped terminal reasons as errors (#7272).
- **`resource-loader.js` — RE-DERIVED.** 0.83.0 added `findShadowedContextFile()`
  (worktree shadowing, ~lines 52-80) outside our patch region. Blind-copying the
  0.82.1 file would have reverted that feature.
- `keybindings.js` + `session-selector.js` — 0 drift, deployed as-is.
- **pi-context 2.1.1 → 2.1.2** — adds `didConversationAdvance()` so passive
  session entries no longer cancel a requested compaction. No API change.
- **pi-codex-goal 0.1.38 → 0.1.39** — pauses a goal when a hidden continuation
  run only calls `get_goal` with no actionable progress (#47). Tools unchanged.
- Backup: `~/pi-update-backup-20260730_235801`.

---

## 0.82.1 (2026-07-27) — from 0.82.0, + pi-web-access 0.14.0, pi-mcp-adapter 2.15.0

Purely additive upstream (no Breaking Changes section).

- **Additive:** Claude Opus 5 on Anthropic + Bedrock, `ANTHROPIC_AUTH_TOKEN`
  bearer auth for Anthropic-compatible gateways, `If-None-Match` catalog
  revalidation, `outputPad` for custom renderers (#7045). Helped us directly:
  startup context-file discovery now skips *directories* named like `AGENTS.md`
  (#7106 — we have one).
- **`resource-loader.js` — RE-DERIVED.** 0.82.1 added the `statSync().isFile()`
  EISDIR guard (#7106) outside our patch region; blind-copying would have
  reverted it.
- `keybindings.js` + `session-selector.js` — 0 drift.
- **pi-web-access 0.13.0 → 0.14.0** — its bundled `librarian` **skill** was
  dropped upstream; our custom `librarian` **tool** is separate and unaffected.
  (The package itself was removed entirely three days later.)
- **pi-mcp-adapter 2.11.0 → 2.15.0** — additive; the `get_`→`read_` rename
  affects only generated MCP *resource* tools, not the `mcp` proxy.
- Backup: `~/pi-update-backup-20260727_152216`.

---

## Standing caution — the compat entrypoint will be removed

`@mariozechner/*` aliases and `@earendil-works/pi-ai/compat` are slated for
removal "in a future release" (no version announced). Both are **still present
and verified in 0.84.2** — `getAliases()` still maps all seven
`@mariozechner/*` specifiers, and `@mariozechner/pi-ai` still resolves to
`ai/dist/compat.js`. Our 100 non-vendored extension `.ts` files import
exactly three specifiers, all aliased:
`@mariozechner/pi-coding-agent` (42), `@mariozechner/pi-tui` (33),
`@mariozechner/pi-ai` (8) — plus `@sinclair/typebox` (22), also aliased.

When removal lands: rename `@mariozechner/*` → `@earendil-works/*` across those
files and move runtime pi-ai imports to `/compat` or the `createModels()` API.
Re-check `getAliases()` in `dist/core/extensions/loader.js` every release —
that function is the whole compat surface.
