/**
 * tool-contract tests — the tool spec must be self-describing and internally
 * consistent, so a model never has to read our source to learn how to call us.
 *
 * WHY THIS FILE EXISTS
 *
 * measured, in a cold session: asked to launch two librarians and one oracle,
 * the model first ran `ls` on the tools directory, then grepped for
 * "parameters|Type.Object|Type.String", then read librarian.ts and oracle.ts —
 * roughly eight discovery calls before any real work, and it would have done
 * the same in every new session.
 *
 * it behaved correctly. the spec was contradictory:
 *   - the wire schema said `required: []` while the parameter description said
 *     "REQUIRED." models treat JSON Schema `required` as machine-truth and
 *     prose as advisory, so the contradiction made the whole spec suspect.
 *   - librarian's description discussed "what repositories you want to
 *     understand" while exposing no repository parameter, even though the seven
 *     github tools beside it all take one.
 *
 * these tests encode the fix as invariants. they are deliberately generic: any
 * tool added later is held to the same contract.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLibrarianTool, librarianAllowlist, normalizeRepositories } from "./librarian";
import { createOracleTool, oracleAllowlist } from "./oracle";
import { createDelegateTool, delegateAllowlist } from "./delegate";
import { createChadTool, chadAllowlist } from "./chad";
import { createFinderTool, finderAllowlist } from "./finder";
import { createCodeReviewTool, codeReviewAllowlist } from "./code-review";
import { createReadSessionTool } from "./read-session";
import { createReadWebPageTool } from "./read-web-page";
import { parseAgentModels, SUB_AGENTS } from "./lib/agent-models";
import { subAgentResult } from "./lib/sub-agent-render";
import { zeroUsage } from "./lib/pi-spawn";

type AnyTool = {
	name: string;
	description: string;
	parameters: { properties?: Record<string, any>; required?: string[] };
};

/** the six sub-agent tools, i.e. everything that spawns a child pi session. */
const SUB_AGENT_TOOLS: Array<[string, AnyTool]> = [
	["librarian", createLibrarianTool() as any],
	["oracle", createOracleTool() as any],
	["delegate", createDelegateTool() as any],
	["chad", createChadTool() as any],
	["finder", createFinderTool() as any],
	["code_review", createCodeReviewTool() as any],
];

/** the primary input each sub-agent tool cannot run without. */
const PRIMARY_PARAM: Record<string, string> = {
	librarian: "query",
	oracle: "task",
	delegate: "prompt",
	chad: "prompt",
	finder: "query",
	code_review: "diff_description",
};

