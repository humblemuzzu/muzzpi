import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { A, dayKey, T, U } from "../record";
import { env, iso, MIN, PRICES, readLines, T0 } from "../test-helpers";
import { claudeArchive, claudeSpec } from "./claude";

const DAY = dayKey(T0);
const MODEL = "anthropic/claude-opus-5";
const spec = claudeSpec("/claude");

const base = (type: string, ms: number, extra: Record<string, unknown>) => JSON.stringify({ type, timestamp: iso(ms), sessionId: "sess", cwd: "/work/app", uuid: `u-${ms}-${type}`, ...extra });
const reply = (ms: number, id: string, usage: Record<string, unknown>, content: unknown[] = [], extra: Record<string, unknown> = {}) =>
	base("assistant", ms, { requestId: `req-${id}`, effort: "high", message: { id, model: "claude-opus-5-20261001", role: "assistant", usage, content }, ...extra });
const prompt = (ms: number, text: string, extra: Record<string, unknown> = {}) => base("user", ms, { message: { role: "user", content: text }, ...extra });
const result = (ms: number, id: string, isError = false) => base("user", ms, { message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: isError }] } });

describe("a Claude Code transcript", () => {
	const rec = readLines(spec, "/claude/projects/-work-app/sess.jsonl", [
		prompt(T0, "fix the login bug"),
		prompt(T0 + 1, "<command-name>/clear</command-name>"),
		prompt(T0 + 2, "Caveat: The messages below were generated", { isMeta: true }),
		reply(T0 + 1000, "m1", { input_tokens: 4, output_tokens: 10, cache_read_input_tokens: 30_000, cache_creation_input_tokens: 2000 }, [{ type: "thinking" }]),
		reply(T0 + 1100, "m1", { input_tokens: 4, output_tokens: 480, cache_read_input_tokens: 30_000, cache_creation_input_tokens: 2000, output_tokens_details: { thinking_tokens: 143 } }, [
			{ type: "tool_use", id: "t1", name: "Bash", input: { command: "git status" } },
		]),
		reply(T0 + 1200, "m1", { input_tokens: 4, output_tokens: 480, cache_read_input_tokens: 30_000, cache_creation_input_tokens: 2000 }, [
			{ type: "tool_use", id: "t2", name: "Edit", input: { file_path: "/work/app/src/a.ts" } },
			{ type: "tool_use", id: "t3", name: "Agent", input: {} },
		]),
		result(T0 + 2000, "t1", true),
		result(T0 + 2100, "t2"),
		base("system", T0 + 3000, { subtype: "compact_boundary", compactMetadata: { preTokens: 579_634 } }),
		base("ai-title", T0 + 3000, { aiTitle: "Login fix" }),
	]);
	const u = rec.usage[`${DAY}\t${MODEL}\thigh`];

	test("copies of one streamed response count once, at the largest value per bucket", () => {
		expect(u[U.turns]).toBe(1);
		expect([u[U.input], u[U.output], u[U.cacheRead], u[U.cacheWrite], u[U.reasoning]]).toEqual([4, 480, 30_000, 2000, 143]);
	});

	test("Claude Code records no cost, so the catalog prices it, folding the dated model id", () => {
		const expected = (4 * 5 + 480 * 25 + 30_000 * 0.5 + 2000 * 6.25) / 1e6;
		expect(u[U.cost]).toBeCloseTo(expected, 12);
		expect(u[U.estimated]).toBeCloseTo(expected, 12);
	});

	test("tool results find their call by id; only real prompts count", () => {
		expect(rec.tools[`${DAY}\tmain\tanthropic\tbash`].slice(0, 2)).toEqual([1, 1]);
		expect(rec.tools[`${DAY}\tmain\tanthropic\tedit`][T.calls]).toBe(1);
		expect(rec.bash[`${DAY}\tanthropic\tgit status`]).toBe(1);
		expect(rec.edits[`${DAY}\tanthropic\t/work/app/src/a.ts`]).toBe(1);
		expect(rec.fanout).toEqual({ [`${DAY}\tanthropic\t1`]: 1 });
		expect(rec.prompts[DAY][0]).toBe(1);
		expect(rec.compactions.map((c) => c[1])).toEqual([579_634]);
		expect([rec.name, rec.title, rec.id, rec.cwd, rec.key]).toEqual(["Login fix", "fix the login bug", "sess", "/work/app", "claude:sess"]);
	});
});

