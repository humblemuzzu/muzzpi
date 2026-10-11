/**
 * delegate tool tests — pin the exact tool surface a spawned delegate child
 * gets, and the parent-facing description that advertises it.
 *
 * the delegate's allowlist is BUILTIN_TOOLS + EXTENSION_TOOLS merged and run
 * through resolveAliases, which is what piSpawn turns into the native `--tools`
 * flag. testing delegateAllowlist() (rather than the raw constants) pins what
 * the child ACTUALLY receives — aliases and dedupe happen at the spawn seam.
 */

import { describe, expect, test } from "bun:test";
import { createDelegateTool, delegateAllowlist } from "./delegate";

describe("delegate tool allowlist", () => {
	const allowlist = delegateAllowlist();

	test("includes the web toolset: web_search, read_web_page, screenshot", () => {
		for (const tool of ["web_search", "read_web_page", "screenshot"]) {
			expect(allowlist).toContain(tool);
		}
	});

	test("keeps the mutation toolset: read, grep, find, ls, bash, edit, write, format_file, skill, finder", () => {
		for (const tool of [
			"read", "grep", "find", "ls", "bash",
			"edit", "write", "format_file", "skill", "finder",
		]) {
			expect(allowlist).toContain(tool);
		}
	});

	test("is deduped (no tool appears twice)", () => {
		expect(new Set(allowlist).size).toBe(allowlist.length);
	});

	test("has no undo_edit/redo_edit: undo history is keyed to the child's own session", () => {
		expect(allowlist).not.toContain("undo_edit");
		expect(allowlist).not.toContain("redo_edit");
	});

	test("resolves the glob alias to find", () => {
		expect(allowlist).toContain("find");
		expect(allowlist).not.toContain("glob");
	});
});

describe("delegate description advertises its tools to the parent", () => {
	const delegate = createDelegateTool() as any;

	test("mentions web search", () => {
		expect(delegate.description).toMatch(/web_search|web search/i);
	});

	test("mentions web page reading", () => {
		expect(delegate.description).toMatch(/read_web_page|web page/i);
	});

	test("mentions screenshot", () => {
		expect(delegate.description).toMatch(/screenshot/i);
	});

	test("still names the example call with the primary parameter", () => {
		expect(delegate.description).toMatch(/Example:\s*delegate\(\{/);
		expect(delegate.description).toContain("prompt:");
	});
});
