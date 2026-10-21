/**
 * oracle tool tests — pin the exact tool surface a spawned oracle child gets,
 * and the parent-facing description that advertises it.
 *
 * the oracle's allowlist is BUILTIN_TOOLS + EXTENSION_TOOLS merged and run
 * through resolveAliases, which is what piSpawn turns into the native `--tools`
 * flag. testing oracleAllowlist() (rather than the raw constants) pins what the
 * child ACTUALLY receives — aliases and dedupe happen at the spawn seam.
 */

import { describe, expect, test } from "bun:test";
import { createOracleTool, oracleAllowlist } from "./oracle";

describe("oracle tool allowlist", () => {
	const allowlist = oracleAllowlist();

	test("includes the web toolset: web_search, x_search, read_web_page, screenshot", () => {
		for (const tool of ["web_search", "x_search", "read_web_page", "screenshot"]) {
			expect(allowlist).toContain(tool);
		}
	});

	test("keeps the local toolset: read, grep, find, ls, bash", () => {
		for (const tool of ["read", "grep", "find", "ls", "bash"]) {
			expect(allowlist).toContain(tool);
		}
	});

	test("is deduped (no tool appears twice)", () => {
		expect(new Set(allowlist).size).toBe(allowlist.length);
	});

	test("resolves the glob alias to find", () => {
		// legacy configs/frontmatter may still name the tool `glob`; pi's
		// built-in is `find`, and TOOL_ALIASES bridges that gap.
		expect(allowlist).toContain("find");
		expect(allowlist).not.toContain("glob");
	});
});

describe("oracle description advertises its tools to the parent", () => {
	const oracle = createOracleTool() as any;

	test("mentions web search", () => {
		expect(oracle.description).toMatch(/web_search|web search/i);
	});

	test("mentions web page reading", () => {
		expect(oracle.description).toMatch(/read_web_page|web page/i);
	});

	test("mentions screenshot", () => {
		expect(oracle.description).toMatch(/screenshot/i);
	});

	test("still names the example call with the primary parameter", () => {
		expect(oracle.description).toMatch(/Example:\s*oracle\(\{/);
		expect(oracle.description).toContain("task:");
	});
});
