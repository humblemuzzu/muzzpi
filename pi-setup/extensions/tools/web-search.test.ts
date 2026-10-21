import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderHealth } from "./lib/web/health";
import { deepseekQuery } from "./lib/web/providers/deepseek";
import { contextBody } from "./lib/web/providers/context";
import { parallelBody } from "./lib/web/providers/parallel";
import { cleanUrl, type ProviderCall, type SearchRequest } from "./lib/web/types";
import { buildRequest, CONFIG_DEFAULTS, createWebSearchTool, type WebSearchExtConfig } from "./web-search";

type Reply = { status: number; body: unknown; delayMs?: number; headers?: Record<string, string> };
type Route = "context" | "deepseek" | "parallel";

const replies: Record<Route, (body: any) => Reply> = {} as any;
const seen: Record<Route, any[]> = { context: [], deepseek: [], parallel: [] };

const server = Bun.serve({
	port: 0,
	async fetch(req) {
		const route = new URL(req.url).pathname.slice(1) as Route;
		const body = await req.json();
		seen[route].push({ body, auth: req.headers.get("authorization") ?? req.headers.get("x-api-key") });
		const reply = replies[route](body);
		if (reply.delayMs) await Bun.sleep(reply.delayMs);
		return new Response(JSON.stringify(reply.body), {
			status: reply.status,
			headers: { "content-type": "application/json", ...reply.headers },
		});
	},
});
afterAll(() => server.stop(true));

const base = `http://127.0.0.1:${server.port}`;
const config: WebSearchExtConfig = {
	...CONFIG_DEFAULTS,
	endpoints: { context: `${base}/context`, deepseek: `${base}/deepseek`, parallel: `${base}/parallel` },
	timeoutSecs: { context: 2, deepseek: 2, parallel: 2 },
};
const allKeys = { CONTEXT_DEV_API_KEY: "ctx-key", DEEPSEEK_API_KEY: "ds-key", PARALLEL_API_KEY: "par-key" };

const contextOk = (n = 2): Reply => ({
	status: 200,
	body: {
		results: Array.from({ length: n }, (_, i) => ({
			url: `https://docs.example.com/page-${i}`,
			title: `Page ${i}`,
			description: `description ${i}`,
			relevance: "high",
			markdown: { markdown: null, code: "NOT_REQUESTED" },
			highlights: { highlights: [`passage ${i}a`, `passage ${i}b`], code: "SUCCESS" },
		})),
		query: "q",
		request_id: "r",
		cache_metadata: { status: "miss", age_ms: 0 },
		key_metadata: { credits_consumed: 2, credits_remaining: 998 },
	},
});
const deepseekOk = (prefix = "ds"): Reply => ({
	status: 200,
	body: {
		results: [
			{ title: `${prefix} one`, url: `https://${prefix}.example.org/one`, summary: `${prefix} summary one`, content: "", date: "2026-10-01T00:00:00+00:00" },
			{ title: `${prefix} two`, url: `https://${prefix}.example.org/two`, summary: `${prefix} summary two`, content: "" },
		],
	},
});
const parallelOk: Reply = {
	status: 200,
	body: { search_id: "s", results: [{ url: "https://p.example.net/a", title: "P", excerpts: ["parallel excerpt"] }], usage: [{ name: "sku_search", count: 1 }] },
};

let healthFile: string;
let health: ProviderHealth;
beforeEach(() => {
	for (const route of Object.keys(seen) as Route[]) seen[route] = [];
	replies.context = () => contextOk();
	replies.deepseek = () => deepseekOk();
	replies.parallel = () => parallelOk;
	healthFile = join(mkdtempSync(join(tmpdir(), "web-search-")), "health.json");
	health = new ProviderHealth(healthFile);
});

function tool(env: Record<string, string | undefined> = allKeys) {
	return createWebSearchTool(config, { env, health }) as any;
}
async function run(params: Record<string, unknown>, env?: Record<string, string | undefined>, signal?: AbortSignal) {
	const r = await tool(env).execute("t", params, signal, undefined, {});
	return { text: r.content[0].text as string, isError: Boolean(r.isError), details: r.details };
}

