---
name: tmux
description: "run a process in a tmux window the user can watch or type into, or one that must outlive this session. a long build, test run or server whose result is all you need goes through bash instead: it moves to the background by itself. check the window before spawning."
---
# tmux

a tmux window is for a process the user wants to see or drive (a dev server
they watch, a REPL), or one that must keep running after this session ends.
anything else long runs through bash: after a minute it moves to the background
as a job, its result reaches you by itself, and the user sees it in the agents
dock. `background: true` starts a server that way at once.

## spawn

```bash
tmux new-window -n "name" -d "command"
```

## inspect

```bash
tmux capture-pane -p -t "name"         # visible screen
tmux capture-pane -p -S - -t "name"    # full scrollback
```

read a window when you need what it printed. do not `sleep` and read it again
to see whether it finished: a command whose end you wait for belongs in bash.

## control

```bash
tmux send-keys -t "name" C-c           # interrupt
tmux kill-window -t "name"             # terminate
tmux select-window -t "name"           # switch to
tmux list-windows                      # list all
```
