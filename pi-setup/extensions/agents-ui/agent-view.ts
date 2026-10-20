import { Input, Key, matchesKey, truncateToWidth, type Component, type Focusable } from "@mariozechner/pi-tui";
import type { RunSnapshot } from "../tools/lib/agent-channel";
import { justify, type Styler } from "../tools/lib/agent-layout";
import { identityColor, STATUS_STYLE } from "../tools/lib/agent-style";
import { normalizeForDisplay } from "../tools/lib/box-format";
import { formatDuration } from "../tools/lib/sub-agent-render";
import { bodyRows, fitHint, frameScreen, innerWidth } from "./frame";
import { controlNotice, elapsedMs, modelText, SPINNER } from "./rows";
import { isLive, type Clock, type RunStore } from "./store";
import { TranscriptRenderer } from "./transcript";

export interface ViewActions {
	steer(id: string, text: string): void;
	continueRun(id: string, text: string): void;
	stop(id: string): void;
}

export type ViewResult = "closed";

const PAGE_OVERLAP = 2;

/**
 * One agent, full screen: its own conversation as the main chat draws it, live
 * while it runs, with a line to steer it (or continue it once it has finished).
 * The line always takes typing, so every action sits on a key no message starts
 * with; nothing from the main session reaches through.
 */
export class AgentView implements Component, Focusable {
	focused = false;
	private version = 0;
	private top = 0;
	private follow = true;
	private fullResults = false;
	private readonly input = new Input({ prompt: "▸ " });
	private readonly transcript: TranscriptRenderer;
	private bodyHeight = 1;
	private cache: { key: string; lines: string[] } | undefined;
	private body: { key: string; lines: string[] } | undefined;

	constructor(
		private id: string,
		private readonly store: RunStore,
		private readonly clock: Clock,
		private readonly theme: Styler,
		private readonly actions: ViewActions,
		private readonly size: () => { rows: number },
		private readonly close: (result: ViewResult) => void,
	) {
		this.transcript = new TranscriptRenderer(theme);
	}

	get viewing(): string {
		return this.id;
	}

	invalidate(): void {
		this.cache = undefined;
		this.body = undefined;
	}

	handleInput(data: string): void {
		this.version++;
		const run = this.store.get(this.id);
		const empty = this.input.getValue() === "";
		if (matchesKey(data, Key.escape)) this.close("closed");
		else if (matchesKey(data, Key.ctrl("c"))) {
			if (run && isLive(run) && !run.stopping) this.actions.stop(run.id);
		} else if (matchesKey(data, Key.ctrl("o"))) this.fullResults = !this.fullResults;
		else if (matchesKey(data, Key.enter)) this.send();
		else if (matchesKey(data, Key.up)) this.scrollBy(-1);
		else if (matchesKey(data, Key.down)) this.scrollBy(1);
		else if (matchesKey(data, Key.pageUp)) this.scrollBy(-(this.bodyHeight - PAGE_OVERLAP));
		else if (matchesKey(data, Key.pageDown)) this.scrollBy(this.bodyHeight - PAGE_OVERLAP);
		else if (empty && matchesKey(data, Key.home)) this.pauseAt(0);
		else if (empty && matchesKey(data, Key.end)) this.follow = true;
		else if (empty && (matchesKey(data, Key.left) || matchesKey(data, Key.right))) this.switchTo(matchesKey(data, Key.right) ? 1 : -1);
		else this.input.handleInput(data);
	}

	private scrollBy(delta: number): void {
		this.follow = false;
		this.top = Math.max(0, this.top + delta);
	}

	private pauseAt(top: number): void {
		this.follow = false;
		this.top = top;
	}

	private switchTo(step: 1 | -1): void {
		const next = this.store.neighbour(this.id, step);
		if (!next || next === this.id) return;
		this.id = next;
		this.follow = true;
		this.top = 0;
	}

	private send(): void {
		const text = this.input.getValue().trim();
		const run = this.store.get(this.id);
		if (!text || !run) return;
		this.input.setValue("");
		this.follow = true;
		if (isLive(run)) this.actions.steer(run.id, text);
		else this.actions.continueRun(run.id, text);
	}

