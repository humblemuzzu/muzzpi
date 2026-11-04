import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createBashTool } from "../bash";
import { findLeaks, gitAction, leakRefusal, scanCommand } from "./commit-guard";
import { redactSecretPatterns } from "./psst";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "commit-guard-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const TOKEN = `ghp_${"aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0hJ3lM6"}`;

function repo(name: string): string {
	const dir = path.join(root, name);
	fs.mkdirSync(dir, { recursive: true });
	const git = (...args: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir });
	git("init", "-q", "-b", "main");
	fs.writeFileSync(path.join(dir, "app.ts"), "export const x = 1;\n");
	git("add", "-A");
	git("commit", "-q", "-m", "init");
	return dir;
}

const run = (dir: string, ...args: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir });

describe("gitAction", () => {
	test("names local commits and pushes only", () => {
		expect(gitAction('git commit -m "x"')?.action).toBe("commit");
		expect(gitAction("git status && git commit -am wip")?.action).toBe("commit");
		expect(gitAction("git log --oneline")).toBeUndefined();
		expect(gitAction("ssh box 'cd app && git push'")).toBeUndefined();
	});

	test("a commit message that mentions ssh is still a local commit", () => {
		expect(gitAction('git commit -m "fix ssh timeout"')?.action).toBe("commit");
	});

	test("global options are skipped, and -C names the repo to scan", () => {
		expect(gitAction("git --no-pager commit -m x")?.action).toBe("commit");
		expect(gitAction("git -C /repo push origin main")).toEqual({ action: "push", dir: "/repo" });
		expect(gitAction('git -C "/a b" -c user.name=x commit -m y')).toEqual({ action: "commit", dir: "/a b" });
	});
});

describe("findLeaks", () => {
	test("reports the file and new-side line of an added secret, never a removed one", () => {
		const diff = [
			"diff --git a/cfg.ts b/cfg.ts",
			"+++ b/cfg.ts",
			"@@ -0,0 +10,3 @@",
			"+const a = 1;",
			`+const token = "${TOKEN}";`,
			`-const old = "${TOKEN}";`,
			"+const b = 2;",
		].join("\n");
		expect(findLeaks(diff, redactSecretPatterns)).toEqual([{ file: "cfg.ts", line: 11 }]);
	});

	test("placeholders and references pass", () => {
		const diff = ["+++ b/.env.example", "@@ -0,0 +1,2 @@", "+API_KEY=YOUR_API_KEY_HERE", "+TOKEN=$GITHUB_TOKEN"].join("\n");
		expect(findLeaks(diff, redactSecretPatterns)).toEqual([]);
	});
});

describe("scanCommand", () => {
	test("a staged secret blocks the commit; the refusal names the line, not the value", async () => {
		const dir = repo("staged");
		fs.writeFileSync(path.join(dir, "cfg.ts"), `export const token = "${TOKEN}";\n`);
		run(dir, "add", "cfg.ts");
		const found = await scanCommand('git commit -m "add cfg"', dir, redactSecretPatterns);
		expect(found?.leaks).toEqual([{ file: "cfg.ts", line: 1 }]);
		const message = leakRefusal(found!.action, found!.leaks);
		expect(message).toContain("cfg.ts:1");
		expect(message).toContain("Do NOT retry this command");
		expect(message).not.toContain(TOKEN);
	});

	test("an unstaged secret only counts for commit -a", async () => {
		const dir = repo("unstaged");
		fs.writeFileSync(path.join(dir, "app.ts"), `export const x = "${TOKEN}";\n`);
		expect(await scanCommand('git commit -m "x"', dir, redactSecretPatterns)).toBeUndefined();
		expect((await scanCommand('git commit -am "x"', dir, redactSecretPatterns))?.leaks).toHaveLength(1);
	});

	test("git -C scans the repo it names, not the shell's directory", async () => {
		const dir = repo("elsewhere");
		fs.writeFileSync(path.join(dir, "cfg.ts"), `export const token = "${TOKEN}";\n`);
		run(dir, "add", "cfg.ts");
		const found = await scanCommand(`git -C "${dir}" commit -m "fix ssh timeout"`, root, redactSecretPatterns);
		expect(found?.leaks).toEqual([{ file: "cfg.ts", line: 1 }]);
	});

	test("a push scans the commits the remote does not have yet", async () => {
		const remote = path.join(root, "remote.git");
		spawnSync("git", ["init", "-q", "--bare", remote]);
		const dir = repo("pushing");
		run(dir, "remote", "add", "origin", remote);
		run(dir, "push", "-q", "-u", "origin", "main");
		expect(await scanCommand("git push", dir, redactSecretPatterns)).toBeUndefined();
		fs.writeFileSync(path.join(dir, "k.ts"), `export const k = "${TOKEN}";\n`);
		run(dir, "add", "k.ts");
		run(dir, "commit", "-q", "-m", "k");
		expect((await scanCommand("git push", dir, redactSecretPatterns))?.leaks).toEqual([{ file: "k.ts", line: 1 }]);
	});

	test("PI_SECRET_SCAN_OFF=1 turns it off", async () => {
		const dir = repo("off");
		fs.writeFileSync(path.join(dir, "cfg.ts"), `export const token = "${TOKEN}";\n`);
		run(dir, "add", "cfg.ts");
		process.env.PI_SECRET_SCAN_OFF = "1";
		try {
			expect(await scanCommand('git commit -m "x"', dir, redactSecretPatterns)).toBeUndefined();
		} finally {
			delete process.env.PI_SECRET_SCAN_OFF;
		}
	});
});

describe("through the bash tool", () => {
	test("the commit does not run", async () => {
		const dir = repo("tool");
		fs.writeFileSync(path.join(dir, "cfg.ts"), `export const token = "${TOKEN}";\n`);
		run(dir, "add", "cfg.ts");
		const tool = createBashTool() as any;
		const ctx = { cwd: dir, sessionManager: { getSessionId: () => "commit-guard-test" } };
		const result = await tool.execute("t", { cmd: 'git commit -m "add cfg"', timeout: 30 }, undefined, undefined, ctx);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("secret scan");
		expect(spawnSync("git", ["rev-list", "--count", "HEAD"], { cwd: dir, encoding: "utf-8" }).stdout.trim()).toBe("1");
	});
});
