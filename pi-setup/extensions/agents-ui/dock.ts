import { truncateToWidth, visibleWidth, type Component, type Focusable } from "@mariozechner/pi-tui";
import type { RunSnapshot, RunStatus } from "../tools/lib/agent-channel";
import type { Styler } from "../tools/lib/agent-layout";
import { identityColor, STATUS_STYLE } from "../tools/lib/agent-style";
import { formatDuration } from "../tools/lib/sub-agent-render";
import type { DockView } from "./dock-view";
import { Picker, type PickerAction } from "./picker";
import { elapsedMs, noticeExpiry, planColumns, renderRow, SPINNER } from "./rows";
import { dockOrder, isLive, type Clock, type RunStore } from "./store";

export const DOCK_MAX_ROWS = 6;
const FINISHED_ROWS = 3;

type DockMode = "hidden" | Exclude<DockView, "off">;

export interface DockHost {
	requestRender(): void;
	focus(): void;
	blur(): void;
	act(action: PickerAction): void;
	/** runs `fn` after `ms`; returns the way to cancel it. */
	later(fn: () => void, ms: number): () => void;
}

const dismissalKey = (run: RunSnapshot) => `${run.id}@${run.endedAt ?? "live"}`;

const countOf = (runs: readonly RunSnapshot[], status: RunSnapshot["status"]) => runs.filter((run) => run.status === status).length;

const SUMMARY_ORDER = ["running", "queued", "done", "failed", "stopped", "interrupted"] as const;

/** The counts are muted; only an outcome that needs a look keeps its colour. */
const SUMMARY_ALERT: Partial<Record<RunStatus, string>> = { failed: STATUS_STYLE.failed.color, interrupted: STATUS_STYLE.interrupted.color };
const HINT_GAP = 3;

/** `chad ×3, oracle`: the agents at work, in dock order, each in its own colour. */
function agentsAtWork(runs: readonly RunSnapshot[], theme: Styler): string {
	const counts = new Map<string, number>();
	for (const run of runs) counts.set(run.agent, (counts.get(run.agent) ?? 0) + 1);
	return [...counts].map(([agent, n]) => theme.fg(identityColor(agent), n > 1 ? `${agent} ×${n}` : agent)).join(theme.fg("dim", ", "));
}

/**
 * The strip under the editor while any background agent runs, nothing once they
 * have all finished (/agents lists them). Folded to one grey line in the "line"
 * view; the rows show while it has the focus, or always in the "full" view, where
 * they stay quiet until focused. Lines are cached per width and rebuilt only when
 * a run, the clock frame, the view or the selection changed, so an idle dock costs
 * nothing per frame.
 */
export class Dock implements Component, Focusable {
	private shownAs: DockView = "line";
	private periodStart = 0;
	private wasLive = false;
	private dismissed = new Set<string>();
	private cancelNotice: (() => void) | undefined;
	private revision = 0;
	private readonly unsubscribe: () => void;
	private cache: { key: string; width: number; lines: string[] } | undefined;
	readonly picker: Picker;

	constructor(
		private readonly store: RunStore,
		private readonly clock: Clock,
		private readonly theme: Styler,
		private readonly host: DockHost,
	) {
		this.picker = new Picker(() => this.shown(), (action) => this.onAction(action), true, clock.now);
		this.unsubscribe = store.subscribe(() => this.onStoreChange());
	}

	get focused(): boolean {
		return this.picker.focused;
	}

	set focused(value: boolean) {
		this.picker.focused = value;
		this.touch();
	}

	get view(): DockView {
		return this.shownAs;
	}

	set view(value: DockView) {
		if (value === this.shownAs) return;
		this.shownAs = value;
		if (this.focused && this.mode() === "hidden") this.host.blur();
		this.touch();
	}

	mode(): DockMode {
		return this.shownAs === "off" || this.store.live().length === 0 ? "hidden" : this.shownAs;
	}

	handleInput(data: string): void {
		if (this.mode() === "hidden") return this.host.blur();
		this.picker.handleInput(data);
		this.touch();
	}

	invalidate(): void {
		this.cache = undefined;
	}

	dispose(): void {
		this.unsubscribe();
		this.cancelNotice?.();
	}

	private touch(): void {
		this.revision++;
		this.host.requestRender();
	}

	private onAction(action: PickerAction): void {
		if (action.type === "dismiss") {
			const run = this.store.get(action.id);
			if (run) this.dismissed.add(dismissalKey(run));
			this.touch();
			if (this.shown().length === 0) this.host.blur();
		} else {
			this.host.act(action);
		}
	}

	private onStoreChange(): void {
		const live = this.store.live().length > 0;
		if (live && !this.wasLive) this.periodStart = this.clock.now();
		this.wasLive = live;
		if (this.focused && this.mode() === "hidden") this.host.blur();
		const expiry = noticeExpiry(this.store.all(), this.clock.now());
		this.cancelNotice?.();
		this.cancelNotice = expiry === undefined ? undefined : this.host.later(() => this.touch(), expiry - this.clock.now() + 50);
		this.host.requestRender();
	}

