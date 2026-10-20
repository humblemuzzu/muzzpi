/**
 * sub-agent inspector — step inside a running or finished sub-agent.
 *
 * ctrl+shift+a (or /subagents) opens an overlay listing every sub-agent run
 * in this session. enter opens one: its thinking, its tool calls, its tool
 * results, scrollable. ←/→ switch between runs, esc backs out.
 *
 * READ-ONLY. it shows the runs the tools extension broadcasts on `pi.events`;
 * it writes nothing and sends nothing to a running child.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { AGENT_RUNS_CHANNEL, type RunSnapshot } from "../tools/lib/agent-channel";
import { SubAgentInspector } from "./inspector";
import { AgentRegistry } from "./registry";

const SHORTCUT = "ctrl+shift+a";

export default function subAgentInspectorExtension(pi: ExtensionAPI): void {
	const registry = new AgentRegistry();

	let unsubscribe: (() => void) | undefined;
	pi.on("session_start", () => {
		unsubscribe?.();
		unsubscribe = pi.events.on(AGENT_RUNS_CHANNEL, (runs) => registry.sync(runs as RunSnapshot[]));
	});
	pi.on("session_shutdown", () => {
		unsubscribe?.();
		unsubscribe = undefined;
	});

	async function open(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) return;

		await ctx.ui.custom<null>(
			(tui, theme, _keybindings, done) => {
				const inspector = new SubAgentInspector(() => registry.list(), theme, done);

				// a sub-agent that is still running keeps pushing updates while the
				// overlay is open; repaint on each one so the view is live.
				registry.onChange = () => {
					inspector.invalidate();
					tui.requestRender();
				};

				return {
					render: (width: number) => inspector.render(width),
					handleInput: (data: string) => {
						inspector.handleInput(data);
						tui.requestRender();
					},
					invalidate: () => inspector.invalidate(),
					dispose: () => {
						registry.onChange = undefined;
					},
					get focused() {
						return inspector.focused;
					},
					set focused(value: boolean) {
						inspector.focused = value;
					},
				};
			},
			{
				overlay: true,
				overlayOptions: {
					// full-bleed: the inspector should read like the agent view it
					// is showing, not like a dialog floating over it.
					anchor: "top-left",
					row: 0,
					col: 0,
					width: "100%",
					maxHeight: "100%",
				},
			},
		);
	}

	pi.registerShortcut(SHORTCUT, {
		description: "Inspect sub-agents",
		handler: open,
	});

	pi.registerCommand("subagents", {
		description: "Inspect sub-agent transcripts (thinking, tool calls, results)",
		handler: (_args, ctx) => open(ctx),
	});
}
