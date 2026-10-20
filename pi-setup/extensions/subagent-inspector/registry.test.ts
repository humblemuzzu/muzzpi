import { describe, expect, it } from "bun:test";
import type { RunSnapshot } from "../tools/lib/agent-channel";
import { zeroUsage } from "../tools/lib/pi-spawn";
import { AgentRegistry, MAX_ENTRIES } from "./registry";

function run(id: string, overrides: Partial<RunSnapshot> = {}): RunSnapshot {
	return {
		id,
		agent: "chad",
		label: `label ${id}`,
		status: "running",
		background: true,
		queuedAt: 1_000,
		startedAt: 2_000,
		usage: zeroUsage(),
		toolCount: 0,
		files: [],
		messages: [],
		...overrides,
	};
}

describe("AgentRegistry", () => {
	it("lists every broadcast run with the inspector's three statuses", () => {
		const registry = new AgentRegistry();
		registry.sync([
			run("a", { status: "queued", startedAt: undefined }),
			run("b"),
			run("c", { status: "done", endedAt: 5_000 }),
			run("d", { status: "failed" }),
			run("e", { status: "interrupted" }),
		]);
		expect(registry.list().map((e) => e.status)).toEqual(["running", "running", "done", "error", "error"]);
		expect(registry.list()[0]).toMatchObject({ toolName: "chad", label: "label a", startedAt: 1_000 });
		expect(registry.list()[2]!.endedAt).toBe(5_000);
	});

	it("keys a continued conversation's runs apart", () => {
		const registry = new AgentRegistry();
		registry.sync([run("a", { status: "done" }), run("a", { startedAt: 9_000 })]);
		const keys = registry.list().map((e) => e.toolCallId);
		expect(new Set(keys).size).toBe(2);
	});

	it("keeps the newest runs and tells the open view", () => {
		const registry = new AgentRegistry();
		let changes = 0;
		registry.onChange = () => changes++;
		registry.sync(Array.from({ length: MAX_ENTRIES + 5 }, (_, i) => run(`r${i}`)));
		expect(registry.list()).toHaveLength(MAX_ENTRIES);
		expect(registry.list()[0]!.label).toBe("label r5");
		expect(changes).toBe(1);
	});
});
