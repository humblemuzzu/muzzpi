import { describe, expect, test } from "bun:test";
import mdExport, { applyMdMenu, mdMenu, parseMdArgs } from "./md-export";

describe("the words after /md", () => {
	test("short and long forms, in any order and case", () => {
		const parsed = parseMdArgs(" TC t 3 all ");
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.request).toMatchObject({ thinking: true, wholeSession: true, lastTurns: 3 });
		expect(parsed.request.toolFilter?.mode).toBe("all");
		expect(parseMdArgs("")).toEqual({ ok: true, request: { thinking: false, toolFilter: null, wholeSession: false, lastTurns: null } });
	});

	test("an unknown word is an error, never quietly ignored", () => {
		expect(parseMdArgs("tc bash")).toEqual({
			ok: false,
			message: '/md has no "bash". Use tc (tool calls, +name/-name to pick tools), thinking (or t), all (whole session) and a number (last N turns), like /md tc t 3.',
		});
		expect(parseMdArgs("0").ok).toBe(false);
		expect(parseMdArgs("-bash").ok).toBe(false);
		expect(parseMdArgs("tc +all").ok).toBe(false);
	});

	test("tool filters pick tools", () => {
		const parsed = parseMdArgs("tc +ask -bash");
		if (!parsed.ok) throw new Error(parsed.message);
		expect(parsed.request.toolFilter?.mode).toBe("includeOnly");
		expect([...parsed.request.toolFilter!.includeNames]).toEqual(["ask"]);
		expect([...parsed.request.toolFilter!.excludeNames]).toEqual(["bash"]);
	});
});

describe("the menu", () => {
	test("starts from what was typed, with the cursor on Copy", () => {
		const parsed = parseMdArgs("tc +ask 3");
		if (!parsed.ok) throw new Error(parsed.message);
		const spec = mdMenu(parsed.request, "/work/repo");
		expect(spec.initial).toBe("copy");
		const by = (id: string) => spec.items.find((i) => i.id === id)!;
		expect(by("tools")).toMatchObject({ value: "included", note: "+ask" });
		expect(by("turns").value).toBe("last 3 turns");
		expect(by("save").note).toBe("in /work/repo");
	});

	test("a turn count the choices lack is added to them", () => {
		const parsed = parseMdArgs("7");
		if (!parsed.ok) throw new Error(parsed.message);
		expect(mdMenu(parsed.request, "/x").items.find((i) => i.id === "turns")!.values).toEqual([
			"everything",
			"last turn",
			"last 3 turns",
			"last 10 turns",
			"last 7 turns",
		]);
	});

	test("the menu's settings win; a typed tool filter survives while tool calls stay on", () => {
		const parsed = parseMdArgs("tc +ask");
		if (!parsed.ok) throw new Error(parsed.message);
		const kept = applyMdMenu(parsed.request, { tools: "included", thinking: "included", scope: "the whole session", turns: "last turn" });
		expect(kept.thinking).toBe(true);
		expect(kept.wholeSession).toBe(true);
		expect(kept.lastTurns).toBe(1);
		expect([...kept.toolFilter!.includeNames]).toEqual(["ask"]);
		expect(applyMdMenu(parsed.request, { tools: "left out", thinking: "left out", scope: "this branch", turns: "everything" })).toEqual({
			thinking: false,
			toolFilter: null,
			wholeSession: false,
			lastTurns: null,
		});
	});
});

describe("suggestions", () => {
	test("the next word, keeping what is typed and leaving out words already used", () => {
		let options: any;
		mdExport({ registerCommand: (_n: string, o: unknown) => (options = o) } as any);
		expect(options.getArgumentCompletions("tc th")).toEqual([{ value: "tc thinking ", label: "thinking", description: "include thinking" }]);
		expect(options.getArgumentCompletions("tc ").map((i: any) => i.label)).toEqual(["thinking", "all"]);
		expect(options.getArgumentCompletions("zz")).toBeNull();
	});
});
