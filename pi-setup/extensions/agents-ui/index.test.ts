import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { initTheme } from "@mariozechner/pi-coding-agent";
import { AGENT_CONTROL_CHANNEL, AGENT_RUNS_CHANNEL, type RunSnapshot } from "../tools/lib/agent-channel";
import agentsUi from "./index";
import { finished, run, strip, theme } from "./test-helpers";

const inheritedTools = process.env.PI_SUBAGENT_TOOLS;
beforeAll(() => {
	initTheme("dark");
	delete process.env.PI_SUBAGENT_TOOLS;
});
afterAll(() => {
	if (inheritedTools !== undefined) process.env.PI_SUBAGENT_TOOLS = inheritedTools;
});

const DOWN = "\u001b[B";
const ESC = "\u001b";
const CTRL_X = "\u0018";

class Bus {
	private handlers = new Map<string, Set<(data: unknown) => void>>();
	on(channel: string, handler: (data: unknown) => void) {
		(this.handlers.get(channel) ?? this.handlers.set(channel, new Set()).get(channel)!).add(handler);
		return () => this.handlers.get(channel)!.delete(handler);
	}
	emit(channel: string, data: unknown) {
		for (const handler of [...(this.handlers.get(channel) ?? [])]) handler(data);
	}
	count(channel: string) {
		return this.handlers.get(channel)?.size ?? 0;
	}
}

function harness(options: { editorText?: string; overlay?: boolean } = {}) {
	const bus = new Bus();
	const events = { control: [] as unknown[] };
	bus.on(AGENT_CONTROL_CHANNEL, (request) => events.control.push(request));
	const sessionHandlers = new Map<string, (event: unknown, ctx: unknown) => void>();
	const commands = new Map<string, (args: string, ctx: unknown) => unknown>();
	const shortcuts = new Map<string, (ctx: unknown) => unknown>();
	const editor = { text: options.editorText ?? "", getText() { return this.text; }, render: () => [] as string[], invalidate() {}, focused: false };
	let focused: any = editor;
	const state = { renders: 0, overlay: options.overlay ?? false, customCalls: [] as any[], widgetSet: [] as unknown[], status: [] as unknown[], notices: [] as string[], inputListeners: new Set<(data: string) => unknown>() };
	const tui: any = {
		terminal: { rows: 24, columns: 100 },
		requestRender: () => state.renders++,
		hasOverlay: () => state.overlay,
		getFocusedComponent: () => focused,
		setFocus: (component: any) => {
			if (focused && "focused" in focused) focused.focused = false;
			focused = component;
			if (focused && "focused" in focused) focused.focused = true;
		},
	};
	let dock: any;
	const ctx: any = {
		mode: "tui",
		hasUI: true,
		isIdle: () => true,
		ui: {
			theme,
			onTerminalInput: (handler: (data: string) => unknown) => {
				state.inputListeners.add(handler);
				return () => state.inputListeners.delete(handler);
			},
			setWidget: (key: string, factory: any) => {
				state.widgetSet.push([key, typeof factory]);
				dock = factory ? factory(tui, theme) : undefined;
			},
			setStatus: (key: string, text: string | undefined) => state.status.push([key, text]),
			notify: (text: string) => state.notices.push(text),
			custom: async (build: any, opts: any) => {
				let resolve!: (value: unknown) => void;
				const result = new Promise((r) => (resolve = r));
				const component = build(tui, theme, {}, resolve);
				state.customCalls.push({ component, opts, resolve });
				return result;
			},
		},
	};
	const pi: any = {
		events: bus,
		on: (name: string, handler: (event: unknown, ctx: unknown) => void) => sessionHandlers.set(name, handler),
		registerCommand: (name: string, def: { handler: (args: string, ctx: unknown) => unknown }) => commands.set(name, def.handler),
		registerShortcut: (key: string, def: { handler: (ctx: unknown) => unknown }) => shortcuts.set(key, def.handler),
	};
	agentsUi(pi);
	const start = () => sessionHandlers.get("session_start")!({ reason: "startup" }, ctx);
	const stop = () => sessionHandlers.get("session_shutdown")!({ reason: "quit" }, ctx);
	const key = (data: string) => {
		for (const listener of state.inputListeners) {
			const result = listener(data) as { consume?: boolean } | undefined;
			if (result?.consume) return true;
		}
		focused?.handleInput?.(data);
		return false;
	};
	const broadcast = (runs: RunSnapshot[]) => bus.emit(AGENT_RUNS_CHANNEL, runs);
	return { bus, events, state, tui, editor, commands, shortcuts, start, stop, key, broadcast, ctx, dock: () => dock, focused: () => focused };
}

