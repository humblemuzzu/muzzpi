# The Herdr Mac app: ⌘ keys, a look, and pi's state

This is the **Herdr Mac app** (`herdr-app`, with `hc` running its terminals).
Ghostty is not involved: the app draws its own window and has real ⌘ keys. For
herdr inside Ghostty, see [`../in-ghostty/`](../in-ghostty/README.md) instead:
the two are set up and configured separately ([which is which](../README.md)).

**It is optional.** Nothing else installs it. Open the app once first, so it
creates `~/.config/herdr-app/`.

## Install, update, turn off

```bash
./install.sh herdr-app              # install, or update after a git pull
./install.sh herdr-app --uninstall  # take it back out
```

Run it with the app open: it is live at once, with no restart.

## Where its settings live

Everything is in `~/.config/herdr-app/`, and the window follows a change within
a second:

| What | File |
|---|---|
| zoom, theme, font, sounds | `settings.json` (also Herdr → Settings, `⌘,`) |
| every key | `keys.json` |
| colours | `themes/cursor-soft.json` |
| popups and panels | `mods/<name>/` |
| pi's state in the agents list | `~/.pi/agent/extensions/herdr-app-status.ts` |

Changing any of these does nothing to herdr in Ghostty, and the Ghostty config
does nothing here.

## What the installer adds

The app already has `⌘T`, `⌘1`–`⌘9`, `⌘⇧[` `⌘⇧]`, `⌘D` / `⌘⇧D`, `⌘⌥` + arrows,
`⌘⇧↩`, `⌘]` `⌘[`, `⌘P`, `⌘B`, `⌘/` and `⌘⇧P` (every command). The installer adds:

| Key | Does | From |
|---|---|---|
| `⌘O` | open a project, or jump to it (`ctrl-s`: shell only) | `mods/muzz-open` |
| `⌘W` | close the pane; asks first for an agent or a space's last terminal | `mods/muzz-close` |
| `⌘I` | park an idea (see [`/idea`](../README.md#idea-park-a-thought-keep-working)) | `mods/muzz-idea` |
| `⌘J` | the agent that needs you, else the one that just finished | `mods/muzz-attention` |
| `⌘⌃1` … `⌘⌃9` | go to space 1–9 (the app's own `ctrl-1` … `ctrl-9` stay) | `keys.json` |
| `⌘⇧W` | close the window; every terminal keeps running | `keys.json` |

And a look: the `cursor-soft` theme (Ghostty's colours with herdr's gruvbox
orange), Fira Code 14, a grey border on the pane you are typing in, and herdr's
`needs-you.mp3` as the "needs you" sound when you have it.

## pi in the app

- **pi's state comes from `herdr-app-status.ts`.** The app learns an agent's
  state only from the program itself (OSC 7501), and pi 1.4 does not send it
  yet; without the file every pi shows as a plain terminal. It does nothing
  outside the app, so it is safe to keep with herdr in Ghostty.
- **Start pi through your shell** (`zsh -lic pi`), as `⌘O` does. The app's
  terminals skip `~/.zshrc`, so a bare `pi` has no `DEEPSEEK_API_KEY`. A tab
  from `⌘T` is already a shell, so typing `pi` there is fine.
- **One copy per session.** Never have the same pi session open here and in
  Ghostty at once: both write to it and it splits into branches.

## When something is off

- **A key does nothing:** `cat ~/.config/herdr-app/keys.error`, then
  `./install.sh herdr-app` again.
- **You pressed `ctrl+alt+shift+esc`:** that resets the layout and every key;
  `./install.sh herdr-app` brings these back.
- **pi shows as a plain terminal:** it started before the status file was
  installed; quit it and start it again.
