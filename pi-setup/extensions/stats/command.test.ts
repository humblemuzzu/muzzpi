import { describe, expect, test } from "bun:test";
import statsExtension, { parseBudget, statsMenu } from "./index";

function registered() {
	let command: any;
	const notes: [string, string | undefined][] = [];
	statsExtension({
		registerCommand: (_name: string, options: unknown) => (command = options),
		registerShortcut() {},
		on() {},
		events: { on: () => () => {}, emit() {} },
	} as any);
	const ctx = { hasUI: false, mode: "rpc", ui: { notify: (text: string, level?: string) => notes.push([text, level]) } };
	return { run: (args: string) => command.handler(args, ctx), complete: command.getArgumentCompletions, notes };
}

describe("budget", () => {
	test("a number with or without $, or off; anything else is refused", () => {
		expect(parseBudget("500")).toEqual({ ok: true, usd: 500 });
		expect(parseBudget("$12.5")).toEqual({ ok: true, usd: 12.5 });
		expect(parseBudget("OFF")).toEqual({ ok: true, usd: undefined });
		for (const bad of ["0", "-3", "1,000", "lots"]) expect(parseBudget(bad)).toEqual({ ok: false });
	});
});

describe("the menu", () => {
	test("opening comes first with its shortcut; the settings say what they are now", () => {
		const spec = statsMenu(false, undefined);
		expect(spec.items.map((i) => i.id)).toEqual(["open", "export", "widget", "budget"]);
		expect(spec.items[0]).toMatchObject({ label: "Open stats", note: "ctrl+shift+s" });
		expect(spec.items[2]).toMatchObject({ label: "Show today's spend under the prompt", note: "hidden now" });
		expect(statsMenu(true, 500).items.slice(2).map((i) => i.note)).toEqual(["shown now", "now $500"]);
	});
});

describe("the command", () => {
	test("an unknown word names every real one", async () => {
		const stats = registered();
		await stats.run("wrapped");
		expect(stats.notes).toEqual([['/stats has no "wrapped". Try: 7d, 30d, 90d, 1y, all, export, widget, budget, or /stats on its own for the menu.', "error"]]);
	});

	test("a range without a screen says how to get a report instead", async () => {
		const stats = registered();
		await stats.run("7D");
		expect(stats.notes).toEqual([["The stats view needs the interactive TUI. /stats export 7d writes a report instead.", "info"]]);
	});

	test("export refuses a range that does not exist, and a bad budget is refused before anything is written", async () => {
		const stats = registered();
		await stats.run("export 2w");
		expect(stats.notes.at(-1)).toEqual(['"2w" isn\'t a range. Use 7d, 30d, 90d, 1y or all.', "error"]);
		await stats.run("budget lots");
		expect(stats.notes.at(-1)![1]).toBe("error");
	});

	test("suggestions name the ranges in words", () => {
		const stats = registered();
		expect(stats.complete("export ").map((i: any) => `${i.value}: ${i.description}`)).toEqual([
			"export 7d: last 7 days",
			"export 30d: last 30 days",
			"export 90d: last 90 days",
			"export 1y: last year",
			"export all: all time",
		]);
		expect(stats.complete("3")).toEqual([{ value: "30d", label: "30d", description: "open the view at the last 30 days" }]);
	});
});
