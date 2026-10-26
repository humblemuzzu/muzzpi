import { beforeAll, describe, expect, test } from "bun:test";
import { initTheme } from "@mariozechner/pi-coding-agent";
import { visibleWidth } from "@mariozechner/pi-tui";
import type { RunSnapshot } from "../tools/lib/agent-channel";
import { AgentView, type ViewActions, type ViewResult } from "./agent-view";
import { ListView, groupRuns, type ListResult } from "./list-view";
import { RunStore } from "./store";
import { TranscriptRenderer } from "./transcript";
import { fakeClock, finished, run, strip, theme } from "./test-helpers";

beforeAll(() => initTheme("dark"));

const KEY = { down: "\u001b[B", up: "\u001b[A", left: "\u001b[D", right: "\u001b[C", enter: "\r", esc: "\u001b", end: "\u001b[F", pageUp: "\u001b[5~" };
const SIZES = [{ width: 40, rows: 12 }, { width: 80, rows: 24 }, { width: 160, rows: 45 }, { width: 22, rows: 10 }];

const assistant = (...content: unknown[]) => ({ role: "assistant", content }) as never;
const toolCall = (id: string, name: string, args: object) => ({ type: "toolCall", id, name, arguments: args });
const toolResult = (id: string, text: string, isError = false) => ({ role: "toolResult", toolCallId: id, toolName: "read", isError, content: [{ type: "text", text }] }) as never;

