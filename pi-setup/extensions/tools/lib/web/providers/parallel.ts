/** Parallel Search API (v1beta, search-extract-2025-10-10). https://docs.parallel.ai/api-reference/search-beta/search */

import { clip, kindForStatus, parseJson, postJson, ProviderError, retryAfterSec, type HttpResponse } from "../http";
import { freshnessStart, type ProviderCall, type ProviderResult, type SearchProvider } from "../types";

export const PARALLEL_ENDPOINT = "https://api.parallel.ai/v1beta/search";

/** $/unit by SKU name. https://docs.parallel.ai/pricing */
const SKU_UNIT_COST: Record<string, number> = {
	sku_search: 0.005,
	sku_search_additional_results: 0.001,
};

interface ParallelResponse {
	results: { url: string; title?: string; publish_date?: string; excerpts?: string[] }[];
	warnings?: (string | { message?: string })[];
	usage?: { name: string; count: number }[];
}

function costFromUsage(usage: ParallelResponse["usage"]): number {
	if (!usage?.length) return SKU_UNIT_COST.sku_search;
	return usage.reduce((sum, item) => sum + (SKU_UNIT_COST[item.name] ?? 0) * item.count, 0);
}

export function parallelBody(call: ProviderCall): { body: Record<string, unknown>; notes: string[] } {
	const req = call.request;
	const notes: string[] = [];
	const body: Record<string, unknown> = {
		objective: req.objective,
		max_results: req.maxResults,
		excerpts: { max_chars_per_result: req.mode === "agentic" ? 4000 : 2000 },
		mode: req.mode,
	};
	if (req.queries.length) body.search_queries = req.queries;
	const policy: Record<string, unknown> = {};
	if (req.includeDomains.length) policy.include_domains = req.includeDomains;
	else if (req.excludeDomains.length) policy.exclude_domains = req.excludeDomains;
	if (req.includeDomains.length && req.excludeDomains.length) {
		notes.push("Parallel applies include_domains alone; exclude_domains ignored");
	}
	if (req.freshness) policy.after_date = freshnessStart(req.freshness);
	if (Object.keys(policy).length) body.source_policy = policy;
	const unsupported = [req.languages.length && "languages", req.country && "country"].filter(Boolean);
	if (unsupported.length) notes.push(`Parallel has no ${unsupported.join(" or ")} filter; ignored`);
	return { body, notes };
}

function parallelError(res: HttpResponse): ProviderError {
	let message = res.text;
	try {
		const parsed = JSON.parse(res.text) as { error?: { message?: string } };
		if (parsed.error?.message) message = parsed.error.message;
	} catch {}
	return new ProviderError(kindForStatus(res.status), clip(message, 300), res.status, retryAfterSec(res.headers));
}

export function createParallelProvider(): SearchProvider {
	return {
		id: "parallel",
		label: "Parallel",
		keyEnv: "PARALLEL_API_KEY",
		async search(call: ProviderCall): Promise<ProviderResult> {
			const { body, notes } = parallelBody(call);
			const res = await postJson(call.endpoint, {
				headers: { "x-api-key": call.key, "parallel-beta": "search-extract-2025-10-10" },
				body,
				timeoutMs: call.timeoutMs,
				signal: call.signal,
			});
			if (res.status !== 200) throw parallelError(res);
			const data = parseJson<ParallelResponse>(res, "Parallel");
			if (!Array.isArray(data.results)) {
				throw new ProviderError("invalid_response", `Parallel returned no results array: ${clip(res.text, 200)}`);
			}
			for (const w of data.warnings ?? []) notes.push(`Parallel: ${typeof w === "string" ? w : (w.message ?? JSON.stringify(w))}`);
			return {
				hits: data.results.map((r) => ({
					url: r.url,
					title: r.title || r.url,
					date: r.publish_date || undefined,
					passages: r.excerpts ?? [],
				})),
				costUsd: costFromUsage(data.usage),
				notes,
			};
		},
	};
}
