import type { SessionEntry, Theme } from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";

const METER_CELLS = 12;
const TICK_MS = 1000;
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
	/** Last request that touched the prompt cache, cache warms included. A read refreshes the TTL as much as a write. */
	lastCacheAt?: number;
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

export function collectCacheStats(entries: readonly SessionEntry[]): CacheStats {
	const stats: CacheStats = { cacheRead: 0, cacheWrite: 0, toolCalls: 0 };
	for (const entry of entries) {
		if (entry.type === "usage" && entry.kind === "cache_warm") {
			touchCache(stats, entry.usage, entry.timestamp);
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
	return stats;
}

/** pi's footer formatter. Cache totals run from 0 to millions, so k/M beats a fixed decimal. */
function formatCompact(count: number): string {
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

export class CacheLineWidget {
	private stats: CacheStats | null = null;
	private ttlMs: number | undefined;
	private timer: ReturnType<typeof setInterval> | undefined;
	private width = 0;
	private lastLine = "";
	private disposed = false;

	constructor(
		private tui: { requestRender(): void },
		private theme: Theme,
	) {}

	setStats(stats: CacheStats, ttlMs: number | undefined): void {
		if (this.disposed) return;
		this.stats = stats;
		this.ttlMs = ttlMs;
		this.syncTimer();
		this.tui.requestRender();
	}

	dispose(): void {
		this.disposed = true;
		this.stopTimer();
	}

	invalidate(): void {}

	render(width: number): string[] {
		this.width = width;
		const line = this.buildLine(width);
		this.lastLine = line;
		return line ? [line] : [];
	}

	/** Derived, not reported: Anthropic returns no expiry, only how much of a write was 1h. */
	private remainingMs(): number | undefined {
		const at = this.stats?.lastCacheAt;
		if (at === undefined || this.ttlMs === undefined) return undefined;
		return this.ttlMs - (Date.now() - at);
	}

	private syncTimer(): void {
		const remaining = this.remainingMs();
		if (remaining === undefined || remaining <= 0) {
			this.stopTimer();
			return;
		}
		if (this.timer) return;
		this.timer = setInterval(() => this.tick(), TICK_MS);
		this.timer.unref?.();
	}

	private stopTimer(): void {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = undefined;
	}

	/** A timer body must never throw: after session replacement pi exits on an uncaughtException. */
	private tick(): void {
		try {
			if ((this.remainingMs() ?? 0) <= 0) this.stopTimer();
			const line = this.buildLine(this.width);
			if (line === this.lastLine) return;
			this.lastLine = line;
			this.tui.requestRender();
		} catch {
			this.stopTimer();
		}
	}

	private buildLine(width: number): string {
		const stats = this.stats;
		if (!stats || width <= 0) return "";
		const theme = this.theme;
		const parts: string[] = [theme.fg("dim", "cache")];

		const rate = stats.cacheRead + stats.cacheWrite > 0 ? stats.lastHitRate : undefined;
		if (rate === undefined) {
			parts.push(theme.fg("dim", EMPTY.repeat(METER_CELLS)));
		} else {
			const tone = rate >= 0.9 ? "success" : rate >= 0.5 ? "warning" : "error";
			const filled = Math.max(0, Math.min(METER_CELLS, Math.round(rate * METER_CELLS)));
			parts.push(theme.fg(tone, FILLED.repeat(filled)) + theme.fg("dim", EMPTY.repeat(METER_CELLS - filled)));
			parts.push(theme.fg(tone, `${Math.round(rate * 100)}% hit`));
		}

		// Before read/write on purpose: truncation cuts from the right, and the
		// remaining lifetime is the one number that has nowhere else to live.
		const remaining = this.remainingMs();
		if (remaining !== undefined) {
			parts.push(
				remaining > 0
					? theme.fg(remaining < 60000 ? "warning" : "dim", `expires in ${formatRemaining(remaining)}`)
					: theme.fg("dim", "expired"),
			);
		}

		parts.push(theme.fg("muted", `read ${formatCompact(stats.cacheRead)}  write ${formatCompact(stats.cacheWrite)}`));
		if (stats.toolCalls > 0) {
			parts.push(theme.fg("dim", stats.toolCalls === 1 ? "1 call" : `${stats.toolCalls} calls`));
		}

		return truncateToWidth(parts.join(LABEL_GAP), width);
	}
}
