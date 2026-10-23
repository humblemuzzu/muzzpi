# AGENTS.md — muzzpi reference

Read by pi and other coding agents at session start. Facts and rules only.

This repo is muzzpi: a portable pi harness in `pi-setup/`, deployed to
`~/.pi/agent/` by `./install.sh pi` (→ `pi-setup/install.sh`), plus Ghostty
config in `ghostty/` (`./install.sh ghostty`), and the optional herdr add-on in
`herdr/` (`./install.sh herdr`, see its README). README.md is the public pitch;
keep its numbers true when the facts change.

**herdr is opt-in: never wire it into `install.sh pi` or `ghostty`.**
`ghostty/config` holds only `config-file = ?herdr-keys` (a no-op without the
file). `herdr/ghostty-keys` makes ⌘ keys type herdr's prefix as bytes
(`text:\x02c` = ctrl+b c), so a binding changes in it and `herdr-keys.toml`
together. The installer merges into the user's herdr config (`# muzzpi` lines,
a marked block) and refuses clashes; **herdr drops its whole config on any parse
error**, so it runs `herdr config check` before every swap.

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
4. **It has no better home.** Per-update detail goes in `pi-setup/pi-migrations.md`, never in a code
   comment. **Do not write a new .md file for a fix**: the commit message holds the story.

**Never append a changelog entry** — `git log -p AGENTS.md` is the changelog.
Write the one-line rule and delete whatever it supersedes.

---

## Providers and defaults

```
pi CLI (v1.4.0) — @earendil-works/pi-coding-agent
  ├─ anthropic + anthropic-sub.ts     → Claude Max OAuth (/login)   [DEFAULT]
  ├─ xai, openai-codex, kimi-coding   → /login (auth.json)
  ├─ openrouter                       → /login (auth.json)
  ├─ deepseek                         → DEEPSEEK_API_KEY in ~/.zshrc
  ├─ river                            → RIVER_API_KEY in ~/.zshrc
  └─ llama-local                      → llama.cpp via /local
```

Default: `anthropic` / `claude-opus-5-5`, thinking `high`, theme gruvbox,
`cacheWarming: "streaming"`, `tuiMode: "fullscreen"`,
`quietStartup: "header"` (`"regular"` restores normal scrollback).

`/model` shows only `settings.json` `enabledModels`; the rest of the catalog
stays hidden. DeepSeek's `deepseek-flash` always serves its newest release, so it
needs no update; `models.json` only sets its off-peak cost.

**Claude-plan billing.** An OAuth request whose system prompt holds the phrases
in `tools/lib/anthropic-sub.ts` bills as extra usage (here a 400). Never write
them into a prompt or drop `anthropic-sub`; `update-pi.sh` runs
`bun pi-setup/port-harness/anthropic-oauth-canary.ts`, run it by hand otherwise. pi's extra-usage banner
(`warnings.anthropicExtraUsage: false`) is not a billing signal.

