import { describe, expect, test } from "bun:test";
import { A, dayKey, T, U } from "../record";
import { env, iso, MIN, readLines, T0 } from "../test-helpers";
import { piSpec } from "./pi";

const DAY = dayKey(T0);
let seq = 0;
const entry = (type: string, ms: number, fields: Record<string, unknown>) => JSON.stringify({ type, id: String(++seq), parentId: null, timestamp: iso(ms), ...fields });
const header = (id: string, ms: number, parentSession?: string) => JSON.stringify({ type: "session", version: 3, id, timestamp: iso(ms), cwd: "/work/app", ...(parentSession ? { parentSession } : {}) });
const user = (ms: number, text: string) => entry("message", ms, { message: { role: "user", content: [{ type: "text", text }] } });
const assistant = (ms: number, u: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
	entry("message", ms, { message: { role: "assistant", provider: "anthropic", model: "claude-opus-5", usage: u, content: [], ...extra } });
const toolResult = (ms: number, toolName: string, extra: Record<string, unknown> = {}) => entry("message", ms, { message: { role: "toolResult", toolName, ...extra } });

const spec = piSpec("/sessions");

describe("a pi session", () => {
	const rec = readLines(spec, "/sessions/a.jsonl", [
		header("s1", T0),
		entry("thinking_level_change", T0, { thinkingLevel: "high" }),
		user(T0 + 1000, "fix the login bug\nplease"),
		assistant(T0 + 2000, { input: 10, output: 100, cacheRead: 30_000, cacheWrite: 0, cost: { input: 0.1, output: 0.5, cacheRead: 0.9, cacheWrite: 0, total: 1.5 } }, {
			content: [
				{ type: "toolCall", name: "bash", arguments: { cmd: "cd x && bun test --watch" } },
				{ type: "toolCall", name: "edit", arguments: { path: "src/a.ts" } },
				{ type: "toolCall", name: "chad" },
				{ type: "toolCall", name: "finder" },
			],
			durationMs: 2000,
		}),
		toolResult(T0 + 3000, "bash", { isError: true, durationMs: 1500 }),
		toolResult(T0 + 4000, "chad", { durationMs: 9000, details: { agent: "chad", model: "deepseek/deepseek-flash", usage: { cost: 0.2, input: 5, output: 7, turns: 3 }, messages: [{ role: "toolResult", toolName: "Read" }] } }),
		entry("session_info", T0 + 5000, { name: "login fix" }),
		entry("custom", T0 + 5000, { customType: "pi-codex-goal", data: { goal: { goalId: "g1", status: "complete", usage: { activeSeconds: 90 } } } }),
	]);

	test("main turns keep pi's recorded cost, keyed by model and thinking level", () => {
		const u = rec.usage[`${DAY}\tanthropic/claude-opus-5\thigh`];
		expect(u[U.turns]).toBe(1);
		expect(u[U.cost]).toBe(1.5);
		expect(u[U.estimated]).toBe(0);
	});

	test("sub-agent spend comes from the tool result, its tool calls count as agent tools", () => {
		expect(rec.agents[`${DAY}\tchad\tdeepseek-flash`].slice(0, 4)).toEqual([1, 0.2, 5, 7]);
		expect(rec.tools[`${DAY}\tagent\t\tread`][T.calls]).toBe(1);
	});

	test("tools, commands, edits, fan-out, prompts, names and goals", () => {
		expect(rec.tools[`${DAY}\tmain\tanthropic\tbash`].slice(0, 3)).toEqual([1, 1, 1500]);
		expect(rec.bash[`${DAY}\tanthropic\tbun test`]).toBe(1);
		expect(rec.edits[`${DAY}\tanthropic\t/work/app/src/a.ts`]).toBe(1);
		expect(rec.fanout[`${DAY}\tanthropic\t2`]).toBe(1);
		expect(rec.prompts[DAY]).toEqual([1, "fix the login bug\nplease".length]);
		expect(rec.title).toBe("fix the login bug");
		expect(rec.name).toBe("login fix");
		expect(rec.goals.g1.slice(0, 2)).toEqual(["complete", 90]);
		expect(rec.key).toBe("pi:s1");
	});
});

test("a turn pi recorded at $0 is priced from the catalog and marked estimated", () => {
	const rec = readLines(spec, "/s/b.jsonl", [header("s2", T0), assistant(T0, { input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } })]);
	const u = rec.usage[`${DAY}\tanthropic/claude-opus-5\tunknown`];
	expect(u[U.cost]).toBe(5);
	expect(u[U.estimated]).toBe(5);
});

