# AGENTS.md — muzzpi reference

Read by pi and other coding agents at session start. Facts and rules only.

This repo is muzzpi: a portable pi harness in `pi-setup/`, deployed to
`~/.pi/agent/` by `./install.sh pi` (→ `pi-setup/install.sh`), plus Ghostty
config in `ghostty/` (`./install.sh ghostty`). README.md is the public pitch;
keep its numbers true when the facts change.

## Rules for editing this file

**A reference, not a logbook.** It is loaded into every session in this repo,
so every line costs tokens on every request. Keep it under ~560 lines; trim
rather than append.

Anything added must pass all four:

1. **A future agent needs it to avoid breaking something.**
2. **It is not discoverable from the code.** File lists, tool inventories and
   anything `ls`/`grep` answers in one call do not go here.
3. **It is a rule or a fact, not a story.** One or two lines. No dates, test
   counts, measurement tables or reproduction steps.
4. **It has no better home.** Per-incident detail goes in `pi-setup/*.md`,
   per-update detail in `pi-setup/pi-migrations.md`, never in a code comment.

**Never append a changelog entry** — `git log -p AGENTS.md` is the changelog.
Write the one-line rule and delete whatever it supersedes.

---

## Providers and defaults

```
pi CLI (v1.2.0) — @earendil-works/pi-coding-agent
  ├─ anthropic + pi-claude-code-use   → Claude Max OAuth (/login)   [DEFAULT]
  ├─ xai, openai-codex, kimi-coding   → /login (auth.json)
  ├─ openrouter                       → /login (auth.json)
  ├─ deepseek                         → DEEPSEEK_API_KEY in ~/.zshrc
  ├─ river                            → RIVER_API_KEY in ~/.zshrc
  └─ llama-local                      → llama.cpp via /local
```

Default: `anthropic` / `claude-opus-5-5`, thinking `high`, theme gruvbox,
`compaction.enabled: true`, `cacheWarming: "off"`, `tuiMode: "fullscreen"`,
`quietStartup: "header"` (`"regular"` restores normal scrollback).

