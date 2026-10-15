import { expect, test } from "bun:test";
import { A, dayKey, T, U } from "../record";
import { env, iso, MIN, readLines, T0 } from "../test-helpers";
import { codexSpec } from "./codex";

const DAY = dayKey(T0);
const spec = codexSpec("/codex");
const THREAD = "01a070ea-b65d-7261-8f57-c2dfa2551ff1";
const FILE = `/codex/sessions/2026/10/10/rollout-2026-10-10T09-00-00-${THREAD}.jsonl`;

let ordinal = 0;
const line = (ms: number, type: string, payload: unknown) => JSON.stringify({ timestamp: iso(ms), ordinal: ordinal++, type, payload });
const meta = (ms: number, extra: Record<string, unknown> = {}) => line(ms, "session_meta", { id: THREAD, cwd: "/work/app", model_provider: "openai", base_instructions: { text: "x".repeat(5000) }, ...extra });
const context = (ms: number, model = "gpt-6") => line(ms, "turn_context", { model, effort: "xhigh", cwd: "/work/app" });
const usage = (i: number, c: number, o: number, r: number) => ({ input_tokens: i, cached_input_tokens: c, output_tokens: o, reasoning_output_tokens: r, total_tokens: i + o });
const tokens = (ms: number, total: ReturnType<typeof usage>, last: ReturnType<typeof usage> | null) => line(ms, "event_msg", { type: "token_count", info: { total_token_usage: total, last_token_usage: last } });

test("each new cumulative total counts its last_token_usage once; repeated snapshots count nothing", () => {
	const rec = readLines(spec, FILE, [
		meta(T0),
		context(T0),
		line(T0 + 1, "event_msg", { type: "token_count", info: null }),
		tokens(T0 + 2, usage(1000, 200, 50, 20), usage(1000, 200, 50, 20)),
		tokens(T0 + 3, usage(1000, 200, 50, 20), usage(1000, 200, 50, 20)),
		tokens(T0 + 4, usage(2500, 1100, 80, 20), usage(1500, 900, 30, 0)),
	]);
	const u = rec.usage[`${DAY}\topenai/gpt-6\txhigh`];
	expect([u[U.turns], u[U.input], u[U.cacheRead], u[U.output], u[U.reasoning]]).toEqual([2, 800 + 600, 200 + 900, 80, 20]);
	expect(u[U.cost]).toBeCloseTo((1400 * 2 + 1100 * 0.2 + 80 * 10) / 1e6, 12);
	expect([rec.key, rec.id, rec.cwd, rec.role]).toEqual([`codex:${THREAD}`, THREAD, "/work/app", "session"]);
});

test("cached tokens never exceed the prompt", () => {
	const rec = readLines(spec, FILE, [meta(T0), context(T0), tokens(T0 + 1, usage(100, 500, 1, 0), usage(100, 500, 1, 0))]);
	const u = rec.usage[`${DAY}\topenai/gpt-6\txhigh`];
	expect([u[U.input], u[U.cacheRead]]).toEqual([0, 100]);
});

test("a rollout that opens by replaying another's events counts only what follows", () => {
	const seen = new Map<string, string>();
	const parent = readLines(spec, FILE, [meta(T0), context(T0), tokens(T0 + 1, usage(1000, 0, 10, 0), usage(1000, 0, 10, 0)), tokens(T0 + 2, usage(3000, 0, 30, 0), usage(2000, 0, 20, 0))], env(seen));
	const child = readLines(spec, FILE.replace(THREAD, "01a070ea-0000-7000-8000-000000000002"), [
		meta(T0 + MIN, { id: "01a070ea-0000-7000-8000-000000000002", forked_from_id: THREAD }),
		context(T0 + MIN),
		tokens(T0 + MIN + 1, usage(1000, 0, 10, 0), usage(1000, 0, 10, 0)),
		tokens(T0 + MIN + 2, usage(3000, 0, 30, 0), usage(2000, 0, 20, 0)),
		tokens(T0 + MIN + 3, usage(3500, 0, 35, 0), usage(500, 0, 5, 0)),
	], env(seen));
	const out = (r: typeof parent) => Object.values(r.usage).reduce((a, v) => a + v[U.output], 0);
	expect([out(parent), out(child)]).toEqual([30, 5]);
});