describe("web_search provider chain", () => {
	test("Context.dev answers first and its passages become the result", async () => {
		const r = await run({ objective: "how stripe auth works" });
		expect(r.isError).toBe(false);
		expect(r.text).toContain("### Page 0\nhttps://docs.example.com/page-0");
		expect(r.text).toContain("passage 0a");
		expect(r.text).toMatch(/\[via Context\.dev in \d+\.\ds \(2 credits, 998 left\)\]$/);
		expect(r.details.provider).toBe("context");
		expect(r.details.credits).toEqual({ used: 2, remaining: 998 });
		expect(seen.deepseek).toHaveLength(0);
		expect(seen.context[0].auth).toBe("Bearer ctx-key");
	});

	test("out of credits falls through to DeepSeek and holds Context.dev for later calls", async () => {
		replies.context = () => ({ status: 402, body: { message: "Insufficient credits", error_code: "USAGE_EXCEEDED", request_id: "r" } });
		const first = await run({ objective: "x" });
		expect(first.details.provider).toBe("deepseek");
		expect(first.text).toContain("via DeepSeek");
		expect(first.text).toContain("Context.dev: out of credits — HTTP 402: USAGE_EXCEEDED: Insufficient credits");

		const second = await run({ objective: "y" });
		expect(seen.context).toHaveLength(1);
		expect(second.text).toContain("Context.dev: out of credits");
		expect(second.text).toContain("skipped until");
	});

	test("a hold belongs to the key that earned it: a new key is tried again", async () => {
		replies.context = () => ({ status: 401, body: { message: "bad key", error_code: "UNAUTHORIZED", request_id: "r" } });
		await run({ objective: "x" });
		replies.context = () => contextOk();
		const r = await run({ objective: "x" }, { ...allKeys, CONTEXT_DEV_API_KEY: "new-key" });
		expect(r.details.provider).toBe("context");
		expect(seen.context).toHaveLength(2);
	});

	test("a short 429 moves on without holding the provider", async () => {
		replies.context = () => ({ status: 429, body: { message: "busy", error_code: "RATE_LIMITED", request_id: "r" }, headers: { "retry-after": "1" } });
		await run({ objective: "x" });
		replies.context = () => contextOk();
		const r = await run({ objective: "x" });
		expect(r.details.provider).toBe("context");
	});

	test("a provider that answers too slowly is a timeout, and the next one serves", async () => {
		replies.context = () => ({ ...contextOk(), delayMs: 2500 });
		const r = await run({ objective: "x" });
		expect(r.details.provider).toBe("deepseek");
		expect(r.text).toContain("Context.dev: timed out");
	});

	test("every provider failing is one error naming each provider and the fix", async () => {
		replies.deepseek = () => ({ status: 500, body: { error: { message: "boom" } } });
		replies.parallel = () => ({ status: 402, body: { type: "error", error: { message: "Insufficient credit in account" } } });
		const r = await run({ objective: "x" }, { DEEPSEEK_API_KEY: "ds", PARALLEL_API_KEY: "p" });
		expect(r.isError).toBe(true);
		expect(r.text).toContain("web_search failed on every provider:");
		expect(r.text).toContain("- Context.dev: not configured — CONTEXT_DEV_API_KEY is not set");
		expect(r.text).toContain("- DeepSeek: server error — HTTP 500: boom");
		expect(r.text).toContain("- Parallel: out of credits — HTTP 402: Insufficient credit in account");
		expect(r.text).toContain("Set CONTEXT_DEV_API_KEY in ~/.zshrc");
		expect(r.text).toContain("Top up Parallel");
	});

	test("no results anywhere is an empty answer, not an error", async () => {
		replies.context = () => ({ status: 200, body: { results: [], query: "q", request_id: "r", cache_metadata: { status: "miss", age_ms: 0 } } });
		replies.deepseek = () => ({ status: 200, body: { results: [] } });
		replies.parallel = () => ({ status: 200, body: { search_id: "s", results: [] } });
		const r = await run({ objective: "x" });
		expect(r.isError).toBe(false);
		expect(r.text).toStartWith("(no results found)");
		expect(r.text).toContain("Context.dev: no results");
	});

	test("a provider skipped for a missing key is named, so a quiet misconfiguration shows", async () => {
		const r = await run({ objective: "x" }, { DEEPSEEK_API_KEY: "ds" });
		expect(r.details.provider).toBe("deepseek");
		expect(r.text).toMatch(/\[via DeepSeek in \d+\.\ds · Context\.dev: not configured — CONTEXT_DEV_API_KEY is not set\]/);
	});

	test("fast mode asks DeepSeek first", async () => {
		const r = await run({ objective: "x", mode: "fast" });
		expect(r.details.provider).toBe("deepseek");
		expect(seen.context).toHaveLength(0);
	});

	test("Context.dev's concurrency limit is respected in-process: the third search goes elsewhere", async () => {
		replies.context = () => ({ ...contextOk(), delayMs: 400 });
		const t = tool();
		const results = await Promise.all([0, 1, 2].map(() => t.execute("t", { objective: "x" }, undefined, undefined, {})));
		const providers = results.map((r: any) => r.details.provider).sort();
		expect(providers).toEqual(["context", "context", "deepseek"]);
		expect(results.find((r: any) => r.details.provider === "deepseek").content[0].text).toContain("requests already in flight");
	});

	test("an abort stops the chain instead of falling through", async () => {
		replies.context = () => ({ ...contextOk(), delayMs: 1000 });
		const ac = new AbortController();
		setTimeout(() => ac.abort(), 100);
		const r = await run({ objective: "x" }, allKeys, ac.signal);
		expect(r.isError).toBe(true);
		expect(r.text).toContain("aborted");
		expect(seen.deepseek).toHaveLength(0);
	});

	test("DeepSeek runs each search query, interleaves them and drops duplicate URLs", async () => {
		replies.deepseek = (body) => (body.query.startsWith("alpha") ? deepseekOk("a") : deepseekOk("b"));
		const r = await run({ objective: "x", mode: "fast", search_queries: ["alpha", "beta"] });
		const urls = r.text.match(/^https:\/\/\S+$/gm);
		expect(urls).toEqual(["https://a.example.org/one", "https://b.example.org/one", "https://a.example.org/two", "https://b.example.org/two"]);
		expect(r.details.cost).toBeCloseTo(0.0015);
		expect(r.text).toContain("*2026-10-01*");
	});

	test("a stringified array from the model is accepted", async () => {
		await run({ objective: "x", mode: "fast", search_queries: '["one", "two"]' });
		expect(seen.deepseek.map((s) => s.body.query)).toEqual(["one", "two"]);
	});
});

