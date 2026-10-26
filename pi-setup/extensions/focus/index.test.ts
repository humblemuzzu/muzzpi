import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme } from "@mariozechner/pi-coding-agent";
import { GOAL_CONTINUATION_PREFIX } from "../tools/lib/injected-prompts";
import focus from "./index";
import { DEFAULT_SETTINGS, readSettings, writeSettings } from "./settings";
import { session, strip, theme } from "./test-helpers";

const ESC = "\u001b";
const ENTER = "\r";
const UP = "\u001b[A";
const RIGHT = "\u001b[C";
const DOWN = "\u001b[B";
const LEFT = "\u001b[D";
const CTRL_SHIFT_H = "\u001b[104;6u";
const CTRL_SHIFT_L = "\u001b[108;6u";
const CTRL_T = "\u0014";
const CTRL_G = "\u0007";
const CTRL_R = "\u0012";
const VIEWPORT = Symbol.for("@earendil-works/pi-tui/viewport");

const startDir = process.env.PI_CODING_AGENT_DIR;
const agentDir = mkdtempSync(join(tmpdir(), "focus-ext-"));
beforeAll(() => {
	initTheme("dark");
	process.env.PI_CODING_AGENT_DIR = agentDir;
});
afterAll(() => {
	if (startDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = startDir;
	rmSync(agentDir, { recursive: true, force: true });
});
beforeEach(() => writeSettings(DEFAULT_SETTINGS));

function harness(options: { fullscreen?: boolean } = {}) {
	const s = session();
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => void>>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const shortcuts = new Map<string, (ctx: unknown) => void>();
	const calls = { sent: [] as unknown[][], labels: [] as unknown[][], navigations: [] as unknown[][], notices: [] as string[], focusGrabs: 0, renders: 0 };
	const screens: Array<{ component: any; overlay: boolean; closed: boolean; resolve: (value: unknown) => void }> = [];
	const widgets = new Map<string, any>();
	const editor = {
		text: "",
		typed: [] as string[],
		focused: true,
		handleInput(data: string) {
			this.typed.push(data);
		},
		getText() {
			return this.text;
		},
		render: () => [] as string[],
		invalidate() {},
	};
	let focusedComponent: unknown = editor;
	let overlayFocused = false;
	let idle = true;
	let expanded = false;
	const tui: any = {
		terminal: { rows: 40, columns: 100 },
		requestRender: () => calls.renders++,
		getFocusedComponent: () => focusedComponent,
		...(options.fullscreen === false ? {} : { [VIEWPORT]: true, getPrimaryScrollView: () => ({ viewportHeight: 30 }) }),
	};
	const ctx: any = {
		mode: "tui",
		hasUI: true,
		isIdle: () => idle,
		sessionManager: s.manager,
		navigateTree: async (id: string, navigation: unknown) => {
			calls.navigations.push([id, navigation]);
			return { cancelled: false };
		},
		ui: {
			theme,
			custom: (build: any, opts?: { overlay?: boolean; onHandle?: (handle: unknown) => void }) =>
				new Promise((resolve) => {
					const screen = {
						component: undefined as any,
						overlay: opts?.overlay === true,
						closed: false,
						resolve: (value: unknown) => {
							screen.closed = true;
							if (focusedComponent === screen.component) {
								focusedComponent = editor;
								overlayFocused = false;
							}
							resolve(value);
						},
					};
					screen.component = build(tui, theme, {}, screen.resolve);
					if (screen.overlay) {
						overlayFocused = true;
						focusedComponent = screen.component;
						screen.component.focused = true;
						opts?.onHandle?.({
							isFocused: () => overlayFocused,
							focus: () => {
								calls.focusGrabs++;
								overlayFocused = true;
								focusedComponent = screen.component;
							},
						});
					}
					screens.push(screen);
				}),
			setWidget: (key: string, factory: any) => (factory ? widgets.set(key, factory(tui, theme)) : widgets.delete(key)),
			notify: (text: string) => calls.notices.push(text),
			getEditorText: () => editor.text,
			setEditorText: (text: string) => (editor.text = text),
			getToolsExpanded: () => expanded,
		},
	};
	const pi: any = {
		events: { on: () => () => {}, emit() {} },
		on: (name: string, handler: (event: unknown, ctx: unknown) => void) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		registerCommand: (name: string, def: any) => commands.set(name, def),
		registerShortcut: (key: string, def: any) => shortcuts.set(key, def.handler),
		sendUserMessage: (...args: unknown[]) => calls.sent.push(args),
		setLabel: (id: string, label: string | undefined) => {
			calls.labels.push([id, label]);
			s.manager.appendLabelChange(id, label);
		},
	};
	focus(pi);
	const fire = (name: string, event: unknown = {}) => (handlers.get(name) ?? []).forEach((handler) => handler(event, ctx));
	const overlay = () => screens.findLast((screen) => screen.overlay && !screen.closed);
	const keys = (...data: string[]) => data.forEach((key) => overlay()!.component.handleInput(key));
	return {
		s,
		ctx,
		calls,
		screens,
		widgets,
		editor,
		commands,
		fire,
		overlay,
		keys,
		start: () => fire("session_start", { reason: "startup" }),
		toggle: () => shortcuts.get("ctrl+shift+h")!(ctx),
		run: (args: string) => commands.get("focus")!.handler(args, ctx),
		screenText: () => overlay()!.component.render(100).map(strip).join("\n"),
		setIdle: (value: boolean) => (idle = value),
		expand: (value: boolean) => (expanded = value),
		loseFocusTo: (component: unknown) => {
			overlayFocused = false;
			focusedComponent = component;
		},
	};
}

describe("opening and closing", () => {
	test("a sub-agent gets nothing", () => {
		process.env.PI_SUBAGENT_TOOLS = "read";
		try {
			expect(harness().commands.size).toBe(0);
		} finally {
			delete process.env.PI_SUBAGENT_TOOLS;
		}
	});

	test("off by default; ctrl+shift+h opens it over the chat area and closes it again", () => {
		const h = harness();
		h.start();
		expect(h.overlay()).toBeUndefined();
		h.toggle();
		expect(h.overlay()).toBeDefined();
		expect(h.overlay()!.component.render(100)).toHaveLength(30);
		h.keys(CTRL_SHIFT_H);
		expect(h.overlay()).toBeUndefined();
		h.toggle();
		h.toggle();
		expect(h.overlay()).toBeUndefined();
	});

	test("outside fullscreen mode it says why and does not open", async () => {
		const h = harness({ fullscreen: false });
		h.start();
		h.toggle();
		await Promise.resolve();
		expect(h.overlay()).toBeUndefined();
		expect(h.calls.notices[0]).toContain("fullscreen");
	});

	test("/focus on starts every session in it; /focus off stops that and closes it", async () => {
		const h = harness();
		h.start();
		await h.run("on");
		expect(readSettings().startInFocus).toBe(true);
		expect(h.overlay()).toBeDefined();
		const next = harness();
		next.start();
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(next.overlay()).toBeDefined();
		await next.run("off");
		expect(readSettings().startInFocus).toBe(false);
		expect(next.overlay()).toBeUndefined();
	});

	test("/focus alone is a menu whose settings save as you change them", async () => {
		const h = harness();
		h.start();
		void h.run("");
		const menu = h.screens.at(-1)!;
		expect(menu.overlay).toBe(false);
		expect(menu.component.render(100).map(strip).join("\n")).toContain("Start every session in focus mode");
		menu.component.handleInput(DOWN);
		menu.component.handleInput(RIGHT);
		menu.component.handleInput(ESC);
		expect(readSettings().startInFocus).toBe(true);
	});

	test("an unknown word is an error that names the right ones", async () => {
		const h = harness();
		h.start();
		await h.run("sideways");
		expect(h.calls.notices[0]).toContain('/focus has no "sideways"');
	});
});

describe("pi's editor stays in charge of typing", () => {
	test("keys focus mode does not use reach pi's editor, which keeps its cursor", () => {
		const h = harness();
		h.start();
		h.editor.focused = false;
		h.toggle();
		expect(h.editor.focused).toBe(true);
		h.keys("h", "i", ENTER, ESC);
		expect(h.editor.typed).toEqual(["h", "i", ENTER, ESC]);
	});

	test("when the keyboard went back to pi's editor, focus mode takes it again; never from a dialog", async () => {
		const h = harness();
		h.start();
		h.toggle();
		h.loseFocusTo(h.editor);
		h.overlay()!.component.render(100);
		await Promise.resolve();
		expect(h.calls.focusGrabs).toBe(1);
		h.loseFocusTo({ dialog: true });
		h.overlay()!.component.render(101);
		await Promise.resolve();
		expect(h.calls.focusGrabs).toBe(1);
	});

	test("process output is full when pi's tool output is expanded", () => {
		const h = harness();
		h.s.prompt("read");
		h.s.call("t1");
		h.s.result("t1", Array.from({ length: 20 }, (_, i) => `out ${i}`).join("\n"));
		h.s.reply("done");
		h.start();
		h.toggle();
		h.keys("\t");
		expect(h.screenText()).not.toContain("out 19");
		h.expand(true);
		expect(h.screenText()).toContain("out 19");
	});
});

describe("acting on a prompt from the list", () => {
	function opened() {
		const h = harness();
		h.s.prompt("earlier");
		h.s.reply("done");
		h.s.prompt("now");
		h.s.reply("ok");
		h.start();
		h.toggle();
		h.keys(CTRL_SHIFT_L, UP);
		return h;
	}

	test("ctrl+t marks it with a /tree label and unmarks it", () => {
		const h = opened();
		const prompt = h.s.manager.getEntries()[0]!.id;
		h.keys(CTRL_T);
		h.keys(CTRL_T);
		expect(h.calls.labels).toEqual([
			[prompt, "★"],
			[prompt, undefined],
		]);
	});

	test("ctrl+r puts it in pi's prompt, but never over text already there", () => {
		const h = opened();
		h.editor.text = "my draft";
		h.keys(CTRL_R);
		expect(h.editor.text).toBe("my draft");
		h.editor.text = "";
		h.keys(CTRL_SHIFT_L, UP, CTRL_R);
		expect(h.editor.text).toBe("earlier");
	});

	test("ctrl+g moves the session to the end of it through /focus goto", async () => {
		const h = opened();
		const last = h.s.manager.getEntries()[1]!.id;
		h.keys(CTRL_G);
		expect(h.calls.sent.at(-1)).toEqual([`/focus goto ${last}`, { expandPromptTemplates: true }]);
		await h.run(`goto ${last}`);
		expect(h.calls.navigations).toEqual([[last, { summarize: false }]]);
	});

	test("ctrl+g refuses a prompt that never got a reply instead of rewinding to before it", () => {
		const h = harness();
		h.s.prompt("unanswered");
		h.s.prompt("answered");
		h.s.reply("yes");
		h.start();
		h.toggle();
		h.keys(CTRL_SHIFT_L, UP, CTRL_G);
		expect(h.calls.sent).toEqual([]);
		expect(h.screenText()).toContain("never got a reply");
	});
});

describe("the pinned prompt", () => {
	test("is off unless you turn it on", () => {
		const h = harness();
		h.s.prompt("make it fast");
		h.start();
		h.fire("agent_start");
		expect(h.widgets.has("focus-pin")).toBe(false);
	});

	test("while working it shows your last prompt, never one goal sent", async () => {
		const h = harness();
		h.s.prompt("make it fast");
		h.start();
		await h.run("pin working");
		h.fire("agent_start");
		expect(strip(h.widgets.get("focus-pin").render(60)[0])).toBe("▸ make it fast");
		h.fire("message_start", { message: { role: "user", content: [{ type: "text", text: `${GOAL_CONTINUATION_PREFIX}g">` }] } });
		expect(strip(h.widgets.get("focus-pin").render(60)[0])).toBe("▸ make it fast");
		h.fire("agent_end");
		expect(h.widgets.has("focus-pin")).toBe(false);
	});
});

describe("session life", () => {
	test("the spinner timer runs only while focus mode is open and the agent works, and dies with the session", () => {
		const realSet = globalThis.setInterval;
		const realClear = globalThis.clearInterval;
		const live = new Set<unknown>();
		globalThis.setInterval = ((fn: () => void, ms: number) => {
			const timer = realSet(fn, ms);
			live.add(timer);
			return timer;
		}) as typeof setInterval;
		globalThis.clearInterval = ((timer: ReturnType<typeof setInterval>) => {
			live.delete(timer);
			realClear(timer);
		}) as typeof clearInterval;
		try {
			const h = harness();
			h.start();
			h.fire("agent_start");
			expect(live.size).toBe(0);
			h.toggle();
			expect(live.size).toBe(1);
			h.keys(CTRL_SHIFT_H);
			expect(live.size).toBe(0);
			h.toggle();
			h.fire("session_shutdown");
			expect(live.size).toBe(0);
			expect(h.overlay()).toBeUndefined();
		} finally {
			globalThis.setInterval = realSet;
			globalThis.clearInterval = realClear;
		}
	});

	test("an entry pi saves after its events still shows, because a new leaf refreshes the index", () => {
		const h = harness();
		h.s.prompt("question");
		h.start();
		h.toggle();
		expect(h.screenText()).toContain("No reply to this prompt");
		h.s.reply("saved late");
		expect(h.screenText()).toContain("saved late");
	});

	test("the turn the agent is on streams its reply in", () => {
		const h = harness();
		h.s.prompt("write the docs");
		h.start();
		h.toggle();
		h.fire("agent_start");
		h.fire("message_update", { message: { role: "assistant", content: [{ type: "text", text: "Drafting the README" }] } });
		expect(h.screenText()).toContain("Drafting the README");
		h.fire("agent_end");
		h.fire("session_shutdown");
	});

	test("arrows walk the prompts only while pi's prompt is empty", () => {
		const h = harness();
		h.s.prompt("first");
		h.s.prompt("second");
		h.start();
		h.toggle();
		h.keys(LEFT);
		expect(h.screenText()).toContain("prompt 1 of 2");
		h.editor.text = "typing";
		h.keys(RIGHT);
		expect(h.screenText()).toContain("prompt 1 of 2");
		expect(h.editor.typed).toEqual([RIGHT]);
	});
});
