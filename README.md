# muzzpi

**pi, fully loaded. Nothing forked.**

A harness for [pi](https://pi.dev), the terminal coding agent. Six sub-agents
that research, review and build in parallel. Web, GitHub and screenshot tools.
Edits you can undo. A TUI built for all-day sessions. And a pi that starts as
fast as stock, with every patch inside.

**35** tools · **6** sub-agents · **19** MCP servers · **14** skills ·
**0.27 s** to a ready prompt · on stock pi **1.3.0**

```bash
git clone https://github.com/humblemuzzu/muzzpi.git && cd muzzpi
./install.sh pi --with-deps    # installs what is missing, then the harness
```

The installer checks your pi before it touches anything, backs up whatever it
overwrites, and ends with an audit that prints the exact fix for anything that
did not land. `--with-deps` installs the Homebrew formulae it needs, pi at the
version its patches were made on, and Rust if searchd is to be built. Without
it, the installer installs nothing you are missing and names what it is;
`--dry-run` prints every change and makes none.

Built and used daily by [Muzzammil](https://itsmuzz.com) since March 2026.

---

## In daily use

The last 30 days, one machine:

| | |
|---|---|
| Sessions | **196**, on 29 of the 30 days |
| Tool calls | **18,905** |
| Sub-agent runs | **1,016**: delegate 479 · chad 249 · read_web_page 103 · code_review 100 · oracle 23 · librarian 21 · read_session 21 · finder 20 |
| Screenshots | 270 |
| Web searches | 99 |

Every number in this README comes from the repo, those sessions, or a benchmark
on an M4 Pro (48 GB, macOS 27).

## Fast

| | patched pi, the old way | muzzpi now |
|---|---:|---:|
| Open pi until you can type | 447 ms | **272 ms** |
| Each sub-agent start | 348 ms | **186 ms** |
| Full start, all 17 extensions | 376 ms | **211 ms** |
| `pi --version` | 269 ms | **111 ms** |
| Memory per pi process | 163 MB | **138 MB** |

Medians of 11–15 runs, alternated between versions so load hits both equally.

- **pi's own build recipe, on our patched files.** pi ships a fast prebuilt
  copy of itself, but it was built before any patch, so a patched pi had to run
  its slow loose files. [`build-pi-bundle.mjs`](pi-setup/pi-bundle/build-pi-bundle.mjs)
  runs pi's own recipe on the patched files instead. On stock pi it reproduces
  75 of pi's 80 files byte for byte; the other 5 are newer dependencies npm
  resolved. It matches stock speed exactly (111 vs 109 ms) and refuses to build
  when pi changes its recipe.
- **MCP servers connect when first used.** Stock pi connects every server at
  startup; its own prebuilt copy takes 733 ms to start with this setup.
- **Each extension ships as one prebuilt file.** Sub-agents load the 4 they need,
  not all 17.
- **Every transcript row caches its render.** A 700k-token session types at
  10 ms per keystroke; it was 180.

Opening pi went from 1.1 s to 0.44 s to 0.27 s since March.

### Search

`find` and `grep` are answered by **searchd**, a small Rust daemon built on
ripgrep's own crates, and fall back to `rg` whenever it cannot vouch for an
answer.

| | `rg`, every call | searchd |
|---|---:|---:|
| `find **/*.ts`, this repo (443 files) | 8.2 ms | **1.1 ms** |
| `find **/AGENTS.md`, 63k files of projects | 109 ms | **14 ms** |
| rare identifier, 63k files of projects | 1.87 s | **18 ms** |
| `find **/AGENTS.md`, all of `~` (1.5M files) | 5.1 s | **22 ms** |
| rare identifier, all of `~` | over 60 s | **83 ms** |
| `find **/AGENTS.md`, the whole Mac | 25 s | **23 ms** |

- **The same answers as `rg`.** It walks with ripgrep's `ignore` crate and
  searches with its matcher and JSON printer. `searchd selftest` compares 1,296
  queries against the `rg` on your machine, and it serves nothing until they
  agree.
- **Never stale.** A repo-sized scope is checked against the disk folder by
  folder before each answer; `~` or `/` waits for macOS's change feed to
  deliver everything that happened before the question.
- **Only what you search.** System folders, apps, `~/Library`, toolchains,
  package caches, agent transcripts, and dependency or build folders outside
  git repos are never indexed (the whole disk's 3.6M entries became 190k). A
  search inside one goes to `rg`; a search of `~` or `/` says how many it left
  out. A repo is answered exactly or handed to `rg`, never approximated.
- **Content index**: which 3-byte chunks each text file in `~` holds. It only
  narrows the files read; every match comes from reading the file. 270 MB on
  disk here, 155k files, warmed in about three minutes in the background. A
  file is read for it only once it has been still for two minutes. Credential
  files (`.env`, keys, `auth.json`, `credentials/`) never enter it: they are
  read at query time instead.
- **Costs pi nothing.** No work at startup; a call is a one-line socket round
  trip (0.3 ms for a small listing), where starting `rg` costs 7 ms. A common
  pattern with a small match limit can be a wash — searchd reads some files in
  order first, as `rg` does.
- **Optional, and macOS-only.** One native binary the installer builds from
  [`searchd/`](pi-setup/searchd). Without Rust, or on another OS, `find` and
  `grep` run `rg` exactly as before. `PI_SEARCHD=0` turns it off.
- **Quiet on battery.** Idle it uses 0.03% CPU and a 23 MB footprint; a start
  walks the disk in about 3 s and the index warms behind it, at macOS's lowest
  priority. No Full Disk Access, and it answers only processes macOS attributes
  to the app it was started from, so it lends no other app that app's folder
  access.
- **Budgets it is held to**: under 0.2% CPU and 50 MB at idle, under 300 MB at
  peak, and an index kept under a 1 GiB cap that never takes the volume below a
  5 GiB free-space floor.
- **Removing it**: `~/.pi/agent/bin/searchd uninstall` stops the daemon and
  deletes its data dir and its binary.

## 01 · Six sub-agents

Each is a fresh pi process with a short prompt naming exactly the tools it has.
Pick by what you need back:

| Agent | Returns | Default model |
|---|---|---|
| `finder` | file paths and line ranges | DeepSeek Flash |
| `chad` | an answer with `path:line` evidence, verified vs inferred | DeepSeek Flash |
| `oracle` | one verdict, its trade-offs and effort | Sonnet 5.5 |
| `delegate` | finished work | Sonnet 5.5 |
| `librarian` | how code works across GitHub repos you have not cloned | DeepSeek Flash |
| `code_review` | a structured review of a diff described in plain words | Sonnet 5.5 |

- **They run in the background.** A call returns at once and the answer
  arrives as a message that wakes the main agent; agents that finish together
  arrive as one. Pass a `continueId` back to redirect a running agent or to
  follow up a finished one; `agents` lists, stops or waits for them, and
  `Ctrl+B` sends a blocking call to the background.
- **Say it, get it.** *"Three chads on deepseek flash, medium thinking, in
  parallel"* runs exactly that. Models live in one file,
  [`agent-models.json`](pi-setup/agent-models.json); a name not on it is refused,
  never swapped for the nearest one. Every result ends with the model and
  thinking level that actually ran.
- **chad cannot write.** No `edit` or `write`, and its bash runs under an
  allowlist that refuses redirection, `sed -i`, interpreters and every git
  command that mutates. Finding out is chad; doing is delegate.
- **No fork bombs.** Only delegate can start another agent (finder). A chad swarm cannot spawn a swarm.
- **A stalled child is killed, never left hanging**: 900 s without output.
- `@oracle`, `@chad`, `@finder`, `@codereview`, `@task` in a message force that agent.

## 02 · Edits you can take back

`edit` and `write` are pi's own tools with a thin layer on top.

- Every change is saved to disk first, so `undo_edit` and `redo_edit` work across
  restarts. They refuse when a later change or an outside edit touched the file.
- A failed match names the first differing line, column and character.
- [`permissions.json`](pi-setup/permissions.json): no `git add -A`, no force push,
  no shelling out to other agents. Local `rm` is refused and points at `trash`;
  over ssh, deletes run.
- A comment gate refuses a patch that is mostly commentary.

## 03 · Bash that cannot hang

- Every command declares a timeout, 1–600 s.
- No output **and** no CPU for 300 s: killed. A command busy at 100% CPU is left
  alone; a machine that slept is not counted as hung.
- A failed command is reported as failed, exit code and stderr intact.

## 04 · Web, GitHub, screen, history

- **`web_search`**, and **`read_web_page`**: fetch a page, or ask a question about
  it and get the answer from a child agent.
- **7 GitHub tools** read, search, glob, list and diff any repo `gh` can see,
  without cloning.
- **`screenshot`** captures a window, a screen region or a whole web page, sized
  to Claude's vision limits so small text stays readable. The harness refuses a
  request that would cross the API's 32 MiB limit, which pi does not check and
  which breaks every later turn.
- **`search_sessions`** and **`read_session`** pull context out of any past
  conversation.
- **`ask`** puts the agent's open questions to you in a picker.

## 05 · Codemode and 19 MCP servers

**codemode** runs one script that makes dozens of tool calls, and reaches the
MCP servers too: Chrome DevTools (isolated, telemetry off), Cloudflare, Paper,
Astro. 6 are on by default and connect only when a script names them; `/mcp`
turns on the other 13.

## 06 · Claude Max, billed to the plan

Claude Opus 5.5 on a Max subscription is the default. A request whose system
prompt carries certain phrases bills as extra usage instead, so
[`anthropic-sub.ts`](pi-setup/extensions/anthropic-sub.ts) keeps them out, and
every pi update runs a canary that proves requests still bill to the plan.

## 07 · A prompt that never changes mid-session

One hook that rewrote the message list every turn once wrote 83,658,669
cache tokens and burned 19% of a $200 plan's week in a day. The system prompt
and tool schemas are now frozen at session start, and the working rules (scope,
evidence, no comments by default, stop before anything that destroys or
publishes) ship inside it. [The whole investigation](pi-setup/2026-10-03-cache-playbook.md).

## 08 · Secrets stay out of the model

Every tool result is scrubbed before the model sees it: vault values, Stripe,
GitHub, AWS and Anthropic key formats, private keys, bearer tokens, URL
passwords, and random-looking values next to secret names. Code that merely
mentions a token stays readable.

## 09 · A TUI for all day

- A box-drawn editor with model, context and git branch on the border, and a
  cache line under it: hit rate, reads, writes.
- `/stats`: nine tabs over every session pi, Claude Code, Codex and OpenCode left
  on the machine: cost, tokens, cache, models, tools, sub-agents, projects
  matched to commits, your rhythm, and a wrapped card. Local and read-only.
- `/studio`: preview pi themes **and** your Ghostty theme, font, cursor and
  opacity live. Esc reverts, Enter keeps.
- A dock for the agents running in the background and a full-screen view of any one's conversation, a command palette, pinned sessions,
  auto-named sessions, desktop notifications, a DeepSeek peak-price clock.
- Hindi, Bengali and emoji cannot smear the screen: pi-tui is patched to never
  undercount a character's width.

| Command | Key | Does |
|---|---|---|
| `/stats` | `Ctrl+Shift+S` | usage dashboard |
| `/studio`, `/theme` | `Ctrl+Shift+K` | live theme and Ghostty preview |
| `/agents` | `Ctrl+Shift+A` | background agents: list, full-screen view of each, steer / stop / continue |
| `/palette` | `Ctrl+Shift+P` | command palette |
| `/ysk` | `Ctrl+Shift+Y` | a side agent that flags what you missed; off until `/ysk on` |
| `/idea` | | park an idea for this project (`pi:` in front files it under the harness); `/idea` alone lists them ([more](herdr/README.md#idea-park-a-thought-keep-working)) |
| `/goal` | | a long-running goal, audited before it is marked done |
| `/md` | | session to markdown |
| `/deepseek` | | DeepSeek peak and off-peak clock |
| `/local` | | run a local model through llama.cpp |
| `/psst` | | the secrets vault |
| `/resume` | `Ctrl+B` | pin a session to the top |

## 10 · Skills

14 skills load on demand: `review`, `dig` (debugging), `git`, `mat-tdd`,
`mat-design`, `c-sqr` (strict code review), `dm-antislop`, `design-port`,
`server-ops`, `tmux`, `chrome-cdp`, `paper-chrome`, `dataforseo`, `jev`.

## Every tool

| | |
|---|---|
| Files | `read` · `edit` · `write` · `undo_edit` · `redo_edit` · `grep` · `find` · `ls` · `format_file` |
| Shell | `bash` · `codemode` |
| Agents | `finder` · `chad` · `oracle` · `delegate` · `librarian` · `code_review` · `agents` |
| Web | `web_search` · `read_web_page` |
| GitHub | `read_github` · `search_github` · `list_directory_github` · `list_repositories` · `glob_github` · `commit_search` · `diff` |
| Screen | `screenshot` |
| Memory | `search_sessions` · `read_session` · `skill` |
| You | `ask` |
| Goals | `get_goal` · `create_goal` · `update_goal` |

## Stock pi vs muzzpi

| | stock pi 1.3 | muzzpi |
|---|---|---|
| Tools on by default | 4: `read`, `bash`, `edit`, `write` | 34 |
| Sub-agents | none, by design | 6, each on its own model |
| Edits | `edit` + `write` | the same tools, plus undo across restarts, permission rules, a comment gate |
| Bash | timeout optional | timeout required, hung commands killed |
| MCP | every server connects at start | each connects on first use |
| Web, GitHub, screen | none | built in |
| Secrets in tool output | sent as is | scrubbed |
| Search | `rg` per call | an index: milliseconds across `~` and the whole Mac |
| Start | 0.16 s with no extensions | 0.21 s with all 17 |

## How it stays working

pi moves fast. 17 releases, from 0.82 to 1.3, each have a written
[migration record](pi-setup/pi-migrations.md); muzzpi started on 0.67.

```bash
bash pi-setup/update-pi.sh <version>   # update pi; never `pi update --self`
bash pi-setup/verify-patches.sh        # audit: every patch, config and build in place
git pull && ./install.sh pi            # update muzzpi
```

- **`update-pi.sh`** backs pi up, refuses a release that changed a file we patch,
  installs, re-patches, rebuilds pi, then makes a real model call and runs the
  Claude-plan canary. Any failure prints the one-line rollback.
- **`install.sh`** compares your pi with the version the patches were made on.
  If pi changed those files, it stops before writing anything and prints the
  command that installs the right pi.
- **`verify-patches.sh`** checks every patch, every config, the extension
  bundles, the sub-agent models, and that pi runs a build of the current
  patched files. Each FAIL prints its fix; a WARN is a login still to do.
- **[`bundle-fidelity.mjs`](pi-setup/port-harness/bundle-fidelity.mjs)** re-proves
  the build recipe against pi's own on each release.

## Things that broke

- **The cache drain.** See 07: 99% of everything metered was cache writes.
- **A pi update killed every sub-agent.** pi 0.84 made bare model ids an error,
  and every spawn died on start. Fixed at the single spawn point; updates now
  call a real sub-agent before calling it clean.
- **Custom tools never reached Claude, for months.** The OAuth shim dropped every
  tool not named like Claude Code's, so Claude wrote tool calls as plain text
  and made up the results.
- **Hindi broke the screen.** pi-tui measured `क्त्र` as 1 column, Ghostty drew
  3, and the TUI desynced. Patched in every pi-tui copy.
- **3 GB of duplicates.** Three npm roots held 18 stale pi packages and 24
  copies of pi-tui. Now there is one, patched.
- **`pi update --self` silently disables every patch** by pointing `pi` at its
  prebuilt copy. Updates go through `update-pi.sh`.
- **Patching pi cost half its startup**, until we ran pi's own build recipe on
  the patched files (see Fast).

## The graveyard

23 packages were installed, used and removed. The audit fails if one comes back.

| Package | Why it went |
|---|---|
| `@tomooshi/condensed-milk-pi` | reported failed git commands as successes |
| `pi-autoresearch` | its prompt guidelines changed mid-session, rewriting the prompt cache |
| `pi-tool-display` | rewrote stored messages, then spliced the whole context on every request |
| `pi-tasks` | array parameters arrived as JSON strings; `task_plan` always failed |
| `pi-web-access` | every search provider key rejected or rate-limited |
| `@marckrenn/pi-sub-bar`, `pi-sub-core` | +324 ms per start for a widget with every provider off |
| `pi-token-burden` | +143 ms per start for one diagnostic command |
| `pi-mcp-adapter` | +33 ms per start and a 3.8k-character tool on every request; pi's own MCP client replaced it |
| `pi-claude-bridge`, `claude-agent-sdk-pi`, `pi-claude-code-use` | replaced by native Claude OAuth and one small extension |
| `pi-codex-goal` | vendored as `/goal`, trimmed |
| `pi-context`, `@sting8k/pi-vcc` | pi's own compaction covers it |
| `pi-computer-use` | its tools never registered |
| `lsp-pi`, `pi-powerline-footer`, `pi-anycopy` | installed where pi never loads them |
| `pi-gpt-config`, `pi-ask`, `pi-grok-cli`, `todos` | unused |

## Install

**Needs:** macOS, and unless you use `--with-deps`, node ≥ 22.19, bun, and pi
at the version in [`base-version`](pi-setup/pi-core-patches/base-version).
`--with-deps` installs exactly those with Homebrew, pi at that version, and
Rust for searchd. A newer pi works if it left the patched files alone; the
installer checks. Homebrew, nvm and any other npm prefix work.

Without `--with-deps`, the two commands it would run are
`npm install -g @earendil-works/pi-coding-agent@"$(cat pi-setup/pi-core-patches/base-version)"`
and `brew install oven-sh/bun/bun ripgrep gh trash`.

**Logins and keys**, one feature each; the installer and the audit say what is
missing:

| | turns on |
|---|---|
| `/login anthropic` in pi | Claude, the default model |
| `DEEPSEEK_API_KEY` | cheap sub-agents (chad, finder, librarian, read_session, read_web_page); without it they run on your main model |
| `RIVER_API_KEY` | DeepSeek V4.1 Flash via River, cheaper in DeepSeek's peak hours |
| `PARALLEL_API_KEY` | `web_search` |
| `gh auth login` | the GitHub tools |
| `ripgrep`, `trash` | `grep` and `find`, safe deletes |
| Rust (`cargo`) | searchd, the index behind `grep` and `find` (macOS only); without it they run `rg`. `--with-deps` installs it |

To use another default model, change `defaultProvider` and `defaultModel` in
[`settings.json`](pi-setup/settings.json).

**Ghostty.** The repo began as a Ghostty config and still ships one: 22 dark
themes, 11 fonts, live switchers. `./install.sh ghostty`; see
[`ghostty/`](ghostty/README.md). Each half installs on its own.

**herdr (optional).** If you run [herdr](https://herdr.dev) inside Ghostty,
`./install.sh herdr` makes Ghostty's ⌘ keys drive it (⌘T tabs, ⌘O open a
project, ⌘] next agent, ⌘W close, ⌘I park an idea). Nothing else installs
it, and Ghostty without it is untouched; every key and how to turn it off are
in [`herdr/`](herdr/README.md).

## Layout

```
muzzpi/
├── install.sh              ./install.sh pi | ghostty | herdr
├── AGENTS.md               the rules every agent reads first
├── pi-setup/
│   ├── extensions/         19 extensions; tools/ holds the 31 tools
│   ├── agents/             system prompt, working rules, sub-agent prompts
│   ├── agent-models.json   which model each sub-agent runs on
│   ├── permissions.json    what bash may never do
│   ├── pi-core-patches/    4 patched pi files + the pi-tui width patch
│   ├── pi-bundle/          pi's build recipe, run on the patched files
│   ├── searchd/            the search index daemon behind find and grep
│   ├── config-skills/      14 skills
│   ├── port-harness/       benchmarks and the Claude-plan canary
│   └── pi-migrations.md    one record per pi release
├── ghostty/                themes, fonts, switchers
└── herdr/                  optional: ⌘ keys for herdr, ⌘O picker, ⌘W close, ⌘I ideas
```

Read next: [`AGENTS.md`](AGENTS.md) for how it fits together and what not to
break, and [`pi-setup/README.md`](pi-setup/README.md) for the full inventory.

## Credits

- [pi](https://github.com/earendil-works/pi) by Mario Zechner, the engine all of
  this runs on.
- [Amp](https://ampcode.com): the system prompt started as a port of Amp's,
  which is why its files are named `*.amp.*`.
- [bdsqqq/dots](https://github.com/bdsqqq/dots): sub-agent wiring and `delegate`
  began as a port from there.
- `/goal` is [pi-codex-goal](https://github.com/fitchmultz/pi-codex-goal),
  vendored. MCP ran through [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter)
  until pi shipped its own client. Claude Max support began with Ben Vargas's
  [pi-claude-code-use](https://github.com/ben-vargas/pi-packages).
- Skills adapted from Matt Pocock (`mat-*`), dmmulroy (`dm-*`) and Cursor (`c-*`).
- Ghostty palettes inspired by [opencode](https://github.com/anomalyco/opencode).
- searchd stands on [ripgrep](https://github.com/BurntSushi/ripgrep)'s crates;
  its macOS change-feed code is adapted from [fsearch](https://github.com/noahdunnagan/fsearch).

## License

MIT.