`enabledModels` (what `/model` shows): opus-5-5, sonnet-5-5, haiku-5-5,
`deepseek/deepseek-flash`, `deepseek/deepseek-v4-pro`,
`river/deepseek-ai/DeepSeek-V4.1-Flash`, and via openrouter
`deepseek/deepseek-v4.1-flash` and `z-ai/glm-5.3-flash` (picker only: sub-agents
use DeepSeek's own API). The catalog still has
xai, openai-codex, kimi and llama models; a model must be in `enabledModels`
for `/model` to see it.

**Do not set `PI_CLAUDE_CODE_USE_DISABLE_TOOL_FILTER`.** pi-claude-code-use
2.2.1 aliases non-core tools to `mcp__tools__*` on anthropic+OAuth; that env
skips the remap and sends flat names and aliases together.

### System prompt assembly

1. `extensions/system-prompt.ts` sets `systemPromptOptions.customPrompt`, which
   replaces pi's preamble, tool list, rules and docs block; pi still renders
   project context, skills and cwd. Parent: `agents/prompt.amp.system.md`
   interpolated (`{identity} {harness} {date} {cwd} {roots} {os} {repo}
   {sessionId} {ls} {harness_docs_section} {agent_models}`). Parent and
   children both get `rules.amp.md` as a `rules` section, every tool's
   registered guidelines as `tool_guidelines`, and pi's docs block as `docs`.
   **Never return `systemPrompt` from `before_agent_start`**: it freezes one
   opaque prompt before later handlers' edits. Edit
   `systemPromptOptions.sections` instead (psst does).
2. `tools/lib/sub-agent-prompt.ts` — **sub-agents** get a short generated
   prompt naming exactly their tools, driven by `PI_SUBAGENT_TOOLS`, which
   `pi-spawn.ts` sets from the same array it builds `--tools` from. The child's
   agent prompt arrives as `--append-system-prompt`.
3. **Each fact has one home.** A tool's call shapes and when-to-use live in its
   own description (children see those too); the template carries only
   cross-tool routing. Do not copy tool descriptions into the template or into
   `promptGuidelines` — every copy is paid on every request.
4. **Nothing in the prompt or tool schemas may change mid-session.** A changed
   prefix re-writes the whole prompt cache; `interpolate.ts` memoizes the
   workspace listing for that reason, and the sub-agent model list is built once
   at load.

## Patches and configs that must survive updates

Run after **any** `pi update`, `pi install`, or package update:

```bash
bash pi-setup/verify-patches.sh     # read-only audit; each FAIL prints its fix
```

| What | Where | Why |
|---|---|---|
| `resource-loader.js` | pi core `dist/core/` | suppresses extension tool-conflict boot errors |
| `session-selector.js` + `keybindings.js` | pi core | session pinning, `Ctrl+B` in `/resume`; pins in `~/.pi/agent/pinned-sessions.json` (user data) |
| **pi-tui width patch** | **every** pi-tui copy | conservative grapheme widths; without it the TUI smears on Indic/exotic unicode |
| extension bundles | `~/.pi/agent/extensions/` | `.js` only; a stray `.ts` shadows its bundle |
| pi-mcp-adapter settings | `~/.config/mcp/mcp.json` + `settings.json` | `scriptMode: false`, `namespaceProxyTools: false`, skills `[]` |
| sub-agent models | `~/.pi/agent/agent-models.json` | valid, every id listed by `pi --list-models` |

### Quick re-patch

```bash
source pi-setup/pi-location.sh && pi_locate && PI=$PI_PKG   # wherever `pi` really lives
cp pi-setup/pi-core-patches/resource-loader.js  $PI/dist/core/resource-loader.js
cp pi-setup/pi-core-patches/session-selector.js $PI/dist/modes/interactive/components/session-selector.js
cp pi-setup/pi-core-patches/keybindings.js      $PI/dist/core/keybindings.js

node pi-setup/pi-core-patches/apply-pi-tui-width-patch.mjs           # all copies
node pi-setup/pi-core-patches/apply-pi-tui-width-patch.mjs --check   # audit
```

`install.sh` applies all of these and runs `verify-patches.sh` last. **Never
hardcode `/opt/homebrew` in a script**: `install.sh`, `verify-patches.sh` and
`update-pi.sh` all locate pi via `pi-location.sh`
(strangers run pi from nvm and Intel prefixes too).

### pi-mcp-adapter config (required)

`settings.scriptMode: false` in `mcp.json` (5.1 only registers `mcpScript` on
`=== true`; mcpScript runs arbitrary JS outside `permissions.json`), and
`{ "source": "npm:pi-mcp-adapter@<ver>", "skills": [] }` in `settings.json`.
**The object form is load-bearing** — the string form silently restores the
`mcp-scripting` skill. After any update: tools contain `mcp`, not `mcpScript`;
skills do not contain `mcp-scripting`. pi's built-in `mcp` extension is
`replaceable`; `-builtin:mcp` in `extensions` makes the adapter's win explicit.

## Packages (npm)

| Package | Ver | Purpose | Patched |
|---|---|---|---|
| `@earendil-works/pi-coding-agent` | 1.2.0 | pi itself | 3 core patches |
| `@benvargas/pi-claude-code-use` | **2.2.1 (pinned)** | Claude Max OAuth payload shim | no |
| `pi-codex-goal` | 0.6.0 (pinned) | `/goal` | no |
| `pi-mcp-adapter` | 5.1.0 (pinned) | one `mcp` proxy tool, lazy servers | **config** |

**Pinned versions** live in `settings.json` and `install.sh`'s package list;
change both. To move a pin: edit the source in both, then
`pi install npm:<pkg>@<ver>` (a bare `pi update <source>` reported success
without installing), then re-check the settings entry kept its shape.

`warnings.anthropicExtraUsage: false` silences pi's Max-OAuth extra-usage
banner; it is UI, not a billing signal.

### Removed — do not reinstall

`pi-context`, `todos.ts`, `pi-web-access`, `pi-tasks` (array params arrived
JSON-stringified), `@tomooshi/condensed-milk-pi` (**reported failed git
commands as successes**), `claude-agent-sdk-pi`, `@sting8k/pi-vcc`,
`pi-computer-use`, `pi-gpt-config`, `pi-ask`, `pi-grok-cli`, `pi-claude-bridge`,
`lsp-pi`, `pi-powerline-footer`, `pi-anycopy`, `pi-autoresearch` (its
`promptGuidelines` flip mid-session, re-writing the prompt cache),
`pi-token-burden` (+143 ms on every start for one command),
`@marckrenn/pi-sub-bar` (+324 ms, every provider off, two patches to stop it
crashing pi), `pi-tool-display` (rewrote stored messages, then spliced the
whole context on every LLM call to undo it).
`verify-patches.sh` `REMOVED_PKGS` must match this list; it fails on any trace.

### One install, no duplicates

pi loads packages from **exactly one** place: `~/.pi/agent/npm/node_modules`
(plus `~/.pi/agent/git/<host>/<org>/<repo>` for git sources). Always install
with `pi install npm:<name>`, from a cwd outside `~` (`~/package.json` is a bun
project whose `devEngines` breaks npm).

**Never `npm install -g` a pi package.** It becomes unloadable, can hijack a
pinned version, and brings an unpatched pi-tui copy. **`npm ls -g` lies here**
(node is nvm, pi is homebrew) — read versions from
`~/.pi/agent/npm/node_modules/*/package.json`.

`extensions/tools/node_modules` is gitignored **deployment source**. Its pi
packages are `file:` links to the installed pi (devDeps + `overrides`), so
tests run against the real, patched pi-tui. **Never put `"*"` back** for those links —
it installs stale pi copies. The live dir installs with `--no-package-lock`
because the lockfile stores the links relative to the checkout.

## MCP servers

Config: `~/.config/mcp/mcp.json` (backed up as `pi-setup/mcp.json`). Do not
create `~/.pi/agent/mcp.json` — the adapter also reads it, so servers would
load twice. Lazy: nothing connects until a tool is called.

| Server | Notes |
|---|---|
| `chrome-devtools` | **stdio**, pinned `chrome-devtools-mcp@1.7.0`: perf traces + Insights, Lighthouse, network, console, heap, Puppeteer |
| `astro` | `127.0.0.1:8089/mcp`, `auth: false`; runs inside the Astro Mac app (Settings → MCP Server) |
| `paper` | `127.0.0.1:29979/mcp`, `auth: false`; inside Paper Desktop, **read+write** on the open file |
| `cloudflare*` | remote HTTP, `protocolVersion: "auto"`. See `pi-setup/2026-08-13-cloudflare-mcp.md` |

**chrome-devtools flags are load-bearing.** `--isolated` (the default profile
is persistent, single-browser and readable by the agent),
`--no-usage-statistics` + `--no-performance-crux` (both default ON; telemetry
to Google, trace URLs to CrUX). **Its arg parser is not strict** — a misspelled
flag is silently ignored; confirm a flag by its startup notice disappearing.
Pin the version, never `@latest`: a lazy spawn re-resolves on every cold start.
File-writing tools are confined to the OS temp dir.

**`auth` must be `"oauth"`, never `true`.** `true` is not legal and fails
silently: no OAuth, no bearer, 401. First connect: `/mcp-auth <key>`, or
headless `mcp({ action: "auth-start", server })` → approve → `auth-complete`
with the `redirectUrl`. Tokens live in the macOS Keychain.

Result rendering: `settings.toolResultRendering: "boxed"` restores the boxed
row; `collapsedResultLines` (1–3) sets collapsed height.

## Extensions (`extensions/`)

The repo holds TypeScript; `install.sh` runs `build-extensions.ts`, which
bundles each extension into one file (`<dir>/index.js`, `<name>.js`, npm
packages external), so pi does not resolve every import through jiti at boot
(~190 ms on every start and every sub-agent). **Never copy `.ts` into the live
dir**: pi prefers `index.ts` over `index.js`; `settings.json` lists the `.js`.
There is **no** disabled state; delete or move out to disable. The live dir also
holds `herdr-agent-state.ts`, installed by herdr, not from this repo; leave it.

| Extension | Purpose |
|---|---|
| `system-prompt.ts` | parent template / sub-agent generated prompt |
| `mentions.ts` | @mentions + agent directives |
| `session-name.ts` | auto session naming (haiku, deliberately; a direct model call, not a sub-agent) |
| `stats/` | `/stats`, Ctrl+Shift+S — analytics over `sessions/` + git; caches, `settings.json` (widget, budget) and wrapped PNGs in `<agent dir>/cache/stats`. The widget only reads an existing index, never a cold parse |
| `notify.ts` | OSC 777 desktop notifications |
| `md-export.ts` | `/md` session → markdown |
| `command-palette/` | Ctrl+Shift+P |
| `theme-studio/` | `/studio`, `/theme`, Ctrl+Shift+K — live pi + Ghostty theme/font/cursor/opacity preview. Esc reverts, Enter keeps. Writes the Ghostty config at `PI_STUDIO_GHOSTTY_CONFIG` or the default path |
| `editor/` | custom box-drawing editor, labels, clipboard image paste |
| `deepseek-peak/` | `/deepseek` + peak/off-peak clock in the editor border |
| `subagent-inspector/` | Ctrl+Shift+A / `/subagents` — sub-agent transcripts |
| `local-model.ts` | `/local` llama.cpp router; bare system prompt for `llama-local` and `llama.cpp` |
| `guardrails/` | comment gate on `edit` / `write` |
| `you-should-know/` | `/ysk` side agent on deepseek-flash. **Off until `/ysk on`**; costs per check |
| `tools/` | custom tools |

### guardrails — the comment gate, and where the rules live

`guardrails/` blocks an `edit` or `write` that adds a comment run over 12 lines
**or** more than 0.5 comment lines per line of code (each trigger catches what
the other misses). It sees arguments after pi's `prepareArguments`, so only
pi's two shapes. Only real source extensions are gated. **It fails open on
any error.** `PI_GUARDRAILS_OFF=1` disables it; `PI_GUARDRAILS_MAX_COMMENT_RUN`,
`_MAX_COMMENT_RATIO`, `_MIN_COMMENTS` retune it.

**The rules live in the system prompt, never in a `context` hook.** Mutating
the message list from `context` on every call makes pi re-send the system
prompt and tool declarations, which invalidated the Anthropic prompt cache on
every turn. `system-prompt.ts` puts `agents/rules.amp.md` in a `rules` section.
Edit the rules in that .md, never in an extension. **`COMMENTS` in
`rules.amp.md` is the only copy of the comment rule.**

### Extension rules learned the hard way

- **Every transcript component caches its lines per width.** In fullscreen
  mode pi-tui renders the whole transcript every frame (a fresh cache per
  frame, `layout.js`), and `Box` reuses its output only when child lines come
  back unchanged. One row rebuilding its lines made each keystroke cost
  O(session): 180 ms at 700k context. `render-cache.test.ts` pins ours.
- **Extensions do not share module state.** Each loads with its own jiti
  instance and `moduleCache: false`; a module-level Map imported from another
  extension reads *empty*. Importing pure functions/constants is fine;
  cross-extension state goes over `pi.on(...)` events.
- **Any timer that outlives a session must be cleared on `session_shutdown`**,
  and anything a timer calls must be in `try`/`catch`. After session replacement
  the ctx is stale and every `pi.*` call throws — inside a timer that is an
  uncaughtException, and pi exits. A timer calling `invalidate()`/
  `requestRender()` counts.
- **Clipboard paste** uses pi's `readClipboardImage`
  (`dist/utils/clipboard-image.js`). `process.argv[1]` is the
  `/opt/homebrew/bin/pi` symlink: `realpathSync` it before resolving `utils/…`,
  or pastes silently insert the raw temp path. If the module cannot load, leave
  `onPasteImage` unset so pi's default path-insert takes over.

## Custom tools

`codemode` is a pi built-in enabled by `defaultTools: ["+codemode"]`; it is not
in the shim's `CORE_TOOL_NAMES`, so it is aliased on Anthropic OAuth. `read`
declares `outputSchema: Type.String()`, so scripts get raw text. **Every tool
result is redacted** (`psst.ts` `redactSecretPatterns`), scripts included; **cap
every quantifier there**: an uncapped `[\w.-]*token[\w.-]*` took 284 s on 1 MB.

`glob.ts` registers as `find`; there is no `glob` tool. The 7 GitHub tools are
separate (`read_github` … `diff`); **there is no tool named `github`**.
`web_search` can be disabled in ext-config; it defaults on. `agent_message`
and its mailbox (`~/.pi/agent/agent-messages/`) are gone: every child process
made a mailbox that was never cleaned up, and sub-agents could not receive.

### Sub-agents

- **One spawn path.** All spawning tools (chad, delegate, oracle, finder,
  librarian, code_review, read_session, read_web_page with `prompt`) build their
  task and `--tools` list, then call `lib/run-sub-agent.ts` → `lib/pi-spawn.ts`.
  Progress, error mapping and the result footer (`model: <id> · <level>`,
  `continueId`) live there once.
- **Models come from `pi-setup/agent-models.json` only** — see Sub-agent models.
- **The spawn graph is acyclic and pinned by `tool-contract.test.ts`:** the only
  agent→agent edge is `delegate → finder`, depth ≤ 2. chad has no
  `chad`/`delegate` (a swarm that spawns swarms is a fork bomb) and no
  `oracle`/`finder`/`librarian` (it already has their tools).
- delegate and chad persist to `~/.pi/agent/sessions-sub` (`SUB_AGENT_SESSION_DIR`,
  next to `PI_SESSIONS_DIR` in `pi-spawn.ts`), out of `/resume`, resumable by
  `continueId`.
- **Don't use `--no-tools`** for sub-agents: it empties the registry and
  nothing can be re-activated.

### chad — read-only

`readOnlyBash: true` sets `PI_BASH_READ_ONLY=1`; `lib/read-only-bash.ts` is an
**allowlist** of command names (fails closed) plus a **denylist** of write/exec
flags, `WRITE_FLAGS` / `POSITIONAL_OUTPUT`, matched as `-oFILE`, `-so`, and `--out`
(only for `GETOPT_LONG_ABBREVIATES`); sed scripts are parsed command by command
(`w`, `s///w`, `e`); `awk` is out. git `-c`/`--config-env`/`--exec-path=`
are refused (config names commands to run). Check anything added for
output/exec flags. A guardrail, not a sandbox.

`oracle` returns a **verdict** and has unrestricted bash; `chad` returns
**evidence** and can write nothing. Finding out → chads; deciding → oracle.

### edit / write — pi's tools, thinly wrapped

`edit-write.ts` registers pi's own tools (`create*ToolDefinition` with injected
`operations`) under pi's names; schema, prompt text and matching stay upstream's
— **never reimplement matching**. The wrapper adds only: undo records (saved
before the write; no record, no write), `permissions.json` checked on the path
pi resolves and its realpath, `lib/mutex.ts`, Claude's field names, and errors
naming the first differing line, column and code point. `\uXXXX` sent as text
is decoded only when that alone makes oldText match, refused in prose files
without escapes; `[REDACTED]` is never written over a real value. UTF-8 text
only; no `replace_all`, delete or move (`trash <path>` / `git mv` in bash).

