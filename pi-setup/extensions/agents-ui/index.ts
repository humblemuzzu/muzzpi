/**
 * agents-ui: the background agents on screen. A dock above the editor while
 * any run, `↓` on an empty editor to manage them, a full-screen view of each
 * one's conversation, and `/agents` for the whole list. notify.ts already
 * notifies when the turn a result woke ends.
 *
 * It only reads the `muzzpi:agent-runs` broadcast and asks the tools extension
 * to act through `muzzpi:agent-runs:control`; it owns no run state and, in a
 * sub-agent, does not load at all.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { isKeyRelease, matchesKey, type Component, type TUI } from "@mariozechner/pi-tui";
import { AGENT_CONTROL_CHANNEL, AGENT_RUNS_CHANNEL, type ControlRequest, type RunSnapshot } from "../tools/lib/agent-channel";
import { withoutTyped } from "../tools/lib/command-args";
import { contributeHelp } from "../tools/lib/help-channel";
import { AgentView, type ViewActions } from "./agent-view";
import { Dock, type DockHost } from "./dock";
import { ListView, type ListResult } from "./list-view";
import type { PickerAction } from "./picker";
import { RunStore, systemClock } from "./store";

const WIDGET_KEY = "agents-dock";
const SHORTCUT = "ctrl+shift+a";
const TICK_MS = 250;
const OVERLAY = { anchor: "top-left", row: 0, col: 0, width: "100%", maxHeight: "100%" } as const;

type FocusAwareTui = TUI & { getFocusedComponent(): Component | null };

interface Editorish extends Component {
	getText(): string;
}

export default function agentsUi(pi: ExtensionAPI): void {
	const store = new RunStore();
	const clock = systemClock();
	const timers = new Set<ReturnType<typeof setTimeout>>();
	let ctx: ExtensionContext | undefined;
	let tui: FocusAwareTui | undefined;
	let dock: Dock | undefined;
	let cameFrom: Component | null = null;
	let ticker: ReturnType<typeof setInterval> | undefined;
	let viewOpen = false;
	let cleanups: Array<() => void> = [];

	const guarded = (fn: () => void) => () => {
		try {
			fn();
		} catch {}
	};

	const later = (fn: () => void, ms: number): (() => void) => {
		const timer = setTimeout(() => {
			timers.delete(timer);
			guarded(fn)();
		}, ms);
		timers.add(timer);
		return () => {
			clearTimeout(timer);
			timers.delete(timer);
		};
	};

	const control = (request: ControlRequest) => pi.events.emit(AGENT_CONTROL_CHANNEL, request);

	const actions: ViewActions = {
		steer: (id, text) => control({ action: "steer", id, text }),
		continueRun: (id, text) => control({ action: "continue", id, text }),
		stop: (id) => control({ action: "stop", id }),
	};

	const handleAction = (action: PickerAction) => {
		if (action.type === "open") void openView(action.id);
		else if (action.type === "stop") actions.stop(action.id);
		else if (action.type === "steer") actions.steer(action.id, action.text);
		else if (action.type === "continue") actions.continueRun(action.id, action.text);
		else if (action.type === "stopAll") control({ action: "stopAll" });
		else if (action.type === "close") blurDock();
	};

	const focusDock = () => {
		if (!tui || !dock || tui.getFocusedComponent() === dock) return;
		cameFrom = tui.getFocusedComponent();
		tui.setFocus(dock);
	};

	const blurDock = () => {
		if (!tui || !dock || tui.getFocusedComponent() !== dock) return;
		tui.setFocus(cameFrom);
		cameFrom = null;
	};

	const syncTicker = () => {
		const animated = store.background().some((run) => run.status === "running") || (viewOpen && store.all().some((run) => run.status === "running"));
		if (animated && !ticker) {
			ticker = setInterval(
				guarded(() => {
					clock.frame++;
					tui?.requestRender();
					syncTicker();
				}),
				TICK_MS,
			);
		} else if (!animated && ticker) {
			clearInterval(ticker);
			ticker = undefined;
			clock.frame++;
			tui?.requestRender();
		}
	};

	const editorWithNothingTyped = (): boolean => {
		const focused = tui?.getFocusedComponent() as Editorish | null | undefined;
		return typeof focused?.getText === "function" && focused.getText() === "";
	};

	const onTerminalInput = (data: string) => {
		if (!tui || tui.hasOverlay()) return undefined;
		if (!dock || isKeyRelease(data) || !matchesKey(data, "down") || dock.focused || !editorWithNothingTyped()) return undefined;
		if (dock.mode() === "hidden") return undefined;
		dock.picker.select(dock.picker.current()?.id);
		focusDock();
		return { consume: true };
	};

	async function showOverlay<T>(build: (tui: TUI, theme: ExtensionContext["ui"]["theme"], done: (result: T) => void) => Component): Promise<T | undefined> {
		if (!ctx || viewOpen) return undefined;
		viewOpen = true;
		syncTicker();
		try {
			return await ctx.ui.custom<T>((t, theme, _keys, done) => build(t, theme, done), { overlay: true, overlayOptions: OVERLAY });
		} finally {
			viewOpen = false;
			syncTicker();
			if (dock?.focused && dock.mode() !== "full") blurDock();
		}
	}

	async function openView(id: string): Promise<void> {
		await showOverlay<"closed">((t, theme, done) => new AgentView(id, store, clock, theme, actions, () => t.terminal, done));
	}

	async function openList(): Promise<void> {
		for (;;) {
			const result: ListResult | undefined = await showOverlay<ListResult>((t, theme, done) => new ListView(store, clock, theme, handleAction, () => t.terminal, done));
			if (!result || !("open" in result)) return;
			await openView(result.open);
		}
	}

	function resolveRun(query: string): RunSnapshot | string {
		const runs = store.all();
		const exact = runs.find((run) => run.id === query);
		if (exact) return exact;
		const matches = runs.filter((run) => run.id.startsWith(query) || run.agent === query);
		if (matches.length === 1) return matches[0]!;
		return matches.length === 0 ? `No agent matches "${query}".` : `"${query}" matches ${matches.length} agents; give more of the id.`;
	}

	const mounted = (current: ExtensionContext): boolean => current.mode === "tui" && !process.env.PI_SUBAGENT_TOOLS;

	pi.on("session_start", (_event, current) => {
		cleanups.forEach((fn) => fn());
		cleanups = [];
		if (!mounted(current)) return;
		ctx = current;
		cleanups.push(
			pi.events.on(AGENT_RUNS_CHANNEL, (runs) => store.ingest(runs as RunSnapshot[])),
			store.subscribe(syncTicker),
			current.ui.onTerminalInput(onTerminalInput),
		);
		const host: DockHost = {
			requestRender: () => tui?.requestRender(),
			focus: focusDock,
			blur: blurDock,
			act: handleAction,
			later,
		};
		current.ui.setWidget(WIDGET_KEY, (t, theme) => {
			tui = t as FocusAwareTui;
			dock = new Dock(store, clock, theme, host);
			return dock;
		});
	});

	pi.on("session_shutdown", () => {
		cleanups.forEach((fn) => fn());
		cleanups = [];
		for (const timer of timers) clearTimeout(timer);
		timers.clear();
		if (ticker) clearInterval(ticker);
		ticker = undefined;
		guarded(() => ctx?.ui.setWidget(WIDGET_KEY, undefined))();
		dock?.dispose();
		dock = undefined;
		tui = undefined;
		ctx = undefined;
	});

	const open = async (args: string, current: ExtensionContext) => {
		if (!mounted(current)) {
			if (current.hasUI) current.ui.notify("The agents view needs the interactive TUI.", "info");
			return;
		}
		ctx = current;
		const query = args.trim();
		if (!query) return openList();
		const found = resolveRun(query);
		if (typeof found === "string") return current.ui.notify(found, "warning");
		return openView(found.id);
	};

	pi.registerCommand("agents", {
		description: "See, steer and stop background agents; /agents chad opens one",
		getArgumentCompletions: (prefix) => {
			const typed = prefix.trim().toLowerCase();
			const items = store
				.all()
				.filter((run) => run.id.toLowerCase().startsWith(typed) || run.agent.toLowerCase().startsWith(typed))
				.map((run) => {
					const short = run.id.slice(run.id.indexOf("-") + 1).slice(0, 8);
					return { value: run.id, label: `${run.agent} ${short}`, description: `${run.status} · ${run.label}` };
				});
			return withoutTyped(items, prefix);
		},
		handler: (args, current) => open(args, current),
	});

	pi.registerShortcut(SHORTCUT, {
		description: "Open the agents list",
		handler: (current) => open("", current),
	});
	contributeHelp(pi, (help) => help.shortcut({ command: "agents", key: SHORTCUT }));
}
