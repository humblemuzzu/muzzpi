import os from "node:os";
import path from "node:path";
import { estimate } from "../pricing";
import { addCalls, addCompaction, addPrompt, addToolResult, addTurn, cleanText, emptyRecord, modelKey, msOf, num, type SessionRecord, type ToolCall, textOf } from "../record";
import type { FileSpec, LineEnv } from "./files";

/**
 * Codex rollouts: `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` and
 * `archived_sessions/`. Usage comes from `token_count` events: the
 * `last_token_usage` increment, counted once per new cumulative total (Codex
 * repeats a snapshot when nothing changed). A resumed or forked rollout
 * replays its parent's events first; while a rollout's leading totals match
 * ones already counted, they are that replay and count nothing.
 *
 * Most bytes are tool output and encrypted reasoning, so a line is only
 * JSON-parsed when its first bytes name a type that is read.
 */

export function codexHome(): string {
	return process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
}

const HEAD_BYTES = 240;
const TYPE = /"type":"([a-z_]+)"/g;
const TIMESTAMP = /"timestamp":"([^"]+)"/;
const INJECTED_PROMPT = /^\s*(<|# AGENTS\.md)/;
const IDE_CONTEXT = "# Context from my IDE setup:";
const IDE_REQUEST = "## My request for Codex:";

/** The IDE extension wraps the request in editor context; the request is what was typed. */
function typed(text: string): string {
	if (!text.trimStart().startsWith(IDE_CONTEXT)) return text;
	const at = text.indexOf(IDE_REQUEST);
	return at === -1 ? "" : text.slice(at + IDE_REQUEST.length).trim();
}

function parse(line: Buffer): any {
	try {
		return JSON.parse(line.toString("utf8"));
	} catch {
		return undefined;
	}
}

function argsOf(p: any): unknown {
	if (p.type === "custom_tool_call") return typeof p.input === "string" ? { input: p.input } : p.input;
	if (typeof p.arguments !== "string") return p.arguments;
	try {
		return JSON.parse(p.arguments);
	} catch {
		return undefined;
	}
}

function agentName(source: any): string | undefined {
	const sub = source?.subagent;
	if (!sub) return undefined;
	const name = typeof sub === "string" ? sub : typeof sub.other === "string" ? sub.other : Object.keys(sub)[0];
	return cleanText(name ?? "", 40) ?? "subagent";
}

function onMeta(rec: SessionRecord, p: any, ms: number): void {
	const st = rec.state;
	if (st.headerSeen || !p) return;
	st.headerSeen = true;
	rec.startMs = ms;
	if (typeof p.cwd === "string") rec.cwd = p.cwd;
	st.provider = typeof p.model_provider === "string" && p.model_provider ? p.model_provider : "openai";
	if (typeof p.id === "string") {
		rec.id = p.id;
		rec.key = `codex:${p.id}`;
	}
	const agent = agentName(p.source);
	const parent = p.parent_thread_id ?? p.source?.subagent?.thread_spawn?.parent_thread_id ?? (p.session_id !== p.id ? p.session_id : undefined);
	if (agent && typeof parent === "string") {
		rec.role = "agent";
		rec.agentName = agent;
		rec.id = parent;
	}
}

function onTokens(rec: SessionRecord, info: any, ms: number, env: LineEnv): void {
	const st = rec.state;
	const total = info?.total_token_usage;
	const last = info?.last_token_usage;
	if (!total && !last) return;
	const totals = total ? [num(total.input_tokens), num(total.cached_input_tokens), num(total.output_tokens), num(total.reasoning_output_tokens)] : undefined;
	if (totals && st.totals && totals.every((v, i) => v === st.totals![i])) return;

	let inc = last;
	if (!inc && totals) {
		const prev = st.totals ?? [0, 0, 0, 0];
		inc = { input_tokens: totals[0] - prev[0], cached_input_tokens: totals[1] - prev[1], output_tokens: totals[2] - prev[2], reasoning_output_tokens: totals[3] - prev[3] };
	}
	if (totals) {
		st.totals = totals;
		const key = `${totals.join(":")}:${num(total.total_tokens)}`;
		if (st.replay !== false && env.seen.has(key)) return;
		st.replay = false;
		env.seen.set(key, "");
		rec.dedup[key] = "";
	}

	const promptTokens = Math.max(0, num(inc.input_tokens));
	const cacheRead = Math.min(promptTokens, Math.max(num(inc.cached_input_tokens), num(inc.cache_read_input_tokens)));
	const cacheWrite = Math.min(promptTokens - cacheRead, Math.max(0, num(inc.cache_write_input_tokens)));
	const input = promptTokens - cacheRead - cacheWrite;
	const output = Math.max(0, num(inc.output_tokens));
	const reasoning = Math.min(output, Math.max(0, num(inc.reasoning_output_tokens)));
	if (input + output + cacheRead + cacheWrite === 0) return;
	const model = st.model ?? modelKey(st.provider, "unknown");
	const priced = estimate(env.prices, rec.rates, model, { input, output, cacheRead, cacheWrite, cacheWrite1h: 0 });
	addTurn(rec, { ms, model, thinking: st.thinking ?? "unknown", input, output, cacheRead, cacheWrite, cacheWrite1h: 0, reasoning, ...priced, durationMs: 0, calls: [] });
}

function onCall(rec: SessionRecord, p: any, ms: number): void {
	if (typeof p.name !== "string") return;
	const call: ToolCall = { name: p.name, args: argsOf(p) };
	addCalls(rec, ms, [call]);
	addToolResult(rec, ms, p.name, { known: false });
}

export function codexLine(rec: SessionRecord, line: Buffer, env: LineEnv): void {
	const head = line.toString("latin1", 0, Math.min(line.length, HEAD_BYTES));
	TYPE.lastIndex = 0;
	const outer = TYPE.exec(head)?.[1];
	const inner = outer ? TYPE.exec(head)?.[1] : undefined;
	if (!outer) return;
	const ms = msOf(TIMESTAMP.exec(head)?.[1]);
	if (!Number.isFinite(ms)) return;
	const st = rec.state;

	switch (outer) {
		case "session_meta":
			return onMeta(rec, parse(line)?.payload, ms);
		case "turn_context": {
			const p = parse(line)?.payload;
			if (typeof p?.model === "string") st.model = modelKey(st.provider, p.model);
			if (typeof p?.effort === "string") st.thinking = p.effort;
			if (!rec.cwd && typeof p?.cwd === "string") rec.cwd = p.cwd;
			return;
		}
		case "compacted":
			return addCompaction(rec, ms, st.prevTurn?.context ?? 0);
		case "event_msg":
			if (inner === "token_count") onTokens(rec, parse(line)?.payload?.info, ms, env);
			else if (inner === "thread_settings_applied" && !st.model) {
				const model = parse(line)?.payload?.thread_settings?.model;
				if (typeof model === "string") st.model = modelKey(st.provider, model);
			}
			return;
		case "response_item":
			if (inner === "function_call" || inner === "custom_tool_call") {
				const p = parse(line)?.payload;
				if (p) onCall(rec, p, ms);
			} else if (inner === "message" && head.includes('"role":"user"')) {
				const text = typed(textOf(parse(line)?.payload?.content));
				if (text.trim() && !INJECTED_PROMPT.test(text)) addPrompt(rec, ms, text);
			}
			return;
	}
}

export function codexSpec(home = codexHome()): FileSpec {
	return {
		harness: "codex",
		roots: [path.join(home, "sessions"), path.join(home, "archived_sessions")],
		accept: (f) => {
			const name = path.basename(f);
			return name.startsWith("rollout-") && name.endsWith(".jsonl");
		},
		create: (f) => {
			const rec = emptyRecord("codex", f);
			rec.state.replay = true;
			return rec;
		},
		line: codexLine,
		finish: (rec) => {
			const thread = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(rec.source)?.[1] ?? path.basename(rec.source);
			if (!rec.id) rec.id = thread;
			if (!rec.key) rec.key = `codex:${thread}`;
		},
	};
}
