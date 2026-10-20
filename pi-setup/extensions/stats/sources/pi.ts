import path from "node:path";
import { AGENT_RESULT_TYPE } from "../../tools/lib/agent-channel";
import { estimate } from "../pricing";
import {
	addAgentRun,
	addCompaction,
	addPrompt,
	addToolResult,
	addTurn,
	bump,
	cleanText,
	dayKey,
	emptyRecord,
	msOf,
	num,
	type SessionRecord,
	T,
	T_LEN,
	textOf,
	toolName,
	UNKNOWN_MODEL,
	ZERO_COST,
} from "../record";
import type { FileSpec, LineEnv } from "./files";

/**
 * pi's own sessions. Main-session spend comes from assistant `usage`, which
 * pi prices itself. Sub-agent spend comes from the parent's record of each run:
 * a blocking call's toolResult `details.usage`, or the `details.runs` of a
 * background run's agent-result message (or of the `agents wait` that took it).
 * A fork copies its parent's entries with their
 * original timestamps, so entries older than the fork header are skipped
 * while the parent exists. pi records $0 for subscription and imported
 * turns; those are priced from the catalog like every other harness.
 */

const IMPORTED = /^\[(opencode|claude|codex)\] /;

function isAgentDetails(details: any): boolean {
	return !!details && typeof details === "object" && !!details.usage && ("agent" in details || "exitCode" in details);
}

function agentFailed(msg: any, details: any): boolean {
	return !!msg.isError || (typeof details.exitCode === "number" && details.exitCode !== 0) || details.stopReason === "error" || details.stopReason === "aborted";
}

function runUsage(details: any) {
	const u = details.usage ?? {};
	return { ...u, cost: u.cost?.total ?? u.cost ?? details.cost };
}

function addRuns(rec: SessionRecord, day: string, runs: unknown): void {
	if (!Array.isArray(runs)) return;
	for (const run of runs) {
		if (!isAgentDetails(run)) continue;
		addAgentRun(rec, day, run.agent, run.model, runUsage(run), run.status !== "done", num(run.durationMs));
		if (Array.isArray(run.messages)) walkChild(rec, day, run.messages, 1);
	}
}

/** A child transcript inside `details.messages`: its tool calls count as agent tool use, its sub-agents as runs. */
function walkChild(rec: SessionRecord, day: string, messages: unknown[], depth: number): void {
	if (depth > 4) return;
	for (const cm of messages as any[]) {
		if (cm?.role !== "toolResult" || typeof cm.toolName !== "string") continue;
		const dur = num(cm.durationMs);
		bump(rec.tools, `${day}\tagent\t\t${toolName(cm.toolName)}`, T_LEN, [
			[T.calls, 1],
			[T.errors, cm.isError ? 1 : 0],
			[T.durationMs, dur],
			[T.timed, dur > 0 ? 1 : 0],
			[T.checked, 1],
		]);
		const d = cm.details;
		if (isAgentDetails(d)) {
			addAgentRun(rec, day, cm.toolName, d.model, runUsage(d), agentFailed(cm, d), dur);
			if (Array.isArray(d.messages)) walkChild(rec, day, d.messages, depth + 1);
		}
	}
}

function onAssistant(rec: SessionRecord, msg: any, ms: number, counted: boolean, env: Pick<LineEnv, "prices">): void {
	const st = rec.state;
	const model = msg.model ? `${msg.provider ?? st.model?.split("/")[0] ?? "unknown"}/${msg.model}` : (st.model ?? UNKNOWN_MODEL);
	const u = msg.usage ?? {};
	const cost = u.cost;
	const total = typeof cost === "object" && cost ? num(cost.total) : num(cost);
	const input = num(u.input);
	const output = num(u.output);
	const cacheRead = num(u.cacheRead);
	const cacheWrite = num(u.cacheWrite);
	const cacheWrite1h = num(u.cacheWrite1h);
	const tokens = input + output + cacheRead + cacheWrite;
	if (rec.importOf && counted && tokens > 0) rec.dedup[`${ms}:${input}:${output}:${cacheRead}:${cacheWrite}`] = "";
	const recorded = typeof cost === "object" && cost ? { input: num(cost.input), output: num(cost.output), cacheRead: num(cost.cacheRead), cacheWrite: num(cost.cacheWrite), total } : { ...ZERO_COST, total };
	const priced = total === 0 && tokens > 0 ? estimate(env.prices, rec.rates, model, { input, output, cacheRead, cacheWrite, cacheWrite1h }) : { cost: recorded, estimated: false, unpriced: false };
	addTurn(
		rec,
		{
			ms,
			model,
			thinking: msg.thinkingLevel ?? st.thinking ?? "unknown",
			input,
			output,
			cacheRead,
			cacheWrite,
			cacheWrite1h,
			reasoning: num(u.reasoning),
			...priced,
			durationMs: num(msg.durationMs),
			stop: msg.stopReason === "error" ? "error" : msg.stopReason === "aborted" ? "aborted" : undefined,
			calls: Array.isArray(msg.content) ? msg.content.filter((c: any) => c?.type === "toolCall" && typeof c.name === "string").map((c: any) => ({ name: c.name, args: c.arguments })) : [],
		},
		counted,
	);
}