- **This Mac: no deletes. Over ssh: deletes run.** `lib/remote-command.ts`
  splits out server parts (ssh args and heredocs, `rsync --delete` to a remote
  dest); local-only rules carry `where: "local"`; text it cannot place stays
  local; keep its real-bash oracle test green. Undo of a creation: `lib/trash.ts`.
- **`ask` rules** (destructive SQL, Docker volumes, buckets, disks; MCP DELETE)
  go through `lib/approval.ts`: a confirm dialog, refused with no UI (sub-agents,
  `-p`), logged to `~/.pi/agent/approvals.jsonl`. Reject beats ask beats allow.
- apply_patch is gone (envelope 9.6%, batch 6.8% failures vs ~2%; see
  `pi-setup/2026-10-11-edit-tool.md`). If GPT models return, gate it by model id.
- Undo/redo refuse when a later still-applied change touches the path, or the
  file drifted outside the tool (`force: true` overrides and reports the loss).
  Ordering comes from position in `activeIds`, **never `Date.now()`**. Redo
  takes the *oldest* undone step; legacy move records pair by `movePartnerUri`.
- `lib/mutex.ts` is a module-level Map — it does **not** span processes, so
  concurrent delegates can collide on one file.

### bash — nothing runs unbounded

| | mechanism | bounds |
|---|---|---|
| L1 | **`timeout` required**, schema-bounded 1–600s | declared budget |
| L2 | idle kill: no output **and** no CPU for 300s | a hung command |
| L3 | `piSpawn` stall watchdog: no child output for 900s | sub-agent children |