	/** this period's background runs, in dock order, without what the user dismissed. */
	private shown(): RunSnapshot[] {
		const mine = this.store.background().filter((run) => !this.dismissed.has(dismissalKey(run)) && (isLive(run) || (run.endedAt ?? 0) >= this.periodStart));
		const live = dockOrder(mine.filter(isLive));
		const finished = dockOrder(mine.filter((run) => !isLive(run))).slice(0, FINISHED_ROWS);
		return [...live, ...finished];
	}

	render(width: number): string[] {
		const mode = this.mode();
		const key = `${mode}|${this.store.version}|${this.picker.version}|${this.revision}|${this.clock.frame}`;
		if (this.cache?.key === key && this.cache.width === width) return this.cache.lines;
		const lines = mode === "hidden" || width < 12 ? [] : mode === "line" && !this.focused ? [this.line(width)] : this.panel(width);
		this.cache = { key, width, lines };
		return lines;
	}

	/** `◐ 4 working · chad ×3, oracle · 1m56s      ↓ manage`: the glyph and the names in colour, no bold. */
	private line(width: number): string {
		const inner = width - 1;
		const runs = this.shown();
		const live = runs.filter(isLive);
		const now = this.clock.now();
		const running = live.some((run) => run.status === "running");
		const glyph = running
			? this.theme.fg(STATUS_STYLE.running.color, SPINNER[this.clock.frame % SPINNER.length]!)
			: this.theme.fg(STATUS_STYLE.queued.color, STATUS_STYLE.queued.icon);
		const longest = Math.max(...live.map((run) => elapsedMs(run, now)));
		const dot = this.theme.fg("dim", " · ");
		const detail = `${agentsAtWork(live, this.theme)}${dot}${this.theme.fg("muted", formatDuration(longest))}`;
		return ` ${truncateToWidth(`${glyph} ${this.summary(runs, inner - 2, detail)}`, inner)}`;
	}

	private panel(width: number): string[] {
		const inner = width - 1;
		const runs = this.shown();
		const selectedAt = this.focused ? this.picker.index() : 0;
		const start = Math.max(0, Math.min(selectedAt - DOCK_MAX_ROWS + 1, runs.length - DOCK_MAX_ROWS));
		const window = runs.slice(start, start + DOCK_MAX_ROWS);
		const now = this.clock.now();
		const cols = planColumns(window, inner, now);
		const lines = [this.summary(runs, inner)];
		for (const run of window) {
			lines.push(renderRow(run, cols, inner, this.theme, this.clock, { selected: this.focused && run.id === this.picker.current()?.id, dim: !isLive(run), quiet: !this.focused }));
		}
		const above = start;
		const below = runs.length - start - window.length;
		if (above > 0 || below > 0) {
			const parts = [above > 0 ? `↑ ${above} more` : "", below > 0 ? `+${below} more` : ""].filter(Boolean);
			lines.push(this.theme.fg("dim", `  ${parts.join(" · ")}`));
		}
		const compose = this.picker.compose;
		if (compose) lines.push(...compose.input.render(inner));
		return lines.map((line) => ` ${truncateToWidth(line, inner)}`);
	}

	/** `2 working · 1 done      ↓ manage`: counts (and the painted `detail`) on the left, the hint flush right with the row columns. */
	private summary(runs: RunSnapshot[], width: number, detail = ""): string {
		const counts = SUMMARY_ORDER.map((status) => ({ status, n: countOf(runs, status) }))
			.filter(({ n }) => n > 0)
			.map(({ status, n }) => this.theme.fg(SUMMARY_ALERT[status] ?? "muted", `${n} ${status === "done" ? "done" : STATUS_STYLE[status].verb}`))
			.join(this.theme.fg("dim", " · "));
		const left = detail ? counts + this.theme.fg("dim", " · ") + detail : counts;
		const used = visibleWidth(left);
		for (const hint of this.hints()) {
			const gap = width - used - visibleWidth(hint);
			if (gap >= HINT_GAP) return left + " ".repeat(gap) + hint;
		}
		return left;
	}

	private hints(): string[] {
		const dim = (text: string) => this.theme.fg("dim", text);
		if (this.picker.notice) return [this.theme.fg("warning", this.picker.notice)];
		if (this.picker.compose) return [dim("enter send · esc cancel")];
		if (this.focused) {
			return [
				dim("↑↓ select · enter open · s steer · c continue · x stop · X stop all · esc back"),
				dim("↑↓ · enter · s · c · x · X · esc"),
				dim("esc back"),
			];
		}
		return [this.theme.fg("muted", "↓ manage")];
	}
}
