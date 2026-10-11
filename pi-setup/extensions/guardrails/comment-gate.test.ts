import { describe, expect, test } from "bun:test";
import { collectAdded, countLines, DEFAULT_THRESHOLDS, judge } from "./comment-gate";

const lines = (s: string) => s.split("\n");

describe("countLines — c syntax", () => {
	test("counts a jsdoc block as one run", () => {
		const c = countLines(
			lines(`/**\n * one\n * two\n * three\n */\nconst x = 1;`),
			"c",
		);
		expect(c.comment).toBe(5);
		expect(c.code).toBe(1);
		expect(c.longestRun).toBe(5);
	});

	test("a single-line block comment does not open a run", () => {
		const c = countLines(lines(`/* short */\nconst a = 1;\nconst b = 2;`), "c");
		expect(c.comment).toBe(1);
		expect(c.code).toBe(2);
		expect(c.longestRun).toBe(1);
	});

	test("code between comments splits the runs", () => {
		const c = countLines(
			lines(`// a\n// b\nconst x = 1;\n// c\n// d\n// e`),
			"c",
		);
		expect(c.longestRun).toBe(3);
	});

	test("a blank line does not split a doc block", () => {
		const c = countLines(lines(`// a\n// b\n\n// c\n// d`), "c");
		expect(c.longestRun).toBe(4);
	});

	test("blank lines are neither comment nor code", () => {
		const c = countLines(lines(`const x = 1;\n\n\nconst y = 2;`), "c");
		expect(c.code).toBe(2);
		expect(c.comment).toBe(0);
	});

	test("a url inside code is not a comment", () => {
		const c = countLines(lines(`const u = "https://x.dev";`), "c");
		expect(c.comment).toBe(0);
		expect(c.code).toBe(1);
	});
});

describe("countLines — other syntaxes", () => {
	test("hash comments count, shebang does not", () => {
		const c = countLines(lines(`#!/usr/bin/env bash\n# why\nrun --now`), "hash");
		expect(c.comment).toBe(1);
		expect(c.code).toBe(2);
	});

	test("a python docstring counts as a block", () => {
		const c = countLines(
			lines(`"""\nwhy this exists\nand more\n"""\nx = 1`),
			"hash",
		);
		expect(c.comment).toBe(4);
		expect(c.code).toBe(1);
	});

	test("an assigned triple-quoted string is code, not a docstring", () => {
		const c = countLines(lines(`x = """body"""\ny = 2`), "hash");
		expect(c.comment).toBe(0);
		expect(c.code).toBe(2);
	});

	test("sql and lua use dashes", () => {
		const c = countLines(lines(`-- why\nselect 1;`), "dash");
		expect(c.comment).toBe(1);
		expect(c.code).toBe(1);
	});

	test("markup uses html comments", () => {
		const c = countLines(lines(`<!--\n why\n-->\n<div />`), "markup");
		expect(c.comment).toBe(3);
		expect(c.code).toBe(1);
	});
});

describe("collectAdded", () => {
	test("write takes the whole file", () => {
		const added = collectAdded({ path: "a.ts", content: "// x\nconst a = 1;" });
		expect(added).toEqual([{ path: "a.ts", lines: ["// x", "const a = 1;"] }]);
	});

	test("edit ignores lines carried over from oldText", () => {
		const added = collectAdded({
			path: "a.ts",
			edits: [{ oldText: "const a = 1;", newText: "// why\nconst a = 1;" }],
		});
		expect(added[0].lines).toEqual(["// why"]);
	});

	test("edit yields one chunk per entry, all on the call's path", () => {
		const added = collectAdded({
			path: "a.ts",
			edits: [
				{ oldText: "x", newText: "const a = 1;" },
				{ oldText: "y", newText: "// b" },
			],
		});
		expect(added).toEqual([
			{ path: "a.ts", lines: ["const a = 1;"] },
			{ path: "a.ts", lines: ["// b"] },
		]);
	});

	test("a call without a path contributes nothing", () => {
		expect(collectAdded({ content: "// x" })).toEqual([]);
	});
});

