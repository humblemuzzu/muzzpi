import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { runCodemode } from "./codemode-harness";
import { createReadTool, NORMAL_LIMITS } from "./read";

const dir = fs.mkdtempSync(join(os.tmpdir(), "read-codemode-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
const file = join(dir, "notes.md");
fs.writeFileSync(file, "# Notes\n\n| **DB backups** | nightly \u2014 kept 7 days |\nlast line\n");

const read = createReadTool(NORMAL_LIMITS) as any;
const readCtx = { cwd: dir, sessionManager: { getSessionId: () => "read-codemode-test" } };
const ctx = {
	tools: [read],
	sessionManager: { getBranch: () => [] },
	executeTool: async (_name: string, args: unknown, opts: { signal?: AbortSignal }) => {
		const result = await read.execute("script/0", args, opts?.signal, undefined, readCtx);
		return { result, isError: result.isError === true, toolCall: { id: "script/0" } };
	},
};

async function script(code: string): Promise<string> {
	return (await runCodemode(ctx, code)).text;
}

describe("read inside a real codemode script", () => {
	test("resolves to the file's text, without line numbers, so a line can be reused as oldText", async () => {
		const out = await script(`
			const text = await tools.read({ path: ${JSON.stringify(file)}, read_range: [3, 3] });
			return JSON.stringify(text);
		`);
		expect(out).toEndWith(`Output:\n${JSON.stringify("| **DB backups** | nightly \u2014 kept 7 days |")}`);
	});

	test("the whole file, byte for byte, so read then write changes nothing", async () => {
		const out = await script(`return JSON.stringify(await tools.read({ path: ${JSON.stringify(file)} }));`);
		expect(out).toEndWith(`Output:\n${JSON.stringify(fs.readFileSync(file, "utf8"))}`);
	});

	test("the model still sees numbered lines", async () => {
		const result = await read.execute("direct", { path: file }, undefined, undefined, readCtx);
		expect(result.content[0].text).toStartWith("1: # Notes\n2: \n3: | **DB backups**");
	});

	test("a directory falls back to its listing text", async () => {
		const out = await script(`return await tools.read({ path: ${JSON.stringify(dir)} });`);
		expect(out).toContain("notes.md");
	});
});
