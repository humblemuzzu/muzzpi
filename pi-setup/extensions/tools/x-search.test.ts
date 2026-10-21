import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClientVersion, jwtSecondsLeft, type TokenSource } from "./lib/x/grok-proxy";
import { buildXRequest, createXSearchTool, relayInstructions, X_CONFIG_DEFAULTS } from "./x-search";

const card = (id: string, user: string, text: string) =>
	`Main Post:\n- [post:0] ID: ${id}\n- Conversation ID: ${id}\n- Author: ${user} - @${user}\n- Timestamp: Wed, 21 Oct 2026 07:08:53 GMT\n- Engagement: Likes=5, Reposts=1, Quotes=0, Replies=2, Bookmarks=0, Views=100\n- Content: ${text}`;

interface Turn {
	status?: number;
	body?: string;
	text?: string;
	postIds?: string[];
	userIds?: string[];
	call?: { name: string; input: string } | null;
	failMidStream?: boolean;
	/** x_posts_fetched; defaults to the number of cited posts. */
	fetched?: number;
	crlf?: boolean;
	incomplete?: string;
}

const DEFAULT_CALL = { name: "x_keyword_search", input: '{"query":"x","limit":"10","mode":"Latest"}' };

function sse(turn: Turn): string {
	const text = turn.text ?? "";
	const annotations = [
		...(turn.postIds ?? []).map((id) => ({ type: "url_citation", url: `https://x.com/i/status/${id}`, start_index: 0, end_index: 0 })),
		...(turn.userIds ?? []).map((id) => ({ type: "url_citation", url: `https://x.com/i/user/${id}`, start_index: 0, end_index: 0 })),
	];
	const events: any[] = [{ type: "response.created", response: {} }];
	for (let i = 0; i < text.length; i += 40) events.push({ type: "response.output_text.delta", delta: text.slice(i, i + 40) });
	if (turn.failMidStream) events.push({ type: "response.failed", response: { error: { message: "model crashed" } } });
	events.push({
		type: turn.incomplete ? "response.incomplete" : "response.completed",
		response: {
			...(turn.incomplete && { incomplete_details: { reason: turn.incomplete } }),
			output: [
				...(turn.call === null ? [] : [{ type: "custom_tool_call", ...(turn.call ?? DEFAULT_CALL), call_id: "xs_call-1" }]),
				{ type: "message", content: [{ type: "output_text", text, annotations }] },
			],
			usage: { input_tokens: 6000, output_tokens: 300, cost_in_usd_ticks: 400000000, server_side_tool_usage_details: { x_posts_fetched: turn.fetched ?? turn.postIds?.length ?? 0 } },
		},
	});
	const eol = turn.crlf ? "\r\n" : "\n";
	return events.map((e) => `event: ${e.type}${eol}data: ${JSON.stringify(e)}${eol}${eol}`).join("");
}

/** serves the SSE body in 7-byte pieces, so events and UTF-8 characters arrive split across reads. */
function chunked(body: string): ReadableStream<Uint8Array> {
	const bytes = new TextEncoder().encode(body);
	let at = 0;
	return new ReadableStream({
		pull(controller) {
			if (at >= bytes.length) return controller.close();
			controller.enqueue(bytes.slice(at, at + 7));
			at += 7;
		},
	});
}

let turns: Turn[] = [];
let requests: { headers: Headers; body: any }[] = [];
const server = Bun.serve({
	port: 0,
	async fetch(req) {
		requests.push({ headers: req.headers, body: await req.json() });
		const turn = turns.shift() ?? { text: "NO RESULTS" };
		if (turn.status && turn.status !== 200) return new Response(turn.body ?? "", { status: turn.status });
		return new Response(chunked(sse(turn)), { headers: { "content-type": "text/event-stream", "x-request-id": "req-1" } });
	},
});
afterAll(() => server.stop(true));

const token = (label: string, value: string | undefined): TokenSource => ({ label, get: async () => value });
let dir: string;
beforeEach(() => {
	turns = [];
	requests = [];
	dir = mkdtempSync(join(tmpdir(), "x-search-"));
});

