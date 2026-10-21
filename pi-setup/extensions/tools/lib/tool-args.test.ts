import { describe, expect, test } from "bun:test";
import { validateToolArguments } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/index.js";
import { createWebSearchTool, prepareWebArguments } from "../web-search";
import { createXSearchTool, prepareXArguments } from "../x-search";
import { argumentPreparer } from "./tool-args";

/** what pi does with a model's call: our prepareArguments, then its own schema validation. */
function piValidates(tool: any, args: Record<string, unknown>) {
	return validateToolArguments(tool, { type: "toolCall", id: "c", name: tool.name, arguments: tool.prepareArguments(args) } as any);
}

describe("argumentPreparer", () => {
	const prepare = argumentPreparer(
		"demo",
		{
			query: { aliases: ["q"] },
			kind: { values: { posts: ["tweets"], users: ["profile"] }, valuesHelp: "posts or users" },
			tags: { list: true },
		},
		"Example: demo({ query: \"x\" })",
	);

	test("other names and other spellings become the schema's own", () => {
		expect(prepare({ q: "hi", kind: "PROFILE", tags: '["a","b"]' })).toEqual({ query: "hi", kind: "users", tags: ["a", "b"] });
	});

	test("the schema's own name wins over an alias given alongside it", () => {
		expect(prepare({ q: "alias", query: "canonical" })).toEqual({ query: "canonical" });
	});

	test("an unknown parameter is refused with the list of real ones and an example", () => {
		expect(() => prepare({ query: "x", colour: "red" })).toThrow('demo: unknown parameter "colour". Its parameters are: query, kind, tags.\nExample: demo({ query: "x" })');
	});

	test("an unknown value is refused with what each value means", () => {
		expect(() => prepare({ query: "x", kind: "lists" })).toThrow('demo: kind "lists" is not one of its values: posts or users.');
	});

	test("null and undefined are dropped rather than reported", () => {
		expect(prepare({ query: "x", kind: null, tags: undefined })).toEqual({ query: "x" });
	});
});

describe("x_search arguments through pi's validation", () => {
	const tool = createXSearchTool();

	test("the names and values models guess are accepted", () => {
		expect(piValidates(tool, { q: "claude", type: "profile", count: "5" })).toEqual({ query: "claude", kind: "users", limit: 5 });
		expect(piValidates(tool, { query: "grok", mode: "Latest", since: "2026-10-01", until: "2026-10-02" })).toEqual({
			query: "grok",
			sort: "latest",
			from_date: "2026-10-01",
			to_date: "2026-10-02",
		});
	});

	test("only a handle is enough: the query becomes from:handle", () => {
		expect(piValidates(tool, { username: "@devmuzzammil" })).toEqual({ query: "from:devmuzzammil", handles: ["@devmuzzammil"] });
	});

	test("a post URL with no kind is read as a thread", () => {
		expect(piValidates(tool, { url: "https://x.com/a/status/2112666467712073815" })).toMatchObject({ kind: "thread" });
	});

	test("a wrong value gets an error that names every allowed value", () => {
		expect(() => piValidates(tool, { query: "x", kind: "lists" })).toThrow(/kind "lists" is not one of its values: posts \(keyword search, the default\), semantic/);
	});

	test("a wrong parameter gets the list of real ones", () => {
		expect(() => prepareXArguments({ query: "x", colour: "red" })).toThrow(/Its parameters are: query, kind, sort, limit, handles, exclude_handles, from_date, to_date/);
	});
});

describe("web_search arguments through pi's validation", () => {
	const tool = createWebSearchTool();

	test("the names and values models guess are accepted", () => {
		expect(piValidates(tool, { query: "tokio select", depth: "deep", recency: "7d", domains: "docs.rs", limit: "3" })).toEqual({
			objective: "tokio select",
			mode: "agentic",
			freshness: "week",
			include_domains: ["docs.rs"],
			max_results: 3,
		});
	});

	test("a stringified array passes pi's array check", () => {
		expect(piValidates(tool, { objective: "x", search_queries: '["a", "b"]' })).toEqual({ objective: "x", search_queries: ["a", "b"] });
	});

	test("a wrong mode names the three modes", () => {
		expect(() => prepareWebArguments({ objective: "x", mode: "hyper" })).toThrow(/mode "hyper" is not one of its values: fast \(~1s/);
	});
});
