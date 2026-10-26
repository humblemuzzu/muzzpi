import { beforeAll, describe, expect, test } from "bun:test";
import { initTheme } from "@mariozechner/pi-coding-agent";
import { visibleWidth } from "@mariozechner/pi-tui";
import { session, strip, theme } from "./test-helpers";
import { FocusView, type FocusHost, type FocusMemory, type LiveState } from "./view";

beforeAll(() => initTheme("dark"));

const ESC = "\u001b";
const ENTER = "\r";
const TAB = "\t";
const LEFT = "\u001b[D";
const RIGHT = "\u001b[C";
const UP = "\u001b[A";
const PAGE_DOWN = "\u001b[6~";
const CTRL_UP = "\u001b[1;5A";
const CTRL_END = "\u001b[1;5F";
const CTRL_HOME = "\u001b[1;5H";
const CTRL_SHIFT_L = "\u001b[108;6u";
const CTRL_SHIFT_H = "\u001b[104;6u";
const CTRL_T = "\u0014";
const CTRL_G = "\u0007";
const CTRL_R = "\u0012";
const SIZES = [
	{ width: 22, rows: 6 },
	{ width: 40, rows: 12 },
	{ width: 100, rows: 30 },
	{ width: 160, rows: 50 },
];

function sample() {
	const s = session();
	s.prompt("Explain the cache drain\nand how to fix it");
	s.call("t1", "read", { path: "prompt-cache.ts" });
	s.result("t1", "x".repeat(40));
	const reply = s.reply("The TTL was **5 minutes**.");
	s.prompt("abandoned approach");
	s.reply("tried");
	s.manager.branch(reply);
	s.manager.appendCompaction("## Goal\nSummary of the cache work", reply, 300_000);
	s.prompt("now write the tests");
	s.reply("tests written");
	return s;
}

function harness(s = sample(), options: { rows?: number; memory?: FocusMemory } = {}) {
	let rows = options.rows ?? 30;
	const live: LiveState = { running: false, startedAt: 0, message: undefined, compacting: false, frame: 0, version: 0 };
	const editor = { text: "", typed: [] as string[], focused: false, handleInput(data: string) {
		this.typed.push(data);
		if (data.length === 1 && data >= " ") this.text += data;
	}, getText() {
		return this.text;
	} };
	const calls = { closed: 0, marked: [] as string[], moved: [] as string[], reused: [] as string[], afterRender: [] as number[] };
	let expanded = false;
	let snap = { view: s.view(), version: 1 };
	const host: FocusHost = {
		snapshot: () => snap,
		live: () => live,
		now: () => 1_700_000_100_000,
		chatRows: () => rows,
		toolsExpanded: () => expanded,
		editor: () => editor,
		afterRender: (drawn) => calls.afterRender.push(drawn),
		mark: (turn) => (calls.marked.push(turn.prompt), "marked"),
		goto: (turn) => (calls.moved.push(turn.lastId), "moving"),
		reuse: (turn) => (calls.reused.push(turn.prompt), "reused"),
		close: () => calls.closed++,
	};
	const view = new FocusView(theme, host, options.memory);
	view.focused = true;
	return {
		s,
		view,
		live,
		editor,
		calls,
		refresh: () => (snap = { view: s.view(), version: snap.version + 1 }),
		resize: (next: number) => (rows = next),
		expand: (value: boolean) => (expanded = value),
		text: (width = 100) => view.render(width).map(strip).join("\n"),
		keys: (...data: string[]) => data.forEach((key) => view.handleInput(key)),
	};
}

describe("it covers pi's chat area exactly", () => {
	test("as many lines as the chat area has rows, none wider than the terminal, on every screen", () => {
		const s = sample();
		s.prompt(`ünïcödé 👩‍👩‍👧 ${"long words ".repeat(80)}\u001b[31mred\u0007\ttab`);
		for (const { width, rows } of SIZES) {
			const h = harness(s, { rows });
			for (const go of [() => {}, () => h.keys(TAB), () => h.keys(CTRL_SHIFT_L), () => h.keys(TAB), () => h.keys(TAB), () => h.keys(ENTER)]) {
				go();
				const lines = h.view.render(width);
				expect(lines).toHaveLength(rows);
				for (const line of lines) {
					expect(visibleWidth(line)).toBeLessThanOrEqual(width);
					expect(line).not.toContain("\n");
				}
			}
		}
	});

	test("when pi's dock grows the chat shrinks, and focus mode follows it on the next frame", async () => {
		const h = harness(sample(), { rows: 30 });
		expect(h.view.render(100)).toHaveLength(30);
		await Promise.resolve();
		expect(h.calls.afterRender).toContain(30);
		h.resize(24);
		expect(h.view.render(100)).toHaveLength(24);
	});

	test("it hands pi's editor the cursor while it holds the keyboard", () => {
		const h = harness();
		expect(h.editor.focused).toBe(true);
	});
});

