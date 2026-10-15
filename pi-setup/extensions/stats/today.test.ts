import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { visibleWidth } from "@mariozechner/pi-tui";
import { burn, prepare, summarizeWindow } from "./aggregate";
import { dayKey } from "./record";
import { piSpec } from "./sources/pi";
import { iso, MIN, readLines } from "./test-helpers";
import { readSettings, todayText, widgetLine, writeSettings } from "./today";

const NOW = new Date(2026, 5, 10, 18, 0).getTime();
const TODAY = dayKey(NOW);
const T = new Date(2026, 5, 10, 9, 0).getTime();

const header = JSON.stringify({ type: "session", id: "w", timestamp: iso(T), cwd: "/w" });
const user = (ms: number) => JSON.stringify({ type: "message", timestamp: iso(ms), message: { role: "user", content: [{ type: "text", text: "go" }] } });
const assistant = (ms: number, cost: number, input: number, cacheRead = 0) =>
	JSON.stringify({ type: "message", timestamp: iso(ms), message: { role: "assistant", provider: "anthropic", model: "claude-opus-5", usage: { input, cacheRead, cost: { total: cost } } } });

function today(lines: string[], commits = 0) {
	const rec = readLines(piSpec("/s"), "/s/w.jsonl", [header, ...lines]);
	const ds = prepare([rec], { roots: new Map(), commits: Array.from({ length: commits }, (_, i) => ({ hash: `c${i}`, ms: T + i, root: "/w", added: 1, deleted: 0, subject: "x" })) }, NOW);
	return summarizeWindow(ds, { start: TODAY, end: TODAY });
}

test("the line reads spend, cache hit, commits and active time for today", () => {
	expect(todayText(today([user(T), assistant(T + 10 * MIN, 42.1, 60, 940)], 3))).toBe("today $42.10 · 94% cache · 3 commits · 10m");
});

test("a budget adds month to date as a share of it", () => {
	const s = today([assistant(T, 1, 1)], 1);
	expect(todayText(s, burn(170, TODAY, 500))).toBe("today $1.00 · 0% cache · 1 commit · 0m · MTD 34% of $500");
	expect(todayText(s, burn(170, TODAY))).not.toContain("MTD");
});

test("no prompt tokens today is a dash, not 0%", () => {
	expect(todayText(today([]))).toBe("today $0 · — cache · 0 commits · 0m");
});

test("the widget line is one clamped row whatever the text holds", () => {
	expect(widgetLine("a\nb\tc\x07d", 80)).toBe("a b cd");
	const long = "today $42.10 · 94% cache · 日本語 ⚡ · 3 commits · 2h 10m · MTD 34% of $500";
	for (let w = 1; w <= 80; w++) expect(visibleWidth(widgetLine(long, w))).toBeLessThanOrEqual(w);
	expect(widgetLine(long, 0)).toBe("");
});

let dir: string | undefined;
afterEach(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
	dir = undefined;
});

test("settings round-trip and reject a bad budget", async () => {
	dir = mkdtempSync(path.join(os.tmpdir(), "stats-settings-"));
	expect(await readSettings(dir)).toEqual({ widget: false });
	await writeSettings(dir, { widget: true, budget: 500 });
	expect(await readSettings(dir)).toEqual({ widget: true, budget: 500 });
	writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ widget: "yes", budget: -3 }));
	expect(await readSettings(dir)).toEqual({ widget: false, budget: undefined });
});