const live: Array<() => void> = [];
afterEach(() => {
	while (live.length) live.pop()!();
	delete process.env.PI_SUBAGENT_TOOLS;
});

function started(options?: Parameters<typeof harness>[0]) {
	const h = harness(options);
	h.start();
	live.push(h.stop);
	return h;
}

describe("mounting", () => {
	test("a TUI session mounts the dock above the editor and listens to the broadcast", () => {
		const h = started();
		expect(h.state.widgetSet).toEqual([["agents-dock", "function"]]);
		expect(h.dock().render(80)).toEqual([]);
		h.broadcast([run()]);
		expect(h.dock().render(80).map(strip)[0]).toContain("1 working");
		expect(h.commands.has("agents")).toBe(true);
		expect(h.shortcuts.has("ctrl+shift+a")).toBe(true);
	});

	test("a sub-agent, or any non-TUI mode, mounts nothing", () => {
		process.env.PI_SUBAGENT_TOOLS = "read,grep";
		const child = harness();
		child.start();
		expect(child.state.widgetSet).toEqual([]);
		expect(child.state.inputListeners.size).toBe(0);
		delete process.env.PI_SUBAGENT_TOOLS;
		const rpc = harness();
		rpc.ctx.mode = "rpc";
		rpc.start();
		expect(rpc.state.widgetSet).toEqual([]);
	});

	test("shutdown removes the widget, the listeners and every timer", async () => {
		const h = harness();
		h.start();
		h.broadcast([run()]);
		expect(h.bus.count(AGENT_RUNS_CHANNEL)).toBe(1);
		h.stop();
		expect(h.state.widgetSet.at(-1)).toEqual(["agents-dock", "undefined"]);
		expect(h.bus.count(AGENT_RUNS_CHANNEL)).toBe(0);
		expect(h.state.inputListeners.size).toBe(0);
		const renders = h.state.renders;
		await Bun.sleep(700);
		expect(h.state.renders).toBe(renders);
	});
});

describe("animation", () => {
	test("ticks only while a background agent runs, and an idle dock costs no frames", async () => {
		const h = started();
		h.broadcast([run({ id: "a" })]);
		const before = h.state.renders;
		await Bun.sleep(700);
		expect(h.state.renders - before).toBeGreaterThanOrEqual(2);
		h.broadcast([finished({ id: "a", endedAt: Date.now() })]);
		await Bun.sleep(300);
		const settled = h.state.renders;
		await Bun.sleep(700);
		expect(h.state.renders).toBe(settled);
	});

	test("a blocking run animates nothing", async () => {
		const h = started();
		h.broadcast([run({ background: false })]);
		const before = h.state.renders;
		await Bun.sleep(600);
		expect(h.state.renders).toBe(before);
	});
});