**Prompt cache (Claude Code's rules).** `anthropic-sub` gives every `cache_control`
of the main session's plan requests `ttl: "1h"` (+ beta `extended-cache-ttl-2025-04-11`);
sub-agents keep pi's 5m; a response served from extra usage drops it to 5m. Knobs:
`PI_PROMPT_CACHE_TTL` / `PI_SUBAGENT_PROMPT_CACHE_TTL` (`5m`|`1h`), `PI_FORCE_PROMPT_CACHING_5M=1`.
**Never set `PI_CACHE_RETENTION=long`**: it is process-wide and sends DeepSeek, River and OpenRouter
`prompt_cache_retention: "24h"`. pi's warmer reads its TTL only from `models.json`
`promptCache.short` (3600 for the Claude models) and refreshes at 90%; only a restart applies a
changed value (`/reload` keeps the session's model object), and `anthropic-sub` warns when it is
under 1h; `anthropic-sub` vetoes warming wherever a request wrote 5m. Claude compacts above 850k
(`compaction.modelOverrides`). `cache-compaction` replays the last main-session request with a
summary instruction appended, so compaction reads the cache; any doubt (no capture, other session or
model, overflow, 90% of the TTL gone, a summarized message not in it) runs pi's own. It loads after
`anthropic-sub`, so it replays that payload byte for byte. `cache-report.py` shows what was rebuilt
after expiry; `PI_ANTHROPIC_METER_LOG=<file>` logs the plan meter next to each request's tokens.

### System prompt assembly

1. `extensions/system-prompt.ts` sets `systemPromptOptions.customPrompt`, which replaces pi's
   preamble, tool list, rules and docs block; pi still renders project context, skills and cwd.
   Parent: `agents/prompt.amp.system.md` interpolated (`{identity} {harness} {date} {cwd} {roots}
   {os} {repo} {sessionId} {ls} {harness_docs_section} {agent_models}`). Parent and children both
   get `rules.amp.md` as a `rules` section, every tool's registered guidelines as `tool_guidelines`,
   and pi's docs block as `docs`. **Never return `systemPrompt` from `before_agent_start`**: it
   freezes one opaque prompt before later handlers' edits. Edit `systemPromptOptions.sections`
   instead (psst does).
2. `tools/lib/sub-agent-prompt.ts` — **sub-agents** get a short generated prompt naming exactly
   their tools, driven by `PI_SUBAGENT_TOOLS`, which `pi-spawn.ts` sets from the same array it
   builds `--tools` from. The child's agent prompt arrives as `--append-system-prompt`.
3. **Each fact has one home.** A tool's call shapes and when-to-use live in its own description
   (children see those too); the template carries only cross-tool routing. Do not copy tool
   descriptions into the template or into `promptGuidelines` — every copy is paid on every request.
4. **Nothing in the prompt or tool schemas may change mid-session.** A changed prefix re-writes the
   whole prompt cache; `interpolate.ts` memoizes the workspace listing for that reason, and the
   sub-agent model list is built once at load.

## Patches and configs that must survive updates

Run after **any** `pi update`, `pi install`, or package update:

```bash
bash pi-setup/verify-patches.sh     # read-only audit; each FAIL prints its fix
```

| What | Where | Why |
|---|---|---|
| `resource-loader.js` | pi core `dist/core/` | suppresses extension tool-conflict boot errors |
| `session-selector.js` + `keybindings.js` | pi core | session pinning, `Ctrl+B` in `/resume`; pins in `~/.pi/agent/pinned-sessions.json` (user data) |
| `mcp-index.js` | pi core `dist/extensions/mcp/index.js` | lazy MCP connect; stock connects every enabled server at every session start |
| **pi-tui width patch** | **every** pi-tui copy | conservative grapheme widths; without it the TUI smears on Indic/exotic unicode |
| **our bundle** | `dist/muzzpi-bundle/`, `pi` → its `cli.js` | what pi runs: the patched files, bundled; stale after any change to them |
| extension bundles | `~/.pi/agent/extensions/` | `.js` only; a stray `.ts` shadows its bundle |
| MCP config | `~/.pi/agent/mcp.json` | every server has a `description`; no `-builtin:mcp` in `settings.json` |
| sub-agent models | `~/.pi/agent/agent-models.json` | valid, every id listed by `pi --list-models` |

`install.sh` applies every patch, rebuilds our bundle and runs
`verify-patches.sh` last; each FAIL there prints its own fix command. **Never
hardcode `/opt/homebrew` in a script**: `install.sh`, `verify-patches.sh` and
`update-pi.sh` all locate pi via `pi-location.sh`
(strangers run pi from nvm and Intel prefixes too).

### pi runs our bundle of the patched files

`pi-bundle/build-pi-bundle.mjs` runs pi's own bundle recipe (`UPSTREAM.tag`) on
the patched `dist/` (~45% faster to start than `dist/cli.js`).
- **A changed patched file needs a rebuild**, or pi runs the old code. Both installers rebuild;
  `verify-patches.sh` fails a stale build. Rollback: `ln -sfn "$PI_PKG/dist/cli.js" "$PI_BIN"`.
- A pi whose recipe or esbuild differs from `UPSTREAM` is refused (exit 3, pi
  stays on `dist/cli.js`): re-derive, then `port-harness/bundle-fidelity.mjs`.
- Rebuilds keep the previous chunks (a live pi imports them lazily). esbuild
  loads by path: `~/node_modules` holds an older one that a lookup finds.
- Extensions get pi's virtual modules: locate pi's files with `tools/lib/pi-package-dir.ts`.

## Packages (npm)

No pi packages: `settings.json` has no `packages`. A future one goes there
and in `install.sh`, pinned; move a pin with `pi install npm:<pkg>@<ver>` (a
bare `pi update <source>` reported success without installing).

### Removed — do not reinstall

`pi-context`, `todos.ts`, `pi-web-access`, `pi-tasks` (array params arrived
JSON-stringified), `@tomooshi/condensed-milk-pi` (**reported failed git
commands as successes**), `claude-agent-sdk-pi`, `@sting8k/pi-vcc`,
`pi-computer-use`, `pi-gpt-config`, `pi-ask`, `pi-grok-cli`, `pi-claude-bridge`,
`lsp-pi`, `pi-powerline-footer`, `pi-anycopy`, `pi-autoresearch` (its
`promptGuidelines` flip mid-session, re-writing the prompt cache),
`pi-token-burden`, `@marckrenn/pi-sub-bar`, `pi-tool-display` (it re-wrote
the whole context on every LLM call), `@benvargas/pi-claude-code-use`,
`pi-mcp-adapter` (it writes `-builtin:mcp` into `settings.json`; pi's built-in
client replaces it), `pi-codex-goal` (vendored as `extensions/goal`; the npm
copy would register the goal tools twice).
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

pi's built-in client reads `~/.pi/agent/mcp.json` (source: `pi-setup/mcp.json`).
Tools are `mcp__<server>__<tool>`, called from codemode; the model learns the
servers from the `<mcp_servers>` prompt section. **Every server needs a
`description`**: without one its line changes when it connects. `mcp-index.js`
makes connecting lazy: a server starts when a script names it, a discovery
call or resource tool needs it, or `/mcp` runs; a failed one is retried on the
next call that needs it. Only `direct`-exposure servers connect at startup.
Rarely used servers stay in the file with `"enabled": false`; `/mcp` turns one on.

| Server | Notes |
|---|---|
| `chrome-devtools` | **stdio**, pinned `chrome-devtools-mcp@1.11.0`: perf traces + Insights, Lighthouse, network, console, heap, Puppeteer |
| `astro` | `127.0.0.1:8089/mcp`; runs inside the Astro Mac app (Settings → MCP Server) |
| `paper` | `127.0.0.1:29979/mcp`; inside Paper Desktop, **read+write** on the open file |
| `cloudflare*` | remote HTTP; `cloudflare` and `cloudflare-bindings` use OAuth |

**chrome-devtools flags are load-bearing.** `--isolated` (the default profile
is persistent, single-browser and readable by the agent),
`--no-usage-statistics` + `--no-performance-crux` (both default ON; telemetry
to Google, trace URLs to CrUX). **Its arg parser is not strict** — a misspelled
flag is only warned about (`Unknown arguments`); confirm a flag by its startup
notice disappearing. `CHROME_DEVTOOLS_MCP_NO_CONFIG_DISCOVERY=1` stops it applying
an ambient `~/.config/cd4a/config.json`. **Keep `"cwd": "/tmp"`**: from any folder
under `~` without its own package.json, npx reads `~/package.json`'s bun
`devEngines` and refuses to start (`EBADDEVENGINES`).
Pin the version, never `@latest`: a lazy spawn re-resolves on every cold start.
File-writing tools are confined to the OS temp dir.

`auth` takes only `{ "provider": "<pi login>" }`; the adapter's `"oauth"` or
`false` fails validation. OAuth needs no key: a server that answers 401 needs
sign-in, `/mcp login <server>` or `pi mcp login <server>` from a shell. Tokens live in `~/.pi/agent/mcp-auth.json` (mode 0600).

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
| `anthropic-sub.ts` | Claude-plan billing: scrubs the trigger phrases, the 1h/5m cache TTL and warming veto, warns on a refusal, `PI_ANTHROPIC_PAYLOAD_LOG` feeds `cache-diag.py`. Parent and children |
| `cache-compaction.ts` | compaction read from the prompt cache (see Prompt cache). Parent only; `PI_CACHE_COMPACTION_MAX_AGE_SEC` overrides its age limit |
| `mentions.ts` | @mentions + agent directives |
| `session-name.ts` | auto session naming (haiku, deliberately; a direct model call, not a sub-agent) |
| `stats/` | `/stats`, Ctrl+Shift+S — analytics over pi, Claude Code, Codex and OpenCode sessions + git. Per-harness ledgers in `<agent dir>/cache/stats` keep sessions whose source is gone (Claude prunes after 30 days): never delete them casually. Bump `ledger.ts` `VERSION` when a parser's output changes. OpenCode is read via the `sqlite3` CLI, read-only. Nothing may reach the model: no tools, no `sendMessage`. The widget reads pi's ledger only, never a cold parse |
| `notify.ts` | OSC 777 desktop notifications |
| `md-export.ts` | `/md` session → markdown |
| `command-palette/` | `/help`, Ctrl+Shift+P: every command, shortcut, @mention and skill; enter runs ours, types pi's own into the editor |
| `theme-studio/` | `/theme`, Ctrl+Shift+K — live pi + Ghostty theme/font/cursor/opacity preview. Esc reverts, Enter keeps. Writes the Ghostty config at `PI_STUDIO_GHOSTTY_CONFIG` or the default path |
| `editor/` | box-drawn editor, clipboard image paste, one meta row below (cache, `setStatus` texts, diff); `/hud` / Ctrl+Shift+I opens the detail view. Labels take `priority` (narrow drops lowest) and `when: "idle"\|"detail"`. Values stay plain text (the user reads them); colour only for an alert |
| `deepseek-peak/` | `/deepseek` + peak/off-peak clock in the editor border; the label shows only while DeepSeek is in use (main model or a live sub-agent) |
| `agents-ui/` | the background agents on screen: dock above the editor, `↓` to manage, `/agents` / Ctrl+Shift+A list, full-screen view per agent. Parent-only; see Sub-agents |
| `local-model.ts` | `/local` llama.cpp router; bare system prompt for `llama-local` and `llama.cpp` |
| `guardrails/` | comment gate on `edit` / `write` |
| `you-should-know/` | `/ysk` side agent on deepseek-flash. **Off until `/ysk on`**; costs per check |
| `ideas/` | `/idea <text>` parks an idea per project, `pi:` in front (or any idea in the repo holding `pi-setup/extensions/ideas`) files it under the harness; `/idea` lists. `<agent dir>/ideas/*.jsonl` is append-only user data, never rewritten; the `.md` views are regenerated. `cli.js` is herdr's ⌘I popup. Parent only |
| `goal/` | `/goal` (`/goal strict <task>` sends `create-goal.md`) and the goal tools; pi-codex-goal 0.6.1 (MIT) with trimmed model text and guarded timers. Keep its stored entry type `pi-codex-goal`: old sessions' goals load by it. A continuation delivered after its goal stopped is rewritten once and stored as a `context_edit`; ones that ran are never rewritten |
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

- **Every transcript component caches its lines per width.** In fullscreen mode pi-tui renders the
  whole transcript every frame (a fresh cache per frame, `layout.js`), and `Box` reuses its output
  only when child lines come back unchanged. One row rebuilding its lines made each keystroke cost
  O(session): 180 ms at 700k context. `render-cache.test.ts` pins ours.
- **Extensions do not share module state.** Each loads with its own jiti instance and `moduleCache:
  false`; a module-level Map imported from another extension reads *empty*. Importing pure
  functions/constants is fine; cross-extension state goes over `pi.on(...)` events.
- **Any timer that outlives a session must be cleared on `session_shutdown`**, and anything a timer
  calls must be in `try`/`catch`. After session replacement the ctx is stale and every `pi.*` call
  throws — inside a timer that is an uncaughtException, and pi exits. A timer calling
  `invalidate()`/ `requestRender()` counts.
- **A `context` handler never returns a changed list**: pi then folds the system messages into one
  (`restoreSystemMessages`) and the cache is re-written. Edit `event.messages` in place for one
  request; store a lasting change as a `context_edit` from `turn_end` (goal) or a
  `before_agent_start` message (mentions).
- **Clipboard paste** loads pi's `dist/utils/clipboard-image.js` on the first paste,
  not at startup; if it is missing, leave `onPasteImage` unset (pi's path-insert).
- **Slash commands:** typed alone one opens `lib/command-menu.ts`; words go through
  `command-args.ts` (unknown word = error; no suggestion equals the typed text, or enter accepts it
  instead of sending); a setting a command changes is saved (new ones in `lib/prefs.ts`); retired
  names stay in `tools/retired-commands.ts`; shortcuts and @mentions reach `/help` only through
  `contributeHelp`. pi: `ui.input` never shows its placeholder (`askText`),
  `setEditorText` does not repaint, `sendUserMessage` runs a command only with
  `expandPromptTemplates: true`, and a command handler is awaited before the next prompt.

## Custom tools

`codemode` is a pi built-in enabled by `defaultTools: ["+codemode"]`. `read`
declares `outputSchema: Type.String()`, so scripts get raw text. **Every tool
result is redacted** (`psst.ts` `redactSecretPatterns`), scripts included; **cap
every quantifier there**: an uncapped `[\w.-]*token[\w.-]*` took 284 s on 1 MB.

`glob.ts` registers as `find`; there is no `glob` tool. The 7 GitHub tools are
separate (`read_github` … `diff`); **there is no tool named `github`**.
`web_search` tries `ext-config.json` `web-search.order` (Context.dev → DeepSeek → Parallel; `fast`
starts at DeepSeek); auth and credit failures are held for every process in
`<agent dir>/cache/web-search-health.json`. A Context.dev key allows 2 requests in flight: the chain
skips it rather than queue.

**`x_search` needs the Grok CLI login, never pi's `/login xai`**: that token reaches the proxy with
API-tier limits and no X tools, and Grok then invents posts. It renews an expiring token by running
`grok models` (it never writes `~/.grok/auth.json`), must send `x-grok-client-version` (426 without;
the floor is re-learned from the 426), keeps the relay rules in the user message (sent as
`instructions`, Grok skipped the tool), and refuses any answer without an X tool call.
**Grok only lists post ids; the posts load from FxTwitter, then X's embed endpoint** (`lib/x/hydrate.ts`).
Never make Grok retype posts by default: it streams ~94 tok/s on grok-4.6, so two long posts took
90 s. X's citations are the ground truth and arrive however little Grok writes. Grok's copy stays
for `users` and as the fallback when no source loads. A retired model is replaced from `/v1/models`.

### searchd — the index behind find and grep

`pi-setup/searchd` (Rust, ripgrep's `ignore`/`grep-*` crates) answers both tools over
`~/.pi/agent/searchd/searchd.sock`; `lib/searchd.ts` is the client. **Any refusal, error or
ack over 100 ms runs `rg`**: the tools never depend on it; nothing touches it at pi startup.
- **In a repo answers equal rg's or it refuses**; `cargo test` (fuzz included) and `searchd
  selftest` are the contract. Outside repos it may leave out skipped and unreadable folders and must
  say so. **Bump `Cargo.toml`'s version with any behaviour change** (stamps are per pair).
- **Skips** (`rules.rs`) are `F_SKIP` nodes; dependency/build names only outside a repo; a repo
  holding a skip goes to rg. `~/Desktop|Documents|Downloads` stay gated until a search inside asks
  (`Gate`, `unlocked.json`). **A glob only narrows**, never lists a .gitignored file.
- **One FSEvents stream on one root**, noise cut by exclusion paths (several paths broke event
  order). **Never exclude `/System`** (nothing arrives); a deaf stream restarts without them.
- **`sync` matches its cookie by event id and keeps `FlushSync`.** Folders compare by ctime.
  Ungrafted folders read stale (`NOT_GRAFTED`); a root re-walk drops in-flight batches. Over 50k
  folders a scope trusts the feed.
- **Credential files never enter the index** (`is_secret`); segments carry `index_rules` and a
  crc checked at open, so a rule change purges them.
- **Budgets** (`main.rs`): disk floor max(5 GiB, 5%), 1 GiB cap, index after 120 s unchanged,
  a rebuild per 600 s at most; `status.indexBlocked` says why it stopped.
- **Starts only on a passing stamp** (`selftest.json`, `ok`); another rg re-checks first, and `ok:
  false` is final for that pair (the client respawns every 60 s). No responsible app, bad HOME or
  data dir: exit before walking. Log: `<data dir>/searchd.log`.
- **Searches only for clients of the daemon's own app** (`same_app`); others get `status` and
  `shutdown`. Every wait is bounded (rg after 8 s). No Full Disk Access; placeholders are never
  read. `searchd uninstall` removes it. Protocol lines start `{"type":"searchd_`.

### Sub-agents

- **One spawn path:** the six agent tools go through `lib/agent-runs.ts` (queue of 16, background,
  notifications), `read_web_page`/`read_session` through `run-sub-agent.ts`; both start the child
  with `pi-spawn.ts` `startChild`, in RPC mode (task over stdin, closed on `agent_settled`). RPC
  gives a child `hasUI`: its dialogs are answered cancelled, and `approval.ts` treats
  `PI_SUBAGENT_TOOLS` as no UI.
- **Agent tools run in the background** only where a result can wake the caller (TUI or RPC parent;
  never `-p`, a child or a codemode script). Results come back once, as one `agent-result` message
  per batch (`triggerTurn` + `deliverAs: "steer"`) unless `agents wait`/`stop` took them. Esc does
  not stop them. `session_shutdown` does, and adds unreported results to the session unwoken; on
  `/reload` the new load continues them (`takeReloadHandoff`).
- **All six persist `<agent>-<uuid>` sessions**; `unresumableReason` refuses another agent's id
  (pre-`AGENT_NAMED_IDS_SINCE` ids are all `delegate-`, so chad may resume those). `continueId`
  steers a running run and continues a finished one, after `session-repair.ts` gives every call a
  killed child left open an error result (pi's own orphan placeholder says nothing).
- **`agents-ui` owns no run state.** It reads `muzzpi:agent-runs` and acts through
  `muzzpi:agent-runs:control` (`AgentRuns.control`: steer / continue / stop / stopAll; the answer or
  refusal comes back as `RunSnapshot.control`, a stop in progress as `stopping`). Its dock widget
  stays mounted and renders no lines when hidden; it ticks (`clock.frame`) only while a background
  run runs. A UI stop is still reported to the main agent (`delivered` stays false).
- **Never bind `ctrl+x`: it is pi's copy key** (`app.message.copy`); stop-all is `X` twice in the
  dock or list. `↓` takes the dock only from an empty editor. The agent view's input takes every
  printable key, so its actions sit on ctrl keys.
- **The six agent tools render with `renderShell: "self"`** (`lib/agent-inline.ts`): a background
  launch is one line, and its call header hides itself through the row's shared `state`.
  `install.sh` drops `RETIRED_EXTENSIONS` instead of carrying them over.
- **Models come from `pi-setup/agent-models.json` only** — see Sub-agent models.
- **The spawn graph is acyclic and pinned by `tool-contract.test.ts`:** the only agent→agent edge is
  `delegate → finder`, depth ≤ 2. chad has no `chad`/`delegate` (a swarm that spawns swarms is a
  fork bomb) and no `oracle`/`finder`/`librarian` (it already has their tools).
- **Don't use `--no-tools`** for sub-agents: it empties the registry and
  nothing can be re-activated.
- **Children load only `CHILD_EXTENSIONS`** (tools, system-prompt, guardrails, anthropic-sub) via
  `--no-extensions -e`, plus `-e builtin:codemode` when their tools include `codemode` (a script
  reaches only the child's tools; `--no-extensions` drops pi's built-ins too). An extension a child
  needs goes in that list; `PI_SUBAGENT_ALL_EXTENSIONS=1` restores the full set; `verify-patches.sh`
  fails if pi changes what `--no-extensions` keeps.

### chad — read-only

`readOnlyBash: true` sets `PI_BASH_READ_ONLY=1`; `lib/read-only-bash.ts` is an
**allowlist** of command names (fails closed) plus a **denylist** of write/exec
flags, `WRITE_FLAGS` / `POSITIONAL_OUTPUT`, matched as `-oFILE`, `-so`, and `--out`
(only for `GETOPT_LONG_ABBREVIATES`); sed scripts are parsed command by command
(`w`, `s///w`, `e`); `awk` is out. git `-c`/`--config-env`/`--exec-path=`
are refused (config names commands to run). Check anything added for
output/exec flags. A guardrail, not a sandbox.

### edit / write — pi's tools, thinly wrapped

`edit-write.ts` registers pi's own tools (`create*ToolDefinition` with injected
`operations`) under pi's names; schema, prompt text and matching stay upstream's
— **never reimplement matching**. The wrapper adds only: undo records (saved
before the write; no record, no write), `permissions.json` checked on the path
pi resolves and its realpath, `lib/mutex.ts` + `lib/file-lock.ts`, Claude's field names, and errors
naming the first differing line, column and code point. `\uXXXX` sent as text
is decoded only when that alone makes oldText match, refused in prose files
without escapes; `[REDACTED]` is never written over a real value; a control
character the file never had is refused. UTF-8 text only; no `replace_all`,
delete or move (`trash <path>` / `git mv` in bash).

**Both go out non-strict (`constrainedSampling: false`)**: pi's `strict: "prefer"`
makes Anthropic garble Claude's non-ASCII (pi #10074). Never copy pi's value
back; drop the override only once pi stops sending Claude strict.

- **This Mac: deletes are rejected, the agent uses `trash`. Over ssh: deletes run.**
  `lib/remote-command.ts` splits out server parts (ssh args and heredocs, `rsync --delete` to a
  remote dest); local-only rules carry `where: "local"`; text it cannot place stays local; keep its
  real-bash oracle test green. Undo of a creation: `lib/trash.ts`.
- **Approvals are off by default (yolo).** `ask` rules (destructive SQL, Docker volumes, buckets,
  disks), MCP DELETE and any extension that calls `requestApproval` go through `lib/approval.ts`,
  which approves without a picker and logs `"auto"` to `~/.pi/agent/approvals.jsonl`. `"approvals":
  { "enabled": true }` in `ext-config.json` (restart pi) brings back the picker (cursor on Deny;
  Deny ends the turn with `terminate`, typed instructions deny but let the agent continue), plain
  confirm in RPC, refused with no UI (sub-agents, `-p`). Reject beats ask beats allow.
- **The `ask` tool and the approval prompt share `lib/choice-dialog.ts`.** `ask` is parent-only:
  never add it to a sub-agent allowlist (`ask.test.ts` pins it). While a picker is open it emits
  `herdr:blocked` on `pi.events`, which herdr's own extension turns into the pane's `blocked` state
  and its "needs you" sound. Its `prepareArguments` must keep parsing stringified arrays: that is
  what made pi-ask's `ask_user` unusable.
- apply_patch is gone; if GPT models return, gate it by model id.
- Undo/redo refuse when a later still-applied change touches the path, or the file drifted outside
  the tool (`force: true` overrides and reports the loss). Ordering comes from position in
  `activeIds`, **never `Date.now()`**. Redo takes the *oldest* undone step; legacy move records pair
  by `movePartnerUri`.
- **`lib/mutex.ts` orders writes inside one process; `lib/file-lock.ts` is the cross-process layer**
  (one lock file per realpath in `~/.pi/agent/locks`, holding pid and time; stale when the pid is
  dead or after 60 s; 10 s wait, then an error naming the holder, `PI_SUBAGENT_ID` for a child).
  Only edit/write take it: bash, format_file and undo_edit can still race a sub-agent.

### bash — nothing runs unbounded

| | mechanism | bounds |
|---|---|---|
| L1 | **`timeout` required**, schema-bounded 1–600s | declared budget |
| L2 | idle kill: no output **and** no CPU for 300s | a hung command |
| L3 | `startChild` stall watchdog: no child output for 900s | sub-agent children |

Overrides: `PI_BASH_MAX_TIMEOUT_SEC`, `PI_BASH_IDLE_KILL_SEC` (0 disables),
`PI_SPAWN_STALL_SEC`, `PI_BASH_CPU_LIVENESS`.

- **CPU liveness can only keep a command alive, never kill it**; `proc-cpu.ts`
  returns `undefined` on failure, degrading to output-only.
- The idle timer runs from t=0 (pipes block-buffer), stamped on raw chunk arrival; the
  machine-sleep guard (`SLEEP_JUMP_MS`, `watchdog.ts`) is checked first and wins.
- Killing ≠ released: `FORCE_RELEASE_MS` (10s) resolves even when a grandchild holds stdout. The
  child is **not** spawned `detached` (Ctrl+C must reach it). 900s sits above pi's HTTP idle (300s)
  + retry; re-check those before shrinking it.
- **bash keeps pi's codemode contract**: `structuredContent` on every exit code (a script's `grep`
  miss is data, not a throw); timeout/idle/abort/signal stay errors. The `tool_result` scrub hook
  must return `structuredContent` too — `content` alone makes pi drop it.

### screenshot / vision budget

`resizedSize`/`countImageTokens` must match Anthropic's reference code (fuzzed
in `vision.test.ts`). Tiers: standard 1568px/1568 tokens, high-res (Claude
4.7+) 2576px/4784; `tierForModel` picks from `ctx.model`.

- **`fitImageFile` is the only path from pixels to a vision model** (`screenshot`
  and `read`). `sips` is a codec, never a resizer; `planView` decides geometry.
- **Every output must pass pi's tool-image normalizer untouched** (`agent-session.js` →
  `normalizeToolResultImages`): side ≤ 2000px and base64 < `inputLimits.images.resize.maxBytes` (4.5
  MiB). Anything over is silently re-encoded by pi. `image-fit.test.ts` runs pi's real normalizer to
  pin this.
- Side cap 2000px (`maxSide`): past 20 images per request the API rejects
  larger ones, and history is resent every turn.
- **pi does not enforce the 32 MiB request limit**; one oversized request is a 413 on every later
  turn. `lib/image-budget.ts` measures the context (`buildSessionProjection`) plus in-flight calls
  and refuses before it.
- Media type comes from the bytes, never the extension (a mismatch is a 400).
  sips ignores EXIF orientation, so `orient()` applies it.
- **Chromium returns BLANK past 16384px** without erroring; `MAX_RENDERABLE_HEIGHT`
  clips and reports it. Full-page captures scroll through once first, or lazy content is missing.
- macOS: every tab is its own `NSWindow`; `CGWindowListCopyWindowInfo` option `0`, never `1`. A
  window is captured where it is; only after a failure, or for a Stage Manager thumbnail, is its app
  activated, **by pid**, and focus handed back only if it still has it. Run
  `port-harness/screenshot-live.ts` after touching `lib/capture.ts` (needs Screen Recording).
- `permissions.json` blocks the capture binary in bash but deliberately not `sips`.

## TUI width — the invariant

**Clamp with the same function pi-tui asserts with** (`visibleWidth` /
`truncateToWidth`). pi-tui throws `Rendered line N exceeds terminal width` as an
uncaughtException, which kills pi. `lib/box-format.ts` `normalizeForDisplay()`
is the render chokepoint for box and sub-agent rendering (display only — model
text is never modified).

1. **Undercount → smear.** pi-tui measures grapheme clusters; terminals advance per spacing
   codepoint. The width patch makes `graphemeWidth()` overcount, never undercount.
2. **Control char in a single-line sink → smear.** A `\n` is width-0 to every check yet moves the
   cursor: editor labels (`flattenLabelText`), widget rows (`flattenSegmentText`) and any truncated
   summary must flatten. Multi-row `renderCall` output is fine.

If it returns: `apply-pi-tui-width-patch.mjs --check` first, then
`pi-setup/render-repro/`, then hunt for a control char in a single-line string.

## Sub-agent models

**`pi-setup/agent-models.json` is the only place a sub-agent model is named.**
`models` maps a short name to a `provider/model` id; `agents` gives each
spawning tool a default `model` + `thinking`. Changing a default is a one-line
edit there, deployed by `install.sh`, read at session start.

- Every spawning tool takes optional `model` (enum of the names) and `thinking` (pi's 7 levels;
  "med" etc. accepted), resolved by `lib/agent-models.ts`; the parent learns the names from the
  `{agent_models}` prompt section.
- **The enum is enforced during decoding on xAI**: a parent cannot emit a name outside the
  list and picks the nearest one. The prompt line forbidding substitution stops that; keep it.
- **pi runs an unknown `--model` anyway**, so the resolver checks `modelRegistry.find` +
  `hasConfiguredAuth` first (an expired token still comes back as the child's error). A failing
  **default** drops `--model` (pi's default runs, so a missing `DEEPSEEK_API_KEY` degrades); a
  failing **explicit** model is refused.
- **pi's `--model` resolver can fall back to another provider's look-alike**, so `pi-spawn.ts`
  SIGKILLs a child whose first assistant message names another provider/model than requested, or,
  with none requested, one not in `agent-models.json` (`modelViolation`). Keep every Claude id
  `anthropic/`. Ids must be provider-qualified; a `continueId` resume keeps the child's model.

## Local models

**llama.cpp must be >= b10270** (older builds mangle `lfm2` tool calls). Check
`llama-server --version` first if local tool calling goes strange; compare the
build number (`0.6.0 (build 11429)`).

pi's `/llama` uses provider `llama.cpp` (`/login llama.cpp`); ours is `/local` + provider
`llama-local` (no login, always listed, no auto-start). For those two providers only,
`local-model.ts` **replaces** the system prompt with a short tool crib and skips the rules
section. **Do not widen those two provider gates.** Local models loop for minutes on
self-directed work — always time them out. Gotchas: it's `ctx.hasUI`, not `ctx.canPrompt`
(falsy in a real TUI); `toLocaleString()` follows the en-IN locale — always pass `"en-US"`.

## Skills

`~/.config/agents/skills/` (source: `pi-setup/config-skills/`) plus
`~/.agents/skills/` (not from this repo). A skill's `description` is sent on
every request — keep it to what decides loading. **The `skill` tool serves
exactly pi's resolved skills** (`systemPromptOptions.skills`) with no discovery
of its own, so a package's `skills: []` hides its skills from both.

Ports with author prefixes (**`c-`**, **`mat-`**, **`dm-`**) had Claude-Code/Cursor
machinery mapped to pi tools or cut; every subagent they spawn is read-only.

## Agent mention directives

`@oracle @finder @codereview @task @chad` → hidden `display: false` directive to call that tool
(`codereview` → `code_review`, `task` → `delegate`); data mentions add context the same way,
stored once after the user's message (`before_agent_start`), never re-injected from `context`.
**Keep the explicit `import "./tools/lib/mentions/agent-source.js"`** in `mentions.ts` (the
barrel `export *` may not evaluate it). Don't add `/value` to agent mentions.

## Update workflow

0. **Update pi with `bash pi-setup/update-pi.sh <ver>`, never `pi update --self`.** Self-update
   repoints `bin/pi` at `dist/bundle/cli.js`, which disables every core patch. It and `install.sh`
   refuse a pi whose stock patched files (listed once, in `pi-core-patches/patches.sh`) differ from
   `base-version`'s.
1. **`bash pi-setup/verify-patches.sh`** — always first.
2. **Grep our own CLI call sites.** An import-level audit cannot see a change in how pi reads the
   arguments `pi-spawn.ts` passes (`--model --thinking --tools --mode --session-id`) or the RPC
   records it uses (`prompt`+`streamingBehavior`, `abort`, `agent_settled`, dialog requests); pi
   0.84's #7327 silently killed every sub-agent that way. When a release touches model resolution,
   tool filtering, CLI arguments or RPC, call one real sub-agent before declaring it clean.
3. **pi core update** → re-derive the 4 core patches against the new stock files (never blind-copy;
   see `pi-migrations.md`) + the width patch, then rebuild (`update-pi.sh` does). The
   `@mariozechner/*` compat aliases will eventually go — then rename imports.
4. **tools extension deps** (`extensions/tools/package.json`) → `npm outdated`
   there; `npm ci` (node_modules is gitignored), then `bun test` before deploying.
5. **After any pi update, make one real `edit` and `write`**: the wrapper rides
   on pi's `operations` and error strings.

Per-version record: `pi-setup/pi-migrations.md`. Read it before `pi update`.

## What NOT to do

- **Don't edit `/opt/homebrew/lib/node_modules/` directly** — wiped on update.
  Edit in `pi-setup/`, deploy with `install.sh`.
- **Don't run `install.sh` without checking what changed** — it overwrites live tweaks (after
  backing them up). `--dry-run` prints every write first.

## Where the detail lives

- `pi-setup/2026-10-03-cache-playbook.md` — the Max-plan cache drain: measurement, root
  cause, fix, every wrong turn. **Read before touching anything that shapes the prompt.**
- `pi-setup/2026-06-15-anthropic-login-analysis.md` — `/login anthropic` vs Claude Code OAuth
- `pi-setup/pi-migrations.md` — per-update record. **Read before `pi update`.**
- `git log -p AGENTS.md` — everything ever cut from this file
- `git log --diff-filter=D --name-only -- pi-setup/` — deleted incident write-ups