function tool(tokens: TokenSource[] = [token("pi", "tok-pi")], fallback = "1.0.62") {
	const version = new ClientVersion(join(dir, "x-search.json"), fallback, join(dir, "no-grok"));
	return createXSearchTool({ ...X_CONFIG_DEFAULTS, baseUrl: `http://127.0.0.1:${server.port}` }, { tokens, version }) as any;
}
async function run(params: Record<string, unknown>, t = tool()) {
	const r = await t.execute("x", params, undefined, undefined, {});
	return { text: r.content[0].text as string, isError: Boolean(r.isError), details: r.details };
}

describe("x_search against the proxy", () => {
	test("posts come back formatted, with the call Grok ran", async () => {
		const raw = `${card("2112803291327504763", "ana_dev", "Grok Build is fast — 速い")}\n\n---\n\n${card("2112803128026529898", "ben_b", "second post")}`;
		turns = [{ text: raw, postIds: ["2112803291327504763", "2112803128026529898"], call: { name: "x_keyword_search", input: '{"query":"Grok Build","limit":"10","mode":"Latest"}' } }];
		const r = await run({ query: "Grok Build" });
		expect(r.isError).toBe(false);
		expect(r.text).toStartWith("@ana_dev (ana_dev) · 2026-10-21 07:08 UTC · 5 likes, 1 reposts, 2 replies, 100 views\nhttps://x.com/ana_dev/status/2112803291327504763\nGrok Build is fast — 速い");
		expect(r.text).toContain('[ran x_keyword_search {"query":"Grok Build","limit":"10","mode":"Latest"} · grok-4.6 ·');
		expect(r.details.posts).toHaveLength(2);
		expect(r.details.cost).toBe(0);
	});

	test("the request carries the version header, the CLI token auth, the filters and the exact relay instructions", async () => {
		turns = [{ text: "NO RESULTS" }];
		await run({ query: "from:karpathy", handles: ["@karpathy"], from_date: "2026-09-01", to_date: "2026-10-01", limit: 3 });
		const [{ headers, body }] = requests;
		expect(headers.get("authorization")).toBe("Bearer tok-pi");
		expect(headers.get("x-xai-token-auth")).toBe("xai-grok-cli");
		expect(headers.get("x-grok-client-version")).toBe("1.0.62");
		expect(headers.get("x-grok-model-override")).toBe("grok-4.6");
		expect(body.tools).toEqual([{ type: "x_search", allowed_x_handles: ["karpathy"], from_date: "2026-09-01", to_date: "2026-10-01" }]);
		expect(body.instructions).toBeUndefined();
		expect(body.input).toHaveLength(1);
		expect(body.input[0].role).toBe("user");
		expect(body.input[0].content).toContain('x_keyword_search with the arguments {"query":"from:karpathy","limit":3,"mode":"Latest"}');
		expect(body.stream).toBe(true);
		expect(body.store).toBe(false);
	});

	test("a post Grok invented is dropped and a post it skipped is reported", async () => {
		const raw = `${card("1111111111111111111", "real", "real post")}\n\n---\n\n${card("2222222222222222222", "fake", "invented")}`;
		turns = [{ text: raw, postIds: ["1111111111111111111", "3333333333333333333"] }];
		const r = await run({ query: "anything" });
		expect(r.details.posts.map((p: any) => p.id)).toEqual(["1111111111111111111"]);
		expect(r.text).not.toContain("invented");
		expect(r.text).toContain("dropped 1 post(s) X did not return — Grok mis-copied them: 2222222222222222222");
		expect(r.text).toContain("Grok's copy left out 1 of the 2 posts X returned: https://x.com/i/status/3333333333333333333");
	});

	test("a page ends with its totals, and a full page with the exact next-page query", async () => {
		const reply = `Main Post:\n- ID: 1000000000000000009\n- Conversation ID: 1000000000000000001\n- Author: Me - @me\n- Engagement: Likes=2, Reposts=0, Quotes=0, Replies=1, Bookmarks=0, Views=40\n- Content: a reply`;
		const raw = `${card("1000000000000000010", "me", "an original")}\n\n---\n\n${reply}`;
		turns = [{ text: raw, postIds: ["1000000000000000010", "1000000000000000009"] }];
		const r = await run({ query: "from:me max_id:1999999999999999999", limit: 2 });
		expect(r.text).toContain("[these 2 posts (1 original, 1 replies): 7 likes, 140 views, 1 reposts, 3 replies received]");
		expect(r.text).toContain('[page is full; for the next 2, same arguments with query: "from:me max_id:1000000000000000008"]');

		turns = [{ text: card("1000000000000000010", "me", "only one"), postIds: ["1000000000000000010"] }];
		const partial = await run({ query: "from:me", limit: 2 });
		expect(partial.text).not.toContain("page is full");
	});

	test("a thread keeps its uncited replies when X's post count covers them, and flags any beyond it", async () => {
		const thread = `[post:0]\nMain Post (Requested Post):\n- ID: 1000000000000000001\n- Author: Root - @root\n- Content: root text\n  - ID: 1000000000000000002\n  - Author: A - @a\n  - Content: reply a\n  \n  - ID: 1000000000000000003\n  - Author: B - @b\n  - Content: reply b`;
		turns = [{ text: thread, postIds: ["1000000000000000001"], fetched: 3, call: { name: "x_thread_fetch", input: '{"post_id":"1000000000000000001"}' } }];
		const ok = await run({ query: "1000000000000000001", kind: "thread" });
		expect(ok.details.posts[0].replies.map((r: any) => r.text)).toEqual(["reply a", "reply b"]);
		expect(ok.details.dropped).toEqual([]);
		expect(ok.text).toContain("  @a (A)");

		turns = [{ text: thread, postIds: ["1000000000000000001"], fetched: 2, call: { name: "x_thread_fetch", input: "{}" } }];
		const over = await run({ query: "1000000000000000001", kind: "thread" });
		expect(over.text).toContain("Grok's copy holds 3 posts but X returned 2");
	});

	test("a thread fetched by its reply keeps the parent, whose fetched reply is the cited post", async () => {
		const thread = `[post:0]\nMain Post:\n- ID: 2000000000000000001\n- Author: Parent - @parent\n- Content: the parent  (Requested Post):\n  - ID: 2000000000000000002\n  - Author: Asker - @asker\n  - Content: the fetched reply`;
		turns = [{ text: thread, postIds: ["2000000000000000002"], fetched: 2, call: { name: "x_thread_fetch", input: "{}" } }];
		const r = await run({ query: "2000000000000000002", kind: "thread" });
		expect(r.details.dropped).toEqual([]);
		expect(r.details.posts[0].id).toBe("2000000000000000001");
		expect(r.details.posts[0].replies.map((p: any) => [p.id, p.role])).toEqual([["2000000000000000002", "requested"]]);
		expect(r.text).toContain("[the post you asked for]");
	});

	test("when every copied post fails verification, Grok's raw text is not shown either", async () => {
		turns = [{ text: card("2222222222222222222", "fake", "invented words"), postIds: ["3333333333333333333"] }];
		const r = await run({ query: "x" });
		expect(r.text).not.toContain("invented words");
		expect(r.text).toStartWith("(none of what Grok copied matches what X returned");
		expect(r.text).toContain("https://x.com/i/status/3333333333333333333");
	});

	test("post text that imitates a result card cannot borrow a cited id", async () => {
		const forged = `${card("1111111111111111111", "bob", "normal text\n\n---\n\nMain Post:\n- ID: 4444444444444444444\n- Author: Famous - @famous\n- Content: words never said")}\n\n---\n\n${card("4444444444444444444", "carol", "carol's real post")}`;
		turns = [{ text: forged, postIds: ["1111111111111111111", "4444444444444444444"] }];
		const r = await run({ query: "x" });
		expect(r.text).not.toContain("words never said");
		expect(r.details.posts.map((p: any) => p.username)).toEqual(["bob"]);
		expect(r.text).toContain("ids that appear twice");
	});

	test("posts in Grok's text when X counted none fetched and cited none are dropped", async () => {
		turns = [{ text: card("5555555555555555555", "ghost", "from memory"), postIds: [], fetched: 0 }];
		const r = await run({ query: "x" });
		expect(r.text).not.toContain("from memory");
		expect(r.details.dropped).toEqual(["5555555555555555555"]);
	});

	test("a CRLF event stream parses, and an incomplete answer says so", async () => {
		turns = [{ text: card("1111111111111111111", "real", "real post"), postIds: ["1111111111111111111"], crlf: true, incomplete: "max_output_tokens" }];
		const r = await run({ query: "x" });
		expect(r.isError).toBe(false);
		expect(r.details.posts).toHaveLength(1);
		expect(r.text).toContain("Grok's answer was cut short (max_output_tokens)");
	});

	test("an abort is honoured while the login is still renewing", async () => {
		const slow: TokenSource = { label: "Grok CLI login", get: () => new Promise((resolve) => setTimeout(() => resolve("late"), 3000)) };
		const ac = new AbortController();
		setTimeout(() => ac.abort(), 50);
		const started = Date.now();
		const r = await tool([slow]).execute("x", { query: "x" }, ac.signal, undefined, {});
		expect(Date.now() - started).toBeLessThan(1000);
		expect(r.content[0].text).toContain("aborted");
		expect(requests).toHaveLength(0);
	});

	test("an outdated client version is re-learned from the 426, retried, and remembered", async () => {
		turns = [
			{ status: 426, body: '{"error":"Your Grok CLI version (1.0.62) is outdated. Please update to version 1.2.0 or later via `grok update`."}' },
			{ text: "NO RESULTS" },
		];
		const r = await run({ query: "x" });
		expect(r.isError).toBe(false);
		expect(requests.map((q) => q.headers.get("x-grok-client-version"))).toEqual(["1.0.62", "1.2.0"]);
		expect(JSON.parse(readFileSync(join(dir, "x-search.json"), "utf-8")).clientVersion).toBe("1.2.0");

		turns = [{ text: "NO RESULTS" }];
		await run({ query: "y" });
		expect(requests[2].headers.get("x-grok-client-version")).toBe("1.2.0");
	});

	test("a rejected token falls back to the next login", async () => {
		turns = [{ status: 401, body: '{"error":"invalid token"}' }, { text: "NO RESULTS" }];
		const r = await run({ query: "x" }, tool([token("pi's xAI login", "bad"), token("Grok CLI login", "good")]));
		expect(r.isError).toBe(false);
		expect(requests.map((q) => q.headers.get("authorization"))).toEqual(["Bearer bad", "Bearer good"]);
		expect(r.details.tokenSource).toBe("Grok CLI login");
	});

	test("a rejected token is renewed once and the search retried with the new one", async () => {
		turns = [{ status: 401, body: '{"error":"expired"}' }, { text: "NO RESULTS" }];
		const renewing: TokenSource = { label: "Grok CLI login", get: async () => "old", refresh: async (rejected) => (rejected === "old" ? "renewed" : undefined) };
		const r = await run({ query: "x" }, tool([renewing]));
		expect(r.isError).toBe(false);
		expect(requests.map((q) => q.headers.get("authorization"))).toEqual(["Bearer old", "Bearer renewed"]);
	});

	test("an answer written without running an X tool is asked once more, then refused and never shown", async () => {
		const fromMemory = { text: card("1111111111111111111", "made_up", "a post from memory"), call: null };
		turns = [fromMemory, fromMemory];
		const r = await run({ query: "x" });
		expect(requests).toHaveLength(2);
		expect(r.isError).toBe(true);
		expect(r.text).toContain("without running an X tool");
		expect(r.text).not.toContain("a post from memory");
	});

	test("a skipped tool call is recovered by the retry", async () => {
		turns = [{ text: "from memory", call: null }, { text: card("1111111111111111111", "real", "real post"), postIds: ["1111111111111111111"] }];
		const r = await run({ query: "x" });
		expect(r.isError).toBe(false);
		expect(r.details.posts.map((p: any) => p.id)).toEqual(["1111111111111111111"]);
	});

	test("no usable login is one error that says how to log in", async () => {
		const expired = `x.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 60 })).toString("base64url")}.y`;
		const r = await run({ query: "x" }, tool([token("pi's xAI login", expired), token("Grok CLI login", undefined)]));
		expect(r.isError).toBe(true);
		expect(r.text).toContain("grok login");
		expect(requests).toHaveLength(0);
	});

	test("a failure mid-stream is an error, not an empty result", async () => {
		turns = [{ text: "partial", failMidStream: true }];
		const r = await run({ query: "x" });
		expect(r.isError).toBe(true);
		expect(r.text).toContain("model crashed");
	});

	test("users are checked against the user ids X returned", async () => {
		const raw = "[X User Result 0]:\n- ID: 33836629\n- Name: Some Researcher - @researcher\n- Followers: 4382318\n- Verified: Blue Verified\n\n---\n\n[X User Result 1]:\n- ID: 99\n- Name: Ghost - @ghost";
		turns = [{ text: raw, userIds: ["33836629"] }];
		const r = await run({ query: "researcher", kind: "users" });
		expect(r.details.users.map((u: any) => u.username)).toEqual(["researcher"]);
		expect(r.text).toStartWith("@researcher (Some Researcher) · 4,382,318 followers · Blue Verified\nhttps://x.com/researcher · id 33836629");
	});

	test("nothing found is a plain empty answer", async () => {
		turns = [{ text: "NO RESULTS" }];
		const r = await run({ query: "zzzz" });
		expect(r.isError).toBe(false);
		expect(r.text).toStartWith("(no posts found)");
	});

	test("output that is not X result text is shown as-is and flagged", async () => {
		turns = [{ text: "I could not run the search." }];
		const r = await run({ query: "x" });
		expect(r.text).toStartWith("I could not run the search.");
		expect(r.text).toContain("did not match the X result format");
	});
});

