import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { failureText } from "./agent-notice";
import { zeroUsage } from "./pi-spawn";
import { finishedResult, runSubAgent } from "./run-sub-agent";
import { getDisplayItems, getFinalOutput, type SingleResult } from "./sub-agent-render";

const WARNING = "Warning: No project session found with id 'chad-1234'; creating a new session with that id.";

let dir: string;
let prevBin: string | undefined;

function writeStub(name: string, body: string[]): string {
	const file = join(dir, name);
	writeFileSync(file, ["#!/bin/sh", ...body, ""].join("\n"), { mode: 0o755 });
	chmodSync(file, 0o755);
	return file;
}

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "run-sub-agent-test-"));
	prevBin = process.env.PI_BIN;
});

afterAll(() => {
	if (prevBin === undefined) delete process.env.PI_BIN; else process.env.PI_BIN = prevBin;
	rmSync(dir, { recursive: true, force: true });
});

function run(signal?: AbortSignal) {
	return runSubAgent({
		agent: "chad",
		label: "t",
		working: "(working...)",
		ctx: { cwd: dir },
		signal,
		spawn: { task: "noop", session: { id: "chad-1234", dir: join(dir, "sessions") } },
	});
}

describe("the child conversation a parent keeps", () => {
	const usage = { ...zeroUsage(), cost: 0.1 };
	const conversation: any[] = [
		{ role: "user", content: [{ type: "text", text: "find it" }, { type: "image", data: "AAAA", mimeType: "image/png" }] },
		{ role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "looking" }, { type: "toolCall", id: "c1", name: "write", arguments: { path: "/a.ts", content: "x\ny" } }], usage },
		{ role: "toolResult", toolCallId: "c1", toolName: "write", content: [{ type: "text", text: "BIG OUTPUT" }], isError: false, durationMs: 12, details: { diff: "BIG DIFF" } },
		{ role: "toolResult", toolCallId: "c2", toolName: "finder", content: [{ type: "text", text: "nested answer" }], isError: true, details: { agent: "finder", exitCode: 1, usage, model: "m", messages: [{ role: "toolResult", toolCallId: "n1", toolName: "grep", content: [{ type: "text", text: "NESTED OUTPUT" }], isError: false }] } },
		{ role: "assistant", content: [{ type: "text", text: "the answer" }], usage },
	];
	const details = (continueId?: string): SingleResult => ({ agent: "chad", task: "t", exitCode: -1, messages: [], usage: zeroUsage(), ...(continueId ? { continueId } : {}) });
	const spawned = { exitCode: 0, messages: conversation, stderr: "", usage } as any;

	test("with its own session file, it keeps what rows and /stats read, and drops output, thinking and images", () => {
		const kept = finishedResult(details("chad-1"), spawned).details;
		const text = JSON.stringify(kept.messages);
		for (const gone of ["BIG OUTPUT", "BIG DIFF", "hmm", "AAAA", "NESTED OUTPUT", "nested answer"]) expect(text).not.toContain(gone);
		expect(getDisplayItems(kept.messages)).toEqual(getDisplayItems(conversation));
		expect(getFinalOutput(kept.messages)).toBe("the answer");
		expect(kept.messages[2]).toEqual({ role: "toolResult", toolCallId: "c1", toolName: "write", content: [], isError: false, durationMs: 12 });
		expect(kept.messages[3].details).toMatchObject({ agent: "finder", exitCode: 1, model: "m", usage });
		expect(kept.messages[3].details.messages[0]).toEqual({ role: "toolResult", toolCallId: "n1", toolName: "grep", content: [], isError: false });
	});

	test("without one (read_session, read_web_page), it is kept whole", () => {
		expect(finishedResult(details(), spawned).details.messages).toBe(conversation);
	});
});

describe("failureText", () => {
	const base = { stopReason: undefined, errorMessage: undefined, stderr: "" };

	test("the expected new-session warning is never the error", () => {
		expect(failureText({ ...base, stderr: `${WARNING}\n` }, "(no output)")).toBe("(no output)");
	});

	test("real stderr still surfaces, with the warning cut out", () => {
		expect(failureText({ ...base, stderr: `${WARNING}\nboom: bad flag\n` }, "(no output)")).toBe("boom: bad flag");
	});

	test("an abort says it was stopped", () => {
		const text = failureText({ stopReason: "aborted", errorMessage: "Request was aborted", stderr: WARNING }, "x");
		expect(text).toMatch(/Stopped before the sub-agent finished/);
	});

	test("a stall keeps its own text", () => {
		const text = failureText({ stopReason: "stalled", errorMessage: "sub-agent killed: no output for 15m.", stderr: WARNING }, "x");
		expect(text).toBe("sub-agent killed: no output for 15m.");
	});

	test("a child that died before it settled says how, rather than showing its last words as the error", () => {
		expect(failureText({ ...base, exit: "SIGKILL" }, "half an answer")).toBe("The sub-agent process ended (SIGKILL) before it finished.");
		expect(failureText({ ...base, exit: "exit code 2", stderr: "boom: bad flag" }, "x")).toBe("boom: bad flag");
	});

	test("the child's own error message beats stderr", () => {
		expect(failureText({ ...base, errorMessage: "401 unauthorized", stderr: "noise" }, "x")).toBe("401 unauthorized");
	});
});

describe("runSubAgent", () => {
	test("Esc on a persisted child reports the stop, not the session warning", async () => {
		process.env.PI_BIN = writeStub("abort.sh", [`echo "${WARNING}" >&2`, "exec sleep 60"]);
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 400);
		const result = await run(controller.signal);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toMatch(/Stopped before the sub-agent finished/);
		expect(result.content[0].text).not.toContain("No project session");
	}, 30000);

	test("a failed child with only the warning on stderr does not show it", async () => {
		process.env.PI_BIN = writeStub("fail.sh", [`echo "${WARNING}" >&2`, "exit 2"]);
		const result = await run();
		expect(result.isError).toBe(true);
		expect(result.content[0].text).not.toContain("No project session");
	}, 30000);

	test("real stderr from a failed child is shown", async () => {
		process.env.PI_BIN = writeStub("fail2.sh", [`echo "${WARNING}" >&2`, "echo 'unknown model xyz' >&2", "exit 2"]);
		const result = await run();
		expect(result.content[0].text).toContain("unknown model xyz");
		expect(result.content[0].text).not.toContain("No project session");
	}, 30000);
});
