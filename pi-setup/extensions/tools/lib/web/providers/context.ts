/** Context.dev web search: POST /v1/web/search. https://docs.context.dev/api-reference/web-scraping/search */

import {
	clipWords,
	kindForStatus,
	parseJson,
	postJson,
	ProviderError,
	retryAfterSec,
	clip,
	type HttpResponse,
} from "../http";
import type { Freshness, Hit, ProviderCall, ProviderResult, SearchMode, SearchProvider } from "../types";

export const CONTEXT_ENDPOINT = "https://api.context.dev/v1/web/search";

const MAX_QUERY_CHARS = 500;
const MAX_RESULTS = 100;

const FRESHNESS: Record<Freshness, string> = {
	day: "last_24_hours",
	week: "last_week",
	month: "last_month",
	year: "last_year",
};

const PASSAGE_CHARS: Record<SearchMode, number | undefined> = {
	fast: undefined,
	"one-shot": 2000,
	agentic: 4000,
};

const LANGUAGES = new Set(
	("am ar az be bg bn ca ceb cs cy da de el en es et eu fa fi fr gu ha haw he hi hr hu hy id is it ja ka kk kn ko ku ky " +
		"lo lt lv mk ml mn mr ms ne nl no or pa pl ps pt ro ru sk sl so sq sr sv sw ta te th tl tr uk ur uz vi yo zh").split(" "),
);

interface ContextResult {
	url: string;
	title?: string;
	description?: string;
	highlights?: { highlights: string[] | null; code: string };
}

interface ContextResponse {
	results: ContextResult[];
	partial?: boolean;
	key_metadata?: { credits_consumed: number; credits_remaining: number };
}

interface ContextErrorBody {
	message?: string;
	error_code?: string;
	error_data?: { retry_after_seconds?: number; credits_remaining?: number };
}

export function contextBody(call: ProviderCall): { body: Record<string, unknown>; notes: string[] } {
	const req = call.request;
	const notes: string[] = [];
	const body: Record<string, unknown> = {
		query: clipWords(req.objective, MAX_QUERY_CHARS),
		numResults: Math.min(req.maxResults, MAX_RESULTS),
	};
	if (req.includeDomains.length) body.includeDomains = req.includeDomains;
	if (req.excludeDomains.length) body.excludeDomains = req.excludeDomains;
	if (req.freshness) body.freshness = FRESHNESS[req.freshness];
	if (req.country) body.country = req.country;
	if (req.languages.length) {
		const known = req.languages.filter((l) => LANGUAGES.has(l));
		const unknown = req.languages.filter((l) => !LANGUAGES.has(l));
		if (known.length) body.languages = known;
		if (unknown.length) notes.push(`languages not supported by Context.dev, ignored: ${unknown.join(", ")}`);
	}
	const passageChars = PASSAGE_CHARS[req.mode];
	if (passageChars) body.highlightsOptions = { enabled: true, maxCharacters: passageChars };
	body.timeoutOpts = { milliseconds: Math.max(5000, call.timeoutMs - 1000), behavior: "return-partial" };
	return { body, notes };
}

function contextError(res: HttpResponse): ProviderError {
	let parsed: ContextErrorBody = {};
	try {
		parsed = JSON.parse(res.text) as ContextErrorBody;
	} catch {}
	const code = parsed.error_code;
	const message = `${code ? `${code}: ` : ""}${clip(parsed.message ?? res.text, 300)}`;
	const retry = parsed.error_data?.retry_after_seconds ?? retryAfterSec(res.headers);
	if (code === "USAGE_EXCEEDED") return new ProviderError("credits", message, res.status);
	if (code === "RATE_LIMITED") return new ProviderError("rate_limit", message, res.status, retry);
	if (code === "REQUEST_TIMEOUT") return new ProviderError("timeout", message, res.status);
	return new ProviderError(kindForStatus(res.status), message, res.status, retry);
}

export function createContextProvider(opts: { usdPerCredit: number }): SearchProvider {
	return {
		id: "context",
		label: "Context.dev",
		keyEnv: "CONTEXT_DEV_API_KEY",
		maxConcurrent: 2,
		async search(call: ProviderCall): Promise<ProviderResult> {
			const { body, notes } = contextBody(call);
			const res = await postJson(call.endpoint, {
				headers: { Authorization: `Bearer ${call.key}` },
				body,
				timeoutMs: call.timeoutMs,
				signal: call.signal,
			});
			if (res.status !== 200) throw contextError(res);
			const data = parseJson<ContextResponse>(res, "Context.dev");
			if (!Array.isArray(data.results)) {
				throw new ProviderError("invalid_response", `Context.dev returned no results array: ${clip(res.text, 200)}`);
			}
			if (data.partial) notes.push("Context.dev hit its deadline and returned the results it had");
			const hits: Hit[] = data.results.map((r) => {
				const highlights = r.highlights?.code === "SUCCESS" ? (r.highlights.highlights ?? []) : [];
				const passages = highlights.length ? highlights : r.description ? [r.description] : [];
				return { url: r.url, title: r.title || r.url, passages };
			});
			const meta = data.key_metadata;
			return {
				hits,
				costUsd: (meta?.credits_consumed ?? 0) * opts.usdPerCredit,
				credits: meta ? { used: meta.credits_consumed, remaining: meta.credits_remaining } : undefined,
				notes,
			};
		},
	};
}
