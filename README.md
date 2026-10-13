# muzzpi

**pi, fully loaded.**

My harness for [pi](https://pi.dev), the terminal coding agent. Six sub-agents
that research, review and build in parallel. Web search, GitHub and screenshots
built in. Edits you can undo. A TUI made for all-day sessions, with live theme
and Ghostty previews. Everything vanilla pi leaves for you to build, already built.

pi's homepage says *"There are many agent harnesses but this one is yours."* This
one is mine. Built and used daily by [Muzzammil](https://itsmuzz.com) since March
2026.

```bash
git clone https://github.com/humblemuzzu/muzzpi.git && cd muzzpi
./install.sh pi --dry-run    # every change it would make, nothing written
./install.sh pi
```

---

## Why it exists

pi is deliberately small. Out of the box the model gets four tools (`read`,
`bash`, `edit`, `write`), and the README says it *"skips features like sub-agents
and plan mode. Ask Pi to build what you want."*

So I did. Everything here is an extension, a config file or a patch on top of
stock pi. Nothing is forked.

## What vanilla pi doesn't have

| | vanilla pi 1.1 | muzzpi |
|---|---|---|
| Tools the model gets | 4 on by default | 30 of its own, plus codemode and one lazy MCP proxy |
| Sub-agents | none, by design | 6, each with its own model and thinking level, resumable |
| Editing | `edit` + `write` | the same `edit` + `write`, plus undo/redo that refuses to clobber drift, permission rules, a comment gate, and errors that show the closest line |
| Bash | timeout optional, no default | timeout required (1–600s), killed after 300s of no output and no CPU |
| Command rules | none | `permissions.json`: no `git add -A`, no force push, no deleting (`trash` only), no shelling out to other agents |
| Secrets | in the clear | scrubbed from every tool result before the model sees it |
| Web | none | `web_search`, `read_web_page` with a Q&A child |
| GitHub | none | 7 tools over `gh api`: read, search, glob, list, commits, diff |
| Screen | none | `screenshot` of any window, region or URL, sized to Claude's vision limits |
| History | session picker | `search_sessions`, `read_session`, `agent_message` between live sessions |
| Session list | stock | pinning (`Ctrl+B` in `/resume`) |
| Comments | whatever the model writes | a gate that refuses a patch that is mostly commentary |

## The sub-agents

Every sub-agent is a fresh pi process with its own short prompt naming exactly
the tools it has. Pick by what you need back:

| Agent | Returns | Use it to |
|---|---|---|
| `finder` | file paths and line ranges | locate code by concept, fast |
| `chad` | an answer with `path:line` evidence, verified vs inferred | find out what is true; swarm several at once, one question each |
| `oracle` | one verdict, trade-offs, effort | decide; review a plan or a hard bug |
| `delegate` | finished work | hand off an independent task; resumable by `continueId` |
| `librarian` | an explanation across repos | read code on GitHub you have not cloned |
| `code_review` | a structured review | review a diff described in plain words |

- **chad cannot write.** No `edit` or `write`, and its bash runs under an allowlist
  that refuses redirection, `sed -i`, interpreters and every git subcommand that
  mutates. Finding out is chad; doing is delegate.
- **The spawn graph is acyclic and pinned by a test.** The only agent that can
  start another is delegate (it can call finder). A chad swarm can never spawn
  its own swarm.
- **Models live in one file.** [`agent-models.json`](pi-setup/agent-models.json)
  names a short list of models and a default per agent. Say *"three chads on
  deepseek flash at medium"* and the parent passes exactly that. A model not on
  the list is refused, never swapped for the nearest one. Every result ends with
  the model and thinking level that actually ran.
- **`@oracle`, `@chad`, `@finder`, `@codereview`, `@task`** in a message force
  that agent.

## The tools

- **`edit`** and **`write`** are pi's own tools with a thin layer on top: every
  change is recorded so `undo_edit` / `redo_edit` walk it back, even after a
  restart. Why not a patch format: [the edit-tool record](pi-setup/2026-10-11-edit-tool.md).
- **`web_search`** and **`read_web_page`**: fetch a page, or ask a question about
  it and get an answer from a child agent.
- **7 GitHub tools** read, search and diff any repo you can see, without cloning.
- **`screenshot`** captures a window, a region of the screen or a whole web page,
  already sized for the model to read small text.
- **`search_sessions`** and **`read_session`** pull context out of any past
  conversation; **`agent_message`** sends work to another live session.
- **codemode** batches dozens of tool calls in one script, and one **`mcp`** proxy
  reaches 19 MCP servers (Chrome DevTools, Cloudflare, Paper, Astro) that only
  connect when first used.
- **13 skills** load on demand: debugging, code review, TDD, design ports, git,
  SEO data, server work over ssh, and more.

## The TUI

- A box-drawn editor with model, context, cost and git branch on the border, and
  a cache line under it: hit rate, read/write totals, time left on the cache.
- `Ctrl+Shift+A` opens any sub-agent's live transcript.
- `/studio` previews pi themes **and** your Ghostty theme, font and opacity live.
  Esc reverts, Enter keeps.
- `/stats` (`Ctrl+Shift+S`): a nine-tab usage dashboard covering cost, tokens,
  cache hits and busts, models, tools, sub-agents, projects matched to commits,
  your work rhythm, and a wrapped card.
- `Ctrl+Shift+P` command palette, `/md` export, desktop notifications, auto-named sessions, a DeepSeek peak-pricing
  clock, and `/ysk`, an opt-in side agent that flags what you might have missed.
- Pin sessions with `Ctrl+B` in `/resume`.
- A patched pi-tui that never undercounts character widths, so Hindi, Bengali
  or emoji in tool output cannot smear the screen.

## Built to run all day

- **Nothing runs unbounded.** Three layers: a declared timeout on every command,
  an idle kill when a command stops printing and stops using CPU, and a 900s
  stall watchdog on sub-agents. A machine sleep never counts as a hang.
- **A failed command is a failure.** Exit codes and stderr reach the model as
  they happened. A package that reported failed `git add` as success was
  removed the day it was caught.
- **Images can't break a session.** Every screenshot and image read is sized to
  Claude's published vision limits before it is sent, and the harness refuses
  a call that would push the request past the API's 32 MiB ceiling. That is a
  limit pi does not check, and crossing it once means a 413 on every later turn.
- **The prompt never changes mid-session.** One mutating hook once rewrote the
  prompt cache on every turn and drained 19% of a Max plan's week in under a
  day. The system prompt and tool schemas are now frozen at session start.
- **Working rules ship in the system prompt**, not in a hook: scope, evidence,
  no comments by default, and a hard stop before anything that deletes data,
  rewrites git history or publishes.
- **Deletes are scoped, data loss asks.** Deleting files on your Mac is blocked
  (`trash` instead); on a server over ssh it just works. Dropping a table, a
  Docker volume, a bucket or a disk, or an MCP `DELETE`, stops for an Allow/Deny
  dialog first. A sub-agent cannot approve one, and every answer is logged.
- **Secrets stay out of the model's context.** Every tool result is scrubbed of
  vault values, key formats (Stripe, GitHub, AWS, Anthropic
  and more), private keys, bearer tokens, URL passwords, and random-looking
  values next to secret names, while code that merely mentions a token stays
  readable.

## Things that broke

Seven months on a fast-moving agent means a lot of things broke silently. The
ones worth knowing about:

- **The cache drain.** A hook re-added a note to the message list every turn.
  83,658,669 cache-write tokens, 99% of everything metered, 19% of a $200 plan's
  week in under 24 hours. Fixed by moving the rules into the system prompt.
  The whole investigation, mistakes included:
  [cache playbook](pi-setup/2026-10-03-cache-playbook.md).
- **A pi update killed every sub-agent.** pi 0.84 made bare model ids an
  ambiguity error, and every spawn died on start. One fix at the single spawn
  point; the update workflow now calls a real sub-agent before calling it clean.
- **For months, custom tools never reached Claude.** The OAuth shim filtered out
  every tool not named like Claude Code's, so Claude wrote tool calls as plain
  text and invented the results.
- **Sub-agents asked for tools that did not exist.** `glob`, `edit_file` and
  `create_file` are not pi names, so they were dropped without a word, and the
  editing agent could not edit.
- **Hindi broke the screen.** pi-tui measured `क्त्र` as 1 column, Ghostty drew 3,
  and the whole TUI desynced. Fixed with a patch applied to every pi-tui copy
  on the machine, and a render harness to prove it.
- **3 GB of duplicates.** Three npm roots held 18 stale pi packages and 24 copies
  of pi-tui. Now there is 1, patched, loaded.
- **A 700k-token session took 180 ms per keystroke.** pi-tui redraws the whole
  transcript every frame, and the edit/write diff renderer re-cut all 3,267 of
  its lines each time. Diffs now render once per width, three packages that
  cost 600 ms of startup went, and each extension ships as one prebuilt file:
  10 ms per keystroke, 1.1 s to 0.44 s to start (every sub-agent too).
- **`pi update --self` silently disables every patch.** It points `pi` at a
  bundled build that ignores patched files. Updates go through
  [`update-pi.sh`](pi-setup/update-pi.sh) instead.

Every pi release since 0.82 has a written migration record:
[`pi-migrations.md`](pi-setup/pi-migrations.md).

## The graveyard

19 packages were installed, used, and removed. `verify-patches.sh` fails if any
of them comes back.

| Package | Why it went |
|---|---|
| `@tomooshi/condensed-milk-pi` | reported failed git commands as successes |
| `pi-autoresearch` | its prompt guidelines changed mid-session, rewriting the cache |
| `pi-tasks` | array parameters arrived JSON-stringified; `task_plan` always failed |
| `pi-web-access` | every search provider key was rejected or rate-limited |
| `pi-context` | checkpoint spam; pi's own `/compact` covers the need |
| `pi-computer-use` | its GUI tools never registered |
| `pi-claude-bridge`, `claude-agent-sdk-pi` | replaced by native Anthropic + `pi-claude-code-use` |
| `@sting8k/pi-vcc` | redundant once native compaction landed |
| `lsp-pi`, `pi-powerline-footer`, `pi-anycopy` | installed where pi never loads them |
| `pi-gpt-config`, `pi-ask`, `pi-grok-cli`, `todos` | unused |
| `@marckrenn/pi-sub-bar` | +324 ms per start for a widget with every provider off |
| `pi-tool-display` | rewrote stored messages, then spliced the whole context on every request |
| `pi-token-burden` | +143 ms per start for one diagnostic command |

## By the numbers

As of October 2026:

| | |
|---|---|
| First commit | 2026-03-10 |
| Commits | 105, on 57 different days |
| Lines changed | +97,381 / −37,598 |
| Tests | 1,877 across 56 files, 0 failing |
| pi releases lived through | 20+, from 0.67 to 1.2 |
| Default-model changes | 17, across six providers: Opus 4.6 → GLM 5.1 → Kimi → GPT-5.5 → Grok 4.6 → Opus 5.5, and back again more than once |
| MCP servers wired in | 19, none connected until first use |
| Skills | 13 |
| Commits made on a Thursday | 34 |
| Commits made between midnight and 5am | 20 |

## Install

**Needs:** macOS (built and tested there), node ≥ 22.19, bun (the installer
bundles each extension into one file so pi starts fast), and pi itself:
`npm install -g @earendil-works/pi-coding-agent`. Homebrew, nvm and any other
npm prefix all work; the installer finds pi from the `pi` on your `PATH`.

**Default model:** Claude Opus 5.5 on a Claude Max subscription (`/login
anthropic` inside pi). To use something else, change `defaultProvider` and
`defaultModel` in [`pi-setup/settings.json`](pi-setup/settings.json).

**Optional, one feature each** (the installer tells you what is missing):

| | turns on |
|---|---|
| `DEEPSEEK_API_KEY` | cheap sub-agents (chad, finder, librarian, read_session, read_web_page); without it they run on your main model |
| `RIVER_API_KEY` | DeepSeek V4.1 Flash via River in `/model`, cheaper than DeepSeek in its peak hours |
| `PARALLEL_API_KEY` | `web_search` |
| `gh auth login` | the 7 GitHub tools |
| `ripgrep`, `trash` | `grep`/`find`, safe deletes |

```bash
./install.sh pi --dry-run   # read this first
./install.sh pi
```

The installer backs up everything it overwrites, including pi's own stock files
(kept as `*.stock` beside the patched ones). It installs nothing globally, and
ends by running [`verify-patches.sh`](pi-setup/verify-patches.sh), which prints
the exact fix for anything that did not land.

**After any pi or package update:**

```bash
bash pi-setup/update-pi.sh <version>   # updating pi itself; never pi update --self
bash pi-setup/verify-patches.sh        # after any pi install / package update
```

## Ghostty

The repo started as my Ghostty config, and it still ships one: 22 dark themes,
11 fonts, and `gt` / `gf` / `gc` switchers that preview live as you scroll.
`./install.sh ghostty`, details in [`ghostty/`](ghostty/README.md). Each half
installs on its own.

## Layout

```
muzzpi/
├── install.sh              ./install.sh pi | ghostty
├── AGENTS.md               the rules and facts every agent reads first
├── pi-setup/
│   ├── extensions/         editor, sub-agent inspector, theme studio, guardrails, …
│   │   └── tools/          the 30 tools and their tests (bun test)
│   ├── agents/             system prompt, working rules, one prompt per sub-agent
│   ├── agent-models.json   which model each sub-agent runs on
│   ├── permissions.json    what bash may never do, and what needs your approval
│   ├── pi-core-patches/    the 3 patched pi files + the pi-tui width patch
│   ├── config-skills/      13 skills
│   └── *.md                migration records and investigations
└── ghostty/                themes, fonts, switchers
```

**Read next:** [`AGENTS.md`](AGENTS.md) for how it all fits and what not to
break, [the cache playbook](pi-setup/2026-10-03-cache-playbook.md) for the best
bug, and [`pi-setup/README.md`](pi-setup/README.md) for the full inventory.

## Credits

- [pi](https://github.com/earendil-works/pi) by Mario Zechner, the engine all of
  this sits on.
- [Amp](https://ampcode.com): the system prompt started as a port of Amp's, which
  is why the prompt files are still named `*.amp.*`.
- [bdsqqq/dots](https://github.com/bdsqqq/dots): the sub-agent wiring and
  `delegate` began as a port from there.
- The packages it runs: [pi-claude-code-use](https://github.com/ben-vargas/pi-packages)
  by Ben Vargas, [pi-codex-goal](https://github.com/fitchmultz/pi-codex-goal) and
  [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter).
- Skills adapted from Matt Pocock (`mat-*`), dmmulroy (`dm-*`) and Cursor (`c-*`).
- Ghostty theme palettes inspired by [opencode](https://github.com/anomalyco/opencode).

## License

MIT.
