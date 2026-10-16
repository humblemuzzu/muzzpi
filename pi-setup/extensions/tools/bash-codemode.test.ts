import { describe, expect, test } from "bun:test";
import { createBashTool } from "./bash";
import { runCodemode } from "./codemode-harness";

const bash = createBashTool() as any;
const bashCtx = { cwd: "/tmp", sessionManager: { getSessionId: () => "bash-codemode-test" } };

/** a session with exactly one callable tool, our bash, dispatched the way pi's executeTool does. */
const ctx = {
	tools: [bash],
	sessionManager: { getBranch: () => [] },
	executeTool: async (_name: string, args: unknown, opts: { signal?: AbortSignal }) => {
		const result = await bash.execute("nested", args, opts?.signal, undefined, bashCtx);
		return { result, isError: result.isError === true, toolCall: { id: "nested" } };
	},
};

async function script(code: string): Promise<{ text: string; isError: boolean }> {
	return runCodemode(ctx, code);
}

describe("bash inside a real codemode script", () => {
	test("a non-zero exit resolves to data instead of killing the script", async () => {
		const r = await script(`
			const res = await tools.bash({ cmd: "grep -c needle /dev/null", timeout: 5 });
			return { exit: res.exit_code, out: res.output.trim() };
		`);
		expect(r.isError).toBe(false);
		expect(r.text).toContain("Script completed");
		expect(r.text).toContain('{"exit":1,"out":"0"}');
	}, 30_000);

	test("a timeout still rejects, so scripts can tell a failure from a result", async () => {
		const r = await script(`
			try { await tools.bash({ cmd: "sleep 5", timeout: 1 }); return "resolved"; }
			catch (e) { return "rejected: " + e.message.split("\\n")[0]; }
		`);
		expect(r.text).toContain("rejected: command timed out after 1 seconds");
	}, 30_000);
});
