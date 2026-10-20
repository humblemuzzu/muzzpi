import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@mariozechner/pi-tui";
import { Dock, DOCK_MAX_ROWS, type DockHost } from "./dock";
import type { PickerAction } from "./picker";
import { RunStore } from "./store";
import { fakeClock, finished, run, scheduler, strip, T0, theme } from "./test-helpers";

const KEY = { down: "\u001b[B", up: "\u001b[A", enter: "\r", esc: "\u001b" };
const WIDTHS = [40, 60, 80, 160];

function setup() {
	const store = new RunStore();
	const clock = fakeClock();
	const timers = scheduler();
	const events = { renders: 0, focus: 0, blur: 0, actions: [] as PickerAction[] };
	const host: DockHost = {
		requestRender: () => events.renders++,
		focus: () => events.focus++,
		blur: () => events.blur++,
		act: (action) => events.actions.push(action),
		later: timers.later,
	};
	const dock = new Dock(store, clock, theme, host);
	const lines = (width = 100) => dock.render(width).map(strip);
	return { store, clock, timers, events, dock, lines };
}

describe("when the dock is there", () => {
	test("nothing shows before any run, and finished runs of an old session never bring it up", () => {
		const { store, dock, lines } = setup();
		expect(dock.mode()).toBe("hidden");
		store.ingest([finished({ endedAt: T0 - 3_600_000 })]);
		expect(dock.mode()).toBe("hidden");
		expect(lines()).toEqual([]);
	});

	test("it appears when the first background run starts, and not for a blocking one", () => {
		const { store, dock } = setup();
		store.ingest([run({ background: false })]);
		expect(dock.mode()).toBe("hidden");
		store.ingest([run({ background: false }), run()]);
		expect(dock.mode()).toBe("full");
	});

	test("the moment the last run finishes it is gone, with no timer left behind", () => {
		const { store, timers, dock, lines, events } = setup();
		store.ingest([run({ id: "a" }), run({ id: "b" })]);
		dock.focused = true;
		store.ingest([finished({ id: "a" }), finished({ id: "b", status: "failed" })]);
		expect(dock.mode()).toBe("hidden");
		expect(lines()).toEqual([]);
		expect(timers.pending()).toBe(0);
		expect(events.blur).toBeGreaterThan(0);
	});

	test("new work brings it back without the runs of the last batch", () => {
		const { store, clock, lines } = setup();
		const old = finished({ id: "a", label: "old batch", endedAt: clock.now() });
		store.ingest([run({ id: "a", label: "old batch" })]);
		store.ingest([old]);
		clock.advance(5_000);
		store.ingest([old, run({ id: "b", label: "new batch" })]);
		const text = lines(120).join("\n");
		expect(text).toContain("new batch");
		expect(text).not.toContain("old batch");
	});
});

