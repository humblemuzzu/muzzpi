/**
 * Focus mode: the chat area shows your prompt, the agent's answer and, one tab
 * away, the work in between, while pi's own editor and footer stay below it.
 * It holds the keyboard only so pi does not scroll the hidden chat; every key
 * it does not use goes straight to pi's editor, so typing, commands, pasted
 * images and every pi shortcut work as they always do.
 */

import type { Message } from "@mariozechner/pi-ai";
import { Input, Key, matchesKey, truncateToWidth, type Component, type Focusable, type TuiMouseEvent, type TuiMouseEventResult } from "@mariozechner/pi-tui";
import { fitHint } from "../agents-ui/frame";
import { SPINNER } from "../agents-ui/rows";
import { TranscriptRenderer } from "../agents-ui/transcript";
import { justify, type Styler } from "../tools/lib/agent-layout";
import { oneLine } from "../tools/lib/choice-dialog";
import { formatDuration } from "../tools/lib/sub-agent-render";
import { answerLines, count, markdownLines, markRow, plainLines, processLines, turnRow, type Working } from "./content";
import { answerOf, MARK_LABEL, matches, searchWords, type Mark, type SessionView, type Turn } from "./session-view";

export interface LiveState {
	running: boolean;
	startedAt: number;
	/** the reply being streamed; pi saves it when it ends */
	message: Message | undefined;
	compacting: boolean;
	/** spinner frame, ticking only while the agent works */
	frame: number;
	/** bumps on every change above */
	version: number;
}

/** the part of pi's editor focus mode talks to */
export interface PiEditor {
	handleInput(data: string): void;
	getText(): string;
	focused?: boolean;
}

export interface FocusHost {
	snapshot(): { view: SessionView; version: number };
	live(): LiveState;
	now(): number;
	/** rows of pi's chat area, which focus mode covers exactly */
	chatRows(): number;
	toolsExpanded(): boolean;
	editor(): PiEditor | undefined;
	/** after a frame drawn `rows` tall: redraw if the chat area changed size, take the keyboard back from pi's editor */
	afterRender(rows: number): void;
	mark(turn: Turn): string;
	goto(turn: Turn): string;
	reuse(turn: Turn): string;
	close(): void;
}

type Screen = "turn" | "list" | "doc";

/** what survives closing focus mode and opening it again in the same session */
export interface FocusMemory {
	screen: Exclude<Screen, "doc">;
	turnId: string | undefined;
	tab: number;
	listTab: number;
	query: string;
}

type Row = { kind: "turn"; turn: Turn } | { kind: "mark"; mark: Mark } | { kind: "cut"; number: number };

const TURN_TABS = ["Answer", "Process"] as const;
const LIST_TABS = ["Prompts", "Answers", "Marks"] as const;
const PROCESS_TAB = 1;
const MARKS_TAB = 2;
const PAGE_OVERLAP = 2;
const CLOSE_KEY = "ctrl+shift+h";
const LIST_KEY = "ctrl+shift+l";

export class FocusView implements Component, Focusable {
	private isFocused = false;
	private screen: Screen;
	/** undefined follows the turn the session is on, so a new prompt shows as soon as it is sent */
	private turnId: string | undefined;
	private tab: number;
	private top = 0;
	private follow = true;
	private listTab: number;
	private selected = -1;
	private listTop = 0;
	private doc: Mark | undefined;
	private docTop = 0;
	private notice = "";
	private version = 0;
	private page = 1;
	private readonly search: Input;
	private readonly transcript: TranscriptRenderer;
	private screenCache: { key: string; lines: string[] } | undefined;
	private contentCache: { key: string; lines: string[] } | undefined;
	private promptCache: { key: string; lines: string[] } | undefined;
	private rowsCache: { key: string; rows: Row[] } | undefined;
	private docCache: { key: string; lines: string[] } | undefined;

	constructor(
		private readonly theme: Styler,
		private readonly host: FocusHost,
		memory?: FocusMemory,
	) {
		this.screen = memory?.screen ?? "turn";
		this.turnId = memory?.turnId;
		this.tab = memory?.tab ?? 0;
		this.listTab = memory?.listTab ?? 0;
		this.search = new Input({ prompt: "/ ", placeholder: "type to search prompts and answers", placeholderStyle: (text) => theme.fg("dim", text) });
		if (memory?.query) this.search.setValue(memory.query);
		this.transcript = new TranscriptRenderer(theme);
	}

	/** pi's editor keeps its cursor while focus mode holds the keyboard for it */
	get focused(): boolean {
		return this.isFocused;
	}

