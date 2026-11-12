import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createBashTool } from "../bash";
import { gitEnv, gitRefusal } from "./git";

// run from pi's bash, this process inherits the deployed hooks; the tests need git as a plain terminal has it
for (const name of Object.keys(process.env)) if (name.startsWith("GIT_CONFIG_")) delete process.env[name];

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-git-"));
const SECRET_NAME = "PI_GIT_TEST_TOKEN";
const SECRET = "Zq8vT3mN6pW1xK4cR7bY";

beforeAll(() => {
	process.env[SECRET_NAME] = SECRET;
});
afterAll(() => {
	delete process.env[SECRET_NAME];
	fs.rmSync(root, { recursive: true, force: true });
});

/** git without pi's environment, as the user's own terminal runs it */
const plainGit = (dir: string, ...args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });

function repo(name: string): string {
	const dir = path.join(root, name);
	fs.mkdirSync(dir, { recursive: true });
	plainGit(dir, "init", "-q", "-b", "main");
	for (const [key, value] of [["user.name", "t"], ["user.email", "t@t"], ["commit.gpgsign", "false"], ["core.hooksPath", ".git/hooks"]]) {
		plainGit(dir, "config", key!, value!);
	}
	fs.writeFileSync(path.join(dir, "app.ts"), "export const x = 1;\n");
	plainGit(dir, "add", "app.ts");
	plainGit(dir, "commit", "-q", "-m", "init");
	return dir;
}

const write = (dir: string, file: string, text: string) => {
	fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
	fs.writeFileSync(path.join(dir, file), text);
};
const commits = (dir: string) => Number(plainGit(dir, "rev-list", "--count", "HEAD").stdout.trim());

const bash = createBashTool() as any;
async function sh(dir: string, cmd: string): Promise<{ text: string; failed: boolean }> {
	const result = await bash.execute("t", { cmd, timeout: 60 }, undefined, undefined, { cwd: dir, sessionManager: { getSessionId: () => "git-test" } });
	return { text: result.content[0].text, failed: result.isError === true };
}

