# muzzpi · pi-setup

The full inventory of the [muzzpi](../README.md) harness: every extension, tool,
prompt, config file and patch, and where each one is installed.

> **`AGENTS.md` (repo root) is the authoritative, maintained reference.** It documents every
> patch, provider, migration, and gotcha in depth. This README is a concise overview — when in
> doubt, read `AGENTS.md`.

## Install

```bash
./install.sh pi --dry-run   # from the repo root: every change, nothing written
./install.sh pi
```

The script finds pi from the `pi` on `PATH` (`pi-location.sh`; Homebrew, nvm or any npm
prefix), backs up everything it overwrites (pi's own stock files are kept as `*.stock`),
re-links `pi` off the bundled build so the core patches load, installs npm deps and the pi
packages, re-applies all patches, and runs `verify-patches.sh` at the end.

After **any** pi/package update, re-run the audit first:

```bash
bash pi-setup/verify-patches.sh          # all PASS = good
node pi-setup/pi-core-patches/apply-pi-tui-width-patch.mjs --check   # exit 0 = good
```

## What's Inside

### Extensions

pi auto-discovers every `.ts` in `extensions/` — there is no "present but disabled" state; to
disable one, delete it or move it out of `extensions/`. An extension can still ship its own
off switch (`you-should-know/` starts off and waits for `/ysk on`), but nothing at the
loader level turns one off.

| Extension | What it does |
|---|---|
| `editor/` | Custom box-drawing bordered editor with labels (context %, cost, model, git branch), enlarged prompt bar, inline `[image #N]` clipboard-paste, and a cache line below the box (hit %, read/write totals, and a TTL countdown where the provider declares one) |
| `tools/` | Full replacement tool suite. See below. |
| `system-prompt.ts` | Injects the full Amp system prompt with runtime template vars (parent sessions); a sub-agent instead gets a short generated prompt naming exactly its own `--tools` allowlist |
| `mentions.ts` | `@mention` resolution (`@session`, `@commit`, `@handoff`) + agent directives (`@oracle`, `@finder`, `@codereview`, `@task` → `delegate`) |
| `session-name.ts` | Auto-generates session names from the first message (Claude Haiku) |
| `stats/` | `/stats` or `Ctrl+Shift+S` — usage analytics over every session: cost, tokens, cache hits and busts, models, tools, sub-agents, projects and commits, work rhythm, and a wrapped card, with ▲/▼ vs the previous window, `p`/`o` project and provider filters, a model leaderboard, cache-bust log and context pressure. `/stats export [range]` writes markdown, `/stats wrapped [range]` a PNG, `/stats budget <usd>` sets a monthly budget with a linear projection, `/stats widget on` shows today's spend under the editor |
| `md-export.ts` | `/md` — exports the current session branch to readable markdown (clipboard or file) |
| `notify.ts` | Desktop notification when the agent finishes (OSC 777) |
| `command-palette/` | `Ctrl+Shift+P` command-palette overlay |
| `subagent-inspector/` | `Ctrl+Shift+A` / `/subagents` — drill into a sub-agent's live transcript |
| `local-model.ts` | `/local` — start/stop the llama.cpp router |
| `deepseek-peak/` | `/deepseek` — a peak/off-peak pricing clock in the editor border |
| `guardrails/` | Comment gate on `edit` / `write` (the behaviour rules themselves ship in the system prompt, not here) |
| `theme-studio/` | `/studio`, `/theme`, `Ctrl+Shift+K` — live-preview a pi theme and the Ghostty theme/font/size; Esc reverts, Enter keeps |
| `you-should-know/` | `/ysk` — a side agent on `deepseek-flash` that flags what you might have missed, and inlines what each sub-agent actually did as evidence. **Off until `/ysk on`**; ~0.1–0.3¢ per check |

### Custom Tools

The `tools/` extension replaces pi's built-ins and adds new tools:

**Replaced built-ins**: `read`, `ls`, `grep`, `find` (registers as `find`), `bash` — all with
mutex locking, secret scrubbing, permission rules, and sub-agent compact modes.
`edit` / `write` are pi's own tools wrapped with undo tracking, permission rules, the shared
file lock, Claude's field names and clearer errors (`edit-write.ts`).
`format_file`, `skill`, `undo_edit` / `redo_edit` round out the replacements.

**Dedicated sub-agents** — each runs on the model and thinking level `agent-models.json` names
for it; a call can pass `model` / `thinking` to override:
- `finder` — concept-based code search (read-only)
- `oracle` — technical advisor that returns a verdict
- `chad` — read-only research agent that returns cited evidence
- `librarian` — GitHub repo explorer
- `code_review` — two-phase review
- `delegate` — full resumable sub-agent for parallel independent work
- `read_web_page` — static web page reader; `prompt` / `objective` spawn a Q&A / excerpt child
- `read_session` — past-session reader

**Other tools:** `search_sessions`, `screenshot`, `web_search` (Parallel AI), `agent_message`.

**New GitHub tools** (GitHub API): `read_github`, `search_github`, `list_directory_github`,
`glob_github`, `list_repositories`, `commit_search`, `diff`

Also adds `/psst*` secret-vault commands + a tool-output secret-scrub hook.

### Agent Prompts (`agents/`)

The parent system prompt (`prompt.amp.system.md`), the shared rules (`rules.amp.md`), the pi
harness notes, and one prompt per sub-agent. `verify-patches.sh` checks each one is deployed.

### Claude Integration

Claude Max is used via pi's **native `anthropic` provider** + the `@benvargas/pi-claude-code-use`
package, which rewrites provider API payloads for Claude Code-style subscription (OAuth) use — no
custom bridge/provider needed.

```bash
/login anthropic
/model anthropic/claude-opus-5-5
```

### Providers / Models

`enabledModels` in `settings.json` is what `/model` lists: the three Claude models (Max OAuth via
pi-claude-code-use, default `claude-opus-5-5`), `deepseek/deepseek-flash` and
`deepseek/deepseek-v4-pro` (`$DEEPSEEK_API_KEY`), `river/deepseek-ai/DeepSeek-V4.1-Flash`
(`$RIVER_API_KEY`; same weights, flat 20% under DeepSeek's off-peak rate, no peak surcharge), and
two openrouter models.

| Provider | Access |
|---|---|
| `anthropic` | Claude Max OAuth (`/login anthropic`) via pi-claude-code-use |
| `deepseek` | `$DEEPSEEK_API_KEY` |
| `river` | `$RIVER_API_KEY`; models.json sets `supportsDeveloperRole: false` because River accepts the `developer` role and silently drops it |
| `openrouter`, `xai`, `openai-codex`, `kimi-coding` | `/login`; xai/codex/kimi models are in the catalog but not in `enabledModels` |
| `llama-local` (`LFM2.5-2.6B`) | local llama.cpp router, managed via `/local` |

### Themes (`themes/`)
gruvbox (active), nightowl, catppuccin-mocha, black-metal.

### Skills
Config-level (`config-skills/` → `~/.config/agents/skills/`):
`chrome-cdp`, `dataforseo`, `design-port`, `dig`, `git`, `jev`, `review`, `server-ops`, `tmux`
plus external skills adapted for pi (author-prefixed):
`c-sqr` (cursor — strict quality review), `mat-design` / `mat-tdd` (matt pocock), `dm-antislop` (dmmulroy).
Mnemonic: `c-` cursor, `mat-` matt, `dm-` dmmulroy.
`find-skills` and `userinterface-wiki` live in `~/.agents/skills/`; they are not part of this repo
and `install.sh` does not create them.

### Settings
- Default provider/model: `anthropic` / `claude-opus-5-5` (thinking high)
- Theme: gruvbox · Thinking: high · Compaction: **enabled** (pi's native LLM compaction)
- Steering/follow-up: all · Quiet startup

### Permissions
- Blocks `git add -A` / `git add .` (forces explicit staging)
- Blocks force push
- Blocks every way to delete on this Mac — `rm`, `rmdir`, `unlink`, `shred`, `find -delete`, `git rm`, `git clean`, delete calls in scripts (use `trash` instead). Deletes inside `ssh host '...'` run normally.
- Asks before destroying data, here or on a server: SQL `DROP`/`TRUNCATE`/`DELETE` without `WHERE`, Docker volumes, cloud buckets and databases, disks, and an MCP `DELETE`. No UI (a sub-agent) means refused; every answer goes to `~/.pi/agent/approvals.jsonl`.

### Pi Packages
`settings.json` `packages` is the list: `@benvargas/pi-claude-code-use`, `pi-codex-goal`,
`pi-mcp-adapter`.
See `AGENTS.md` → "Packages (npm)" for versions and patches, and "Removed — do not reinstall"
for the packages that were taken out on purpose (`verify-patches.sh` fails if one comes back).

## Directory Structure

```
pi-setup/
├── install.sh                  # One-command installer (deploys + re-applies patches; --dry-run)
├── update-pi.sh                # The only supported way to update pi itself
├── pi-location.sh              # Finds pi's package dir from the `pi` on PATH (sourced by the scripts)
├── settings.json               # Pi settings (provider: anthropic, model: claude-opus-5-5)
├── agent-models.json           # Sub-agent model list + per-agent default model/thinking
├── keybindings.json            # Custom keybindings
├── models.json                 # Custom providers + context-window overrides
├── permissions.json            # Tool permission rules
├── mcp.json                    # pi-mcp-adapter global MCP servers
├── build-extensions.ts         # Bundles each extension into one .js (run by install.sh)
├── verify-patches.sh           # Read-only audit of every patch/config
├── extensions/                 # extensions + tools/ suite
│   ├── editor/                 # Custom TUI editor + cache line
│   ├── command-palette/        # Ctrl+Shift+P palette
│   ├── subagent-inspector/     # Ctrl+Shift+A sub-agent transcript inspector
│   ├── theme-studio/           # /studio — live theme + Ghostty preview
│   ├── deepseek-peak/          # /deepseek — peak/off-peak clock
│   ├── guardrails/             # edit/write comment gate
│   ├── you-should-know/        # /ysk — side agent (off until asked)
│   ├── tools/                  # custom tools + shared lib/ (tests run here: bun test)
│   ├── stats/                  # /stats — usage analytics dashboard
│   ├── system-prompt.ts  mentions.ts  session-name.ts
│   └── md-export.ts  notify.ts  local-model.ts
├── agents/                     # system prompt, rules, sub-agent prompts
├── themes/                     # pi themes
├── pi-skills/                  # pi-level skills (→ ~/.pi/agent/skills/); currently empty
├── config-skills/              # config skills (→ ~/.config/agents/skills/)
├── pi-core-patches/            # resource-loader + session-pinning + pi-tui width patches
├── pi-migrations.md            # Per-update record. Read before updating pi
├── 2026-*.md                   # Investigations: migrations, the bdsqqq port, MCP, cache, login
└── README.md                   # This file
```

## If Anything Breaks

1. `bash pi-setup/verify-patches.sh` — each FAIL prints its exact fix command.
2. Read `AGENTS.md` — it has the full record of every patch, provider, and migration, plus
   rollback notes. Check there first.
