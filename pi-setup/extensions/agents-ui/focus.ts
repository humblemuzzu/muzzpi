import type { Message } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Markdown, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import { prefsFile, readPrefs, writePrefs } from "../tools/lib/prefs";
import { contributeHelp } from "../tools/lib/help-channel";
import { normalizeForDisplay } from "../tools/lib/box-format";
import { TranscriptRenderer } from "./transcript";
import { FocusState, type FocusMessage } from "./focus-state";

export function installFocusView(pi: ExtensionAPI): void {
	if (process.env.PI_SUBAGENT_TOOLS) return;
	let state = new FocusState();
	let close: (() => void) | undefined;
	let repaint: (() => void) | undefined;
	const preferences = prefsFile("focus");
	let enabled = readPrefs(preferences).enabled !== false;
	let blocked = false;
	let viewId = 0;

	const open = (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui" || !ctx.hasUI || blocked || close || !state.question) return;
		const id = ++viewId;
		void ctx.ui.custom<void>((tui, theme, _keys, done) => {
			let tab = 0;
			const offsets = [0, 0, 0];
			let page = 1;
			let cache: { key: string; lines: string[] } | undefined;
			const transcript = new TranscriptRenderer(theme);
			close = () => { close = undefined; repaint = undefined; done(); };
			repaint = () => tui.requestRender();
			return {
				invalidate() { cache = undefined; },
				handleInput(data: string) {
					if (matchesKey(data, "escape") || matchesKey(data, "enter")) return close?.();
					if (matchesKey(data, "ctrl+c")) { ctx.abort(); return; }
					if (matchesKey(data, "tab") || matchesKey(data, "right")) tab = (tab + 1) % 3;
					else if (matchesKey(data, "shift+tab") || matchesKey(data, "left")) tab = (tab + 2) % 3;
					else if (matchesKey(data, "up")) offsets[tab] = Math.max(0, offsets[tab] - 1);
					else if (matchesKey(data, "down")) offsets[tab] += 1;
					else if (matchesKey(data, "pageUp")) offsets[tab] = Math.max(0, offsets[tab] - page);
					else if (matchesKey(data, "pageDown")) offsets[tab] += page;
					else if (matchesKey(data, "home")) offsets[tab] = 0;
					else if (matchesKey(data, "end")) offsets[tab] = Number.MAX_SAFE_INTEGER;
					tui.requestRender();
				},
				render(width: number): string[] {
					const height = Math.max(1, tui.terminal.rows);
					const key = `${width}|${height}|${state.version}|${state.running}|${tab}|${offsets.join()}`;
					if (cache?.key === key) return cache.lines;
					const question = wrapTextWithAnsi(normalizeForDisplay(state.question), Math.max(1, width));
					const limit = Math.max(1, Math.min(6, Math.floor(height / 4)));
					const pinned = question.slice(0, limit);
					if (question.length > limit) pinned[pinned.length - 1] = truncateToWidth(`${pinned.at(-1)} … (Question tab for full prompt)`, width);
					const top = [theme.fg("accent", "Your question"), ...pinned, "", ["Answer", "Process", "Question"].map((name, i) => i === tab ? theme.fg("accent", `[${name}]`) : theme.fg("muted", name)).join("   ")];
					page = Math.max(1, height - top.length - 2);
					const body = tab === 1 ? transcript.lines(state.messages as unknown as Message[], Math.max(1, width), { full: true }) : tab === 2 ? question : new Markdown(normalizeForDisplay(state.answer()), 0, 0, getMarkdownTheme()).render(Math.max(1, width));
					offsets[tab] = Math.min(offsets[tab], Math.max(0, body.length - page));
					const visible = body.slice(offsets[tab], offsets[tab] + page);
					while (visible.length < page) visible.push("");
					const lines = [...top, ...visible, "", theme.fg("muted", "Tab: switch · ↑↓/PgUp/PgDn: scroll · Esc/Enter: chat · Ctrl+C: stop")].slice(0, height).map(line => truncateToWidth(line, Math.max(1, width)));
					cache = { key, lines };
					return lines;
				},
			};
		}, { overlay: true, overlayOptions: { anchor: "top-left", row: 0, col: 0, width: "100%", maxHeight: "100%" } }).catch(() => {}).finally(() => { if (viewId === id) { close = undefined; repaint = undefined; } });
	};

	pi.events.on("herdr:blocked", (event: unknown) => {
		blocked = (event as { active?: boolean } | null)?.active === true;
		if (blocked) close?.();
	});

	pi.registerCommand("focus", {
		description: "Pinned question with separate answer and process tabs (on/off)",
		handler: async (args, ctx) => {
			if (args.trim() === "off") { enabled = false; writePrefs(preferences, { enabled }); close?.(); return; }
			if (args.trim() && args.trim() !== "on") { ctx.ui.notify("Use /focus, /focus on, or /focus off", "warning"); return; }
			enabled = true;
			writePrefs(preferences, { enabled });
			open(ctx);
		},
	});
	pi.registerShortcut("ctrl+shift+f", { description: "Open question, answer and process", handler: async ctx => open(ctx) });
	contributeHelp(pi, help => help.shortcut({ command: "focus", key: "ctrl+shift+f" }));
	pi.on("session_start", async (_event, ctx) => {
		close?.();
		state = new FocusState();
		blocked = false;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "message") state.accept(entry.message as FocusMessage, true);
		}
	});
	pi.on("message_start", async (event, ctx) => {
		if (event.message.role === "user") {
			state.accept(event.message as FocusMessage, true);
			if (enabled) open(ctx);
		} else if (event.message.role === "assistant") state.accept(event.message as FocusMessage, false);
		repaint?.();
	});
	pi.on("message_update", async event => { state.accept(event.message as FocusMessage, false); repaint?.(); });
	pi.on("message_end", async event => { if (event.message.role !== "user") state.accept(event.message as FocusMessage, true); repaint?.(); });
	pi.on("agent_start", async () => { state.running = true; repaint?.(); });
	pi.on("agent_end", async () => { state.running = false; repaint?.(); });
	pi.on("session_shutdown", async () => { close?.(); repaint = undefined; });
}
