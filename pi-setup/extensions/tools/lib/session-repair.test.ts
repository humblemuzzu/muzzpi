import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { savedSessionModel, subAgentSessionFile, INTERRUPTED_RESULT, repairInterrupted } from "./session-repair";

let dir: string;

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "session-repair-"));
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
const assistant = (content: unknown[], stopReason = "toolUse") => ({
	role: "assistant",
	content,
	api: "openai-completions",
	provider: "deepseek",
	model: "deepseek-flash",
	usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	stopReason,
	timestamp: Date.now(),
});
const call = (id: string) => ({ type: "toolCall", id, name: "bash", arguments: { cmd: "sleep 60" } });
const result = (id: string) => ({ role: "toolResult", toolCallId: id, toolName: "bash", content: [{ type: "text", text: "ok" }], isError: false, timestamp: Date.now() });

function session(id: string, messages: unknown[]): string {
	const manager = SessionManager.create(dir, dir, { id });
	for (const message of messages) manager.appendMessage(message as any);
	return manager.getSessionFile()!;
}

function messagesOf(file: string): any[] {
	return SessionManager.open(file).buildSessionContext().messages as any[];
}

describe("repairInterrupted", () => {
	test("answers every call the last assistant message left open, and only those", () => {
		const file = session("chad-open", [user("go"), assistant([call("a"), call("b"), call("c")]), result("a")]);
		expect(repairInterrupted(file)).toBe(2);
		const tail = messagesOf(file).slice(-3);
		expect(tail.map((m) => m.toolCallId)).toEqual(["a", "b", "c"]);
		expect(tail.slice(1).every((m) => m.isError && m.content[0].text === INTERRUPTED_RESULT)).toBe(true);
	});

	test("is idempotent", () => {
		const file = session("chad-twice", [user("go"), assistant([call("x")])]);
		expect(repairInterrupted(file)).toBe(1);
		expect(repairInterrupted(file)).toBe(0);
	});

	test("leaves a finished conversation alone", () => {
		const file = session("chad-done", [user("go"), assistant([call("x")]), result("x"), assistant([{ type: "text", text: "done" }], "stop")]);
		expect(repairInterrupted(file)).toBe(0);
	});

	test("never puts a result after a later user message", () => {
		const file = session("chad-later", [user("go"), assistant([call("x")]), user("steer")]);
		expect(repairInterrupted(file)).toBe(0);
	});
});

describe("subAgentSessionFile", () => {
	test("finds a saved session by id, and nothing for an unknown one", () => {
		const file = session("delegate-find-1", [user("go"), assistant([{ type: "text", text: "hi" }], "stop")]);
		expect(subAgentSessionFile(dir, "delegate-find-1")).toBe(file);
		expect(subAgentSessionFile(dir, "delegate-find")).toBeUndefined();
		expect(subAgentSessionFile(join(dir, "missing"), "x")).toBeUndefined();
	});
});

describe("savedSessionModel", () => {
	test("is what the branch last ran on or switched to, and nothing for a conversation never saved", () => {
		const manager = SessionManager.create(dir, dir, { id: "oracle-model" });
		manager.appendModelChange("openai-codex", "gpt-6-astra");
		manager.appendMessage(user("go") as any);
		manager.appendMessage(assistant([{ type: "text", text: "hi" }], "stop") as any);
		expect(savedSessionModel(dir, "oracle-model")).toBe("deepseek/deepseek-flash");
		manager.appendModelChange("anthropic", "claude-opus-5-5");
		expect(savedSessionModel(dir, "oracle-model")).toBe("anthropic/claude-opus-5-5");
		expect(savedSessionModel(dir, "oracle-never")).toBeUndefined();
	});
});
