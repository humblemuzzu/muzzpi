import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { evaluateCommand, evaluatePermission, type PermissionRule } from "./permissions";

const RULES: PermissionRule[] = [
	{
		tool: "Bash",
		matches: { cmd: ["*git add -A*", "*git add .*"] },
		action: "reject",
		message: "stage files explicitly with 'git add <file>' — unstaged changes may not be yours",
	},
	{
		tool: "Bash",
		matches: { cmd: ["*git push --force*", "*git push -f*", "*--force-with-lease*"] },
		action: "reject",
		message: "never force push. if diverged: 'git fetch origin && git rebase origin/main && git push'",
	},
	{
		tool: "Bash",
		matches: { cmd: ["rm *", "* && rm *", "* || rm *", "* ; rm *"] },
		action: "reject",
		message: "use 'trash <file>' instead of rm — recoverable deletion",
	},
	{ tool: "*", action: "allow" },
];

describe("evaluatePermission", () => {
	it("allows normal commands", () => {
		expect(evaluatePermission("Bash", { cmd: "git status" }, RULES)).toEqual({ action: "allow" });
		expect(evaluatePermission("Bash", { cmd: "ls -la" }, RULES)).toEqual({ action: "allow" });
		expect(evaluatePermission("Bash", { cmd: "nix build .#foo" }, RULES)).toEqual({ action: "allow" });
	});

	it("rejects git add -A", () => {
		const v = evaluatePermission("Bash", { cmd: "git add -A" }, RULES);
		expect(v.action).toBe("reject");
		expect(v.message).toContain("stage files explicitly");
	});

	it("rejects git add .", () => {
		const v = evaluatePermission("Bash", { cmd: "git add ." }, RULES);
		expect(v.action).toBe("reject");
	});

	it("allows explicit git add", () => {
		const v = evaluatePermission("Bash", { cmd: "git add src/foo.ts" }, RULES);
		expect(v.action).toBe("allow");
	});

	it("rejects force push variants", () => {
		expect(evaluatePermission("Bash", { cmd: "git push --force" }, RULES).action).toBe("reject");
		expect(evaluatePermission("Bash", { cmd: "git push -f origin main" }, RULES).action).toBe("reject");
		expect(evaluatePermission("Bash", { cmd: "git push --force-with-lease" }, RULES).action).toBe("reject");
	});

	it("allows normal git push", () => {
		expect(evaluatePermission("Bash", { cmd: "git push" }, RULES).action).toBe("allow");
		expect(evaluatePermission("Bash", { cmd: "git push origin main" }, RULES).action).toBe("allow");
	});

	it("rejects rm commands", () => {
		expect(evaluatePermission("Bash", { cmd: "rm foo.txt" }, RULES).action).toBe("reject");
		expect(evaluatePermission("Bash", { cmd: "rm -rf /tmp/junk" }, RULES).action).toBe("reject");
		expect(evaluatePermission("Bash", { cmd: "ls && rm foo" }, RULES).action).toBe("reject");
		expect(evaluatePermission("Bash", { cmd: "false || rm foo" }, RULES).action).toBe("reject");
		expect(evaluatePermission("Bash", { cmd: "echo hi ; rm foo" }, RULES).action).toBe("reject");
	});

	it("allows non-Bash tools via wildcard catch-all", () => {
		expect(evaluatePermission("Read", { cmd: "/etc/passwd" }, RULES)).toEqual({ action: "allow" });
	});

	it("allows everything when no rules", () => {
		expect(evaluatePermission("Bash", { cmd: "rm -rf /" }, [])).toEqual({ action: "allow" });
	});

	it("matches tool name with glob", () => {
		const rules: PermissionRule[] = [
			{ tool: "mcp__*", action: "reject", message: "no mcp" },
			{ tool: "*", action: "allow" },
		];
		expect(evaluatePermission("mcp__playwright_click", {}, rules).action).toBe("reject");
		expect(evaluatePermission("Bash", { cmd: "ls" }, rules).action).toBe("allow");
	});
});

