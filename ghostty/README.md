# muzzpi · ghostty

The Ghostty half of [muzzpi](../README.md): 22 dark themes, 11 developer fonts,
6 cursor styles, frosted glass, and switchers that change the terminal live as
you scroll. Enter keeps, Esc reverts.

Theme palettes inspired by [opencode](https://github.com/anomalyco/opencode)'s
theme system.

## Install

Needs macOS, [Ghostty](https://ghostty.org) and [Homebrew](https://brew.sh).

```bash
./install.sh ghostty        # from the repo root
source ~/.zshrc
```

The installer:

1. checks Ghostty is installed
2. installs `fzf`, which powers the switchers
3. installs the fonts with Homebrew
4. backs up your Ghostty config and installs this one
5. copies the themes to `~/.config/ghostty/themes/`
6. installs `gtheme`, `gfont`, `gcursor` and `ghostty-config` to `~/.local/bin`
7. adds that directory to your `PATH` and the `gg` / `gt` / `gf` / `gc` aliases

### Accessibility permission (needed for live preview)

Live preview sends Ghostty its reload shortcut (`⌘+Shift+,`), which macOS only
allows with Accessibility access. In **System Settings → Privacy & Security →
Accessibility**, add and enable Ghostty and whichever terminal ran the
installer. Without it the switchers still save your choice; press `⌘+Shift+,`
yourself.

## Commands

| | |
|---|---|
| `gg` | config hub: theme, font, cursor, opacity |
| `gt` | theme switcher, live preview |
| `gf` | font switcher, live preview |
| `gc` | cursor switcher, live preview |

## Themes

All dark, each with a full 16-colour ANSI palette, cursor and selection colours.

| Theme | Feel | Background |
|---|---|---|
| ember-soft | lifted charcoal, warm orange cursor | `#222226` |
| ember-dark | the same, one step darker | `#18181a` |
| cursor-soft | Cursor Dark without the hard black and white | `#1e1e1e` |
| melange-dark | warm brown paper, cream text | `#292522` |
| afterglow | flat charcoal, muted | `#212121` |
| miasma | earth khaki, no neon | `#222222` |
| n0tch2k | low contrast, easy on the eyes | `#222222` |
| kanso-mist | muted ink | `#22262d` |
| github-dark-dimmed | dimmed GitHub grey | `#22272e` |
| ayu-mirage | twilight slate | `#1f2430` |
| gruvbox-medium | warm brown-orange, lifted | `#282828` |
| one-half-dark | classic Atom grey | `#282c34` |
| kanagawa | Japanese ink, muted earth | `#1f1f28` |
| midnight-code | deep blue-black, pastel accents | `#1a1b26` |
| catppuccin-macchiato | warm purple-blue, soft pastels | `#24273a` |
| dracula-pro | classic purple, bright accents | `#282a36` |
| vesper | true black, amber and mint | `#101010` |
| rosepine | dark plum, pinks and golds | `#191724` |
| gruvbox-dark | warm brown-orange, hard | `#1d2021` |
| nord-frost | arctic blue-grey | `#2e3440` |
| opencode | near-black, orange accent | `#0a0a0a` |
| synthwave | 80s neon purple | `#1b1720` |

To switch by hand, set `theme = kanagawa` in
`~/Library/Application Support/com.mitchellh.ghostty/config` and press
`⌘+Shift+,`.

**Ghostty reads custom themes from `~/.config/ghostty/themes/`**, not from the
Application Support folder next to the config.

### Adding your own

Create a file in `~/.config/ghostty/themes/` (no extension) with `background`,
`foreground`, `cursor-color`, `cursor-text`, `selection-background`,
`selection-foreground` and `palette = 0=#…` through `palette = 15=#…`. It shows up
in `gt` automatically.

## Fonts

Fira Code (default), JetBrains Mono, Geist Mono, Cascadia Code, Monaspace Neon,
Argon and Radon, Victor Mono, Maple Mono, Commit Mono and Iosevka. All 14pt
except Victor Mono at 15pt.

## Cursor, opacity, blur

Cursor: bar, block or underline, each blinking or steady.

The config ships solid: `background-opacity = 1.0` and `background-blur = 0`.
`gg` → Opacity offers presets from solid (`1.0`) to very transparent (`0.75`), or
any custom value.

## Files

| In the repo | Installed to |
|---|---|
| `config` | `~/Library/Application Support/com.mitchellh.ghostty/config` |
| `themes/*` | `~/.config/ghostty/themes/` |
| `scripts/*` | `~/.local/bin/` |

The config's last line, `config-file = ?herdr-keys`, does nothing unless you
also install the optional [herdr add-on](../herdr/README.md); it never changes
Ghostty's own keys on its own.

## Troubleshooting

- **"theme not found" on launch:** the theme files are not in
  `~/.config/ghostty/themes/`. Re-run the installer, or
  `cp ghostty/themes/* ~/.config/ghostty/themes/`.
- **Live preview does not reload:** grant Accessibility access (above).
- **`declare -A: invalid option`:** an old copy of the scripts. Every script here
  runs on macOS's bash 3.2; re-run the installer.
- **`gtheme: command not found`:** `~/.local/bin` is not on your `PATH`. Re-run
  the installer, then `source ~/.zshrc`.
- **Fonts missing:** quit Ghostty fully (`⌘+Q`) and reopen it.

## Uninstall

```bash
trash ~/.local/bin/gtheme ~/.local/bin/gfont ~/.local/bin/gcursor ~/.local/bin/ghostty-config
trash ~/.config/ghostty/themes
ls ~/Library/Application\ Support/com.mitchellh.ghostty/config.backup.*   # copy the one you want back
```

Then delete the `~/.local/bin` `PATH` line and the `Ghostty switchers` alias
block from `~/.zshrc`.

## Credits

[Ghostty](https://ghostty.org) by Mitchell Hashimoto. Fonts by JetBrains, GitHub
(Monaspace), Vercel (Geist), Microsoft (Cascadia) and their other authors.
Switchers built on [fzf](https://github.com/junegunn/fzf).