	render(width: number): string[] {
		const { rows } = this.size();
		const run = this.store.get(this.id);
		const key = `${width}|${rows}|${this.store.version}|${this.clock.frame}|${this.version}|${this.id}|${this.focused}`;
		if (this.cache?.key === key) return this.cache.lines;
		this.input.focused = this.focused;
		const inner = innerWidth(width);
		this.bodyHeight = bodyRows(rows);
		const lines = run ? this.screen(run, width, inner, rows) : frameScreen({ title: "", body: [this.theme.fg("muted", "that agent is gone")], input: "", hints: this.theme.fg("dim", "esc close") }, width, rows, this.theme);
		this.cache = { key, lines };
		return lines;
	}

	private screen(run: RunSnapshot, width: number, inner: number, rows: number): string[] {
		const all = this.bodyLines(run, inner);
		const maxTop = Math.max(0, all.length - this.bodyHeight);
		if (this.follow) this.top = maxTop;
		this.top = Math.min(this.top, maxTop);
		if (!this.follow && this.top >= maxTop) this.follow = true;
		return frameScreen(
			{ title: this.title(run, inner), body: all.slice(this.top, this.top + this.bodyHeight), input: this.inputRow(run, inner), hints: this.hints(run, maxTop, inner) },
			width,
			rows,
			this.theme,
		);
	}

	private bodyLines(run: RunSnapshot, inner: number): string[] {
		const key = `${run.id}|${inner}|${this.fullResults}|${run.messages.length}|${run.status}|${run.errorMessage ?? ""}`;
		if (this.body?.key === key) return this.body.lines;
		const { theme } = this;
		const lines = this.transcript.lines(run.messages, inner, { full: this.fullResults });
		if (lines.length === 0) lines.push(theme.fg("muted", isLive(run) ? "starting up…" : "(no transcript)"));
		if (!isLive(run) && run.errorMessage && run.status !== "done") lines.push("", ...normalizeForDisplay(run.errorMessage).split("\n").map((line) => theme.fg("error", line)));
		this.body = { key, lines };
		return lines;
	}

	private title(run: RunSnapshot, inner: number): string {
		const { theme } = this;
		const style = STATUS_STYLE[run.status];
		const glyph = run.status === "running" && !run.stopping ? SPINNER[this.clock.frame % SPINNER.length]! : style.icon;
		const model = modelText(run);
		const left = `${theme.fg(run.stopping ? "error" : style.color, glyph)} ${theme.fg(identityColor(run.agent), theme.bold(run.agent))}  ${theme.bold(normalizeForDisplay(run.label))}${model ? theme.fg("dim", `  ${model}`) : ""}`;
		const what = run.stopping ? theme.fg("error", "stopping…") : theme.fg("dim", run.status === "running" ? (run.activity ? normalizeForDisplay(run.activity) : "working") : style.verb);
		const right = `${what}${theme.fg("dim", ` · ${formatDuration(elapsedMs(run, this.clock.now()))}`)}`;
		return justify(left, right, inner, 24).line;
	}

	private inputRow(run: RunSnapshot, inner: number): string {
		const line = this.input.render(inner)[0] ?? "";
		if (this.input.getValue() !== "") return truncateToWidth(line, inner);
		const placeholder = isLive(run) ? "type to steer this agent" : "type to continue this agent";
		return truncateToWidth(`${line.trimEnd()}${this.theme.fg("dim", placeholder)}`, inner);
	}

	private hints(run: RunSnapshot, maxTop: number, inner: number): string {
		const { theme } = this;
		const notice = controlNotice(run, this.clock.now());
		if (notice) return theme.fg(notice.ok ? "dim" : "warning", notice.ok ? notice.text : `✗ ${notice.text}`);
		const dim = (text: string) => theme.fg("dim", text);
		const send = `enter ${isLive(run) ? "steer" : "continue"}`;
		const position = this.follow ? "following" : `paused (${Math.max(0, maxTop - this.top)} below) · end follows`;
		const switching = this.store.all().length > 1 ? "←→ agent · " : "";
		const stop = isLive(run) && !run.stopping ? " · ctrl+c stop" : "";
		return fitHint(
			[
				`${send} · ↑↓ scroll · ${switching}ctrl+o ${this.fullResults ? "short" : "full"} results${stop} · esc close · ${position}`,
				`${send} · ↑↓ scroll · ${switching}esc close${stop} · ${this.follow ? "following" : "paused · end follows"}`,
				`${send} · esc close · ${this.follow ? "following" : "paused"}`,
				"esc close",
			],
			inner,
			dim,
		);
	}
}
