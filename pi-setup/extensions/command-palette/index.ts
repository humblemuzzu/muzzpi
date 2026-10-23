import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { collectHelp, contributeHelp } from "../tools/lib/help-channel";
import { loadBuiltinCommands } from "./builtins";
import { buildEntries, editorTextFor } from "./entries";
import { HelpView } from "./palette";
import type { HelpEntry } from "./types";

const SHORTCUT = "ctrl+shift+p";
const MAX_WIDTH = 110;

export default function helpExtension(pi: ExtensionAPI) {
	contributeHelp(pi, (help) => help.shortcut({ command: "help", key: SHORTCUT }));

	async function open(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI || ctx.mode !== "tui") {
			ctx.ui.notify("/help needs the interactive TUI. Type / to see every command.", "info");
			return;
		}
		const entries = buildEntries(pi.getCommands(), await loadBuiltinCommands(), collectHelp(pi.events));
		let columns = 100;
		let repaint = () => {};
		const picked = await ctx.ui.custom<HelpEntry | undefined>(
			(tui, theme, _keybindings, done) => {
				columns = tui.terminal.columns;
				repaint = () => tui.requestRender();
				const view = new HelpView(entries, theme, done, () => tui.terminal.rows);
				return {
					render: (width: number) => view.render(width),
					handleInput: (data: string) => {
						view.handleInput(data);
						tui.requestRender();
					},
					invalidate: () => view.invalidate(),
					get focused() {
						return view.focused;
					},
					set focused(value: boolean) {
						view.focused = value;
					},
				};
			},
			{
				overlay: true,
				overlayOptions: () => ({ anchor: "top-center", width: Math.min(MAX_WIDTH, Math.floor(columns * 0.9)), minWidth: 50, maxHeight: "100%", offsetY: 1 }),
			},
		);
		if (picked) act(picked, ctx, repaint);
	}

	/** pi's setEditorText does not repaint, so the typed command would stay invisible until the next key. */
	function act(entry: HelpEntry, ctx: ExtensionContext, repaint: () => void): void {
		if (entry.action.kind === "run") {
			pi.sendUserMessage(`/${entry.action.command}`, { expandPromptTemplates: true });
			return;
		}
		const text = editorTextFor(entry, ctx.ui.getEditorText());
		if (text === undefined) {
			ctx.ui.notify(`Your prompt has a draft in it, so ${entry.name} was not typed over it. Send or clear the draft, then pick it again.`, "info");
			return;
		}
		ctx.ui.setEditorText(text);
		repaint();
	}

	pi.registerCommand("help", {
		description: "Every muzzpi command, shortcut and @mention in one searchable list",
		handler: async (_args, ctx) => open(ctx),
	});

	pi.registerShortcut(SHORTCUT, {
		description: "Open /help",
		handler: async (ctx) => open(ctx),
	});
}
