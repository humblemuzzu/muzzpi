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
import { getExtensionConfig } from "./lib/config";
import { runSubAgent, toolError } from "./lib/run-sub-agent";
import { renderSubAgentResult } from "./lib/sub-agent-render";
import type { ToolCostDetails } from "./lib/tool-cost";
import { clip, parseJson, postJson, ProviderError, retryAfterSec } from "./lib/web/http";

export const CRAWLAPI_ENDPOINT = "https://api.crawlapi.dev/v1/scrape";
const KEY_ENV = "CRAWLAPI_API_KEY";
const SERVER_TIMEOUT_MS = 60_000;
const CLIENT_TIMEOUT_MS = 70_000;
const MAX_CHARS = 64_000;
const SUB_AGENT_MAX_CHARS = 400_000;
const RETRIES = 2;
const MAX_RETRY_WAIT_SEC = 10;
const RETRIED_CODES = new Set(["RATE_LIMITED", "ENGINE_FAILED", "INTERNAL"]);
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_PAGES = 16;
/** what a new account pays: the Starter pack, $10 for 15,000 credits. */
export const DEFAULT_USD_PER_CREDIT = 10 / 15_000;

const DEFAULT_PROMPT_SYSTEM = `Analyze web page content and answer questions. Be concise, answer from provided content only. No filler.`;

type Format = "markdown" | "json";

interface CrawlPage {
	success: true;
	request_id: string;
	data: {
		metadata: { title: string; final_url: string; truncated?: boolean; login_required?: boolean };
		markdown?: string | null;
		json?: object | null;
	};
	usage: { credits: number; remaining: number };
}

interface CrawlFailure {
	success: false;
	request_id: string;
	error: { code: string; message: string; retryable: boolean };
}

type CrawlResponse = CrawlPage | CrawlFailure;

/** a page as this process holds it: when it was fetched, so a repeat read can say how old it is. */
export interface HeldPage {
	page: CrawlPage;
	fetchedAt: number;
	/** set when this read was served from the in-process copy instead of a new request. */
	cachedAgeMs?: number;
}

export interface ReadWebPageDetails extends ToolCostDetails {
	credits: number;
	requestId: string;
	cached: boolean;
}

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

function ageText(ms: number): string {
	const minutes = Math.floor(ms / 60_000);
	return minutes > 0 ? `${minutes}m ago` : `${Math.max(1, Math.floor(ms / 1000))}s ago`;
}

/** crawlapi's own notes on a page: where it was read, what it cost, and what the text is not. */
export function pageNotes(held: HeldPage): string[] {
	const { page, cachedAgeMs } = held;
	const { metadata } = page.data;
	const { credits, remaining } = page.usage;
	const spent =
		cachedAgeMs !== undefined
			? `copy read ${ageText(cachedAgeMs)}, no credits spent`
			: `${credits} credit${credits === 1 ? "" : "s"}, ${remaining.toLocaleString("en-US")} left`;
	const notes = [`crawlapi read ${metadata.final_url} ("${clip(metadata.title, 120)}") · ${spent} · request ${page.request_id}`];
	if (metadata.login_required) notes.push("sign-in wall: this is the wall's own text, not the page");
	if (metadata.truncated) notes.push("crawlapi cut the page at its size cap; the rest of the page is not available");
	return notes;
}

/** the page as a reader gets it: one window of the content, at most `cap` characters, then crawlapi's notes. */
export function pageResult(held: HeldPage, format: Format, startIndex?: number, maxLength?: number, cap = MAX_CHARS): string {
	const { data } = held.page;
	const full = format === "json" ? JSON.stringify(data.json ?? {}) : (data.markdown ?? "");
	const from = Math.min(Math.max(0, Math.floor(startIndex ?? 0)), full.length);
	const length = Math.min(Math.max(1, Math.floor(maxLength ?? cap)), cap);
	const to = Math.min(full.length, from + length);
	const notes = pageNotes(held);
	if (from > 0 || to < full.length) {
		const rest = to < full.length ? `; pass start_index: ${to} for more` : "";
		notes.push(`characters ${from}–${to} of ${full.length}${rest}`);
	}
	return `${full.slice(from, to)}\n\n${notes.map((note) => `[${note}]`).join("\n")}`;
}

/** successful reads, kept for a few minutes so another window or another question on the same page is free. */
export class PageCache {
	private readonly pages = new Map<string, { page: CrawlPage; fetchedAt: number }>();

	constructor(private readonly now: () => number = Date.now) {}

	get(url: string, format: Format): HeldPage | undefined {
		const key = `${format} ${url}`;
		const hit = this.pages.get(key);
		if (!hit) return undefined;
		const age = this.now() - hit.fetchedAt;
		if (age >= CACHE_TTL_MS) {
			this.pages.delete(key);
			return undefined;
		}
		return { ...hit, cachedAgeMs: age };
	}

