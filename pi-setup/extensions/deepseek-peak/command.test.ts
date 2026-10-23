import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import deepseekPeakExtension from "./index";

const startDir = process.env.PI_CODING_AGENT_DIR;
const agentDir = mkdtempSync(join(tmpdir(), "deepseek-prefs-"));
beforeAll(() => (process.env.PI_CODING_AGENT_DIR = agentDir));
afterAll(() => {
	if (startDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = startDir;
});

function load() {
	let command: any;
	const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
	const labels: string[] = [];
	const notes: [string, string | undefined][] = [];
	deepseekPeakExtension({
		events: { emit: (channel: string, data: { key: string }) => labels.push(`${channel}:${data.key}`), on: () => () => {} },
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		registerCommand: (_name: string, options: unknown) => (command = options),
	} as any);
	const ctx = {
		hasUI: true,
		model: { provider: "anthropic", id: "claude" },
		ui: { theme: { fg: (_c: string, s: string) => s }, notify: (text: string, level?: string) => notes.push([text, level]) },
	};
	const fire = async (event: string) => {
		for (const handler of handlers.get(event) ?? []) await handler({}, ctx);
	};
	return { run: (args: string) => command.handler(args, ctx), complete: command.getArgumentCompletions, fire, labels, notes };
}

describe("/deepseek", () => {
	test("off is remembered: the next session paints nothing", async () => {
		const first = load();
		await first.run("OFF");
		expect(first.notes.at(-1)![0]).toBe("Clock and DeepSeek label hidden, also in future sessions. /deepseek on shows them.");
		expect(JSON.parse(readFileSync(join(agentDir, "cache", "deepseek-peak.json"), "utf8"))).toEqual({ hidden: true });
		await first.fire("session_shutdown");

		const next = load();
		await next.fire("session_start");
		expect(next.labels).toEqual([]);
		await next.run("show");
		expect(next.labels).toContain("editor:set-label:clock");
		await next.fire("session_shutdown");
		expect(JSON.parse(readFileSync(join(agentDir, "cache", "deepseek-peak.json"), "utf8"))).toEqual({ hidden: false });
	});

	test("a typo is an error, not the report", async () => {
		const ds = load();
		await ds.run("of");
		expect(ds.notes).toEqual([['/deepseek has no "of". Use /deepseek off, /deepseek on, or /deepseek on its own for the price clock.', "error"]]);
		await ds.run("");
		expect(ds.notes.at(-1)![0]).toStartWith("DeepSeek pricing clock");
	});

	test("suggestions", () => {
		expect(load().complete("o").map((i: any) => i.value)).toEqual(["off", "on"]);
	});
});
