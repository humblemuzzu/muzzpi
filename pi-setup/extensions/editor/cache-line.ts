import type { SessionEntry } from "@mariozechner/pi-coding-agent";
import type { Styler } from "../tools/lib/agent-layout";
import { CACHE_PING_ENTRY, type CachePing } from "../tools/lib/prompt-cache";
import { type Alert, ink } from "./ink";

const METER_CELLS = 12;
const FILLED = "█";
const EMPTY = "░";
const LABEL_GAP = "  ";
const FIVE_MINUTES_MS = 300_000;
const ONE_HOUR_MS = 3_600_000;

type Usage = Extract<SessionEntry, { type: "usage" }>["usage"];

export interface CacheStats {
	cacheRead: number;
	cacheWrite: number;
	toolCalls: number;
	/** pi's cache-hit figure: cacheRead / prompt, most recent assistant turn only. */
	lastHitRate?: number;
	/** Last request that touched the prompt cache, keep-alive reads included. A read refreshes the TTL as much as a write. */
	lastCacheAt?: number;
	/** keep-alive reads: prompt-cache's, and pi's own warmer in older sessions */
	warms: number;
	/** Lifetime of the latest cache write, from the 1h share Anthropic reports. */
	lastWriteTtlMs?: number;
}

function touchCache(stats: CacheStats, usage: Usage, timestamp: string): void {
	if (usage.cacheRead > 0 || usage.cacheWrite > 0) {
		const at = Date.parse(timestamp);
		if (Number.isFinite(at)) stats.lastCacheAt = at;
	}
	if (usage.cacheWrite > 0) stats.lastWriteTtlMs = (usage.cacheWrite1h ?? 0) > 0 ? ONE_HOUR_MS : FIVE_MINUTES_MS;
}

/** `lastResponseAt`: start of the latest request that got a response, which may not be in `entries` yet. */
export function collectCacheStats(entries: readonly SessionEntry[], lastResponseAt?: number): CacheStats {
	const stats: CacheStats = { cacheRead: 0, cacheWrite: 0, toolCalls: 0, warms: 0 };
	for (const entry of entries) {
		if (entry.type === "usage" && entry.kind === "cache_warm") {
			stats.warms++;
			touchCache(stats, entry.usage, entry.timestamp);
			continue;
		}
		if (entry.type === "custom" && entry.customType === CACHE_PING_ENTRY) {
			const ping = entry.data as CachePing | undefined;
			if (!ping?.usage) continue;
			stats.warms++;
			touchCache(stats, ping.usage, entry.timestamp);
			continue;
		}
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "assistant") continue;
		const usage = message.usage;
		const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
		stats.cacheRead += usage.cacheRead;
		stats.cacheWrite += usage.cacheWrite;
		if (Array.isArray(message.content)) {
			stats.toolCalls += message.content.filter((block) => block.type === "toolCall").length;
		}
		if (prompt > 0) stats.lastHitRate = usage.cacheRead / prompt;
		touchCache(stats, usage, entry.timestamp);
	}
	if (lastResponseAt !== undefined && lastResponseAt > (stats.lastCacheAt ?? 0)) stats.lastCacheAt = lastResponseAt;
	return stats;
}

/** pi's footer formatter. Cache totals run from 0 to millions, so k/M beats a fixed decimal. */
export function formatCompact(count: number): string {
	if (count < 1000) return String(count);
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

/** Coarse on purpose: the row only repaints when this string changes. */
function formatRemaining(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m`;
}

export interface CacheView {
	stats: CacheStats;
	/** the cache lifetime; undefined for a provider that declares none */
	ttlMs: number | undefined;
}

/**
 * Derived, not reported: Anthropic returns no expiry, only how much of a write
 * was 1h. `soon` is the last 5 minutes of a 1h cache, the last minute of a 5m one.
 */
export function cacheLifetime(view: CacheView, now: number): { remaining: number; soon: boolean } | undefined {
	const at = view.stats.lastCacheAt;
	if (at === undefined || view.ttlMs === undefined) return undefined;
	const remaining = view.ttlMs - (now - at);
	return { remaining, soon: remaining <= Math.min(FIVE_MINUTES_MS, view.ttlMs / 5) };
}

function hitRate(stats: CacheStats): number | undefined {
	return stats.cacheRead + stats.cacheWrite > 0 ? stats.lastHitRate : undefined;
}

function hitAlert(rate: number): Alert {
	return rate >= 0.9 ? undefined : rate >= 0.5 ? "warning" : "error";
}

/**
 * The glance figure: `cache 100% · 59m left`. Plain while healthy; colour only
 * for a poor hit rate or a cache about to go cold. The countdown shows only
 * while idle, because every request of a running turn renews it.
 */
export function compactCacheText(view: CacheView, now: number, running: boolean, paint: Styler): string {
	const rate = hitRate(view.stats);
	if (rate === undefined) return "";
	const life = running ? undefined : cacheLifetime(view, now);
	if (life && life.remaining <= 0) return "cache expired";
	const hit = ink(paint, hitAlert(rate), `cache ${Math.round(rate * 100)}%`);
	if (!life) return hit;
	const left = formatRemaining(life.remaining);
	const countdown = life.soon ? paint.fg("warning", `expires in ${left}`) : `${left} left`;
	return `${hit}${paint.fg("dim", " · ")}${countdown}`;
}

/** The detail view: meter, hit rate, lifetime, totals. */
export function fullCacheText(view: CacheView, now: number, paint: Styler): string {
	const stats = view.stats;
	const parts: string[] = [paint.fg("dim", "cache")];

	const rate = hitRate(stats);
	if (rate === undefined) {
		parts.push(paint.fg("dim", EMPTY.repeat(METER_CELLS)));
	} else {
		const alert = hitAlert(rate);
		const filled = Math.max(0, Math.min(METER_CELLS, Math.round(rate * METER_CELLS)));
		parts.push(ink(paint, alert, FILLED.repeat(filled)) + paint.fg("dim", EMPTY.repeat(METER_CELLS - filled)));
		parts.push(ink(paint, alert, `${Math.round(rate * 100)}% hit`));
	}

	const life = cacheLifetime(view, now);
	if (life) {
		parts.push(
			life.remaining > 0 ? ink(paint, life.soon ? "warning" : undefined, `expires in ${formatRemaining(life.remaining)}`) : "expired",
		);
	}

	parts.push(`read ${formatCompact(stats.cacheRead)}  write ${formatCompact(stats.cacheWrite)}`);
	if (stats.warms > 0) parts.push(paint.fg("dim", `kept warm ${stats.warms}×`));
	if (stats.toolCalls > 0) {
		parts.push(paint.fg("dim", stats.toolCalls === 1 ? "1 call" : `${stats.toolCalls} calls`));
	}
	return parts.join(LABEL_GAP);
}