// --- new matchers: cwd / path / within ---
// ported alongside the tool-policy matchers. `within` is the one worth pinning:
// it is a containment guard, so it must resolve paths to absolute BEFORE
// comparing (otherwise "../" escapes match as text) and must fail closed.
describe("evaluatePermission: cwd matcher", () => {
	const rules: PermissionRule[] = [
		{ tool: "*", matches: { cwd: "/tmp/*" }, action: "reject", message: "no work in /tmp" },
		{ tool: "*", action: "allow" },
	];

	it("rejects when cwd matches", () => {
		expect(evaluatePermission("Bash", { cwd: "/tmp/scratch" }, rules).action).toBe("reject");
	});

	it("allows when cwd differs", () => {
		expect(evaluatePermission("Bash", { cwd: "/home/user/project" }, rules).action).toBe("allow");
	});

	it("allows when cwd is absent (rule cannot apply)", () => {
		expect(evaluatePermission("Bash", {}, rules).action).toBe("allow");
	});
});

describe("evaluatePermission: path matcher", () => {
	const rules: PermissionRule[] = [
		{ tool: "edit", matches: { path: "*.env" }, action: "reject", message: "no secrets" },
		{ tool: "*", action: "allow" },
	];

	it("rejects a matching single path", () => {
		expect(evaluatePermission("edit", { path: "/app/.env" }, rules).action).toBe("reject");
	});

	it("rejects when ANY path in paths[] matches", () => {
		expect(
			evaluatePermission("edit", { paths: ["/app/a.ts", "/app/prod.env"] }, rules).action,
		).toBe("reject");
	});

	it("allows when no path matches", () => {
		expect(evaluatePermission("edit", { path: "/app/index.ts" }, rules).action).toBe("allow");
	});

	it("allows when no paths were observed", () => {
		expect(evaluatePermission("edit", {}, rules).action).toBe("allow");
	});
});

describe("evaluatePermission: within containment guard", () => {
	// allow edits only inside the project; reject anything else
	const rules: PermissionRule[] = [
		{ tool: "edit", matches: { within: "/home/user/project" }, action: "allow" },
		{ tool: "edit", action: "reject", message: "edits must stay inside the project" },
		{ tool: "*", action: "allow" },
	];

	it("allows a path inside the root", () => {
		expect(evaluatePermission("edit", { path: "/home/user/project/src/a.ts" }, rules).action)
			.toBe("allow");
	});

	it("rejects a path outside the root", () => {
		expect(evaluatePermission("edit", { path: "/etc/passwd" }, rules).action).toBe("reject");
	});

	it("rejects a '../' escape instead of matching it as text", () => {
		expect(
			evaluatePermission("edit", { path: "/home/user/project/../../../etc/passwd" }, rules).action,
		).toBe("reject");
	});

	it("requires EVERY path to be inside, not just one", () => {
		expect(
			evaluatePermission(
				"edit",
				{ paths: ["/home/user/project/a.ts", "/etc/passwd"] },
				rules,
			).action,
		).toBe("reject");
	});

	it("fails closed when no paths were observed", () => {
		expect(evaluatePermission("edit", {}, rules).action).toBe("reject");
	});

	it("resolves relative paths against sessionCwd", () => {
		expect(
			evaluatePermission(
				"edit",
				{ path: "src/a.ts", sessionCwd: "/home/user/project" },
				rules,
			).action,
		).toBe("allow");
		expect(
			evaluatePermission(
				"edit",
				{ path: "../../../etc/passwd", sessionCwd: "/home/user/project" },
				rules,
			).action,
		).toBe("reject");
	});

	it("treats cwd as a touched path for containment", () => {
		expect(evaluatePermission("edit", { cwd: "/etc" }, rules).action).toBe("reject");
	});
});

