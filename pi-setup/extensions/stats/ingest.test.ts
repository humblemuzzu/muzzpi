import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { dropImports, ingestPiWarm } from "./ingest";
import { type Ledger, readLedger, writeLedger } from "./ledger";
import { A_LEN, U, U_LEN } from "./record";
import { ingestFiles } from "./sources/files";
import { piSpec } from "./sources/pi";
import { bare, iso, PRICES, T0 } from "./test-helpers";

const header = (id: string) => `${JSON.stringify({ type: "session", id, timestamp: iso(T0), cwd: "/w" })}\n`;
const turn = (ms: number, cost: number) => `${JSON.stringify({ type: "message", timestamp: iso(ms), message: { role: "assistant", provider: "anthropic", model: "claude-opus-5", usage: { output: 1, cost: { total: cost } } } })}\n`;
const total = (l: Ledger) => l.records.reduce((a, r) => a + Object.values(r.usage).reduce((x, v) => x + v[U.cost], 0), 0);

test("appends are read from the last offset, deletions keep their record, a moved file is not counted twice", async () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "stats-ingest-"));
	const sessions = path.join(dir, "sessions");
	mkdirSync(path.join(sessions, "p"), { recursive: true });
	const a = path.join(sessions, "p", "a.jsonl");
	const b = path.join(sessions, "p", "b.jsonl");
	writeFileSync(a, header("A") + turn(T0, 1) + turn(T0 + 1, 2));
	writeFileSync(b, header("B") + turn(T0, 4));
	const spec = piSpec(sessions);
	const run = async (ledger?: Ledger) => {
		const out = await ingestFiles(spec, ledger, PRICES, () => {});
		return { records: out.records, stale: false, changed: out.changed };
	};

	const first = await run();
	expect(total(first)).toBe(7);
	expect((await run(first)).changed).toBe(false);

	appendFileSync(a, `${turn(T0 + 2, 8)}{"type":"message","timest`);
	const second = await run(first);
	expect(total(second)).toBe(15);
	expect(second.records.find((r) => r.key === "pi:A")!.offset).toBeLessThan(statSync(a).size);

	rmSync(b);
	const third = await run(second);
	expect(total(third)).toBe(15);

	renameSync(a, path.join(sessions, "p", "a-moved.jsonl"));
	const fourth = await run(third);
	expect(total(fourth)).toBe(15);
	expect(fourth.records.filter((r) => r.key === "pi:A").length).toBe(1);
});

test("an older ledger is re-read where its sources exist and keeps the sessions whose sources are gone", async () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "stats-ledger-"));
	const gone = bare("claude", "pruned");
	gone.usage["2026-01-01\tanthropic/claude-opus-5\tunknown"] = [1, 0, 0, 0, 0, 0, 7];
	gone.agents["2026-01-01\tExplore\tclaude-opus-5"] = [1, 2];
	writeFileSync(path.join(dir, "ledger-claude-v1.json"), JSON.stringify({ version: 1, timeZone: "UTC", records: [gone] }));
	const ledger = (await readLedger(dir, "claude"))!;
	expect(ledger.stale).toBe(true);
	const rec = ledger.records[0];
	expect([rec.usage["2026-01-01\tanthropic/claude-opus-5\tunknown"].length, rec.agents["2026-01-01\tExplore\tclaude-opus-5"].length]).toEqual([U_LEN, A_LEN]);
	expect(rec.usage["2026-01-01\tanthropic/claude-opus-5\tunknown"][U.cost]).toBe(7);
	await writeLedger(dir, "claude", ledger.records);
	expect(existsSync(path.join(dir, "ledger-claude-v1.json"))).toBe(false);
	expect((await readLedger(dir, "claude"))!.stale).toBe(false);
	expect(await ingestPiWarm(dir, dir, PRICES)).toBeUndefined();
});

test("a pi import is dropped while its original's turns are known, and kept once they are not", () => {
	const imported = bare("pi", "imp");
	imported.importOf = "opencode";
	imported.dedup = { "1:1:1:0:0": "", "2:1:1:0:0": "" };
	const original = bare("opencode", "ses");
	original.dedup = { "1:1:1:0:0": "", "2:1:1:0:0": "" };
	expect(dropImports([imported, original]).map((r) => r.key)).toEqual(["opencode:ses"]);
	expect(dropImports([imported]).map((r) => r.key)).toEqual(["pi:imp"]);
});
