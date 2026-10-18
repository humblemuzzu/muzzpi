import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formatReviewSummary, parseReviewMarkdown } from "./code-review";

const REPORT = `# Code review

## Summary

Adds a cache. One real bug.

## Comments

### high · The key ignores the locale

- **Filename:** \`src/cache.ts\`
- **Start line:** 42
- **End line:** 45
- **Comment type:** bug
- **Text:** The key ignores the locale.
- **Why:** Two locales share one entry.
- **Checked:** ran \`bun test cache.test.ts\` → "expected 2 entries, got 1"
- **Fix:** Include the locale in the key.

\`\`\`ts
const key = \`\${locale}:\${id}\`;
\`\`\`

### **Low** · Good eviction tests

- **Filename:** src/cache.test.ts
- **Start line:** 1
- **End line:** 30
- **Comment type:** compliment
- **Text:** Good eviction tests.
- **Why:** They pin the LRU order.
`;

describe("parseReviewMarkdown", () => {
	test("reads every labelled field of every comment", () => {
		const comments = parseReviewMarkdown(REPORT);
		expect(comments).toHaveLength(2);
		expect(comments[0]).toEqual({
			filename: "src/cache.ts",
			startLine: 42,
			endLine: 45,
			severity: "high",
			commentType: "bug",
			text: "The key ignores the locale.",
			why: "Two locales share one entry.",
			checked: 'ran `bun test cache.test.ts` → "expected 2 entries, got 1"',
			fix: "Include the locale in the key.",
		});
		expect(comments[1]).toMatchObject({ severity: "low", commentType: "compliment", fix: "" });
	});

	test("no ### Comment heading, no comments", () => {
		expect(parseReviewMarkdown("# Code review\n\n## Summary\n\nClean.\n\n## Comments\n")).toEqual([]);
		expect(parseReviewMarkdown("")).toEqual([]);
	});

	test("in ## Comments every ### heading is one comment, whatever its title", () => {
		const report = "## Comments\n\n### low · Naming\n\n### Cache key\n\n- **Severity:** high\n\n### 2. critical — SQL injection\n";
		expect(parseReviewMarkdown(report).map((c) => c.severity)).toEqual(["low", "high", "critical"]);
	});

	test("severity comes from the heading's first word only; otherwise from the Severity bullet", () => {
		const report = "### Comment: low-level socket leak\n\n- **Severity:** high\n\n### Socket leak, not low priority\n";
		expect(parseReviewMarkdown(report).map((c) => c.severity)).toEqual(["high", ""]);
	});

	test("a whole report wrapped in one code box is unwrapped, and its inner code boxes still hide decoys", () => {
		const inner = REPORT.replace("const key", "### Comment\n- **Severity:** critical\nconst key");
		const wrapped = "```markdown\n" + inner + "```\n";
		expect(parseReviewMarkdown(wrapped).map((c) => c.severity)).toEqual(["high", "low"]);
	});

	test("when every comment sits inside code boxes, they are still counted rather than lost", () => {
		const report = "## Comments\n\n```md\n### Comment\n\n- **Severity:** high\n```\n\nsee above\n\n```md\n### Comment\n\n- **Severity:** low\n```\n";
		expect(parseReviewMarkdown(report).map((c) => c.severity)).toEqual(["high", "low"]);
	});

	test("numbered and titled comment headings still count", () => {
		const report = "### Comment 1\n\n- **Severity:** high\n\n### Comment: null check\n\n- **Severity:** low\n";
		expect(parseReviewMarkdown(report).map((c) => c.severity)).toEqual(["high", "low"]);
	});

	test("a ### Comment or a label inside a fenced block is neither a comment nor a field", () => {
		const report = [
			"## Comments",
			"",
			"### Comment",
			"",
			"- **Filename:** a.md",
			"- **Severity:** medium",
			"- **Fix:** use this shape",
			"",
			"```md",
			"### Comment",
			"- **Filename:** b.md",
			"- **Text:** not text",
			"```",
			"",
			"- **Text:** the real text",
		].join("\n");
		const comments = parseReviewMarkdown(report);
		expect(comments).toHaveLength(1);
		expect(comments[0]).toMatchObject({ filename: "a.md", text: "the real text", fix: "use this shape" });
	});

	test("an unclosed fence while the report is still streaming hides its contents", () => {
		const partial = "### Comment\n\n- **Severity:** low\n- **Fix:** like so\n\n```md\n### Comment\n- **Severity:** high\n";
		expect(parseReviewMarkdown(partial).map((c) => c.severity)).toEqual(["low"]);
	});

	test("only the ## Comments section is parsed when it exists", () => {
		const report = "### Comment\n\n- **Severity:** high\n\n## Comments\n\n### Comment\n\n- **Severity:** low\n\n## Notes\n\n### Comment\n\n- **Severity:** critical\n";
		expect(parseReviewMarkdown(report).map((c) => c.severity)).toEqual(["low"]);
	});

	test("labels read without a bullet, from a numbered list, or with the colon outside the bold", () => {
		const report = "### Comment\n\n**Severity:** medium\n1. **Start line:** 7\n- **End line**: 9\n";
		expect(parseReviewMarkdown(report)[0]).toMatchObject({ severity: "medium", startLine: 7, endLine: 9 });
	});

	test("bold and backticked values are unwrapped", () => {
		const [comment] = parseReviewMarkdown("### Comment\n\n- **Filename:** **a.ts**\n- **Text:** `b`\n");
		expect(comment).toMatchObject({ filename: "a.ts", text: "b" });
	});

	test("severity and comment type are read from the first known term, not by deleting characters", () => {
		const report = "### Comment\n\n- **Severity:** High (crashes on save)\n- **Comment type:** suggested edit\n\n### Comment\n\n- **Severity:** below the bar\n- **Comment type:** Non-actionable\n";
		const comments = parseReviewMarkdown(report);
		expect(comments.map((c) => [c.severity, c.commentType])).toEqual([
			["high", "suggested_edit"],
			["", "non_actionable"],
		]);
	});

	test("a Checked line sits beside the other fields without disturbing them", () => {
		const report = "### Comment\n\n- **Severity:** medium\n- **Text:** t\n- **Checked:** ran `bun test` → \"expected 2, got 1\"\n- **Fix:** f\n";
		expect(parseReviewMarkdown(report)[0]).toMatchObject({ severity: "medium", text: "t", fix: "f" });
	});

	test("a review of nothing has no comments and no summary line", () => {
		const report = "# Code review\n\n## Summary\n\n`git status --porcelain` was empty.\n\n## Comments\n\nNo changes to review.\n";
		expect(parseReviewMarkdown(report)).toEqual([]);
		expect(formatReviewSummary(parseReviewMarkdown(report))).toBe("");
	});

	test("a malformed line number reads as 0", () => {
		const [comment] = parseReviewMarkdown("### Comment\n\n- **Start line:** n/a\n");
		expect(comment.startLine).toBe(0);
	});
});