Overrides: `PI_BASH_MAX_TIMEOUT_SEC`, `PI_BASH_IDLE_KILL_SEC` (0 disables),
`PI_SPAWN_STALL_SEC`, `PI_BASH_CPU_LIVENESS`.

- **CPU liveness can only keep a command alive, never kill it**; `proc-cpu.ts`
  returns `undefined` on failure, degrading to output-only.
- The idle timer runs from t=0 (pipes block-buffer) and is stamped on raw chunk
  arrival. The machine-sleep guard (`SLEEP_JUMP_MS` in `watchdog.ts`) is checked
  first and wins.
- Killing ≠ released: `FORCE_RELEASE_MS` (10s) resolves even when a grandchild
  holds stdout. The child is **not** spawned `detached` (Ctrl+C must reach it).
- A stalled child must be **relaunched, never resumed**: it left a `tool_use`
  with no `tool_result`, which is a provider 400 on replay.
- 900s sits above pi's own HTTP idle (300s) + retry; re-check those before
  shrinking it.
- **bash keeps pi's codemode contract**: `structuredContent` on every exit code
  (a script's `grep` miss is data, not a throw); timeout/idle/abort/signal stay
  errors. The `tool_result` scrub hook must return `structuredContent` too —
  `content` alone makes pi drop it.

### screenshot / vision budget

`resizedSize`/`countImageTokens` must match Anthropic's reference code (fuzzed
in `vision.test.ts`). Tiers: standard 1568px/1568 tokens, high-res (Claude
4.7+) 2576px/4784; `tierForModel` picks from `ctx.model`.