describe("x_search arguments", () => {
	test("invalid combinations are refused with the reason", () => {
		expect(buildXRequest({ query: " " })).toContain("query is required");
		expect(buildXRequest({ query: "x", handles: ["a"], exclude_handles: ["b"] })).toContain("cannot be combined");
		expect(buildXRequest({ query: "x", from_date: "09/01/2026" })).toContain("from_date must be a real date");
		expect(buildXRequest({ query: "x", to_date: "2026-02-31" })).toContain("to_date must be a real date");
		expect(buildXRequest({ query: "x", from_date: "2026-09-02", to_date: "2026-09-02" })).toContain("exclusive");
		expect(buildXRequest({ query: "x", kind: "thread" })).toContain("post id or a post URL");
		expect(buildXRequest({ query: "x", kind: "lists" })).toContain("kind must be one of");
	});

	test("a thread takes a post URL or id, and filters that cannot apply are reported", () => {
		const req = buildXRequest({ query: "https://x.com/someone/status/2112666467712073815?s=20", kind: "thread", handles: ["a"] });
		expect(typeof req).toBe("object");
		if (typeof req === "string") return;
		expect(req.args).toEqual({ post_id: "2112666467712073815" });
		expect(req.toolConfig).toEqual({ type: "x_search" });
		expect(req.notes[0]).toContain("ignored for thread");
	});

	test("handles are cleaned of @ and profile URLs; limit is capped at 10; top sort maps to Top", () => {
		const req = buildXRequest({ query: "x", handles: '["@a", "https://x.com/b"]', limit: 50, sort: "top" });
		if (typeof req === "string") throw new Error(req);
		expect(req.toolConfig.allowed_x_handles).toEqual(["a", "b"]);
		expect(req.args).toEqual({ query: "x", limit: 10, mode: "Top" });
	});

	test("the relay keeps bios for user searches only", () => {
		const users = buildXRequest({ query: "x", kind: "users" });
		const posts = buildXRequest({ query: "x" });
		if (typeof users === "string" || typeof posts === "string") throw new Error("invalid");
		expect(relayInstructions(users)).not.toContain("Bio");
		expect(relayInstructions(posts)).toContain('every "- Bio:" line');
	});
});

describe("client version", () => {
	test("the newest of fallback, installed Grok CLI and learned floor wins", () => {
		const grokHome = join(dir, "grok");
		const cache = join(dir, "cache.json");
		mkdirSync(grokHome);
		writeFileSync(join(grokHome, "version.json"), JSON.stringify({ version: "1.0.70" }));
		const v = new ClientVersion(cache, "1.0.62", grokHome);
		expect(v.current()).toBe("1.0.70");
		v.learn("1.1.0");
		expect(v.current()).toBe("1.1.0");
		writeFileSync(join(grokHome, "version.json"), JSON.stringify({ version: "1.2.3" }));
		expect(v.current()).toBe("1.2.3");
	});

	test("JWT expiry is read without verifying the token", () => {
		const jwt = `h.${Buffer.from(JSON.stringify({ exp: 2000 })).toString("base64url")}.s`;
		expect(jwtSecondsLeft(jwt, 1_000_000)).toBe(1000);
		expect(jwtSecondsLeft("not-a-jwt")).toBeUndefined();
	});
});
