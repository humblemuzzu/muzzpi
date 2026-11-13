import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createReadWebPageTool, pageResult, PageCache } from "./read-web-page";

const requests: { auth: string | null; body: any }[] = [];
let rateLimitedLeft = 0;

const page = (overrides: { markdown?: string; metadata?: object; json?: object; credits?: number } = {}) => ({
	success: true,
	request_id: "req_ok",
	data: {
		metadata: { title: "Docs", description: "", language: "en", status: 200, final_url: "https://docs.test/", ...overrides.metadata },
		links: ["https://docs.test/next"],
		...(overrides.json ? { json: overrides.json } : { markdown: overrides.markdown ?? "# Docs\n\nHello, see [next](https://docs.test/next)." }),
	},
	usage: { credits: overrides.credits ?? 1, remaining: 9999 },
});

const failure = (status: number, code: string, retryable: boolean, headers: Record<string, string> = {}) =>
	Response.json(
		{ success: false, request_id: `req_${code}`, error: { code, message: `${code} message`, retryable, doc_url: "x" } },
		{ status, headers },
	);

const server = Bun.serve({
	port: 0,
	async fetch(req) {
		const body = await req.json();
		requests.push({ auth: req.headers.get("authorization"), body });
		switch (body.url) {
			case "https://wall.test/":
				return Response.json(page({ metadata: { login_required: true, truncated: true } }));
			case "https://long.test/":
				return Response.json(page({ markdown: "a".repeat(100_000) + "END" }));
			case "https://data.test/":
				return Response.json(
					page({ json: { structured: { type: "recipe" }, tables: [{ rows: [["1"]] }], jsonld: [], embedded: [{ key: "__NEXT_DATA__" }] } }),
				);
			case "https://premium.test/":
				return Response.json(page({ credits: 25 }));
			case "https://missing.test/":
				return failure(404, "NOT_FOUND", false);
			case "https://busy.test/":
				if (rateLimitedLeft-- > 0) return failure(429, "RATE_LIMITED", true, { "retry-after": "0" });
				return Response.json(page());
			case "https://blocked.test/":
				return failure(422, "BLOCKED", true);
			default:
				return Response.json(page());
		}
	},
});
afterAll(() => server.stop(true));
beforeEach(() => {
	requests.length = 0;
	rateLimitedLeft = 0;
});

const endpoint = `http://127.0.0.1:${server.port}/v1/scrape`;
let clock = 1_000_000;
const freshTool = () =>
	createReadWebPageTool({ endpoint, env: { CRAWLAPI_API_KEY: "ck_test" }, usdPerCredit: 0.001, now: () => clock }) as any;
let tool = freshTool();
beforeEach(() => {
	tool = freshTool();
});

const call = (params: Record<string, unknown>) => tool.execute("w", params, undefined, undefined, {});
const read = async (params: Record<string, unknown>) => {
	const r = await call(params);
	return { text: r.content[0].text as string, isError: Boolean(r.isError) };
};

const plainTheme = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s };

