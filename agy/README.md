# muzzpi · agy

A setup for Google's [Antigravity CLI](https://antigravity.google/product/antigravity-cli)
(`agy`): it stops asking permission for everything, shows your quota and
context under the prompt, and turns off every piece of telemetry that has a
switch.

```
  Neon High · accept-edits                          ctx 12% of 1M · 5h 90% · week 86% · main
```

## Install

Needs macOS or Linux, `python3`, and `agy` (signed in once).

```bash
git clone https://github.com/humblemuzzu/muzzpi.git
bash muzzpi/agy/install.sh
```

From inside this repo, `./install.sh agy` does the same.

Then, by hand:

1. **Open a new terminal tab**, so the telemetry lines load.
2. **Check it:** `agy -p "/config"` should list `toolPermission always-proceed`,
   `altScreenMode always` and the rest.
3. **Account telemetry:** open `agy`, type `/config`, type `telemetry`. If
   **Enable Telemetry** says `on`, press `←`. This one is saved to your Google
   account, not a file, so the script cannot change it.
4. **If the script printed a NOTE about ask rules:** open `/permissions` and
   delete them from the **Ask** tab. An ask rule beats every allow rule.

The script merges into your existing settings (your model, theme and trusted
folders stay), backs the old file up as `settings.json.bak-<date>`, and is
safe to run again.

## What it changes

| Setting | Value | What you get |
|---|---|---|
| `toolPermission` | `always-proceed` | No permission prompts for commands, web pages or MCP tools |
| `agentMode` | `accept-edits` | File edits apply without a diff prompt |
| `artifactReviewPolicy` | `always-proceed` | It does not stop to wait for plan approval |
| `allowNonWorkspaceAccess` | `true` | It can work on files outside the folder you started in |
| allow rules | `command(*)`, `read_file(*)`, `write_file(<home>)`, `read_url(*)`, `execute_url(*)`, `mcp(*)` | A backup for the setting above, in case one path skips it |
| deny rules | `rm -rf /`, `rm -rf ~`, `git push --force`, `git push -f`, writes to `~/.ssh` | Always blocked, no matter what |
| `notifications` | `true` | A desktop notification when it finishes or needs you |
| `altScreenMode` | `always` | Full-screen mode: mouse scroll, click to expand, prompt pinned at the bottom |
| `queuedMessages` | `send-immediately` | What you type while it works goes in right away (`Alt+M` queues one instead) |
| `showTips`, `showFeedbackSurvey` | `false` | No tips, no surveys |
| `statusLine` | `statusline.py` | Model, mode, context used, 5-hour and weekly quota, git branch |

All of these live in `~/.gemini/antigravity-cli/settings.json`.

## The status line

One line under the prompt. Plain text; colour only when something needs you:

- **Left:** model and mode, then `waiting for you` (yellow) when it needs an
  approval, `error` (red), and how many agents, tasks and queued messages are
  running.
- **Right:** context used out of the window, Gemini quota for the 5-hour and
  weekly windows, Claude quota once you have used some, cost when `agy` reports
  it, and the git branch.
- Context turns yellow at 70% and red at 85%. Quota turns yellow under 20% and
  red under 5%, and then shows how long until it resets.
- On a narrow pane it drops the least useful parts first.

## Telemetry

| What | How it is turned off |
|---|---|
| Usage data (**Enable Telemetry**) | By hand in `/config`, step 3 above |
| Crash reports | `ANTIGRAVITY_SENTRY_SAMPLE_RATE=0` in `~/.zshrc` (or `~/.bashrc`) |
| Chrome DevTools usage stats for `/browser` | `CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS=1` in the same file |
| Feedback surveys | `showFeedbackSurvey: false` |
| Antigravity IDE crash reporter | `enable-crash-reporter: false` in `~/.antigravity/argv.json`, if you have the IDE |

What no switch turns off:

- `agy` sends logs straight to `play.googleapis.com/log`, and users report it
  keeps uploading there even with Enable Telemetry off. Blocking that host on
  your computer stops it; `agy` keeps working and just retries the upload
  quietly in the background. Google's own Antigravity guide for locked-down
  networks lists this host as optional and safe to block. It needs your
  password. Paste this as one line; it blocks both IPv4 and IPv6 and is safe
  to run twice:
  ```bash
  grep -q '0.0.0.0 play.googleapis.com' /etc/hosts || echo "0.0.0.0 play.googleapis.com" | sudo tee -a /etc/hosts; grep -q ':: play.googleapis.com' /etc/hosts || echo ":: play.googleapis.com" | sudo tee -a /etc/hosts; sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder
  ```
  Restart any `agy` session that was already open: a connection opened
  before the block can stay open. Undo:
  ```bash
  sudo sed -i '' '/play.googleapis.com/d' /etc/hosts; sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder
  ```
  Do this on your computer only, never on a router, Pi-hole or network DNS:
  phones on that network would stop downloading from the Google Play Store.
  The old Gemini CLI hangs when this host is blocked; `agy` does not.
- Logs that go through the same Google server `agy` uses for the AI itself.
  Blocking that server breaks `agy`.

## Optional: rules and `/handoff`

```bash
bash muzzpi/agy/install.sh --with-rules
```

Also installs:

- `rules/GEMINI.md` → `~/.gemini/GEMINI.md`: working rules every session
  follows (no comment spam, finish what was asked, stop before anything
  destructive, show proof before saying done, stage files by name, never push
  unasked, simple English). Your old file is backed up first.
- `skills/handoff/` → `~/.gemini/config/skills/handoff/`: type `/handoff` and it
  writes the agreed plan to `PLAN.md` at the repo root, complete enough for
  another session to carry out, and copies it to the clipboard.

## Before you run it

- **This is full auto.** Nothing asks before it runs a command or edits a
  file; only the deny list is blocked.
- **Work or school Google accounts** can have admin rules that override some of
  these settings.
- **Undo:** copy `settings.json.bak-<date>` back over `settings.json`, and
  delete the two lines from `~/.zshrc`.
