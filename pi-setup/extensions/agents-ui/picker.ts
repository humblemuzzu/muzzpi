import { Input, Key, matchesKey } from "@mariozechner/pi-tui";
import type { RunSnapshot } from "../tools/lib/agent-channel";
import { isLive } from "./store";

export type PickerAction =
	| { type: "open"; id: string }
	| { type: "stop"; id: string }
	| { type: "dismiss"; id: string }
	| { type: "steer" | "continue"; id: string; text: string }
	| { type: "stopAll" }
	| { type: "close" };

const STOP_ALL_ARMED_MS = 3_000;

interface Compose {
	kind: "steer" | "continue";
	id: string;
	input: Input;
}

/** Selection and the keys that act on the selected run; the dock and the full list share it. */
export class Picker {
	version = 0;
	selected: string | undefined;
	compose: Compose | undefined;
	notice: string | undefined;
	private focus = false;
	private stopAllArmedUntil = 0;

	constructor(
		private readonly visible: () => RunSnapshot[],
		private readonly act: (action: PickerAction) => void,
		private readonly dismissable = false,
		private readonly now: () => number = Date.now,
	) {}

	get focused(): boolean {
		return this.focus;
	}

	set focused(value: boolean) {
		if (value === this.focus) return;
		this.focus = value;
		if (this.compose) this.compose.input.focused = value;
		this.version++;
	}

	index(): number {
		const runs = this.visible();
		const at = runs.findIndex((run) => run.id === this.selected);
		return Math.max(at, 0);
	}

	current(): RunSnapshot | undefined {
		return this.visible()[this.index()];
	}

	select(id: string | undefined): void {
		this.selected = id;
		this.version++;
	}

	handleInput(data: string): void {
		this.version++;
		this.notice = undefined;
		if (this.compose) return this.handleCompose(data);
		const runs = this.visible();
		const at = this.index();
		const run = runs[at];
		if (matchesKey(data, Key.up)) this.selected = runs[Math.max(0, at - 1)]?.id;
		else if (matchesKey(data, Key.down)) this.selected = runs[Math.min(runs.length - 1, at + 1)]?.id;
		else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) this.act({ type: "close" });
		else if (data === "X") this.stopAll(runs);
		else if (!run) return;
		else if (matchesKey(data, Key.enter)) this.act({ type: "open", id: run.id });
		else if (data === "s") this.begin("steer", run);
		else if (data === "c") this.begin("continue", run);
		else if (data === "x") this.stopOrDismiss(run);
	}

	private begin(kind: Compose["kind"], run: RunSnapshot): void {
		if (kind === "steer" && !isLive(run)) {
			this.notice = `${run.agent} has finished; press c to continue it`;
			return;
		}
		if (kind === "continue" && isLive(run)) {
			this.notice = `${run.agent} is still running; press s to steer it`;
			return;
		}
		const input = new Input({ prompt: `${kind} ${run.agent} ▸ `, placeholder: kind === "steer" ? "tell it something" : "what next?" });
		input.focused = this.focus;
		this.compose = { kind, id: run.id, input };
	}

	private stopAll(runs: RunSnapshot[]): void {
		const live = runs.filter(isLive).length;
		if (live === 0) {
			this.notice = "No background agent is running";
		} else if (this.now() < this.stopAllArmedUntil) {
			this.stopAllArmedUntil = 0;
			this.act({ type: "stopAll" });
		} else {
			this.stopAllArmedUntil = this.now() + STOP_ALL_ARMED_MS;
			this.notice = `Press X again to stop all ${live} running agent${live === 1 ? "" : "s"}`;
		}
	}

	private stopOrDismiss(run: RunSnapshot): void {
		if (isLive(run)) this.act({ type: "stop", id: run.id });
		else if (this.dismissable) this.act({ type: "dismiss", id: run.id });
		else this.notice = `${run.agent} has already finished`;
	}

	private handleCompose(data: string): void {
		const compose = this.compose!;
		if (matchesKey(data, Key.escape)) {
			this.compose = undefined;
		} else if (matchesKey(data, Key.enter)) {
			const text = compose.input.getValue().trim();
			if (!text) return;
			this.compose = undefined;
			this.act({ type: compose.kind, id: compose.id, text });
		} else {
			compose.input.handleInput(data);
		}
	}
}
