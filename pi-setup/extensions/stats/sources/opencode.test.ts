import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, test } from "bun:test";
import { A, dayKey, type SessionRecord, U } from "../record";
import { PRICES, T0 } from "../test-helpers";
import { ingestOpencode } from "./opencode";

const DAY = dayKey(T0);
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const json = (v: unknown) => q(JSON.stringify(v));

function assistant(id: string, session: string, ms: number, tokens: { input: number; output: number; reasoning?: number; read?: number; write?: number }, extra: Record<string, unknown> = {}) {
	const data = { role: "assistant", providerID: "anthropic", modelID: "claude-opus-5", variant: "high", cost: 0, time: { created: ms, completed: ms + 500 }, tokens: { input: tokens.input, output: tokens.output, reasoning: tokens.reasoning ?? 0, cache: { read: tokens.read ?? 0, write: tokens.write ?? 0 } }, ...extra };
	return `INSERT INTO message VALUES (${q(id)}, ${q(session)}, ${ms}, ${ms}, ${json(data)});`;
}

function setup(dir: string, extra = ""): string {
	const db = path.join(dir, "opencode.db");
	const sql = `
CREATE TABLE session (id text PRIMARY KEY, project_id text, parent_id text, slug text, directory text, title text, version text, time_created integer, time_updated integer, agent text);
CREATE TABLE message (id text PRIMARY KEY, session_id text, time_created integer, time_updated integer, data text);
CREATE TABLE part (id text PRIMARY KEY, message_id text, session_id text, time_created integer, time_updated integer, data text);
CREATE TABLE session_v2 (id text PRIMARY KEY, project_id text, parent_id text, slug text, directory text, title text, version text, time_created integer, time_updated integer, agent text);
CREATE TABLE session_message (id text PRIMARY KEY, session_id text, type text, seq integer, time_created integer, time_updated integer, data text);
INSERT INTO session VALUES ('ses_root', 'p', NULL, 's', '/work/app', 'Login page', '1', ${T0}, ${T0 + 10}, 'build');
INSERT INTO session VALUES ('ses_child', 'p', 'ses_root', 's', '/work/app', 'explore', '1', ${T0 + 1}, ${T0 + 11}, 'explore');
INSERT INTO session VALUES ('ses_fork', 'p', NULL, 's', '/work/app', 'Login page (fork)', '1', ${T0 + 2}, ${T0 + 12}, 'build');
INSERT INTO message VALUES ('msg_u1', 'ses_root', ${T0}, ${T0}, ${json({ role: "user", time: { created: T0 } })});
INSERT INTO part VALUES ('prt_1', 'msg_u1', 'ses_root', ${T0}, ${T0}, ${json({ type: "text", text: "add a login page" })});
INSERT INTO part VALUES ('prt_2', 'msg_u1', 'ses_root', ${T0}, ${T0}, ${json({ type: "text", text: "<system>", synthetic: true })});
${assistant("msg_a1", "ses_root", T0 + 1000, { input: 10, output: 90, reasoning: 10, read: 20_000, write: 1000 })}
INSERT INTO part VALUES ('prt_3', 'msg_a1', 'ses_root', ${T0 + 1100}, ${T0 + 1100}, ${json({ type: "tool", tool: "bash", state: { status: "error", input: { command: "bun test" }, time: { start: T0 + 1100, end: T0 + 1600 } } })});
INSERT INTO part VALUES ('prt_4', 'msg_a1', 'ses_root', ${T0 + 1200}, ${T0 + 1200}, ${json({ type: "tool", tool: "task", state: { status: "completed", input: {}, time: { start: T0 + 1200, end: T0 + 1300 } } })});
INSERT INTO part VALUES ('prt_5', 'msg_a1', 'ses_root', ${T0 + 1300}, ${T0 + 1300}, ${json({ type: "step-finish", tokens: { input: 10, output: 90 } })});
${assistant("msg_c1", "ses_child", T0 + 2000, { input: 5, output: 50 }, { providerID: "opencode", modelID: "big-pickle", agent: "explore" })}
${assistant("msg_f1", "ses_fork", T0 + 1000, { input: 10, output: 90, reasoning: 10, read: 20_000, write: 1000 })}
INSERT INTO session_message VALUES ('msg_a1', 'ses_root', 'assistant', 1, ${T0 + 1000}, ${T0 + 1000}, ${json({ model: { id: "claude-opus-5", providerID: "anthropic" }, time: { created: T0 + 1000, completed: T0 + 1500 }, tokens: { input: 10, output: 90, reasoning: 10, cache: { read: 20_000, write: 1000 } }, cost: 0 })});
INSERT INTO session_message VALUES ('msg_v2', 'ses_root', 'assistant', 2, ${T0 + 5000}, ${T0 + 5000}, ${json({ model: { id: "gpt-6-codex", providerID: "opencode", variant: "default" }, time: { created: T0 + 5000, completed: T0 + 6000 }, cost: 0.5, tokens: { input: 1000, output: 100, reasoning: 0, cache: { read: 0, write: 0 } }, content: [{ type: "tool", name: "edit", state: { status: "completed", input: { filePath: "/work/app/src/b.ts" } } }] })});
${extra}`;
	execFileSync("sqlite3", [db, sql]);
	return db;
}

