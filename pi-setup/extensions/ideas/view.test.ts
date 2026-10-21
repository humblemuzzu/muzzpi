import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@mariozechner/pi-tui";
import type { Idea, Scope, Status } from "./store";
import { type Change, IdeaList, type ListSource } from "./view";

const theme = {
	fg: (_color: string, text: string) => `\x1b[33m${text}\x1b[39m`,
	bg: (_color: string, text: string) => `\x1b[44m${text}\x1b[49m`,
	bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
};

const NOW = new Date("2026-10-21T12:00:00+05:30");

function idea(id: string, text: string, extra: Partial<Idea> = {}): Idea {
	return {
		id,
		ts: "2026-10-20T10:00:00+05:30",
		scope: "project",
		kind: "idea",
		text,
		at: { cwd: "/p/photos", root: "/p/photos", project: "photos", isHarness: false, branch: "main", commit: "abc1234" },
		source: "pi",
		file: "photos.jsonl",
		status: "open",
		...extra,
	};
}

function harness(ideas: Idea[], harnessView = false) {
	const store = ideas.map((item) => ({ ...item }));
	const applied: Change[] = [];
	const source: ListSource = {
		harnessView,
		title: (everything) => (everything ? "All ideas" : "photos ideas"),
		ideas: (everything) =>
			store.filter((item) => item.status === "open" && (everything || item.scope === (harnessView ? "harness" : "project"))),
		moveTarget: (item) => (item.scope === "project" ? { scope: "harness" as Scope, label: "harness" } : undefined),
		apply: (change) => {
			applied.push(change);
			const target = store.find((item) => item.id === change.idea.id)!;
			if ("status" in change) target.status = change.status as Status;
			else target.scope = change.scope;
		},
	};
	let closed: { start: Idea | undefined } | undefined;
	let renders = 0;
	const list = new IdeaList(source, theme, { requestRender: () => renders++ }, (start) => (closed = { start }), () => NOW);
	return { list, applied, closed: () => closed, renders: () => renders, store };
}

const text = (lines: string[]) => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");

describe("IdeaList rendering", () => {
	test("no line is ever wider than the terminal, whatever the idea holds", () => {
		const nasty = [
			idea("a001", "plain ascii idea that goes on and on ".repeat(8)),
			idea("a002", "emoji 👩‍👩‍👧‍👦🏳️‍🌈 and CJK 漢字かなカナ 한국어 and wide ｆｕｌｌ", { kind: "bug" }),
			idea("a003", "Indic नमस्ते क्षत्रिय ஸ்ரீ and combining e\u0301\u0301\u0301 z\u0336", { kind: "dislike" }),
			idea("a004", "control\tchars\nnew\rline\u0007bell\x1b[31mred", { lastPrompt: "while\nthis\tran 🤖".repeat(20) }),
		];
		for (const everything of [false, true]) {
			const { list } = harness(nasty);
			if (everything) list.handleInput("a");
			for (let width = 10; width <= 160; width++) {
				for (const line of list.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});

	test("rows show the kind, the age and the detail of the selected idea", () => {
		const { list } = harness([idea("a001", "crop is off", { kind: "bug", lastPrompt: "fix uploads" })]);
		const out = text(list.render(100));
		expect(out).toContain("photos ideas · 1 open");
		expect(out).toContain("› bug crop is off");
		expect(out).toContain("1d");
		expect(out).toContain("#a001 · 2026-10-20 10:00 · main@abc1234 · while: fix uploads");
		expect(out).toContain("m → harness");
	});

	test("the harness view names the project each idea came from", () => {
		const { list } = harness([idea("a001", "dock flickers", { scope: "harness" })], true);
		expect(text(list.render(100))).toMatch(/dock flickers\s+photos · 1d/);
	});

	test("long lists scroll around the selection and say where you are", () => {
		const many = Array.from({ length: 30 }, (_, i) => idea(`i${String(i).padStart(3, "0")}`, `idea number ${i}`));
		const { list } = harness(many);
		for (let i = 0; i < 20; i++) list.handleInput("\x1b[B");
		const out = text(list.render(100));
		expect(out).toContain("› idea number 20");
		expect(out).toContain("21 of 30");
		expect(out).not.toContain("idea number 0\n");
	});

	test("an unchanged width returns the cached lines; input rebuilds them", () => {
		const { list, renders } = harness([idea("a001", "one"), idea("a002", "two")]);
		const first = list.render(80);
		expect(list.render(80)).toBe(first);
		list.handleInput("j");
		expect(list.render(80)).not.toBe(first);
		expect(renders()).toBe(1);
	});
});

describe("IdeaList keys", () => {
	test("enter hands back the selected idea; esc and q close with nothing", () => {
		const one = harness([idea("a001", "one"), idea("a002", "two")]);
		one.list.handleInput("\x1b[B");
		one.list.handleInput("\r");
		expect(one.closed()?.start?.id).toBe("a002");

		const two = harness([idea("a001", "one")]);
		two.list.handleInput("\x1b");
		expect(two.closed()).toEqual({ start: undefined });

		const three = harness([idea("a001", "one")]);
		three.list.handleInput("q");
		expect(three.closed()).toEqual({ start: undefined });
	});

	test("d, x and m change the idea, and u puts it back", () => {
		const { list, applied, store } = harness([idea("a001", "one"), idea("a002", "two"), idea("a003", "three")]);
		list.handleInput("d");
		expect(text(list.render(100))).toContain("done: one");
		list.handleInput("u");
		expect(store[0]!.status).toBe("open");
		list.handleInput("x");
		list.handleInput("m");
		expect(applied.map((change) => ("status" in change ? change.status : `scope:${change.scope}`))).toEqual([
			"done",
			"open",
			"dropped",
			"scope:harness",
		]);
		expect(store[1]!.scope).toBe("harness");
		expect(text(list.render(100))).toContain("photos ideas · 1 open");
	});

	test("keys arrive the same way through the kitty keyboard protocol", () => {
		const { list, store } = harness([idea("a001", "one")]);
		list.handleInput("\x1b[100u");
		expect(store[0]!.status).toBe("done");
	});

	test("a toggles between this project and every project", () => {
		const { list } = harness([idea("a001", "here"), idea("a002", "parked", { scope: "harness" })]);
		expect(text(list.render(100))).not.toContain("parked");
		list.handleInput("a");
		const out = text(list.render(100));
		expect(out).toContain("All ideas · 2 open");
		expect(out).toMatch(/parked\s+harness · 1d/);
	});

	test("an idea with nowhere to go says so instead of moving", () => {
		const { list, applied } = harness([idea("a001", "parked", { scope: "harness" })], true);
		list.handleInput("m");
		expect(applied).toEqual([]);
		expect(text(list.render(100))).toContain("nowhere else to go");
	});

	test("an empty list still closes and tells you how to add one", () => {
		const { list, closed } = harness([]);
		expect(text(list.render(80))).toContain("No open ideas here. /idea <text> saves one.");
		list.handleInput("d");
		list.handleInput("\r");
		expect(closed()).toBeUndefined();
		list.handleInput("\x1b");
		expect(closed()).toEqual({ start: undefined });
	});
});
