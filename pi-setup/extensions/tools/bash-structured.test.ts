import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createBashTool } from "./bash";
import { STRUCTURED_MAX_BYTES } from "./lib/full-output";

const tool = createBashTool() as any;
const ctx = { cwd: "/tmp", sessionManager: { getSessionId: () => "bash-structured-test" } };
const run = (cmd: string, timeout = 30) => tool.execute("t", { cmd, timeout }, undefined, undefined, ctx);

describe("bash structuredContent (codemode contract)", () => {
	test("declares pi's bash output schema", () => {
		expect(Object.keys(tool.outputSchema.properties).sort()).toEqual(
			["exit_code", "full_output_path", "output", "truncated", "wall_time_seconds"],
		);
	});

	test("a non-zero exit is an error for the model and still data for scripts", async () => {
		const r = await run("echo found-nothing; exit 3");
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toContain("exit code 3");
		expect(r.structuredContent).toMatchObject({ output: "found-nothing\n", truncated: false, exit_code: 3 });
		expect(r.structuredContent.full_output_path).toBeUndefined();
		expect(typeof r.structuredContent.wall_time_seconds).toBe("number");
	});

	test("output excludes the `$ cmd` header the model sees", async () => {
		const r = await run("echo hi");
		expect(r.content[0].text).toStartWith("$ echo hi");
		expect(r.structuredContent.output).toBe("hi\n");
		expect(r.structuredContent.exit_code).toBe(0);
	});

	test("a line-truncated run names a file that holds every line", async () => {
		const r = await run("seq 1 5000");
		const marker = (r.content[0].text as string).match(/\[\d+ lines truncated; full output: (.+)\]/);
		expect(marker).not.toBeNull();
		const lines = readFileSync(marker![1], "utf8").trimEnd().split("\n");
		expect(lines).toHaveLength(5000);
		expect(lines[2499]).toBe("2500");
		expect(r.structuredContent.output.trimEnd().split("\n")).toHaveLength(5000);
		expect(r.structuredContent.truncated).toBe(false);
		expect((statSync(marker![1]).mode & 0o777).toString(8)).toBe("600");
	});

	test("small output writes no file", async () => {
		const r = await run("seq 1 10");
		expect(r.content[0].text).not.toContain("full output:");
	});

	test("one huge line is capped for the model and kept whole on disk", async () => {
		const r = await run("head -c 200000 /dev/zero | tr '\\0' x");
		const text = r.content[0].text as string;
		expect(text.length).toBeLessThan(51_000);
		const file = text.match(/characters truncated; full output: (\S+)\]/)![1];
		expect(readFileSync(file, "utf8")).toBe("x".repeat(200_000));
		expect(r.structuredContent.output).toBe("x".repeat(200_000));
	});

	test("streamed the way pi runs it (with onUpdate), a long line is neither duplicated nor miscounted", async () => {
		const updates: unknown[] = [];
		const r = await tool.execute(
			"t",
			{ cmd: "head -c 200000 /dev/zero | tr '\\0' x", timeout: 30 },
			undefined,
			(u: unknown) => updates.push(u),
			ctx,
		);
		expect(updates.length).toBeGreaterThan(0);
		expect(r.content[0].text).toContain("[180000 characters truncated; full output:");
		expect(r.structuredContent.output).toBe("x".repeat(200_000));
	});

	test("past the script cap, output is head + tail and full_output_path is set", async () => {
		const r = await run(`head -c ${STRUCTURED_MAX_BYTES + 500_000} /dev/zero | tr '\\0' y`);
		const s = r.structuredContent;
		expect(s.truncated).toBe(true);
		expect(existsSync(s.full_output_path)).toBe(true);
		expect(statSync(s.full_output_path).size).toBe(STRUCTURED_MAX_BYTES + 500_000);
		expect(s.output).toContain("bytes omitted; full output in");
		expect(s.output.length).toBeLessThan(STRUCTURED_MAX_BYTES + 200);
	});

	test("a timeout stays a plain error, as with pi's built-in", async () => {
		const r = await run("sleep 5", 1);
		expect(r.isError).toBe(true);
		expect(r.structuredContent).toBeUndefined();
	});

	test("a command killed by a signal is an error, not a success", async () => {
		const r = await run("kill -9 $$");
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toContain("terminated by SIGKILL");
		expect(r.structuredContent).toBeUndefined();
	});
});