const usage = (recs: SessionRecord[], key: string) => recs.find((r) => r.key === key)!;
let dir: string;
let first: Awaited<ReturnType<typeof ingestOpencode>>;

beforeAll(async () => {
	dir = mkdtempSync(path.join(os.tmpdir(), "opencode-"));
	setup(dir);
	mkdirSync(path.join(dir, "storage", "message", "ses_old"), { recursive: true });
	writeFileSync(path.join(dir, "storage", "message", "ses_old", "msg_old.json"), JSON.stringify({ id: "msg_old", sessionID: "ses_old", role: "assistant", providerID: "anthropic", modelID: "claude-opus-5", path: { root: "/work/old" }, time: { created: T0 - 86_400_000, completed: T0 - 86_399_000 }, tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } }));
	writeFileSync(path.join(dir, "storage", "message", "ses_old", "msg_a1.json"), JSON.stringify({ id: "msg_a1", role: "assistant", tokens: { input: 999, output: 999 } }));
	first = await ingestOpencode(undefined, PRICES, () => {}, undefined, dir);
});

describe("reading OpenCode", () => {
	test("v1 and v2 rows of one message count once; reasoning joins output; the catalog prices what OpenCode did not", () => {
		const root = usage(first.records, "opencode:ses_root");
		const u = root.usage[`${DAY}\tanthropic/claude-opus-5\thigh`];
		expect([u[U.turns], u[U.input], u[U.output], u[U.reasoning], u[U.cacheRead], u[U.cacheWrite]]).toEqual([1, 10, 100, 10, 20_000, 1000]);
		expect(u[U.estimated]).toBeCloseTo((10 * 5 + 100 * 25 + 20_000 * 0.5 + 1000 * 6.25) / 1e6, 12);
		expect([root.name, root.cwd, root.title]).toEqual(["Login page", "/work/app", "add a login page"]);
	});

	test("a message only the v2 table holds is read, with its tools and OpenCode's own cost", () => {
		const u = usage(first.records, "opencode:ses_root").usage[`${DAY}\topencode/gpt-6-codex\tunknown`];
		expect([u[U.turns], u[U.cost], u[U.estimated]]).toEqual([1, 0.5, 0]);
		expect(usage(first.records, "opencode:ses_root").edits).toEqual({ [`${DAY}\topencode\t/work/app/src/b.ts`]: 1 });
	});

	test("tool parts, their outcome and duration; step-finish parts are not usage", () => {
		const root = usage(first.records, "opencode:ses_root");
		expect(root.tools[`${DAY}\tmain\tanthropic\tbash`].slice(0, 5)).toEqual([1, 1, 500, 1, 1]);
		expect(root.bash).toEqual({ [`${DAY}\tanthropic\tbun test`]: 1 });
		expect(root.fanout).toEqual({ [`${DAY}\tanthropic\t1`]: 1 });
	});

	test("a child session is an agent run of its root", () => {
		const child = usage(first.records, "opencode:ses_child");
		expect([child.role, child.id, child.agentName]).toEqual(["agent", "ses_root", "explore"]);
		expect(child.agents[`${DAY}\texplore\tbig-pickle`][A.runs]).toBe(1);
	});

	test("a fork's copy of a message counts nothing; the legacy tree adds only what no database has", () => {
		expect(Object.keys(usage(first.records, "opencode:ses_fork").usage)).toEqual([]);
		const old = usage(first.records, "opencode:legacy:ses_old");
		expect(Object.values(old.usage).map((v) => v[U.output])).toEqual([2]);
	});
});

describe("incremental reads", () => {
	test("an unchanged database reuses every record and writes nothing", async () => {
		const again = await ingestOpencode({ records: first.records, stale: false, extra: first.extra }, PRICES, () => {}, undefined, dir);
		expect(again.changed).toBe(false);
		expect(again.records.find((r) => r.key === "opencode:ses_root")).toBe(first.records.find((r) => r.key === "opencode:ses_root"));
	});

	test("a new message rebuilds only its session; a deleted session stays in the ledger", async () => {
		execFileSync("sqlite3", [path.join(dir, "opencode.db"), `${assistant("msg_a2", "ses_root", T0 + 9000, { input: 1, output: 1 })} UPDATE session SET time_updated=${T0 + 99} WHERE id='ses_root'; DELETE FROM message WHERE session_id='ses_child'; DELETE FROM session WHERE id='ses_child';`]);
		const next = await ingestOpencode({ records: first.records, stale: false, extra: first.extra }, PRICES, () => {}, undefined, dir);
		expect(next.changed).toBe(true);
		expect(next.records.find((r) => r.key === "opencode:ses_fork")).toBe(first.records.find((r) => r.key === "opencode:ses_fork"));
		expect(usage(next.records, "opencode:ses_root").usage[`${DAY}\tanthropic/claude-opus-5\thigh`][U.turns]).toBe(2);
		expect(usage(next.records, "opencode:ses_child").agents[`${DAY}\texplore\tbig-pickle`][A.runs]).toBe(1);
		expect(Object.keys(usage(next.records, "opencode:ses_fork").usage)).toEqual([]);
		expect(next.records.filter((r) => r.key === "opencode:ses_root").length).toBe(1);
	});
});
