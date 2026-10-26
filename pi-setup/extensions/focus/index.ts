/**
 * focus: focus mode (`/focus`, ctrl+shift+h) covers pi's chat area with the
 * session as your prompts and the agent's answers, every one of them across
 * compactions and /tree branches, while pi's own editor and footer stay below
 * it. Also the optional one-line reminder of your last prompt above the editor.
 *
 * Parent only, fullscreen only. It reads the session pi already holds, indexes
 * it only while the screen is open, and sends nothing to the model.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, type Component, type OverlayHandle, type TUI } from "@mariozechner/pi-tui";
import type { Styler } from "../tools/lib/agent-layout";
import { oneLine } from "../tools/lib/choice-dialog";
import { completeWords, findWord, splitArgs, unknownWord, type Word } from "../tools/lib/command-args";
import { canShowMenu, menuAsText, showMenu, type MenuSpec } from "../tools/lib/command-menu";
import { contributeHelp } from "../tools/lib/help-channel";
import { injectedKind } from "../tools/lib/injected-prompts";
import { SUB_AGENT_TOOLS_ENV } from "../tools/lib/sub-agent-prompt";
import { MARK_LABEL, messageText, SessionIndex, type SessionView, type Turn } from "./session-view";
import { readSettings, writeSettings, type FocusSettings, type PinMode } from "./settings";
import { FocusView, type FocusHost, type FocusMemory, type LiveState, type PiEditor } from "./view";
import { chatRows } from "./viewport";

const SHORTCUT = "ctrl+shift+h";
const PIN_WIDGET = "focus-pin";
const TICK_MS = 250;
const OVERLAY = { anchor: "top-left", row: 0, col: 0, width: "100%", maxHeight: "100%" } as const;
const EMPTY_VIEW: SessionView = { turns: [], marks: [], compactions: 0, active: undefined };

const PIN_MODES: readonly PinMode[] = ["working", "always", "off"];
const PIN_LABELS: Record<PinMode, string> = { working: "while the agent works", always: "always", off: "off" };
const INSIDE = "inside my prompt";
const ALONE = "as prompts of their own";

const WORDS: Word[] = [
	{ name: "open", description: "open focus mode now" },
	{ name: "close", description: "back to pi's chat" },
	{ name: "on", description: "start every session in focus mode, and open it now" },
	{ name: "off", description: "start sessions in pi's normal view again" },
	{ name: "pin", description: "when your last prompt shows above the editor", next: () => PIN_MODES.map((mode) => ({ value: mode, description: PIN_LABELS[mode] })) },
];

const USAGE = ["/focus open | close", "/focus on | off   start every session in it, or not", "/focus pin working | always | off"];

type FocusAwareTui = TUI & { getFocusedComponent(): Component | null };

class PinLine implements Component {
	private cache: { width: number; lines: string[] } | undefined;

	constructor(
		private readonly text: string,
		private readonly theme: Styler,
	) {}

	render(width: number): string[] {
		if (this.cache?.width !== width) {
			this.cache = { width, lines: [truncateToWidth(`${this.theme.fg("accent", "▸ ")}${this.theme.fg("muted", oneLine(this.text))}`, width)] };
		}
		return this.cache.lines;
	}

	invalidate(): void {
		this.cache = undefined;
	}
}

function lastTypedPrompt(ctx: ExtensionContext): string {
	const branch = ctx.sessionManager.getBranch();
	for (let at = branch.length - 1; at >= 0; at--) {
		const entry = branch[at]!;
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const text = messageText(entry.message);
		if (!injectedKind(text)) return text;
	}
	return "";
}

type EditorComponent = Component & PiEditor;

function asPiEditor(component: Component | null): EditorComponent | undefined {
	const candidate = component as Partial<PiEditor> | null;
	return typeof candidate?.getText === "function" && typeof candidate.handleInput === "function" ? (component as EditorComponent) : undefined;
}

export default function focus(pi: ExtensionAPI): void {
	if (process.env[SUB_AGENT_TOOLS_ENV]) return;

	let settings = readSettings();
	let ctx: ExtensionContext | undefined;
	let tui: FocusAwareTui | undefined;
	let view: FocusView | undefined;
	let handle: OverlayHandle | undefined;
	let editor: EditorComponent | undefined;
	let closeView: (() => void) | undefined;
	let memory: FocusMemory | undefined;
	let ticker: ReturnType<typeof setInterval> | undefined;
	let startTimer: ReturnType<typeof setTimeout> | undefined;
	let index = new SessionIndex();
	let snap: { view: SessionView; version: number; leaf: string | null } | undefined;
	let indexVersion = 0;
	let dirty = true;
	let lastPrompt = "";
	let pinned: string | undefined;
	const live: LiveState = { running: false, startedAt: 0, message: undefined, compacting: false, frame: 0, version: 0 };

	const mounted = (current: ExtensionContext) => current.mode === "tui" && current.hasUI;
	const repaint = () => {
		if (closeView) tui?.requestRender();
	};
	const liveChanged = () => {
		live.version++;
		repaint();
	};
	const sessionChanged = () => {
		dirty = true;
		repaint();
	};

	// Every append moves the leaf, so a new leaf also means stale: pi saves a message only after its message_end handlers.
	const snapshot = (): { view: SessionView; version: number } => {
		const manager = ctx?.sessionManager;
		const leaf = manager?.getLeafId() ?? null;
		if (!snap || dirty || snap.leaf !== leaf) {
			const built = manager ? index.update(manager.getEntries(), leaf, !settings.showInjected) : EMPTY_VIEW;
			snap = !snap || built !== snap.view ? { view: built, version: ++indexVersion, leaf } : { ...snap, leaf };
			dirty = false;
		}
		return snap;
	};

	const syncTicker = () => {
		const wanted = closeView !== undefined && live.running;
		if (wanted && !ticker) {
			ticker = setInterval(() => {
				try {
					live.frame++;
					tui?.requestRender();
				} catch {}
			}, TICK_MS);
		} else if (!wanted && ticker) {
			clearInterval(ticker);
			ticker = undefined;
		}
	};

	const syncPin = () => {
		if (!ctx || !mounted(ctx)) return;
		const show = lastPrompt !== "" && (settings.pin === "always" || (settings.pin === "working" && live.running));
		const text = show ? lastPrompt : undefined;
		if (text === pinned) return;
		pinned = text;
		ctx.ui.setWidget(PIN_WIDGET, text === undefined ? undefined : (_tui, theme) => new PinLine(text, theme));
	};

	const close = () => closeView?.();

	const host: FocusHost = {
		snapshot,
		live: () => live,
		now: () => Date.now(),
		chatRows: () => (tui ? (chatRows(tui) ?? 0) : 0),
		toolsExpanded: () => ctx?.ui.getToolsExpanded() ?? false,
		editor: () => editor,
		afterRender(rows) {
			if (!tui || !closeView) return;
			if ((chatRows(tui) ?? 0) !== rows) tui.requestRender();
			if (handle && !handle.isFocused() && editor && tui.getFocusedComponent() === editor) handle.focus();
		},
		mark(turn: Turn) {
			if (turn.label && turn.label !== MARK_LABEL) return `it already has the /tree label "${oneLine(turn.label)}"; change that one in /tree`;
			pi.setLabel(turn.id, turn.label ? undefined : MARK_LABEL);
			sessionChanged();
			return turn.label ? "unmarked" : `marked ${MARK_LABEL}: it is under Marks and in /tree`;
		},
		goto(turn: Turn) {
			if (live.running) return "the agent is working: wait for it, or esc to stop it, then ctrl+g";
			if (ctx?.sessionManager.getLeafId() === turn.lastId) return "the session is already at the end of this prompt";
			const last = ctx?.sessionManager.getEntry(turn.lastId);
			if (last?.type === "message" && last.message.role === "user") return "this prompt never got a reply, so there is no end of it to move to";
			pi.sendUserMessage(`/focus goto ${turn.lastId}`, { expandPromptTemplates: true });
			return "moving the session to the end of that prompt…";
		},
		reuse(turn: Turn) {
			if (!ctx) return "";
			if (ctx.ui.getEditorText().trim()) return "pi's prompt already has text in it: clear it, then ctrl+r again";
			ctx.ui.setEditorText(turn.prompt);
			return "that prompt is in pi's prompt below: edit it, then enter sends it";
		},
		close,
	};

	const open = (current: ExtensionContext): void => {
		ctx = current;
		if (!mounted(current)) {
			if (current.hasUI) current.ui.notify("Focus mode needs the interactive TUI.", "info");
			return;
		}
		if (closeView) return;
		dirty = true;
		current.ui
			.custom<void>(
				(t, theme, _keybindings, done) => {
					const focusable = t as FocusAwareTui;
					const target = asPiEditor(focusable.getFocusedComponent());
					const refusal = chatRows(t) === undefined ? "Focus mode needs pi's fullscreen mode (`tuiMode: \"fullscreen\"` in settings.json)." : !target ? "Focus mode opens from pi's prompt: close the dialog that is open first." : undefined;
					if (refusal) {
						queueMicrotask(() => done());
						current.ui.notify(refusal, "warning");
						return { render: () => [], invalidate() {} };
					}
					tui = focusable;
					editor = target;
					const screen = new FocusView(theme, host, memory);
					view = screen;
					closeView = () => {
						memory = screen.memory();
						closeView = undefined;
						view = undefined;
						handle = undefined;
						syncTicker();
						done();
					};
					syncTicker();
					return screen;
				},
				{ overlay: true, overlayOptions: OVERLAY, onHandle: (opened) => (handle = opened) },
			)
			.catch((error: unknown) => {
				closeView = undefined;
				view = undefined;
				handle = undefined;
				syncTicker();
				current.ui.notify(`Focus mode could not open: ${error instanceof Error ? error.message : String(error)}`, "error");
			});
	};

	const save = (current: ExtensionContext, update: Partial<FocusSettings>): void => {
		settings = { ...settings, ...update };
		try {
			writeSettings(settings);
		} catch (error) {
			current.ui.notify(`Could not save that for next time: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
		sessionChanged();
		syncPin();
	};

	const menuSpec = (current: ExtensionContext): MenuSpec => ({
		title: "Focus mode",
		status: [
			"The chat area shows your prompts and the agent's answers, with the work one tab away; pi's prompt stays below it. Every prompt of the session is there: before each compaction and on every /tree branch.",
		],
		items: [
			closeView ? { id: "close", label: "Close focus mode", note: SHORTCUT } : { id: "open", label: "Open focus mode", note: SHORTCUT },
			{ id: "start", label: "Start every session in focus mode", values: ["off", "on"], value: settings.startInFocus ? "on" : "off" },
			{ id: "pin", label: "Pin my last prompt above the editor", values: PIN_MODES.map((mode) => PIN_LABELS[mode]), value: PIN_LABELS[settings.pin] },
			{
				id: "injected",
				label: "Prompts sent by goal and /ysk",
				values: [INSIDE, ALONE],
				value: settings.showInjected ? ALONE : INSIDE,
				description: "Kept inside the prompt you typed before them, or listed as prompts of their own.",
			},
		],
		onChange(id, value) {
			if (id === "start") save(current, { startInFocus: value === "on" });
			else if (id === "pin") save(current, { pin: PIN_MODES.find((mode) => PIN_LABELS[mode] === value) ?? settings.pin });
			else if (id === "injected") save(current, { showInjected: value === ALONE });
		},
	});

	const gotoEntry = async (id: string, current: ExtensionCommandContext): Promise<void> => {
		if (!id) return current.ui.notify("/focus goto needs the id of an entry in this session.", "error");
		const result = await current.navigateTree(id, { summarize: false });
		if (result.cancelled) current.ui.notify("The session stayed where it was.", "info");
	};

	pi.registerCommand("focus", {
		description: "Focus mode: your prompts and the agent's answers in the chat area, the whole session long",
		getArgumentCompletions: (prefix) => completeWords(WORDS, prefix),
		handler: async (args, current) => {
			ctx = current;
			const { word, rest } = splitArgs(args);
			if (word === "goto") return gotoEntry(rest, current);
			if (!word) {
				const spec = menuSpec(current);
				if (!canShowMenu(current)) return current.ui.notify(menuAsText(spec, USAGE), "info");
				const choice = await showMenu(current, spec);
				if (choice?.id === "open") open(current);
				else if (choice?.id === "close") close();
				return;
			}
			const found = findWord(WORDS, word);
			if (!found) return current.ui.notify(unknownWord("focus", word, WORDS), "error");
			if (found.name === "open") return open(current);
			if (found.name === "close") return close();
			if (found.name === "on") {
				save(current, { startInFocus: true });
				return open(current);
			}
			if (found.name === "off") {
				save(current, { startInFocus: false });
				close();
				return current.ui.notify(`Sessions start in pi's normal view again; ${SHORTCUT} or /focus open still opens focus mode.`, "info");
			}
			const mode = PIN_MODES.find((candidate) => candidate === rest.trim().toLowerCase());
			if (!mode) return current.ui.notify("Use /focus pin working, /focus pin always or /focus pin off.", "error");
			save(current, { pin: mode });
			current.ui.notify(`Your last prompt shows above the editor: ${PIN_LABELS[mode]}. Remembered across sessions.`, "info");
		},
	});

	pi.registerShortcut(SHORTCUT, { description: "Open or close focus mode", handler: (current) => (closeView ? close() : open(current)) });
	contributeHelp(pi, (help) => help.shortcut({ command: "focus", key: SHORTCUT }));

	pi.on("session_start", (_event, current) => {
		ctx = current;
		settings = readSettings();
		index = new SessionIndex();
		snap = undefined;
		dirty = true;
		memory = undefined;
		Object.assign(live, { running: false, message: undefined, compacting: false });
		pinned = undefined;
		if (!mounted(current)) return;
		lastPrompt = lastTypedPrompt(current);
		syncPin();
		// after every session_start handler has run, so pi's editor is the one in place
		if (settings.startInFocus) {
			startTimer = setTimeout(() => {
				startTimer = undefined;
				try {
					if (ctx) open(ctx);
				} catch {}
			}, 0);
		}
	});

	pi.on("session_shutdown", () => {
		close();
		if (startTimer) clearTimeout(startTimer);
		startTimer = undefined;
		if (ticker) clearInterval(ticker);
		ticker = undefined;
		try {
			if (pinned !== undefined) ctx?.ui.setWidget(PIN_WIDGET, undefined);
		} catch {}
		pinned = undefined;
		view = undefined;
		editor = undefined;
		tui = undefined;
		ctx = undefined;
	});

	pi.on("agent_start", () => {
		live.running = true;
		live.startedAt = Date.now();
		liveChanged();
		syncTicker();
		syncPin();
	});

	pi.on("agent_end", () => {
		live.running = false;
		live.message = undefined;
		dirty = true;
		liveChanged();
		syncTicker();
		syncPin();
	});

	pi.on("message_start", (event) => {
		const { message } = event;
		if (message.role === "assistant") {
			live.message = message;
			liveChanged();
		} else if (message.role === "user") {
			const text = messageText(message);
			if (!injectedKind(text)) {
				lastPrompt = text;
				syncPin();
			}
		}
	});

	pi.on("message_update", (event) => {
		if (event.message.role !== "assistant") return;
		live.message = event.message;
		liveChanged();
	});

	pi.on("message_end", (event) => {
		if (event.message.role === "assistant") live.message = undefined;
		dirty = true;
		liveChanged();
	});

	pi.on("turn_end", sessionChanged);

	pi.on("session_tree", () => {
		if (memory) memory.turnId = undefined;
		view?.followSession();
		if (ctx) lastPrompt = lastTypedPrompt(ctx);
		sessionChanged();
		syncPin();
	});

	pi.on("session_before_compact", () => {
		live.compacting = true;
		liveChanged();
	});

	const compacted = () => {
		live.compacting = false;
		dirty = true;
		liveChanged();
	};
	pi.on("session_compact", compacted);
	pi.on("session_compact_failed", compacted);
}