describe("the rows", () => {
	test("a summary line counts what is working, queued and done, with the hint after it", () => {
		const { store, lines } = setup();
		store.ingest([run(), run(), run({ status: "queued", startedAt: undefined }), finished()]);
		expect(lines()[0]).toBe(" 2 working · 1 queued · 1 done   ↓ manage");
	});

	test("running first with the activity beside the label, finished dimmed after them", () => {
		const { store, lines } = setup();
		store.ingest([finished({ id: "done-1", label: "an old one" }), run({ id: "live-1", label: "a live one", activity: "read pi-spawn.ts" })]);
		const rows = lines(120);
		expect(rows[1]).toContain("chad a live one");
		expect(rows[1]).toContain("read pi-spawn.ts");
		expect(rows[1]).toContain("deepseek-flash");
		expect(rows[1]).toEndWith("↓45k");
		expect(rows[2]).toContain("chad an old one");
		expect(rows[2]).toContain("Found the bug in auth.ts");
		expect(rows[2]).toEndWith("↑45k");
	});

	test("six rows at most, then how many more", () => {
		const { store, lines } = setup();
		store.ingest(Array.from({ length: 9 }, (_, i) => run({ id: `r${i}`, startedAt: T0 + i })));
		const rows = lines(100);
		expect(rows).toHaveLength(1 + DOCK_MAX_ROWS + 1);
		expect(rows.at(-1)).toBe("   +3 more");
	});

	test("right columns are all or nothing: at a narrow width every row loses them together", () => {
		const { store, lines } = setup();
		store.ingest([run({ label: "short" }), run({ label: "another", model: undefined })]);
		const wide = lines(160);
		expect(wide[1]).toContain("deepseek-flash");
		const narrow = lines(40);
		expect(narrow.slice(1).some((row) => /\d+s|↓/.test(row.slice(30)))).toBe(false);
		const mid = lines(52);
		expect(mid.slice(1).every((row) => /\d+s\s+↓45k$/.test(row))).toBe(true);
		expect(mid[1]).not.toContain("deepseek-flash");
	});

	test("a queued run says so, a stopping run says stopping", () => {
		const { store, lines } = setup();
		store.ingest([run({ status: "queued", startedAt: undefined, usage: run().usage }), run({ stopping: true })]);
		const rows = lines(120).join("\n");
		expect(rows).toContain("queued");
		expect(rows).toContain("stopping…");
	});

	test("a refusal shows on its row and goes away on its own", () => {
		const { store, clock, timers, dock, lines } = setup();
		const control = { action: "continue" as const, ok: false, text: "still running; steer it instead", at: clock.now() };
		store.ingest([run({ control })]);
		expect(lines(120).join("\n")).toContain("✗ still running; steer it instead");
		clock.advance(7_000);
		timers.advance(7_000);
		expect(dock.render(120).map(strip).join("\n")).not.toContain("still running");
	});

	test("every width keeps every line inside it", () => {
		const { store, dock } = setup();
		store.ingest([
			run({ label: "a very long label that cannot possibly fit into a narrow terminal ".repeat(2), activity: "read /a/very/long/path/to/a/file/that/is/deep/in/the/tree.ts" }),
			run({ agent: "code_review", label: "日本語のラベル" }),
			finished({ status: "failed", errorMessage: "boom\nsecond" }),
		]);
		for (const width of [12, 20, ...WIDTHS]) {
			for (const line of dock.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});
});

describe("caching", () => {
	test("the same width and state give the very same lines", () => {
		const { store, clock, dock } = setup();
		store.ingest([run()]);
		const first = dock.render(80);
		expect(dock.render(80)).toBe(first);
		expect(dock.render(60)).not.toBe(first);
		const again = dock.render(80);
		clock.advance(250);
		expect(dock.render(80)).not.toBe(again);
		store.ingest([run()]);
		expect(dock.render(80)).not.toBe(dock.render(70));
	});

	test("a hidden dock returns no lines and the glyph spins with the frame", () => {
		const { store, clock, dock } = setup();
		store.ingest([run()]);
		const a = strip(dock.render(100)[1]!);
		clock.advance(250);
		const b = strip(dock.render(100)[1]!);
		expect(a.slice(0, 5)).not.toBe(b.slice(0, 5));
	});
});

describe("keys in the focused dock", () => {
	function focusedWith(runs = [run({ id: "live-a" }), run({ id: "live-b" }), finished({ id: "done-c" })]) {
		const ctx = setup();
		ctx.store.ingest(runs);
		ctx.dock.focused = true;
		return ctx;
	}

	test("up and down move the pointer, enter opens the run", () => {
		const { dock, events, lines } = focusedWith();
		expect(lines(100)[1]).toStartWith(" ❯ ");
		dock.handleInput(KEY.down);
		expect(lines(100)[2]).toStartWith(" ❯ ");
		dock.handleInput(KEY.enter);
		expect(events.actions).toEqual([{ type: "open", id: "live-b" }]);
		dock.handleInput(KEY.up);
		dock.handleInput(KEY.up);
		dock.handleInput(KEY.enter);
		expect(events.actions.at(-1)).toEqual({ type: "open", id: "live-a" });
	});

	test("s opens a one-line input; enter sends it as a steer, esc drops it", () => {
		const { dock, events, lines } = focusedWith();
		dock.handleInput("s");
		expect(lines(100).at(-1)).toContain("steer chad ▸");
		for (const ch of "check tests") dock.handleInput(ch);
		expect(lines(100).at(-1)).toContain("check tests");
		dock.handleInput(KEY.enter);
		expect(events.actions).toEqual([{ type: "steer", id: "live-a", text: "check tests" }]);
		expect(lines(100).at(-1)).not.toContain("steer chad ▸");
		dock.handleInput("s");
		dock.handleInput(KEY.esc);
		expect(events.actions).toHaveLength(1);
		expect(lines(100).at(-1)).not.toContain("▸");
	});

	test("c continues a finished run and refuses a running one inline", () => {
		const { dock, events, lines } = focusedWith();
		dock.handleInput("c");
		expect(lines(100)[0]).toContain("still running; press s to steer it");
		dock.handleInput(KEY.down);
		dock.handleInput(KEY.down);
		dock.handleInput("c");
		for (const ch of "go on") dock.handleInput(ch);
		dock.handleInput(KEY.enter);
		expect(events.actions).toEqual([{ type: "continue", id: "done-c", text: "go on" }]);
	});

	test("s on a finished run refuses and points at c", () => {
		const { dock, lines } = focusedWith();
		dock.handleInput(KEY.down);
		dock.handleInput(KEY.down);
		dock.handleInput("s");
		expect(lines(100)[0]).toContain("has finished; press c to continue it");
	});

	test("x stops a live run and dismisses a finished one", () => {
		const { dock, events, lines } = focusedWith();
		dock.handleInput("x");
		expect(events.actions).toEqual([{ type: "stop", id: "live-a" }]);
		dock.handleInput(KEY.down);
		dock.handleInput(KEY.down);
		dock.handleInput("x");
		expect(lines(100).join("\n")).not.toContain("Found the bug");
	});

	test("a focus left over after the work ended gives itself up instead of swallowing keys", () => {
		const { store, dock, events } = focusedWith([run({ id: "a" })]);
		store.ingest([finished({ id: "a" })]);
		const blurred = events.blur;
		dock.handleInput("x");
		expect(events.blur).toBeGreaterThan(blurred);
		expect(events.actions).toEqual([]);
	});

	test("esc asks to leave, and unknown keys do nothing", () => {
		const { dock, events } = focusedWith();
		dock.handleInput("q");
		dock.handleInput(KEY.esc);
		expect(events.actions).toEqual([{ type: "close" }]);
	});

	test("the hint line follows the focus and gives way to the width", () => {
		const { dock, lines } = focusedWith();
		expect(lines(120)[0]).toContain("↑↓ select · enter open · s steer · c continue · x stop · X stop all · esc back");
		expect(lines(50)[0]).not.toContain("select");
		expect(lines(22)[0]).not.toContain("esc");
	});

	test("X asks once, then stops all; it lapses after three seconds", () => {
		const { dock, events, clock, lines } = focusedWith();
		dock.handleInput("X");
		expect(lines(120)[0]).toContain("Press X again to stop all");
		clock.advance(3_100);
		dock.handleInput("X");
		expect(events.actions).toEqual([]);
		dock.handleInput("X");
		expect(events.actions).toEqual([{ type: "stopAll" }]);
	});
});
