import { truncateToWidth, type Component, type Focusable } from "@mariozechner/pi-tui";
import type { RunSnapshot } from "../tools/lib/agent-channel";
import type { Styler } from "../tools/lib/agent-layout";
import { bodyRows, fitHint, frameScreen, innerWidth } from "./frame";
import { Picker, type PickerAction } from "./picker";
import { planColumns, renderRow } from "./rows";
import { dockOrder, isLive, type Clock, type RunStore } from "./store";

type Group = { title: string; runs: RunSnapshot[] };

export function groupRuns(runs: readonly RunSnapshot[], showFinished: boolean): Group[] {
	const groups: Group[] = [
		{ title: "Running", runs: dockOrder(runs.filter((run) => run.status === "running")) },
		{ title: "Queued", runs: dockOrder(runs.filter((run) => run.status === "queued")) },
	];
	if (showFinished) {
		groups.push(
			{ title: "Done", runs: dockOrder(runs.filter((run) => ["done", "failed", "stopped"].includes(run.status))) },
			{ title: "Interrupted", runs: dockOrder(runs.filter((run) => run.status === "interrupted")) },
		);
	}
	return groups.filter((group) => group.runs.length > 0);
}

export type ListResult = { open: string } | { closed: true };

/** Every run of the session in groups, full height, with the dock's keys and `h` to hide what has finished. */
export class ListView implements Component, Focusable {
	focused = false;
	private showFinished = true;
	private version = 0;
	private cache: { key: string; lines: string[] } | undefined;
	readonly picker: Picker;

	constructor(
		private readonly store: RunStore,
		private readonly clock: Clock,
		private readonly theme: Styler,
		act: (action: PickerAction) => void,
		private readonly size: () => { rows: number },
		private readonly close: (result: ListResult) => void,
	) {
		this.picker = new Picker(
			() => groupRuns(this.store.all(), this.showFinished).flatMap((group) => group.runs),
			(action) => {
				if (action.type === "close") this.close({ closed: true });
				else if (action.type === "open") this.close({ open: action.id });
				else act(action);
			},
			false,
			clock.now,
		);
		this.picker.select(groupRuns(store.all(), true)[0]?.runs[0]?.id);
	}

	invalidate(): void {
		this.cache = undefined;
	}

	handleInput(data: string): void {
		this.version++;
		if (!this.picker.compose && data === "h") this.showFinished = !this.showFinished;
		else this.picker.handleInput(data);
	}

	render(width: number): string[] {
		const { rows } = this.size();
		const key = `${width}|${rows}|${this.store.version}|${this.clock.frame}|${this.version}|${this.picker.version}|${this.focused}`;
		if (this.cache?.key === key) return this.cache.lines;
		this.picker.focused = this.focused;
		const inner = innerWidth(width);
		const { theme } = this;
		const groups = groupRuns(this.store.all(), this.showFinished);
		const flat = groups.flatMap((group) => group.runs);
		const cols = planColumns(flat, inner, this.clock.now());
		const selected = this.picker.current()?.id;

		const body: string[] = [];
		let selectedLine = 0;
		for (const group of groups) {
			if (body.length > 0) body.push("");
			body.push(theme.fg("dim", `▾ ${group.title} ${group.runs.length}`));
			for (const run of group.runs) {
				if (run.id === selected) selectedLine = body.length;
				body.push(renderRow(run, cols, inner, theme, this.clock, { selected: run.id === selected, dim: !isLive(run) }));
			}
		}
		if (body.length === 0) body.push(theme.fg("muted", "no agents have run in this session"));

		const visible = bodyRows(rows);
		const start = Math.max(0, Math.min(selectedLine - Math.floor(visible / 2), body.length - visible));
		const window = body.slice(start, start + visible);
		if (start > 0) window[0] = theme.fg("dim", `▲ ${start} more`);
		if (start + visible < body.length) window[window.length - 1] = theme.fg("dim", `▼ ${body.length - start - visible} more`);

		const live = flat.filter(isLive).length;
		const title = `${theme.bold("agents")}${theme.fg("dim", `  ${this.store.all().length} in this session · ${live} live`)}`;
		const compose = this.picker.compose;
		const input = compose ? truncateToWidth(compose.input.render(inner)[0] ?? "", inner) : "";
		const hints = this.picker.notice
			? theme.fg("warning", this.picker.notice)
			: compose
				? theme.fg("dim", "enter send · esc cancel")
				: fitHint(
						[
							`↑↓ · enter open · s steer · c continue · x stop · X stop all · h ${this.showFinished ? "hide" : "show"} finished · esc close`,
							"↑↓ · enter · s · c · x · X · h · esc",
							"esc close",
						],
						inner,
						(text) => theme.fg("dim", text),
					);
		const lines = frameScreen({ title, body: window, input, hints }, width, rows, theme);
		this.cache = { key, lines };
		return lines;
	}
}