function onToolResult(rec: SessionRecord, msg: any, ms: number): void {
	const tool = typeof msg.toolName === "string" ? msg.toolName : "unknown";
	const dur = num(msg.durationMs);
	addToolResult(rec, ms, tool, { error: !!msg.isError, durationMs: dur });
	const day = dayKey(ms);
	const d = msg.details;
	if (isAgentDetails(d)) {
		addAgentRun(rec, day, tool, d.model, runUsage(d), agentFailed(msg, d), dur);
		if (Array.isArray(d.messages)) walkChild(rec, day, d.messages, 1);
	} else if (Array.isArray(d?.runs)) {
		addRuns(rec, day, d.runs);
	} else if (msg.usage && typeof msg.usage === "object") {
		addAgentRun(rec, day, tool, undefined, { ...msg.usage, cost: msg.usage.cost?.total ?? msg.usage.cost }, false, 0, 0);
	}
}

/** Feed one JSONL line. `parentExists` decides whether a fork's copied prefix is a duplicate or the only surviving copy. */
export function piLine(rec: SessionRecord, line: string, env: Pick<LineEnv, "parentExists" | "prices">): void {
	let entry: any;
	try {
		entry = JSON.parse(line);
	} catch {
		return;
	}
	if (!entry || typeof entry !== "object") return;
	const st = rec.state;

	if (entry.type === "session") {
		if (st.headerSeen) return;
		st.headerSeen = true;
		rec.id = String(entry.id ?? "");
		rec.cwd = String(entry.cwd ?? "");
		rec.startMs = msOf(entry.timestamp) || 0;
		if (typeof entry.parentSession === "string" && env.parentExists(entry.parentSession)) rec.skipBeforeMs = rec.startMs;
		return;
	}

	const ms = msOf(entry.timestamp);
	if (!Number.isFinite(ms)) return;
	const counted = rec.skipBeforeMs === undefined || ms >= rec.skipBeforeMs;

	switch (entry.type) {
		case "model_change":
			if (entry.provider && entry.modelId) st.model = `${entry.provider}/${entry.modelId}`;
			return;
		case "thinking_level_change":
			if (typeof entry.thinkingLevel === "string") st.thinking = entry.thinkingLevel;
			return;
		case "session_info":
			if (typeof entry.name === "string" && entry.name.trim()) {
				rec.name = cleanText(entry.name);
				const from = IMPORTED.exec(entry.name.trim())?.[1];
				if (from) rec.importOf = from as SessionRecord["importOf"];
			}
			return;
		case "compaction":
			if (counted) addCompaction(rec, ms, num(entry.tokensBefore));
			else st.afterCompaction = true;
			return;
		case "custom": {
			const goal = entry.customType === "pi-codex-goal" ? entry.data?.goal : undefined;
			if (counted && goal?.goalId) rec.goals[goal.goalId] = [String(goal.status ?? "active"), num(goal.usage?.activeSeconds), ms];
			return;
		}
		case "custom_message":
			if (counted && entry.customType === AGENT_RESULT_TYPE) addRuns(rec, dayKey(ms), entry.details?.runs);
			return;
		case "message":
			break;
		default:
			return;
	}

	const msg = entry.message;
	if (!msg || typeof msg !== "object") return;
	if (msg.role === "assistant") onAssistant(rec, msg, ms, counted, env);
	else if (!counted) return;
	else if (msg.role === "toolResult") onToolResult(rec, msg, ms);
	else if (msg.role === "user") addPrompt(rec, ms, textOf(msg.content));
}

export function piSpec(sessionsDir: string): FileSpec {
	return {
		harness: "pi",
		roots: [sessionsDir],
		accept: (f) => f.endsWith(".jsonl"),
		create: (f) => emptyRecord("pi", f),
		line: (rec, line, env) => piLine(rec, line.toString("utf8"), env),
		finish: (rec) => {
			rec.key = rec.id ? `pi:${rec.id}` : `pi:${path.basename(rec.source)}`;
		},
	};
}
