import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFormatFileTool } from "./format-file";

const ROOT = realpathSync.native(mkdtempSync(join(tmpdir(), "format-file-")));
const SESSION = `format-file-test-${Date.now()}`;
const previousChanges = process.env.PI_FILE_CHANGES_DIR;
beforeAll(() => {
	process.env.PI_FILE_CHANGES_DIR = join(ROOT, ".changes");
});
const CHANGES = join(ROOT, ".changes", SESSION);
const tool = createFormatFileTool() as any;

/** answers --file-info like prettier 3, and "formats" by rewriting the file. */
const STUB = [
	"#!/bin/sh",
	'if [ "$1" = "--file-info" ]; then',
	'  case "$2" in',
	"    *ignored*) echo '{ \"ignored\": true, \"inferredParser\": null }' ;;",
	"    *.py) echo '{ \"ignored\": false, \"inferredParser\": null }' ;;",
	"    *) echo '{ \"ignored\": false, \"inferredParser\": \"typescript\" }' ;;",
	"  esac",
	"  exit 0",
	"fi",
	'printf "formatted by %s\\n" "$0" > "$4"',
	"",
].join("\n");

function project(name: string, opts: { git?: boolean; stubAt?: string } = {}): string {
	const dir = join(ROOT, name);
	mkdirSync(dir, { recursive: true });
	if (opts.git) mkdirSync(join(dir, ".git"));
	if (opts.stubAt) {
		const bin = join(opts.stubAt, "node_modules", ".bin");
		mkdirSync(bin, { recursive: true });
		writeFileSync(join(bin, "prettier"), STUB, { mode: 0o755 });
	}
	return dir;
}

async function format(file: string) {
	const result = await tool.execute("fmt", { path: file }, undefined, undefined, {
		cwd: ROOT,
		sessionManager: { getSessionId: () => SESSION },
	});
	return { text: result.content[0].text as string, isError: result.isError === true };
}

/**
 * run the tool in a fresh process with its own PATH/HOME: bun's child_process
 * and os.homedir() do not see changes made to process.env at runtime.
 * PATH=/usr/bin:/bin keeps the PATH/bunx fallbacks from reaching a real prettier.
 */
function formatInChild(file: string, env: Record<string, string> = {}) {
	const script =
		`const { createFormatFileTool } = await import(${JSON.stringify(join(import.meta.dir, "format-file.ts"))});` +
		`const r = await createFormatFileTool().execute("fmt", { path: ${JSON.stringify(file)} }, undefined, undefined,` +
		` { cwd: ${JSON.stringify(ROOT)}, sessionManager: { getSessionId: () => ${JSON.stringify(SESSION)} } });` +
		"console.log(JSON.stringify({ text: r.content[0].text, isError: r.isError === true }));";
	const run = spawnSync(process.execPath, ["-e", script], {
		encoding: "utf-8",
		env: { ...process.env, PATH: "/usr/bin:/bin", ...env },
	});
	return JSON.parse(run.stdout) as { text: string; isError: boolean };
}

afterAll(() => {
	if (previousChanges === undefined) delete process.env.PI_FILE_CHANGES_DIR;
	else process.env.PI_FILE_CHANGES_DIR = previousChanges;
	rmSync(ROOT, { recursive: true, force: true });
});

describe("format_file", () => {
	test("a file the formatter ignores is an error, never 'already formatted'", async () => {
		const dir = project("ignored-case", { git: true, stubAt: join(ROOT, "ignored-case") });
		const file = join(dir, "ignored.json");
		writeFileSync(file, '{"a":1,   "b":2}\n');
		const r = await format(file);
		expect(r.isError).toBe(true);
		expect(r.text).toContain("ignores ignored.json");
		expect(readFileSync(file, "utf-8")).toBe('{"a":1,   "b":2}\n');
	});

	test("a file with no parser is an error naming the extension", async () => {
		const dir = project("py-case", { git: true, stubAt: join(ROOT, "py-case") });
		const file = join(dir, "b.py");
		writeFileSync(file, "x = 1\n");
		const r = await format(file);
		expect(r.isError).toBe(true);
		expect(r.text).toContain("has no parser for .py files");
	});

	test("a supported file is formatted with the project's own bin and the diff is returned", async () => {
		const dir = project("ok-case", { git: true, stubAt: join(ROOT, "ok-case") });
		const file = join(dir, "a.ts");
		writeFileSync(file, "const a=1\n");
		const r = await format(file);
		expect(r.isError).toBe(false);
		expect(r.text).toContain("formatted a.ts with prettier (project)");
		expect(readFileSync(file, "utf-8")).toBe(`formatted by ${join(dir, "node_modules", ".bin", "prettier")}\n`);
		expect(readdirSync(CHANGES).some((f) => f.startsWith("fmt."))).toBe(true);
	});

	test("a bin above the git root is not the project's formatter", async () => {
		const dir = project(join("outer", "repo"), { git: true, stubAt: join(ROOT, "outer") });
		const file = join(dir, "a.ts");
		writeFileSync(file, "const a=1\n");
		const r = formatInChild(file);
		expect(r.isError).toBe(true);
		expect(r.text).toStartWith("no formatter available");
	});

	test("a bin in $HOME is not the project's formatter, even without a git root", async () => {
		const home = project("home", { stubAt: join(ROOT, "home") });
		const dir = project(join("home", "notes"));
		const file = join(dir, "a.ts");
		writeFileSync(file, "const a=1\n");
		const r = formatInChild(file, { HOME: home });
		expect(r.isError).toBe(true);
		expect(r.text).toStartWith("no formatter available");
	});
});
