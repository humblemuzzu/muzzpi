import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGlobTool } from "./glob";
import { createGrepTool } from "./grep";

const REPO = realpathSync.native(mkdtempSync(join(tmpdir(), "search-tools-")));
mkdirSync(join(REPO, ".git"));
mkdirSync(join(REPO, "build"));
mkdirSync(join(REPO, "src"));
writeFileSync(join(REPO, ".gitignore"), "build/\n");
writeFileSync(join(REPO, "build", "out.txt"), "needle in the ignored dir\n");
writeFileSync(join(REPO, "src", "notes.md"), "alpha\nbeta\ngamma\ndelta\nepsilon\n");
writeFileSync(join(REPO, "src", "code.ts"), "gamma\n");
writeFileSync(join(REPO, "src", "many.txt"), "hit\nhit\nhit\nhit\nhit\n");
writeFileSync(join(REPO, ".git", "config"), "gamma\n");
mkdirSync(join(REPO, "dated"));
for (const [name, age] of [["old.log", 300], ["new.log", 10], ["mid.log", 100]] as const) {
	writeFileSync(join(REPO, "dated", name), "x\n");
	const t = Date.now() / 1000 - age;
	utimesSync(join(REPO, "dated", name), t, t);
}
afterAll(() => rmSync(REPO, { recursive: true, force: true }));

const ctx = { cwd: REPO };
const find = async (args: object) => {
	const r: any = await createGlobTool().execute!("f", args as any, undefined, undefined, ctx as any);
	return { text: r.content[0].text as string, isError: r.isError === true };
};
const grep = async (args: object) => {
	const r: any = await createGrepTool().execute!("g", args as any, undefined, undefined, ctx as any);
	return { text: r.content[0].text as string, isError: r.isError === true };
};

describe("find", () => {
	test("an empty result says .gitignore was applied and how to search past it", async () => {
		const r = await find({ filePattern: "**/out.txt" });
		expect(r.text).toBe(
			"no files found matching pattern (files matched by .gitignore are skipped; an ignored directory passed as `path` is searched)",
		);
	});

	test("an ignored directory passed as path is listed, as the note promises", async () => {
		expect((await find({ filePattern: "*", path: "build" })).text).toBe("out.txt");
	});

	test("a pattern without / matches at any depth; a leading / anchors to the search dir, as the description says", async () => {
		expect((await find({ filePattern: "*.md" })).text).toBe("src/notes.md");
		expect((await find({ filePattern: "/*.md" })).text).toStartWith("no files found");
		expect((await find({ filePattern: "/*.md", path: "src" })).text).toBe("notes.md");
	});

	test("the documented `src/**/*.ts` form matches — a pattern with / is relative to the search dir", async () => {
		expect((await find({ filePattern: "src/**/*.ts" })).text).toBe("src/code.ts");
		expect((await find({ filePattern: "**/*.ts", path: "src" })).text).toBe("code.ts");
	});

	test("results come newest first", async () => {
		expect((await find({ filePattern: "*.log", path: "dated" })).text).toBe("new.log\nmid.log\nold.log");
	});

	test("a missing path is reported as missing", async () => {
		const r = await find({ filePattern: "*", path: "nope" });
		expect(r.isError).toBe(true);
		expect(r.text).toBe(`path not found: ${join(REPO, "nope")}`);
	});

	test("a file passed as path is refused with directions, not an ENOTDIR spawn error", async () => {
		const r = await find({ filePattern: "*", path: "src/notes.md" });
		expect(r.isError).toBe(true);
		expect(r.text).toBe(`${join(REPO, "src", "notes.md")} is a file; find lists directories (use read or grep on a file)`);
	});

	test("no pattern is an error, not a crash", async () => {
		const r = await find({ path: "src" });
		expect(r.isError).toBe(true);
		expect(r.text).toContain("filePattern is required");
	});
});

describe("grep", () => {
	test("an empty result carries the same .gitignore note", async () => {
		expect((await grep({ pattern: "needle" })).text).toStartWith("no matches found (files matched by .gitignore");
	});

	test("an ignored directory passed as path is searched", async () => {
		expect((await grep({ pattern: "needle", path: "build" })).text).toContain("out.txt:1: needle in the ignored dir");
	});

	test("nothing inside .git is searched", async () => {
		const r = await grep({ pattern: "gamma" });
		expect(r.text).toContain("src/code.ts");
		expect(r.text).not.toContain(".git");
	});

	test("path and glob are honoured together", async () => {
		const r = await grep({ pattern: "gamma", path: "src", glob: "*.md" });
		expect(r.text).toContain("notes.md:3: gamma");
		expect(r.text).not.toContain("code.ts");
	});

	test("a glob containing / filters relative to path", async () => {
		const r = await grep({ pattern: "gamma", glob: "src/*.md" });
		expect(r.text).toContain("src/notes.md:3: gamma");
		expect(r.text).not.toContain("code.ts");
	});

	test("a missing path is reported as missing", async () => {
		const r = await grep({ pattern: "x", path: "nope" });
		expect(r.isError).toBe(true);
		expect(r.text).toBe(`path not found: ${join(REPO, "nope")}`);
	});

	test("context sets the lines around each match", async () => {
		expect((await grep({ pattern: "gamma", path: "src/notes.md", context: 0 })).text).toBe("notes.md:3: gamma");
		const wide = (await grep({ pattern: "gamma", path: "src/notes.md", context: 2 })).text;
		expect(wide.split("\n")).toEqual([
			"notes.md-1- alpha",
			"notes.md-2- beta",
			"notes.md:3: gamma",
			"notes.md-4- delta",
			"notes.md-5- epsilon",
		]);
	});

	test("limit stops collection and says so", async () => {
		const r = await grep({ pattern: "hit", path: "src/many.txt", context: 0, limit: 2 });
		expect(r.text).toContain("stopped at 2 matches");
	});
});

describe("an ambient RIPGREP_CONFIG_PATH", () => {
	const withConfig = async <T>(run: () => Promise<T>): Promise<T> => {
		const config = join(REPO, "..", `${REPO.split("/").pop()}.ripgreprc`);
		writeFileSync(config, "--fixed-strings\n--glob=!*.md\n");
		const previous = process.env.RIPGREP_CONFIG_PATH;
		process.env.RIPGREP_CONFIG_PATH = config;
		try {
			return await run();
		} finally {
			if (previous === undefined) delete process.env.RIPGREP_CONFIG_PATH;
			else process.env.RIPGREP_CONFIG_PATH = previous;
			rmSync(config, { force: true });
		}
	};

	test("does not turn a grep regex into a literal or hide files", async () => {
		const r = await withConfig(() => grep({ pattern: "gam+a", path: "src", context: 0 }));
		expect(r.text).toContain("notes.md:3: gamma");
	});

	test("does not hide files from find", async () => {
		expect((await withConfig(() => find({ filePattern: "*.md" }))).text).toBe("src/notes.md");
	});
});
