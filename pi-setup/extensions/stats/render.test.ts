import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@mariozechner/pi-tui";
import { type Dataset, prepare, RANGES, summarize } from "./aggregate";
import { plainInk } from "./draw";
import { A, dayKey, U } from "./record";
import { claudeSpec } from "./sources/claude";
import { codexSpec } from "./sources/codex";
import { piSpec } from "./sources/pi";
import { TABS } from "./tabs";
import { bare, env, iso, MIN, readLines, T0 } from "./test-helpers";
import { StatsView, type ViewOptions } from "./view";

const DAY_MS = 86_400_000;
const NOW = T0 + 2 * 3_600_000;
const DAY = dayKey(T0);

const pi = readLines(piSpec("/s"), "/s/a.jsonl", [
	JSON.stringify({ type: "session", id: "pi-1", timestamp: iso(T0), cwd: "/repo/x" }),
	JSON.stringify({ type: "message", timestamp: iso(T0 + 1000), message: { role: "user", content: [{ type: "text", text: "build the thing" }] } }),
	...Array.from({ length: 40 }, (_, i) =>
		JSON.stringify({
			type: "message",
			timestamp: iso(T0 + 2000 + i * MIN),
			message: {
				role: "assistant",
				provider: "anthropic",
				model: i % 3 ? "claude-opus-5" : "claude-sonnet-5",
				thinkingLevel: i % 2 ? "high" : "low",
				durationMs: 2000,
				usage: { input: 10 * i, output: 50, cacheRead: 1000 * i, cacheWrite: 30_000, cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.04, total: 0.1 } },
				content: [{ type: "toolCall", name: "bash", arguments: { cmd: "git status" } }, { type: "toolCall", name: "chad" }],
			},
		}),
	),
	JSON.stringify({ type: "message", timestamp: iso(T0 + 50 * MIN), message: { role: "toolResult", toolName: "chad", details: { agent: "chad", model: "deepseek/deepseek-flash", usage: { cost: 0.5, turns: 4 } } } }),
	JSON.stringify({ type: "compaction", timestamp: iso(T0 + 51 * MIN), tokensBefore: 180_000 }),
]);
const claudeMain = readLines(claudeSpec("/c"), "/c/projects/-repo-x/c-1.jsonl", [
	JSON.stringify({ type: "user", timestamp: iso(T0 - 9 * DAY_MS), sessionId: "c-1", cwd: "/repo/y", uuid: "u1", message: { role: "user", content: "older work" } }),
	JSON.stringify({ type: "assistant", timestamp: iso(T0 - 9 * DAY_MS + MIN), sessionId: "c-1", cwd: "/repo/y", requestId: "r", message: { id: "m", model: "claude-opus-5", usage: { input_tokens: 5, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 60_000 } } }),
]);
const claudeAgent = readLines(claudeSpec("/c"), "/c/projects/-repo-y/c-1/subagents/agent-z.jsonl", [
	JSON.stringify({ type: "assistant", timestamp: iso(T0 - 9 * DAY_MS + 2 * MIN), sessionId: "c-1", requestId: "r2", message: { id: "m2", model: "claude-opus-5", usage: { input_tokens: 5, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }),
]);
const codex = readLines(codexSpec("/x"), "/x/sessions/rollout-2026-10-01T00-00-00-01a070ea-b65d-7261-8f57-c2dfa2551ff1.jsonl", [
	JSON.stringify({ timestamp: iso(T0 - DAY_MS), type: "session_meta", payload: { id: "01a070ea-b65d-7261-8f57-c2dfa2551ff1", cwd: "/repo/x", model_provider: "openai" } }),
	JSON.stringify({ timestamp: iso(T0 - DAY_MS), type: "turn_context", payload: { model: "gpt-6", effort: "high" } }),
	JSON.stringify({ timestamp: iso(T0 - DAY_MS + 1), type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100_000, cached_input_tokens: 90_000, output_tokens: 2000, reasoning_output_tokens: 500, total_tokens: 102_000 }, last_token_usage: { input_tokens: 100_000, cached_input_tokens: 90_000, output_tokens: 2000, reasoning_output_tokens: 500, total_tokens: 102_000 } } } }),
]);
claudeMain.name = "evil\nname\x1b[2J\x1b]0;title\x07\ttab";
const archive = bare("claude", "archive", "archive");
archive.usage[`2026-01-05\tanthropic/claude-opus-5\tunknown`] = Object.assign(new Array(20).fill(0), { [U.output]: 1000, [U.cacheRead]: 50_000, [U.cost]: 3 });

const git = {
	roots: new Map([
		["/repo/x", "/repo/x"],
		["/repo/y", "/repo/y"],
	]),
	commits: [
		{ hash: "a", ms: T0 + 10 * MIN, root: "/repo/x", added: 5, deleted: 1, subject: "feat: a", sessionId: "pi-1" },
		{ hash: "b", ms: T0 - 9 * DAY_MS + 3 * MIN, root: "/repo/y", added: 2, deleted: 0, subject: "fix: b" },
	],
};
const full = prepare([pi, claudeMain, claudeAgent, codex, archive], git, NOW);
const empty = prepare([], { commits: [], roots: new Map() }, NOW);
const OPTS: ViewOptions = { planUsd: 200, windows: new Map([["anthropic/claude-opus-5", 200_000]]), budget: 500 };