const shippedRules: PermissionRule[] = JSON.parse(
	fs.readFileSync(path.join(import.meta.dir, "../../../permissions.json"), "utf8"),
);

// pins both halves of the shipped delete guard on this machine: every bypass is
// caught AND ordinary commands that merely contain the letters "rm" are not.
describe("the real permissions.json: nothing deletes on this machine", () => {
	const rules = shippedRules;
	const verdict = (cmd: string) => evaluateCommand(cmd, rules).action;

	it("blocks rm at the start of a command", () => {
		expect(verdict("rm f")).toBe("reject");
		expect(verdict("rm -rf /tmp/x")).toBe("reject");
	});

	it("blocks rm after any separator, with or without spaces", () => {
		for (const cmd of [
			"echo hi && rm f", "echo hi ; rm f", "echo hi; rm f", "echo hi;rm f", "true || rm f", "(rm f)",
			"echo $(rm f)", "echo `rm f`", "{ rm f; }", "echo hi\nrm f",
		]) {
			expect(verdict(cmd)).toBe("reject");
		}
	});

	it("blocks rm inside loops/conditionals and via xargs / find -exec", () => {
		expect(verdict("for f in *; do rm $f; done")).toBe("reject");
		expect(verdict("if x; then rm f; fi")).toBe("reject");
		expect(verdict("find . -exec rm {} +")).toBe("reject");
		expect(verdict("find . -execdir rm {} +")).toBe("reject");
		expect(verdict("xargs rm < list")).toBe("reject");
		expect(verdict("ls | xargs -0 rm")).toBe("reject");
	});

	it("blocks rm behind a path, a quote, a backslash or a wrapper", () => {
		for (const cmd of [
			"/bin/rm f", "/usr/bin/rm -rf x", "\\rm f", '"rm" f', "command rm f", "builtin rm f", "sudo rm f",
			"sudo -n rm f", "sudo -u root rm f", "env rm f", "env FOO=1 rm f", "FOO=1 rm f", "nohup rm f", "time rm f",
			"exec rm f", "nice -n 5 rm f", "timeout 5 rm f", "busybox rm f",
			"eval rm f", 'eval "rm f"', "$(which rm) f", "`which rm` f", "ls | xargs -I{} rm {}", "find . -exec /bin/rm {} +",
		]) {
			expect(verdict(cmd)).toBe("reject");
		}
	});

	it("blocks rm inside a shell string or a script's process call", () => {
		for (const cmd of [
			'sh -c "rm f"', "bash -c 'rm f'", "bash -lc 'rm f'", 'find . -exec sh -c "rm {}" \\;', 'git submodule foreach "rm f"',
			`python3 -c "import os; os.system('rm f')"`, `python3 -c "import subprocess; subprocess.run(['rm','f'])"`,
		]) {
			expect(verdict(cmd)).toBe("reject");
		}
	});

	it("blocks every other way to delete", () => {
		for (const cmd of [
			"rmdir empty", "unlink f", "shred -u f", "find . -name '*.log' -delete", "sudo find / -delete",
			"git rm f", "git -C repo rm -r dir", "git clean -fd", "git rm $(git ls-files --cached)", "git rm foo # --cached",
			"rsync -a --delete src/ dst/", "rsync --remove-source-files a b",
			`python3 -c "import os; os.remove('f')"`, `python -c "import shutil; shutil.rmtree('d')"`,
			`python3 -c "from os import remove; remove('f')"`, `node -e "require('fs').rmSync('d', {recursive: true})"`,
			`node -e "require('fs').promises.rm('d')"`, `node -e "require('fs/promises').rm('d')"`,
			`bun -e "await Bun.file('f').unlink()"`, `perl -e 'unlink("f")'`, `perl -e 'unlink "f"'`,
			`perl -MFile::Path -e 'rmtree("d")'`, `deno eval "Deno.remove('f')"`, `ruby -e 'Dir.rmdir("d")'`,
			`ruby -e 'FileUtils.rm_rf("d")'`, "python3 - <<'EOF'\nfrom pathlib import Path\nPath('f').unlink()\nEOF",
		]) {
			expect(verdict(cmd)).toBe("reject");
		}
	});

	it("says to use trash", () => {
		expect(evaluatePermission("Bash", { cmd: "rm f" }, rules).message).toContain("trash <path>");
	});

	it("does NOT fire on commit messages, dry runs, or commands that merely contain 'rm'", () => {
		for (const cmd of [
			"npm run rm-cache", "grep rm file.txt", "warm up", "echo confirm", "trash foo", "trash -v a b",
			"git rm --cached f", "git rm -r --cached dir", "git log --grep rm", "docker run --rm img", "ls node_modules/.bin",
			"grep -rn unlinkSync src", 'git commit -m "git clean up"', 'git commit -m "git rm foo"', 'git commit -m "do rm"',
			'git commit -m "fix: time rm"', 'git commit -m "find -delete support"', 'git commit -m "rsync --delete support"',
			"git clean -n", "git clean -nd", "git clean --dry-run", "git rm -n f", 'echo "then rm"', "command -v rm",
			'rg "exec rm" .', "node a.js; git log --grep=unlinkSync", "node scripts/rmSync.js", "cd x && ./scripts/rm.sh",
			"cat .env", "find . -name '*.ts' -print", "rsync -a src/ dst/", "which trash", "pnpm remove lodash",
		]) {
			expect(verdict(cmd)).toBe("allow");
		}
	});

	it("a heredoc that is only data (commit message, file body) is not read as commands", () => {
		expect(verdict("git commit -F - <<'EOF'\nblock deletes:\nrsync --delete, rm -rf, git clean\nEOF")).toBe("allow");
		expect(verdict('cat > notes.md <<EOF\nrm f\nEOF\necho done')).toBe("allow");
		expect(verdict("cat > notes.md <<EOF\nrm f\nEOF\nrm g")).toBe("reject");
		expect(verdict("bash <<'EOF'\nrm f\nEOF")).toBe("reject");
		expect(verdict("python3 - <<'EOF'\nimport os; os.remove('f')\nEOF")).toBe("reject");
		expect(verdict("cat <<EOF | sh\nrm f\nEOF")).toBe("reject");
	});

	it("ssh to this machine is still this machine", () => {
		for (const cmd of [
			"ssh localhost rm f", "ssh 127.0.0.1 'rm -rf ~/x'", "ssh [::1] rm f", "ssh -o ProxyCommand='rm -rf ~' web true",
			'ssh web "echo $(rm -rf ~)"', "ssh web 'ls'; rm -rf ~/x", "ssh web 'ls' && find . -delete",
			"rsync -a --delete web:/srv/ ./backup/",
		]) {
			expect(verdict(cmd)).toBe("reject");
		}
	});

	it("stays fast, and still decides, on commands built to make the rules backtrack", () => {
		const assignments = (n: number) => Array.from({ length: n }, (_, i) => `K${i}=v${i}`).join(" ");
		for (const [cmd, expected] of [
			[`${assignments(60)} ; rm x`, "reject"],
			[`${assignments(30)} make`, "allow"],
			["sudo a ".repeat(40), "allow"],
			[`ssh h '${assignments(30)} true'`, "allow"],
			[`${"node bun python time sudo exec run call eval xargs ".repeat(8000)}`, "allow"],
		] as const) {
			const started = performance.now();
			expect({ cmd: cmd.slice(0, 40), action: verdict(cmd) }).toEqual({ cmd: cmd.slice(0, 40), action: expected });
			expect(performance.now() - started).toBeLessThan(300);
		}
	});

	it("a `<<` that bash does not read as a heredoc hides nothing", () => {
		for (const cmd of [
			'echo "<<EOF"\nrm -rf x\nEOF', "echo '<<EOF'\nrm -rf x", "echo hi # <<EOF\nrm -rf x", "cat <<<EOF\nrm -rf x\nEOF",
			"echo $((1<<2))\nrm -rf x",
		]) {
			expect({ cmd, action: verdict(cmd) }).toEqual({ cmd, action: "reject" });
		}
	});

	it("rsync that removes the files it sent is a delete here", () => {
		expect(verdict("rsync -a --remove-sent-files src/ h:dst/")).toBe("reject");
	});
});

