import {
	CURSOR_MARKER,
	decodeKittyPrintable,
	type Focusable,
	fuzzyFilter,
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@mariozechner/pi-tui";
import { normalizeForDisplay } from "../tools/lib/box-format";
import { describeAction } from "./entries";
import type { HelpEntry, HelpSection } from "./types";

const LIST_ROWS_MAX = 16;
const LIST_ROWS_MIN = 4;
/** every line that is not a list row: borders, search, scroll markers, details, hint, and a margin */
const CHROME_LINES = 15;
const NAME_COLUMN_MAX = 24;
const DETAIL_LINES = 3;

const SECTION_TITLE: Record<HelpSection, string> = {
	muzzpi: "muzzpi",
	pi: "pi",
	prompts: "prompts",
	mentions: "@mentions · add one to your message",
	skills: "skills · start a message with one",
};

interface HelpTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

type Row = { kind: "header"; section: HelpSection } | { kind: "entry"; entry: HelpEntry; index: number };

function oneLine(text: string): string {
	return normalizeForDisplay(text.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]+/g, " ")).trim();
}

function typed(data: string): string | undefined {
	const kitty = decodeKittyPrintable(data);
	if (kitty !== undefined) return kitty;
	if (data.startsWith("\x1b[200~")) return data.slice(6).replace(/\x1b\[201~$/, "");
	return [...data].every((ch) => ch >= " " && ch !== "\x7f") ? data : undefined;
}

/** /help: every command, shortcut, @mention and skill, searchable; enter runs or types the highlighted one. */
export class HelpView implements Focusable {
	focused = false;
	private search = "";
	private shown: HelpEntry[];
	private rows: Row[] = [];
	private selected = 0;
	private scroll = 0;
	private cacheKey = "";
	private cache: string[] = [];
	/** per section, so one long skill name does not push every command's description right */
	private readonly nameColumns = new Map<HelpSection, number>();
	private searchColumn = NAME_COLUMN_MAX;
	private readonly keyColumn: number;

	constructor(
		private readonly entries: readonly HelpEntry[],
		private readonly theme: HelpTheme,
		private readonly done: (entry: HelpEntry | undefined) => void,
		private readonly terminalRows: () => number = () => 40,
	) {
		this.shown = [...entries];
		for (const entry of entries) {
			const width = Math.min(NAME_COLUMN_MAX, visibleWidth(oneLine(entry.name)));
			this.nameColumns.set(entry.section, Math.max(this.nameColumns.get(entry.section) ?? 8, width));
		}
		this.keyColumn = Math.max(0, ...entries.map((e) => (e.key ? visibleWidth(e.key) : 0)));
		this.layout();
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			if (this.search && matchesKey(data, Key.escape)) return this.setSearch("");
			return this.done(undefined);
		}
		if (matchesKey(data, Key.enter)) {
			const entry = this.shown[this.selected];
			if (entry) this.done(entry);
			return;
		}
		if (matchesKey(data, Key.up) || matchesKey(data, Key.ctrl("p"))) return this.move(-1);
		if (matchesKey(data, Key.down) || matchesKey(data, Key.ctrl("n"))) return this.move(1);
		if (matchesKey(data, Key.pageUp)) return this.move(-this.listRows());
		if (matchesKey(data, Key.pageDown)) return this.move(this.listRows());
		if (matchesKey(data, Key.backspace)) return this.setSearch([...this.search].slice(0, -1).join(""));
		if (matchesKey(data, Key.ctrl("u"))) return this.setSearch("");
		const text = typed(data);
		if (text) this.setSearch(this.search + oneLine(text));
	}

	private setSearch(search: string): void {
		this.search = search;
		this.shown = search ? fuzzyFilter([...this.entries], search, (e) => `${e.name} ${e.description}`) : [...this.entries];
		this.searchColumn = Math.min(NAME_COLUMN_MAX, Math.max(8, ...this.shown.map((e) => visibleWidth(oneLine(e.name)))));
		this.selected = 0;
		this.scroll = 0;
		this.layout();
		this.changed();
	}

	/** Sections get a header while browsing; search results are one list, best match first. */
	private layout(): void {
		this.rows = [];
		this.shown.forEach((entry, index) => {
			if (!this.search && this.shown[index - 1]?.section !== entry.section) this.rows.push({ kind: "header", section: entry.section });
			this.rows.push({ kind: "entry", entry, index });
		});
	}

	private move(delta: number): void {
		if (this.shown.length === 0) return;
		this.selected = Math.min(this.shown.length - 1, Math.max(0, this.selected + delta));
		this.keepVisible();
		this.changed();
	}

	private listRows(): number {
		return Math.min(LIST_ROWS_MAX, Math.max(LIST_ROWS_MIN, this.terminalRows() - CHROME_LINES));
	}

	private keepVisible(): void {
		let row = this.rows.findIndex((r) => r.kind === "entry" && r.index === this.selected);
		const bottom = row;
		while (row > 0 && this.rows[row - 1]!.kind === "header") row--;
		const visible = this.listRows();
		if (row < this.scroll) this.scroll = row;
		else if (bottom >= this.scroll + visible) this.scroll = bottom - visible + 1;
	}

	private changed(): void {
		this.cacheKey = "";
	}

	invalidate(): void {
		this.cacheKey = "";
	}

	render(width: number): string[] {
		const key = `${width}:${this.listRows()}:${this.focused}`;
		if (key === this.cacheKey) return this.cache;
		this.cache = this.build(Math.max(width, 30)).map((line) => truncateToWidth(line, width, ""));
		this.cacheKey = key;
		return this.cache;
	}

	private build(width: number): string[] {
		const t = this.theme;
		const inner = width - 2;
		const border = (s: string) => t.fg("border", s);
		const row = (content = "") => {
			const clipped = truncateToWidth(content, inner, "");
			return border("│") + clipped + " ".repeat(Math.max(0, inner - visibleWidth(clipped))) + border("│");
		};
		const rule = (left: string, right: string) => border(`${left}${"─".repeat(inner)}${right}`);

		const cursor = this.focused ? `${CURSOR_MARKER}${t.fg("accent", "▏")}` : t.fg("dim", "▏");
		const placeholder = this.search ? "" : t.fg("dim", "search commands, shortcuts and @mentions");
		const lines = [rule("╭", "╮"), row(` ${t.fg("accent", "❯")} ${t.fg("text", oneLine(this.search))}${cursor}${placeholder}`), rule("├", "┤")];

		if (this.shown.length === 0) {
			lines.push(row(), row(t.fg("muted", "   nothing matches; backspace or esc to clear")), row());
		} else {
			this.keepVisible();
			const end = Math.min(this.rows.length, this.scroll + this.listRows());
			const above = this.rows.slice(0, this.scroll).filter((r) => r.kind === "entry").length;
			const below = this.rows.slice(end).filter((r) => r.kind === "entry").length;
			lines.push(row(above ? t.fg("dim", `   ↑ ${above} more`) : ""));
			for (const r of this.rows.slice(this.scroll, end)) lines.push(row(this.renderRow(r, inner)));
			lines.push(row(below ? t.fg("dim", `   ↓ ${below} more`) : ""));
		}

		const entry = this.shown[this.selected];
		if (entry) {
			lines.push(rule("├", "┤"));
			const detail = wrapTextWithAnsi(oneLine(entry.description) || "No description.", inner - 2);
			for (const line of detail.slice(0, DETAIL_LINES)) lines.push(row(` ${t.fg("text", line)}`));
			const key = entry.key ? ` · ${entry.key} opens it from anywhere` : "";
			lines.push(row(` ${t.fg("muted", `${describeAction(entry)}${key}`)}`));
		}
		lines.push(rule("├", "┤"));
		lines.push(row(` ${t.fg("dim", "↑↓ move · enter choose · type to search · esc close")}`));
		lines.push(rule("╰", "╯"));
		return lines;
	}

	private renderRow(r: Row, inner: number): string {
		const t = this.theme;
		if (r.kind === "header") return ` ${t.fg("muted", t.bold(SECTION_TITLE[r.section]))}`;
		const on = r.index === this.selected;
		const column = this.search ? this.searchColumn : (this.nameColumns.get(r.entry.section) ?? NAME_COLUMN_MAX);
		const name = truncateToWidth(oneLine(r.entry.name), column, "…");
		const pad = " ".repeat(Math.max(0, column - visibleWidth(name)) + 2);
		const key = r.entry.key ?? "";
		const keyWidth = this.keyColumn ? this.keyColumn + 2 : 0;
		const room = Math.max(0, inner - 3 - column - 2 - keyWidth - 1);
		const description = truncateToWidth(oneLine(r.entry.description), room, "…");
		const descPad = " ".repeat(Math.max(0, room - visibleWidth(description)));
		const keyText = keyWidth ? `  ${" ".repeat(Math.max(0, this.keyColumn - visibleWidth(key)))}${t.fg("dim", key)}` : "";
		const pointer = on ? t.fg("accent", " › ") : "   ";
		const label = on ? t.fg("accent", t.bold(name)) : t.fg("text", name);
		return `${pointer}${label}${pad}${t.fg(on ? "text" : "dim", description)}${descPad}${keyText}`;
	}
}
