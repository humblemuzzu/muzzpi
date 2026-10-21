/** DeepSeek Search API: POST /v1/tools/search. https://api-docs.deepseek.com/guides/search */

import { clip, clipWords, kindForStatus, parseJson, postJson, ProviderError, retryAfterSec, type HttpResponse } from "../http";
import { dedupeHits, freshnessStart, type Hit, type ProviderCall, type ProviderResult, type SearchProvider } from "../types";

export const DEEPSEEK_ENDPOINT = "https://api.deepseek.com/v1/tools/search";

const MAX_QUERY_CHARS = 128;
const MAX_COUNT = 50;
const MAX_QUERIES = 3;
const CONTENT_CHARS = 4000;
/** $0.75 per 1,000 searches that return results; empty and failed searches are free. */
const USD_PER_SEARCH = 0.00075;

interface DeepSeekResult {
	title?: string;
	url: string;
	snippet?: string;
	summary?: string;
	content?: string;
	date?: string | null;
}

interface DeepSeekErrorBody {
	error?: { message?: string; code?: string };
}

/**
 * The operators count against DeepSeek's 128-character query limit, so they are
 * placed first and the search text gets what is left. Domains that do not fit
 * are dropped and reported rather than producing a 400.
 */
export function deepseekQuery(text: string, call: ProviderCall, notes: string[]): string {
	const req = call.request;
	const ops: string[] = [];
	if (req.languages.length) ops.push(`lang:${req.languages.join(",")}`);
	if (req.freshness) ops.push(`after:${freshnessStart(req.freshness)}`);
	const textReserve = Math.min(40, text.length);
	const fits = (clause: string) => [...ops, clause].join(" ").length + 1 + textReserve <= MAX_QUERY_CHARS;

	let included = 0;
	for (const domain of req.includeDomains) {
		const clause = `${included ? "OR " : ""}site:${domain}`;
		if (!fits(clause)) break;
		ops.push(clause);
		included++;
	}
	if (included < req.includeDomains.length) {
		notes.push(`DeepSeek's 128-character query fit ${included} of ${req.includeDomains.length} include_domains`);
	}
	let excluded = 0;
	for (const domain of req.excludeDomains) {
		const clause = `-site:${domain}`;
		if (!fits(clause)) break;
		ops.push(clause);
		excluded++;
	}
	if (excluded < req.excludeDomains.length) {
		notes.push(`DeepSeek's 128-character query fit ${excluded} of ${req.excludeDomains.length} exclude_domains`);
	}
	const opText = ops.join(" ");
	const room = Math.max(0, MAX_QUERY_CHARS - opText.length - (opText ? 1 : 0));
	return [clipWords(text, room), opText].filter(Boolean).join(" ").slice(0, MAX_QUERY_CHARS);
}

function deepseekError(res: HttpResponse): ProviderError {
	let parsed: DeepSeekErrorBody = {};
	try {
		parsed = JSON.parse(res.text) as DeepSeekErrorBody;
	} catch {}
	const message = clip(parsed.error?.message ?? res.text, 300);
	return new ProviderError(kindForStatus(res.status), message, res.status, retryAfterSec(res.headers));
}

function toHit(r: DeepSeekResult, withContent: boolean): Hit {
	const passages: string[] = [];
	const summary = r.summary?.trim() || r.snippet?.trim();
	if (summary) passages.push(summary);
	const content = r.content?.trim();
	if (withContent && content) {
		passages.push(content.length > CONTENT_CHARS ? `${content.slice(0, CONTENT_CHARS)}…` : content);
	}
	return { url: r.url, title: r.title || r.url, date: r.date ? r.date.slice(0, 10) : undefined, passages };
}

/** results of several queries, taken in turn so every query's best hit comes before any query's second. */
function interleave(lists: Hit[][]): Hit[] {
	const out: Hit[] = [];
	const longest = Math.max(0, ...lists.map((l) => l.length));
	for (let i = 0; i < longest; i++) for (const list of lists) if (list[i]) out.push(list[i]);
	return out;
}

export function createDeepSeekProvider(): SearchProvider {
	return {
		id: "deepseek",
		label: "DeepSeek",
		keyEnv: "DEEPSEEK_API_KEY",
		async search(call: ProviderCall): Promise<ProviderResult> {
			const req = call.request;
			const notes: string[] = [];
			if (req.country) notes.push("DeepSeek has no country filter; country ignored");
			const texts = req.queries.length ? req.queries.slice(0, MAX_QUERIES) : [req.objective];
			if (req.queries.length > MAX_QUERIES) notes.push(`DeepSeek ran the first ${MAX_QUERIES} of ${req.queries.length} search_queries`);
			const withContent = req.mode === "agentic";
			const queryNotes: string[] = [];
			const queries = texts.map((t) => deepseekQuery(t, call, queryNotes));
			notes.push(...new Set(queryNotes));

			const settled = await Promise.allSettled(
				queries.map(async (query) => {
					const res = await postJson(call.endpoint, {
						headers: { Authorization: `Bearer ${call.key}` },
						body: {
							query,
							count: Math.min(req.maxResults, MAX_COUNT),
							ori_question: clipWords(req.objective, MAX_QUERY_CHARS),
							need_content: withContent,
						},
						timeoutMs: call.timeoutMs,
						signal: call.signal,
					});
					if (res.status !== 200) throw deepseekError(res);
					const data = parseJson<{ results?: DeepSeekResult[] }>(res, "DeepSeek");
					if (!Array.isArray(data.results)) {
						throw new ProviderError("invalid_response", `DeepSeek returned no results array: ${clip(res.text, 200)}`);
					}
					return data.results.map((r) => toHit(r, withContent));
				}),
			);

			const lists: Hit[][] = [];
			const failures: ProviderError[] = [];
			settled.forEach((s, i) => {
				if (s.status === "fulfilled") lists.push(s.value);
				else {
					const err = s.reason instanceof ProviderError ? s.reason : new ProviderError("invalid_response", String(s.reason));
					failures.push(err);
					notes.push(`DeepSeek query "${queries[i]}" failed: ${err.message}`);
				}
			});
			if (!lists.length) throw failures[0];
			const paid = lists.filter((l) => l.length > 0).length;
			return { hits: dedupeHits(interleave(lists), req.maxResults), costUsd: paid * USD_PER_SEARCH, notes };
		},
	};
}
