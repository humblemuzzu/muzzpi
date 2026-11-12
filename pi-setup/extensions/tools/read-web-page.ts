/**
 * read_web_page — one crawlapi.dev request per page. crawlapi renders the page,
 * reads documents and returns markdown or structured JSON; this file sends the
 * URL and lays the answer out for the model.
 * https://docs.crawlapi.dev/api-reference/scrape.md
 */

import { setTimeout as sleep } from "node:timers/promises";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { emptyAgentModels, mainRoute, modelParams, resolveRoute, type AgentModels, type ModelRoute } from "./lib/agent-models";
import { osc8Link } from "./lib/box-format";
import { runSubAgent, toolError } from "./lib/run-sub-agent";
import { clip, renderSubAgentResult } from "./lib/sub-agent-render";
import { parseJson, postJson, ProviderError, retryAfterSec } from "./lib/web/http";

export const CRAWLAPI_ENDPOINT = "https://api.crawlapi.dev/v1/scrape";
const KEY_ENV = "CRAWLAPI_API_KEY";
const SERVER_TIMEOUT_MS = 45_000;
const CLIENT_TIMEOUT_MS = 55_000;
const MAX_CHARS = 64_000;
const MAX_LINKS = 100;
const RETRIES = 2;
const MAX_RETRY_WAIT_SEC = 10;
const RETRIED_CODES = new Set(["RATE_LIMITED", "ENGINE_FAILED", "INTERNAL"]);

const DEFAULT_PROMPT_SYSTEM = `Analyze web page content and answer questions. Be concise, answer from provided content only. No filler.`;

type Format = "markdown" | "json";

interface CrawlPage {
	success: true;
	request_id: string;
	data: {
		metadata: { title: string; final_url: string; truncated?: boolean; login_required?: boolean };
		links: string[];
		markdown?: string | null;
		json?: { tables: unknown[]; jsonld: unknown[]; embedded: unknown[]; structured?: unknown } | null;
	};
	usage: { credits: number; remaining: number };
}

interface CrawlFailure {
	success: false;
	request_id: string;
	error: { code: string; message: string; retryable: boolean };
}

type CrawlResponse = CrawlPage | CrawlFailure;

async function scrape(
	endpoint: string,
	key: string,
	url: string,
	format: Format,
	signal?: AbortSignal,
): Promise<{ body: CrawlResponse; retryAfter?: number }> {
	for (let attempt = 0; ; attempt++) {
		const res = await postJson(endpoint, {
			headers: { Authorization: `Bearer ${key}` },
			body: { url, format, timeout: SERVER_TIMEOUT_MS },
			timeoutMs: CLIENT_TIMEOUT_MS,
			signal,
		});
		const body = parseJson<CrawlResponse>(res, "crawlapi");
		if (typeof body?.success !== "boolean") {
			throw new ProviderError("invalid_response", `crawlapi answered HTTP ${res.status} without a success flag`, res.status);
		}
		const wait = retryAfterSec(res.headers);
		if (body.success === true) return { body };
		const retry = RETRIED_CODES.has(body.error.code) && attempt < RETRIES && (wait ?? 1) <= MAX_RETRY_WAIT_SEC;
		if (!retry) return { body, retryAfter: wait };
		await sleep((wait ?? 1) * 1000, undefined, { signal });
	}
}

export function crawlErrorText(failure: CrawlFailure, retryAfter?: number): string {
	const { code, message, retryable } = failure.error;
	const retry = retryable
		? `retryable${retryAfter !== undefined ? ` after ${retryAfter}s` : " later"}`
		: "not retryable: the same request gets the same answer";
	return `crawlapi ${code}: ${message} (${retry}; request ${failure.request_id})`;
}

function pageBody(page: CrawlPage, format: Format): string {
	const { data } = page;
	let body: string;
	if (format === "json") {
		const { structured, tables, jsonld, embedded } = data.json ?? {};
		body = JSON.stringify({ structured, tables, jsonld, embedded });
	} else {
		body = data.markdown ?? "";
	}
	const links = [...new Set(data.links)];
	if (!links.length) return body;
	const hidden = links.length - MAX_LINKS;
	const list = links.slice(0, MAX_LINKS).join("\n") + (hidden > 0 ? `\n[${hidden} more links not shown]` : "");
	return `${body}\n\nLinks (${links.length}):\n${list}`;
}

/** the page as the model reads it: one window of the content, then crawlapi's notes. */
export function pageResult(page: CrawlPage, format: Format, startIndex?: number, maxLength?: number): string {
	const full = pageBody(page, format);
	const from = Math.min(Math.max(0, Math.floor(startIndex ?? 0)), full.length);
	const length = Math.min(Math.max(1, Math.floor(maxLength ?? MAX_CHARS)), MAX_CHARS);
	const to = Math.min(full.length, from + length);

	const { metadata } = page.data;
	const { credits, remaining } = page.usage;
	const notes = [
		`crawlapi read ${metadata.final_url} ("${clip(metadata.title, 120)}") · ${credits} credit${credits === 1 ? "" : "s"}, ${remaining.toLocaleString("en-US")} left`,
	];
	if (metadata.login_required) notes.push("sign-in wall: this is the wall's own text, not the page");
	if (metadata.truncated) notes.push("crawlapi cut the page at its size cap; the rest of the page is not available");
	if (from > 0 || to < full.length) {
		const rest = to < full.length ? `; pass start_index: ${to} for more` : "";
		notes.push(`characters ${from}–${to} of ${full.length}${rest}`);
	}
	return `${full.slice(from, to)}\n\n${notes.map((note) => `[${note}]`).join("\n")}`;
}