- **`fitImageFile` is the only path from pixels to a vision model** (`screenshot`
  and `read`). `sips` is a codec, never a resizer; `planView` decides geometry.
- **Every output must pass pi's tool-image normalizer untouched**
  (`agent-session.js` → `normalizeToolResultImages`): side ≤ 2000px and base64
  < `inputLimits.images.resize.maxBytes` (4.5 MiB). Anything over is silently
  re-encoded by pi. `image-fit.test.ts` runs pi's real normalizer to pin this.
- Side cap 2000px (`maxSide`): past 20 images per request the API rejects
  larger ones, and history is resent every turn.
- **pi does not enforce the 32 MiB request limit**; one oversized request is a
  413 on every later turn. `lib/image-budget.ts` measures the context
  (`buildSessionProjection`) plus in-flight calls and refuses before it.
- Media type comes from the bytes, never the extension (a mismatch is a 400).
  sips ignores EXIF orientation, so `orient()` applies it.
- `MAX_IMAGES_PER_CALL = 12`, truncating from the top. **Chromium returns BLANK
  past 16384px** without erroring; `MAX_RENDERABLE_HEIGHT` clips and reports it.
  Full-page captures scroll through once first, or lazy content is missing.
- 0x0, truncated and unreadable files throw `UnusableImageError`; `read` has
  no raw-bytes fallback.
