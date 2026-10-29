# herdr: two separate setups

[herdr](https://herdr.dev) runs your terminals and coding agents in one window:
projects on the left, agents and their state below, tabs and splits on the
right. It comes in two forms, and muzzpi sets up each one on its own:

| | herdr in Ghostty | Herdr Mac app |
|---|---|---|
| what it is | the `herdr` terminal program, inside Ghostty | its own Mac app (`herdr-app`, with `hc`) |
| install | `./install.sh herdr-ghostty` | `./install.sh herdr-app` |
| read | [`in-ghostty/`](in-ghostty/README.md) | [`app/`](app/README.md) |
| its settings | `~/.config/herdr/config.toml` + your Ghostty config | `~/.config/herdr-app/` |
| how ⌘ keys work | Ghostty types herdr's `ctrl+b` + a letter | real ⌘ keys in the app |
| pi's state comes from | `herdr-agent-state.ts` (herdr installs it) | `herdr-app-status.ts` (`./install.sh herdr-app`) |

**They share no settings.** A theme, key or sound changed in one never changes
the other. Install one, the other, or both; each only acts where it runs.

**Running both:** each has its own terminals, so a pi started in one is not in
the other. Never open the same pi session in both at once: both write to it
and it splits into branches. Quit it in one before resuming it in the other.

Both are optional: `./install.sh pi` and `./install.sh ghostty` never touch
herdr. (`./install.sh herdr` still works as the old name of `herdr-ghostty`.)

## `/idea`: park a thought, keep working

A pi feature that both setups put on `⌘I`. An idea that shows up while an
agent works costs you the task you are on if you chase it. Write it down in two
seconds instead and come back to it later.

```
/idea try webp thumbnails          saved for the project you are in
/idea pi: dock should show time    saved for the harness (pi, muzzpi), from any project
/idea bug: crop is off by 2px      a bug
/idea dislike: too many popups     something you don't like
/idea pi: bug: dock flickers       labels combine
/idea                              open the list
```

- **Labels** go at the start: `pi:` (or `harness:`) files it under the
  harness; `bug:` (or `fix:`) and `dislike:` (or `hate:`, `meh:`) set the kind.
  Inside the muzzpi repo every idea is a harness idea, no `pi:` needed.
- **It never interrupts**: it works while an agent runs, never reaches the
  model and costs nothing.
- **`⌘I`** opens the same box as a popup from any pane, even a plain shell.
- **The list** (`/idea` alone): `enter` puts the idea in your prompt, `d`
  done, `x` drop, `m` move between project and harness, `u` undo, `a` every
  project, `esc` close.
- **The prompt bar** shows how many ideas are open for the project you are in.

Each idea keeps its date and time, the branch and commit, the pi session, and
the prompt the agent was running, so later you know where it came from. They
live in `~/.pi/agent/ideas/`: one `.jsonl` per project, plus readable `.md`
copies. `harness.md` gathers every harness idea in one list.