describe("the real permissions.json: server work", () => {
	const verdict = (cmd: string) => evaluateCommand(cmd, shippedRules);

	it("deleting files on a server just runs", () => {
		for (const cmd of [
			"ssh host rm f",
			"ssh host 'rm f'",
			"ssh profilephoto 'docker image prune -f; docker builder prune -af; rm -rf /root/profilephoto-rsync-strays-20261012'",
			"ssh crawlapi 'diff /tmp/envf /tmp/envc; shred -u /tmp/envf /tmp/envc'",
			"ssh -i ~/.ssh/k root@10.0.0.5 'find /var/log/app -name \"*.gz\" -mtime +30 -delete'",
			"ssh crawlapi bash -s <<'EOF'\nrm -rf /root/.profilephoto-retired-20261002\ndf -h /\nEOF",
			"rsync -az --delete ./dist/ deploy@web:/srv/app/",
			"ssh web 'cd /srv/app && git add -A && git commit -m deploy'",
		]) {
			expect(verdict(cmd)).toEqual({ action: "allow" });
		}
	});

	it("force push stays blocked everywhere", () => {
		expect(verdict("ssh web 'cd /srv/app && git push --force'").action).toBe("reject");
	});

	it("a local delete next to server work is still blocked", () => {
		expect(verdict("ssh web 'rm -rf /srv/old'; rm -rf ./build").action).toBe("reject");
	});
});