test("result links lose tracking parameters and bare numeric fragments, nothing else", () => {
	expect(cleanUrl("https://bun.com/blog/bun-v1.4.1?utm_source=x&utm_medium=y&page=2#1")).toBe("https://bun.com/blog/bun-v1.4.1?page=2");
	expect(cleanUrl("https://medium.com/p/abc?source=post_page-----1")).toBe("https://medium.com/p/abc");
	expect(cleanUrl("https://docs.rs/tokio#select")).toBe("https://docs.rs/tokio#select");
	expect(cleanUrl("not a url")).toBe("not a url");
});

describe("web_search arguments", () => {
	test("bad arguments are refused with the reason", () => {
		expect(buildRequest({ objective: " " }, CONFIG_DEFAULTS)).toContain("objective is required");
		expect(buildRequest({ objective: "x", mode: "turbo" }, CONFIG_DEFAULTS)).toContain("mode must be one of");
		expect(buildRequest({ objective: "x", freshness: "hour" }, CONFIG_DEFAULTS)).toContain("freshness must be one of");
		expect(buildRequest({ objective: "x", languages: ["english"] }, CONFIG_DEFAULTS)).toContain('not "english"');
		expect(buildRequest({ objective: "x", country: "USA" }, CONFIG_DEFAULTS)).toContain('not "usa"');
		expect(buildRequest({ objective: "x", languages: ["en", "de", "fr", "es", "it", "ja"] }, CONFIG_DEFAULTS)).toContain("at most 5 languages");
		expect((buildRequest({ objective: "x", languages: ["EN", "en", "ja"] }, CONFIG_DEFAULTS) as SearchRequest).languages).toEqual(["en", "ja"]);
	});

	test("domains are reduced to their host, and max_results is capped", () => {
		const req = buildRequest(
			{ objective: "x", include_domains: ["https://www.Stripe.com/docs/api", "github.com/"], max_results: 500 },
			CONFIG_DEFAULTS,
		) as SearchRequest;
		expect(req.includeDomains).toEqual(["stripe.com", "github.com"]);
		expect(req.maxResults).toBe(50);
	});
});

describe("provider request bodies", () => {
	const request = (over: Partial<SearchRequest> = {}): SearchRequest => ({
		objective: "find the thing",
		queries: [],
		maxResults: 10,
		mode: "one-shot",
		includeDomains: [],
		excludeDomains: [],
		languages: [],
		...over,
	});
	const call = (req: SearchRequest): ProviderCall => ({ request: req, key: "k", endpoint: "http://x", timeoutMs: 30_000 });

	test("Context.dev gets its filter names, passage size by mode, and unsupported languages are reported", () => {
		const { body, notes } = contextBody(call(request({ freshness: "week", languages: ["en", "xx"], includeDomains: ["a.com"] })));
		expect(body).toMatchObject({ freshness: "last_week", languages: ["en"], includeDomains: ["a.com"], highlightsOptions: { enabled: true, maxCharacters: 2000 } });
		expect(notes[0]).toContain("xx");
		expect(contextBody(call(request({ mode: "fast" }))).body.highlightsOptions).toBeUndefined();
	});

	test("DeepSeek's query keeps every operator inside 128 characters and says what it dropped", () => {
		const notes: string[] = [];
		const many = Array.from({ length: 12 }, (_, i) => `site-number-${i}.example.com`);
		const q = deepseekQuery("a fairly long natural language question about something specific", call(request({ includeDomains: many, languages: ["en"] })), notes);
		expect(q.length).toBeLessThanOrEqual(128);
		expect(q).toContain("lang:en");
		expect(q).toContain("site:site-number-0.example.com");
		expect(notes[0]).toMatch(/fit \d+ of 12 include_domains/);
	});

	test("no combination of filters pushes a DeepSeek query past 128 characters", () => {
		const q = deepseekQuery("x".repeat(300), call(request({ languages: ["en", "de", "fr", "es", "ja"], freshness: "week", includeDomains: ["a".repeat(120) + ".com"] })), []);
		expect(q.length).toBeLessThanOrEqual(128);
	});

	test("Parallel gets a source policy, and include wins over exclude as Parallel documents", () => {
		const { body, notes } = parallelBody(call(request({ includeDomains: ["a.com"], excludeDomains: ["b.com"], freshness: "year" })));
		expect((body.source_policy as any).include_domains).toEqual(["a.com"]);
		expect((body.source_policy as any).exclude_domains).toBeUndefined();
		expect((body.source_policy as any).after_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(notes[0]).toContain("exclude_domains ignored");
	});
});
