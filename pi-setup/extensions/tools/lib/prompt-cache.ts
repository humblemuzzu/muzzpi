/**
 * The conversation's prompt-cache entry: the last request that wrote it, how
 * long Anthropic keeps it, and the keep-alive that re-reads it while something
 * will continue the conversation (a turn in progress, or a background agent
 * that will report back).
 */
import { calculateCost, type Model, type Usage } from "@earendil-works/pi-ai";
import { isPlainObject } from "./anthropic-sub";

export const HOUR_MS = 3_600_000;
export const FIVE_MINUTES_MS = 300_000;

/** customType of the session entry that records one keep-alive read; `data` is a CachePing. */
export const CACHE_PING_ENTRY = "cache-ping";
/** `pi.events` channel announcing a keep-alive read, so the cache line can renew its countdown. */
export const CACHE_PING_CHANNEL = "muzzpi:cache-ping";

export interface CachePing {
	provider: string;
	model: string;
	ttlMs: number;
	usage: Usage;
}

export interface CapturedRequest {
	payload: Record<string, unknown>;
	messages: readonly unknown[];
	sessionId: string;
	modelId: string;
	/** start of the latest request that read or wrote the entry */
	at: number;
}

/** Lifetime of the entry a payload writes: anthropic-sub marks every breakpoint 1h, pi's own are 5m. */
export function payloadTtlMs(payload: Record<string, unknown>): number {
	const system = Array.isArray(payload.system) ? payload.system : [];
	const hour = system.some((block) => isPlainObject(block) && isPlainObject(block.cache_control) && block.cache_control.ttl === "1h");
	return hour ? HOUR_MS : FIVE_MINUTES_MS;
}

/** Anthropic's receipt: how long it kept what a request wrote. Undefined when it wrote nothing. */
export function writtenTtlMs(usage: Pick<Usage, "cacheWrite" | "cacheWrite1h">): number | undefined {
	if (usage.cacheWrite <= 0) return undefined;
	return (usage.cacheWrite1h ?? 0) >= usage.cacheWrite ? HOUR_MS : FIVE_MINUTES_MS;
}

/** One read per lifetime, as late as is safe: a tenth of it is left for a late timer and the request itself. */
export function refreshDelayMs(ttlMs: number): number {
	return Math.floor(ttlMs * 0.9);
}

/** A timer this late may find the entry gone, and a read of a missing entry rewrites all of it. */
export function refreshDeadlineMs(ttlMs: number): number {
	return Math.floor(ttlMs * 0.95);
}

/** Budget thinking keys the cache on a budget derived from max_tokens, so a 1-token replay would miss. */
export function isReplayable(payload: Record<string, unknown>): boolean {
	return !(isPlainObject(payload.thinking) && payload.thinking.type === "enabled");
}

/** Everything before the last breakpoint is unchanged, so the whole prompt is a cache read. */
export function pingPayload(payload: Record<string, unknown>): Record<string, unknown> {
	return { ...payload, max_tokens: 1 };
}

function price(model: Model<any>, tokens: Partial<Usage>): number {
	const usage: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		...tokens,
	};
	return calculateCost(model, usage).total;
}

/**
 * How many keep-alive reads cost no more than the one rebuild they prevent.
 * Spending at most that on one wait is ski rental: however long the wait turns
 * out to be, it never costs more than twice the best choice made in hindsight.
 */
export function pingBudget(model: Model<any>, promptTokens: number, ttlMs: number): number {
	if (promptTokens <= 0) return 0;
	const ping = price(model, { cacheRead: promptTokens, output: 1 });
	const write = price(model, { cacheWrite: promptTokens, cacheWrite1h: ttlMs >= HOUR_MS ? promptTokens : 0 });
	const rebuild = write - price(model, { cacheRead: promptTokens });
	return ping > 0 ? Math.max(0, Math.floor(rebuild / ping)) : 0;
}

export interface KeepAliveDeps {
	now(): number;
	/** runs `fire` after `ms`; returns its cancel */
	schedule(fire: () => void, ms: number): () => void;
	budget(promptTokens: number, ttlMs: number): number;
	/** sends the replay; resolves with its usage, or undefined when it failed */
	ping(capture: CapturedRequest, payload: Record<string, unknown>, signal: AbortSignal): Promise<Usage | undefined>;
	warmed(capture: CapturedRequest, usage: Usage, ttlMs: number): void;
}

export class KeepAlive {
	private entry: CapturedRequest | undefined;
	private previous: CapturedRequest | undefined;
	/** the entry the keep-alive gave up on: past its deadline, over budget, or failing */
	private abandoned: CapturedRequest | undefined;
	private retried = false;
	/** the lifetime Anthropic reported for the latest write */
	private receiptTtlMs: number | undefined;
	private promptTokens = 0;
	private pingsLeft: number | undefined;
	private turnActive = false;
	private liveRuns = 0;
	private cancelTimer: (() => void) | undefined;
	private inFlight: AbortController | undefined;

