import { truncateToWidth, visibleWidth, type Component, type Focusable } from "@mariozechner/pi-tui";
import type { RunSnapshot } from "../tools/lib/agent-channel";
import type { Styler } from "../tools/lib/agent-layout";
import { STATUS_STYLE } from "../tools/lib/agent-style";
import { normalizeForDisplay } from "../tools/lib/box-format";
import { Picker, type PickerAction } from "./picker";
import { noticeExpiry, planColumns, renderRow } from "./rows";
import { dockOrder, isLive, type Clock, type RunStore } from "./store";

export const DOCK_MAX_ROWS = 6;
const FINISHED_ROWS = 3;
export const IDLE_REMOVAL_MS = 10 * 60_000;

type DockMode = "hidden" | "full" | "sentence";

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

/**
 * The strip above the editor: one row per background agent while any runs, one
 * sentence once they have all finished, gone ten minutes later. Lines are
 * cached per width and rebuilt only when a run, the clock frame or the
 * selection changed, so an idle dock costs nothing per frame.
 */
export class Dock implements Component, Focusable {
	private periodStart = 0;
	private idleSince: number | undefined;
	private dismissed = new Set<string>();
	private cancelIdle: (() => void) | undefined;
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

	mode(): DockMode {
		if (this.store.live().length > 0) return "full";
		return this.idleSince !== undefined && this.clock.now() - this.idleSince < IDLE_REMOVAL_MS ? "sentence" : "hidden";
	}

	handleInput(data: string): void {
		if (this.mode() !== "full") return this.host.blur();
		this.picker.handleInput(data);
		this.touch();
	}

	invalidate(): void {
		this.cache = undefined;
	}

	dispose(): void {
		this.unsubscribe();
		this.cancelIdle?.();
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
		const live = this.store.live().length;
		if (live > 0) {
			if (this.idleSince !== undefined || this.periodStart === 0) this.periodStart = this.clock.now();
			this.idleSince = undefined;
			this.cancelIdle?.();
			this.cancelIdle = undefined;
		} else if (this.periodStart > 0 && this.idleSince === undefined) {
			this.idleSince = this.clock.now();
			this.cancelIdle = this.host.later(() => {
				this.cancelIdle = undefined;
				this.host.blur();
				this.touch();
			}, IDLE_REMOVAL_MS);
		}
		if (this.focused && this.mode() !== "full") this.host.blur();
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
		const lines = mode === "hidden" || width < 12 ? [] : mode === "sentence" ? this.sentence(width) : this.panel(width);
		this.cache = { key, width, lines };
		return lines;
	}

	private sentence(width: number): string[] {
		const finished = this.shown();
		if (finished.length === 0) return [];
		const count = (status: RunSnapshot["status"]) => countOf(finished, status);
		const allDone = count("done") === finished.length;
		const failed = count("failed");
		const icon = this.theme.fg(allDone ? "success" : failed > 0 ? "error" : "warning", allDone ? "✓" : failed > 0 ? "✕" : "■");
		const what =
			finished.length === 1
				? `${normalizeForDisplay(finished[0]!.agent)} ${STATUS_STYLE[finished[0]!.status].verb}`
				: allDone
					? `${finished.length} agents finished`
					: (["done", "failed", "stopped", "interrupted"] as const)
							.filter((status) => count(status) > 0)
							.map((status) => `${count(status)} ${STATUS_STYLE[status].verb}`)
							.join(", ");
		return [truncateToWidth(` ${icon} ${what}${this.theme.fg("dim", "  ↓ to review")}`, width)];
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
			lines.push(renderRow(run, cols, inner, this.theme, this.clock, { selected: this.focused && run.id === this.picker.current()?.id, dim: !isLive(run) }));
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

	private summary(runs: RunSnapshot[], width: number): string {
		const counts = SUMMARY_ORDER.map((status) => ({ status, n: countOf(runs, status) }))
			.filter(({ n }) => n > 0)
			.map(({ status, n }) => this.theme.fg(STATUS_STYLE[status].color, `${n} ${status === "done" ? "done" : STATUS_STYLE[status].verb}`))
			.join(this.theme.fg("dim", " · "));
		for (const hint of this.hints()) {
			const line = `${counts}   ${hint}`;
			if (visibleWidth(line) <= width) return line;
		}
		return counts;
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
		return [dim("↓ manage")];
	}
}
