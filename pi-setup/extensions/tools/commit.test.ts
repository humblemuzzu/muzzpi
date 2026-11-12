import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createCommitTool } from "./commit";

// run from pi's bash, this process inherits the deployed hooks; the tests need git as a plain terminal has it
for (const name of Object.keys(process.env)) if (name.startsWith("GIT_CONFIG_")) delete process.env[name];

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-commit-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const git = (dir: string, ...args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });

function repo(name: string): string {
	const dir = path.join(root, name);
	fs.mkdirSync(dir, { recursive: true });
	git(dir, "init", "-q", "-b", "main");
	for (const [key, value] of [["user.name", "t"], ["user.email", "t@t"], ["commit.gpgsign", "false"], ["core.hooksPath", ".git/hooks"]]) {
		git(dir, "config", key!, value!);
	}
	write(dir, "app.ts", "export const x = 1;\n");
	write(dir, "old.ts", "export const old = 1;\n");
	git(dir, "add", "app.ts", "old.ts");
	git(dir, "commit", "-q", "-m", "init");
	return dir;
}

function write(dir: string, file: string, text: string) {
	fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
	fs.writeFileSync(path.join(dir, file), text);
}

const committed = (dir: string, ref = "HEAD") => git(dir, "show", "--name-only", "--format=", ref).stdout.trim().split("\n").filter(Boolean).sort();

const tool = createCommitTool() as any;
async function commit(dir: string, params: Record<string, unknown>, session = "commit-test") {
	const args = tool.prepareArguments(params);
	const result = await tool.execute("t", args, undefined, undefined, { cwd: dir, sessionManager: { getSessionId: () => session } });
	return { text: result.content[0].text as string, failed: result.isError === true };
}

describe("commit takes exactly the files named", () => {
	test("another session's staged and unstaged work stays out, and stays where it was", async () => {
		const dir = repo("only-mine");
		write(dir, "theirs-staged.ts", "export const a = 1;\n");
		git(dir, "add", "theirs-staged.ts");
		write(dir, "old.ts", "export const old = 2; // theirs, unstaged\n");
		write(dir, "mine.ts", "export const mine = 1;\n");
		write(dir, "app.ts", "export const x = 2;\n");

		const run = await commit(dir, { message: "feat(app): add mine", files: ["mine.ts", "app.ts"] });
		expect(run.failed).toBe(false);
		expect(committed(dir)).toEqual(["app.ts", "mine.ts"]);
		expect(git(dir, "diff", "--cached", "--name-only").stdout.trim()).toBe("theirs-staged.ts");
		expect(git(dir, "diff", "--name-only").stdout.trim()).toBe("old.ts");
		expect(run.text).toMatch(/^Committed [0-9a-f]{7} feat\(app\): add mine/);
		expect(run.text).toContain("staged, not committed: theirs-staged.ts");
		expect(run.text).toContain("changed, not staged: old.ts");
		expect(git(dir, "log", "-1", "--format=%B").stdout).toContain("Session-Id: commit-test");
	});

	test("a new file, a deleted file and a rename (both paths) in one commit", async () => {
		const dir = repo("kinds");
		write(dir, "new.ts", "export const n = 1;\n");
		fs.rmSync(path.join(dir, "app.ts"));
		fs.renameSync(path.join(dir, "old.ts"), path.join(dir, "renamed.ts"));
		const run = await commit(dir, { message: "refactor: move things", files: ["new.ts", "app.ts", "old.ts", "renamed.ts"] });
		expect(run.failed).toBe(false);
		expect(git(dir, "ls-files").stdout.trim().split("\n").sort()).toEqual(["new.ts", "renamed.ts"]);
		expect(git(dir, "status", "--porcelain").stdout).toBe("");
	});

	test("a move or delete already staged by `git mv` / `git rm` is committed by naming both paths", async () => {
		const dir = repo("staged-move");
		git(dir, "mv", "old.ts", "moved.ts");
		git(dir, "rm", "-q", "app.ts");
		const run = await commit(dir, { message: "refactor: move old", files: ["old.ts", "moved.ts", "app.ts"] });
		expect(run.failed).toBe(false);
		expect(git(dir, "ls-files").stdout.trim()).toBe("moved.ts");
		expect(git(dir, "status", "--porcelain").stdout).toBe("");
	});

	test("two sessions committing in the same checkout at once each get only their own file", async () => {
		const dir = repo("parallel");
		write(dir, "a.ts", "export const a = 1;\n");
		write(dir, "b.ts", "export const b = 1;\n");
		const [first, second] = await Promise.all([
			commit(dir, { message: "feat: a", files: ["a.ts"] }, "session-a"),
			commit(dir, { message: "feat: b", files: ["b.ts"] }, "session-b"),
		]);
		expect(first.failed || second.failed).toBe(false);
		const subjects = git(dir, "log", "--format=%s", "-2").stdout.trim().split("\n").sort();
		expect(subjects).toEqual(["feat: a", "feat: b"]);
		for (const ref of ["HEAD", "HEAD~1"]) expect(committed(dir, ref)).toHaveLength(1);
	});

	test("without files it commits what is staged, such as hunks", async () => {
		const dir = repo("staged");
		write(dir, "app.ts", "export const x = 3;\n");
		git(dir, "add", "app.ts");
		const run = await commit(dir, { message: "fix: x" });
		expect(run.failed).toBe(false);
		expect(committed(dir)).toEqual(["app.ts"]);
	});

	test("a bare string or a JSON-stringified list of files is accepted", async () => {
		const dir = repo("loose-args");
		write(dir, "a.ts", "export const a = 1;\n");
		write(dir, "b.ts", "export const b = 1;\n");
		expect((await commit(dir, { message: "feat: a", files: "a.ts" })).failed).toBe(false);
		expect((await commit(dir, { message: "feat: b", files: '["b.ts"]' })).failed).toBe(false);
		expect(committed(dir)).toEqual(["b.ts"]);
	});

	test("cwd may be a folder inside the repository; files are relative to it", async () => {
		const dir = repo("subdir");
		write(dir, "pkg/src/a.ts", "export const a = 1;\n");
		const run = await commit(root, { message: "feat(pkg): a", files: ["src/a.ts"], cwd: path.join(dir, "pkg") });
		expect(run.failed).toBe(false);
		expect(committed(dir)).toEqual(["pkg/src/a.ts"]);
	});
});