describe("the turn screen reads like the chat", () => {
	test("your prompt opens the page and scrolls away with it; the answer follows", () => {
		const s = session();
		s.prompt(Array.from({ length: 30 }, (_, i) => `prompt line ${i}`).join("\n"));
		s.reply(Array.from({ length: 30 }, (_, i) => `answer line ${i}`).join("\n\n"));
		const h = harness(s, { rows: 20 });
		expect(h.text()).toContain("You asked");
		expect(h.text()).toContain("prompt line 0");
		h.keys(PAGE_DOWN, PAGE_DOWN);
		expect(h.text()).not.toContain("prompt line 0");
		expect(h.text()).toContain("answer line");
		h.keys(CTRL_HOME);
		expect(h.text()).toContain("prompt line 0");
		h.keys(CTRL_END);
		expect(h.text()).toContain("answer line 29");
	});

	test("tab shows the work; ←→ and ctrl+↑↓ walk the prompts; the tags say where each one is", () => {
		const h = harness();
		expect(h.text()).toContain("tests written");
		h.keys(LEFT);
		expect(h.text()).toContain("on another /tree branch");
		h.keys(CTRL_UP);
		expect(h.text()).toContain("summarised away (compaction 1)");
		expect(h.text()).toContain("The TTL was 5 minutes.");
		h.keys(TAB);
		expect(h.text()).toContain("Process · 1 tool");
		expect(h.text()).toMatch(/✓ Read .*prompt-cache\.ts/);
		h.keys(RIGHT, RIGHT);
		expect(h.text()).toContain("prompt 3 of 3");
	});

	test("full tool output follows pi's own ctrl+o", () => {
		const s = session();
		s.prompt("read it");
		s.call("t1");
		s.result("t1", Array.from({ length: 20 }, (_, i) => `out ${i}`).join("\n"));
		s.reply("done");
		const h = harness(s);
		h.keys(TAB);
		expect(h.text()).not.toContain("out 19");
		h.expand(true);
		expect(h.text()).toContain("out 19");
	});
});

describe("pi's editor keeps working underneath", () => {
	test("every key focus mode does not use goes to pi's editor: letters, enter, esc, ctrl+c, shift+tab", () => {
		const h = harness();
		const before = h.text();
		h.keys("h", "i", ENTER, ESC, "\u0003", "\u001b[Z", UP);
		expect(h.editor.typed).toEqual(["h", "i", ENTER, ESC, "\u0003", "\u001b[Z", UP]);
		expect(h.text()).toBe(before);
	});

	test("tab and the arrows are focus mode's only while pi's prompt is empty", () => {
		const h = harness();
		h.keys("x", TAB, LEFT);
		expect(h.editor.typed).toEqual(["x", TAB, LEFT]);
		expect(h.text()).toContain("prompt 3 of 3");
		h.keys(PAGE_DOWN, CTRL_UP);
		expect(h.editor.typed).toHaveLength(3);
		expect(h.text()).toContain("prompt 2 of 3");
	});

	test("ctrl+shift+h closes it", () => {
		const h = harness();
		h.keys(CTRL_SHIFT_H);
		expect(h.calls.closed).toBe(1);
	});
});

describe("while the agent works", () => {
	test("the answer streams in, and the process shows the call in flight", () => {
		const h = harness();
		h.live.running = true;
		h.live.version++;
		expect(h.text()).toContain("working");
		h.live.message = { role: "assistant", content: [{ type: "text", text: "Writing the first test" }, { type: "toolCall", id: "w", name: "write", arguments: { path: "a.test.ts" } }] } as never;
		h.live.version++;
		expect(h.text()).toContain("Writing the first test");
		h.keys(TAB);
		expect(h.text()).toMatch(/⋯ Write .*a\.test\.ts/);
	});

	test("a reply that pi keeps filling in is never shown from a stale copy, while streaming or once saved", () => {
		const s = session();
		s.prompt("write it");
		const h = harness(s);
		const reply = { role: "assistant", content: [{ type: "text", text: "Draft" }], stopReason: "stop" };
		h.live.running = true;
		h.live.message = reply as never;
		h.live.version++;
		expect(h.text()).toContain("Draft");
		reply.content[0]!.text = "Draft of the whole README";
		h.live.version++;
		expect(h.text()).toContain("Draft of the whole README");
		s.manager.appendMessage(reply as never);
		h.live.running = false;
		h.live.message = undefined;
		h.live.version++;
		h.refresh();
		expect(h.text()).toContain("Draft of the whole README");
	});
});