describe("read_web_page", () => {
	test("sends one request with only url, format and timeout, and the key as a bearer token", async () => {
		const { text, isError } = await read({ url: "https://docs.test/" });
		expect(isError).toBe(false);
		expect(requests).toEqual([{ auth: "Bearer ck_test", body: { url: "https://docs.test/", format: "markdown", timeout: 60_000 } }]);
		expect(text).toBe(
			'# Docs\n\nHello, see [next](https://docs.test/next).\n\n[crawlapi read https://docs.test/ ("Docs") · 1 credit, 9,999 left · request req_ok]',
		);
	});

	test("the credits a page cost are its tool cost, so the session total counts them", async () => {
		const r = await call({ url: "https://premium.test/" });
		expect(r.details).toEqual({ cost: 0.025, credits: 25, requestId: "req_ok", cached: false });
	});

	test("a sign-in wall and crawlapi's own cut are both said", async () => {
		const { text } = await read({ url: "https://wall.test/" });
		expect(text).toContain("[sign-in wall: this is the wall's own text, not the page]");
		expect(text).toContain("[crawlapi cut the page at its size cap; the rest of the page is not available]");
	});

	test("a long page comes in windows that name the next start_index", async () => {
		const first = await read({ url: "https://long.test/" });
		expect(first.text).toContain("[characters 0–64000 of 100003; pass start_index: 64000 for more]");
		const last = await read({ url: "https://long.test/", start_index: 64_000 });
		expect(last.text).toContain("aEND\n\n");
		expect(last.text).toContain("[characters 64000–100003 of 100003]");
	});

	test("format json returns crawlapi's json as sent, structured first", async () => {
		const { text } = await read({ url: "https://data.test/", format: "json" });
		expect(requests[0].body.format).toBe("json");
		expect(
			text.startsWith('{"structured":{"type":"recipe"},"tables":[{"rows":[["1"]]}],"jsonld":[],"embedded":[{"key":"__NEXT_DATA__"}]}\n\n'),
		).toBe(true);
	});

	test("a failure is the error code, its message and whether a retry helps", async () => {
		const missing = await read({ url: "https://missing.test/" });
		expect(missing).toEqual({
			isError: true,
			text: "crawlapi NOT_FOUND: NOT_FOUND message (not retryable: the same request gets the same answer; request req_NOT_FOUND)",
		});
		const blocked = await read({ url: "https://blocked.test/" });
		expect(blocked.text).toContain("crawlapi BLOCKED: BLOCKED message (retryable later;");
		expect(requests).toHaveLength(2);
	});

	test("RATE_LIMITED is retried after Retry-After, at most twice", async () => {
		rateLimitedLeft = 2;
		expect((await read({ url: "https://busy.test/" })).isError).toBe(false);
		expect(requests).toHaveLength(3);

		requests.length = 0;
		rateLimitedLeft = 5;
		tool = freshTool();
		const gaveUp = await read({ url: "https://busy.test/" });
		expect(gaveUp.text).toContain("crawlapi RATE_LIMITED: RATE_LIMITED message (retryable after 0s;");
		expect(requests).toHaveLength(3);
	});

	test("without a key it says how to get one and sends nothing", async () => {
		const keyless = createReadWebPageTool({ endpoint, env: {} }) as any;
		const r = await keyless.execute("w", { url: "https://docs.test/" }, undefined, undefined, {});
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toContain("CRAWLAPI_API_KEY");
		expect(requests).toHaveLength(0);
	});
});

describe("read_web_page reuses a page for ten minutes", () => {
	test("the next window of a page is served from the copy, free, and says so", async () => {
		await call({ url: "https://long.test/" });
		clock += 90_000;
		const next = await call({ url: "https://long.test/", start_index: 64_000 });
		expect(requests).toHaveLength(1);
		expect(next.content[0].text).toContain("[crawlapi read https://docs.test/ (\"Docs\") · copy read 1m ago, no credits spent · request req_ok]");
		expect(next.details).toEqual({ cost: 0, credits: 0, requestId: "req_ok", cached: true });
	});

	test("after ten minutes the page is read again", async () => {
		await call({ url: "https://docs.test/" });
		clock += 10 * 60_000;
		await call({ url: "https://docs.test/" });
		expect(requests).toHaveLength(2);
	});

	test("markdown and json of one URL are separate reads", async () => {
		await call({ url: "https://data.test/" });
		await call({ url: "https://data.test/", format: "json" });
		expect(requests.map((r) => r.body.format)).toEqual(["markdown", "json"]);
	});

	test("a failure is never reused: the next call asks again", async () => {
		await call({ url: "https://missing.test/" });
		await call({ url: "https://missing.test/" });
		expect(requests).toHaveLength(2);
	});

	test("only the sixteen most recent pages are kept", () => {
		const cache = new PageCache(() => clock);
		const held = { success: true, request_id: "r", data: { metadata: { title: "", final_url: "" } }, usage: { credits: 1, remaining: 1 } } as any;
		for (let i = 0; i < 17; i++) cache.put(`https://p.test/${i}`, "markdown", held);
		expect(cache.get("https://p.test/0", "markdown")).toBeUndefined();
		expect(cache.get("https://p.test/1", "markdown")).toBeDefined();
		expect(cache.get("https://p.test/16", "markdown")).toBeDefined();
	});
});

describe("read_web_page sub-agent input", () => {
	test("a sub-agent gets the whole page, not the main model's window", () => {
		const long = { page: page({ markdown: "a".repeat(100_000) + "END" }), fetchedAt: 0 } as any;
		expect(pageResult(long, "markdown")).not.toContain("END");
		const whole = pageResult(long, "markdown", undefined, undefined, 400_000);
		expect(whole).toContain("aEND\n\n");
		expect(whole).not.toContain("characters 0–");
	});
});

describe("read_web_page rendering", () => {
	test("a plain read renders its text, not an agent tree", async () => {
		const r = await call({ url: "https://docs.test/" });
		const lines = tool.renderResult(r, { expanded: false }, plainTheme, {}).render(120).join("\n");
		expect(lines).toContain("Hello, see [next](https://docs.test/next).");
	});
});
