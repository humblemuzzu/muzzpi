/**
 * sub-agent prompt tests.
 *
 * the invariant that matters: a child's prompt names EXACTLY the tools that
 * child was given — never one more, never one fewer. every agent brings a
 * different list, so each is checked against the same allowlist function that
 * piSpawn turns into `--tools`.
 *
 * checking the real allowlists rather than hand-written lists is the point: if
 * someone adds a tool to oracle's EXTENSION_TOOLS, this suite keeps passing
 * (correctly), but if the prompt ever stops reflecting the allowlist it fails.
 */

import { describe, expect, test } from "bun:test";
import { buildSubAgentPrompt, parseToolList } from "./sub-agent-prompt";
import { oracleAllowlist } from "../oracle";
import { delegateAllowlist } from "../delegate";
import { finderAllowlist } from "../finder";
import { librarianAllowlist } from "../librarian";
import { codeReviewAllowlist } from "../code-review";

/** the tool names the prompt actually advertises, pulled back out of its bullets. */
function bulletTools(prompt: string): string[] {
	return [...prompt.matchAll(/^- `([^`]+)`$/gm)].map((match) => match[1]);
}

describe("parseToolList", () => {
	test("splits a plain csv", () => {
		expect(parseToolList("read,grep,find,ls")).toEqual(["read", "grep", "find", "ls"]);
	});

	test("trims whitespace around names", () => {
		expect(parseToolList(" read , grep ")).toEqual(["read", "grep"]);
	});

	test("drops empty entries rather than emitting blank bullets", () => {
		expect(parseToolList("read,,grep,")).toEqual(["read", "grep"]);
	});

	test("an empty or blank value yields nothing — the caller falls back to the parent prompt", () => {
		expect(parseToolList("")).toEqual([]);
		expect(parseToolList(" , , ")).toEqual([]);
	});
});

describe("buildSubAgentPrompt", () => {
	const prompt = buildSubAgentPrompt("Amp", "read,grep,find,ls");

	test("names the identity", () => {
		expect(prompt).toContain("# Amp — sub-agent");
	});

	test("lists exactly the tools it was given, in order", () => {
		expect(bulletTools(prompt)).toEqual(["read", "grep", "find", "ls"]);
	});

	test("states the count", () => {
		expect(prompt).toContain("Those 4 are the only tools registered in this session");
	});

	test("says no other tool exists", () => {
		expect(prompt).toMatch(/do not attempt to call any other tool/i);
		expect(prompt).toContain("a tool may reach you capitalised (`Read`). It is");
		expect(prompt).not.toContain("mcp__tools__");
	});

	test("tells the child it has no parent context", () => {
		expect(prompt).toMatch(/share\s+none of its conversation context/i);
	});

	test("carries the working habits delegate would otherwise lose", () => {
		// delegate is the one sub-agent with no agent prompt of its own.
		expect(prompt).toMatch(/Read first/);
		expect(prompt).toMatch(/Verify/);
		expect(prompt).toMatch(/root cause of the task you were given/);
		expect(prompt).toMatch(/blocked or unverified instead of implying it is done/);
	});

	test("leaves the shared behaviour rules to rules.amp.md", () => {
		expect(prompt).not.toMatch(/no comments by default/i);
		expect(prompt).not.toMatch(/out of scope/i);
		expect(prompt).not.toMatch(/Cite what you claim/);
	});

	test("says the final message is the whole answer", () => {
		expect(prompt).toMatch(/final message is the entire answer/i);
	});

	test("carries none of the parent-only claims that confused children", () => {
		// the exact lines a child used to read and act on. see the module header.
		expect(prompt).not.toContain("The full tool surface");
		expect(prompt).not.toContain("dedicated sub-agents are exactly five tools");
		expect(prompt).not.toContain("every file modification");
		expect(prompt).not.toContain("There is no separate `edit` or `write` tool");
	});

	test("a single-tool child reads as english, not 'These 1 are'", () => {
		// read_web_page and read_session children get exactly one tool.
		const single = buildSubAgentPrompt("Amp", "read");
		expect(bulletTools(single)).toEqual(["read"]);
		expect(single).toContain("That is the only tool registered in this session");
		expect(single).not.toContain("Those 1 are");
	});
});

describe("every sub-agent's prompt matches its real allowlist", () => {
	const agents: Array<[string, string[]]> = [
		["finder", finderAllowlist()],
		["oracle", oracleAllowlist()],
		["code_review", codeReviewAllowlist()],
		["librarian", librarianAllowlist()],
		["delegate", delegateAllowlist()],
		// the two fetch/read tools that spawn a child with a single read-only tool
		["read_web_page / read_session", ["read"]],
	];

	for (const [agent, allowlist] of agents) {
		test(`${agent}: prompt names exactly its ${allowlist.length} tool(s)`, () => {
			const built = buildSubAgentPrompt("Amp", allowlist.join(","));
			expect(bulletTools(built)).toEqual(allowlist);
		});

		test(`${agent}: prompt never names a tool the child lacks`, () => {
			const built = buildSubAgentPrompt("Amp", allowlist.join(","));
			const advertised = new Set(bulletTools(built));
			for (const tool of advertised) {
				expect(allowlist).toContain(tool);
			}
			expect(advertised.size).toBe(allowlist.length);
		});
	}

	test("the agents genuinely differ — this is not one shared list", () => {
		expect(finderAllowlist()).not.toEqual(oracleAllowlist());
		expect(librarianAllowlist()).not.toEqual(delegateAllowlist());
		// librarian is github-only: no local file tools at all
		expect(librarianAllowlist()).not.toContain("read");
		expect(librarianAllowlist()).toContain("read_github");
		// delegate is the only child that can mutate files
		expect(delegateAllowlist()).toEqual(expect.arrayContaining(["edit", "write"]));
		expect(oracleAllowlist()).not.toContain("edit");
		expect(oracleAllowlist()).not.toContain("write");
		expect(finderAllowlist()).not.toContain("bash");
	});
});
