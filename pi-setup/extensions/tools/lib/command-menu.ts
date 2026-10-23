/**
 * The menu a slash command opens when typed on its own: what the feature is
 * set to now, then each thing it can do, with one line on what that does.
 * It takes the editor's place while open, like the ask picker, so the
 * transcript stays visible.
 */

import { decodeKittyPrintable, Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import { normalizeForDisplay } from "./box-format";

export interface MenuItem {
	id: string;
	label: string;
	description?: string;
	/** dim text after the label: a shortcut, a path */
	note?: string;
	/** a setting rather than an action: enter, space and ←→ step through these */
	values?: readonly string[];
	value?: string;
}

export interface MenuSpec {
	title: string;
	/** where things stand, shown under the title */
	status?: readonly string[];
	items: readonly MenuItem[];
	/** id of the row the cursor starts on */
	initial?: string;
}

export interface MenuChoice {
	id: string;
	/** every setting row's value when the menu closed */
	values: Record<string, string>;
}

interface MenuTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

interface MenuTui {
	requestRender(): void;
}

export interface MenuContext {
	mode?: string;
	hasUI?: boolean;
	ui?: {
		custom?<T>(factory: (tui: any, theme: any, keybindings: any, done: (result: T) => void) => any): Promise<T>;
	};
}

const LABEL_COLUMN_MAX = 40;

function clean(text: string): string {
	return normalizeForDisplay(text.replace(/\t/g, "  ").replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, ""));
}

function oneLine(text: string): string {
	return clean(text.replace(/[\r\n\u2028\u2029\v\f]+/g, " ")).trim();
}

function pressedText(data: string): string | undefined {
	const kitty = decodeKittyPrintable(data);
	if (kitty !== undefined) return kitty;
	return data.length === 1 && data >= " " ? data : undefined;
}

export class CommandMenu {
	private row: number;
	private readonly values: string[];
	private cacheWidth = -1;
	private cache: string[] = [];

