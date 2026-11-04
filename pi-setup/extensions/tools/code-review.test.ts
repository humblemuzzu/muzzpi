import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formatReviewSummary, parseReviewMarkdown, reviewSpawnParts } from "./code-review";

const REPORT = `# Code review

## Summary

**1 important · 1 nit · 1 pre-existing**

Adds a cache. One real bug.

## Important

### high · The key ignores the locale

- **Filename:** \`src/cache.ts\`
- **Start line:** 42
- **End line:** 45
- **Text:** The key ignores the locale.
- **Why:** Two locales share one entry.
- **Checked:** ran \`bun test cache.test.ts\` → "expected 2 entries, got 1"
- **Fix:** Include the locale in the key.
- **Instances:** src/cache.ts:42, src/feed.ts:9

\`\`\`ts
const key = \`\${locale}:\${id}\`;
\`\`\`

## Nits

### nit · Stale name in the log line

- **Filename:** src/cache.ts
- **Start line:** 60
- **End line:** 60
- **Text:** The log still says "store".
- **Why:** It points readers at a file that no longer exists.
- **Checked:** read src/cache.ts:60
- **Fix:** Say "cache".

## Pre-existing

### pre-existing · Eviction never runs

- **Filename:** src/lru.ts
- **Start line:** 10
- **End line:** 12
- **Text:** The size check compares with the wrong field.
- **Why:** The cache grows without bound.
- **Checked:** traced src/lru.ts:10 → src/lru.ts:12
`;

describe("parseReviewMarkdown", () => {
	test("reads every finding from the Important, Nits and Pre-existing sections", () => {
		const findings = parseReviewMarkdown(REPORT);
		expect(findings.map((f) => f.severity)).toEqual(["high", "nit", "pre-existing"]);
		expect(findings[0]).toEqual({
			filename: "src/cache.ts",
			startLine: 42,
			endLine: 45,
			severity: "high",
			commentType: "",
			title: "The key ignores the locale",
			text: "The key ignores the locale.",
			why: "Two locales share one entry.",
			checked: 'ran `bun test cache.test.ts` → "expected 2 entries, got 1"',
			fix: "Include the locale in the key.",
			instances: "src/cache.ts:42, src/feed.ts:9",
		});
		expect(findings[2]).toMatchObject({ title: "Eviction never runs", fix: "" });
	});

	test("a clean review has no findings and no summary line", () => {
		const clean = "# Code review\n\n## Summary\n\n**Nothing to fix.**\n\nAdds a parser; it handles every input it can get.\n";
		expect(parseReviewMarkdown(clean)).toEqual([]);
		expect(formatReviewSummary(parseReviewMarkdown(clean))).toBe("");
		expect(parseReviewMarkdown("")).toEqual([]);
	});

	test("a ### heading in the Summary is not a finding", () => {
		const report = "## Summary\n\n### critical · not a finding\n\n## Important\n\n### medium · real\n";
		expect(parseReviewMarkdown(report).map((f) => f.severity)).toEqual(["medium"]);
	});

	test("reports written before the sections still parse: ## Comments, low and comment types", () => {
		const legacy = "## Comments\n\n### high · Bug\n\n- **Comment type:** bug\n\n### **Low** · Good tests\n\n- **Comment type:** compliment\n";
		const findings = parseReviewMarkdown(legacy);
		expect(findings.map((f) => [f.severity, f.commentType])).toEqual([
			["high", "bug"],
			["nit", "compliment"],
		]);
	});

	test("in a findings section every ### heading is one finding, whatever its title", () => {
		const report = "## Comments\n\n### low · Naming\n\n### Cache key\n\n- **Severity:** high\n\n### 2. critical — SQL injection\n";
		expect(parseReviewMarkdown(report).map((f) => f.severity)).toEqual(["nit", "high", "critical"]);
	});

	test("the tag comes from the heading's first word only; otherwise from a Severity bullet", () => {
		const report = "### Finding: low-level socket leak\n\n- **Severity:** high\n\n### Socket leak, not low priority\n";
		expect(parseReviewMarkdown(report).map((f) => f.severity)).toEqual(["high", ""]);
	});

	test("tag spellings: nits, preexisting, Pre existing", () => {
		const report = "## Important\n\n### Nits · a\n\n### preexisting · b\n\n### **Pre existing** — c\n";
		const findings = parseReviewMarkdown(report);
		expect(findings.map((f) => f.severity)).toEqual(["nit", "pre-existing", "pre-existing"]);
		expect(findings.map((f) => f.title)).toEqual(["a", "b", "c"]);
	});

	test("a whole report wrapped in one code box is unwrapped, and its inner code boxes still hide decoys", () => {
		const inner = REPORT.replace("const key", "### critical · decoy\nconst key");
		const wrapped = "```markdown\n" + inner + "```\n";
		expect(parseReviewMarkdown(wrapped).map((f) => f.severity)).toEqual(["high", "nit", "pre-existing"]);
	});

	test("when every finding sits inside code boxes, they are still counted rather than lost", () => {
		const report = "## Important\n\n```md\n### high · a\n```\n\nsee above\n\n```md\n### nit · b\n```\n";
		expect(parseReviewMarkdown(report).map((f) => f.severity)).toEqual(["high", "nit"]);
	});

	test("a heading or a label inside a fenced block is neither a finding nor a field", () => {
		const report = [
			"## Important",
			"",
			"### medium · Real",
			"",
			"- **Filename:** a.md",
			"- **Fix:** use this shape",
			"",
			"```md",
			"### high · decoy",
			"- **Filename:** b.md",
			"- **Text:** not text",
			"```",
			"",
			"- **Text:** the real text",
		].join("\n");
		const findings = parseReviewMarkdown(report);
		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({ filename: "a.md", text: "the real text", fix: "use this shape" });
	});

	test("an unclosed fence while the report is still streaming hides its contents", () => {
		const partial = "## Important\n\n### medium · a\n\n- **Fix:** like so\n\n```md\n### high · b\n";
		expect(parseReviewMarkdown(partial).map((f) => f.severity)).toEqual(["medium"]);
	});

	test("labels read without a bullet, from a numbered list, or with the colon outside the bold", () => {
		const report = "### Finding\n\n**Severity:** medium\n1. **Start line:** 7\n- **End line**: 9\n";
		expect(parseReviewMarkdown(report)[0]).toMatchObject({ severity: "medium", startLine: 7, endLine: 9 });
	});

	test("bold and backticked values are unwrapped; a malformed line number reads as 0", () => {
		const [finding] = parseReviewMarkdown("### Finding\n\n- **Filename:** **a.ts**\n- **Text:** `b`\n- **Start line:** n/a\n");
		expect(finding).toMatchObject({ filename: "a.ts", text: "b", startLine: 0 });
	});
});

