import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { estimate, type PriceBook } from "../pricing";
import {
	addCalls,
	addCompaction,
	addPrompt,
	addToolResult,
	addTurn,
	bump,
	cleanText,
	emptyRecord,
	modelKey,
	msOf,
	num,
	type SessionRecord,
	textOf,
	U,
	U_LEN,
} from "../record";
import type { FileSpec, LineEnv } from "./files";

/**
 * Claude Code transcripts: `<config>/projects/<project>/<session>.jsonl`,
 * with each sub-agent in `<session>/subagents/agent-<id>.jsonl` beside a
 * `.meta.json` naming its type. Claude Code records no cost, so every turn
 * is priced from pi's catalog.
 *
 * A response is written once per content block, and forked sub-agents and
 * resumed sessions copy whole responses into other files; every copy keeps
 * `message.id:requestId`. Copies made mid-stream carry partial counts, so a
 * response counts once, at the largest value any copy reported per bucket.
 * Tool calls, results and prompts count only in the record that first had
 * the response or the prompt.
 */

export function claudeHome(): string {
	return process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), ".claude");
}

const SKIPPED_PROMPTS = /^\s*(<|\[Request interrupted|Caveat: The messages below)/;
const NONE = [0, 0, 0, 0, 0, 0, 0];

function usageOf(u: any): number[] {
	return [
		num(u?.input_tokens),
		num(u?.output_tokens),
		num(u?.cache_read_input_tokens),
		num(u?.cache_creation_input_tokens),
		num(u?.cache_creation?.ephemeral_1h_input_tokens),
		num(u?.output_tokens_details?.thinking_tokens),
	];
}

function agentType(file: string): string {
	try {
		const meta = JSON.parse(readFileSync(file.replace(/\.jsonl$/, ".meta.json"), "utf8"));
		const name = typeof meta?.agentType === "string" ? cleanText(meta.agentType, 40) : undefined;
		if (name) return name;
	} catch {
		// a transcript without a meta file is still an agent run
	}
	return "subagent";
}

function onAssistant(rec: SessionRecord, entry: any, ms: number, env: LineEnv): void {
	const msg = entry.message;
	const st = rec.state;
	const model = typeof msg?.model === "string" ? msg.model : "";
	if (!model || model === "<synthetic>") return;
	const key = msg.id ? (entry.requestId ? `${msg.id}:${entry.requestId}` : `m:${msg.id}`) : undefined;
	const now = usageOf(msg.usage);
	const prior = key ? env.seen.get(key) : undefined;
	const owned = !key || prior === undefined || key in rec.dedup;
	const before = prior ? prior.split(",").map(Number) : NONE;
	const delta = now.map((v, i) => Math.max(0, v - (before[i] || 0)));
	const slot = [...now.map((v, i) => Math.max(v, before[i] || 0)), before[6] || 0];

	const mk = modelKey("anthropic", model);
	if (prior === undefined || delta.some((v) => v > 0)) {
		const [input, output, cacheRead, cacheWrite, cacheWrite1h, reasoning] = delta;
		const priced = estimate(env.prices, rec.rates, mk, { input, output, cacheRead, cacheWrite, cacheWrite1h });
		addTurn(
			rec,
			{
				ms,
				model: mk,
				thinking: typeof entry.effort === "string" ? entry.effort : "unknown",
				input,
				output,
				cacheRead,
				cacheWrite,
				cacheWrite1h,
				reasoning: Math.min(reasoning, output),
				...priced,
				durationMs: 0,
				stop: entry.isApiErrorMessage || msg.stop_reason === "error" ? "error" : undefined,
				calls: [],
			},
			true,
			prior !== undefined,
		);
	}
	if (owned) {
		const blocks: any[] = Array.isArray(msg.content) ? msg.content : [];
		const uses = blocks.filter((b) => b?.type === "tool_use" && typeof b.name === "string");
		for (const b of uses) if (typeof b.id === "string") (st.calls ??= {})[b.id] = b.name;
		slot[6] = addCalls(rec, ms, uses.map((b) => ({ name: b.name as string, args: b.input })), slot[6]);
	}
	if (key) {
		const csv = slot.join(",");
		env.seen.set(key, csv);
		if (owned) rec.dedup[key] = csv;
	}
}

function onUser(rec: SessionRecord, entry: any, ms: number, env: LineEnv): void {
	const content = entry.message?.content;
	if (Array.isArray(content) && content.some((b: any) => b?.type === "tool_result")) {
		const calls = rec.state.calls ?? {};
		for (const b of content) {
			const tool = b?.type === "tool_result" ? calls[b.tool_use_id] : undefined;
			if (!tool) continue;
			delete calls[b.tool_use_id];
			addToolResult(rec, ms, tool, { error: b.is_error === true });
		}
		return;
	}
	if (entry.isMeta || entry.isCompactSummary) return;
	const text = textOf(content);
	if (!text.trim() || SKIPPED_PROMPTS.test(text)) return;
	if (typeof entry.uuid === "string") {
		const key = `u:${entry.uuid}`;
		if (env.seen.has(key)) return;
		env.seen.set(key, "");
		rec.dedup[key] = "";
	}
	addPrompt(rec, ms, text);
}

export function claudeLine(rec: SessionRecord, line: string, env: LineEnv): void {
	let entry: any;
	try {
		entry = JSON.parse(line);
	} catch {
		return;
	}
	if (!entry || typeof entry !== "object") return;
	if (!rec.cwd && typeof entry.cwd === "string") rec.cwd = entry.cwd;
	if (!rec.id && typeof entry.sessionId === "string") rec.id = entry.sessionId;
	if (entry.type === "ai-title" && typeof entry.aiTitle === "string") rec.name = cleanText(entry.aiTitle) ?? rec.name;
	if (entry.type === "summary" && typeof entry.summary === "string") rec.name ??= cleanText(entry.summary);
	const ms = msOf(entry.timestamp);
	if (!Number.isFinite(ms)) return;
	if (!rec.startMs) rec.startMs = ms;

	if (entry.type === "assistant") onAssistant(rec, entry, ms, env);
	else if (entry.type === "user") onUser(rec, entry, ms, env);
	else if (entry.type === "system" && entry.subtype === "compact_boundary") addCompaction(rec, ms, num(entry.compactMetadata?.preTokens));
}

export function claudeSpec(home = claudeHome()): FileSpec {
	return {
		harness: "claude",
		roots: [path.join(home, "projects")],
		accept: (f) => f.endsWith(".jsonl") && path.basename(f) !== "journal.jsonl",
		create: (f) => {
			const agent = path.basename(path.dirname(f)) === "subagents";
			const rec = emptyRecord("claude", f, agent ? "agent" : "session");
			if (agent) rec.agentName = agentType(f);
			return rec;
		},
		line: (rec, line, env) => claudeLine(rec, line.toString("utf8"), env),
		finish: (rec) => {
			const stem = path.basename(rec.source, ".jsonl");
			if (!rec.id) rec.id = rec.role === "agent" ? path.basename(path.dirname(path.dirname(rec.source))) : stem;
			rec.key = rec.role === "agent" ? `claude:agent:${stem}` : `claude:${stem}`;
		},
	};
}

/**
 * Claude Code's own `stats-cache.json` keeps per-model lifetime buckets and
 * per-day input+output tokens for history whose transcripts are gone. Each
 * day gets its share of every bucket in proportion to its tokens: exact in
 * total, estimated in the per-day split. Only days before the first
 * transcript day are used, so the two sources never overlap.
 */
export async function claudeArchive(prices: PriceBook, firstTranscriptDay: string | undefined, home = claudeHome()): Promise<SessionRecord | undefined> {
	let raw: any;
	try {
		raw = JSON.parse(await fs.readFile(path.join(home, "stats-cache.json"), "utf8"));
	} catch {
		return undefined;
	}
	const daily: Array<{ date: string; tokensByModel: Record<string, number> }> = Array.isArray(raw?.dailyModelTokens) ? raw.dailyModelTokens : [];
	const lifetime: Record<string, any> = raw?.modelUsage && typeof raw.modelUsage === "object" ? raw.modelUsage : {};
	const totals = new Map<string, number>();
	for (const d of daily) for (const [m, v] of Object.entries(d.tokensByModel ?? {})) totals.set(m, (totals.get(m) ?? 0) + num(v));

	const rec = emptyRecord("claude", path.join(home, "stats-cache.json"), "archive");
	rec.key = "claude:archive";
	rec.id = "archive";
	for (const d of daily) {
		if (typeof d.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(d.date)) continue;
		if (firstTranscriptDay && d.date >= firstTranscriptDay) continue;
		for (const [model, tokens] of Object.entries(d.tokensByModel ?? {})) {
			const u = lifetime[model];
			const total = totals.get(model) ?? 0;
			if (!u || total <= 0 || num(tokens) <= 0) continue;
			const share = num(tokens) / total;
			const input = Math.round(num(u.inputTokens) * share);
			const output = Math.round(num(u.outputTokens) * share);
			const cacheRead = Math.round(num(u.cacheReadInputTokens) * share);
			const cacheWrite = Math.round(num(u.cacheCreationInputTokens) * share);
			const mk = modelKey("anthropic", model);
			const { cost, estimated, unpriced } = estimate(prices, rec.rates, mk, { input, output, cacheRead, cacheWrite, cacheWrite1h: 0 });
			bump(rec.usage, `${d.date}\t${mk}\tunknown`, U_LEN, [
				[U.input, input],
				[U.output, output],
				[U.cacheRead, cacheRead],
				[U.cacheWrite, cacheWrite],
				[U.cost, cost.total],
				[U.costInput, cost.input],
				[U.costOutput, cost.output],
				[U.costCacheRead, cost.cacheRead],
				[U.costCacheWrite, cost.cacheWrite],
				[U.estimated, estimated ? cost.total : 0],
				[U.unpriced, unpriced ? 1 : 0],
			]);
		}
	}
	return Object.keys(rec.usage).length ? rec : undefined;
}
