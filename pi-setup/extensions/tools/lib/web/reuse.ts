/**
 * Identical searches are answered once: a repeat inside the window is served
 * from memory, and a repeat while the first is still running shares its call.
 * The shared call is aborted only when every caller waiting on it has aborted.
 */

import { ProviderError } from "./http";

export const REUSE_WINDOW_MS = 30_000;
const MAX_ENTRIES = 64;

interface Flight<T> {
	promise: Promise<T>;
	abort: AbortController;
	callers: number;
	settled: boolean;
}

function until<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(new ProviderError("aborted", "search aborted"));
		if (signal.aborted) return onAbort();
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}

export class SearchReuse<T> {
	private readonly done = new Map<string, { at: number; value: T }>();
	private readonly flying = new Map<string, Flight<T>>();

	constructor(
		private readonly storable: (value: T) => boolean,
		private readonly now: () => number = Date.now,
	) {}

	async run(key: string, start: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<{ value: T; reused: boolean }> {
		if (signal?.aborted) throw new ProviderError("aborted", "search aborted");
		const kept = this.recall(key);
		if (kept) return { value: structuredClone(kept.value), reused: true };

		let flight = this.flying.get(key);
		const reused = flight !== undefined;
		flight ??= this.launch(key, start);
		flight.callers++;
		try {
			return { value: structuredClone(await until(flight.promise, signal)), reused };
		} finally {
			if (--flight.callers === 0 && !flight.settled) {
				if (this.flying.get(key) === flight) this.flying.delete(key);
				flight.abort.abort();
			}
		}
	}

	private launch(key: string, start: (signal: AbortSignal) => Promise<T>): Flight<T> {
		const abort = new AbortController();
		const flight = { abort, callers: 0, settled: false } as Flight<T>;
		flight.promise = start(abort.signal).then((value) => {
			if (this.storable(value)) this.store(key, value);
			return value;
		});
		const settle = () => {
			flight.settled = true;
			if (this.flying.get(key) === flight) this.flying.delete(key);
		};
		flight.promise.then(settle, settle);
		this.flying.set(key, flight);
		return flight;
	}

	private recall(key: string): { at: number; value: T } | undefined {
		const entry = this.done.get(key);
		if (!entry) return undefined;
		this.done.delete(key);
		if (this.now() - entry.at >= REUSE_WINDOW_MS) return undefined;
		this.done.set(key, entry);
		return entry;
	}

	private store(key: string, value: T): void {
		this.done.delete(key);
		this.done.set(key, { at: this.now(), value: structuredClone(value) });
		for (const oldest of this.done.keys()) {
			if (this.done.size <= MAX_ENTRIES) break;
			this.done.delete(oldest);
		}
	}
}
