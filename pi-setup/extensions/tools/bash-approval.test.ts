import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createBashTool } from "./bash";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bash-approval-"));
const rulesFile = path.join(dir, "permissions.json");
const logFile = path.join(dir, "approvals.jsonl");
fs.writeFileSync(
	rulesFile,
	JSON.stringify([
		{ tool: "Bash", matches: { cmd: "*forbidden-here*", where: "local" }, action: "reject", message: "no" },
		{ tool: "Bash", matches: { cmd: "*ask-me*" }, action: "ask", message: "destroys the test marker" },
		{ tool: "*", action: "allow" },
	]),
);
process.env.PI_PERMISSIONS_FILE = rulesFile;
process.env.PI_APPROVALS_LOG = logFile;
afterAll(() => {
	delete process.env.PI_PERMISSIONS_FILE;
	delete process.env.PI_APPROVALS_LOG;
});

const tool = createBashTool() as any;
const marker = path.join(dir, "ask-me");
const prompts: { title: string; message: string }[] = [];

function ctx(answer?: boolean | Error) {
	const base = { cwd: dir, sessionManager: { getSessionId: () => "approval-test" } };
	if (answer === undefined) return { ...base, hasUI: false };
	return {
		...base,
		hasUI: true,
		ui: {
			confirm: async (title: string, message: string) => {
				prompts.push({ title, message });
				if (answer instanceof Error) throw answer;
				return answer;
			},
		},
	};
}

const run = (cmd: string, context: object) => tool.execute("t", { cmd, timeout: 10 }, undefined, undefined, context);
const text = (result: any) => result.content.map((c: any) => c.text).join("");
const lastLog = () => JSON.parse(fs.readFileSync(logFile, "utf8").trim().split("\n").at(-1)!);

beforeEach(() => {
	prompts.length = 0;
	fs.rmSync(marker, { force: true });
});

describe("bash asks before a command that needs approval", () => {
	test("without a UI it refuses, runs nothing, and hands the command back", async () => {
		const result = await run(`touch ${marker}`, ctx());
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("this needs the user's approval (destroys the test marker)");
		expect(text(result)).toEndWith(`touch ${marker}`);
		expect(fs.existsSync(marker)).toBe(false);
		expect(lastLog()).toMatchObject({ decision: "no-ui", command: `touch ${marker}`, session: "approval-test", hosts: [] });
	});

	test("approved, it runs", async () => {
		const result = await run(`touch ${marker} && echo made`, ctx(true));
		expect(result.isError).toBeFalsy();
		expect(text(result)).toContain("made");
		expect(fs.existsSync(marker)).toBe(true);
		expect(prompts).toHaveLength(1);
		expect(prompts[0]!.message).toContain("- destroys the test marker");
		expect(prompts[0]!.message).toContain(`Runs on this machine:\ntouch ${marker} && echo made`);
		expect(lastLog().decision).toBe("approved");
	});

	test("denied, or a dialog that fails, runs nothing", async () => {
		for (const answer of [false, new Error("dialog closed")]) {
			const result = await run(`touch ${marker}`, ctx(answer));
			expect(result.isError).toBe(true);
			expect(text(result)).toContain("the user denied this command");
			expect(fs.existsSync(marker)).toBe(false);
			expect(lastLog().decision).toBe("denied");
		}
	});

	test("the dialog names the server a remote part runs on", async () => {
		await run("ssh -o ConnectTimeout=1 approval-test-host 'touch /tmp/ask-me'", ctx(false));
		expect(prompts[0]!.message).toContain("Runs on approval-test-host:");
		expect(lastLog().hosts).toEqual(["approval-test-host"]);
	});

	test("a rejected part wins over an ask: no dialog at all", async () => {
		const result = await run(`touch ${marker}; echo forbidden-here`, ctx(true));
		expect(text(result)).toBe("command rejected: no");
		expect(prompts).toHaveLength(0);
		expect(fs.existsSync(marker)).toBe(false);
	});
});

describe("approval log", () => {
	test("a secret in the command is scrubbed before it is written, and only the owner can read the log", async () => {
		const password = "Xk29fLp0qZ7m";
		await run(`echo postgres://app:${password}@db.internal/app > /dev/null; touch ${marker}`, ctx(false));
		const text = fs.readFileSync(logFile, "utf8");
		expect(text).not.toContain(password);
		expect(lastLog().command).toContain("postgres://app:[REDACTED]@db.internal/app");
		expect(fs.statSync(logFile).mode & 0o777).toBe(0o600);
	});

	test("an unwritable log does not change the answer", async () => {
		process.env.PI_APPROVALS_LOG = path.join(rulesFile, "cannot", "be", "a", "dir.jsonl");
		try {
			const result = await run(`touch ${marker}`, ctx(true));
			expect(result.isError).toBeFalsy();
			expect(fs.existsSync(marker)).toBe(true);
		} finally {
			process.env.PI_APPROVALS_LOG = logFile;
		}
	});
});
