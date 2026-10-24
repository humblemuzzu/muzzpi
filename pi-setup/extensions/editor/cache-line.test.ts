import { describe, expect, test } from "bun:test";
import { collectCacheStats } from "./cache-line";

const usage = (cacheRead: number, cacheWrite: number, cacheWrite1h = 0) => ({
	input: 1,
	output: 1,
	cacheRead,
	cacheWrite,
	cacheWrite1h,
	totalTokens: 2 + cacheRead + cacheWrite,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const turn = (timestamp: string, u: ReturnType<typeof usage>) =>
	({ type: "message", id: timestamp, parentId: null, timestamp, message: { role: "assistant", content: [], usage: u } }) as any;

const warm = (timestamp: string, u: ReturnType<typeof usage>, kind = "cache_warm") =>
	({ type: "usage", id: timestamp, parentId: null, timestamp, kind, provider: "anthropic", model: "claude-opus-5-5", usage: u }) as any;

const ping = (timestamp: string, u: ReturnType<typeof usage>) =>
	({ type: "custom", id: timestamp, parentId: null, timestamp, customType: "cache-ping", data: { provider: "anthropic", model: "claude-opus-5-5", ttlMs: 3_600_000, usage: u } }) as any;

const at = (iso: string) => Date.parse(iso);

describe("collectCacheStats", () => {
	test("a 1h write gives a one-hour lifetime, a 5m write five minutes", () => {
		expect(collectCacheStats([turn("2026-10-20T10:00:00Z", usage(0, 5000, 5000))]).lastWriteTtlMs).toBe(3_600_000);
		expect(collectCacheStats([turn("2026-10-20T10:00:00Z", usage(0, 5000, 0))]).lastWriteTtlMs).toBe(300_000);
	});

	test("the latest write decides the tier", () => {
		const stats = collectCacheStats([turn("2026-10-20T10:00:00Z", usage(0, 5000, 5000)), turn("2026-10-20T10:01:00Z", usage(5000, 40, 0))]);
		expect(stats.lastWriteTtlMs).toBe(300_000);
	});

	test("a read-only turn keeps the tier and renews the time", () => {
		const stats = collectCacheStats([turn("2026-10-20T10:00:00Z", usage(0, 5000, 5000)), turn("2026-10-20T10:30:00Z", usage(5000, 0))]);
		expect(stats.lastWriteTtlMs).toBe(3_600_000);
		expect(stats.lastCacheAt).toBe(at("2026-10-20T10:30:00Z"));
	});

	test("a cache warm renews the time without counting as a turn", () => {
		const stats = collectCacheStats([turn("2026-10-20T10:00:00Z", usage(0, 5000, 5000)), warm("2026-10-20T10:54:00Z", usage(5000, 0))]);
		expect(stats.lastCacheAt).toBe(at("2026-10-20T10:54:00Z"));
		expect(stats.cacheRead).toBe(0);
		expect(stats.cacheWrite).toBe(5000);
		expect(stats.lastWriteTtlMs).toBe(3_600_000);
		expect(stats.warms).toBe(1);
	});

	test("a keep-alive read renews the time and counts as a warm, not a turn", () => {
		const stats = collectCacheStats([turn("2026-10-20T10:00:00Z", usage(0, 5000, 5000)), ping("2026-10-20T10:54:00Z", usage(5000, 0))]);
		expect(stats.lastCacheAt).toBe(at("2026-10-20T10:54:00Z"));
		expect(stats.cacheRead).toBe(0);
		expect(stats.warms).toBe(1);
		expect(stats.lastWriteTtlMs).toBe(3_600_000);
	});

	test("other usage entries are ignored", () => {
		const stats = collectCacheStats([turn("2026-10-20T10:00:00Z", usage(0, 5000, 5000)), warm("2026-10-20T10:20:00Z", usage(9000, 9000), "compaction")]);
		expect(stats.lastCacheAt).toBe(at("2026-10-20T10:00:00Z"));
		expect(stats.lastWriteTtlMs).toBe(3_600_000);
	});

	test("a response not yet saved as an entry renews the time", () => {
		const entries = [turn("2026-10-20T10:00:00Z", usage(0, 5000, 5000))];
		const stats = collectCacheStats(entries, at("2026-10-20T10:54:00Z"));
		expect(stats.lastCacheAt).toBe(at("2026-10-20T10:54:00Z"));
		expect(stats.lastWriteTtlMs).toBe(3_600_000);
	});

	test("an older response never moves the time back", () => {
		const entries = [turn("2026-10-20T10:30:00Z", usage(0, 5000, 5000))];
		expect(collectCacheStats(entries, at("2026-10-20T10:00:00Z")).lastCacheAt).toBe(at("2026-10-20T10:30:00Z"));
	});

	test("no write leaves the tier unknown", () => {
		expect(collectCacheStats([turn("2026-10-20T10:00:00Z", usage(0, 0))]).lastWriteTtlMs).toBeUndefined();
		expect(collectCacheStats([]).lastWriteTtlMs).toBeUndefined();
	});
});