test("a sub-agent thread is an agent run of the thread that spawned it", () => {
	const rec = readLines(spec, FILE, [
		meta(T0, { source: { subagent: { other: "guardian" } }, parent_thread_id: "parent-thread", session_id: "parent-thread" }),
		context(T0, "gpt-6"),
		tokens(T0 + 1, usage(100, 0, 5, 0), usage(100, 0, 5, 0)),
	]);
	expect([rec.role, rec.id, rec.agentName, rec.key]).toEqual(["agent", "parent-thread", "guardian", `codex:${THREAD}`]);
	expect(rec.agents[`${DAY}\tguardian\tgpt-6`][A.runs]).toBe(1);
});

test("calls, shell words, patched files and real prompts; injected context is not a prompt", () => {
	const call = (ms: number, name: string, args: unknown) => line(ms, "response_item", { type: "function_call", name, arguments: JSON.stringify(args), call_id: "c" });
	const rec = readLines(spec, FILE, [
		meta(T0),
		context(T0),
		line(T0 + 1, "response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>\n</environment_context>" }] }),
		line(T0 + 2, "response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "add a login page" }] }),
		tokens(T0 + 3, usage(10, 0, 1, 0), usage(10, 0, 1, 0)),
		call(T0 + 4, "exec_command", { cmd: "cargo test -p core" }),
		call(T0 + 5, "shell", { command: ["bash", "-lc", "git diff --stat"] }),
		line(T0 + 6, "response_item", { type: "custom_tool_call", name: "apply_patch", input: "*** Begin Patch\n*** Update File: src/a.rs\n*** End Patch" }),
		line(T0 + 7, "compacted", { message: "", replacement_history: [] }),
	]);
	expect(rec.prompts[DAY][0]).toBe(1);
	expect(rec.title).toBe("add a login page");
	expect(rec.bash).toEqual({ [`${DAY}\topenai\tcargo test`]: 1, [`${DAY}\topenai\tgit diff`]: 1 });
	expect(rec.edits).toEqual({ [`${DAY}\topenai\t/work/app/src/a.rs`]: 1 });
	expect(rec.tools[`${DAY}\tmain\topenai\texec_command`].slice(0, 5)).toEqual([1, 0, 0, 0, 0]);
	expect(rec.compactions.length).toBe(1);
	expect(rec.tools[`${DAY}\tmain\topenai\tapply_patch`][T.calls]).toBe(1);
});

test("a call logged before the first token count belongs to the session's provider", () => {
	const rec = readLines(spec, FILE, [
		meta(T0, { model_provider: "deepseek" }),
		context(T0, "deepseek-v4-flash"),
		line(T0 + 1, "response_item", { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: "ls" }) }),
	]);
	expect(rec.bash).toEqual({ [`${DAY}\tdeepseek\tls`]: 1 });
});

test("rollouts from before Codex logged usage give an empty record keyed by their thread", () => {
	const rec = readLines(spec, `/codex/sessions/2025/08/23/rollout-2025-08-23T03-06-44-5647374c-c63b-4889-b2b8-0909f18fb894.jsonl`, [
		JSON.stringify({ id: "5647374c-c63b-4889-b2b8-0909f18fb894", timestamp: iso(T0), instructions: null }),
		JSON.stringify({ record_type: "state" }),
		JSON.stringify({ type: "message", id: null, role: "user", content: [{ type: "input_text", text: "hi" }] }),
	]);
	expect([rec.key, Object.keys(rec.usage).length]).toEqual(["codex:5647374c-c63b-4889-b2b8-0909f18fb894", 0]);
});
