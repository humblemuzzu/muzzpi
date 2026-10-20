import { describe, expect, test } from "bun:test";
import { theme } from "../tools/lib/test-theme";
import { activityLabel, createActivityState, describeToolCall, endActivity, formatGlanceElapsed, runDetail, startActivity } from "./activity";

const strip = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "");
const T0 = 1_700_000_000_000;

describe("activity label", () => {
	test("idle shows nothing", () => {
		expect(activityLabel(createActivityState(), T0, theme)).toBe("");
	});

	test("a run shows what it is doing and for how long, without seconds past the first minute", () => {
		const state = createActivityState();
		startActivity(state, T0);
		expect(strip(activityLabel(state, T0 + 500, theme))).toBe("· thinking");
		state.phase = "streaming";
		expect(strip(activityLabel(state, T0 + 12_000, theme))).toBe("· writing · 12s");
		state.phase = "tool";
		state.activeTools.set("a", "read(index.ts)");
		state.activeTools.set("b", "grep(Dock)");
		state.activeTools.set("c", "bash(git status)");
		expect(strip(activityLabel(state, T0 + 94 * 60_000 + 26_000, theme))).toBe("· read(index.ts), grep(Dock) +1 · 1h 34m");
	});

	test("the glance clock", () => {
		expect(formatGlanceElapsed(59_999)).toBe("59s");
		expect(formatGlanceElapsed(4 * 60_000 + 59_000)).toBe("4m");
		expect(formatGlanceElapsed(60 * 60_000)).toBe("1h 0m");
	});

	test("the detail view keeps the last run's figures once idle", () => {
		const state = createActivityState();
		expect(runDetail(state, T0)).toBe("");
		startActivity(state, T0);
		state.turnIndex = 68;
		expect(runDetail(state, T0 + 94 * 60_000 + 26_000)).toBe("turn 69 · 94m26s");
		endActivity(state, T0 + 94 * 60_000 + 26_000);
		expect(runDetail(state, T0 + 999_999)).toBe("last run 69 turns · 94m26s");
	});
});

describe("describeToolCall", () => {
	test("a multiline script shows its first line only", () => {
		expect(describeToolCall("bash", { cmd: "git status\nrm -rf /" })).toBe("bash(git status)");
	});

	test("a bare path shows its basename, a long hint is capped", () => {
		expect(describeToolCall("read", { path: "/a/b/index.ts" })).toBe("read(index.ts)");
		expect(describeToolCall("grep", { pattern: "x".repeat(40) })).toBe(`grep(${"x".repeat(24)}…)`);
		expect(describeToolCall("todo", {})).toBe("todo");
	});
});