describe("aggregation across harnesses", () => {
	const s = summarize(full, "30d");

	test("a sub-agent transcript joins its parent's session; the archive is history, not a session", () => {
		expect(s.sessions.map((x) => `${x.harness}:${x.id}`).sort()).toEqual(["claude:c-1", "codex:01a070ea-b65d-7261-8f57-c2dfa2551ff1", "pi:pi-1"]);
		const c = s.sessions.find((x) => x.id === "c-1")!;
		expect([c.turns, c.agentRuns]).toEqual([1, 1]);
		expect(s.harnesses.get("claude")!.sessions).toBe(1);
	});

	test("lifetime counts the archive's spend and its day as active", () => {
		const all = summarize(full, "all");
		expect(all.daily.get("2026-01-05")!.cost).toBe(3);
		expect(full.lifetime.activeDays.has("2026-01-05")).toBe(true);
		expect(full.lifetime.harnessRank.sort()).toEqual(["claude", "codex", "pi"]);
	});

	test("a harness filter keeps that harness only and leaves commits out", () => {
		const c = summarize(full, "30d", { harness: "codex" });
		expect([...c.harnesses.keys()]).toEqual(["codex"]);
		expect(c.usage[U.turns]).toBe(1);
		expect(c.agentTotal[A.runs]).toBe(0);
		expect(c.commits).toEqual([]);
		expect(s.commits.length).toBe(2);
		expect(s.aiCommits).toBe(2);
	});

	test("models remember which harnesses ran them", () => {
		expect([...s.modelHarness.get("anthropic/claude-opus-5")!].sort()).toEqual(["claude", "pi"]);
		expect(s.daily.get(DAY)!.byHarness.get("pi")![0]).toBeCloseTo(40 * 0.1 + 0.5, 9);
	});
});

const fits = (view: StatsView, width: number) => {
	for (const line of view.render(width)) {
		expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		expect(line).not.toMatch(/NaN|undefined|Infinity|\[object/);
		expect(line.replace(/\x1b\[[0-9;]*m/g, "")).not.toMatch(/[\x00-\x1f\x7f]/);
	}
};

test("every tab, range, filter and width fits and shows no broken numbers", () => {
	const filters = [[], ["h"], ["h", "h"], ["h", "h", "h", "h"], ["p"], ["o"], ["p", "o", "h"]];
	for (const ds of [full, empty]) {
		for (const keys of filters) {
			for (let tab = 1; tab <= TABS.length; tab++) {
				for (const width of [44, 80, 120, 170, 240]) {
					const view = new StatsView(ds, plainInk, OPTS, () => {});
					for (const k of [...keys, String(tab)]) view.handleInput(k);
					for (let r = 0; r < RANGES.length; r++) {
						fits(view, width);
						view.handleInput("]");
					}
				}
			}
		}
	}
});

test("toggles cycle without breaking the layout", () => {
	const view = new StatsView(full, plainInk, OPTS, () => {});
	for (const k of ["m", "m", "g", "g", "c", "v", "b", "t", "\x1b[D", "\x1b[A", "j", "k", "2", "b", "3", "\x1b[C"]) {
		view.handleInput(k);
		fits(view, 150);
	}
});

test("the header names the range and harnesses; clicks switch range, tab and harness", () => {
	const view = new StatsView(full, plainInk, OPTS, () => {});
	const text = () => view.render(170).join("\n");
	expect(text()).toContain("Last 30 days");
	expect(text()).toContain("3 harnesses");
	expect(text()).toContain("Where it ran");
	const click = (row: number, label: string) => {
		const x = view.render(170)[row].replace(/\x1b\[[0-9;]*m/g, "").indexOf(label);
		expect(x).toBeGreaterThan(-1);
		view.handleMouse({ type: "press", button: "left", x, y: row } as never);
	};
	click(0, " 7d ");
	expect(text()).toContain("Last 7 days");
	click(1, "Models");
	expect(text()).toContain("Leaderboard");
	click(1, "Codex");
	click(1, "Overview");
	expect(text()).toContain("Codex · main-session spend by model");
	expect(view.render(170)[2]).not.toContain("✕");
	view.handleInput("p");
	expect(view.render(170)[2]).toContain("project");
});

test("deltas compare against the previous window, and lifetime has none", () => {
	const view = new StatsView(full, plainInk, OPTS, () => {});
	expect(view.render(170).join("\n")).toMatch(/new|▲|▼/);
	for (let i = 0; i < 3; i++) view.handleInput("]");
	const life = view.render(170).join("\n");
	expect(life).toContain("Lifetime");
	expect(life.split("\n").slice(3, 14).join("\n")).not.toMatch(/[▲▼]|\bnew\b/);
});
