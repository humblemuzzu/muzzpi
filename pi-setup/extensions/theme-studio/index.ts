import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	CURSOR_MARKER,
	decodeKittyPrintable,
	fuzzyFilter,
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@mariozechner/pi-tui";
import { withoutTyped } from "../tools/lib/command-args";
import { contributeHelp } from "../tools/lib/help-channel";

const SHORTCUT = "ctrl+shift+k";
const CONFIG =
	process.env.PI_STUDIO_GHOSTTY_CONFIG ??
	join(homedir(), "Library/Application Support/com.mitchellh.ghostty/config");
const THEME_DIRS = [
	join(homedir(), ".config/ghostty/themes"),
	"/Applications/Ghostty.app/Contents/Resources/ghostty/themes",
];
const DARK_THEMES = new Set([
	"Gruvbox Dark Hard",
	"Gruvbox Material Dark",
	"Catppuccin Mocha",
	"Nord",
	"Rose Pine Moon",
	"Kanagawa Dragon",
	"Kanagawa Wave",
	"TokyoNight",
	"TokyoNight Night",
	"TokyoNight Storm",
	"One Half Dark",
	"Atom One Dark",
	"Ayu Mirage",
	"GitHub Dark Default",
	"Material Darker",
	"Nightfox",
	"Carbonfox",
	"Poimandres",
	"Black Metal",
	"Kanso Ink",
	"Kanso Zen",
	"Vague",
	"Melange Dark",
	"Iceberg Dark",
	"Mellow",
	"Miasma",
	"Ghostty Default Style Dark",
	"Cursor Dark",
	"Spacegray",
	"Tomorrow Night",
	"Night Owl",
	"Everforest Dark Hard",
	"gruvbox-dark",
	"gruvbox-medium",
	"catppuccin-macchiato",
	"kanagawa",
	"nord-frost",
	"opencode",
	"rosepine",
	"vesper",
	"midnight-code",
	"ayu-mirage",
	"kanso-mist",
	"github-dark-dimmed",
	"one-half-dark",
	"ember-dark",
	"ember-soft",
	"cursor-soft",
	"melange-dark",
	"afterglow",
	"miasma",
	"n0tch2k",
	"Afterglow",
	"Dark+",
	"Melange Dark",
	"Miasma",
	"GitHub Dark Dimmed",
	"Kanso Mist",
	"Gruvbox Dark",
	"N0tch2k",
]);
const GHOSTTY_BIN = "/Applications/Ghostty.app/Contents/MacOS/ghostty";
const RELOAD =
	'tell application "Ghostty" to perform action "reload_config" on focused terminal of selected tab of front window';
const MAX_VISIBLE = 12;
const SIZES = ["12", "13", "14", "15", "16", "18"];
const OPACITIES = ["1", "0.95", "0.92", "0.85", "0.8", "0.7"];
const CURSORS = ["block", "bar", "underline"].flatMap((style) => [
	{ value: `${style}|false`, label: style, hint: "steady" },
	{ value: `${style}|true`, label: style, hint: "blink" },
]);
const PI_SAMPLE = [
	"accent",
	"success",
	"warning",
	"error",
	"muted",
	"mdHeading",
	"syntaxKeyword",
	"syntaxString",
	"syntaxFunction",
	"toolDiffAdded",
	"toolDiffRemoved",
] as const;

type Entry = { value: string; label: string; hint?: string };
type Tab = {
	name: string;
	entries: Entry[];
	baseline: string;
	apply(value: string): void;
	commit?(value: string): void;
	panel?(value: string): string[];
};

function getKey(text: string, key: string): string | undefined {
	return text.match(new RegExp(`^${key}\\s*=\\s*(.*)$`, "m"))?.[1]?.trim();
}

function setKey(text: string, key: string, value: string): string {
	const line = `${key} = ${value}`;
	const re = new RegExp(`^${key}\\s*=.*$`, "m");
	return re.test(text) ? text.replace(re, () => line) : `${text.replace(/\n*$/, "\n")}${line}\n`;
}

