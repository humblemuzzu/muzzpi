/**
 * Runs a search on each provider in order until one returns results.
 * Every provider's outcome is recorded, so the answer can say which one
 * served it and why the ones before it did not.
 */

import { ProviderError, type FailureKind } from "./http";
import type { ProviderHealth } from "./health";
import type { ProviderId, ProviderResult, SearchProvider, SearchRequest } from "./types";

export interface Attempt {
	provider: ProviderId;
	outcome: "ok" | "empty" | "skipped" | "failed";
	kind?: FailureKind;
	reason?: string;
	ms?: number;
}

export interface ChainResult {
	/** set when a provider returned results, or when every provider that ran found nothing. */
	provider?: ProviderId;
	result?: ProviderResult;
	attempts: Attempt[];
}

export interface ChainOptions {
	order: readonly ProviderId[];
	providers: Record<ProviderId, SearchProvider>;
	keys: Partial<Record<ProviderId, string>>;
	endpoints: Record<ProviderId, string>;
	timeoutMs: Record<ProviderId, number>;
	health: ProviderHealth;
	signal?: AbortSignal;
}

const inFlight = new Map<ProviderId, number>();

export async function searchWithFallback(request: SearchRequest, opts: ChainOptions): Promise<ChainResult> {
	const attempts: Attempt[] = [];
	let empty: { provider: ProviderId; result: ProviderResult } | undefined;

	for (const id of opts.order) {
		const provider = opts.providers[id];
		const key = opts.keys[id];
		if (!key) {
			attempts.push({ provider: id, outcome: "skipped", kind: "missing_key", reason: `${provider.keyEnv} is not set` });
			continue;
		}
		const held = opts.health.blocked(id, key);
		if (held) {
			const until = new Date(held.until).toTimeString().slice(0, 5);
			attempts.push({ provider: id, outcome: "skipped", kind: held.kind, reason: `${held.message} (skipped until ${until})` });
			continue;
		}
		const running = inFlight.get(id) ?? 0;
		if (provider.maxConcurrent !== undefined && running >= provider.maxConcurrent) {
			attempts.push({
				provider: id,
				outcome: "skipped",
				kind: "rate_limit",
				reason: `${running} requests already in flight, its concurrency limit`,
			});
			continue;
		}

		const started = Date.now();
		inFlight.set(id, running + 1);
		try {
			const result = await provider.search({
				request,
				key,
				endpoint: opts.endpoints[id],
				timeoutMs: opts.timeoutMs[id],
				signal: opts.signal,
			});
			const ms = Date.now() - started;
			opts.health.clear(id);
			if (result.hits.length) {
				attempts.push({ provider: id, outcome: "ok", ms });
				return { provider: id, result, attempts };
			}
			attempts.push({ provider: id, outcome: "empty", reason: "no results", ms });
			empty ??= { provider: id, result };
		} catch (thrown) {
			const err = thrown instanceof ProviderError
				? thrown
				: new ProviderError("invalid_response", `unexpected ${id} response: ${(thrown as Error)?.message ?? thrown}`);
			if (err.kind === "aborted") throw err;
			opts.health.record(id, key, err);
			attempts.push({
				provider: id,
				outcome: "failed",
				kind: err.kind,
				reason: err.status ? `HTTP ${err.status}: ${err.message}` : err.message,
				ms: Date.now() - started,
			});
		} finally {
			inFlight.set(id, (inFlight.get(id) ?? 1) - 1);
		}
	}
	return { ...empty, attempts };
}
