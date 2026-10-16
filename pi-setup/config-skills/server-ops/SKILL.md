---
name: server-ops
description: "rules for work on a server over ssh: deploys, cleanups, Docker, databases, cron, backups. load before running anything on a remote host. covers quoting, SQL over ssh, what may be created or deleted, secrets, and keeping the project's server playbook true."
---
# server-ops

## Before you touch anything

- Read the project's server playbook first (`docs/prod-bro.md`, `Docs/runbooks/*`, or what AGENTS.md names).
- **The playbook can be stale.** Check every claim you are about to act on against the server itself (`docker ps`, `ls`, `crontab -l`) before you plan around it. A database the playbook calls "still running" may have been gone for days.

## Running commands remotely

- **One script, no nested quotes.** For more than a one-liner, send a script on stdin:

  ```bash
  ssh host bash -s <<'EOF'
  set -euo pipefail
  cd /opt/app
  docker compose ps
  EOF
  ```

  The quoted `'EOF'` keeps your shell from expanding anything; the server runs it exactly as written.
- **SQL goes on stdin, never through `-c` inside three layers of quotes:**

  ```bash
  ssh host "docker exec -i app-db psql -U app -d app -v ON_ERROR_STOP=1" <<'SQL'
  SELECT count(*) FROM request_log;
  SQL
  ```

- Deleting files on a server works normally (`rm`, `find -delete`, `rsync --delete`). Deleting files on the Mac does not; use `trash`.
- Commands that destroy data (DROP / TRUNCATE / DELETE without WHERE, `docker volume rm`, `compose down -v`, bucket deletes, `mkfs`) run without any dialog. If the user did not ask for it, ask in chat first; if they did, run it.

## What you may create

Never create anything that costs money, runs on a schedule, or grants access unless the user asked for it in this conversation: buckets, databases, cron entries, systemd timers, DNS records, API tokens, firewall openings. "Do all of it" means the things already discussed, not new infrastructure. Propose it in one line instead.

## Secrets

- Use secrets by reference (`$NAME` from psst, or an env file on the server); never print them.
- Tool output is redacted, but mask what you print anyway: `crontab -l | sed -E 's/(Bearer )[^ "]+/\1***/'`.
- Never write a secret into a playbook. Store it in psst and write its name.

## Before you finish

- **Update the playbook in the same turn**: what changed, where backups are, which images or files a rollback needs.
- Anything you could not remove goes under a **Pending cleanup** heading with exact paths, sizes (`du -sh`) and why it is still there. Leftovers nobody wrote down are how playbooks go stale.
- Before deleting a folder, say in your reply what it held and how big it was.
