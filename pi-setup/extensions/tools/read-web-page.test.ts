import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createReadWebPageTool } from "./read-web-page";

const requests: { auth: string | null; body: any }[] = [];
let rateLimitedLeft = 0;

const page = (overrides: { markdown?: string; links?: string[]; metadata?: object; json?: object } = {}) => ({
	success: true,
	request_id: "req_ok",
	data: {
		metadata: { title: "Docs", description: "", language: "en", status: 200, final_url: "https://docs.test/", ...overrides.metadata },
		links: overrides.links ?? [],
		...(overrides.json ? { json: overrides.json } : { markdown: overrides.markdown ?? "# Docs\n\nHello." }),
	},
	usage: { credits: 1, remaining: 9999 },
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
			case "https://links.test/":
				return Response.json(page({ links: [...Array.from({ length: 150 }, (_, i) => `https://l.test/${i}`), "https://l.test/0"] }));
			case "https://wall.test/":
				return Response.json(page({ metadata: { login_required: true, truncated: true } }));
			case "https://long.test/":
				return Response.json(page({ markdown: "a".repeat(100_000) + "END" }));
			case "https://data.test/":
				return Response.json(page({ json: { tables: [{ rows: [["1"]] }], jsonld: [], embedded: [{ key: "__NEXT_DATA__" }] } }));
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

const tool = createReadWebPageTool({ endpoint: `http://127.0.0.1:${server.port}/v1/scrape`, env: { CRAWLAPI_API_KEY: "ck_test" } }) as any;
const read = async (params: Record<string, unknown>) => {
	const r = await tool.execute("w", params, undefined, undefined, {});
	return { text: r.content[0].text as string, isError: Boolean(r.isError) };
};

describe("read_web_page", () => {
	test("sends one request with only url, format and timeout, and the key as a bearer token", async () => {
		const { text, isError } = await read({ url: "https://docs.test/" });
		expect(isError).toBe(false);
		expect(requests).toEqual([{ auth: "Bearer ck_test", body: { url: "https://docs.test/", format: "markdown", timeout: 45_000 } }]);
		expect(text).toBe('# Docs\n\nHello.\n\n[crawlapi read https://docs.test/ ("Docs") · 1 credit, 9,999 left]');
	});

	test("links come after the page, deduplicated and capped at 100", async () => {
		const { text } = await read({ url: "https://links.test/" });
		expect(text).toContain("Links (150):\nhttps://l.test/0\n");
		expect(text).toContain("https://l.test/99\n[50 more links not shown]");
		expect(text).not.toContain("https://l.test/100\n");
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

	test("format json returns the structured data, tables first", async () => {
		const { text } = await read({ url: "https://data.test/", format: "json" });
		expect(requests[0].body.format).toBe("json");
		expect(text.startsWith('{"tables":[{"rows":[["1"]]}],"jsonld":[],"embedded":[{"key":"__NEXT_DATA__"}]}')).toBe(true);
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
		const gaveUp = await read({ url: "https://busy.test/" });
		expect(gaveUp.text).toContain("crawlapi RATE_LIMITED: RATE_LIMITED message (retryable after 0s;");
		expect(requests).toHaveLength(3);
	});

	test("without a key it says how to get one and sends nothing", async () => {
		const keyless = createReadWebPageTool({ endpoint: `http://127.0.0.1:${server.port}/v1/scrape`, env: {} }) as any;
		const r = await keyless.execute("w", { url: "https://docs.test/" }, undefined, undefined, {});
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toContain("CRAWLAPI_API_KEY");
		expect(requests).toHaveLength(0);
	});
});