	set focused(value: boolean) {
		this.isFocused = value;
		const editor = this.host.editor();
		if (value && editor) editor.focused = true;
		this.version++;
	}

	memory(): FocusMemory {
		return { screen: this.screen === "doc" ? "list" : this.screen, turnId: this.turnId, tab: this.tab, listTab: this.listTab, query: this.search.getValue() };
	}

	/** after the session moved (/tree), show where it is now */
	followSession(): void {
		this.turnId = undefined;
		this.top = 0;
		this.follow = true;
		this.contentCache = undefined;
		this.version++;
	}

	invalidate(): void {
		this.screenCache = this.contentCache = this.promptCache = this.rowsCache = this.docCache = undefined;
		this.search.invalidate();
	}

	// ── input ──

	handleInput(data: string): void {
		if (matchesKey(data, CLOSE_KEY)) return this.host.close();
		const action = this.screen === "turn" ? this.turnAction(data) : undefined;
		if (this.screen === "turn" && !action) {
			this.host.editor()?.handleInput(data);
			if (!this.notice) return;
		}
		this.notice = "";
		this.version++;
		if (action) action();
		else if (this.screen === "list") this.listKey(data);
		else if (this.screen === "doc") this.docKey(data);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "wheel" || !event.wheelDelta) return undefined;
		this.version++;
		const delta = event.wheelDelta * 3;
		if (this.screen === "turn") this.scrollBy(delta);
		else if (this.screen === "list") this.moveSelection(delta);
		else this.docTop = Math.max(0, this.docTop + delta);
		return { handled: true };
	}

	/** focus mode's own keys on the turn screen; Tab and the arrows only while pi's editor is empty */
	private turnAction(data: string): (() => void) | undefined {
		if (matchesKey(data, LIST_KEY)) return () => this.openList();
		if (matchesKey(data, Key.pageUp)) return () => this.scrollBy(-this.page);
		if (matchesKey(data, Key.pageDown)) return () => this.scrollBy(this.page);
		if (matchesKey(data, "ctrl+home")) return () => this.scrollBy(-Number.MAX_SAFE_INTEGER);
		if (matchesKey(data, "ctrl+end")) return () => this.toBottom();
		if (matchesKey(data, "ctrl+up")) return () => this.stepTurn(-1);
		if (matchesKey(data, "ctrl+down")) return () => this.stepTurn(1);
		if ((this.host.editor()?.getText() ?? "") !== "") return undefined;
		if (matchesKey(data, Key.tab)) return () => this.switchTab();
		if (matchesKey(data, Key.left)) return () => this.stepTurn(-1);
		if (matchesKey(data, Key.right)) return () => this.stepTurn(1);
		return undefined;
	}

	private listKey(data: string): void {
		if (matchesKey(data, Key.escape)) {
			if (this.search.getValue()) return this.setQuery("");
			this.screen = "turn";
			return;
		}
		if (matchesKey(data, LIST_KEY)) {
			this.screen = "turn";
			return;
		}
		if (matchesKey(data, Key.tab) || matchesKey(data, "shift+tab")) {
			this.listTab = (this.listTab + (matchesKey(data, Key.tab) ? 1 : LIST_TABS.length - 1)) % LIST_TABS.length;
			this.selected = -1;
			return;
		}
		if (matchesKey(data, Key.enter)) return this.openRow();
		if (matchesKey(data, Key.ctrl("t"))) return this.withRowTurn((turn) => (this.notice = this.host.mark(turn)));
		if (matchesKey(data, Key.ctrl("g"))) return this.withRowTurn((turn) => (this.notice = this.host.goto(turn)));
		if (matchesKey(data, Key.ctrl("r"))) {
			return this.withRowTurn((turn) => {
				this.notice = this.host.reuse(turn);
				this.screen = "turn";
			});
		}
		if (matchesKey(data, Key.up)) return this.moveSelection(-1);
		if (matchesKey(data, Key.down)) return this.moveSelection(1);
		if (matchesKey(data, Key.pageUp)) return this.moveSelection(-this.page);
		if (matchesKey(data, Key.pageDown)) return this.moveSelection(this.page);
		const before = this.search.getValue();
		this.search.handleInput(data);
		if (this.search.getValue() !== before) this.selected = -1;
	}

	private docKey(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.screen = "list";
			return;
		}
		const step = matchesKey(data, Key.up) ? -1 : matchesKey(data, Key.down) ? 1 : matchesKey(data, Key.pageUp) ? -this.page : matchesKey(data, Key.pageDown) ? this.page : 0;
		this.docTop = Math.max(0, this.docTop + step);
	}

	private setQuery(query: string): void {
		this.search.setValue(query);
		this.selected = -1;
	}

	// ── actions ──

	private current(view: SessionView): Turn | undefined {
		return (this.turnId ? view.turns.find((turn) => turn.id === this.turnId) : undefined) ?? view.active;
	}

	private working(turn: Turn, view: SessionView): Working | undefined {
		const live = this.host.live();
		return live.running && turn === view.active ? { message: live.message, spinner: SPINNER[live.frame % SPINNER.length]! } : undefined;
	}

	private show(turn: Turn, view: SessionView): void {
		this.turnId = turn === view.active ? undefined : turn.id;
		this.top = 0;
		this.follow = this.working(turn, view) !== undefined;
	}

	private stepTurn(delta: number): void {
		const { view } = this.host.snapshot();
		const turn = this.current(view);
		const next = turn ? view.turns[turn.number - 1 + delta] : undefined;
		if (next) this.show(next, view);
	}

	private switchTab(): void {
		this.tab = (this.tab + 1) % TURN_TABS.length;
		this.top = 0;
		const { view } = this.host.snapshot();
		const turn = this.current(view);
		this.follow = turn !== undefined && this.working(turn, view) !== undefined;
	}

	private scrollBy(delta: number): void {
		this.follow = false;
		this.top = Math.max(0, this.top + delta);
	}

	private toBottom(): void {
		this.top = Number.MAX_SAFE_INTEGER;
		this.follow = true;
	}

	private openList(): void {
		this.screen = "list";
		this.selected = -1;
	}

	private moveSelection(delta: number): void {
		const rows = this.rows(this.host.snapshot());
		if (rows.length === 0) return;
		let at = Math.min(rows.length - 1, Math.max(0, (this.selected < 0 ? rows.length - 1 : this.selected) + delta));
		const step = delta < 0 ? -1 : 1;
		while (rows[at]?.kind === "cut") at += rows[at + step] ? step : -step;
		this.selected = at;
	}

	private selectedRow(): Row | undefined {
		return this.rows(this.host.snapshot())[this.selected];
	}

	private withRowTurn(act: (turn: Turn) => void): void {
		const row = this.selectedRow();
		const turn = row?.kind === "turn" ? row.turn : row?.kind === "mark" ? row.mark.turn : undefined;
		if (turn) act(turn);
	}

	private openRow(): void {
		const snap = this.host.snapshot();
		const row = this.selectedRow();
		if (!row || row.kind === "cut") return;
		if (row.kind === "turn") {
			this.show(row.turn, snap.view);
			this.screen = "turn";
		} else if (row.mark.text !== undefined && (row.mark.kind === "summary" || row.mark.kind === "branch")) {
			this.doc = row.mark;
			this.docTop = 0;
			this.screen = "doc";
		} else if (row.mark.turn) {
			this.show(row.mark.turn, snap.view);
			this.screen = "turn";
		} else this.notice = "the prompt that mark belongs to is no longer in this session";
	}

	// ── rendering ──

	render(width: number): string[] {
		const rows = Math.max(0, this.host.chatRows());
		const snap = this.host.snapshot();
		const live = this.host.live();
		this.search.focused = this.isFocused && this.screen === "list";
		queueMicrotask(() => this.host.afterRender(rows));
		const key = `${width}|${rows}|${snap.version}|${live.version}|${live.running ? live.frame : -1}|${this.version}|${this.isFocused}|${this.host.toolsExpanded()}`;
		if (this.screenCache?.key === key) return this.screenCache.lines;
		const lines = rows === 0 ? [] : this.screen === "turn" ? this.turnScreen(width, rows, snap) : this.screen === "list" ? this.listScreen(width, rows, snap) : this.docScreen(width, rows);
		this.screenCache = { key, lines };
		return lines;
	}

	/** header, a second row, body, the bottom rows, hints: exactly `rows` lines, none wider than `width` */
	private compose(width: number, rows: number, left: string, second: string, body: (height: number) => string[], bottom: string[], hints: string): string[] {
		const height = Math.max(0, rows - 3 - bottom.length);
		const content = body(height).slice(0, height);
		while (content.length < height) content.push("");
		const header = justify(left, this.status(), width, 12).line;
		return [header, second, ...content, ...bottom, hints].slice(0, rows).map((line) => truncateToWidth(line, width));
	}

	private status(): string {
		const { theme } = this;
		const live = this.host.live();
		if (live.compacting) return theme.fg("warning", "compacting…");
		if (!live.running) return theme.fg("dim", "ready");
		return `${theme.fg("accent", SPINNER[live.frame % SPINNER.length]!)} ${theme.fg("muted", "working")} ${theme.fg("dim", formatDuration(this.host.now() - live.startedAt))}`;
	}

	private title(rest: string): string {
		return `${this.theme.fg("accent", this.theme.bold("◆ focus"))}${rest ? this.theme.fg("dim", `  ${rest}`) : ""}`;
	}

	private tabRow(names: readonly string[], active: number, right: string, width: number): string {
		const { theme } = this;
		const tabs = names.map((name, index) => (index === active ? theme.fg("accent", theme.bold(name)) : theme.fg("muted", name))).join("   ");
		return justify(tabs, right ? theme.fg("dim", right) : "", width, 12).line;
	}

	private hints(tiers: string[], width: number): string {
		if (this.notice) return this.theme.fg("warning", oneLine(this.notice));
		return fitHint(tiers, width, (text) => this.theme.fg("dim", text));
	}

	private turnScreen(width: number, rows: number, snap: { view: SessionView; version: number }): string[] {
		const { view } = snap;
		const turn = this.current(view);
		const working = turn ? this.working(turn, view) : undefined;
		const content = turn ? this.content(turn, working, width) : plainLines("Nothing asked in this session yet: type below.", width).map((line) => this.theme.fg("muted", line));
		const room = Math.max(1, rows - 3);
		this.page = Math.max(1, room - PAGE_OVERLAP);
		const bottom = Math.max(0, content.length - room);
		if (working && this.follow) this.top = bottom;
		this.top = Math.min(this.top, bottom);
		if (working && this.top === bottom) this.follow = true;
		const below = content.length - this.top - room;
		const tabs = turn && turn.toolCalls > 0 ? [TURN_TABS[0], `${TURN_TABS[1]} · ${count(turn.toolCalls, "tool")}`] : TURN_TABS;
		const hints = this.hints(
			[
				"tab answer/process · ←→ or ctrl+↑↓ prompts · pgup/pgdn scroll · ctrl+shift+l every prompt · ctrl+shift+h close",
				"tab answer/process · ←→ prompts · ctrl+shift+l every prompt · ctrl+shift+h close",
				"ctrl+shift+l every prompt · ctrl+shift+h close",
			],
			width,
		);
		return this.compose(width, rows, this.title(turn ? this.turnTags(turn, view) : ""), this.tabRow(tabs, this.tab, below > 0 ? `↓ ${below} more` : "", width), () => content.slice(this.top, this.top + room), [], hints);
	}

	private turnTags(turn: Turn, view: SessionView): string {
		const tags = [`prompt ${turn.number} of ${view.turns.length}`];
		if (!turn.onPath) tags.push("on another /tree branch");
		else if (turn.compacted) tags.push(`summarised away (compaction ${turn.compacted})`);
		if (turn.kind !== "human") tags.push(turn.kind === "goal" ? "sent by goal" : "sent by /ysk");
		if (turn.label) tags.push(turn.label === MARK_LABEL ? `${MARK_LABEL} marked` : `${MARK_LABEL} ${oneLine(turn.label)}`);
		return tags.join(" · ");
	}

	/** the prompt, then the answer or the work: one page that scrolls like the chat */
	private content(turn: Turn, working: Working | undefined, width: number): string[] {
		const live = working ? `${this.host.live().version}|${working.spinner}` : "-";
		const full = this.host.toolsExpanded();
		const key = `${turn.id}|${turn.lastId}|${this.tab}|${width}|${turn.steps.length}|${full}|${live}|${answerOf(turn).state}`;
		if (this.contentCache?.key === key) return this.contentCache.lines;
		const { theme } = this;
		const asker = turn.kind === "human" ? "You asked" : turn.kind === "goal" ? "Goal asked" : "/ysk asked";
		const body = this.tab === PROCESS_TAB ? processLines(turn, working, width, full, this.transcript, theme) : answerLines(turn, working, width, theme);
		const lines = [theme.fg("muted", asker), ...this.promptLines(turn, width), "", ...body];
		this.contentCache = { key, lines };
		return lines;
	}

	/** wrapped once per prompt and width, not again for every streamed token of the answer */
	private promptLines(turn: Turn, width: number): string[] {
		const key = `${turn.id}|${width}`;
		if (this.promptCache?.key !== key) this.promptCache = { key, lines: plainLines(turn.prompt, width).map((line) => this.theme.fg("text", line)) };
		return this.promptCache.lines;
	}

	private rows(snap: { view: SessionView; version: number }): Row[] {
		const query = this.search.getValue();
		const key = `${snap.version}|${this.listTab}|${query}`;
		if (this.rowsCache?.key === key) return this.rowsCache.rows;
		const words = searchWords(query);
		let rows: Row[];
		if (this.listTab === MARKS_TAB) {
			rows = snap.view.marks.filter((mark) => words.every((word) => `${mark.title}\n${mark.text ?? ""}`.toLowerCase().includes(word))).map((mark) => ({ kind: "mark", mark }));
		} else {
			rows = [];
			let lastCut = 0;
			for (const turn of snap.view.turns) {
				if (!matches(turn, words)) continue;
				if (words.length === 0 && turn.onPath) {
					if (lastCut && turn.compacted !== lastCut) rows.push({ kind: "cut", number: lastCut });
					lastCut = turn.compacted;
				}
				rows.push({ kind: "turn", turn });
			}
		}
		this.rowsCache = { key, rows };
		return rows;
	}

	private listScreen(width: number, rows: number, snap: { view: SessionView; version: number }): string[] {
		const { view } = snap;
		const list = this.rows(snap);
		if (this.selected < 0 || this.selected >= list.length) {
			const current = this.current(view);
			const at = this.listTab === MARKS_TAB ? -1 : list.findIndex((row) => row.kind === "turn" && row.turn === current);
			this.selected = at >= 0 ? at : list.length - 1;
		}
		const shown = list.filter((row) => row.kind !== "cut").length;
		const counts = this.listTab === MARKS_TAB ? count(shown, "mark") : `${shown} of ${count(view.turns.length, "prompt")}${view.compactions ? ` · ${count(view.compactions, "compaction")}` : ""}`;
		const hints = this.hints(
			[
				"enter open · type to search · tab prompts/answers/marks · ctrl+t mark · ctrl+g go there · ctrl+r reuse · ⑂ other branch · ◌ summarised · esc back",
				"enter open · type to search · ctrl+t mark · ctrl+g go there · ctrl+r reuse · esc back",
				"enter open · esc back",
			],
			width,
		);
		const bottom = [this.search.render(width)[0] ?? ""];
		return this.compose(width, rows, this.title("every prompt in this session"), this.tabRow(LIST_TABS, this.listTab, counts, width), (height) => this.listBody(list, view, width, height), bottom, hints);
	}

	private listBody(list: Row[], view: SessionView, width: number, height: number): string[] {
		const { theme } = this;
		const room = Math.max(1, height);
		this.page = Math.max(1, room - PAGE_OVERLAP);
		if (this.selected < this.listTop) this.listTop = this.selected;
		if (this.selected >= this.listTop + room) this.listTop = this.selected - room + 1;
		this.listTop = Math.max(0, Math.min(this.listTop, list.length - room));
		const now = this.host.now();
		const active = view.active && this.working(view.active, view) ? view.active : undefined;
		const spinner = SPINNER[this.host.live().frame % SPINNER.length]!;
		const lines = list.slice(this.listTop, this.listTop + room).map((row, offset) => {
			const style = { selected: this.listTop + offset === this.selected, now };
			if (row.kind === "cut") return theme.fg("dim", `  ── summary ${row.number}: the prompts above left the model's memory here ──`);
			if (row.kind === "mark") return markRow(row.mark, width, style, theme);
			const text = this.listTab === 1 ? answerOf(row.turn).text || row.turn.prompt : row.turn.prompt;
			return turnRow(row.turn, text, width, { ...style, working: row.turn === active ? spinner : undefined }, theme);
		});
		if (list.length === 0) lines.push(theme.fg("muted", this.search.getValue() ? "Nothing matches. Esc clears the search." : this.listTab === MARKS_TAB ? "No marks yet: ctrl+t marks a prompt, and goals and summaries show here." : "No prompts yet."));
		return lines;
	}

	private docScreen(width: number, rows: number): string[] {
		const doc = this.doc;
		const key = `${doc?.id}|${width}`;
		if (this.docCache?.key !== key) this.docCache = { key, lines: doc?.text ? markdownLines(doc.text, width) : [] };
		const { lines } = this.docCache;
		const hints = this.hints(["↑↓ scroll · esc back to the list", "esc back"], width);
		return this.compose(
			width,
			rows,
			this.title(doc ? oneLine(doc.title) : ""),
			"",
			(height) => {
				this.page = Math.max(1, height - PAGE_OVERLAP);
				this.docTop = Math.min(this.docTop, Math.max(0, lines.length - height));
				return lines.slice(this.docTop, this.docTop + height);
			},
			[],
			hints,
		);
	}
}