- `collectSubAgentImages` returns the **2 most recent** images from
  oracle/delegate/code_review/chad.
- macOS: every tab is its own `NSWindow`; `CGWindowListCopyWindowInfo` option
  `0`, never `1`; off-Space capture usually works, so try and explain, never
  pre-refuse. Screen Recording must be granted to the terminal running pi.
- `permissions.json` blocks the capture binary in bash but deliberately does
  not match `sips`.

## TUI width — the invariant

**Clamp with the same function pi-tui asserts with** (`visibleWidth` /
`truncateToWidth`). pi-tui throws `Rendered line N exceeds terminal width` as an
uncaughtException, which kills pi. `lib/box-format.ts` `normalizeForDisplay()`
is the render chokepoint for box and sub-agent rendering (display only — model
text is never modified).

1. **Undercount → smear.** pi-tui measures grapheme clusters; terminals advance
   per spacing codepoint. The width patch makes `graphemeWidth()` overcount,
   never undercount. Re-apply on every install.
2. **Control char in a single-line sink → smear.** A `\n` is width-0 to every
   check and still moves the cursor. Editor labels (`flattenLabelText`), widget
   rows (`flattenSegmentText`) and any truncated summary must flatten.
   Multi-row `renderCall` output is fine.

If it returns: `apply-pi-tui-width-patch.mjs --check` first, then
`pi-setup/render-repro/`, then hunt for a control char in a single-line string.