describe("the secret scan runs inside git, on exactly what is committed", () => {
	test("`git add && git commit` in one command: the secret added by the add is caught", async () => {
		const dir = repo("same-command");
		write(dir, "cfg.ts", `export const token = "${SECRET}";\n`);
		const run = await sh(dir, 'git add cfg.ts && git commit -q -m "feat: cfg"');
		expect(run.failed).toBe(true);
		expect(run.text).toContain(`cfg.ts:1  the value of $${SECRET_NAME}`);
		expect(run.text).toContain("Nothing was committed");
		expect(run.text).not.toContain(SECRET);
		expect(commits(dir)).toBe(1);
	});

	test("--no-verify does not skip it", async () => {
		const dir = repo("no-verify");
		write(dir, "cfg.ts", `export const token = "${SECRET}";\n`);
		plainGit(dir, "add", "cfg.ts");
		expect((await sh(dir, 'git commit -q --no-verify -m "feat: cfg"')).failed).toBe(true);
		expect(commits(dir)).toBe(1);
	});

	test("a path-limited commit is judged on its own files, not on what another session staged", async () => {
		const dir = repo("path-limited");
		write(dir, "theirs.ts", `export const token = "${SECRET}";\n`);
		plainGit(dir, "add", "theirs.ts");
		write(dir, "mine.ts", "export const y = 2;\n");
		plainGit(dir, "add", "mine.ts");
		const run = await sh(dir, 'git commit -q -m "feat: mine" -- mine.ts');
		expect(run.failed).toBe(false);
		expect(plainGit(dir, "show", "--name-only", "--format=", "HEAD").stdout.trim()).toBe("mine.ts");
		expect(plainGit(dir, "diff", "--cached", "--name-only").stdout.trim()).toBe("theirs.ts");
	});

	test("what only looks like a secret goes through, with a note", async () => {
		const dir = repo("warning");
		write(dir, "test_env.py", 'DATABASE_URL = "postgresql://app:ci-password-not-real@db:5432/app"\n');
		const run = await sh(dir, 'git add test_env.py && git commit -q -m "test: env"');
		expect(run.failed).toBe(false);
		expect(run.text).toContain("nothing blocks this");
		expect(run.text).toContain("test_env.py:1");
		expect(commits(dir)).toBe(2);
	});

	test("a value the file already held before this commit is not newly published", async () => {
		const dir = repo("already-there");
		write(dir, "cfg.ts", `export const token = "${SECRET}";\n`);
		plainGit(dir, "add", "cfg.ts");
		plainGit(dir, "commit", "-q", "-m", "an old commit made outside pi");
		write(dir, "cfg.ts", `export const token = "${SECRET}"; // moved\n`);
		const run = await sh(dir, 'git add cfg.ts && git commit -q -m "chore: touch cfg"');
		expect(run.failed).toBe(false);
		expect(run.text).toContain("already in this file before");
	});

	test("a rebase replaying a commit made outside pi is not stopped", async () => {
		const dir = repo("rebase");
		plainGit(dir, "checkout", "-q", "-b", "side");
		write(dir, "cfg.ts", `export const token = "${SECRET}";\n`);
		plainGit(dir, "add", "cfg.ts");
		plainGit(dir, "commit", "-q", "-m", "side");
		plainGit(dir, "checkout", "-q", "main");
		write(dir, "other.ts", "export const z = 3;\n");
		plainGit(dir, "add", "other.ts");
		plainGit(dir, "commit", "-q", "-m", "main moves");
		plainGit(dir, "checkout", "-q", "side");
		const run = await sh(dir, "git rebase main");
		expect(run.failed).toBe(false);
		expect(plainGit(dir, "status", "--porcelain").stdout).toBe("");
	});

	test("a merge bringing in a branch made outside pi is not stopped", async () => {
		const dir = repo("merge");
		plainGit(dir, "checkout", "-q", "-b", "side");
		write(dir, "cfg.ts", `export const token = "${SECRET}";\n`);
		plainGit(dir, "add", "cfg.ts");
		plainGit(dir, "commit", "-q", "-m", "side");
		plainGit(dir, "checkout", "-q", "main");
		write(dir, "other.ts", "export const z = 3;\n");
		plainGit(dir, "add", "other.ts");
		plainGit(dir, "commit", "-q", "-m", "main moves");
		const run = await sh(dir, 'git merge -q --no-ff -m "merge side" side');
		expect(run.failed).toBe(false);
		expect(plainGit(dir, "log", "-1", "--format=%s").stdout.trim()).toBe("merge side");
	});

	test("new content amended in during a rebase stop is still caught", async () => {
		const dir = repo("rebase-edit");
		write(dir, "b.ts", "export const b = 1;\n");
		plainGit(dir, "add", "b.ts");
		plainGit(dir, "commit", "-q", "-m", "b");
		expect((await sh(dir, `GIT_SEQUENCE_EDITOR="sed -i.bak 's/^pick/edit/'" git rebase -i HEAD~1`)).failed).toBe(false);
		write(dir, "b.ts", `export const b = "${SECRET}";\n`);
		const run = await sh(dir, "git add b.ts && git commit -q --amend --no-edit");
		expect(run.failed).toBe(true);
		expect(run.text).toContain("b.ts:1");
		plainGit(dir, "rebase", "--abort");
	});

	test("a push of an unpushed secret is stopped, and --no-verify is checked before it runs", async () => {
		const remote = path.join(root, "remote.git");
		plainGit(root, "init", "-q", "--bare", remote);
		const dir = repo("push");
		plainGit(dir, "remote", "add", "origin", remote);
		expect((await sh(dir, "git push -q -u origin main")).failed).toBe(false);
		write(dir, "cfg.ts", `export const token = "${SECRET}";\n`);
		plainGit(dir, "add", "cfg.ts");
		plainGit(dir, "commit", "-q", "-m", "made outside pi");

		const pushed = await sh(dir, "git push -q");
		expect(pushed.failed).toBe(true);
		expect(pushed.text).toContain("git did not push");
		expect(pushed.text).toMatch(/[0-9a-f]{7} cfg\.ts:1/);

		const skipped = await sh(dir, "git push -q --no-verify");
		expect(skipped.failed).toBe(true);
		expect(skipped.text).toContain("this command was not run");
		expect(plainGit(remote, "rev-list", "--count", "main").stdout.trim()).toBe("1");
	});

	test("PI_SECRET_SCAN_OFF=1 in pi's environment turns it off", async () => {
		const dir = repo("off");
		write(dir, "cfg.ts", `export const token = "${SECRET}";\n`);
		process.env.PI_SECRET_SCAN_OFF = "1";
		try {
			expect((await sh(dir, 'git add cfg.ts && git commit -q -m "feat: cfg"')).failed).toBe(false);
		} finally {
			delete process.env.PI_SECRET_SCAN_OFF;
		}
	});
});