describe("formatReviewSummary", () => {
	test("counts Important, nits and pre-existing", () => {
		expect(formatReviewSummary(parseReviewMarkdown(REPORT))).toBe("1 important · 1 nit · 1 pre-existing");
	});

	test("nothing parsed, no summary line", () => {
		expect(formatReviewSummary([])).toBe("");
	});

	test("a finding with no readable tag is counted as unrated, never dropped", () => {
		const findings = parseReviewMarkdown("### Finding\n\n- **Severity:** high\n\n### Finding\n\n- **Text:** no tag\n");
		expect(formatReviewSummary(findings)).toBe("1 important · 1 unrated · 1 unverified");
	});

	test("an Important finding counts as proven only when Checked is `ran … → …` or `traced … → …`", () => {
		const finding = (tag: string, checked?: string) => `### ${tag} · x\n\n${checked === undefined ? "" : `- **Checked:** ${checked}\n`}`;
		const report = [
			"## Important",
			finding("medium", "not verified"),
			finding("medium"),
			finding("high", "read the file, did not run it"),
			finding("high", "Ran `bun test` → fails"),
			finding("critical", "**ran** a probe → crashes"),
			finding("medium", "traced a.ts:1 → b.ts:9"),
			finding("medium", "traced a.ts:1 -> b.ts:9"),
			finding("high", "traced the caller"),
			"## Nits",
			finding("nit", "read a.ts:3"),
		].join("\n");
		expect(formatReviewSummary(parseReviewMarkdown(report))).toBe("8 important · 1 nit · 4 unverified");
	});
});

describe("reviewSpawnParts", () => {
	test("a first review names its level, standard by default, and always gets the report follow-up", () => {
		expect(reviewSpawnParts({ diffDescription: "git diff HEAD" }, "REPORT", false)).toEqual({
			task: "Review the following diff:\ngit diff HEAD\n\nReview level: standard",
			followUp: "REPORT",
		});
		const deep = reviewSpawnParts({ diffDescription: "d", level: "deep", files: ["a.ts"], instructions: "money path" }, "R", false);
		expect(deep.task).toContain("Review level: deep");
		expect(deep.task).toContain("Focus the review on these files:\na.ts");
		expect(deep.task).toContain("Additional review instructions:\nmoney path");
	});

	test("a continued review is a re-review and still gets the verify-and-report follow-up", () => {
		const parts = reviewSpawnParts({ diffDescription: "git diff HEAD" }, "REPORT", true);
		expect(parts.task.startsWith("Re-review the same work after the author's changes:\ngit diff HEAD")).toBe(true);
		expect(parts.followUp).toBe("REPORT");
	});
});

describe("the prompts ask for the shape the parser reads", () => {
	const report = readFileSync(join(import.meta.dir, "../../agents/prompt.amp.code-review-report.md"), "utf8");

	test("every heading and label the parser looks for is in the report prompt", () => {
		for (const line of ["## Important", "## Nits", "## Pre-existing", "### high · ", "- **Filename:**", "- **Start line:**", "- **End line:**", "- **Text:**", "- **Why:**", "- **Checked:**", "- **Fix:**", "- **Instances:**", "`ran <command>", "`traced <file:line>", "**Nothing to fix.**"]) {
			expect(report).toContain(line);
		}
	});

	test("the report prompt's own template parses as one proven Important finding", () => {
		const template = report.match(/```markdown\n([\s\S]*?)\n```\n/)?.[1];
		if (template === undefined) throw new Error("no ```markdown template block found in prompt.amp.code-review-report.md");
		const findings = parseReviewMarkdown(template);
		expect(findings).toEqual([expect.objectContaining({ severity: "high", title: "Cache key ignores the locale", startLine: 42, endLine: 45 })]);
		expect(formatReviewSummary(findings)).toBe("1 important");
	});
});
