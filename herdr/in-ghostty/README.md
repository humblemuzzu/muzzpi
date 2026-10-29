# herdr in Ghostty: ⌘ keys for projects, agents and ideas

This is the **herdr terminal program running inside Ghostty**. For the Herdr Mac
app, see [`../app/`](../app/README.md) instead: the two are set up and
configured separately ([which is which](../README.md)).

Out of the box every herdr action sits behind `ctrl+b` and a letter. This
folder makes Ghostty's usual ⌘ keys drive herdr instead, and adds a project
picker, a safe close and an idea popup.

**It is optional.** Nothing here is installed by `./install.sh pi` or
`./install.sh ghostty`, and Ghostty without it behaves exactly as before. You
need herdr and Ghostty; without Ghostty you still get the herdr side (the
popups and bindings), reachable with `ctrl+b` and a letter.

## Install, update, turn off

```bash
./install.sh herdr-ghostty                # install, or update after a git pull
./install.sh herdr-ghostty --no-ghostty   # herdr side only, Ghostty untouched
./install.sh herdr-ghostty --uninstall    # take it all back out
```

Then reload Ghostty with `⌘⇧,`. `fzf` and `jq` are needed for `⌘O`
(`brew install fzf jq`); `⌘I` needs pi's ideas extension (`./install.sh pi`).

## Where its settings live

| What | File |
|---|---|
| herdr's own settings (theme, sounds, bindings) | `~/.config/herdr/config.toml` |
| the ⌘ keys | `herdr-keys` next to your Ghostty config |
| look of the terminal text (font, colours, padding) | your Ghostty config |
| pi's state in herdr's sidebar | `~/.pi/agent/extensions/herdr-agent-state.ts`, installed by herdr itself |

Changing any of these does nothing to the Mac app.

## The keys

| Key | Does |
|---|---|
| `⌘T` | new tab in this project |
| `⌘1` … `⌘9` | go to tab 1–9 |
| `⌘⇧[` / `⌘⇧]` | previous / next tab |
| `⌘W` | close the pane you are in (see below) |
| `⌘D` / `⌘⇧D` | split right / down |
| `⌘⌥` + arrows | move between split panes |
| `⌘⇧↩` | zoom the pane, and back |
| `⌘O` | open a project, or jump to it if it is open |
| `⌘⌃1` … `⌘⌃9` | go to project 1–9 in the sidebar |
| `⌘]` / `⌘[` | next / previous agent in the sidebar |
| `⌘J` | the agent that just finished or needs you |
| `⌘P` | search every agent and terminal by name |
| `⌘I` | park an idea (see [`/idea`](../README.md#idea-park-a-thought-keep-working)) |
| `⌘B` | hide / show the sidebar |
| `⌘/` | every herdr key |
| `⌘⌥T` | a plain Ghostty tab, outside herdr |
| `⌘⇧W` | close the Ghostty window: herdr keeps running, `herdr` brings it all back |

The mouse still works for everything: click a project, an agent or a tab.

### `⌘O`: open a project

A popup lists the folders inside `~/Documents/Code stuff`, `~/StudioProjects`,
`~/Projects` and `~/code`. Open projects come first, marked `●` with what
their agent is doing; the rest are sorted by when you last ran pi there.
Type a few letters and:

- `enter`: jump to the project, or open it and start pi there
- `ctrl-s`: open it with a plain shell, no pi
- `esc`: cancel

Set `MUZZPI_PROJECT_ROOTS=dir1:dir2` in `~/.zshrc` to list other folders.

### `⌘W`: close what you are in

- a plain shell closes straight away
- a pane running pi (or any agent) asks first: *Close pi (working)? It stops.*
- the last terminal of a project asks first, because the project closes with it

When it asks, `enter` closes and any other key keeps it.

## How it works

herdr listens for `ctrl+b` and then a letter. Ghostty's `⌘` keys are set to
type exactly that for you:

```
⌘T  →  Ghostty types ctrl+b c  →  herdr opens a tab
```

| File | Holds | Installed as |
|---|---|---|
| `ghostty-keys` | the ⌘ keys and the bytes each one types | `herdr-keys` next to your Ghostty config, loaded by one line: `config-file = ?herdr-keys` |
| `herdr-keys.toml` | the herdr bindings those bytes need, and the three popups | merged into `~/.config/herdr/config.toml`, every added line marked `# muzzpi` |
| `bin/herdr-open` | the `⌘O` picker | `~/.local/bin/` |
| `bin/herdr-close` | the `⌘W` close | `~/.local/bin/` |
| `bin/herdr-idea` | the `⌘I` popup | `~/.local/bin/` |

The installer leaves the rest of your herdr config alone. Both configs are
checked by herdr and Ghostty themselves before they are swapped in, and the old
ones are kept as `*.backup-<date>`. If your herdr config already uses one of
these keys, or its prefix is not `ctrl+b`, the installer says which line and
changes nothing.

To change a key, change it in both `ghostty-keys` and `herdr-keys.toml`, then
run `./install.sh herdr-ghostty` again.

## When something is off

- **A ⌘ key does nothing:** reload Ghostty (`⌘⇧,`). Still nothing:
  `./install.sh herdr-ghostty` again, it reports what is missing.
- **A ⌘ key types `^B` and a letter:** that tab is not running herdr.
- **`⌘O` says it needs fzf or jq:** `brew install fzf jq`.
- **`⌘I` says the ideas extension is missing:** `./install.sh pi`.
- **The installer reports a clash:** it names the line in your herdr config;
  change it there, or pick other keys in both files here.