describe("↓ on the editor", () => {
	test("with an empty editor it focuses the dock and keeps the key from the editor", () => {
		const h = started();
		h.broadcast([run({ id: "a" })]);
		expect(h.key(DOWN)).toBe(true);
		expect(h.focused()).toBe(h.dock());
		expect(h.dock().focused).toBe(true);
	});

	test("with text in the editor (or a history entry) ↓ stays the editor's", () => {
		const h = started({ editorText: "an earlier prompt" });
		h.broadcast([run({ id: "a" })]);
		expect(h.key(DOWN)).toBe(false);
		expect(h.focused()).toBe(h.editor);
	});

	test("nothing happens with no dock, with an overlay open, or when something else has focus", () => {
		const h = started();
		expect(h.key(DOWN)).toBe(false);
		h.broadcast([run({ id: "a" })]);
		h.state.overlay = true;
		expect(h.key(DOWN)).toBe(false);
		h.state.overlay = false;
		h.tui.setFocus({ render: () => [], invalidate() {}, handleInput() {} });
		expect(h.key(DOWN)).toBe(false);
	});

	test("esc gives the focus back to the editor", () => {
		const h = started();
		h.broadcast([run({ id: "a" })]);
		h.key(DOWN);
		h.key(ESC);
		expect(h.focused()).toBe(h.editor);
		expect(h.dock().focused).toBe(false);
	});

	test("when the work is over and only the sentence is left, ↓ opens the list instead", async () => {
		const h = started();
		h.broadcast([run({ id: "a" })]);
		h.broadcast([finished({ id: "a", endedAt: Date.now() })]);
		expect(h.dock().render(80).map(strip)).toEqual([" ✓ chad finished  ↓ to review"]);
		expect(h.key(DOWN)).toBe(true);
		expect(h.state.customCalls).toHaveLength(1);
		expect(h.state.customCalls[0].opts).toMatchObject({ overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left" } });
		h.state.customCalls[0].resolve({ closed: true });
	});
});

describe("acting from the dock", () => {
	test("s sends a steer on the control channel, x a stop, c a continue", () => {
		const h = started();
		h.broadcast([run({ id: "a" }), finished({ id: "b", endedAt: Date.now() })]);
		h.key(DOWN);
		h.key("s");
		for (const ch of "look at tests") h.key(ch);
		h.key("\r");
		h.key("x");
		h.key(DOWN);
		h.key("c");
		for (const ch of "more") h.key(ch);
		h.key("\r");
		expect(h.events.control).toEqual([
			{ action: "steer", id: "a", text: "look at tests" },
			{ action: "stop", id: "a" },
			{ action: "continue", id: "b", text: "more" },
		]);
	});

	test("closing a view after the work ended hands the focus back to the editor", async () => {
		const h = started();
		h.broadcast([run({ id: "a" })]);
		h.key(DOWN);
		h.key("\r");
		await Bun.sleep(0);
		h.broadcast([finished({ id: "a", endedAt: Date.now() })]);
		h.state.customCalls[0].component.handleInput(ESC);
		await Bun.sleep(0);
		expect(h.focused()).toBe(h.editor);
	});

	test("enter opens the agent's view as a full-screen overlay, and closing it returns to the dock", async () => {
		const h = started();
		h.broadcast([run({ id: "a", label: "audit it" })]);
		h.key(DOWN);
		h.key("\r");
		await Bun.sleep(0);
		expect(h.state.customCalls).toHaveLength(1);
		const view = h.state.customCalls[0].component;
		expect(view.render(80).map(strip)[1]).toContain("audit it");
		expect(view.render(80)).toHaveLength(24);
		view.handleInput(ESC);
		await Bun.sleep(0);
		expect(h.dock().focused).toBe(true);
		h.key("\r");
		await Bun.sleep(0);
		expect(h.state.customCalls).toHaveLength(2);
		h.state.customCalls[1].resolve("closed");
	});
});

describe("stop all", () => {
	test("X in the dock asks first, then sends stopAll; ctrl+x stays pi's copy key", () => {
		const h = started();
		h.broadcast([run({ id: "a" }), run({ id: "b" })]);
		expect(h.key(CTRL_X)).toBe(false);
		h.key(DOWN);
		h.key("X");
		expect(h.dock().render(140).map(strip)[0]).toContain("Press X again to stop all 2 running agents");
		expect(h.events.control).toEqual([]);
		h.key("X");
		expect(h.events.control).toEqual([{ action: "stopAll" }]);
	});
});

describe("/agents", () => {
	function withThree() {
		const h = started();
		h.broadcast([run({ id: "chad-aaa1", label: "first" }), run({ id: "chad-aaa2", label: "second" }), run({ id: "oracle-bbb", agent: "oracle", label: "third" })]);
		return h;
	}

	test("with no argument opens the list; with an id or a unique prefix, that agent's view", async () => {
		const h = withThree();
		const open = h.commands.get("agents")!;
		void open("", h.ctx);
		await Bun.sleep(0);
		expect(strip(h.state.customCalls[0].component.render(100)[1]!)).toContain("agents");
		h.state.customCalls[0].resolve({ closed: true });
		await Bun.sleep(0);
		void open("oracle-b", h.ctx);
		await Bun.sleep(0);
		expect(strip(h.state.customCalls[1].component.render(100)[1]!)).toContain("third");
		h.state.customCalls[1].resolve("closed");
	});

	test("an unknown or ambiguous id says so and opens nothing", async () => {
		const h = withThree();
		const open = h.commands.get("agents")!;
		await open("nothing", h.ctx);
		await open("chad-aaa", h.ctx);
		expect(h.state.notices).toEqual(['No agent matches "nothing".', '"chad-aaa" matches 2 agents; give more of the id.']);
		expect(h.state.customCalls).toHaveLength(0);
	});

	test("the shortcut opens the list", async () => {
		const h = withThree();
		void h.shortcuts.get("ctrl+shift+a")!(h.ctx);
		await Bun.sleep(0);
		expect(h.state.customCalls).toHaveLength(1);
		h.state.customCalls[0].resolve({ closed: true });
	});
});
