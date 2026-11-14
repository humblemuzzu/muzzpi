/**
 * Claude's own web search: the Messages API's server-side web_search tool,
 * called the way Claude Code calls it. The Claude plan pays; no dollar cost.
 */

import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { isAnthropicRejection } from "../../anthropic-sub";
import { clip, clipWords, kindForStatus, parseJson, postJson, ProviderError, retryAfterSec, type HttpResponse } from "../http";
import {
	cleanUrl,
	type Hit,
	type ProviderCall,
	type ProviderResult,
	type SearchMode,
	type SearchProvider,
	type SearchRequest,
} from "../types";

export const ANTHROPIC_MESSAGES_ENDPOINT = "https://api.anthropic.com/v1/messages?beta=true";

const TOOL_VERSION = "web_search_20250305";
const CLAUDE_CLI_VERSION = "2.1.322";
const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const SEARCH_PROMPT =
	"You run web searches for another model that is waiting on the result. " +
	"Search as instructed, then reply with a concise, factual summary of the most relevant findings.";
const MAX_QUERY_CHARS = 500;
const MAX_GOAL_CHARS = 2000;
const MAX_SUMMARY_CHARS = 16_000;
const MAX_OUTPUT_TOKENS = 16_000;

const FRESHNESS_HINT = {
	day: "the last 24 hours",
	week: "the last week",
	month: "the last month",
	year: "the last year",
} as const;

interface RawResult {
	url?: string;
	title?: string;
	page_age?: string | null;
}

interface RawCitation {
	url?: string;
	cited_text?: string;
}

interface RawBlock {
	type?: string;
	text?: string;
	citations?: RawCitation[];
	content?: RawResult[] | { type?: string; error_code?: string };
}

interface RawResponse {
	content?: RawBlock[];
	stop_reason?: string;
	usage?: {
		input_tokens?: number;
		output_tokens?: number;
		server_tool_use?: { web_search_requests?: number };
	};
	error?: { type?: string; message?: string };
}

export interface ClaudeAnswer {
	hits: Hit[];
	summary?: string;
	/** the summary was longer than the tool hands to the model. */
	summaryCut: boolean;
	searches: number;
	tokensIn: number;
	tokensOut: number;
	errors: string[];
	stopReason?: string;
}

export interface ClaudeBodyOptions {
	model: string;
	maxUses: number;
	/** let the model think; off is Claude Code's own setting for its search side-query. */
	thinking: boolean;
}

/** the keyword queries, capped at the mode's search budget; the note when that drops or shortens some */
function queryLines(request: SearchRequest, maxUses: number, notes: string[]): string[] {
	const queries = request.queries.map((text) => clipWords(text, MAX_QUERY_CHARS)).filter(Boolean);
	if (request.queries.some((text) => clipWords(text, MAX_QUERY_CHARS) !== text.trim())) {
		notes.push(`Claude's queries were shortened to ${MAX_QUERY_CHARS} characters`);
	}
	if (queries.length <= maxUses) return queries;
	notes.push(`Claude searched the first ${maxUses} of ${queries.length} search_queries`);
	return queries.slice(0, maxUses);
}

export function claudeBody(request: SearchRequest, opts: ClaudeBodyOptions): { body: Record<string, unknown>; notes: string[] } {
	const notes: string[] = [];
	const queries = queryLines(request, opts.maxUses, notes);
	let prompt = queries.length
		? `Perform a web search for each of these queries, one search each (at most ${opts.maxUses}), for this research goal:\n` +
			`${clipWords(request.objective, MAX_GOAL_CHARS)}\n\nQueries:\n` +
			queries.map((query, i) => `${i + 1}. ${query}`).join("\n")
		: `Perform a web search for the query: ${clipWords(request.objective, MAX_QUERY_CHARS)}`;

	const tool: Record<string, unknown> = { type: TOOL_VERSION, name: "web_search", max_uses: opts.maxUses };
	if (request.includeDomains.length) tool.allowed_domains = request.includeDomains;
	else if (request.excludeDomains.length) tool.blocked_domains = request.excludeDomains;
	if (request.includeDomains.length && request.excludeDomains.length) {
		notes.push("Claude takes allowed_domains or blocked_domains, not both; exclusions were applied to its results");
	}
	if (request.country) tool.user_location = { type: "approximate", country: request.country.toUpperCase() };
	if (request.freshness) {
		prompt += `\n\nPrefer results published within ${FRESHNESS_HINT[request.freshness]}.`;
		notes.push("Claude search has no date filter; a recency hint was added to the query");
	}
	if (request.languages.length) notes.push(`Claude search has no language filter; ignored ${request.languages.join(", ")}`);

	return {
		body: {
			model: opts.model,
			max_tokens: MAX_OUTPUT_TOKENS,
			...(opts.thinking ? {} : { thinking: { type: "disabled" } }),
			system: [
				{ type: "text", text: IDENTITY },
				{ type: "text", text: SEARCH_PROMPT },
			],
			messages: [{ role: "user", content: prompt }],
			tools: [tool],
			tool_choice: { type: "tool", name: "web_search" },
		},
		notes,
	};
}

function capSummary(text: string): { text: string; cut: boolean } {
	const points = Array.from(text);
	if (points.length <= MAX_SUMMARY_CHARS) return { text, cut: false };
	return { text: `${points.slice(0, MAX_SUMMARY_CHARS - 1).join("")}…`, cut: true };
}

