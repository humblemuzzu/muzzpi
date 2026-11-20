import type { Usage } from "@earendil-works/pi-ai";
import { type Envelope, keepAliveEnvelope } from "./wire";

/**
 * Gemini 4 sets no fixed cache lifetime: an entry nobody read was gone after 45 s in one test and still
 * there after 300 s in another, while one read every 30 s keeps an entry alive.
 */
export const LIFETIME_MS = 45_000;
export const PING_AFTER_MS = 30_000;
/** A timer this late (a laptop asleep) finds the entry gone, and reading a gone entry is a full rebuild. */
export const STALE_AFTER_MS = 40_000;
/** A failed read is tried once more this long after, if that is still before the entry goes stale. */
export const RETRY_AFTER_MS = 3_000;

/** Gemini 4 re-reads the last 2,050 tokens of the previous request at the full rate when a request adds fewer. */
const RE_READ_TOKENS = 2_050;
/** A cached token costs a twentieth of a fresh one: Gemini 4's price, which the plan's quota follows. */
const CACHED_WEIGHT = 0.05;
/** Gemini 4 caches no prefix shorter than this. */
const MIN_CACHED_TOKENS = 4_096;
/** Reads that found the cache already gone, in a row: past this, pings only cost, so they stop for the session. */
const MISSES_BEFORE_STOP = 2;
/**
 * The share of one rebuild the reads may spend. Replayed over 1,369 real gaps between agy requests, a full
 * rebuild's worth of reads cost more than it saved (long waits outlast it anyway); two-thirds cost least.
 */
const REBUILD_SHARE = 2 / 3;

/** As many reads as cost no more than two-thirds of the rebuild they prevent. */
export function pingBudget(promptTokens: number): number {
	if (promptTokens < MIN_CACHED_TOKENS) return 0;
	const read = Math.min(promptTokens, RE_READ_TOKENS) + CACHED_WEIGHT * Math.max(0, promptTokens - RE_READ_TOKENS);
	return Math.max(0, Math.floor((REBUILD_SHARE * (promptTokens - read)) / read));
}

export interface KeepAliveDeps {
	now(): number;
	/** runs `fire` after `ms`; returns its cancel */
	schedule(fire: () => void, ms: number): () => void;
	/** sends one read; resolves with its usage, or undefined when it failed */
	ping(payload: Envelope, signal: AbortSignal): Promise<Usage | undefined>;
	warmed(payload: Envelope, usage: Usage): void;
}

interface Entry {
	payload: Envelope;
	/** the latest request or read of this prompt */
	at: number;
	pingsLeft: number;
}

/**
 * Keeps the last conversation request's cache entry warm between requests: while tools run, while
 * background work runs, and while the person reads. Never beside a request in flight.
 */
export class KeepAlive {
	private entry: Entry | undefined;
	private pending: Envelope | undefined;
	private requesting = false;
	private misses = 0;
	private stopped = false;
	private retried = false;
	private cancelTimer: (() => void) | undefined;
	private inFlight: AbortController | undefined;

	constructor(private readonly deps: KeepAliveDeps) {}

	get scheduled(): boolean {
		return this.cancelTimer !== undefined;
	}

	request(payload: Envelope): void {
		this.halt();
		this.pending = payload;
		this.requesting = true;
	}

	/** A reply that reported no prompt never reached the cache, so the previous entry is still the one to keep. */
	answered(promptTokens: number): void {
		this.requesting = false;
		const payload = this.pending;
		this.pending = undefined;
		if (payload && promptTokens > 0) {
			this.entry = { payload, at: this.deps.now(), pingsLeft: pingBudget(promptTokens) };
			this.retried = false;
		}
		this.reschedule();
	}

	forget(): void {
		this.halt();
		this.entry = undefined;
		this.pending = undefined;
		this.requesting = false;
	}

	/** A new session: pings are allowed again. */
	reset(): void {
		this.forget();
		this.misses = 0;
		this.stopped = false;
	}

	private halt(): void {
		this.cancelTimer?.();
		this.cancelTimer = undefined;
		this.inFlight?.abort();
		this.inFlight = undefined;
	}

	private reschedule(at?: number): void {
		this.cancelTimer?.();
		this.cancelTimer = undefined;
		const entry = this.entry;
		if (!entry || this.stopped || this.requesting || entry.pingsLeft <= 0) return;
		const due = (at ?? entry.at + PING_AFTER_MS) - this.deps.now();
		this.cancelTimer = this.deps.schedule(() => {
			this.cancelTimer = undefined;
			void this.refresh().catch(() => undefined);
		}, Math.max(0, due));
	}

	private async refresh(): Promise<void> {
		const entry = this.entry;
		if (!entry || this.stopped || this.requesting || entry.pingsLeft <= 0) return;
		const sentAt = this.deps.now();
		if (sentAt - entry.at > STALE_AFTER_MS) {
			this.entry = undefined;
			return;
		}
		entry.pingsLeft--;
		const controller = new AbortController();
		this.inFlight = controller;
		let usage: Usage | undefined;
		try {
			usage = await this.deps.ping(keepAliveEnvelope(entry.payload, sentAt), controller.signal);
		} catch {
			usage = undefined;
		} finally {
			if (this.inFlight === controller) this.inFlight = undefined;
		}
		if (this.entry !== entry || controller.signal.aborted) return;
		if (!usage) {
			const retryAt = this.deps.now() + RETRY_AFTER_MS;
			if (this.retried || retryAt - entry.at > STALE_AFTER_MS) {
				this.entry = undefined;
				return;
			}
			this.retried = true;
			entry.pingsLeft++;
			this.reschedule(retryAt);
			return;
		}
		this.retried = false;
		this.deps.warmed(entry.payload, usage);
		if (usage.cacheRead === 0) {
			this.entry = undefined;
			this.misses += 1;
			if (this.misses >= MISSES_BEFORE_STOP) this.stopped = true;
			return;
		}
		this.misses = 0;
		entry.at = sentAt;
		this.reschedule();
	}
}