	constructor(private readonly deps: KeepAliveDeps) {}

	get capture(): CapturedRequest | undefined {
		return this.entry;
	}

	/** The payload's label and Anthropic's receipt for the latest write; the shorter wins. */
	get lifetimeMs(): number | undefined {
		if (!this.entry) return undefined;
		return Math.min(payloadTtlMs(this.entry.payload), this.receiptTtlMs ?? Number.POSITIVE_INFINITY);
	}

	/** A conversation request went out: it reads or writes the entry, so the next read is a full lifetime away. */
	request(capture: CapturedRequest): void {
		this.inFlight?.abort();
		this.inFlight = undefined;
		this.previous = this.entry;
		this.entry = capture;
		this.pingsLeft = undefined;
		this.retried = false;
		this.reschedule();
	}

	/**
	 * The reply to the latest request: its prompt size prices the next read. With no cache
	 * activity it never reached the cache, so the entry that exists is still the previous one.
	 */
	answered(usage: Pick<Usage, "input" | "cacheRead" | "cacheWrite" | "cacheWrite1h">): void {
		if (!this.entry) return;
		if (usage.cacheRead + usage.cacheWrite > 0) {
			this.previous = undefined;
			this.promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
			if (this.readReceipt(usage) && !this.inFlight) this.reschedule();
			return;
		}
		const previous = this.previous;
		const receipt = this.receiptTtlMs;
		this.forget();
		if (!previous) return;
		this.entry = previous;
		this.receiptTtlMs = receipt;
		this.reschedule();
	}

	/** A starting turn always sends a request, which reschedules; resuming here would race it with a read. */
	turn(active: boolean): void {
		this.turnActive = active;
	}

	/** A run the user continues from the agents UI makes an idle session wait again. */
	backgroundRuns(live: number): void {
		this.liveRuns = live;
		if (this.waiting() && !this.cancelTimer && !this.inFlight && this.entry !== this.abandoned) this.reschedule();
	}

	forget(): void {
		this.cancelTimer?.();
		this.cancelTimer = undefined;
		this.inFlight?.abort();
		this.inFlight = undefined;
		this.entry = undefined;
		this.previous = undefined;
		this.abandoned = undefined;
		this.retried = false;
		this.receiptTtlMs = undefined;
		this.pingsLeft = undefined;
	}

	/** true when the receipt changed the lifetime */
	private readReceipt(usage: Pick<Usage, "cacheWrite" | "cacheWrite1h">): boolean {
		const before = this.lifetimeMs;
		this.receiptTtlMs = writtenTtlMs(usage) ?? this.receiptTtlMs;
		return this.lifetimeMs !== before;
	}

	private waiting(): boolean {
		return this.turnActive || this.liveRuns > 0;
	}

	private reschedule(at?: number): void {
		this.cancelTimer?.();
		this.cancelTimer = undefined;
		const entry = this.entry;
		if (!entry) return;
		const due = (at ?? entry.at + refreshDelayMs(this.lifetimeMs!)) - this.deps.now();
		this.cancelTimer = this.deps.schedule(() => {
			this.cancelTimer = undefined;
			void this.refresh().catch(() => undefined);
		}, Math.max(0, due));
	}

	private async refresh(): Promise<void> {
		const entry = this.entry;
		if (!entry || !this.waiting()) return;
		const ttlMs = this.lifetimeMs!;
		const sentAt = this.deps.now();
		const deadline = entry.at + refreshDeadlineMs(ttlMs);
		this.pingsLeft ??= this.deps.budget(this.promptTokens, ttlMs);
		if (!isReplayable(entry.payload) || sentAt > deadline || this.pingsLeft <= 0) {
			this.abandoned = entry;
			return;
		}
		this.pingsLeft--;
		const controller = new AbortController();
		this.inFlight = controller;
		let usage: Usage | undefined;
		try {
			usage = await this.deps.ping(entry, pingPayload(entry.payload), controller.signal);
		} catch {
			usage = undefined;
		} finally {
			if (this.inFlight === controller) this.inFlight = undefined;
		}
		if (this.entry !== entry || controller.signal.aborted) return;
		if (!usage) {
			if (this.retried) {
				this.abandoned = entry;
				return;
			}
			this.retried = true;
			this.pingsLeft++;
			this.reschedule(sentAt + (deadline - sentAt) / 2);
			return;
		}
		this.retried = false;
		entry.at = sentAt;
		this.promptTokens = usage.input + usage.cacheRead + usage.cacheWrite || this.promptTokens;
		this.readReceipt(usage);
		this.deps.warmed(entry, usage, this.lifetimeMs!);
		this.reschedule();
	}
}