function rgb(hex: string): [number, number, number] | undefined {
	const m = hex.trim().match(/^#?([0-9a-f]{6})$/i);
	if (!m) return undefined;
	const n = Number.parseInt(m[1]!, 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const paint = (text: string, fg?: string, bg?: string): string => {
	const f = fg && rgb(fg);
	const b = bg && rgb(bg);
	const codes = [f ? `38;2;${f.join(";")}` : "", b ? `48;2;${b.join(";")}` : ""].filter(Boolean);
	return codes.length ? `\x1b[${codes.join(";")}m${text}\x1b[0m` : text;
};

type Palette = { colors: string[]; background?: string; foreground?: string };
const palettes = new Map<string, Palette | undefined>();

function readPalette(name: string): Palette | undefined {
	if (palettes.has(name)) return palettes.get(name);
	let result: Palette | undefined;
	for (const dir of THEME_DIRS) {
		const file = join(dir, name);
		if (!existsSync(file)) continue;
		const palette: Palette = { colors: [] };
		for (const line of readFileSync(file, "utf8").split("\n")) {
			const entry = line.match(/^palette\s*=\s*(\d+)=(#[0-9a-f]{6})/i);
			if (entry) palette.colors[Number(entry[1])] = entry[2]!;
			const bg = line.match(/^background\s*=\s*(#?[0-9a-f]{6})/i);
			if (bg) palette.background = bg[1];
			const fg = line.match(/^foreground\s*=\s*(#?[0-9a-f]{6})/i);
			if (fg) palette.foreground = fg[1];
		}
		result = palette;
		break;
	}
	palettes.set(name, result);
	return result;
}

function listGhosttyThemes(): Entry[] {
	const seen = new Map<string, Entry>();
	THEME_DIRS.forEach((dir, i) => {
		if (!existsSync(dir)) return;
		for (const name of readdirSync(dir)) {
			if (name.startsWith(".")) continue;
			const custom = i === 0;
			if ((custom || DARK_THEMES.has(name)) && !seen.has(name)) {
				seen.set(name, { value: name, label: name, hint: custom ? "custom" : undefined });
			}
		}
	});
	return [...seen.values()].sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
}

function run(file: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) =>
		execFile(file, args, { timeout: 5000 }, (error, stdout) => (error ? reject(error) : resolve(stdout))),
	);
}

async function listFonts(): Promise<string[]> {
	try {
		const out = await run(existsSync(GHOSTTY_BIN) ? GHOSTTY_BIN : "ghostty", ["+list-fonts"]);
		return out.split("\n").filter((line) => line && !/^\s/.test(line));
	} catch {
		return [];
	}
}

class GhosttyWriter {
	private timer?: ReturnType<typeof setTimeout>;
	private pending: Record<string, string> = {};
	private chain: Promise<void> = Promise.resolve();

	constructor(private onError: (message: string) => void) {}

	set(patch: Record<string, string>): void {
		Object.assign(this.pending, patch);
		clearTimeout(this.timer);
		this.timer = setTimeout(() => this.flush(), 150);
	}

	flush(): void {
		clearTimeout(this.timer);
		const patch = this.pending;
		this.pending = {};
		if (Object.keys(patch).length === 0) return;
		this.chain = this.chain
			.then(() => this.write(patch))
			.catch((error) => this.onError(error instanceof Error ? error.message : String(error)));
	}

	dispose(): void {
		clearTimeout(this.timer);
	}

	private async write(patch: Record<string, string>): Promise<void> {
		let text = readFileSync(CONFIG, "utf8");
		for (const [key, value] of Object.entries(patch)) text = setKey(text, key, value);
		writeFileSync(CONFIG, text);
		await run("osascript", ["-e", RELOAD]);
	}
}

function buildTabs(ctx: ExtensionContext, writer: GhosttyWriter, fonts: string[], config: string): Tab[] {
	const themes = ctx.ui.getAllThemes();
	const piTab: Tab = {
		name: "Pi",
		entries: themes.filter((t) => t.name !== "light").map((t) => ({ value: t.name, label: t.name, hint: t.path ? "custom" : "built-in" })),
		baseline: ctx.ui.theme.name ?? themes[0]?.name ?? "",
		apply(value) {
			const theme = ctx.ui.getTheme(value);
			if (theme) ctx.ui.setTheme(theme);
		},
		commit(value) {
			ctx.ui.setTheme(value);
		},
		panel() {
			const th = ctx.ui.theme;
			return [PI_SAMPLE.slice(0, 6), PI_SAMPLE.slice(6)].map((row) =>
				row.map((token) => th.fg(token, token)).join(" "),
			);
		},
	};
	if (!config) return [piTab];

	const current = (key: string, fallback: string) => getKey(config, key) ?? fallback;
	const withCurrent = (entries: Entry[], value: string): Entry[] =>
		entries.some((e) => e.value === value) ? entries : [{ value, label: value, hint: "current" }, ...entries];
	const setting = (name: string, key: string, entries: Entry[], baseline: string): Tab => ({
		name,
		entries: withCurrent(entries, baseline),
		baseline,
		apply: (value) => writer.set({ [key]: value }),
	});

	const font = current("font-family", "");
	const cursor: Tab = {
		name: "Cursor",
		entries: CURSORS,
		baseline: `${current("cursor-style", "block")}|${current("cursor-style-blink", "false")}`,
		apply(value) {
			const [style, blink] = value.split("|");
			writer.set({ "cursor-style": style!, "cursor-style-blink": blink! });
		},
	};

	return [
		piTab,
		{
			...setting("Ghostty", "theme", listGhosttyThemes(), current("theme", "")),
			panel(value) {
				const p = readPalette(value);
				if (!p) return [];
				const swatch = p.colors.map((c) => (c ? paint("  ", undefined, c) : "")).join("");
				const sample = paint(" ~/code ❯ git status  ", p.foreground, p.background);
				return [swatch, sample];
			},
		},
		setting("Font", "font-family", fonts.map((f) => ({ value: f, label: f })), font),
		setting("Size", "font-size", SIZES.map((s) => ({ value: s, label: s })), current("font-size", "14")),
		cursor,
		setting("Opacity", "background-opacity", OPACITIES.map((o) => ({ value: o, label: o })), current("background-opacity", "1")),
	];
}

class Studio {
	focused = false;
	private tab = 0;
	private search = "";
	private highlighted = 0;
	private scroll = 0;
	private shown: string[];
	private filtered: Entry[] = [];

	constructor(
		private ctx: ExtensionContext,
		private tabs: Tab[],
		private writer: GhosttyWriter,
		private repaint: () => void,
		private done: () => void,
	) {
		this.shown = tabs.map((t) => t.baseline);
		this.enter(0);
	}

	private get active(): Tab {
		return this.tabs[this.tab]!;
	}

	private enter(tab: number): void {
		this.tab = (tab + this.tabs.length) % this.tabs.length;
		this.search = "";
		this.refilter();
		const at = this.filtered.findIndex((e) => e.value === this.shown[this.tab]);
		this.highlighted = Math.max(0, at);
		this.keepVisible();
	}

	private refilter(): void {
		const { entries } = this.active;
		this.filtered = this.search
			? fuzzyFilter(entries, this.search, (e) => `${e.label} ${e.hint ?? ""}`)
			: [...entries];
	}

	private keepVisible(): void {
		if (this.highlighted < this.scroll) this.scroll = this.highlighted;
		else if (this.highlighted >= this.scroll + MAX_VISIBLE) this.scroll = this.highlighted - MAX_VISIBLE + 1;
	}

	private preview(): void {
		const entry = this.filtered[this.highlighted];
		if (!entry || this.shown[this.tab] === entry.value) return;
		this.shown[this.tab] = entry.value;
		this.active.apply(entry.value);
	}

	private commit(): void {
		this.tabs.forEach((tab, i) => {
			const value = this.shown[i]!;
			if (value === tab.baseline) return;
			tab.apply(value);
			tab.commit?.(value);
			tab.baseline = value;
		});
		this.writer.flush();
	}

	private close(): void {
		this.tabs.forEach((tab, i) => {
			if (this.shown[i] !== tab.baseline) tab.apply(tab.baseline);
		});
		this.writer.flush();
		this.done();
	}

	private move(delta: number): void {
		if (this.filtered.length === 0) return;
		this.highlighted = Math.min(this.filtered.length - 1, Math.max(0, this.highlighted + delta));
		this.keepVisible();
		this.preview();
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) return this.close();
		if (matchesKey(data, Key.enter)) {
			this.commit();
			return this.done();
		}
		if (matchesKey(data, Key.left) || matchesKey(data, Key.shift("tab"))) this.enter(this.tab - 1);
		else if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) this.enter(this.tab + 1);
		else if (matchesKey(data, Key.up) || matchesKey(data, Key.ctrl("p"))) this.move(-1);
		else if (matchesKey(data, Key.down) || matchesKey(data, Key.ctrl("n"))) this.move(1);
		else if (matchesKey(data, Key.backspace)) {
			this.search = this.search.slice(0, -1);
			this.afterSearch();
		} else {
			const typed = decodeKittyPrintable(data) ?? (!data.startsWith("\x1b") && data.charCodeAt(0) >= 32 ? data : undefined);
			if (typed) {
				this.search += typed;
				this.afterSearch();
			}
		}
		this.repaint();
	}

	private afterSearch(): void {
		this.refilter();
		this.highlighted = 0;
		this.scroll = 0;
		this.preview();
	}

	invalidate(): void {}

	render(width: number): string[] {
		const th = this.ctx.ui.theme;
		const inner = Math.max(10, width - 2);
		const edge = (s: string) => th.fg("border", s);
		const row = (content: string) => {
			const clipped = truncateToWidth(content, inner);
			return edge("│") + clipped + " ".repeat(Math.max(0, inner - visibleWidth(clipped))) + edge("│");
		};
		const rule = (l: string, r: string) => edge(`${l}${"─".repeat(inner)}${r}`);

		const tabs = this.tabs
			.map((t, i) => (i === this.tab ? th.fg("accent", th.bold(t.name)) : th.fg("dim", t.name)))
			.join(th.fg("dim", "  "));
		const cursor = this.focused ? CURSOR_MARKER + th.fg("accent", "▏") : th.fg("dim", "▏");
		const hint = this.search ? "" : th.fg("dim", "type to filter…");
		const lines = [
			rule("╭", "╮"),
			row(` ${tabs}`),
			rule("├", "┤"),
			row(th.fg("dim", " ❯ ") + th.fg("text", this.search) + cursor + hint),
			rule("├", "┤"),
		];

		if (this.filtered.length === 0) lines.push(row(th.fg("muted", "  no matches")));
		const end = Math.min(this.scroll + MAX_VISIBLE, this.filtered.length);
		if (this.scroll > 0) lines.push(row(th.fg("dim", `  ↑ ${this.scroll} more`)));
		for (let i = this.scroll; i < end; i++) {
			const entry = this.filtered[i]!;
			const on = i === this.highlighted;
			const mark = entry.value === this.active.baseline ? th.fg("success", "● ") : "  ";
			const label = on ? th.fg("accent", th.bold(entry.label)) : th.fg("text", entry.label);
			const suffix = entry.hint ? `  ${th.fg("dim", entry.hint)}` : "";
			lines.push(row(`${on ? th.fg("accent", "❯ ") : "  "}${mark}${label}${suffix}`));
		}
		if (this.filtered.length > end) lines.push(row(th.fg("dim", `  ↓ ${this.filtered.length - end} more`)));

		const focus = this.filtered[this.highlighted]?.value;
		const panel = focus ? this.active.panel?.(focus) ?? [] : [];
		if (panel.length) {
			lines.push(rule("├", "┤"));
			for (const line of panel) lines.push(row(` ${line}`));
		}

		lines.push(rule("├", "┤"));
		lines.push(row(th.fg("dim", " ←→ section · ↑↓ preview · enter keep + close · esc revert")));
		lines.push(rule("╰", "╯"));
		return lines;
	}
}

export default function themeStudio(pi: ExtensionAPI) {
	async function open(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) return;

		let config = "";
		try {
			config = readFileSync(CONFIG, "utf8");
		} catch {
			ctx.ui.notify(`Ghostty config not found at ${CONFIG}; showing pi themes only`, "warning");
		}

		let warned = false;
		const writer = new GhosttyWriter((message) => {
			if (warned) return;
			warned = true;
			try {
				ctx.ui.notify(`Ghostty: ${message}`, "error");
			} catch {}
		});
		const tabs = buildTabs(ctx, writer, config ? await listFonts() : [], config);

		try {
			await ctx.ui.custom<void>(
				(tui, _theme, _keybindings, done) => {
					const studio = new Studio(ctx, tabs, writer, () => tui.requestRender(), () => done());
					return {
						render: (width: number) => studio.render(width),
						handleInput: (data: string) => studio.handleInput(data),
						invalidate: () => studio.invalidate(),
						get focused() {
							return studio.focused;
						},
						set focused(value: boolean) {
							studio.focused = value;
						},
					};
				},
				{
					overlay: true,
					overlayOptions: { anchor: "right-center", width: 58, minWidth: 44, maxHeight: "85%", margin: { right: 1 } },
				},
			);
		} finally {
			writer.dispose();
		}
	}

	let ui: ExtensionContext["ui"] | undefined;
	let names: string[] | undefined;
	pi.on("session_start", (_event, ctx) => {
		ui = ctx.hasUI ? ctx.ui : undefined;
		names = undefined;
	});
	/** read once per session: pi scans the custom themes folder on every call */
	const themeNames = (): string[] => {
		try {
			names ??= (ui?.getAllThemes() ?? []).map((t) => t.name).sort();
			return names;
		} catch {
			return [];
		}
	};

	pi.registerCommand("theme", {
		description: "Change the pi and Ghostty theme, font and cursor, with a live preview",
		getArgumentCompletions: (prefix) => {
			const typed = prefix.trim().toLowerCase();
			const current = ui?.theme.name;
			const items = themeNames()
				.filter((name) => name.toLowerCase().startsWith(typed))
				.map((name) => ({ value: name, label: name, description: name === current ? "pi theme now" : "switch pi to it" }));
			return withoutTyped(items, prefix);
		},
		handler: async (args, ctx) => {
			const wanted = args.trim();
			if (!wanted) return open(ctx);
			const name = ctx.ui.getAllThemes().find((t) => t.name.toLowerCase() === wanted.toLowerCase())?.name;
			if (!name) {
				const known = ctx.ui.getAllThemes().map((t) => t.name).sort().join(", ");
				return ctx.ui.notify(`No pi theme called "${wanted}". Themes: ${known}. /theme on its own opens the picker.`, "error");
			}
			const result = ctx.ui.setTheme(name);
			ctx.ui.notify(result.success ? `pi theme: ${name}.` : `Could not switch to ${name}: ${result.error ?? "unknown error"}`, result.success ? "info" : "error");
		},
	});
	pi.registerShortcut(SHORTCUT, {
		description: "Open the theme picker",
		handler: (ctx) => open(ctx),
	});
	contributeHelp(pi, (help) => help.shortcut({ command: "theme", key: SHORTCUT }));
}