	constructor(
		private readonly spec: MenuSpec,
		private readonly tui: MenuTui,
		private readonly theme: MenuTheme,
		private readonly done: (choice: MenuChoice | undefined) => void,
	) {
		const start = spec.items.findIndex((item) => item.id === spec.initial);
		this.row = Math.max(0, start);
		this.values = spec.items.map((item) => item.value ?? item.values?.[0] ?? "");
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) return this.done(undefined);
		if (matchesKey(data, Key.up) || matchesKey(data, Key.ctrl("p"))) return this.move(-1);
		if (matchesKey(data, Key.down) || matchesKey(data, Key.ctrl("n"))) return this.move(1);
		const item = this.spec.items[this.row];
		if (!item) return;
		if (item.values && matchesKey(data, Key.left)) return this.step(-1);
		if (item.values && matchesKey(data, Key.right)) return this.step(1);
		if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) return this.activate();
		const text = pressedText(data);
		const digit = text && /^[1-9]$/.test(text) && this.numbered ? Number(text) : 0;
		if (digit > 0 && digit <= this.spec.items.length) {
			this.row = digit - 1;
			this.activate();
		}
	}

	private get numbered(): boolean {
		return this.spec.items.length <= 9;
	}

	private activate(): void {
		const item = this.spec.items[this.row]!;
		if (item.values) return this.step(1);
		const values: Record<string, string> = {};
		this.spec.items.forEach((entry, i) => {
			if (entry.values) values[entry.id] = this.values[i]!;
		});
		this.done({ id: item.id, values });
	}

	private move(delta: number): void {
		const count = this.spec.items.length;
		this.row = (this.row + delta + count) % count;
		this.changed();
	}

	private step(delta: number): void {
		const options = this.spec.items[this.row]!.values!;
		const at = Math.max(0, options.indexOf(this.values[this.row]!));
		this.values[this.row] = options[(at + delta + options.length) % options.length]!;
		this.changed();
	}

	private changed(): void {
		this.cacheWidth = -1;
		this.tui.requestRender();
	}

	invalidate(): void {
		this.cacheWidth = -1;
	}

	render(width: number): string[] {
		if (width === this.cacheWidth) return this.cache;
		this.cache = this.build(Math.max(width, 12)).map((line) => truncateToWidth(line, width, ""));
		this.cacheWidth = width;
		return this.cache;
	}

	private build(width: number): string[] {
		const t = this.theme;
		const inner = width - 2;
		const lines: string[] = [];
		const push = (line = "") => lines.push(` ${line}`);
		const wrap = (text: string, style: (s: string) => string, indent: string) => {
			for (const paragraph of clean(text).split("\n")) {
				for (const line of wrapTextWithAnsi(paragraph, Math.max(inner - indent.length, 8))) push(indent + style(line));
			}
		};

		lines.push(t.fg("accent", "─".repeat(width)));
		push(t.fg("accent", t.bold(oneLine(this.spec.title))));
		for (const status of this.spec.status ?? []) wrap(status, (s) => t.fg("muted", s), "");
		push();

		const items = this.spec.items;
		const hasColumn = items.some((item) => item.values || item.note);
		const column = Math.min(LABEL_COLUMN_MAX, Math.max(...items.map((item) => visibleWidth(oneLine(item.label)))));
		const number = (i: number) => (this.numbered ? `${i + 1} ` : "");
		items.forEach((item, i) => {
			const selected = i === this.row;
			const label = oneLine(item.label);
			const cursor = selected ? t.fg("accent", "› ") : "  ";
			const styled = t.fg(selected ? "accent" : "text", label);
			const gap = hasColumn ? " ".repeat(Math.max(0, column - visibleWidth(label)) + 3) : "";
			const value = item.values ? t.fg(selected ? "accent" : "text", oneLine(this.values[i]!)) : "";
			const note = item.note ? t.fg("dim", oneLine(item.note)) : "";
			const after = value && note ? `${value}  ${note}` : value || note;
			push(`${cursor}${t.fg("dim", number(i))}${styled}${after ? gap + after : ""}`);
			if (item.description) wrap(item.description, (s) => t.fg("dim", s), "    ");
		});

		push();
		push(t.fg("dim", this.hint()));
		lines.push(t.fg("accent", "─".repeat(width)));
		return lines;
	}

	private hint(): string {
		const setting = this.spec.items[this.row]?.values !== undefined;
		return ["↑↓ move", setting ? "enter or ←→ change" : "enter choose", "esc close"].join(" · ");
	}
}

export function canShowMenu(ctx: MenuContext | undefined): boolean {
	return Boolean(ctx?.hasUI && ctx.mode === "tui" && ctx.ui?.custom);
}

/** Resolves with the chosen row, or undefined when the user closed the menu. Only call when `canShowMenu`. */
export function showMenu(ctx: MenuContext, spec: MenuSpec): Promise<MenuChoice | undefined> {
	if (!ctx.ui?.custom || spec.items.length === 0) return Promise.resolve(undefined);
	return ctx.ui.custom<MenuChoice | undefined>((tui, theme, _keybindings, done) => new CommandMenu(spec, tui, theme, done));
}

interface AskContext {
	mode?: string;
	ui: {
		input(title: string, placeholder?: string): Promise<string | undefined>;
		theme?: { fg(color: string, text: string): string };
	};
}

/**
 * A one-line text prompt with a hint under its title. pi's input dialog never
 * shows its placeholder, so the hint has to be part of the title.
 */
export async function askText(ctx: AskContext, title: string, hint?: string): Promise<string | undefined> {
	const theme = ctx.mode === "tui" ? ctx.ui.theme : undefined;
	const full = !hint ? title : theme ? `${title}\n${theme.fg("dim", hint)}` : `${title} (${hint})`;
	return ctx.ui.input(full);
}

/** The same menu as plain text, for a session with no screen to draw it on. */
export function menuAsText(spec: MenuSpec, usage: readonly string[]): string {
	const lines = [oneLine(spec.title), ...(spec.status ?? []).map(oneLine)];
	if (usage.length > 0) lines.push("", ...usage);
	return lines.join("\n");
}