## Sub-agent models

**`pi-setup/agent-models.json` is the only place a sub-agent model is named.**
`models` maps a short name to a `provider/model` id; `agents` gives each
spawning tool a default `model` + `thinking`. Changing a default is a one-line
edit there, deployed by `install.sh`, read at session start.

- Every spawning tool takes optional `model` (enum of the names) and `thinking`
  (pi's 7 levels; "med" etc. accepted). `lib/agent-models.ts` resolves them;
  the parent learns the names from the `{agent_models}` prompt section.
- **The enum is enforced during decoding on xAI**: a parent cannot emit a name
  outside the list and will pick the nearest one. The prompt line forbidding
  substitution is what stops that; keep it.
- **pi runs an unknown `--model` anyway** (warning, then a made-up id), so the
  resolver checks `modelRegistry.find` + `hasConfiguredAuth` before spawning. It
  cannot see an expired token or a lapsed sub; those come back as the child's
  error, with the footer naming the model. A failing **default** drops
  `--model` (the child runs on pi's default, so a missing `DEEPSEEK_API_KEY`
  degrades instead of breaking five agents); a failing **explicit** model is
  refused.
- **pi's `--model` resolver can fall back across providers** (to another
  provider's look-alike id when the named one is unauthenticated or missing), so
  `pi-spawn.ts` SIGKILLs a child whose first assistant message names any
  provider/model other than the one requested, or, with none requested, one not
  in `agent-models.json` (`modelViolation`). Keep every Claude id `anthropic/`.
- **Ids must be provider-qualified** (a bare id is ambiguous across providers
  since pi 0.84); the loader refuses one. No default → `--model` omitted → pi's
  default. A `continueId` resume skips the defaults: pi restores the child's
  own model.
- `thinking` is clamped by pi to what the model supports; the footer shows the
  level that actually ran.

## Local models

**llama.cpp must be >= b10270** (b8680 mangles `lfm2` tool calls: `\n` arrives
as a literal backslash-n, and `[f(a), f(b)]` parses as one call). Check
`llama-server --version` first if local tool calling goes strange.

pi's own `/llama` uses provider `llama.cpp` (needs `/login llama.cpp`); ours is
`/local` + provider `llama-local` in models.json (no login, always listed).
`/local [start|stop|restart|unload|status|logs]`, no auto-start. For
`llama-local` and `llama.cpp` only, `local-model.ts` **replaces** the system
prompt with a short tool crib and skips the rules section. **Do not widen those
two provider gates.** Sub-agents keep the short child prompt. Local models loop
for minutes on self-directed work — always time them out.

Gotchas: it's `ctx.hasUI`, not `ctx.canPrompt` (undefined, i.e. falsy, in a
real TUI); `toLocaleString()` follows the en-IN system locale — always pass
`"en-US"`.

## Skills