describe("the real permissions.json: commands that destroy data ask first", () => {
	const verdict = (cmd: string) => evaluateCommand(cmd, shippedRules);
	const asks = (cmd: string) => verdict(cmd).action === "ask";

	it("destructive SQL, here or on a server, with the server named", () => {
		for (const cmd of [
			'psql "$DB" -c "DROP TABLE users"',
			"psql -c 'drop database app'",
			'mysql -e "TRUNCATE TABLE sessions"',
			'sqlite3 app.db "DELETE FROM jobs"',
			'psql -c "ALTER TABLE users DROP COLUMN email"',
			"psql -c 'alter table users drop email'",
			'wrangler d1 execute prod --remote --command "DELETE FROM events"',
			"psql \"$DB\" <<'SQL'\nBEGIN;\nDELETE FROM sessions;\nCOMMIT;\nSQL",
		]) {
			expect({ cmd, asks: asks(cmd) }).toEqual({ cmd, asks: true });
		}
		const remote = verdict("ssh crawlapi \"docker exec crawlapi-db psql -U app -c 'DELETE FROM request_log'\"");
		expect(remote.action).toBe("ask");
		expect(remote.asks).toEqual([{ host: "crawlapi", message: expect.stringContaining("SQL that deletes data") }]);
	});

	it("ordinary SQL and SQL that is only text do not ask", () => {
		for (const cmd of [
			'psql -c "DELETE FROM jobs WHERE finished_at < now() - interval \'30 days\'"',
			"psql -c 'select count(*) from request_log'",
			'psql -c "ALTER TABLE users ALTER COLUMN name DROP NOT NULL"',
			'psql -c "ALTER TABLE users DROP CONSTRAINT users_email_key"',
			'rg -n "DROP TABLE" migrations/',
			"cat > notes.md <<'EOF'\npsql -c 'DROP TABLE x'\nEOF",
			"truncate -s 0 app.log",
		]) {
			expect({ cmd, action: verdict(cmd).action }).toEqual({ cmd, action: "allow" });
		}
	});

	it("wiping a whole database", () => {
		for (const cmd of [
			"dropdb app_prod", "ssh db 'sudo -u postgres dropdb app'", "redis-cli -n 0 FLUSHALL", "redis-cli flushdb",
			"mongosh app --eval 'db.dropDatabase()'", "mongosh --eval 'db.users.drop()'", "npx prisma migrate reset --force",
			"npx prisma db push --force-reset", "supabase db reset --linked", "bin/rails db:drop",
		]) {
			expect({ cmd, asks: asks(cmd) }).toEqual({ cmd, asks: true });
		}
		for (const cmd of ["redis-cli GET key", "npx prisma migrate deploy", "npx prisma db push", "bin/rails db:migrate"]) {
			expect({ cmd, action: verdict(cmd).action }).toEqual({ cmd, action: "allow" });
		}
	});

	it("Docker volumes and database data folders", () => {
		for (const cmd of [
			"docker volume rm pgdata", "docker volume prune -f", "docker system prune -af --volumes",
			"docker compose down -v", "docker compose -f prod.yml down --volumes", "docker-compose down --rmi all -v",
			"ssh crawlapi 'cd /opt/crawlapi && docker compose down -v'", "ssh db 'rm -rf /var/lib/postgresql/16/main'",
		]) {
			expect({ cmd, asks: asks(cmd) }).toEqual({ cmd, asks: true });
		}
		for (const cmd of [
			"docker compose down", "docker compose down --remove-orphans", "docker rmi crawlapi-api:old",
			"docker builder prune -af", "docker system prune -af", "docker image prune -f", "docker rm -f old-container",
			"docker volume ls", "ssh web 'rm -rf /var/lib/app-cache'",
		]) {
			expect({ cmd, action: verdict(cmd).action }).toEqual({ cmd, action: "allow" });
		}
	});

	it("cloud storage and cloud databases", () => {
		for (const cmd of [
			"aws s3 rb s3://backups --force", "aws s3 rm s3://backups/ --recursive", "aws s3api delete-bucket --bucket b",
			"gsutil -m rm -r gs://b/dir", "gcloud storage buckets delete gs://b", "wrangler r2 bucket delete server-backups",
			"wrangler d1 delete prod-db", "rclone purge r2:server-backups", "fly volumes destroy vol_123",
		]) {
			expect({ cmd, asks: asks(cmd) }).toEqual({ cmd, asks: true });
		}
		for (const cmd of ["aws s3 ls s3://b", "aws s3 cp f s3://b/f", "aws s3 rm s3://b/one-file.txt", "wrangler r2 bucket list"]) {
			expect({ cmd, action: verdict(cmd).action }).toEqual({ cmd, action: "allow" });
		}
	});

	it("erasing a disk", () => {
		for (const cmd of ["ssh box 'mkfs.ext4 /dev/sdb1'", "ssh box 'wipefs -a /dev/sdb'", "ssh box 'dd if=/dev/zero of=/dev/sdb bs=1M'"]) {
			expect({ cmd, asks: asks(cmd) }).toEqual({ cmd, asks: true });
		}
		for (const cmd of ["dd if=/dev/urandom of=./blob bs=1k count=4", "dd if=x of=/dev/null"]) {
			expect({ cmd, action: verdict(cmd).action }).toEqual({ cmd, action: "allow" });
		}
	});

	it("diskutil erases count as erasing a disk", () => {
		for (const cmd of ["diskutil eraseDisk APFS X /dev/disk4", "diskutil apfs deleteVolume disk3s5", "diskutil zeroDisk disk4"]) {
			expect({ cmd, asks: asks(cmd) }).toEqual({ cmd, asks: true });
		}
		expect(verdict("diskutil list").action).toBe("allow");
	});

	it("SQL: piped in, long, quoted names, WHERE on the next line", () => {
		const longMigration = `psql "$DB" <<'SQL'\n${"INSERT INTO t VALUES (1);\n".repeat(500)}DROP TABLE old_t;\nSQL`;
		for (const cmd of [`echo "DROP TABLE t" | psql "$DB"`, longMigration, `psql -c 'DELETE FROM users RETURNING *'`]) {
			expect({ cmd: cmd.slice(0, 60), asks: asks(cmd) }).toEqual({ cmd: cmd.slice(0, 60), asks: true });
		}
		for (const cmd of [
			"psql \"$DB\" <<'SQL'\nDELETE FROM users\nWHERE id = 1;\nSQL",
			'psql -c \'DELETE FROM "users" WHERE id = 1\'',
			"psql -c 'DELETE FROM users u WHERE u.id = 1'",
			"psql -c 'DELETE FROM a USING b WHERE a.id = b.id'",
			"rg -n d1 src; echo 'DROP TABLE'",
		]) {
			expect({ cmd, action: verdict(cmd).action }).toEqual({ cmd, action: "allow" });
		}
	});

	it("a block beats an ask, and every ask on a line is listed", () => {
		expect(verdict("psql -c 'DROP TABLE t'; rm -rf ./x").action).toBe("reject");
		expect(verdict("psql -c 'DROP TABLE t'; amp --version").action).toBe("reject");
		const both = verdict("ssh a 'docker volume rm v1' && ssh b 'redis-cli FLUSHALL'");
		expect(both.action).toBe("ask");
		expect(both.asks?.map((ask) => ask.host)).toEqual(["a", "b"]);
	});
});

