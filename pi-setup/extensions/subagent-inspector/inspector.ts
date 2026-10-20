/**
 * the inspector: a list of sub-agent runs, and a full-screen transcript for
 * whichever one you open.
 *
 * the detail view deliberately renders through pi's OWN components
 * (Markdown/Text via Container) rather than hand-drawn box chrome, so a
 * sub-agent's transcript looks like the parent agent's transcript — same
 * markdown, same tool-line shape, same colours. going "inside" a sub-agent
 * should not feel like opening a different program.
 *
 * read-only by design. it observes the transcripts the sub-agent tools
 * already report; it never writes files, never resumes a child, and never
 * talks back to a running process.
 *
 * RENDERING CONTRACT (see AGENTS.md, "TUI Width Desync Fix")
 * every line this component emits is (1) built from normalizeForDisplay()'d
 * text and (2) truncated to the render width as a final net. a single
 * over-wide line desyncs the whole TUI.
 */

import { getMarkdownTheme, type Theme } from "@mariozechner/pi-coding-agent";
import {
	type Component,
	Container,
	type Focusable,
	Key,
	Markdown,
	matchesKey,
	Text,
	truncateToWidth,
	TruncatedText,
	visibleWidth,
} from "@mariozechner/pi-tui";
import { normalizeForDisplay } from "../tools/lib/box-format";
import { formatDuration, formatUsageStats, modelLabel, toolArgSummary } from "../tools/lib/sub-agent-render";
import { buildTranscript, type TranscriptNode } from "./transcript";
import type { AgentEntry } from "./types";

/** tool result lines shown per result before collapsing, unless full mode. */
const RESULT_PREVIEW_LINES = 12;
const MIN_BODY_ROWS = 6;
const MAX_BODY_ROWS = 200;
/**
 * one header row + one footer row. every view emits exactly
 * `bodyRows() + CHROME_ROWS` lines, which equals the terminal height, so the
 * overlay covers the screen completely instead of interleaving with the chat.
 */
const CHROME_ROWS = 2;

type Mode = "list" | "detail";

function terminalRows(): number {
	const rows = process.stdout.rows;
	return typeof rows === "number" && rows > 0 ? rows : 24;
}

function bodyRows(): number {
	return Math.max(MIN_BODY_ROWS, Math.min(MAX_BODY_ROWS, terminalRows() - CHROME_ROWS));
}

export function elapsedOf(entry: AgentEntry, now: number): string {
	return formatDuration((entry.endedAt ?? now) - entry.startedAt);
}

/**
 * pi's markdown theme is only available once initTheme() has run. that is
 * always true inside an interactive session, but a throw from render() would
 * take the whole TUI down, so failure degrades to plain text instead.
 */
function resolveMarkdownTheme(): unknown {
	try {
		return getMarkdownTheme();
	} catch {
		return undefined;
	}
}