test("a sub-agent transcript is an agent run of its parent session, named by its meta file", () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "claude-"));
	const file = path.join(dir, "projects", "-w", "sess", "subagents", "agent-a1.jsonl");
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file.replace(/\.jsonl$/, ".meta.json"), JSON.stringify({ agentType: "Explore" }));
	const rec = readLines(spec, file, [
		reply(T0, "a1", { input_tokens: 1, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, [{ type: "tool_use", id: "x", name: "Read", input: {} }], { isSidechain: true }),
		result(T0 + 1, "x"),
		reply(T0 + 2, "a2", { input_tokens: 1, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, [], { isSidechain: true }),
	]);
	expect([rec.role, rec.id, rec.agentName, rec.key]).toEqual(["agent", "sess", "Explore", "claude:agent:agent-a1"]);
	expect(Object.keys(rec.usage)).toEqual([]);
	const a = rec.agents[`${DAY}\tExplore\tclaude-opus-5`];
	expect([a[A.runs], a[A.turns], a[A.output]]).toEqual([1, 2, 100]);
	expect(rec.tools[`${DAY}\tagent\t\tread`][T.calls]).toBe(1);
});

test("a response copied into another file counts once there; a fuller copy adds only the difference", () => {
	const seen = new Map<string, string>();
	const first = readLines(spec, "/claude/projects/-w/agent-1.jsonl", [reply(T0, "m9", { input_tokens: 1, output_tokens: 8, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 })], env(seen));
	const second = readLines(spec, "/claude/projects/-w/agent-2.jsonl", [
		prompt(T0 - 5, "shared opening"),
		reply(T0, "m9", { input_tokens: 1, output_tokens: 222, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 }, [{ type: "tool_use", id: "z", name: "Bash", input: { command: "ls" } }]),
		reply(T0 + MIN, "m10", { input_tokens: 1, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
	], env(seen));
	const out = (r: typeof first) => Object.values(r.usage).reduce((a, v) => a + v[U.output], 0);
	const turns = (r: typeof first) => Object.values(r.usage).reduce((a, v) => a + v[U.turns], 0);
	expect([out(first), turns(first)]).toEqual([8, 1]);
	expect([out(second), turns(second)]).toEqual([214 + 5, 1]);
	expect(second.bash).toEqual({});
});

test("a resumed transcript's replayed prompts are not counted again", () => {
	const seen = new Map<string, string>();
	const p = prompt(T0, "same prompt");
	readLines(spec, "/claude/projects/-w/one.jsonl", [p], env(seen));
	const again = readLines(spec, "/claude/projects/-w/two.jsonl", [p, prompt(T0 + MIN, "new prompt")], env(seen));
	expect(again.prompts[DAY][0]).toBe(1);
});

describe("the stats-cache archive", () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "claude-home-"));
	writeFileSync(
		path.join(dir, "stats-cache.json"),
		JSON.stringify({
			dailyModelTokens: [
				{ date: "2026-01-01", tokensByModel: { "claude-opus-5-20261001": 300 } },
				{ date: "2026-01-02", tokensByModel: { "claude-opus-5-20261001": 100 } },
				{ date: "2026-09-30", tokensByModel: { "claude-opus-5-20261001": 0 } },
			],
			modelUsage: { "claude-opus-5-20261001": { inputTokens: 40, outputTokens: 360, cacheReadInputTokens: 4000, cacheCreationInputTokens: 400 } },
		}),
	);

	test("lifetime buckets are spread over days by their tokens and priced", async () => {
		const rec = (await claudeArchive(PRICES, undefined, dir))!;
		const jan1 = rec.usage[`2026-01-01\t${MODEL}\tunknown`];
		expect([rec.role, jan1[U.turns], jan1[U.input], jan1[U.output], jan1[U.cacheRead], jan1[U.cacheWrite]]).toEqual(["archive", 0, 30, 270, 3000, 300]);
		expect(jan1[U.estimated]).toBeGreaterThan(0);
		const total = Object.values(rec.usage).reduce((a, v) => a + v[U.cacheRead], 0);
		expect(total).toBe(4000);
	});

	test("days from the first transcript on are left to the transcripts", async () => {
		const rec = (await claudeArchive(PRICES, "2026-01-02", dir))!;
		expect(Object.keys(rec.usage)).toEqual([`2026-01-01\t${MODEL}\tunknown`]);
	});
});
