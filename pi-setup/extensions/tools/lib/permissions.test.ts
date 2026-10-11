import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { evaluatePermission, withoutDataHeredocs, type PermissionRule } from "./permissions";

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

// pins both halves of the shipped delete guard: every bypass is caught AND
// ordinary commands that merely contain the letters "rm" are not.
describe("the real permissions.json: nothing deletes, everything goes to trash", () => {
	const rules: PermissionRule[] = JSON.parse(
		fs.readFileSync(path.join(import.meta.dir, "../../../permissions.json"), "utf8"),
	);
	const verdict = (cmd: string) => evaluatePermission("Bash", { cmd }, rules).action;

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
			"exec rm f", "nice -n 5 rm f", "timeout 5 rm f", "ssh host rm f", "ssh host 'rm f'", "busybox rm f",
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
		const bash = (cmd: string) => evaluatePermission("Bash", { cmd: withoutDataHeredocs(cmd) }, rules).action;
		expect(bash("git commit -F - <<'EOF'\nblock deletes:\nrsync --delete, rm -rf, git clean\nEOF")).toBe("allow");
		expect(bash('cat > notes.md <<EOF\nrm f\nEOF\necho done')).toBe("allow");
		expect(bash("cat > notes.md <<EOF\nrm f\nEOF\nrm g")).toBe("reject");
		expect(bash("bash <<'EOF'\nrm f\nEOF")).toBe("reject");
		expect(bash("python3 - <<'EOF'\nimport os; os.remove('f')\nEOF")).toBe("reject");
		expect(bash("cat <<EOF | sh\nrm f\nEOF")).toBe("reject");
		expect(bash("ssh host <<EOF\nrm f\nEOF")).toBe("reject");
	});

	it("stays fast on a huge command full of wrapper and interpreter words", () => {
		const huge = `cat <<EOF > x\n${"node bun python time sudo exec run call eval xargs ".repeat(8000)}\nEOF`;
		const started = performance.now();
		verdict(huge);
		expect(performance.now() - started).toBeLessThan(200);
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