test("after /tree moves to another reply inside the same prompt, that reply is what shows", () => {
	const s = session();
	const prompt = s.prompt("task");
	s.reply("answer A");
	const h = harness(s);
	expect(h.text()).toContain("answer A");
	s.manager.branch(prompt);
	s.reply("answer B");
	h.refresh();
	h.view.followSession();
	expect(h.text()).toContain("answer B");
	expect(h.text()).not.toContain("answer A");
});

test("your own ! commands show in the work, with their output", () => {
	const s = session();
	s.prompt("check");
	s.manager.appendMessage({ role: "bashExecution", command: "ls src", output: "a.ts\nb.ts", exitCode: 0, cancelled: false, truncated: false, timestamp: 1 } as never);
	s.reply("two files");
	const h = harness(s);
	h.keys(TAB);
	expect(h.text()).toContain("$ ls src");
	expect(h.text()).toContain("b.ts");
});

describe("every prompt (ctrl+shift+l)", () => {
	test("lists every prompt, marks the other branch and the compaction, and opens one with enter", () => {
		const h = harness();
		h.keys(CTRL_SHIFT_L);
		const text = h.text();
		expect(text).toContain("every prompt in this session");
		expect(text).toMatch(/⑂ abandoned approach/);
		expect(text).toContain("── summary 1");
		expect(text).toContain("3 of 3 prompts · 1 compaction");
		h.keys(UP, UP, ENTER);
		expect(h.text()).toContain("prompt 1 of 3");
	});

	test("typing searches here instead of reaching pi's editor; esc clears the search, then goes back", () => {
		const h = harness();
		h.keys(CTRL_SHIFT_L, "t", "t", "l");
		expect(h.editor.typed).toEqual([]);
		expect(h.text()).toContain("1 of 3 prompts");
		h.keys(ESC);
		expect(h.text()).toContain("3 of 3 prompts");
		h.keys(ESC);
		expect(h.text()).toContain("You asked");
	});

	test("ctrl+t marks, ctrl+g goes there, ctrl+r puts the prompt in pi's prompt", () => {
		const h = harness();
		h.keys(CTRL_SHIFT_L, UP, UP, CTRL_T);
		expect(h.calls.marked).toEqual(["Explain the cache drain\nand how to fix it"]);
		expect(h.text()).toContain("marked");
		h.keys(CTRL_G);
		expect(h.calls.moved).toHaveLength(1);
		h.keys(CTRL_R);
		expect(h.calls.reused).toEqual(["Explain the cache drain\nand how to fix it"]);
		expect(h.text()).toContain("You asked");
	});

	test("the answers tab lists the replies, and marks open a summary to read", () => {
		const h = harness();
		h.keys(CTRL_SHIFT_L, TAB);
		expect(h.text()).toContain("tests written");
		h.keys(TAB);
		expect(h.text()).toContain("Summary 1: 300k tokens before");
		h.keys(ENTER);
		expect(h.text()).toContain("Summary of the cache work");
		h.keys(ESC);
		expect(h.text()).toContain("Summary 1: 300k tokens before");
	});

	test("the mouse wheel moves the selection", () => {
		const h = harness();
		h.keys(CTRL_SHIFT_L);
		h.view.handleMouse({ type: "wheel", button: "none", x: 0, y: 0, wheelDelta: -1 } as never);
		h.keys(ENTER);
		expect(h.text()).toContain("prompt 1 of 3");
	});
});

describe("caching and memory", () => {
	test("a frame is reused until something changes, and a key passed to pi's editor changes nothing here", () => {
		const h = harness();
		const first = h.view.render(100);
		expect(h.view.render(100)).toBe(first);
		h.keys("a");
		expect(h.view.render(100)).toBe(first);
		h.refresh();
		expect(h.view.render(100)).not.toBe(first);
		const second = h.view.render(100);
		h.keys(CTRL_UP);
		expect(h.view.render(100)).not.toBe(second);
	});

	test("where you were comes back when focus mode opens again", () => {
		const h = harness();
		h.keys(LEFT, LEFT, TAB);
		const again = harness(h.s, { memory: h.view.memory() });
		expect(again.text()).toContain("prompt 1 of 3");
		expect(again.text()).toMatch(/✓ Read .*prompt-cache\.ts/);
	});
});
