import type { Styler } from "../tools/lib/agent-layout";

const SPINNER_FRAMES = ["·", "•", "*", "⁑", "⁂", "⁑", "*", "•", "·"];
export const SPINNER_INTERVAL_MS = 150;

type ActivityPhase = "idle" | "thinking" | "tool" | "streaming";

export interface ActivityState {
	phase: ActivityPhase;
	/** 0-based, as pi's turn_start reports it */
	turnIndex: number;
	/** in-flight tool calls by id, so parallel calls all show */
	activeTools: Map<string, string>;
	startedAt: number;
	frame: number;
	/** the run that ended last, kept for the detail view */
	lastRun?: { turns: number; elapsedMs: number };
}

export function createActivityState(): ActivityState {
	return { phase: "idle", turnIndex: 0, activeTools: new Map(), startedAt: 0, frame: 0 };
}

export function startActivity(state: ActivityState, now: number): void {
	state.phase = "thinking";
	state.turnIndex = 0;
	state.activeTools.clear();
	state.startedAt = now;
	state.frame = 0;
}

export function endActivity(state: ActivityState, now: number): void {
	if (state.phase !== "idle" && state.startedAt > 0) {
		state.lastRun = { turns: state.turnIndex + 1, elapsedMs: now - state.startedAt };
	}
	state.phase = "idle";
	state.activeTools.clear();
}

/** `94m26s`: the detail view's clock. */
export function formatElapsed(ms: number): string {
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	const rem = s % 60;
	return `${m}m${rem > 0 ? `${rem}s` : ""}`;
}

/** `12s`, `4m`, `1h 34m`: seconds stop mattering after the first minute. */
export function formatGlanceElapsed(ms: number): string {
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * `read(index.ts)`. bash `cmd` is often a multiline script, and a newline in
 * a single-line sink moves the real cursor (the TUI smear): first line only,
 * basename for a bare path, then a hard cap.
 */
export function describeToolCall(toolName: string, args: unknown): string {
	const a = args as { path?: unknown; pattern?: unknown; query?: unknown; filePattern?: unknown; cmd?: unknown } | undefined;
	const hint = a?.path ?? a?.pattern ?? a?.query ?? a?.filePattern ?? a?.cmd;
	if (typeof hint !== "string") return toolName;
	const firstLine = hint.split("\n", 1)[0]!.trim();
	const pathLike = firstLine.includes("/") && !firstLine.includes(" ");
	const base = pathLike ? (firstLine.split("/").pop() ?? firstLine) : firstLine;
	const short = base.length > 24 ? `${base.slice(0, 24)}…` : base;
	return short ? `${toolName}(${short})` : toolName;
}

function doing(state: ActivityState): string {
	if (state.activeTools.size > 0) {
		const tools = [...state.activeTools.values()];
		const overflow = tools.length > 2 ? ` +${tools.length - 2}` : "";
		return tools.slice(0, 2).join(", ") + overflow;
	}
	return state.phase === "streaming" ? "writing" : "thinking";
}

/** The bottom-border label while a run is on: `⁂ read(index.ts) · 4m`. Empty when idle. */
export function activityLabel(state: ActivityState, now: number, paint: Styler): string {
	if (state.phase === "idle") return "";
	const spinner = paint.fg("accent", SPINNER_FRAMES[state.frame % SPINNER_FRAMES.length]!);
	const elapsed = now - state.startedAt;
	const clock = state.startedAt > 0 && elapsed >= 1000 ? `${paint.fg("dim", " · ")}${formatGlanceElapsed(elapsed)}` : "";
	return `${spinner} ${doing(state)}${clock}`;
}

export function advanceSpinner(state: ActivityState): void {
	state.frame = (state.frame + 1) % SPINNER_FRAMES.length;
}

/** The detail view's run figures: `turn 69 · 94m26s`, or the last run's once idle. */
export function runDetail(state: ActivityState, now: number): string {
	if (state.phase !== "idle") return `turn ${state.turnIndex + 1} · ${formatElapsed(now - state.startedAt)}`;
	const last = state.lastRun;
	if (!last) return "";
	return `last run ${last.turns} ${last.turns === 1 ? "turn" : "turns"} · ${formatElapsed(last.elapsedMs)}`;
}