function conversation(): RunSnapshot["messages"] {
	return [
		{ role: "user", content: [{ type: "text", text: "Task: audit the token flow" }] },
		assistant({ type: "thinking", thinking: "I should read the session file first." }, toolCall("t1", "read", { path: "src/session.ts" })),
		toolResult("t1", Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n")),
		assistant({ type: "text", text: "## Result\n\nThe **token** is refreshed twice." }, toolCall("t2", "bash", { command: "grep -rn refresh src" })),
		toolResult("t2", "boom", true),
	] as never;
}

function viewSetup(runs: RunSnapshot[], size = { width: 80, rows: 24 }) {
	const store = new RunStore();
	store.ingest(runs);
	const clock = fakeClock();
	const log = { steer: [] as unknown[], cont: [] as unknown[], stop: [] as string[], closed: [] as ViewResult[] };
	const actions: ViewActions = {
		steer: (id, text) => log.steer.push([id, text]),
		continueRun: (id, text) => log.cont.push([id, text]),
		stop: (id) => log.stop.push(id),
	};
	const view = new AgentView(runs[0]!.id, store, clock, theme, actions, () => ({ rows: size.rows }), (r) => log.closed.push(r));
	return { store, clock, log, view, size, lines: () => view.render(size.width).map(strip), type: (text: string) => [...text].forEach((ch) => view.handleInput(ch)) };
}

describe("the transcript", () => {
	test("is drawn like the main chat: task, thinking, tool lines with their outcome, prose as markdown, results cut short", () => {
		const lines = new TranscriptRenderer(theme).lines(conversation(), 80, { full: false }).map(strip);
		const text = lines.join("\n");
		expect(text).toContain("task\nTask: audit the token flow");
		expect(text).toContain("thinking\nI should read the session file first.");
		expect(text).toContain("✓ Read src/session.ts");
		expect(text).toContain("✕ Bash grep -rn refresh src");
		expect(text).toContain("    line 6\n");
		expect(text).not.toContain("line 7\n");
		expect(text).toContain("… 14 more lines (ctrl+o shows all)");
		expect(text).toContain("Result");
		expect(text).not.toContain("**");
	});

	test("full results show every line", () => {
		const text = new TranscriptRenderer(theme).lines(conversation(), 80, { full: true }).map(strip).join("\n");
		expect(text).toContain("    line 20");
	});

	test("a message is rendered once per width and kept", () => {
		const renderer = new TranscriptRenderer(theme);
		const messages = conversation();
		const first = renderer.lines(messages, 80, { full: false });
		const again = renderer.lines(messages, 80, { full: false });
		expect(again).toEqual(first);
		const message = messages[3]!;
		const spy = (renderer as any).cache.get(message);
		renderer.lines(messages, 80, { full: false });
		expect((renderer as any).cache.get(message)).toBe(spy);
		renderer.lines(messages, 60, { full: false });
		expect((renderer as any).cache.get(message)).not.toBe(spy);
	});

	test("the first user message is the task, later ones are messages to the agent", () => {
		const messages = [...conversation(), { role: "user", content: [{ type: "text", text: "Message from the user while you work:\n\nalso check x" }] } as never];
		const text = new TranscriptRenderer(theme).lines(messages, 80, { full: false }).map(strip).join("\n");
		expect(text).toContain("task\nTask: audit the token flow");
		expect(text).toContain("message\nMessage from the user while you work:");
	});

	test("a tool call shows pending until its result arrives", () => {
		const messages = conversation().slice(0, 2);
		const text = new TranscriptRenderer(theme).lines(messages, 80, { full: false }).map(strip).join("\n");
		expect(text).toContain("⋯ Read src/session.ts");
	});
});

describe("the full-screen agent view", () => {
	test("is a frame exactly as tall and wide as the screen, at every size", () => {
		for (const size of SIZES) {
			const { view } = viewSetup([run({ messages: conversation(), activity: "read x.ts" })], size);
			const lines = view.render(size.width);
			expect(lines).toHaveLength(size.rows);
			for (const line of lines) expect(visibleWidth(line)).toBe(size.width);
		}
	});

	test("title row: status, agent, label, model on the left; activity and elapsed on the right", () => {
		const { view } = viewSetup([run({ label: "audit token flow", activity: "read auth/session.rs", messages: conversation() })]);
		const title = strip(view.render(100)[1]!);
		expect(title).toMatch(/^│ [◐◓◑◒] chad {2}audit token flow {2}deepseek-flash\s+read auth\/session\.rs · \d+s/);
	});

	test("follows the live end; scrolling up pauses, End resumes", () => {
		const long = Array.from({ length: 60 }, (_, i) => assistant({ type: "text", text: `paragraph ${i}` }));
		const { view, lines, store } = viewSetup([run({ messages: long as never })]);
		expect(lines().join("\n")).toContain("paragraph 59");
		view.handleInput(KEY.up);
		view.handleInput(KEY.up);
		const paused = lines();
		expect(paused.join("\n")).not.toContain("paragraph 59");
		expect(paused.at(-2)).toContain("paused");
		store.ingest([run({ id: view.viewing, messages: [...long, assistant({ type: "text", text: "brand new" })] as never })]);
		expect(lines().join("\n")).not.toContain("brand new");
		view.handleInput(KEY.end);
		expect(lines().join("\n")).toContain("brand new");
		expect(lines().at(-2)).toContain("following");
	});

	test("ctrl+o toggles full tool results", () => {
		const { view, lines } = viewSetup([run({ messages: conversation() })], { width: 80, rows: 60 });
		expect(lines().join("\n")).not.toContain("line 20");
		view.handleInput("\u000f");
		expect(lines().join("\n")).toContain("line 20");
	});

	test("left and right switch to the neighbouring agent when the draft is empty", () => {
		const { view, lines } = viewSetup([run({ id: "a", label: "first one" }), run({ id: "b", label: "second one" })]);
		expect(lines()[1]).toContain("first one");
		view.handleInput(KEY.right);
		expect(lines()[1]).toContain("second one");
		view.handleInput(KEY.left);
		view.handleInput(KEY.left);
		expect(lines()[1]).toContain("second one");
	});

	test("typing steers a running agent, and the line empties", () => {
		const { view, log, lines, type } = viewSetup([run({ id: "a" })]);
		expect(lines().at(-3)).toContain("type to steer this agent");
		type("look at tests");
		expect(lines().at(-3)).toContain("look at tests");
		view.handleInput(KEY.enter);
		expect(log.steer).toEqual([["a", "look at tests"]]);
		expect(lines().at(-3)).toContain("type to steer this agent");
	});

	test("typing to a finished agent continues it", () => {
		const { view, log, lines, type } = viewSetup([finished({ id: "a", messages: conversation() })]);
		expect(lines().at(-3)).toContain("type to continue this agent");
		type("now fix it");
		view.handleInput(KEY.enter);
		expect(log.cont).toEqual([["a", "now fix it"]]);
		expect(log.steer).toEqual([]);
	});

	test("while a draft exists, arrows move the cursor instead of switching agents", () => {
		const { view, lines, type } = viewSetup([run({ id: "a", label: "first one" }), run({ id: "b", label: "second one" })]);
		type("hi");
		view.handleInput(KEY.right);
		expect(lines()[1]).toContain("first one");
	});

	test("every letter is text: a message may start with f, x or q", () => {
		const { view, log, lines, type } = viewSetup([run({ id: "a" })]);
		type("fix x and q");
		expect(lines().at(-3)).toContain("fix x and q");
		view.handleInput(KEY.enter);
		expect(log.steer).toEqual([["a", "fix x and q"]]);
		expect(log.stop).toEqual([]);
		expect(log.closed).toEqual([]);
	});

	test("ctrl+c stops a live run and keeps the view; esc closes it", () => {
		const { view, log } = viewSetup([run({ id: "a" })]);
		view.handleInput("\u0003");
		expect(log.stop).toEqual(["a"]);
		expect(log.closed).toEqual([]);
		view.handleInput(KEY.esc);
		expect(log.closed).toEqual(["closed"]);
	});

	test("keys it does not own never leave it: only its own handlers run", () => {
		const { view, log } = viewSetup([run({ id: "a" })]);
		view.handleInput("\u0018");
		expect(log.closed).toEqual([]);
		expect(log.stop).toEqual([]);
		expect(log.steer).toEqual([]);
	});

	test("a refusal from the tools extension shows in the hint row", () => {
		const { view, store, lines, clock } = viewSetup([finished({ id: "a" })]);
		store.ingest([finished({ id: "a", control: { action: "continue", ok: false, text: "ran in an earlier session", at: clock.now() } })]);
		expect(lines().at(-2)).toContain("✗ ran in an earlier session");
	});

	test("the same screen is served from cache until something changes", () => {
		const { view, store, size, clock } = viewSetup([run({ id: "a", messages: conversation() })]);
		const first = view.render(size.width);
		expect(view.render(size.width)).toBe(first);
		expect(view.render(70)).not.toBe(first);
		const again = view.render(size.width);
		clock.advance(250);
		expect(view.render(size.width)).not.toBe(again);
		store.ingest([run({ id: "a" })]);
		expect(view.render(size.width)).not.toBe(again);
	});

	test("a run that vanished says so instead of throwing", () => {
		const { view, store, size } = viewSetup([run({ id: "a" })]);
		store.ingest([]);
		expect(() => view.render(size.width)).not.toThrow();
		expect(view.render(size.width).map(strip).join("\n")).toContain("that agent is gone");
	});
});

describe("the agents list", () => {
	function listSetup(runs: RunSnapshot[], size = { width: 100, rows: 24 }) {
		const store = new RunStore();
		store.ingest(runs);
		const clock = fakeClock();
		const log = { acts: [] as unknown[], closed: [] as ListResult[] };
		const list = new ListView(store, clock, theme, (a) => log.acts.push(a), () => ({ rows: size.rows }), (r) => log.closed.push(r));
		return { store, list, log, size, lines: () => list.render(size.width).map(strip) };
	}
	const mixed = () => [
		run({ id: "r1" }),
		run({ id: "q1", status: "queued", startedAt: undefined }),
		finished({ id: "d1" }),
		finished({ id: "f1", status: "failed", errorMessage: "boom" }),
		finished({ id: "i1", status: "interrupted" }),
	];

	test("groups running, queued, done and interrupted", () => {
		const groups = groupRuns(mixed().map((r) => r), true);
		expect(groups.map((g) => [g.title, g.runs.map((r) => r.id)])).toEqual([["Running", ["r1"]], ["Queued", ["q1"]], ["Done", ["d1", "f1"]], ["Interrupted", ["i1"]]]);
	});

	test("shows the groups with their counts, and h hides what has finished", () => {
		const { list, lines } = listSetup(mixed());
		const text = lines().join("\n");
		expect(text).toContain("▾ Running 1");
		expect(text).toContain("▾ Done 2");
		expect(text).toContain("▾ Interrupted 1");
		list.handleInput("h");
		const hidden = lines().join("\n");
		expect(hidden).toContain("▾ Running 1");
		expect(hidden).not.toContain("▾ Done");
		expect(lines().at(-2)).toContain("h show finished");
	});

	test("enter hands the selected run to whoever opened the list; esc closes it", () => {
		const { list, log } = listSetup(mixed());
		list.handleInput(KEY.down);
		list.handleInput(KEY.enter);
		expect(log.closed).toEqual([{ open: "q1" }]);
		list.handleInput(KEY.esc);
		expect(log.closed.at(-1)).toEqual({ closed: true });
	});

	test("s, c and x act on the selected run exactly as in the dock", () => {
		const { list, log, lines } = listSetup(mixed());
		list.handleInput("x");
		expect(log.acts).toEqual([{ type: "stop", id: "r1" }]);
		list.handleInput("s");
		for (const ch of "go") list.handleInput(ch);
		expect(lines().at(-3)).toContain("steer chad ▸ go");
		list.handleInput(KEY.enter);
		expect(log.acts.at(-1)).toEqual({ type: "steer", id: "r1", text: "go" });
	});

	test("fills the screen exactly at every size, with an empty session too", () => {
		for (const size of SIZES) {
			for (const runs of [mixed(), []]) {
				const { list } = listSetup(runs, size);
				const lines = list.render(size.width);
				expect(lines).toHaveLength(size.rows);
				for (const line of lines) expect(visibleWidth(line)).toBe(size.width);
			}
		}
	});

	test("scrolls to keep the selected row on screen, with ▲ ▼ rows instead of a bar", () => {
		const many = Array.from({ length: 30 }, (_, i) => run({ id: `r${i}`, startedAt: 1_700_000_000_000 + i }));
		const { list, lines } = listSetup(many, { width: 100, rows: 14 });
		expect(lines().join("\n")).toContain("▼");
		for (let i = 0; i < 20; i++) list.handleInput(KEY.down);
		const text = lines().join("\n");
		expect(text).toContain("▲");
		expect(text).toContain("❯");
	});
});
