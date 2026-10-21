import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureFromPane, paneFromJson } from "./capture";

const dir = mkdtempSync(join(tmpdir(), "ideas-capture-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const SESSION_ID = "01a15cdc-57f1-7292-882a-b1523d070a45";

describe("paneFromJson", () => {
	test("reads the pane out of herdr's pane get reply", () => {
		const reply = JSON.stringify({ id: "cli:pane:get", result: { pane: { cwd: "/p", agent: "pi", agent_status: "idle" }, type: "pane_info" } });
		expect(paneFromJson(reply)).toEqual({ cwd: "/p", agent: "pi", agent_status: "idle" });
	});

	test("an error reply or garbage gives no pane", () => {
		expect(paneFromJson('{"error":{"code":"pane_not_found"}}')).toBeUndefined();
		expect(paneFromJson("not json")).toBeUndefined();
	});
});

describe("captureFromPane", () => {
	test("a shell pane records only where the idea came from", () => {
		expect(captureFromPane(undefined)).toEqual({ source: "herdr" });
		expect(captureFromPane({ cwd: "/p" })).toEqual({ source: "herdr" });
	});

	test("a pi pane links its session, its name and the prompt it was running", () => {
		const file = join(dir, `2026-10-21T05-08-26-737Z_${SESSION_ID}.jsonl`);
		writeFileSync(
			file,
			[
				JSON.stringify({ type: "session", id: SESSION_ID }),
				JSON.stringify({ type: "message", message: { role: "user", content: "older prompt" } }),
				JSON.stringify({ type: "session_info", name: "crop work" }),
				JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "fix the uploads" }] } }),
				JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "on it" }] } }),
				'{"type":"message","message":{"role":"user","content":"cut sh',
			].join("\n"),
		);
		const capture = captureFromPane({ agent: "pi", agent_status: "working", agent_session: { kind: "path", value: file } });
		expect(capture).toEqual({
			source: "herdr",
			agentBusy: true,
			session: { id: SESSION_ID, file, name: "crop work" },
			lastPrompt: "fix the uploads",
		});
	});

	test("another agent or a missing session file still saves the idea", () => {
		expect(captureFromPane({ agent: "claude", agent_status: "idle" })).toEqual({ source: "herdr", agentBusy: false });
		const gone = join(dir, "gone.jsonl");
		expect(captureFromPane({ agent: "pi", agent_status: "done", agent_session: { kind: "path", value: gone } })).toEqual({
			source: "herdr",
			agentBusy: false,
			session: { id: "gone", file: gone },
		});
	});
});
