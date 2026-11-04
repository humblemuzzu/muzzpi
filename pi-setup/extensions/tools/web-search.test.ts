import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchWithFallback, type ChainOptions } from "./lib/web/chain";
import { ProviderHealth } from "./lib/web/health";
import { ProviderError } from "./lib/web/http";
import { contextBody, createContextProvider } from "./lib/web/providers/context";
import { createDeepSeekProvider, deepseekQuery } from "./lib/web/providers/deepseek";
import { createParallelProvider, parallelBody } from "./lib/web/providers/parallel";
import { cleanUrl, type Hit, type ProviderCall, type ProviderId, type SearchProvider, type SearchRequest } from "./lib/web/types";
import { buildRequest, CONFIG_DEFAULTS, createWebSearchTool, formatCappedHits, type WebSearchExtConfig } from "./web-search";

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

function tool(env: Record<string, string | undefined> = allKeys, now?: () => number) {
	return createWebSearchTool(config, { env, health, now }) as any;
}
async function runOn(t: any, params: Record<string, unknown>, signal?: AbortSignal) {
	const r = await t.execute("t", params, signal, undefined, {});
	return { text: r.content[0].text as string, isError: Boolean(r.isError), details: r.details };
}
async function run(params: Record<string, unknown>, env?: Record<string, string | undefined>, signal?: AbortSignal) {
	return runOn(tool(env), params, signal);
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
		expect(r.text).toContain("[Context.dev found no results]");
		expect(r.text).not.toContain("no provider found results");
		expect(seen.deepseek).toHaveLength(0);
		expect(seen.parallel).toHaveLength(0);
	});

	test("an empty DeepSeek answer is not final: the next provider is asked", async () => {
		replies.deepseek = () => ({ status: 200, body: { results: [] } });
		const r = await run({ objective: "x", mode: "fast" });
		expect(r.details.provider).toBe("context");
		expect(r.text).toContain("DeepSeek: no results");
		expect(seen.deepseek).toHaveLength(1);
	});

	test("when only non-final providers find nothing, the answer says so once", async () => {
		replies.deepseek = () => ({ status: 200, body: { results: [] } });
		const r = await run({ objective: "x" }, { DEEPSEEK_API_KEY: "ds" });
		expect(r.text).toContain("[DeepSeek found no results · Context.dev: not configured");
		expect(r.text).not.toContain("DeepSeek: no results");
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
		const results = await Promise.all([0, 1, 2].map((i) => t.execute("t", { objective: `x${i}` }, undefined, undefined, {})));
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

const PINNED_TOOL_TEXT_SHA256 = "72442a2d975b69e418df8eb9c81708d51d62a062f715afe92cdd4d81017c4139";

test("the label, description and parameters in the cached prompt do not change", () => {
	const t = createWebSearchTool(CONFIG_DEFAULTS, { env: {} }) as any;
	const text = JSON.stringify({ label: t.label, description: t.description, parameters: t.parameters });
	expect(createHash("sha256").update(text).digest("hex")).toBe(PINNED_TOOL_TEXT_SHA256);
});

const fakeHit = (url: string, passage = "p"): Hit => ({ url, title: url, passages: [passage] });
const fakeResult = (urls: string[], passage?: string) => ({ hits: urls.map((u) => fakeHit(u, passage)), costUsd: 0.01, credits: { used: 2, remaining: 98 }, notes: [] });
const providerSet = (search: (id: ProviderId, call: ProviderCall) => Promise<ReturnType<typeof fakeResult>>): Record<ProviderId, SearchProvider> => ({
	context: { ...createContextProvider({ usdPerCredit: 0 }), search: (call) => search("context", call) },
	deepseek: { ...createDeepSeekProvider(), search: (call) => search("deepseek", call) },
	parallel: { ...createParallelProvider(), search: (call) => search("parallel", call) },
});
const fakeTool = (providers: Record<ProviderId, SearchProvider>, now: () => number = Date.now) =>
	createWebSearchTool(config, { env: allKeys, health, providers, now }) as any;

describe("the total time limit", () => {
	const request: SearchRequest = { objective: "x", queries: [], maxResults: 10, mode: "one-shot", includeDomains: [], excludeDomains: [], languages: [] };
	const chainOptions = (providers: Record<ProviderId, SearchProvider>, now: () => number, over: Partial<ChainOptions> = {}): ChainOptions => ({
		order: ["context", "deepseek", "parallel"],
		providers,
		keys: { context: "k", deepseek: "k", parallel: "k" },
		endpoints: { context: "http://c", deepseek: "http://d", parallel: "http://p" },
		timeoutMs: { context: 30_000, deepseek: 15_000, parallel: 30_000 },
		health,
		now,
		...over,
	});

	test("a provider that spends the budget leaves the rest skipped, and the remaining time caps each timeout", async () => {
		let clock = 1_000_000;
		const timeouts: number[] = [];
		const providers = providerSet(async (id, call) => {
			timeouts.push(call.timeoutMs);
			clock += 44_500;
			throw new ProviderError("unavailable", `${id} down`);
		});
		const r = await searchWithFallback(request, chainOptions(providers, () => clock, { deadlineAt: clock + 45_000 }));
		expect(timeouts).toEqual([30_000]);
		expect(r.result).toBeUndefined();
		expect(r.attempts.map((a) => [a.provider, a.outcome])).toEqual([["context", "failed"], ["deepseek", "skipped"]]);
		expect(r.attempts[1]).toMatchObject({ kind: "timeout", reason: "the search's total time limit" });
	});

	test("a provider is given no more than what is left", async () => {
		const clock = 5_000;
		const timeouts: number[] = [];
		const providers = providerSet(async (_id, call) => {
			timeouts.push(call.timeoutMs);
			return fakeResult(["https://a.com/1"]);
		});
		await searchWithFallback(request, chainOptions(providers, () => clock, { deadlineAt: clock + 12_345 }));
		expect(timeouts).toEqual([12_345]);
	});

	test("under a second left, nothing is started", async () => {
		const clock = 5_000;
		const providers = providerSet(async () => {
			throw new Error("must not run");
		});
		const r = await searchWithFallback(request, chainOptions(providers, () => clock, { deadlineAt: clock + 999 }));
		expect(r.attempts).toEqual([{ provider: "context", outcome: "skipped", kind: "timeout", reason: "the search's total time limit" }]);
	});

	test("the caller's abort wins over the time limit", async () => {
		const ac = new AbortController();
		ac.abort();
		const providers = providerSet(async () => fakeResult(["https://a.com/1"]));
		await expect(searchWithFallback(request, chainOptions(providers, () => 5_000, { deadlineAt: 5_000, signal: ac.signal }))).rejects.toMatchObject({ kind: "aborted" });
	});

	test("an empty answer found before the limit is returned when the limit then stops the chain", async () => {
		let clock = 0;
		const providers = providerSet(async () => {
			clock += 44_500;
			return fakeResult([]);
		});
		const r = await searchWithFallback(request, chainOptions(providers, () => clock, { order: ["deepseek", "parallel"], deadlineAt: 45_000 }));
		expect(r.provider).toBe("deepseek");
		expect(r.result?.hits).toEqual([]);
		expect(r.attempts.map((a) => a.outcome)).toEqual(["empty", "skipped"]);
	});
});

describe("identical searches are answered once", () => {
	const gate = () => {
		let open!: () => void;
		const opened = new Promise<void>((r) => (open = r));
		return { open, opened };
	};

	test("two identical searches in flight share one provider call", async () => {
		const g = gate();
		let calls = 0;
		const t = fakeTool(providerSet(async () => {
			calls++;
			await g.opened;
			return fakeResult(["https://a.com/1"]);
		}));
		const first = runOn(t, { objective: "same" });
		const second = runOn(t, { objective: "same" });
		g.open();
		const both = await Promise.all([first, second]);
		expect(calls).toBe(1);
		expect(both.filter((r) => r.text.includes("reused the result of an identical search")).length).toBe(1);
		expect(both.every((r) => r.text.includes("https://a.com/1"))).toBe(true);
	});

	test("the shared call outlives one caller's abort and stops when every caller has aborted", async () => {
		const g = gate();
		let calls = 0;
		let providerSignal: AbortSignal | undefined;
		const t = fakeTool(providerSet((_id, call) => {
			calls++;
			providerSignal = call.signal;
			return new Promise((resolve, reject) => {
				call.signal?.addEventListener("abort", () => reject(new ProviderError("aborted", "stopped")));
				g.opened.then(() => resolve(fakeResult(["https://a.com/1"])));
			});
		}));
		const a = new AbortController();
		const b = new AbortController();
		const first = runOn(t, { objective: "same" }, a.signal);
		const second = runOn(t, { objective: "same" }, b.signal);
		a.abort();
		expect((await first).isError).toBe(true);
		expect(providerSignal?.aborted).toBe(false);
		g.open();
		const kept = await second;
		expect(kept.isError).toBe(false);
		expect(calls).toBe(1);

		const c = new AbortController();
		const d = new AbortController();
		const third = runOn(t, { objective: "other" }, c.signal);
		const fourth = runOn(t, { objective: "other" }, d.signal);
		c.abort();
		d.abort();
		expect((await third).text).toContain("aborted");
		expect((await fourth).text).toContain("aborted");
		expect(providerSignal?.aborted).toBe(true);
	});

	test("a repeat inside 30 s is served from memory with a note and no cost; after 30 s it is searched again", async () => {
		let clock = 1_000_000;
		let calls = 0;
		const t = fakeTool(providerSet(async () => (calls++, fakeResult(["https://a.com/1"]))), () => clock);
		const first = await runOn(t, { objective: "same" });
		expect(first.text).not.toContain("reused");
		clock += 29_999;
		const second = await runOn(t, { objective: "same" });
		expect(calls).toBe(1);
		expect(second.text).toContain("[reused the result of an identical search from the last 30 s]");
		expect(second.details.cost).toBe(0);
		expect(second.details.credits).toBeUndefined();
		expect(first.details.cost).toBe(0.01);
		clock += 1;
		const third = await runOn(t, { objective: "same" });
		expect(calls).toBe(2);
		expect(third.text).not.toContain("reused");
		expect(third.details.notes).toEqual([]);
	});

	test("a different request, or a different key, is searched again", async () => {
		let calls = 0;
		const providers = providerSet(async () => (calls++, fakeResult(["https://a.com/1"])));
		const t = fakeTool(providers);
		await runOn(t, { objective: "same" });
		await runOn(t, { objective: "same", max_results: 3 });
		expect(calls).toBe(2);
		const rekeyed = createWebSearchTool(config, { env: { ...allKeys, CONTEXT_DEV_API_KEY: "other" }, health, providers }) as any;
		await runOn(rekeyed, { objective: "same" });
		await runOn(rekeyed, { objective: "same" });
		expect(calls).toBe(3);
	});

	test("an answer without hits, and a failed chain, are never kept", async () => {
		let calls = 0;
		const empty = fakeTool(providerSet(async () => (calls++, fakeResult([]))));
		await runOn(empty, { objective: "same" });
		await runOn(empty, { objective: "same" });
		expect(calls).toBe(2);

		calls = 0;
		const failing = fakeTool(providerSet(async () => {
			calls++;
			throw new ProviderError("unavailable", "down");
		}));
		expect((await runOn(failing, { objective: "same" })).isError).toBe(true);
		expect((await runOn(failing, { objective: "same" })).isError).toBe(true);
		expect(calls).toBe(6);
	});

	test("memory holds 64 searches: the least recently used one is forgotten", async () => {
		let calls = 0;
		const t = fakeTool(providerSet(async () => (calls++, fakeResult(["https://a.com/1"]))));
		for (let i = 0; i < 65; i++) await runOn(t, { objective: `q${i}` });
		await runOn(t, { objective: "q64" });
		expect(calls).toBe(65);
		await runOn(t, { objective: "q0" });
		expect(calls).toBe(66);
	});

	test("what a caller gets back is its own copy", async () => {
		const t = fakeTool(providerSet(async () => fakeResult(["https://a.com/1"])));
		const first = await runOn(t, { objective: "same" });
		first.details.attempts.length = 0;
		first.details.notes.push("mutated");
		const second = await runOn(t, { objective: "same" });
		expect(second.details.attempts.length).toBeGreaterThan(0);
		expect(second.details.notes).toEqual(["reused the result of an identical search from the last 30 s"]);
	});
});

describe("domain filters are checked on the answer", () => {
	const contextUrls = (urls: string[]): Reply => ({
		status: 200,
		body: { results: urls.map((url) => ({ url, title: url, highlights: { highlights: ["h"], code: "SUCCESS" } })), key_metadata: { credits_consumed: 1, credits_remaining: 9 } },
	});
	const urlsIn = (text: string) => text.match(/^https:\/\/\S+$/gm);

	test("include_domains keeps the domain, its subdomains and www, and counts what it dropped", async () => {
		replies.context = () => contextUrls(["https://docs.example.com/a", "https://www.example.com/b", "https://notexample.com/c", "https://other.org/d"]);
		const r = await run({ objective: "x", include_domains: ["example.com"] });
		expect(urlsIn(r.text)).toEqual(["https://docs.example.com/a", "https://www.example.com/b"]);
		expect(r.text).toContain("dropped 2 results outside the requested domains");
	});

	test("exclude_domains drops matches, www or not", async () => {
		replies.context = () => contextUrls(["https://www.pinterest.com/a", "https://pinterest.com/b", "https://ok.org/c"]);
		const r = await run({ objective: "x", exclude_domains: ["pinterest.com"] });
		expect(urlsIn(r.text)).toEqual(["https://ok.org/c"]);
		expect(r.text).toContain("dropped 2 results outside the requested domains");
	});

	test("nothing is said when nothing was dropped", async () => {
		replies.context = () => contextUrls(["https://docs.example.com/a"]);
		const r = await run({ objective: "x", include_domains: ["example.com"] });
		expect(r.text).not.toContain("dropped");
	});

	test("hits all filtered away leave an empty answer from a final provider, not a fall-through", async () => {
		replies.context = () => contextUrls(["https://other.org/d"]);
		const r = await run({ objective: "x", include_domains: ["example.com"] });
		expect(r.text).toStartWith("(no results found)");
		expect(r.text).toContain("dropped 1 result outside the requested domains");
		expect(seen.deepseek).toHaveLength(0);
	});
});

describe("the model-facing text is capped", () => {
	const bigHits = (n: number, chars: number): Hit[] => Array.from({ length: n }, (_, i) => fakeHit(`https://a.com/${i}`, `${i}`.repeat(chars)));
	const TRAILER = "[results cut at 30,000 characters; open a URL above with read_web_page for the full page]";

	test("text under the cap is untouched", () => {
		const hits = bigHits(3, 100);
		expect(formatCappedHits(hits).text).not.toContain("results cut");
	});

	test("over the cap it is cut between hits, with the trailer, inside 30,000 characters", () => {
		const { text, headerLineIndices } = formatCappedHits(bigHits(12, 4000));
		expect(text.length).toBeLessThanOrEqual(30_000);
		expect(text.endsWith(TRAILER)).toBe(true);
		const kept = text.match(/^### /gm)!.length;
		expect(kept).toBeGreaterThan(0);
		expect(kept).toBeLessThan(12);
		expect(headerLineIndices).toHaveLength(kept);
		const lastHit = `${kept - 1}`.repeat(4000);
		expect(text).toContain(`${lastHit}\n\n${TRAILER}`);
	});

	test("one hit larger than the cap is cut inside itself", () => {
		const { text, headerLineIndices } = formatCappedHits(bigHits(2, 50_000));
		expect(text.length).toBeLessThanOrEqual(30_000);
		expect(text.endsWith(TRAILER)).toBe(true);
		expect(headerLineIndices).toEqual([0]);
	});

	test("the tool cuts the model's text but keeps every hit for the screen", async () => {
		replies.context = () => ({
			status: 200,
			body: { results: bigHits(12, 4000).map((h) => ({ url: h.url, title: h.title, highlights: { highlights: h.passages, code: "SUCCESS" } })) },
		});
		const r = await run({ objective: "x", max_results: 12 });
		expect(r.text).toContain(TRAILER);
		expect(r.text.length).toBeLessThan(31_000);
		expect(r.details.resultSections).toHaveLength(12);
	});
});