describe("evaluatePermission: an ask never hides a later reject", () => {
	const rules: PermissionRule[] = [
		{ tool: "Bash", matches: { cmd: "*drop*" }, action: "ask", message: "asks" },
		{ tool: "Bash", matches: { cmd: "*launch*" }, action: "reject", message: "no" },
		{ tool: "Bash", matches: { cmd: "*fine*" }, action: "allow" },
		{ tool: "Bash", matches: { cmd: "*late*" }, action: "reject", message: "too late" },
		{ tool: "*", action: "allow" },
	];

	it("reject listed after the ask still wins", () => {
		expect(evaluatePermission("Bash", { cmd: "drop and launch" }, rules)).toEqual({ action: "reject", message: "no" });
	});

	it("an allow after the ask ends the search with the ask, as first-match order says", () => {
		expect(evaluatePermission("Bash", { cmd: "drop fine late" }, rules)).toEqual({ action: "ask", message: "asks" });
		expect(evaluatePermission("Bash", { cmd: "drop" }, rules)).toEqual({ action: "ask", message: "asks" });
	});
});

describe("evaluatePermission: where", () => {
	const rules: PermissionRule[] = [
		{ tool: "Bash", matches: { cmd: "rm *", where: "local" }, action: "reject" },
		{ tool: "Bash", matches: { cmd: "reboot*", where: "remote" }, action: "ask" },
		{ tool: "*", action: "allow" },
	];

	it("a local rule skips server commands and a remote rule skips local ones", () => {
		expect(evaluatePermission("Bash", { cmd: "rm f" }, rules).action).toBe("reject");
		expect(evaluatePermission("Bash", { cmd: "rm f", host: "web" }, rules).action).toBe("allow");
		expect(evaluatePermission("Bash", { cmd: "reboot", host: "web" }, rules).action).toBe("ask");
		expect(evaluatePermission("Bash", { cmd: "reboot" }, rules).action).toBe("allow");
	});
});

describe("evaluatePermission: regex: patterns", () => {
	it("fails closed on a malformed regex instead of matching everything", () => {
		const broken: PermissionRule[] = [
			{ tool: "*", matches: { cmd: ["regex:([unclosed"] }, action: "reject" },
			{ tool: "*", action: "allow" },
		];
		expect(evaluatePermission("Bash", { cmd: "anything at all" }, broken).action).toBe("allow");
	});
});
