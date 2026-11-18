import { describe, expect, test } from "bun:test";
import type { RunSnapshot } from "./agent-channel";
import type { RunReport } from "./agent-notice";
import type { JobReport } from "./bash-jobs";
import { agentActivity, broskiTasks, jobActivity } from "./broski";
import { zeroUsage } from "./pi-spawn";

const snapshot = (over: Partial<RunSnapshot>): RunSnapshot => ({
	id: "chad-1",
	agent: "chad",
	label: "find the bug",
	status: "running",
	queuedAt: 1_000,
	startedAt: 2_000,
	usage: zeroUsage(),
	toolCount: 0,
	files: [],
	messages: [],
	stopping: false,
	...over,
});

const report = (over: Partial<RunReport>): RunReport => ({
	agent: "chad",
	label: "find the bug",
	continueId: "chad-1",
	status: "done",
	durationMs: 61_500,
	toolCount: 3,
	files: [],
	usage: zeroUsage(),
	messages: [{ role: "assistant", content: [{ type: "text", text: "It is in src/a.ts:12." }] } as any],
	...over,
});

describe("broski:tasks", () => {
	test("lists only what still runs: agents by name and label, jobs by command", () => {
		const tasks = broskiTasks([
			snapshot({}),
			snapshot({ id: "oracle-2", agent: "oracle", label: "is this right?", status: "queued", startedAt: undefined }),
			snapshot({ id: "chad-3", status: "done" }),
			snapshot({ id: "bash-1a2b", agent: "bash", label: "bun test", command: "bun test\n--bail" }),
		]);
		expect(tasks).toEqual([
			{ id: "chad-1", kind: "agent", title: "chad: find the bug", startedAt: 2_000 },
			{ id: "oracle-2", kind: "agent", title: "oracle: is this right?", startedAt: 1_000 },
			{ id: "bash-1a2b", kind: "task", title: "bun test", command: "bun test\n--bail", startedAt: 2_000 },
		]);
	});

	test("a title is one line within Broski's bound, since Broski drops a task that does not fit", () => {
		const [task] = broskiTasks([snapshot({ label: `line one\nline two ${"x".repeat(5_000)}` })]);
		expect(task!.title.length).toBe(1_024);
		expect(task!.title).toStartWith("chad: line one line two x");
	});
});

describe("details.broski", () => {
	test("one finished agent is a row of its own, its report the body", () => {
		expect(agentActivity([report({})])).toMatchObject({
			kind: "agent",
			title: "chad: find the bug",
			status: "completed",
			durationMs: 61_500,
			body: { format: "markdown" },
		});
		expect(agentActivity([report({})])!.body!.text).toContain("It is in src/a.ts:12.");
	});

	test("a batch is one row, failed when any of it failed", () => {
		const activity = agentActivity([report({}), report({ agent: "oracle", continueId: "oracle-2", status: "failed" })]);
		expect(activity).toMatchObject({ kind: "agent", title: "2 agents reported back: chad, oracle", status: "failed" });
	});

	test("a job's end carries its command and exit code; a wake_on line says it still runs", () => {
		const ended: JobReport = { id: "bash-1a2b", command: "bun test", status: "failed", kind: "finished", durationMs: 4_000, exitCode: 1, text: "Background job bash-1a2b failed after 4s.\n\n$ bun test\n\n1 fail" };
		expect(jobActivity([ended])).toMatchObject({ kind: "task", title: "Background job bash-1a2b failed after 4s.", status: "failed", command: "bun test", exitCode: 1, body: { format: "log" } });
		expect(jobActivity([{ ...ended, kind: "matched", status: "running", exitCode: undefined }])).toMatchObject({ status: "running" });
	});
});