export class SubAgentInspector implements Component, Focusable {
	private mode: Mode = "list";
	private selected = 0;
	private scroll = 0;
	/** last scroll offset actually rendered; resolves the "pin to bottom" sentinel. */
	private lastScroll = 0;
	private fullResults = false;
	private cachedLines?: string[];
	private cachedWidth?: number;
	/** rendered transcript cache — markdown parsing is too slow to redo per keystroke. */
	private bodyCacheKey?: string;
	private bodyCache?: string[];

	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
	}

	constructor(
		private readonly entries: () => AgentEntry[],
		private readonly theme: Theme,
		private readonly done: (result: null) => void,
		private readonly now: () => number = Date.now,
	) {}

	// ── input ────────────────────────────────────────────────────────────

	handleInput(data: string): void {
		const list = this.entries();

		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			if (this.mode === "detail") {
				this.mode = "list";
				this.invalidate();
				return;
			}
			this.done(null);
			return;
		}

		if (this.mode === "list") {
			this.handleListInput(data, list);
			return;
		}
		this.handleDetailInput(data, list);
	}

	private handleListInput(data: string, list: AgentEntry[]): void {
		if (matchesKey(data, Key.up)) {
			this.selected = Math.max(0, this.selected - 1);
			this.invalidate();
		} else if (matchesKey(data, Key.down)) {
			this.selected = Math.min(Math.max(0, list.length - 1), this.selected + 1);
			this.invalidate();
		} else if (matchesKey(data, Key.enter) && list.length > 0) {
			this.mode = "detail";
			this.scroll = Number.POSITIVE_INFINITY; // start at the newest activity
			this.invalidate();
		}
	}

	private handleDetailInput(data: string, list: AgentEntry[]): void {
		const page = bodyRows();

		if (matchesKey(data, Key.up)) this.scrollBy(-1);
		else if (matchesKey(data, Key.down)) this.scrollBy(1);
		else if (matchesKey(data, Key.pageUp)) this.scrollBy(-page);
		else if (matchesKey(data, Key.pageDown)) this.scrollBy(page);
		else if (matchesKey(data, Key.home)) this.scrollTo(0);
		else if (matchesKey(data, Key.end)) this.scrollTo(Number.POSITIVE_INFINITY);
		else if (matchesKey(data, Key.left)) this.switchAgent(-1, list);
		else if (matchesKey(data, Key.right)) this.switchAgent(1, list);
		else if (data === "f" || data === "F") {
			this.fullResults = !this.fullResults;
			this.invalidate();
		}
	}

	private scrollBy(delta: number): void {
		this.scroll = Math.max(0, this.resolvedScroll() + delta);
		this.invalidate();
	}

	private scrollTo(value: number): void {
		this.scroll = value;
		this.invalidate();
	}

	private switchAgent(delta: number, list: AgentEntry[]): void {
		if (list.length === 0) return;
		this.selected = (this.selected + delta + list.length) % list.length;
		this.scroll = Number.POSITIVE_INFINITY;
		this.invalidate();
	}

	/**
	 * Infinity is the sentinel for "pin to bottom". a relative scroll must
	 * start from the offset that was last rendered, otherwise pressing up
	 * while pinned would jump to the top instead of moving one line.
	 */
	private resolvedScroll(): number {
		return Number.isFinite(this.scroll) ? this.scroll : this.lastScroll;
	}

	// ── render ───────────────────────────────────────────────────────────

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const lines = this.mode === "list" ? this.renderList(width) : this.renderDetail(width);

		// every row is padded to the full width so the overlay fully occludes
		// the conversation behind it — a short line would let the parent
		// transcript show through on the right.
		const padded = lines.map((line) => {
			const safe = truncateToWidth(line, width);
			return safe + " ".repeat(Math.max(0, width - visibleWidth(safe)));
		});

		this.cachedLines = padded;
		this.cachedWidth = width;
		return padded;
	}

	invalidate(): void {
		this.cachedLines = undefined;
		this.cachedWidth = undefined;
		this.bodyCacheKey = undefined;
	}

	// ── list view ────────────────────────────────────────────────────────

	private renderList(width: number): string[] {
		const th = this.theme;
		const list = this.entries();
		const out: string[] = [];
		const rows = bodyRows();

		out.push(
			th.fg("toolTitle", th.bold(" sub-agents")) +
				th.fg("dim", ` · ${list.length} in this session`),
		);
		out.push("");

		if (list.length === 0) {
			out.push(th.fg("muted", "   nothing yet — sub-agents appear here as soon as they start"));
		} else {
			this.selected = Math.min(this.selected, list.length - 1);
			const offset = Math.max(
				0,
				Math.min(this.selected - Math.floor(rows / 2), list.length - rows),
			);
			const visible = list.slice(offset, offset + rows);

			if (offset > 0) out.push(th.fg("dim", `   ↑ ${offset} more`));
			visible.forEach((entry, index) => {
				out.push(this.listRow(entry, offset + index === this.selected, width));
			});
			const remaining = list.length - (offset + visible.length);
			if (remaining > 0) out.push(th.fg("dim", `   ↓ ${remaining} more`));
		}

		// fill to the same height as the detail view so the overlay always
		// occupies the whole screen — a short overlay lets the conversation
		// behind it show through and the two interleave.
		while (out.length < rows + CHROME_ROWS - 1) out.push("");
		out.push(th.fg("dim", " ↑↓ move • enter open • esc close"));
		return out;
	}

	private listRow(entry: AgentEntry, isSelected: boolean, innerWidth: number): string {
		const th = this.theme;
		const pointer = isSelected ? th.fg("accent", "❯ ") : "  ";
		const name = isSelected
			? th.fg("accent", th.bold(entry.toolName))
			: th.fg("toolTitle", entry.toolName);
		const elapsed = elapsedOf(entry, this.now());
		const meta = th.fg("dim", `${elapsed}${entry.messages.length ? ` · ${entry.messages.length} msg` : ""}`);
		const label = th.fg("text", normalizeForDisplay(entry.label));
		return truncateToWidth(
			`${pointer}${this.statusIcon(entry)} ${name}  ${label}  ${meta}`,
			innerWidth,
		);
	}

	private statusIcon(entry: AgentEntry): string {
		const th = this.theme;
		if (entry.status === "running") return th.fg("warning", "⋯");
		return entry.status === "error" ? th.fg("error", "✕") : th.fg("success", "✓");
	}

	// ── detail view ──────────────────────────────────────────────────────

	private renderDetail(width: number): string[] {
		const th = this.theme;
		const list = this.entries();
		const entry = list[this.selected];

		if (!entry) {
			return [th.fg("muted", " sub-agent gone"), "", th.fg("dim", " esc back")];
		}

		const body = this.bodyLines(entry, width);
		const rows = bodyRows();
		const maxScroll = Math.max(0, body.length - rows);
		const scroll = Math.min(Number.isFinite(this.scroll) ? this.scroll : maxScroll, maxScroll);
		this.scroll = scroll;
		this.lastScroll = scroll;

		const out: string[] = [this.detailHeader(entry, width)];
		out.push(...body.slice(scroll, scroll + rows));
		for (let i = body.slice(scroll, scroll + rows).length; i < rows; i++) out.push("");
		out.push(this.detailFooter(list, scroll, maxScroll));
		return out;
	}

	private detailHeader(entry: AgentEntry, width: number): string {
		const th = this.theme;
		const usage = entry.usage ? formatUsageStats(entry.usage, modelLabel(entry)) : "";
		const head =
			`${this.statusIcon(entry)} ${th.fg("toolTitle", th.bold(entry.toolName))} ` +
			th.fg("text", normalizeForDisplay(entry.label));
		const meta = th.fg("dim", [elapsedOf(entry, this.now()), usage].filter(Boolean).join(" · "));
		const gap = width - visibleWidth(head) - visibleWidth(meta) - 2;
		return gap > 1
			? ` ${head}${" ".repeat(gap)}${meta}`
			: truncateToWidth(` ${head}`, width);
	}

	private detailFooter(
		list: AgentEntry[],
		scroll: number,
		maxScroll: number,
	): string {
		const th = this.theme;
		const position = list.length > 1 ? `←→ agent ${this.selected + 1}/${list.length} • ` : "";
		const percent = maxScroll === 0 ? "100%" : `${Math.round((scroll / maxScroll) * 100)}%`;
		const results = this.fullResults ? "full" : "trimmed";
		return th.fg("dim", ` ↑↓ scroll ${percent} • ${position}f results:${results} • esc back`);
	}

	/**
	 * render the transcript through pi's OWN components so it matches the
	 * parent view: Markdown for assistant prose, wrapped Text for thinking and
	 * tool results, a TruncatedText tool line per call.
	 *
	 * cached because re-parsing markdown for a long transcript on every
	 * keystroke is wasteful; the key covers everything that changes the output.
	 */
	private bodyLines(entry: AgentEntry, width: number): string[] {
		const key = `${entry.toolCallId}|${entry.messages.length}|${entry.status}|${this.fullResults}|${width}`;
		if (this.bodyCacheKey === key && this.bodyCache) return this.bodyCache;

		const th = this.theme;
		const fg = th.fg.bind(th);
		const container = new Container();
		const mdTheme = resolveMarkdownTheme();
		const nodes = buildTranscript(entry.messages, { includeToolResults: true });

		for (const node of nodes) this.addNode(container, node, fg, mdTheme);

		if (container.children.length === 0) {
			container.addChild(
				new Text(
					fg("muted", entry.status === "running" ? " starting up…" : " (no transcript)"),
					1,
					0,
				),
			);
		}

		const lines = container.render(width);
		this.bodyCacheKey = key;
		this.bodyCache = lines;
		return lines;
	}

	private addNode(
		container: Container,
		node: TranscriptNode,
		fg: (color: string, text: string) => string,
		mdTheme: unknown,
	): void {
		const th = this.theme;
		switch (node.kind) {
			case "user":
				container.addChild(new Text(fg("muted", "task"), 1, 1));
				container.addChild(this.prose(node.text, 1, 0, mdTheme));
				return;
			case "thinking":
				container.addChild(new Text(fg("dim", "Thinking:"), 1, 1));
				container.addChild(new Text(fg("dim", normalizeForDisplay(node.text)), 1, 0));
				return;
			case "text":
				container.addChild(this.prose(node.text, 1, 1, mdTheme));
				return;
			case "toolCall": {
				const icon =
					node.isError === true
						? fg("error", "✕")
						: node.isError === false
							? fg("success", "✓")
							: fg("muted", "⋯");
				const label = node.name.charAt(0).toUpperCase() + node.name.slice(1);
				container.addChild(
					new TruncatedText(
						`${icon} ${fg("accent", th.bold(label))} ` +
							fg("dim", normalizeForDisplay(toolArgSummary(node.name, node.args))),
						1,
						1,
					),
				);
				return;
			}
			case "toolResult": {
				const all = node.text.split("\n");
				const shown = this.fullResults ? all : all.slice(0, RESULT_PREVIEW_LINES);
				const colour = node.isError ? "error" : "dim";
				container.addChild(
					new Text(fg(colour, normalizeForDisplay(shown.join("\n"))), 3, 0),
				);
				const hidden = all.length - shown.length;
				if (hidden > 0) {
					container.addChild(new Text(fg("muted", `… ${hidden} more lines (f)`), 3, 0));
				}
				return;
			}
		}
	}

	/**
	 * assistant/user prose. rendered as markdown so it matches the parent
	 * transcript; falls back to wrapped plain text when no markdown theme is
	 * available (see resolveMarkdownTheme).
	 */
	private prose(text: string, paddingX: number, paddingY: number, mdTheme: unknown): Component {
		const clean = normalizeForDisplay(text);
		if (!mdTheme) return new Text(this.theme.fg("text", clean), paddingX, paddingY);
		try {
			return new Markdown(clean, paddingX, paddingY, mdTheme as never);
		} catch {
			return new Text(this.theme.fg("text", clean), paddingX, paddingY);
		}
	}
}