describe("tool contract: schema and prose must agree", () => {
	for (const [name, tool] of SUB_AGENT_TOOLS) {
		test(`${name}: primary parameter is required in the schema`, () => {
			const primary = PRIMARY_PARAM[name];
			expect(tool.parameters.required ?? []).toContain(primary);
			expect(tool.parameters.properties?.[primary]?.type).toBe("string");
		});

		test(`${name}: no parameter claims "REQUIRED" in prose`, () => {
			// the exact contradiction that sent the model to our source. a
			// parameter is required by being in `required`, never by shouting.
			const proseHits = Object.entries(tool.parameters.properties ?? {})
				.filter(([, schema]) => /\bREQUIRED\b/.test(String((schema as any)?.description ?? "")))
				.map(([param]) => param);
			expect(proseHits).toEqual([]);
		});

		test(`${name}: description carries a literal Example: call`, () => {
			expect(tool.description).toMatch(/Example:\s*\w+\(\{/);
		});

		test(`${name}: the Example names the tool and its primary parameter`, () => {
			const example = tool.description.slice(tool.description.indexOf("Example:"));
			expect(example).toContain(`${name}({`);
			expect(example).toContain(`${PRIMARY_PARAM[name]}:`);
		});

		test(`${name}: every optional parameter says so or explains itself`, () => {
			// an optional parameter with no description is undiscoverable, which
			// is the same failure in a quieter form.
			for (const [param, schema] of Object.entries(tool.parameters.properties ?? {})) {
				const description = String((schema as any)?.description ?? "");
				expect(description.length).toBeGreaterThan(0);
			}
		});
	}
});

describe("tool contract: librarian exposes repositories as structured input", () => {
	const librarian = createLibrarianTool() as any;

	test("a repository parameter exists", () => {
		// its absence, while the description talked about repositories, is what
		// made the model disbelieve the schema and read the file.
		expect(librarian.parameters.properties?.repository).toBeDefined();
	});

	test("repository accepts several repos", () => {
		expect(librarian.parameters.properties.repository.type).toBe("array");
		expect(librarian.parameters.properties.repository.items?.type).toBe("string");
	});

	test("repository is optional — a query may name repos in prose", () => {
		expect(librarian.parameters.required ?? []).not.toContain("repository");
	});
});

describe("normalizeRepositories tolerates what models actually send", () => {
	test("a proper array passes through, trimmed", () => {
		expect(normalizeRepositories(["  owner/repo ", "b/c"])).toEqual(["owner/repo", "b/c"]);
	});

	test("a bare string becomes one entry", () => {
		expect(normalizeRepositories("owner/repo")).toEqual(["owner/repo"]);
	});

	test("a JSON-stringified array is parsed", () => {
		// the exact shape that made pi-tasks' array parameters unusable.
		expect(normalizeRepositories('["a/b","c/d"]')).toEqual(["a/b", "c/d"]);
	});

	test("a malformed JSON-looking string is kept whole rather than dropped", () => {
		expect(normalizeRepositories('["a/b"')).toEqual(['["a/b"']);
	});

	test("empty, null and non-string members are dropped", () => {
		expect(normalizeRepositories(null)).toEqual([]);
		expect(normalizeRepositories(undefined)).toEqual([]);
		expect(normalizeRepositories("   ")).toEqual([]);
		expect(normalizeRepositories([1, null, "a/b", "  "])).toEqual(["a/b"]);
	});
});

describe("tool contract: overlapping sub-agents name each other", () => {
	/*
	 * oracle and chad both answer "go look at the code", so the boundary between
	 * them has to be in BOTH descriptions. it was in only one: chad already said
	 * "architecture judgement -> use oracle" while oracle still advertised
	 * "finding difficult bugs across many files", which reads like a chad job.
	 *
	 * an asymmetric hint is worse than none \u2014 it routes to whichever description
	 * the model happened to weigh, and the failure is invisible because both
	 * tools return something plausible.
	 */
	const oracle = createOracleTool() as any;
	const chad = createChadTool() as any;

	test("chad sends judgement questions to the oracle", () => {
		expect(chad.description).toMatch(/use oracle/i);
	});

	test("oracle sends fact-finding to chad", () => {
		expect(oracle.description).toMatch(/use chad/i);
	});

	test("each states what it returns, so the choice is about the deliverable", () => {
		expect(oracle.description).toMatch(/VERDICT|recommendation/);
		expect(chad.description).toMatch(/Evidence|Verified vs inferred/i);
	});

	test("finder stays the locator, not a third opinion", () => {
		const finder = createFinderTool() as any;
		expect(finder.description).toMatch(/not to use this tool/i);
	});
});

describe("tool contract: the spawn graph is acyclic", () => {
	/*
	 * WHY THIS IS NOT PARANOIA
	 *
	 * a cycle here does not merely recurse, it MULTIPLIES. chad is built to be
	 * launched eight at a time; if a chad could spawn chads that is 64 pi
	 * processes at depth 2 and 512 at depth 3, each with its own context and
	 * its own API bill, and the parent sees one tool call sitting there.
	 *
	 * today the graph has exactly one agent->agent edge (delegate -> finder) and
	 * that is enforced by nothing but six hand-written constants. adding one
	 * name to one array is all it takes, and the damage shows up as a stalled
	 * session rather than an error.
	 */
	const allowlists: Record<string, string[]> = {
		finder: finderAllowlist(),
		oracle: oracleAllowlist(),
		code_review: codeReviewAllowlist(),
		librarian: librarianAllowlist(),
		delegate: delegateAllowlist(),
		chad: chadAllowlist(),
	};
	const agents = Object.keys(allowlists);

	test("no sub-agent can spawn itself", () => {
		for (const [name, tools] of Object.entries(allowlists)) {
			expect(tools, `${name} must not be able to spawn ${name}`).not.toContain(name);
		}
	});

	test("no cycle exists anywhere in the graph", () => {
		const visit = (node: string, path: string[]): string[] | null => {
			if (path.includes(node)) return [...path, node];
			for (const child of (allowlists[node] ?? []).filter((t) => agents.includes(t))) {
				const cycle = visit(child, [...path, node]);
				if (cycle) return cycle;
			}
			return null;
		};
		for (const root of agents) {
			expect(visit(root, []), `cycle reachable from ${root}`).toBeNull();
		}
	});

	test("nesting is at most one agent deep, so fan-out cannot compound", () => {
		const depth = (node: string, seen: string[]): number => {
			const children = (allowlists[node] ?? []).filter(
				(t) => agents.includes(t) && !seen.includes(t),
			);
			return children.length === 0
				? 1
				: 1 + Math.max(...children.map((c) => depth(c, [...seen, node])));
		};
		for (const root of agents) {
			expect(depth(root, []), `${root} nests too deeply`).toBeLessThanOrEqual(2);
		}
	});

	test("the one nesting edge is delegate -> finder, and it terminates", () => {
		// stated explicitly so a change to the shape of the graph has to change
		// this line too, rather than silently passing the generic checks above.
		const edges = Object.entries(allowlists).flatMap(([from, tools]) =>
			tools.filter((t) => agents.includes(t)).map((to) => `${from} -> ${to}`),
		);
		expect(edges).toEqual(["delegate -> finder"]);
		expect(allowlists.finder.filter((t) => agents.includes(t))).toEqual([]);
	});
});

describe("tool contract: grammar sampling stays opt-in", () => {
	test("no sub-agent tool declares constrainedSampling", () => {
		// pi-ai's "exactly one required string property" rule only binds tools
		// that opt in (resolveGrammarConstrainedSampling returns early without a
		// `constrainedSampling` field). sub-agent tools must not opt in, or adding
		// a second required parameter would start throwing at request time.
		for (const [name, tool] of SUB_AGENT_TOOLS) {
			expect((tool as any).constrainedSampling, `${name} must not opt in`).toBeUndefined();
		}
	});
});

describe("tool contract: every sub-agent takes a model and a thinking level", () => {
	const models = parseAgentModels({
		models: { grok: { id: "xai/grok-4.6" }, "deepseek-flash": { id: "deepseek/deepseek-flash" } },
		agents: { chad: { model: "grok", thinking: "high" } },
	});
	const tools: Array<[string, any]> = [
		["chad", createChadTool({ models })],
		["delegate", createDelegateTool({ models })],
		["oracle", createOracleTool({ models })],
		["finder", createFinderTool({ models })],
		["librarian", createLibrarianTool({ models })],
		["code_review", createCodeReviewTool({ models })],
		["read_session", createReadSessionTool({ models })],
		["read_web_page", createReadWebPageTool({ models })],
	];

	test("the list here is every agent the model config knows", () => {
		expect(tools.map(([name]) => name).sort()).toEqual([...SUB_AGENTS].sort());
	});

	for (const [name, tool] of tools) {
		test(`${name}: model and thinking are optional enums`, () => {
			const { properties, required = [] } = tool.parameters;
			expect(properties.model.enum).toEqual(["grok", "deepseek-flash"]);
			expect(properties.thinking.enum).toContain("xhigh");
			expect(required).not.toContain("model");
			expect(required).not.toContain("thinking");
		});
	}

	test("an unknown model is refused before any process starts", async () => {
		const dir = mkdtempSync(join(tmpdir(), "route-refusal-"));
		const marker = join(dir, "spawned");
		const stub = join(dir, "pi.sh");
		writeFileSync(stub, `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });
		const prev = process.env.PI_BIN;
		process.env.PI_BIN = stub;
		try {
			const ctx = { cwd: dir, modelRegistry: { find: () => ({}), hasConfiguredAuth: () => true } };
			const result = await createChadTool({ models }).execute!("t1", { prompt: "x", model: "gpt-9" } as any, undefined, undefined, ctx as any);
			expect((result as any).isError).toBe(true);
			expect((result as any).content[0].text).toContain("Use one of: grok, deepseek-flash");
			expect(existsSync(marker)).toBe(false);
		} finally {
			if (prev === undefined) delete process.env.PI_BIN;
			else process.env.PI_BIN = prev;
		}
	});

	test("every result names the model that ran, so the parent can tell the user", () => {
		const result = subAgentResult(
			"answer",
			{ agent: "chad", task: "t", exitCode: 0, messages: [], usage: zeroUsage(), model: "deepseek/deepseek-flash", thinkingLevel: "max", continueId: "c1" },
		);
		expect(result.content.at(-1)).toEqual({
			type: "text",
			text: "answer\n\n---\nmodel: deepseek/deepseek-flash · max\ncontinueId: c1",
		});
	});
});