/** content blocks → the hits, the cited passages and the answer Claude wrote over them */
export function parseClaudeResponse(json: unknown): ClaudeAnswer {
	const body = (json ?? {}) as RawResponse;
	if (!Array.isArray(body.content)) {
		throw new ProviderError("invalid_response", "Claude returned no content blocks");
	}
	const blocks = body.content;
	const lastResult = blocks.reduce((last, block, i) => (block.type === "web_search_tool_result" ? i : last), -1);
	const byUrl = new Map<string, Hit>();
	const citations: RawCitation[] = [];
	const errors: string[] = [];
	const texts: string[] = [];

	blocks.forEach((block, i) => {
		if (block.type === "web_search_tool_result") {
			if (Array.isArray(block.content)) {
				for (const result of block.content) {
					if (!result?.url) continue;
					const key = cleanUrl(result.url);
					const held = byUrl.get(key);
					if (held) {
						if (!held.date && result.page_age) held.date = result.page_age;
						continue;
					}
					byUrl.set(key, {
						url: result.url,
						title: result.title || result.url,
						date: result.page_age || undefined,
						passages: [],
					});
				}
			} else if (block.content?.error_code) {
				errors.push(block.content.error_code);
			}
			return;
		}
		if (block.type !== "text") return;
		if (typeof block.text === "string" && i > lastResult) texts.push(block.text);
		if (Array.isArray(block.citations)) citations.push(...block.citations);
	});

	for (const citation of citations) {
		const held = citation.url ? byUrl.get(cleanUrl(citation.url)) : undefined;
		const passage = citation.cited_text?.trim();
		if (held && passage && !held.passages.includes(passage)) held.passages.push(passage);
	}

	const summary = capSummary(texts.join("").trim());
	return {
		hits: [...byUrl.values()],
		summary: summary.text || undefined,
		summaryCut: summary.cut,
		searches: body.usage?.server_tool_use?.web_search_requests ?? 0,
		tokensIn: body.usage?.input_tokens ?? 0,
		tokensOut: body.usage?.output_tokens ?? 0,
		errors,
		stopReason: body.stop_reason,
	};
}

function claudeError(res: HttpResponse): ProviderError {
	let message = res.text;
	let type = "";
	try {
		const parsed = JSON.parse(res.text) as RawResponse;
		message = parsed.error?.message ?? message;
		type = parsed.error?.type ?? "";
	} catch {}
	if (isAnthropicRejection(message)) return new ProviderError("credits", clip(message, 300), res.status);
	if (type === "authentication_error") return new ProviderError("auth", clip(message, 300), res.status);
	return new ProviderError(kindForStatus(res.status), clip(message, 300), res.status, retryAfterSec(res.headers));
}

function searchErrorKind(code: string) {
	if (code === "too_many_requests") return "rate_limit" as const;
	if (code === "unavailable") return "unavailable" as const;
	return "bad_request" as const;
}

function tokenCount(tokens: number): string {
	return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}

function claudeHeaders(token: string): Record<string, string> {
	return {
		authorization: `Bearer ${token}`,
		"anthropic-version": "2023-06-01",
		"anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
		accept: "application/json",
		"user-agent": `claude-cli/${CLAUDE_CLI_VERSION}`,
		"x-app": "cli",
	};
}

/** the Claude plan's access token, refreshed by pi; undefined for an API key or a missing login */
export async function claudePlanToken(ctx: ExtensionToolContext | undefined): Promise<string | undefined> {
	try {
		const auth = await ctx?.modelRegistry.getProviderAuth("anthropic");
		return auth?.source === "OAuth" ? auth.auth.apiKey : undefined;
	} catch {
		return undefined;
	}
}

export interface ClaudeProviderOptions {
	model: string;
	maxUses: Record<SearchMode, number>;
	maxConcurrent?: number;
	thinking: boolean;
	token(ctx: ExtensionToolContext | undefined): Promise<string | undefined>;
}

export function createClaudeProvider(opts: ClaudeProviderOptions): SearchProvider {
	return {
		id: "claude",
		label: "Claude",
		missingKey: "no Claude plan login (run /login anthropic)",
		maxConcurrent: opts.maxConcurrent,
		resolveKey: opts.token,
		async search(call: ProviderCall): Promise<ProviderResult> {
			const { body, notes } = claudeBody(call.request, {
				model: opts.model,
				maxUses: opts.maxUses[call.request.mode],
				thinking: opts.thinking,
			});
			const res = await postJson(call.endpoint, {
				headers: claudeHeaders(call.key),
				body,
				timeoutMs: call.timeoutMs,
				signal: call.signal,
			});
			if (res.status !== 200) throw claudeError(res);
			const answer = parseClaudeResponse(parseJson<unknown>(res, "Claude"));
			if (!answer.hits.length && !answer.summary) {
				const code = answer.errors[0];
				throw new ProviderError(searchErrorKind(code ?? ""), `Claude returned no results${code ? ` (${code})` : ""}`);
			}

			if (answer.searches) {
				const searches = `${answer.searches} search${answer.searches === 1 ? "" : "es"}`;
				notes.push(`${searches}, ${tokenCount(answer.tokensIn)} tokens in / ${tokenCount(answer.tokensOut)} out (Claude plan)`);
			}
			if (answer.errors.includes("max_uses_exceeded")) {
				notes.push("Claude asked for more searches than the cap allowed");
			}
			const failed = [...new Set(answer.errors.filter((code) => code !== "max_uses_exceeded"))];
			if (failed.length) notes.push(`Claude's search reported ${failed.join(", ")}`);
			if (answer.stopReason === "max_tokens") notes.push("Claude's summary hit the output limit and was cut");
			if (answer.summaryCut) notes.push(`Claude's summary was cut to ${MAX_SUMMARY_CHARS.toLocaleString("en-US")} characters`);
			if (answer.stopReason === "pause_turn") notes.push("Claude paused the search; the results may be partial");

			return {
				hits: answer.hits.slice(0, call.request.maxResults),
				summary: answer.summary,
				costUsd: 0,
				notes,
			};
		},
	};
}
