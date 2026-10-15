import { PriceBook } from "./pricing";
import { emptyRecord, type Harness, type Role, type SessionRecord } from "./record";
import type { FileSpec, LineEnv } from "./sources/files";

export const MIN = 60_000;
export const T0 = new Date(2026, 9, 10, 9, 0, 0).getTime();
export const iso = (ms: number) => new Date(ms).toISOString();

/** A small catalog in pi's shape: one row per provider/model, prices per million tokens. */
export const PRICES = new PriceBook([
	{ provider: "anthropic", id: "claude-opus-5", cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } },
	{ provider: "anthropic", id: "claude-sonnet-5", cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
	{ provider: "openai", id: "gpt-6", cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 0, tiers: [{ inputTokensAbove: 272_000, input: 4, output: 15, cacheRead: 0.4, cacheWrite: 0 }] } },
	{ provider: "openai-codex", id: "gpt-6", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
	{ provider: "opencode", id: "gpt-6-codex", cost: { input: 1, output: 8, cacheRead: 0.1, cacheWrite: 0 } },
	{ provider: "opencode", id: "big-pickle", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
	{ provider: "zai", id: "glm-6", cost: { input: 1, output: 4, cacheRead: 0.2, cacheWrite: 0 } },
	{ provider: "zai-coding-cn", id: "glm-6", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
	{ provider: "openrouter", id: "moonshotai/kimi-k3", cost: { input: 0.6, output: 2.5, cacheRead: 0.15, cacheWrite: 0 } },
]);

export function env(seen = new Map<string, string>(), parentExists: (p: string) => boolean = () => false): LineEnv {
	return { prices: PRICES, seen, parentExists };
}

/** Feeds `lines` to a spec the way the file reader does, then finishes the record. */
export function readLines(spec: FileSpec, file: string, lines: string[], e: LineEnv = env()): SessionRecord {
	const rec = spec.create(file);
	for (const l of lines) spec.line(rec, Buffer.from(l), e);
	spec.finish(rec);
	return rec;
}

export function bare(harness: Harness, id: string, role: Role = "session"): SessionRecord {
	const r = emptyRecord(harness, `/src/${id}`, role);
	r.id = id;
	r.key = `${harness}:${id}`;
	return r;
}