`~/.config/agents/skills/` (source: `pi-setup/config-skills/`) plus
`~/.agents/skills/` (not from this repo). A skill's `description` is sent on
every request — keep it to what decides loading. **The `skill` tool serves
exactly pi's resolved skills** (`systemPromptOptions.skills`) with no discovery
of its own, so a package's `skills: []` hides its skills from both.

Ports with author prefixes — **`c-` cursor, `mat-` matt pocock, `dm-`
dmmulroy** — had Claude-Code/Cursor machinery mapped to pi tools or cut; every
subagent they spawn is read-only.

## Agent mention directives

`@oracle @finder @codereview @task @chad` → hidden `display: false` directive
injected in the `context` hook telling the model to call that tool
(`codereview` → `code_review`, `task` → `delegate`).

- **Don't remove the explicit `import "./tools/lib/mentions/agent-source.js"`**
  in `mentions.ts` — the barrel `export *` doesn't guarantee evaluation of a
  module with no named exports, and the sources register on load.
- Don't add `/value` to agent mentions; the `@oracle` text is not stripped.

## Update workflow

0. **Update pi with `bash pi-setup/update-pi.sh <ver>`, never `pi update --self`.**
   Self-update repoints `bin/pi` at `dist/bundle/cli.js`, which disables every
   core patch. The script runs npm outside `~` and refuses if stock patched
   files drifted from `pi-core-patches/base-version`.
1. **`bash pi-setup/verify-patches.sh`** — always first.
2. **Grep our own CLI call sites.** An import-level audit cannot see a change in
   how pi reads the arguments `pi-spawn.ts` passes (`--model --thinking --tools
   --mode --session-id`); pi 0.84's #7327 silently killed every sub-agent that
   way. When a release touches model resolution, tool filtering or CLI
   arguments, call one real sub-agent before declaring it clean.
3. **pi core update** → re-derive the 3 core patches against the new stock
   files (never blind-copy; see `pi-migrations.md`) + the width patch. The
   `@mariozechner/*` compat aliases will eventually go — then rename imports.
4. **Any `pi install` / package update** → `verify-patches.sh` (width patcher
   check included).
5. **tools extension deps** (`extensions/tools/package.json`) → `npm outdated`
   there; `npm ci` (node_modules is gitignored), then `bun test` before deploying.
6. **After any pi update, make one real `edit` and `write`**: the wrapper rides
   on pi's `operations` and error strings.

Per-version record: `pi-setup/pi-migrations.md`. Read it before `pi update`.

## What NOT to do

- **Don't edit `/opt/homebrew/lib/node_modules/` directly** — wiped on update.
  Edit in `pi-setup/`, deploy with `install.sh`.
- **Don't run `install.sh` without checking what changed** — it overwrites live
  tweaks (after backing them up).
  `--dry-run` prints every write first.

## Where the detail lives

- `pi-setup/2026-05-17-migration-log.md` — v0.74.0 migration, architecture
- `pi-setup/2026-07-30-bdsqqq-port.md` — sub-agent wiring, OAuth tool-filter
  trap. **Read before touching tools/subagents.**
- `pi-setup/2026-10-11-edit-tool.md` — edit/write decision, data, scoreboard
- `pi-setup/2026-10-13-performance.md` — keystroke and boot profiling, the bundled
  deploy, what was removed and why
- `pi-setup/2026-10-13-permissions.md` — server deletes, approval dialog, secret redaction, edit hints
- `pi-setup/2026-08-13-cloudflare-mcp.md` — the 16 Cloudflare servers, auth flow
- `pi-setup/2026-10-04-you-should-know.md` — the `/ysk` side agent and its cache-cost maths
- `pi-setup/2026-10-03-cache-playbook.md` — the Max-plan cache drain: measurement, root
  cause, fix, every wrong turn. **Read before touching anything that shapes the prompt.**
- `pi-setup/2026-06-15-anthropic-login-analysis.md` — `/login anthropic` vs Claude Code OAuth
- `pi-setup/pi-migrations.md` — per-update record. **Read before `pi update`.**
- `pi-setup/README.md` — setup docs
- `git log -p AGENTS.md` — everything ever cut from this file
