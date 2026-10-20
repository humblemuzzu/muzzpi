import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createBashTool } from "./bash";
import { SUB_AGENT_TOOLS_ENV } from "./lib/sub-agent-prompt";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bash-approval-"));
const rulesFile = path.join(dir, "permissions.json");
const logFile = path.join(dir, "approvals.jsonl");
const approvalsOn = path.join(dir, "ext-config-on.json");
const approvalsDefault = path.join(dir, "ext-config-absent.json");
fs.writeFileSync(approvalsOn, JSON.stringify({ approvals: { enabled: true } }));
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
process.env.PI_EXT_CONFIG_PATH = approvalsOn;
const childTools = process.env[SUB_AGENT_TOOLS_ENV];
delete process.env[SUB_AGENT_TOOLS_ENV];
afterAll(() => {
	if (childTools !== undefined) process.env[SUB_AGENT_TOOLS_ENV] = childTools;
	delete process.env.PI_PERMISSIONS_FILE;
	delete process.env.PI_APPROVALS_LOG;
	delete process.env.PI_EXT_CONFIG_PATH;
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

describe("approvals off (the default)", () => {
	test("an ask rule runs without a dialog, even with no UI, and is logged as auto", async () => {
		process.env.PI_EXT_CONFIG_PATH = approvalsDefault;
		try {
			for (const context of [ctx(), ctx(false)]) {
				fs.rmSync(marker, { force: true });
				const result = await run(`touch ${marker}`, context);
				expect(result.isError).toBeFalsy();
				expect(fs.existsSync(marker)).toBe(true);
				expect(lastLog()).toMatchObject({ decision: "auto", command: `touch ${marker}` });
			}
			expect(prompts).toHaveLength(0);
		} finally {
			process.env.PI_EXT_CONFIG_PATH = approvalsOn;
		}
	});

	test("a reject rule still refuses", async () => {
		process.env.PI_EXT_CONFIG_PATH = approvalsDefault;
		try {
			expect(text(await run("echo forbidden-here", ctx()))).toBe("command rejected: no");
		} finally {
			process.env.PI_EXT_CONFIG_PATH = approvalsOn;
		}
	});
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

	test("inside a sub-agent nobody is asked, though its RPC mode has a UI", async () => {
		process.env[SUB_AGENT_TOOLS_ENV] = "bash";
		try {
			const result = await run(`touch ${marker}`, ctx(true));
			expect(text(result)).toContain("this needs the user's approval");
			expect(prompts).toHaveLength(0);
			expect(fs.existsSync(marker)).toBe(false);
		} finally {
			delete process.env[SUB_AGENT_TOOLS_ENV];
		}
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

function picker(keys: string[]) {
	const theme = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s };
	return {
		cwd: dir,
		sessionManager: { getSessionId: () => "approval-test" },
		hasUI: true,
		mode: "tui",
		ui: {
			custom: (factory: any) =>
				new Promise((resolve) => {
					const dialog = factory({ requestRender() {} }, theme, {}, resolve);
					dialog.focused = true;
					prompts.push({ title: "picker", message: dialog.render(200).join("\n") });
					for (const key of keys) dialog.handleInput(key);
				}),
		},
	};
}

describe("the approval picker", () => {
	test("it shows the reasons and the command, and Allow runs it", async () => {
		const result = await run(`touch ${marker}`, picker(["\x1b[A", "\r"]));
		expect(result.isError).toBeFalsy();
		expect(fs.existsSync(marker)).toBe(true);
		expect(prompts[0]!.message).toContain("- destroys the test marker");
		expect(prompts[0]!.message).toContain(`touch ${marker}`);
	});

	test("the cursor starts on Deny, so a stray Enter cannot approve", async () => {
		const result = await run(`touch ${marker}`, picker(["\r"]));
		expect(result.isError).toBe(true);
		expect(fs.existsSync(marker)).toBe(false);
	});

	test("a reason that starts with a digit is text, never a shortcut to Allow", async () => {
		const result = await run(`touch ${marker}`, picker([..."1st move it to trash", "\r"]));
		expect(fs.existsSync(marker)).toBe(false);
		expect(text(result)).toContain("said what to do instead:\n1st move it to trash\n");
	});

	test("Deny and Esc stop the turn", async () => {
		for (const keys of [["\r"], ["\x1b"]]) {
			const result = await run(`touch ${marker}`, picker(keys));
			expect(text(result)).toContain("Stop and wait for the user's next message");
			expect(result.terminate).toBe(true);
			expect(lastLog().decision).toBe("denied");
		}
	});

	test("typing instead denies, hands the words to the agent, lets it continue, and logs them", async () => {
		const result = await run(`touch ${marker}`, picker([..."move it to trash instead", "\r"]));
		expect(fs.existsSync(marker)).toBe(false);
		expect(result.isError).toBe(true);
		expect(result.terminate).toBe(false);
		expect(text(result)).toBe(
			"not run: the user denied this command and said what to do instead:\nmove it to trash instead\nDo that. Do not retry the denied command.",
		);
		expect(lastLog()).toMatchObject({ decision: "denied", feedback: "move it to trash instead" });
	});

	test("a secret typed into the reason is scrubbed in the log", async () => {
		const fakePassword = "tr0ub4dor-fake-pw";
		await run(`touch ${marker}`, picker([...`use postgres://app:${fakePassword}@db/app`, "\r"]));
		expect(fs.readFileSync(logFile, "utf8")).not.toContain(fakePassword);
		expect(lastLog().feedback).toContain("postgres://app:");
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