describe("commit refuses before touching anything", () => {
	test("a folder, a file that never existed, and a path outside the repository", async () => {
		const dir = repo("refusals");
		write(dir, "src/a.ts", "export const a = 1;\n");
		expect((await commit(dir, { message: "feat: a", files: ["src"] })).text).toContain("is a folder");
		expect((await commit(dir, { message: "feat: a", files: ["nope.ts"] })).text).toContain("does not exist");
		expect((await commit(dir, { message: "feat: a", files: ["../elsewhere.ts"] })).text).toContain("not a file inside the repository");
		expect(git(dir, "diff", "--cached", "--name-only").stdout).toBe("");
	});

	test("a message that is not `type(scope): subject`", async () => {
		const dir = repo("message");
		write(dir, "a.ts", "export const a = 1;\n");
		const run = await commit(dir, { message: "Added a", files: ["a.ts"] });
		expect(run.failed).toBe(true);
		expect(run.text).toContain("type(scope): subject");
		expect(git(dir, "rev-list", "--count", "HEAD").stdout.trim()).toBe("1");
	});

	test("nothing staged and no files", async () => {
		const dir = repo("empty");
		expect((await commit(dir, { message: "fix: x" })).text).toContain("Nothing is staged");
	});

	test("files with no change", async () => {
		const dir = repo("unchanged");
		const run = await commit(dir, { message: "fix: x", files: ["app.ts"] });
		expect(run.failed).toBe(true);
		expect(run.text).toContain("None of these files has a change to commit");
	});
});

describe("commit and the secret scan", () => {
	test("a value of the user's secrets stops it, with the hook's own instructions", async () => {
		const dir = repo("secret");
		process.env.PI_COMMIT_TEST_TOKEN = "Hq4wN8xL2vB6tR9mZ3pK";
		try {
			write(dir, "cfg.ts", `export const t = "${process.env.PI_COMMIT_TEST_TOKEN}";\n`);
			const run = await commit(dir, { message: "feat: cfg", files: ["cfg.ts"] });
			expect(run.failed).toBe(true);
			expect(run.text).toContain("cfg.ts:1  the value of $PI_COMMIT_TEST_TOKEN");
			expect(git(dir, "rev-list", "--count", "HEAD").stdout.trim()).toBe("1");
		} finally {
			delete process.env.PI_COMMIT_TEST_TOKEN;
		}
	});
});

describe("commit with push", () => {
	test("sets origin as upstream on the first push, then pushes to it", async () => {
		const remote = path.join(root, "remote.git");
		git(root, "init", "-q", "--bare", remote);
		const dir = repo("push");
		git(dir, "remote", "add", "origin", remote);
		write(dir, "a.ts", "export const a = 1;\n");
		const first = await commit(dir, { message: "feat: a", files: ["a.ts"], push: true });
		expect(first.failed).toBe(false);
		expect(first.text).toContain("Pushed to origin/main.");
		write(dir, "b.ts", "export const b = 1;\n");
		const second = await commit(dir, { message: "feat: b", files: ["b.ts"], push: true });
		expect(second.text).toContain("Pushed to origin/main.");
		expect(git(remote, "log", "--format=%s", "main").stdout.trim().split("\n")).toEqual(["feat: b", "feat: a", "init"]);
	});
});