	put(url: string, format: Format, page: CrawlPage): HeldPage {
		const key = `${format} ${url}`;
		const held = { page, fetchedAt: this.now() };
		this.pages.delete(key);
		this.pages.set(key, held);
		while (this.pages.size > CACHE_PAGES) this.pages.delete(this.pages.keys().next().value!);
		return held;
	}
}

/** the price of one credit, from ext-config.json `read-web-page.usdPerCredit`. */
export function configuredUsdPerCredit(): number {
	const { usdPerCredit } = getExtensionConfig("read-web-page", { usdPerCredit: DEFAULT_USD_PER_CREDIT });
	return typeof usdPerCredit === "number" && usdPerCredit >= 0 ? usdPerCredit : DEFAULT_USD_PER_CREDIT;
}

export interface ReadWebPageConfig {
	systemPrompt?: string;
	models?: AgentModels;
	endpoint?: string;
	env?: Record<string, string | undefined>;
	usdPerCredit?: number;
	now?: () => number;
}

export function createReadWebPageTool(config: ReadWebPageConfig = {}): ToolDefinition {
	const models = config.models ?? emptyAgentModels();
	const endpoint = config.endpoint ?? CRAWLAPI_ENDPOINT;
	const usdPerCredit = config.usdPerCredit ?? DEFAULT_USD_PER_CREDIT;
	const cache = new PageCache(config.now);
	const renderAgentRun = renderSubAgentResult("read_web_page");

	return {
		name: "read_web_page",
		label: "Read Web Page",
		description:
			"Read the contents of a web page at a given URL.\n\n" +
			"Returns the page as Markdown with its links inline, or with format \"json\" its structured data: what the page declares " +
			"itself to be (a product, article, recipe, app, film or book, event, job, FAQ, business, video or X post) and its tables. " +
			"Use it whenever you need what a web page says: never fetch a page with curl and strip its HTML yourself.\n\n" +
			"Optional: an objective or a prompt hands the whole page to a small sub-agent that returns only the relevant verbatim " +
			"excerpts or an answer, which keeps a long page out of your context.\n\n" +
			"Pages are rendered, so content built by JavaScript is included; PDFs, Office files, CSV, JSON and feeds are read like pages. " +
			"Public http(s) URLs only: no sign-in, no localhost. Use `curl` via Bash for local URLs, HTTP APIs, headers or raw HTML.\n\n" +
			"Reading the same URL again within 10 minutes (the next window, another question) reuses the copy and costs nothing. " +
			"A failure returns an error code and whether a retry can help; never retry one that says it is not retryable.",

		parameters: Type.Object({
			url: Type.String({
				description: "The URL of the web page to read.",
			}),
			format: Type.Optional(
				Type.Union([Type.Literal("markdown"), Type.Literal("json")], {
					description:
						"markdown (default) for the page's text; json for what the page declares itself to be, its tables, JSON-LD and embedded data. " +
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
			const asksSubAgent = Boolean(params.prompt || params.objective);

			let route: ModelRoute = {};
			if (asksSubAgent) {
				const resolved = resolveRoute(models, "read_web_page", params, ctx.modelRegistry, false, mainRoute(ctx.model));
				if ("error" in resolved) return toolError(resolved.error);
				route = resolved;
			}

			let held = cache.get(url, format);
			if (!held) {
				try {
					const { body, retryAfter } = await scrape(endpoint, key, url, format, signal);
					if (body.success === false) return toolError(crawlErrorText(body, retryAfter));
					held = cache.put(url, format, body);
				} catch (err) {
					if (signal?.aborted) return toolError("read_web_page aborted");
					return toolError(`read_web_page: ${(err as Error).message}`);
				}
			}

			const cached = held.cachedAgeMs !== undefined;
			const credits = cached ? 0 : held.page.usage.credits;
			const details: ReadWebPageDetails = { cost: credits * usdPerCredit, credits, requestId: held.page.request_id, cached };

			if (!asksSubAgent) {
				const text = pageResult(held, format, params.start_index, params.max_length);
				return { content: [{ type: "text" as const, text }], details } as any;
			}

			const content = pageResult(held, format, params.start_index, params.max_length, SUB_AGENT_MAX_CHARS);
			const ask = params.prompt
				? `Answer this question: ${params.prompt}` +
					(params.objective ? `\n\nResearch goal behind it: ${params.objective}` : "")
				: `Quote, verbatim, every passage relevant to this goal: ${params.objective}\n\n` +
					"Quote only — no commentary. If nothing is relevant, say so.";
			const result = await runSubAgent({
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
			const answer = result.content[result.content.length - 1];
			if (answer?.type === "text") answer.text += `\n${pageNotes(held).map((note) => `[${note}]`).join("\n")}`;
			result.details.cost += details.cost;
			return result;
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

		renderResult(result: any, options: any, theme: any, context: any) {
			const fromSubAgent = typeof result.details?.agent === "string";
			return renderAgentRun(fromSubAgent ? result : { ...result, details: undefined }, options, theme, context);
		},
	};
}
