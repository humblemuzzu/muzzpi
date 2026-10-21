/**
 * web_search — one tool over several search providers. Each provider is tried
 * in the configured order until one returns results; the answer names the
 * provider that served it and why any before it were passed over.
 */

import * as path from "node:path";
import { getAgentDir, type ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { boxRendererWindowed, osc8Link, type BoxSection, type Excerpt } from "./lib/box-format";
import { getEnabledExtensionConfig, type ExtensionConfigSchema } from "./lib/config";
import { stringList } from "./lib/params";
import { argumentPreparer } from "./lib/tool-args";
import { withPromptPatch } from "./lib/prompt-patch";
import type { ToolCostDetails } from "./lib/tool-cost";
import { searchWithFallback, type Attempt } from "./lib/web/chain";
import { ProviderHealth } from "./lib/web/health";
import { ProviderError, type FailureKind } from "./lib/web/http";
import { CONTEXT_ENDPOINT, createContextProvider } from "./lib/web/providers/context";
import { createDeepSeekProvider, DEEPSEEK_ENDPOINT } from "./lib/web/providers/deepseek";
import { createParallelProvider, PARALLEL_ENDPOINT } from "./lib/web/providers/parallel";
import {
	cleanUrl,
	FRESHNESS,
	PROVIDER_IDS,
	SEARCH_MODES,
	type Freshness,
	type Hit,
	type ProviderId,
	type SearchMode,
	type SearchProvider,
	type SearchRequest,
} from "./lib/web/types";

export type WebSearchExtConfig = {
	defaultMaxResults: number;
	defaultMode: SearchMode;
	order: ProviderId[];
	/** a mode listed here uses its own order instead of `order`. */
	orderByMode: Partial<Record<SearchMode, ProviderId[]>>;
	timeoutSecs: Record<ProviderId, number>;
	endpoints: Record<ProviderId, string>;
	contextUsdPerCredit: number;
};

export const CONFIG_DEFAULTS: WebSearchExtConfig = {
	defaultMaxResults: 10,
	defaultMode: "one-shot",
	order: ["context", "deepseek", "parallel"],
	orderByMode: { fast: ["deepseek", "context", "parallel"] },
	timeoutSecs: { context: 30, deepseek: 15, parallel: 30 },
	endpoints: { context: CONTEXT_ENDPOINT, deepseek: DEEPSEEK_ENDPOINT, parallel: PARALLEL_ENDPOINT },
	contextUsdPerCredit: 0,
};

const MAX_RESULTS_CAP = 50;
const MAX_LANGUAGES = 5;

export const prepareWebArguments = argumentPreparer(
	"web_search",
	{
		objective: { aliases: ["query", "q", "question", "prompt", "task", "search", "topic", "goal", "request"] },
		search_queries: { list: true, aliases: ["queries", "keywords", "terms", "search_query", "query_list", "searches"] },
		max_results: { number: true, aliases: ["limit", "count", "num_results", "results", "n", "size", "top_k"] },
		mode: {
			aliases: ["depth", "search_mode", "effort"],
			values: {
				fast: ["quick", "turbo", "lite", "basic", "shallow", "instant"],
				"one-shot": ["oneshot", "default", "normal", "standard", "balanced", "auto"],
				agentic: ["deep", "advanced", "thorough", "research", "comprehensive", "pro"],
			},
			valuesHelp: "fast (~1s, title and summary), one-shot (the default, matching passages), agentic (longer passages and page text)",
		},
		include_domains: { list: true, aliases: ["domains", "sites", "site", "include", "include_sites", "only_domains", "allowed_domains"] },
		exclude_domains: { list: true, aliases: ["exclude", "exclude_sites", "blocked_domains", "block", "excluded_domains"] },
		freshness: {
			aliases: ["recency", "time_range", "timeframe", "since", "published_within", "period", "date_range"],
			values: {
				day: ["24h", "1d", "today", "daily", "last_24_hours", "last_day", "d"],
				week: ["7d", "last_week", "weekly", "w"],
				month: ["30d", "last_month", "monthly", "m"],
				year: ["365d", "12m", "last_year", "yearly", "y"],
			},
			valuesHelp: "day, week, month or year",
		},
		languages: { list: true, aliases: ["language", "lang", "langs", "locale"] },
		country: { aliases: ["region", "location", "geo", "gl", "country_code"] },
	},
	'Example: web_search({ objective: "How SvelteKit remote functions work", search_queries: ["sveltekit remote functions"], mode: "fast" })',
);

const isPositiveInt = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 1;
const isProviderId = (v: unknown): v is ProviderId => (PROVIDER_IDS as readonly unknown[]).includes(v);
const isOrder = (v: unknown) =>
	Array.isArray(v) && v.length > 0 && v.every(isProviderId) && new Set(v).size === v.length;
const isProviderMap = (v: unknown, check: (x: unknown) => boolean) =>
	typeof v === "object" && v !== null && PROVIDER_IDS.every((id) => check((v as Record<string, unknown>)[id]));

function isWebSearchConfig(value: Record<string, unknown>): value is WebSearchExtConfig {
	const byMode = value.orderByMode;
	return (
		isPositiveInt(value.defaultMaxResults) &&
		(SEARCH_MODES as readonly unknown[]).includes(value.defaultMode) &&
		isOrder(value.order) &&
		typeof byMode === "object" && byMode !== null &&
		Object.entries(byMode).every(([mode, order]) => (SEARCH_MODES as readonly string[]).includes(mode) && isOrder(order)) &&
		isProviderMap(value.timeoutSecs, isPositiveInt) &&
		isProviderMap(value.endpoints, (e) => typeof e === "string" && /^https?:\/\//.test(e)) &&
		typeof value.contextUsdPerCredit === "number" && value.contextUsdPerCredit >= 0
	);
}

const WEB_SEARCH_CONFIG_SCHEMA: ExtensionConfigSchema<WebSearchExtConfig> = { validate: isWebSearchConfig };

const KIND_LABEL: Record<FailureKind, string> = {
	missing_key: "not configured",
	auth: "key rejected",
	credits: "out of credits",
	rate_limit: "rate limited",
	bad_request: "rejected the request",
	timeout: "timed out",
	unavailable: "server error",
	network: "unreachable",
	invalid_response: "unreadable response",
	aborted: "aborted",
};

const COLLAPSED_EXCERPTS: Excerpt[] = [{ focus: "head", context: 5 }];

export interface WebSearchDetails extends ToolCostDetails {
	provider?: ProviderId;
	attempts: Attempt[];
	credits?: { used: number; remaining: number };
	notes: string[];
	matchLineIndices?: number[];
	resultSections?: BoxSection[];
}

export interface WebSearchDeps {
	env?: Record<string, string | undefined>;
	health?: ProviderHealth;
	providers?: Record<ProviderId, SearchProvider>;
}

function defaultProviders(config: WebSearchExtConfig): Record<ProviderId, SearchProvider> {
	return {
		context: createContextProvider({ usdPerCredit: config.contextUsdPerCredit }),
		deepseek: createDeepSeekProvider(),
		parallel: createParallelProvider(),
	};
}

function domainOf(input: string): string {
	return input.trim().replace(/^[a-z]+:\/\//i, "").replace(/^www\./i, "").split(/[/?#]/)[0].toLowerCase();
}

/** turns raw tool arguments into a request, or says what is wrong with them. */
export function buildRequest(params: Record<string, unknown>, config: WebSearchExtConfig): SearchRequest | string {
	const objective = typeof params.objective === "string" ? params.objective.trim() : "";
	if (!objective) return "objective is required: describe what you are looking for";
	const mode = params.mode ?? config.defaultMode;
	if (!(SEARCH_MODES as readonly unknown[]).includes(mode)) return `mode must be one of ${SEARCH_MODES.join(", ")}`;
	const freshness = params.freshness;
	if (freshness !== undefined && !(FRESHNESS as readonly unknown[]).includes(freshness)) {
		return `freshness must be one of ${FRESHNESS.join(", ")}`;
	}
	const rawMax = params.max_results ?? config.defaultMaxResults;
	const maxResults = Math.round(Number(rawMax));
	if (!Number.isFinite(maxResults) || maxResults < 1) return "max_results must be a positive number";
	const languages = [...new Set(stringList(params.languages).map((l) => l.toLowerCase()))];
	if (languages.length > MAX_LANGUAGES) return `at most ${MAX_LANGUAGES} languages`;
	const badLang = languages.find((l) => !/^[a-z]{2,3}$/.test(l));
	if (badLang) return `languages takes ISO 639-1 codes such as "en" or "ja", not "${badLang}"`;
	const country = typeof params.country === "string" && params.country.trim() ? params.country.trim().toLowerCase() : undefined;
	if (country && !/^[a-z]{2}$/.test(country)) return `country takes a two-letter code such as "us" or "de", not "${country}"`;
	return {
		objective,
		queries: stringList(params.search_queries),
		maxResults: Math.min(maxResults, MAX_RESULTS_CAP),
		mode: mode as SearchMode,
		includeDomains: stringList(params.include_domains).map(domainOf).filter(Boolean),
		excludeDomains: stringList(params.exclude_domains).map(domainOf).filter(Boolean),
		freshness: freshness as Freshness | undefined,
		languages,
		country,
	};
}

export function formatHits(hits: Hit[]): { text: string; headerLineIndices: number[] } {
	if (!hits.length) return { text: "(no results found)", headerLineIndices: [] };
	const lines: string[] = [];
	const headerLineIndices: number[] = [];
	hits.forEach((hit, i) => {
		if (i > 0) lines.push("", "---", "");
		headerLineIndices.push(lines.length);
		lines.push(`### ${hit.title || "(untitled)"}`, hit.url);
		if (hit.date) lines.push(`*${hit.date}*`);
		hit.passages.forEach((passage, j) => {
			lines.push("");
			lines.push(...passage.split("\n"));
			if (j < hit.passages.length - 1) lines.push("");
		});
	});
	return { text: lines.join("\n"), headerLineIndices };
}

function hitsToSections(hits: Hit[]): BoxSection[] {
	return hits.map((hit) => {
		const lines = [{ text: osc8Link(hit.url, hit.url), highlight: true }];
		if (hit.date) lines.push({ text: hit.date, highlight: true });
		for (const passage of hit.passages) {
			lines.push({ text: "", highlight: false });
			for (const line of passage.split("\n")) lines.push({ text: line, highlight: false });
		}
		return { header: hit.title || "(untitled)", blocks: [{ lines }] };
	});
}

function attemptLine(a: Attempt, label: string, maxReason = Number.POSITIVE_INFINITY): string {
	const reason = a.reason && a.reason.length > maxReason ? `${a.reason.slice(0, maxReason - 1)}…` : a.reason;
	return `${label}: ${KIND_LABEL[a.kind ?? "invalid_response"]}${reason ? ` — ${reason}` : ""}`;
}

/** one line saying who answered and why earlier providers did not; the model reads it, so it is plain words. */
export function sourceLine(
	attempts: Attempt[],
	providers: Record<ProviderId, SearchProvider>,
	credits?: { used: number; remaining: number },
): string {
	const served = attempts.find((a) => a.outcome === "ok");
	const passed = attempts.filter((a) => a !== served && a.outcome !== "ok");
	const spent = credits ? ` (${credits.used} credits, ${credits.remaining.toLocaleString("en-US")} left)` : "";
	const parts = served
		? [`via ${providers[served.provider].label} in ${((served.ms ?? 0) / 1000).toFixed(1)}s${spent}`]
		: ["no provider found results"];
	for (const a of passed) {
		parts.push(a.outcome === "empty" ? `${providers[a.provider].label}: no results` : attemptLine(a, providers[a.provider].label, 140));
	}
	return parts.join(" · ");
}

function failureText(attempts: Attempt[], providers: Record<ProviderId, SearchProvider>): string {
	const lines = ["web_search failed on every provider:"];
	for (const a of attempts) lines.push(`- ${attemptLine(a, providers[a.provider].label)}`);
	const missing = attempts.filter((a) => a.kind === "missing_key").map((a) => providers[a.provider].keyEnv);
	const credits = attempts.filter((a) => a.kind === "credits").map((a) => providers[a.provider].label);
	if (missing.length) lines.push(`Set ${missing.join(" or ")} in ~/.zshrc, then start a new shell and pi.`);
	if (credits.length) lines.push(`Top up ${credits.join(" or ")}, or set another provider's key.`);
	return lines.join("\n");
}

function errorResult(text: string, details?: WebSearchDetails) {
	return { content: [{ type: "text" as const, text }], isError: true, ...(details && { details }) } as any;
}

export function createWebSearchTool(config: WebSearchExtConfig = CONFIG_DEFAULTS, deps: WebSearchDeps = {}): ToolDefinition<any> {
	const providers = deps.providers ?? defaultProviders(config);
	const timeoutMs = Object.fromEntries(PROVIDER_IDS.map((id) => [id, config.timeoutSecs[id] * 1000])) as Record<ProviderId, number>;
	let health = deps.health;

	return {
		name: "web_search",
		label: "Web Search",
		prepareArguments: prepareWebArguments,
		description:
			"Search the web for information relevant to a research objective.\n\n" +
			"Use when you need up-to-date or precise documentation. Use `read_web_page` to fetch full content from a " +
			"specific URL, and `x_search` for posts on X. Providers are tried in turn (Context.dev, DeepSeek, Parallel); " +
			"the result ends with the one that answered.\n\n" +
			'Example: web_search({ objective: "The request fields of the Stripe create-customer API. Prefer Stripe\'s docs.", include_domains: ["stripe.com"] })\n' +
			'Example: web_search({ objective: "How SvelteKit remote functions work; shipped last month.", search_queries: ["sveltekit remote functions"], freshness: "month" })',

		parameters: Type.Object({
			objective: Type.String({
				description:
					"A natural-language description of the broader task or research goal, including any source or freshness guidance.",
			}),
			search_queries: Type.Optional(
				Type.Array(Type.String(), {
					description: "Optional keyword queries (3–6 words each) so specific terms are matched; 1–3 work best.",
				}),
			),
			max_results: Type.Optional(
				Type.Number({ description: `Optional. Results to return (default ${config.defaultMaxResults}, at most ${MAX_RESULTS_CAP}).` }),
			),
			mode: Type.Optional(
				Type.Union(SEARCH_MODES.map((m) => Type.Literal(m)), {
					description:
						`Optional retrieval depth (default ${config.defaultMode}). ` +
						"'fast' ~1s: title and a short summary per page — for a single fact, a version, whether an API exists. " +
						"'one-shot' ~5–12s: the passages of each page that match the objective — the default for documentation. " +
						"'agentic': longer passages plus page text — for comparisons and questions one passage will not answer.",
				}),
			),
			include_domains: Type.Optional(
				Type.Array(Type.String(), { description: 'Optional. Only return results from these domains, e.g. ["docs.python.org"].' }),
			),
			exclude_domains: Type.Optional(
				Type.Array(Type.String(), { description: 'Optional. Never return results from these domains, e.g. ["pinterest.com"].' }),
			),
			freshness: Type.Optional(
				Type.Union(FRESHNESS.map((f) => Type.Literal(f)), {
					description: "Optional. Only pages published within the last day, week, month or year.",
				}),
			),
			languages: Type.Optional(
				Type.Array(Type.String(), { description: 'Optional. ISO 639-1 codes of the languages to return, e.g. ["en", "ja"].' }),
			),
			country: Type.Optional(
				Type.String({ description: 'Optional. Two-letter country code to localize results, e.g. "de".' }),
			),
		}),

		async execute(_toolCallId, params, signal) {
			const request = buildRequest(params as Record<string, unknown>, config);
			if (typeof request === "string") return errorResult(request);

			const env = deps.env ?? process.env;
			const order = config.orderByMode[request.mode] ?? config.order;
			health ??= new ProviderHealth(path.join(getAgentDir(), "cache", "web-search-health.json"));

			let chain;
			try {
				chain = await searchWithFallback(request, {
					order,
					providers,
					keys: Object.fromEntries(order.map((id) => [id, env[providers[id].keyEnv]?.trim() || undefined])),
					endpoints: config.endpoints,
					timeoutMs,
					health,
					signal,
				});
			} catch (err) {
				const aborted = err instanceof ProviderError && err.kind === "aborted";
				return errorResult(aborted ? "web_search aborted" : `web_search failed: ${(err as Error).message}`);
			}

			const { result, attempts } = chain;
			if (!result) {
				return errorResult(failureText(attempts, providers), { cost: 0, attempts, notes: [] });
			}

			const source = sourceLine(attempts, providers, result.credits);
			const hits = result.hits.map((hit) => ({ ...hit, url: cleanUrl(hit.url) }));
			const { text, headerLineIndices } = formatHits(hits);
			const trailer = [source, ...result.notes].map((line) => `[${line}]`).join("\n");
			const details: WebSearchDetails = {
				cost: result.costUsd,
				provider: chain.provider,
				attempts,
				credits: result.credits,
				notes: result.notes,
				matchLineIndices: headerLineIndices,
				resultSections: hitsToSections(hits),
			};
			return { content: [{ type: "text" as const, text: `${text}\n\n${trailer}` }], details };
		},

		renderCall(args: any, theme: any) {
			const objective = String(args.objective ?? "...");
			const short = objective.length > 70 ? `${objective.slice(0, 70)}...` : objective;
			let text = theme.fg("toolTitle", theme.bold("web_search ")) + theme.fg("dim", short);
			const queries = stringList(args.search_queries);
			if (queries.length) text += theme.fg("muted", ` [${queries.join(", ")}]`);
			const filters = [
				...stringList(args.include_domains).map((d) => `site:${d}`),
				...stringList(args.exclude_domains).map((d) => `-site:${d}`),
				args.freshness && `past ${args.freshness}`,
				args.mode && args.mode !== config.defaultMode && args.mode,
			].filter(Boolean);
			if (filters.length) text += theme.fg("muted", ` · ${filters.join(" ")}`);
			return new Text(text, 0, 0);
		},

		renderResult(result: any, { expanded }: { expanded: boolean }) {
			const details = result.details as WebSearchDetails | undefined;
			const sections = details?.resultSections;
			if (!details || !sections?.length) {
				const text = result.content?.[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}
			const notices = [sourceLine(details.attempts, providers, details.credits), ...details.notes];
			return boxRendererWindowed(
				() => sections,
				{ collapsed: { maxSections: 3, excerpts: COLLAPSED_EXCERPTS }, expanded: {} },
				notices,
				expanded,
			);
		},
	};
}

/** the tool as registered: config resolved (defaults → global → project) and prompt-patched; null when disabled. */
export function createConfiguredWebSearchTool(): ToolDefinition<any> | null {
	const { enabled, config } = getEnabledExtensionConfig("web-search", CONFIG_DEFAULTS, { schema: WEB_SEARCH_CONFIG_SCHEMA });
	if (!enabled) return null;
	return withPromptPatch(createWebSearchTool(config));
}