test("an [opencode] import records the identity OpenCode gives the same turn", () => {
	const rec = readLines(spec, "/s/c.jsonl", [
		header("s3", T0),
		entry("session_info", T0, { name: "[opencode] Background: find it" }),
		assistant(T0 + 5000, { input: 11, output: 42, cacheRead: 896, cacheWrite: 0, cost: { total: 0 } }),
	]);
	expect(rec.importOf).toBe("opencode");
	expect(Object.keys(rec.dedup)).toEqual([`${T0 + 5000}:11:42:896:0`]);
});

test("a fork skips its parent's copied entries only while the parent is on disk", () => {
	const lines = [header("f", T0 + 10 * MIN, "/s/parent.jsonl"), assistant(T0, { output: 1, cost: { total: 1 } }), assistant(T0 + 11 * MIN, { output: 1, cost: { total: 2 } })];
	const cost = (exists: boolean) => readLines(spec, "/s/f.jsonl", lines, env(new Map(), () => exists)).usage[`${DAY}\tanthropic/claude-opus-5\tunknown`][U.cost];
	expect(cost(true)).toBe(2);
	expect(cost(false)).toBe(3);
});

test("agent runs from tool results keep their failure", () => {
	const rec = readLines(spec, "/s/d.jsonl", [header("s4", T0), toolResult(T0, "delegate", { isError: true, details: { exitCode: 1, usage: { cost: 1 } } })]);
	expect(rec.agents[`${DAY}\tdelegate\tunknown`][A.failures]).toBe(1);
});

describe("background agent runs", () => {
	const run = (agent: string, status: string, cost: number) => ({
		agent,
		label: "x",
		continueId: `${agent}-1`,
		status,
		durationMs: 4000,
		toolCount: 1,
		files: [],
		model: "deepseek/deepseek-flash",
		usage: { input: 5, output: 7, cacheRead: 0, cacheWrite: 0, cost, contextTokens: 0, turns: 2 },
		messages: [{ role: "toolResult", toolName: "grep" }],
	});
	const rec = readLines(spec, "/s/bg.jsonl", [
		header("s5", T0),
		toolResult(T0, "chad", { details: { agent: "chad", task: "x", continueId: "chad-1", background: true } }),
		entry("custom_message", T0 + 1000, { customType: "agent-result", content: "…", display: true, details: { runs: [run("chad", "done", 0.25), run("oracle", "failed", 0.5)] } }),
		toolResult(T0 + 2000, "agents", { details: { runs: [run("finder", "done", 0.1)] } }),
		entry("custom_message", T0 + 3000, { customType: "something-else", details: { runs: [run("chad", "done", 9)] } }),
	]);

	test("the stub counts as a call, not a run", () => {
		const key = Object.keys(rec.tools).find((k) => k.startsWith(`${DAY}\tmain\t`) && k.endsWith("\tchad"))!;
		expect(rec.tools[key][T.calls]).toBe(1);
		expect(Object.values(rec.agents).reduce((n, row) => n + row[A.runs], 0)).toBe(3);
	});

	test("each run in an agent-result message or an agents wait counts once, with its spend and failure", () => {
		expect(rec.agents[`${DAY}\tchad\tdeepseek-flash`].slice(0, 2)).toEqual([1, 0.25]);
		expect(rec.agents[`${DAY}\toracle\tdeepseek-flash`][A.failures]).toBe(1);
		expect(rec.agents[`${DAY}\tfinder\tdeepseek-flash`][A.runs]).toBe(1);
		expect(rec.agents[`${DAY}\tchad\tdeepseek-flash`][A.durationMs]).toBe(4000);
		expect(rec.tools[`${DAY}\tagent\t\tgrep`][T.calls]).toBe(3);
	});
});