describe("the report prompt asks for the shape the parser reads", () => {
	const prompt = readFileSync(join(import.meta.dir, "../../agents/prompt.amp.code-review-report.md"), "utf8");

	test("every heading and label the parser looks for is in the prompt's template", () => {
		for (const line of ["## Comments", "### high · ", "- **Filename:**", "- **Start line:**", "- **End line:**", "- **Comment type:**", "- **Text:**", "- **Why:**", "- **Checked:**", "- **Fix:**", "`ran <command>", "`traced <file:line>", "not verified"]) {
			expect(prompt).toContain(line);
		}
	});

	test("the prompt's own template parses as one comment with its severity and type", () => {
		const template = prompt.match(/```markdown\n([\s\S]*?)\n```\n/)?.[1];
		if (template === undefined) throw new Error("no ```markdown template block found in prompt.amp.code-review-report.md");
		const comments = parseReviewMarkdown(template);
		expect(comments).toEqual([expect.objectContaining({ severity: "high", commentType: "bug", startLine: 42, endLine: 45 })]);
		expect(formatReviewSummary(comments)).toBe("1 comment: 1 high");
	});
});

describe("formatReviewSummary", () => {
	test("counts by severity, most severe first", () => {
		expect(formatReviewSummary(parseReviewMarkdown(REPORT))).toBe("2 comments: 1 high, 1 low");
	});

	test("nothing parsed, no summary line", () => {
		expect(formatReviewSummary([])).toBe("");
	});

	test("a comment with no readable severity is counted as unrated, never dropped", () => {
		const comments = parseReviewMarkdown("### Comment\n\n- **Severity:** high\n\n### Comment\n\n- **Text:** no severity\n");
		expect(formatReviewSummary(comments)).toBe("2 comments: 1 high, 1 unrated");
		expect(formatReviewSummary(parseReviewMarkdown("### Comment\n"))).toBe("1 comment: 1 unrated");
	});

	test("a bug counts as proven only when Checked is `ran … → …` or `traced … → …`; other types are never flagged", () => {
		const comment = (type: string, checked?: string) =>
			`### Comment\n\n- **Severity:** medium\n- **Comment type:** ${type}\n${checked === undefined ? "" : `- **Checked:** ${checked}\n`}`;
		const report = [
			comment("bug", "not verified"),
			comment("bug", "Unverified — no repro"),
			comment("bug"),
			comment("bug", "n/a"),
			comment("bug", "read the file, did not run it"),
			comment("bug", "Ran `bun test` → fails"),
			comment("bug", "**ran** a probe → crashes"),
			comment("bug", "traced a.ts:1 → b.ts:9"),
			comment("bug", "traced a.ts:1 -> b.ts:9"),
			comment("bug", "ran nothing — could not reproduce"),
			comment("bug", "traced the caller"),
			comment("suggested_edit"),
		].join("\n");
		expect(formatReviewSummary(parseReviewMarkdown(report))).toBe("12 comments: 12 medium · 7 unverified");
	});
});
