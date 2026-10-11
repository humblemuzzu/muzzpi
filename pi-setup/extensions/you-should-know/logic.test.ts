/**
 * unit tests for you-should-know's pure half — no pi deps, instant, free.
 *
 * run: bun test pi-setup/extensions/you-should-know/logic.test.ts
 *
 * the parser and the sub-agent evidence extractor are the parts that must not
 * regress: a model reply that fails to parse silently shows nothing, a reply that
 * parses wrongly shows a note built from the wrong line, and a sub-agent block
 * that misreports what a child did is worse than no block at all.
 */

import { describe, expect, it } from "bun:test";
import {
	FREE_IGNORES,
	HISTORY_MAX,
	MAX_SKIP,
	collectSubAgentReports,
	describeCall,
	editPaths,
	emptyState,
	flatten,
	nextSkip,
	normalizeLine,
	parseNote,
	pushCapped,
	renderPrompt,
	renderSubAgents,
	textOf,
	type SubAgentReport,
} from "./logic";

describe("flatten", () => {
	it("collapses the cursor-moving whitespace that would smear a one-line widget", () => {
		expect(flatten("a\nb\tc")).toBe("a b c");
		expect(flatten("a\r\n\r\nb")).toBe("a b");
	});

	it("keeps ANSI colour codes and drops other control characters", () => {
		expect(flatten("\x1b[31mred\x1b[39m")).toBe("\x1b[31mred\x1b[39m");
		expect(flatten("a\x00\x07b")).toBe("ab");
	});

	it("trims and collapses runs of spaces", () => {
		expect(flatten("  a    b  ")).toBe("a b");
	});
});

describe("emptyState", () => {
	it("starts off, so a fresh setup never spends before being asked", () => {
		expect(emptyState().enabled).toBe(false);
	});
});

describe("normalizeLine", () => {
	it("makes two spellings of the same note compare equal", () => {
		expect(normalizeLine("The Agent EDITED  test files!")).toBe(normalizeLine("the agent edited test files"));
	});
});

describe("nextSkip", () => {
	it("gives the first ignores away, then doubles, then caps", () => {
		expect(nextSkip(0)).toBe(0);
		expect(nextSkip(FREE_IGNORES)).toBe(0);
		expect(nextSkip(FREE_IGNORES + 1)).toBe(1);
		expect(nextSkip(FREE_IGNORES + 2)).toBe(2);
		expect(nextSkip(FREE_IGNORES + 3)).toBe(4);
		expect(nextSkip(FREE_IGNORES + 20)).toBe(MAX_SKIP);
	});
});

describe("pushCapped", () => {
	it("keeps only the newest entries", () => {
		const list: string[] = [];
		for (let i = 0; i < HISTORY_MAX + 10; i++) pushCapped(list, `line ${i}`);
		expect(list.length).toBe(HISTORY_MAX);
		expect(list[0]).toBe("line 10");
	});
});

describe("parseNote", () => {
	it("treats every spelling of 'nothing to say' as none", () => {
		expect(parseNote("learn: none")).toBe("none");
		expect(parseNote("learn: none.")).toBe("none");
		expect(parseNote("learn: None")).toBe("none");
		expect(parseNote("  learn:  none  ")).toBe("none");
		expect(parseNote("learn: ok")).toBe("none");
	});

	it("returns null when there is no learn line at all", () => {
		expect(parseNote("I have nothing to report.")).toBe(null);
		expect(parseNote("")).toBe(null);
		expect(parseNote("tag: Heads up")).toBe(null);
	});

	it("parses a full note", () => {
		const parsed = parseNote(
			[
				"learn: The sub-agent edited two test files instead of the source.",
				"tag: Heads up",
				"evidence: test/parser.test.ts:12; edit",
				"explain:",
				"**Tests were loosened**",
				"",
				"* The child changed the assertions.",
			].join("\n"),
		);
		expect(parsed).not.toBe(null);
		expect(parsed).not.toBe("none");
		if (parsed === null || parsed === "none") return;
		expect(parsed.tag).toBe("Heads up");
		expect(parsed.line).toBe("The sub-agent edited two test files instead of the source.");
		expect(parsed.evidence).toBe("test/parser.test.ts:12; edit");
		expect(parsed.explain).toContain("**Tests were loosened**");
		expect(parsed.explain).toContain("changed the assertions");
	});

	it("survives the markdown and quoting the model wraps replies in", () => {
		const parsed = parseNote('> **learn:** "Cache writes are free on this provider."\n> tag: **you should know**');
		expect(parsed).not.toBe(null);
		if (parsed === null || parsed === "none") return;
		expect(parsed.line).toBe("Cache writes are free on this provider.");
		expect(parsed.tag).toBe("You should know");
	});

	it("defaults an unreadable tag to 'You should know'", () => {
		const parsed = parseNote("learn: Something worth knowing about the build.");
		if (parsed === null || parsed === "none") throw new Error("expected a note");
		expect(parsed.tag).toBe("You should know");
	});

	it("drops an evidence line that says none", () => {
		const parsed = parseNote("learn: A real thing worth nodding at.\nevidence: none");
		if (parsed === null || parsed === "none") throw new Error("expected a note");
		expect(parsed.evidence).toBeUndefined();
	});

	it("takes only the first learn line", () => {
		const parsed = parseNote("learn: First one here.\nlearn: Second one here.");
		if (parsed === null || parsed === "none") throw new Error("expected a note");
		expect(parsed.line).toBe("First one here.");
	});

	it("keeps a single-line explain that shares the label's line", () => {
		const parsed = parseNote("learn: A real thing worth nodding at.\nexplain: **Title** body");
		if (parsed === null || parsed === "none") throw new Error("expected a note");
		expect(parsed.explain).toBe("**Title** body");
	});
});

