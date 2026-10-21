import { decodeKittyPrintable, Key, matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { normalizeForDisplay } from "../tools/lib/box-format";
import { type Idea, type Scope, type Status, age, flatten } from "./store";

export type Change = { idea: Idea; status: Status } | { idea: Idea; scope: Scope };

export interface ListSource {
	/** open ideas, newest first: this project's (or the harness's), or every project's */
	ideas(everything: boolean): Idea[];
	title(everything: boolean): string;
	/** where `m` sends an idea, or undefined when it has nowhere to go */
	moveTarget(idea: Idea): { scope: Scope; label: string } | undefined;
	apply(change: Change): void;
	/** the view lists harness ideas, so the project an idea came from is worth showing */
	harnessView: boolean;
}

interface ListTheme {
	fg(color: string, text: string): string;
	bg(color: string, text: string): string;
	bold(text: string): string;
}

const VISIBLE_ROWS = 12;

function show(text: string): string {
	return normalizeForDisplay(flatten(text));
}

export class IdeaList {
	focused = false;
	private everything = false;
	private index = 0;
	private notice: string | undefined;
	private undo: Change | undefined;
	private cacheWidth = -1;
	private cache: string[] = [];

	constructor(
		private readonly source: ListSource,
		private readonly theme: ListTheme,
		private readonly tui: { requestRender(): void },
		private readonly done: (start: Idea | undefined) => void,
		private readonly now: () => Date = () => new Date(),
	) {}

	invalidate(): void {
		this.cacheWidth = -1;
	}

	private changed(): void {
		this.invalidate();
		this.tui.requestRender();
	}

	private visible(): Idea[] {
		const ideas = this.source.ideas(this.everything);
		this.index = Math.min(this.index, Math.max(ideas.length - 1, 0));
		return ideas;
	}

	private change(change: Change, undo: Change, notice: string): void {
		this.source.apply(change);
		this.undo = undo;
		this.notice = notice;
	}

	handleInput(data: string): void {
		const ideas = this.visible();
		const idea = ideas[this.index];
		const key = decodeKittyPrintable(data) ?? data;
		this.notice = undefined;
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || key === "q") return this.done(undefined);
		if (matchesKey(data, Key.up) || key === "k") this.index = Math.max(this.index - 1, 0);
		else if (matchesKey(data, Key.down) || key === "j") this.index = Math.min(this.index + 1, Math.max(ideas.length - 1, 0));
		else if (key === "a") {
			this.everything = !this.everything;
			this.index = 0;
		} else if (key === "u") {
			if (!this.undo) this.notice = "nothing to undo";
			else {
				this.source.apply(this.undo);
				this.notice = "undone";
				this.undo = undefined;
			}
		} else if (!idea) return;
		else if (matchesKey(data, Key.enter)) return this.done(idea);
		else if (key === "d") this.change({ idea, status: "done" }, { idea, status: "open" }, `done: ${show(idea.text)}`);
		else if (key === "x") this.change({ idea, status: "dropped" }, { idea, status: "open" }, `dropped: ${show(idea.text)}`);
		else if (key === "m") {
			const target = this.source.moveTarget(idea);
			if (!target) this.notice = "this idea has nowhere else to go";
			else this.change({ idea, scope: target.scope }, { idea, scope: idea.scope }, `moved to ${target.label}: ${show(idea.text)}`);
		} else return;
		this.changed();
	}

	render(width: number): string[] {
		if (width === this.cacheWidth) return this.cache;
		this.cache = this.build(Math.max(width, 10)).map((line) => truncateToWidth(line, width, ""));
		this.cacheWidth = width;
		return this.cache;
	}

	private where(idea: Idea): string {
		if (this.everything) return idea.scope === "harness" ? "harness" : idea.at.project;
		return this.source.harnessView ? idea.at.project : "";
	}

	private row(idea: Idea, selected: boolean, width: number): string {
		const t = this.theme;
		const right = [this.where(idea), age(idea.ts, this.now())].filter(Boolean).join(" · ");
		const kind = idea.kind === "idea" ? "" : `${idea.kind} `;
		const room = Math.max(width - 4 - visibleWidth(right) - 2, 4);
		const text = truncateToWidth(kind + show(idea.text), room, "…");
		const styled = kind && text.startsWith(kind) ? t.fg("warning", kind) + text.slice(kind.length) : text;
		const gap = " ".repeat(Math.max(width - 4 - visibleWidth(text) - visibleWidth(right), 1));
		const line = `${selected ? t.fg("accent", "› ") : "  "}${selected ? t.bold(styled) : styled}${gap}${t.fg("dim", right)}`;
		return ` ${line}`;
	}

	private detail(idea: Idea): string {
		const when = idea.ts.slice(0, 16).replace("T", " ");
		const code = idea.at.commit ? `${idea.at.branch ?? "?"}@${idea.at.commit}${idea.at.dirty ? "*" : ""}` : "";
		const parts = [`#${idea.id}`, when, code, idea.lastPrompt ? `while: ${show(idea.lastPrompt)}` : ""];
		return parts.filter(Boolean).join(" · ");
	}

	private build(width: number): string[] {
		const t = this.theme;
		const ideas = this.visible();
		const lines = [t.fg("accent", "─".repeat(width)), ` ${t.fg("accent", t.bold(`${this.source.title(this.everything)} · ${ideas.length} open`))}`, ""];
		if (!ideas.length) lines.push(`   ${t.fg("muted", this.everything ? "No open ideas anywhere." : "No open ideas here. /idea <text> saves one.")}`);
		const first = Math.min(Math.max(this.index - Math.floor(VISIBLE_ROWS / 2), 0), Math.max(ideas.length - VISIBLE_ROWS, 0));
		for (let i = first; i < Math.min(first + VISIBLE_ROWS, ideas.length); i++) lines.push(this.row(ideas[i]!, i === this.index, width));
		if (ideas.length > VISIBLE_ROWS) lines.push(`   ${t.fg("dim", `${this.index + 1} of ${ideas.length}`)}`);
		lines.push("");
		const current = ideas[this.index];
		if (current) lines.push(`   ${t.fg("muted", this.detail(current))}`);
		if (this.notice) lines.push(`   ${t.fg("success", this.notice)}`);
		const move = current && this.source.moveTarget(current);
		const keys = ["enter start", "d done", "x drop", move ? `m → ${move.label}` : "", "u undo", this.everything ? "a back" : "a all projects", "esc close"];
		lines.push(`   ${t.fg("dim", keys.filter(Boolean).join(" · "))}`);
		lines.push(t.fg("accent", "─".repeat(width)));
		return lines;
	}
}
