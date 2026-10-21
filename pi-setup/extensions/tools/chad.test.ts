/**
 * chad tool tests — pin the read-only surface.
 *
 * no mutation tool may reach the child. `chad` is read-only by construction,
 * not by prompt, and a tool quietly added to the allowlist would give it back
 * the ability to write with nothing failing — so it is asserted from several
 * directions.
 */

import { describe, expect, test } from "bun:test";
import { createChadTool, chadAllowlist } from "./chad";
import { delegateAllowlist } from "./delegate";

describe("chad allowlist: read-only by construction", () => {
	const allowlist = chadAllowlist();

	test("carries NO mutation tool of any kind", () => {
		// the whole safety argument rests on this list. `bash` is present but
		// gated by lib/read-only-bash.ts; everything here writes unconditionally.
		for (const tool of ["edit", "write", "format_file", "undo_edit", "redo_edit"]) {
			expect(allowlist).not.toContain(tool);
		}
	});

	test("delegate has edit and write and chad does not — they are not the same tool", () => {
		expect(delegateAllowlist()).toEqual(expect.arrayContaining(["edit", "write"]));
		expect(allowlist).not.toContain("edit");
		expect(allowlist).not.toContain("write");
	});

	test("has the research toolset", () => {
		for (const tool of [
			"read", "grep", "find", "ls", "bash", "skill",
			"web_search", "x_search", "read_web_page", "screenshot",
		]) {
			expect(allowlist).toContain(tool);
		}
	});

	test("has the seven github tools directly, rather than nesting a librarian", () => {
		// a nested librarian is a whole extra process to reach tools chad can
		// call itself.
		for (const tool of [
			"read_github", "search_github", "list_directory_github",
			"list_repositories", "glob_github", "commit_search", "diff",
		]) {
			expect(allowlist).toContain(tool);
		}
	});

	test("excludes the sub-agents — nesting one is a process for tools chad already has", () => {
		for (const tool of ["oracle", "finder", "librarian", "code_review"]) {
			expect(allowlist).not.toContain(tool);
		}
	});

	test("cannot spawn itself or a delegate — a swarm that spawns swarms is a fork bomb", () => {
		expect(allowlist).not.toContain("chad");
		expect(allowlist).not.toContain("delegate");
	});

	test("is deduped and alias-resolved", () => {
		expect(new Set(allowlist).size).toBe(allowlist.length);
		expect(allowlist).toContain("find");
		expect(allowlist).not.toContain("glob");
	});
});

describe("chad description tells the parent what it is", () => {
	const chad = createChadTool() as any;

	test("states the read-only constraint in the description, not only in the prompt", () => {
		// the description is what the parent plans against; a parent that thinks
		// chad can edit will hand it edits and get refusals back.
		expect(chad.description).toMatch(/CANNOT CHANGE ANYTHING/);
		expect(chad.description).toMatch(/read-only/i);
	});

	test("points at delegate for work that writes", () => {
		expect(chad.description).toMatch(/delegate/);
	});

	test("advertises swarm use", () => {
		expect(chad.description).toMatch(/several can be launched at once|single message/i);
	});

	test("names its own tools", () => {
		for (const tool of ["web_search", "x_search", "read_web_page", "screenshot", "bash", "GitHub"]) {
			expect(chad.description).toContain(tool);
		}
	});

	test("carries a literal Example: call naming the primary parameter", () => {
		expect(chad.description).toMatch(/Example:\s*chad\(\{/);
		expect(chad.description).toContain("prompt:");
	});

	test("never advertises a mutation tool", () => {
		// edit/write may only appear as a denial. the tool inventory line is
		// what a model reads as "what I get", so they must not appear there.
		const toolsLine = chad.description
			.split("\n")
			.find((line: string) => line.startsWith("Tools:"));
		expect(toolsLine).toBeDefined();
		expect(toolsLine).not.toMatch(/\b(edit|write)\b/);
		expect(chad.description).toContain("no edit or write");
	});
});

describe("chad schema", () => {
	const chad = createChadTool() as any;

	test("prompt is required and is a string", () => {
		expect(chad.parameters.required ?? []).toContain("prompt");
		expect(chad.parameters.properties.prompt.type).toBe("string");
	});

	test("continueId exists — a chad is resumable like a delegate", () => {
		expect(chad.parameters.properties.continueId).toBeDefined();
		expect(chad.parameters.required ?? []).not.toContain("continueId");
	});

	test("takes no scope parameter", () => {
		// scope existed to divide write-ownership between concurrent agents.
		// nothing writes, so it would be a required field that does nothing.
		expect(chad.parameters.properties.scope).toBeUndefined();
	});
});