describe("describeCall", () => {
	it("prefers the most specific argument it knows", () => {
		expect(describeCall("read", { path: "src/a.ts" })).toBe("read(src/a.ts)");
		expect(describeCall("find", { filePattern: "**/*.ts", cmd: "ls" })).toBe("find(**/*.ts)");
	});

	it("shows only the first line of a multi-line command", () => {
		expect(describeCall("bash", { cmd: "bun test\nrm -rf /" })).toBe("bash(bun test)");
	});

	it("falls back to the bare name", () => {
		expect(describeCall("ls", {})).toBe("ls");
		expect(describeCall("read", { path: 42 })).toBe("read");
		expect(describeCall("read", { path: "   " })).toBe("read");
		expect(describeCall("read", null)).toBe("read");
	});

	it("keeps the report one line and short", () => {
		const long = describeCall("bash", { cmd: `echo ${"x".repeat(200)}` });
		expect(long.length).toBeLessThanOrEqual(70);
		expect(long).toEndWith("…)");
	});
});

describe("editPaths", () => {
	it("reads the path argument of an editing tool", () => {
		expect(editPaths("write", { path: "a/b.ts" })).toEqual(["a/b.ts"]);
		expect(editPaths("edit", { file: "a/b.ts" })).toEqual(["a/b.ts"]);
	});

	it("reads Claude's file_path spelling", () => {
		expect(editPaths("edit", { file_path: "src/one.ts" })).toEqual(["src/one.ts"]);
	});

	it("ignores tools that cannot change a file", () => {
		expect(editPaths("read", { path: "a/b.ts" })).toEqual([]);
		expect(editPaths("bash", { cmd: "echo hi" })).toEqual([]);
	});

});

describe("textOf", () => {
	it("joins text blocks and ignores everything else", () => {
		expect(textOf({ content: [{ type: "text", text: "a" }, { type: "toolCall" }, { type: "text", text: "b" }] })).toBe("a\nb");
	});

	it("handles a plain string body and junk", () => {
		expect(textOf({ content: "hello" })).toBe("hello");
		expect(textOf(null)).toBe("");
		expect(textOf({})).toBe("");
	});
});

describe("collectSubAgentReports", () => {
	const entries = [
		{ type: "message", message: { role: "user", content: "hi" } },
		{
			type: "message",
			message: {
				role: "toolResult",
				toolName: "chad",
				details: {
					agent: "chad",
					task: "make the parser tests pass",
					exitCode: 0,
					messages: [
						{ role: "user", content: [{ type: "text", text: "task" }] },
						{
							role: "assistant",
							content: [
								{ type: "toolCall", name: "edit", arguments: { path: "test/parser.test.ts" } },
								{ type: "toolCall", name: "bash", arguments: { cmd: "bun test\nsecond line" } },
								{ type: "text", text: "I fixed the parser by updating the tests." },
							],
						},
					],
				},
			},
		},
		{ type: "message", message: { role: "toolResult", toolName: "read", details: {} } },
	];

	it("pulls the child's edits, calls and claim out of the tool result", () => {
		const reports = collectSubAgentReports(entries, 3);
		expect(reports.length).toBe(1);
		const report = reports[0]!;
		expect(report.agent).toBe("chad");
		expect(report.task).toBe("make the parser tests pass");
		expect(report.exitCode).toBe(0);
		expect(report.edits).toEqual(["test/parser.test.ts"]);
		expect(report.calls[0]).toBe("edit(test/parser.test.ts)");
		expect(report.calls[1]).toBe("bash(bun test)");
		expect(report.final).toBe("I fixed the parser by updating the tests.");
	});

	it("ignores tool results that are not sub-agents", () => {
		expect(collectSubAgentReports([entries[2]!], 3)).toEqual([]);
	});

	it("keeps only the newest reports", () => {
		const many = Array.from({ length: 6 }, (_, i) => ({
			type: "message",
			message: { role: "toolResult", details: { agent: `a${i}`, task: "t", messages: [] } },
		}));
		const reports = collectSubAgentReports(many, 3);
		expect(reports.map((r) => r.agent)).toEqual(["a3", "a4", "a5"]);
	});
});

describe("renderSubAgents", () => {
	it("adds nothing when there were no sub-agents", () => {
		expect(renderSubAgents([])).toBe("");
	});

	it("says a claim is a claim, not evidence", () => {
		const report: SubAgentReport = {
			agent: "oracle",
			task: "review the cache plan",
			edits: [],
			calls: ["read(a.ts)"],
			final: "Looks fine.",
		};
		const block = renderSubAgents([report]);
		expect(block).toContain('sub-agent "oracle"');
		expect(block).toContain("files it edited: none");
		expect(block).toContain("read(a.ts)");
		expect(block).toContain("a claim, not evidence");
	});
});

describe("renderPrompt", () => {
	it("fills all three placeholders", () => {
		const out = renderPrompt("seen:\n{{SEEN}}\nknown:\n{{KNOWN}}\n{{SUBAGENTS}}", {
			enabled: true,
			seen: ["one"],
			known: [],
			ignoredInARow: 0,
			skip: 0,
			checks: 0,
			shown: 0,
		}, []);
		expect(out).toContain("- one");
		expect(out).toContain("- (none yet)");
		expect(out).not.toContain("{{");
	});
});
