# 2026-10-13 — server deletes, approval dialog, secret redaction, edit hints

Source: the 2026-10-12 profilephoto/crawlapi server session (`01a120c9`), its
closing "what went wrong" report, and the session file itself.

## What was wrong

| Problem | Evidence |
|---|---|
| The delete rule read command text only, so `ssh host 'rm -rf …'` was refused and the advice (`trash`) does not exist on Linux | `shred -u` over ssh refused (entry 627); the 2026-10-02 session `mv`'d 116 MB into `/root/.profilephoto-retired-20261002` instead, and nobody wrote it down |
| Bigger losses went through: `docker builder prune -af` before any approval, a root crontab rewrite, an R2 bucket delete through the Cloudflare MCP | entries 643, 649, 703 |
| Only psst vault values, auth.json and `*KEY/TOKEN/SECRET/PASSWORD` env vars were scrubbed; a playbook and `crontab -l` printed live secrets | crawlapi playbook: Postgres password, API/admin tokens, Dodo key, Netcup panel password |
| Edit misses: Opus typed `""` for `…`/`—`, and sent `\u2014` as six characters (4 failed edits on one line, 1 literal `\u2014` written into `prod-bro.md`); 15 of 1,910 edit/write calls since 2026-10-11 carried literal escapes | session file entries 282, 454, 538, 589–596, 692 |
| The closest-match hint compared only the first line of oldText, so a miss on line 2 printed two identical strings | `you sent: "Interfaces,"` / `file has: "Interfaces,"` |
| codemode `tools.read` returned `N: ` prefixed lines; pi's own read returns the text | our `read.ts` had no `outputSchema` |

## What changed

- **`lib/remote-command.ts`** splits a command into what runs here and what runs
  on each ssh host (args, heredocs fed to ssh, `cat <<EOF | ssh host bash`,
  `rsync --delete` into a remote destination). `ssh localhost`/`127.x`/this
  machine's name, `-o ProxyCommand`/`LocalCommand`, and `$(…)` / backticks /
  `<(…)` / `>(…)` stay local because they run here. A 20-case test runs each
  command in real `/bin/bash` with `ssh` stubbed and checks the split agrees.
  Three bypasses were found that way and fixed: `$'it\'s'`, a quote inside a
  `#` comment, `>(…)`.
- **`permissions.json`**: the delete rule, `git add -A`, `amp` and
  `screencapture` carry `"where": "local"`. Five `ask` rules (destructive SQL,
  whole-database wipes, Docker volumes and database data dirs, cloud storage,
  disks) apply here and on servers.
- **`lib/approval.ts`**: `ctx.ui.confirm` with the reasons, hosts and the exact
  command; no UI → refused with the command handed back; every decision appended
  to `~/.pi/agent/approvals.jsonl`. Reject beats ask beats allow
  (`evaluateCommand`). Same shape as opencode's evaluation, minus "always allow":
  approval is per command.
- **`lib/destructive-mcp.ts`** + a `tool_call` hook: an `mcp` call whose args
  send an HTTP `DELETE`, run destructive SQL, or name a delete of a data store
  (`r2_bucket_delete`) asks first. `paper_delete_nodes` does not.
- **`psst.ts` `redactSecretPatterns`** runs on every tool result: key formats,
  PEM keys, JWTs, `Bearer`, URL passwords (not localhost), and values next to
  secret-sounding names that look random (a digit or symbol and at least 5
  lowercase/uppercase/digit/symbol switches, ignoring `_ - .`).
- **edit/write**: the hint lines up the whole oldText and names the first
  differing line, column and code points; `\uXXXX` text is decoded when only the
  decoded oldText matches; a prose file without escapes refuses one in newText or
  content; `[REDACTED]` is never written over a real value (scripts receive
  redacted text, so a codemode read→write would otherwise overwrite secrets);
  a miss says when the file changed after it was last read (`lib/seen-files.ts`).
- **`read`** declares `outputSchema: Type.String()` and returns the raw lines,
  final newline included, as `structuredContent`.
- Prompt: the bash line says deletes are blocked on this Mac and work over ssh;
  DANGER says not to ask in chat for something the user already asked for, since
  the dialog asks. New skill `server-ops`.

## Measured

| | before | after |
|---|---|---|
| `"token_" × 200k` through the redactor | 284,644 ms | 7 ms |
| `ssh h '<50k × rm>'` through the rules | 4,180 ms | 22 ms |
| lines redacted, this repo / profilephoto src / ownaeo-gsc / tube2text | — | 10 / 10 / 0 / 1 (all test fixtures except tube2text's prod `DATABASE_URL`) |
| crawlapi playbook lines redacted | 0 | 11, every table secret and the Dodo key |

End to end in `pi --mode rpc` on Haiku, answering the dialog from a script: a
local `rm` is refused with no dialog; `ssh … 'rm -rf …'` runs; a Docker volume
delete shows the dialog and runs only on Allow; the same from inside a codemode
script; an MCP bucket delete is blocked on Deny; `pi -p` refuses and hands the
command back; 0 of 6 planted secrets reached the model; the 2026-10-12 `""`
line now gets "line 4, column 21: you sent `"` (U+0022), the file has `…`".

## Found by the independent review, and fixed

| Hole | Fix |
|---|---|
| `out="$(ssh h cat f)"; rm -rf x`: the `)` of `$(` was never matched, a phantom quote swallowed the local `rm` | a paren stack restores the outer quote at the matching `)` |
| `<<EOF` inside quotes, after `#`, or `<<<` read as a heredoc (also in the older `withoutDataHeredocs`) | `heredocTags` reads `<<` the way bash does, skipping `$(( ))` shifts too |
| `ssh localhost.`, `ssh 0`, `127.1`, `2130706433`, `a@b@localhost`, `$HOSTNAME`, `-o HostName=127.0.0.1`, `-F`, `-I`, an ssh-config alias | inet_aton parsing, last-`@` split, fail closed on anything ssh or the shell could rewrite, `~/.ssh/config` HostName lookup |
| `-o ' ProxyCommand=…'` with a leading space | leading whitespace allowed, more local-exec options |
| rsync: options after the destination, `--remove-sent-files`, `-e 'rm …'` | operands parsed past value options; any `-e` other than plain ssh stays local |
| the delete regex's nested `( wrapper args )*` took 1.6 s on 22 `K=v` pairs and then answered **allow** (pre-existing bypass) | one optional wrapper group; same coverage, under 1 ms |
| an `ask` listed before a `reject` hid it | an ask keeps looking for a later reject |
| `[REDACTED]` guard blocked docs and new files | only refuses when the file really holds something the scrubber hides |
| redaction hit `SecretKeyV2Provider`, ARNs, `token_endpoint`, cache keys; missed `redis://:pw@`, `Basic`, passphrases, Slack webhooks | word-shaped values and id/endpoint/expiry/public/cache names skipped; the misses added |
| approvals.jsonl stored commands raw | scrubbed, file mode 600 |

The real-bash oracle now runs 56 commands, 36 of them generated (six ways to
write the ssh part, joined to a local command by every separator).

## Accepted holes

- `sudo ssh …`, `mosh` and `ssh` reached through `bash -c` stay local (stricter, not looser).
- An ssh-config `Include` or `Match` block is not followed; a plain `Host` alias is.
- A password with no digit or symbol, or a random-looking test fixture next to a
  secret name, is redacted or missed by shape alone; there is no way to tell.
- The ask rules read text, like everything here: a guardrail, not a sandbox.

## Rollback

Revert the commit and re-run `install.sh`; `approvals.jsonl` can stay.