export interface ReadWebPageConfig {
	systemPrompt?: string;
	models?: AgentModels;
	endpoint?: string;
	env?: Record<string, string | undefined>;
}

export function createReadWebPageTool(config: ReadWebPageConfig = {}): ToolDefinition {
	const models = config.models ?? emptyAgentModels();
	const endpoint = config.endpoint ?? CRAWLAPI_ENDPOINT;
	return {
		name: "read_web_page",
		label: "Read Web Page",
		description:
			"Read the contents of a web page at a given URL.\n\n" +
			"Returns the page content converted to Markdown, or with format \"json\" its tables, JSON-LD and embedded data. " +
			"Use it whenever you need what a web page says: never fetch a page with curl and strip its HTML yourself.\n\n" +
			"When an objective is provided, a sub-agent returns verbatim excerpts relevant to that objective.\n\n" +
			"Pages are rendered, so content built by JavaScript is included; PDFs, Office files, CSV, JSON and feeds are read like pages. " +
			"Public http(s) URLs only: no sign-in, no localhost. Use `curl` via Bash for local URLs, HTTP APIs, headers or raw HTML.\n\n" +
			"A failure returns an error code and whether a retry can help; never retry one that says it is not retryable.",

		parameters: Type.Object({
			url: Type.String({
				description: "The URL of the web page to read.",
			}),
			format: Type.Optional(
				Type.Union([Type.Literal("markdown"), Type.Literal("json")], {
					description:
						"markdown (default) for the page's text; json for its tables, JSON-LD and embedded data. " +
						"A page with no structured data answers NO_CONTENT for json.",
				}),
			),
			objective: Type.Optional(
				Type.String({
					description:
						"A natural-language description of the research goal. " +
						"If set, a sub-agent returns only relevant verbatim excerpts. If not set, the full content is returned.",
				}),
			),
			prompt: Type.Optional(
				Type.String({
					description:
						"A question to answer about the page content. " +
						"Spawns an AI sub-agent that reads the page and returns a prose answer.",
				}),
			),
			start_index: Type.Optional(
				Type.Number({
					description: "Character offset to start from in the content (for pagination).",
				}),
			),
			max_length: Type.Optional(
				Type.Number({
					description: `Maximum number of characters to return (for pagination; at most ${MAX_CHARS.toLocaleString("en-US")}).`,
				}),
			),
			...modelParams(models, "read_web_page"),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const key = (config.env ?? process.env)[KEY_ENV]?.trim();
			if (!key) {
				return toolError(
					`read_web_page needs ${KEY_ENV}: create a key at https://app.crawlapi.dev/keys, export it in ~/.zshrc, then restart pi.`,
				);
			}
			const url = params.url;
			const format: Format = params.format === "json" ? "json" : "markdown";

			let route: ModelRoute = {};
			if (params.prompt || params.objective) {
				const resolved = resolveRoute(models, "read_web_page", params, ctx.modelRegistry, false, mainRoute(ctx.model));
				if ("error" in resolved) return toolError(resolved.error);
				route = resolved;
			}

			let page: CrawlPage;
			try {
				const { body, retryAfter } = await scrape(endpoint, key, url, format, signal);
				if (body.success === false) return toolError(crawlErrorText(body, retryAfter));
				page = body;
			} catch (err) {
				if (signal?.aborted) return toolError("read_web_page aborted");
				return toolError(`read_web_page: ${(err as Error).message}`);
			}

			const content = pageResult(page, format, params.start_index, params.max_length);

			if (params.prompt || params.objective) {
				const ask = params.prompt
					? `Answer this question: ${params.prompt}` +
						(params.objective ? `\n\nResearch goal behind it: ${params.objective}` : "")
					: `Quote, verbatim, every passage relevant to this goal: ${params.objective}\n\n` +
						"Quote only — no commentary. If nothing is relevant, say so.";
				return runSubAgent({
					agent: "read_web_page",
					label: params.prompt ?? params.objective,
					working: "(analyzing...)",
					ctx,
					signal,
					onUpdate,
					spawn: {
						task: `Here is the content of ${url}:\n\n${content}\n\n---\n\n${ask}`,
						model: route.model,
						thinkingLevel: route.thinking,
						builtinTools: ["read"],
						extensionTools: [],
						systemPromptBody: config.systemPrompt || DEFAULT_PROMPT_SYSTEM,
					},
				});
			}

			return { content: [{ type: "text" as const, text: content }] } as any;
		},

		renderCall(args: any, theme: any, context: any) {
			const text = context?.lastComponent ?? new Text("", 0, 0);
			const url = args.url || "...";
			const displayUrl = clip(url, 60);
			const linkedUrl = url.startsWith("http") ? osc8Link(url, displayUrl) : displayUrl;
			let label = theme.fg("toolTitle", theme.bold("read_web_page ")) + theme.fg("dim", linkedUrl);
			if (args.format === "json") label += theme.fg("muted", " json");
			const promptLabel = args.prompt || args.objective;
			if (promptLabel) label += theme.fg("muted", ` — ${clip(promptLabel, 40)}`);
			text.setText(label);
			return text;
		},

		renderResult: renderSubAgentResult("read_web_page"),
	};
}