describe("staging every change is refused; staging files by name is not", () => {
	const refused = [
		"git add .", "git add -A", "git add --all", "git add -u", "git add -- .", "git add ./", "git add :/", "git add '*'", "git add ..",
		"git -C ../repo add -A", "git status && git add .", "bash -c 'git add .'", "(cd sub && git add .)",
		"git commit -am wip", "git commit -a -m wip", "git commit --all -m wip",
	];
	const allowed = [
		"git add .gitignore src/app.ts", "git add .env.example AGENTS.md", "git add ./src/app.ts", "git add .github/workflows/ci.yml",
		"git add -A -- src docs", "git add -A src/app.ts", "git add -n .", "git add --dry-run -A", "git add -u -- src/app.ts",
		'git commit -m "-a fix"', 'git commit -m "git add . is refused"', "git commit -q -m x -- src/app.ts", "git add -p",
		"git commit -F - <<'EOF'\nfix: x\n\ngit add . and git commit -a are refused now\nEOF",
		"ssh web 'cd /srv/app && git add -A && git commit -m deploy'",
		"git add \\\n  src/a.ts \\\n  src/b.ts",
		"git add \\\n  src/a.ts \\\n  src/b.ts \\",
		"git add \\\n  src/a.ts \\\n  && git commit -q -m x",
		"git init -q demo && cd demo && git add . && git commit -qm init",
	];
	for (const cmd of refused) test(`refused: ${cmd}`, () => expect(gitRefusal(cmd)).toBeDefined());
	for (const cmd of allowed) test(`allowed: ${cmd.split("\n")[0]}`, () => expect(gitRefusal(cmd)).toBeUndefined());

	test("the refusal says what to do instead", () => {
		expect(gitRefusal("git add .")).toContain("git add -- src/a.ts src/b.ts");
		expect(gitRefusal("git add .")).toContain("commit` tool");
	});

	test("every one of the 50 old `git add` blocks in past sessions that named files now runs", () => {
		// the shapes that the `*git add .*` glob refused: lists that start with a dotfile, -A scoped to paths, dry runs
		for (const cmd of [
			"git add .editorconfig .github .gitignore .node-version AGENTS.md LICENSE",
			"git add .gitignore api/src/index.ts api/src/lib/api-gateway.ts",
			"git add .node-version .nvmrc api/Dockerfile api/package.json",
			"git add -A -- AGENTS.md bench control docs migrations sites src tests",
			"git add -A src/crawlapi/docs_export.py tests/test_docs_export.py",
			"git add -A -n . 2>/dev/null",
		]) {
			expect(gitRefusal(cmd)).toBeUndefined();
		}
	});
});

describe("pushes that rewrite or delete the remote are refused", () => {
	for (const cmd of ["git push --force", "git push -f origin main", "git push --force-with-lease", "git push origin +main", "git push origin :old", "git push --delete origin old", "ssh box 'cd app && git push -f'"]) {
		test(`refused: ${cmd}`, () => expect(gitRefusal(cmd)).toBeDefined());
	}
	for (const cmd of ["git push", "git push -u origin main", "git push origin main:main", "git push -o ci.skip origin main"]) {
		test(`allowed: ${cmd}`, () => expect(gitRefusal(cmd)).toBeUndefined());
	}
});

describe("the environment", () => {
	test("the hooks go after the user's own config entries", () => {
		const env = gitEnv({ PATH: "/usr/bin", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.pager", GIT_CONFIG_VALUE_0: "cat" });
		expect(env.GIT_CONFIG_COUNT).toBe("5");
		expect(env.GIT_CONFIG_KEY_1).toBe("hook.pi-secret-scan.event");
		expect(env.GIT_CONFIG_KEY_0).toBeUndefined();
	});

	test("a pi started from bash does not register the hooks a second time", () => {
		const outer = gitEnv({ PATH: "/usr/bin" });
		const inner = gitEnv({ PATH: "/usr/bin", ...outer });
		expect(inner.GIT_CONFIG_COUNT).toBeUndefined();
	});
});

describe("git never waits for a human", () => {
	test("a commit with no message ends at once instead of opening the repo's editor", async () => {
		const dir = repo("editor");
		plainGit(dir, "config", "core.editor", "sleep 120");
		write(dir, "b.ts", "export const b = 1;\n");
		plainGit(dir, "add", "b.ts");
		const started = Date.now();
		const run = await sh(dir, "git commit");
		expect(Date.now() - started).toBeLessThan(15_000);
		expect(run.text).toContain("empty commit message");
		expect(commits(dir)).toBe(1);
	});

	test("a commit with a message carries the session's trailer", async () => {
		const dir = repo("trailer");
		write(dir, "c.ts", "export const c = 1;\n");
		expect((await sh(dir, 'git add c.ts && git commit -q -m "feat: c"')).failed).toBe(false);
		expect(plainGit(dir, "log", "-1", "--format=%B").stdout.trim()).toBe("feat: c\n\nSession-Id: git-test");
	});

	test("git-hunks passes its adversarial suite", () => {
		const suite = spawnSync("bash", [path.join(import.meta.dir, "..", "..", "..", "git", "git-hunks-test")], { encoding: "utf8" });
		expect(suite.stdout).toContain("0 failed");
		expect(suite.status).toBe(0);
	}, 120_000);

	test("`git hunks` is a git command in bash", async () => {
		const dir = repo("hunks");
		write(dir, "app.ts", "export const x = 2;\n");
		const run = await sh(dir, "git hunks list app.ts");
		expect(run.failed).toBe(false);
		expect(run.text).toContain("git hunks add");
	});
});