describe("judge", () => {
	const header = (n: number) =>
		["/**", ...Array.from({ length: n }, (_, i) => ` * line ${i}`), " */"].join("\n");

	test("blocks the screenshot case — a 30-line header over a few consts", () => {
		const verdict = judge({
			path: "api/route.ts",
			content: `${header(28)}\nconst A = 0.05;\nconst B = 10;\nconst C = 30;`,
		});
		expect(verdict.blocked).toBe(true);
		expect(verdict.reason).toContain("api/route.ts");
		expect(verdict.reason).toContain("comment block");
	});

	test("still blocks a big header when the rest of the file dilutes the ratio", () => {
		const body = Array.from({ length: 200 }, (_, i) => `const v${i} = ${i};`).join("\n");
		expect(judge({ path: "a.ts", content: `${header(28)}\n${body}` }).blocked).toBe(true);
	});

	test("blocks death by a thousand one-liners", () => {
		const body = Array.from({ length: 10 }, (_, i) => `// step ${i}\nconst v${i} = ${i};`)
			.join("\n");
		const verdict = judge({ path: "a.ts", content: body });
		expect(verdict.blocked).toBe(true);
		expect(verdict.reason).toContain("per line of code");
	});

	test("allows a normal file with a short header", () => {
		const body = Array.from({ length: 40 }, (_, i) => `const v${i} = ${i};`).join("\n");
		expect(judge({ path: "a.ts", content: `${header(4)}\n${body}` }).blocked).toBe(false);
	});

	test("allows a few comments below the floor even in a tiny change", () => {
		expect(
			judge({ path: "a.ts", content: "// a\n// b\n// c\nconst x = 1;" }).blocked,
		).toBe(false);
	});

	test("allows a long why-block that is under the run cap", () => {
		const body = Array.from({ length: 30 }, (_, i) => `const v${i} = ${i};`).join("\n");
		expect(judge({ path: "a.ts", content: `${header(10)}\n${body}` }).blocked).toBe(false);
	});

	test("ignores markdown, where # is a heading", () => {
		const md = Array.from({ length: 40 }, (_, i) => `# heading ${i}`).join("\n");
		expect(judge({ path: "README.md", content: md }).blocked).toBe(false);
	});

	test("ignores yaml and json config", () => {
		const yaml = Array.from({ length: 40 }, (_, i) => `# note ${i}`).join("\n");
		expect(judge({ path: "ci.yml", content: yaml }).blocked).toBe(false);
		expect(judge({ path: "tsconfig.json", content: yaml }).blocked).toBe(false);
	});

	test("ignores a file with no extension", () => {
		const many = Array.from({ length: 40 }, () => "// x").join("\n");
		expect(judge({ path: "Makefile", content: many }).blocked).toBe(false);
	});

	test("does not block a pure comment deletion", () => {
		expect(
			judge({ path: "a.ts", edits: [{ oldText: `${header(28)}\nconst x = 1;`, newText: "const x = 1;" }] }).blocked,
		).toBe(false);
	});

	test("does not block when an edit only moves an existing block", () => {
		const block = `${header(28)}`;
		expect(
			judge({ path: "a.ts", edits: [{ oldText: `${block}\nconst x = 1;`, newText: `const x = 1;\n${block}` }] })
				.blocked,
		).toBe(false);
	});

	test("blocks a bad entry inside an otherwise clean edit", () => {
		const verdict = judge({
			path: "bad.ts",
			edits: [
				{ oldText: "a", newText: "const a = 1;" },
				{ oldText: "b", newText: `${header(28)}\nconst b = 2;` },
			],
		});
		expect(verdict.blocked).toBe(true);
		expect(verdict.reason).toContain("bad.ts");
	});

	test("empty and malformed calls pass", () => {
		expect(judge({}).blocked).toBe(false);
		expect(judge({ path: "a.ts", edits: "nonsense" as unknown as [] }).blocked).toBe(false);
		expect(judge({ path: "a.ts" }).blocked).toBe(false);
	});

	test("thresholds are honoured", () => {
		const args = { path: "a.ts", content: `${header(10)}\nconst x = 1;\nconst y = 2;` };
		expect(judge(args, { ...DEFAULT_THRESHOLDS, maxRun: 50, maxRatio: 50 }).blocked).toBe(false);
		expect(judge(args, { ...DEFAULT_THRESHOLDS, maxRun: 3 }).blocked).toBe(true);
	});
});
