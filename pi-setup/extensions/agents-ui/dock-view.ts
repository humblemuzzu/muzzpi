/**
 * `/agents dock`: how the running background agents show under the prompt.
 * Remembered across sessions; the dock follows a change at once.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { findWord, splitArgs, unknownWord, type Word } from "../tools/lib/command-args";
import { canShowMenu, menuAsText, showMenu, type MenuSpec } from "../tools/lib/command-menu";
import { prefsFile, readPrefs, writePrefs } from "../tools/lib/prefs";

export type DockView = "line" | "full" | "off";

const PREFS = "agents-dock";

const VIEWS: ReadonlyArray<Word & { name: DockView; label: string }> = [
	{ name: "line", label: "One quiet line", description: "a single dim line under the prompt while agents run; ↓ opens the list" },
	{ name: "full", label: "The whole list", description: "a quiet row per agent under the prompt; ↓ to act on them" },
	{ name: "off", aliases: ["hide"], label: "Nothing", description: "nothing on screen; /agents and ctrl+shift+a still open the list" },
];

export const DOCK_WORD: Word = {
	name: "dock",
	description: "how running agents show under the prompt: line, full or off",
	next: () => VIEWS.map((v) => ({ value: v.name, description: v.description })),
};

const USAGE = VIEWS.map((v) => `/agents dock ${v.name.padEnd(5)} ${v.description}`);

export function readDockView(file: string = prefsFile(PREFS)): DockView {
	const view = readPrefs(file).view;
	return view === "full" || view === "off" ? view : "line";
}

export function writeDockView(view: DockView, file: string = prefsFile(PREFS)): void {
	writePrefs(file, { view });
}

function menuSpec(current: DockView): MenuSpec {
	return {
		title: "Agents under the prompt",
		status: [`Now: ${VIEWS.find((v) => v.name === current)!.label.toLowerCase()}. /agents always opens the full list.`],
		items: VIEWS.map((v) => ({ id: v.name, label: v.label, note: v.name === current ? "current" : undefined, description: v.description })),
		initial: current,
	};
}

function apply(ctx: ExtensionContext, view: DockView, onChange: (view: DockView) => void): void {
	try {
		writeDockView(view);
	} catch (err) {
		ctx.ui.notify(`Could not save that: ${err instanceof Error ? err.message : String(err)}`, "error");
		return;
	}
	onChange(view);
	ctx.ui.notify(`Agents dock: ${VIEWS.find((v) => v.name === view)!.label.toLowerCase()}. Remembered across sessions.`, "info");
}

export async function runDockCommand(rest: string, ctx: ExtensionContext, onChange: (view: DockView) => void): Promise<void> {
	const current = readDockView();
	const { word } = splitArgs(rest);
	if (word) {
		const found = findWord(VIEWS, word);
		if (!found) return ctx.ui.notify(unknownWord("agents dock", word, VIEWS), "error");
		return apply(ctx, found.name, onChange);
	}
	const spec = menuSpec(current);
	if (!canShowMenu(ctx)) return ctx.ui.notify(menuAsText(spec, USAGE), "info");
	const choice = await showMenu(ctx, spec);
	if (choice && choice.id !== current) apply(ctx, choice.id as DockView, onChange);
}
