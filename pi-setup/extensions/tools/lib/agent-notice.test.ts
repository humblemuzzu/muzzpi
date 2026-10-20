import { describe, expect, test } from "bun:test";
import { backgroundStub, MAX_ANSWER_CHARS, notificationText, type RunReport } from "./agent-notice";
import { zeroUsage } from "./pi-spawn";

const report = (overrides: Partial<RunReport> = {}): RunReport => ({
	agent: "chad",
	label: "session naming",
	continueId: "chad-1",
	status: "done",
	durationMs: 61_000,
	toolCount: 3,
	files: [],
	model: "deepseek/deepseek-flash",
	thinkingLevel: "high",
	usage: { ...zeroUsage(), output: 10, cost: 0.01, turns: 2 },
	messages: [{ role: "assistant", content: [{ type: "text", text: "the answer" }] } as any],
	...overrides,
});

describe("the agent-result notification", () => {
	test("opens with the frame that it is not the user, then one block per run", () => {
		const text = notificationText([report(), report({ agent: "delegate", continueId: "delegate-2", files: ["src/a.ts"] })]);
		expect(text).toStartWith("[Automated agent event. This was not written by the user");
		expect(text).toContain("2 background sub-agents finished.");
		expect(text).toContain("## chad: session naming\ncontinueId: chad-1 · status: done · took 1m01s · 3 tool calls");
		expect(text).toContain("model: deepseek/deepseek-flash · high");
		expect(text).toContain("files changed: src/a.ts");
		expect(text.match(/the answer/g)).toHaveLength(2);
	});

	test("a failed run says why, then what it said last", () => {
		const text = notificationText([report({ status: "failed", errorMessage: "provider exploded" })]);
		expect(text).toContain("status: failed");
		expect(text).toContain("provider exploded\n\nIts last message before that:\nthe answer");
	});

	test("a very long answer is cut, with the way to read the rest", () => {
		const long = "x".repeat(MAX_ANSWER_CHARS + 500);
		const text = notificationText([report({ messages: [{ role: "assistant", content: [{ type: "text", text: long }] } as any] })]);
		expect(text.length).toBeLessThan(MAX_ANSWER_CHARS + 1_000);
		expect(text).toContain(`read the rest with read_session on session_id chad-1`);
	});
});

describe("the launch stub", () => {
	test("says what to do meanwhile and how to reach the agent", () => {
		const text = backgroundStub("oracle", "oracle-9", 0);
		expect(text).toContain("oracle is running in the background (continueId: oracle-9)");
		expect(text).toMatch(/do not guess, predict or report its result/);
		expect(text).toMatch(/Do not poll, sleep or redo its work/);
		expect(text).toContain("call oracle again with this continueId");
	});

	test("a queued agent says it waits for a slot", () => {
		expect(backgroundStub("chad", "chad-1", 16)).toContain("is queued behind 16 running agents");
	});
});
