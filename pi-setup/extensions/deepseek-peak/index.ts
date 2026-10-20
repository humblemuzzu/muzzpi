/**
 * deepseek-peak — live peak/off-peak pricing indicator in the editor border.
 *
 * From 16:00 UTC on 2026-08-16 DeepSeek charges 2× during two weekday UTC
 * windows (since 2026-08-23, weekends in Beijing time are all off-peak).
 * This puts the current phase, and the time until it flips, in the
 * bottom-left slot of the custom editor's border while DeepSeek is in use (the
 * main model or a live sub-agent); otherwise only the detail view shows it.
 *
 * Zero network, zero cache: the windows are defined in UTC and `Date` already
 * knows UTC. See ./peak.ts for why that is the accurate choice, not the lazy
 * one.
 *
 * The label is injected through the editor extension's public event bus
 * ("editor:set-label"), so this file never imports the editor — a module-level
 * import would not share state anyway, since pi loads each extension with its
 * own jiti instance and `moduleCache: false`.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { AGENT_RUNS_CHANNEL, type RunSnapshot } from "../tools/lib/agent-channel";
import {
	EFFECTIVE_FROM_MS,
	PEAK_WINDOWS_UTC,
	PRICES,
	computeState,
	formatClock,
	formatDuration,
	labelColor,
	localPeakWindows,
	renderLabel,
	utcHourToLocal,
} from "./peak";

const LABEL_KEY = "deepseek-peak";

/**
 * The wall clock is a SEPARATE label so it can carry its own colour — the
 * editor joins same-side labels with " · " itself. Emitted first, so it reads
 * "7:02 · ◇ ds off-peak · 11h 41m left" (Map insertion order decides).
 */
const CLOCK_KEY = "clock";

const CLOCK_PRIORITY = 30;
const LABEL_PRIORITY = 40;

/**
 * 5s poll, but each label is only re-emitted when its TEXT changes — which at
 * minute granularity is once a minute. A repaint per tick would fight the
 * editor's own render loop for no visible gain. 5s rather than 60s so the
 * minute never shows up more than 5s late; the extra ticks are no-ops.
 */
const POLL_MS = 5_000;

function isDeepseekModel(ctx: ExtensionContext | null): boolean {
	const model = ctx?.model;
	if (!model) return false;
	return `${model.provider ?? ""}/${model.id ?? ""}`.toLowerCase().includes("deepseek");
}

export function hasLiveDeepseekRun(runs: readonly RunSnapshot[]): boolean {
	return runs.some((run) => (run.status === "running" || run.status === "queued") && (run.model ?? "").toLowerCase().includes("deepseek"));
}

/** the full report behind /deepseek */
function buildReport(now: Date, ctx: ExtensionContext | null): string {
	const state = computeState(now);
	const windows = localPeakWindows(now);
	const tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "local";
	const utcNow = now.toISOString().slice(11, 16);
	const localNow = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });

	const lines: string[] = [];
	lines.push(`DeepSeek pricing clock`);
	lines.push(``);
	lines.push(`   now        : ${utcNow} UTC  ·  ${localNow} ${tz}`);

	if (state.phase === "pre-launch") {
		lines.push(`   status     : flat rates — peak/off-peak not active yet`);
		lines.push(`   starts     : ${new Date(EFFECTIVE_FROM_MS).toISOString().slice(0, 16).replace("T", " ")} UTC`);
		lines.push(`   countdown  : ${formatDuration(state.msUntilChange)} (opens ${state.next})`);
	} else {
		const icon = state.phase === "peak" ? "◆" : "◇";
		lines.push(`   status     : ${icon} ${state.phase.toUpperCase()}  (${state.multiplier}× off-peak rate)`);
		lines.push(`   changes to : ${state.next} in ${formatDuration(state.msUntilChange)}`);
	}

	lines.push(``);
	lines.push(`   peak hours (2× price) — weekdays only`);
	PEAK_WINDOWS_UTC.forEach(([s, e], i) => {
		const utc = `${String(s).padStart(2, "0")}:00–${String(e).padStart(2, "0")}:00 UTC`;
		lines.push(`     ${utc}   =  ${windows[i]} ${tz}`);
	});
	lines.push(`   weekends (Beijing Sat/Sun) are entirely off-peak.`);

	lines.push(``);
	lines.push(`   $ per 1M tokens        cache-hit   cache-miss   output`);
	for (const [name, p] of Object.entries(PRICES)) {
		const pad = name.padEnd(9);
		lines.push(
			`     ${pad} off-peak   ${p.cacheHit.toFixed(3).padStart(8)}   ${p.cacheMiss.toFixed(2).padStart(10)}   ${p.output.toFixed(2).padStart(6)}`,
		);
		lines.push(
			`     ${" ".repeat(9)} peak       ${(p.cacheHit * 2).toFixed(3).padStart(8)}   ${(p.cacheMiss * 2).toFixed(2).padStart(10)}   ${(p.output * 2).toFixed(2).padStart(6)}`,
		);
	}

	if (isDeepseekModel(ctx)) {
		lines.push(``);
		lines.push(
			state.phase === "peak"
				? `   ⚠ you are on ${ctx?.model?.id} right now — this turn bills at 2×.`
				: `   ✓ you are on ${ctx?.model?.id} — cheapest rate.`,
		);
	}

	lines.push(``);
	lines.push(`   /deepseek off  hides the border label + clock · /deepseek on  restores`);
	return lines.join("\n");
}

export default function deepseekPeakExtension(pi: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | null = null;
	let lastClock: string | null = null;
	let lastLabel: string | null = null;
	let enabled = true;
	let ctxRef: ExtensionContext | null = null;
	let deepseekRunLive = false;
	let lastInUse: boolean | null = null;

	const stopWatchingRuns = pi.events.on(AGENT_RUNS_CHANNEL, (runs: unknown) => {
		const live = Array.isArray(runs) && hasLiveDeepseekRun(runs as RunSnapshot[]);
		if (live === deepseekRunLive) return;
		deepseekRunLive = live;
		paintSafely();
	});

	const emit = (key: string, text: string, options: { priority: number; when?: "idle" | "detail" }): void => {
		pi.events.emit("editor:set-label", { key, text, position: "bottom", align: "left", ...options });
	};

	const paint = (force = false): void => {
		if (!enabled || !ctxRef) return;
		const now = new Date();
		const inUse = isDeepseekModel(ctxRef) || deepseekRunLive;
		if (inUse !== lastInUse) {
			lastInUse = inUse;
			force = true;
		}

		// --- wall clock, DELIBERATELY UNCOLOURED ---
		// Plain text lands on the terminal's default foreground (#ebdbb2 in this
		// Ghostty theme) — the off-white asked for, and it follows the terminal
		// if the theme changes. Every theme colour available here is either loud
		// (accent/warning/error) or grey (muted #a89984, dim #7c6f64), and
		// `fg("text")` THROWS: both themes map "text" to "", and Theme.fg rejects
		// a falsy ansi string with "Unknown theme color".
		// Safe because the preceding border chrome ends in \x1b[39m (Theme.fg
		// resets foreground), so this inherits no colour from it.
		const clock = formatClock(now);
		if (force || clock !== lastClock) {
			lastClock = clock;
			emit(CLOCK_KEY, clock, { priority: CLOCK_PRIORITY, when: "idle" });
		}

		// --- pricing phase ---
		const state = computeState(now);
		const text = renderLabel(state);
		if (!force && text === lastLabel) return;
		lastLabel = text;

		let styled = text;
		const color = labelColor(state, inUse);
		try {
			if (color) styled = ctxRef.ui.theme.fg(color, text);
		} catch {
			/* theme unavailable (print/json mode) — plain text is fine */
		}
		emit(LABEL_KEY, styled, { priority: LABEL_PRIORITY, when: inUse ? undefined : "detail" });
	};

	const stop = (): void => {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
	};

	/**
	 * A throw inside a setInterval callback is an uncaughtException, and pi's
	 * handler for that KILLS THE PROCESS — so anything on this timer must be
	 * caught here, not left to bubble.
	 *
	 * The failure that made this necessary: `pi.events.emit` calls the runtime's
	 * `assertActive()`, which throws once the ctx captured at session_start goes
	 * stale. `session_shutdown` below normally clears the timer first, but this
	 * is the layer that has to hold if a future pi path invalidates without
	 * emitting it. A stale runtime never comes back, so stop rather than retry —
	 * and stay silent, because a console write during a TUI render scribbles the
	 * screen and the next session's own instance is already painting.
	 */
	const paintSafely = (force = false): void => {
		try {
			paint(force);
		} catch {
			enabled = false;
			stop();
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctxRef = ctx;
		stop();
		// the editor extension keeps labels sent before its editor mounts, so the
		// order of the two session_start handlers does not matter.
		paintSafely(true);
		// hidden (/deepseek off) or already broken — a poll that can only no-op
		// is not worth owning.
		if (!enabled) return;
		timer = setInterval(() => paintSafely(), POLL_MS);
		timer.unref?.();
	});

	/**
	 * MANDATORY for any process-lifetime timer in a pi extension.
	 *
	 * /new, /resume, fork, import and /reload all tear the session down and then
	 * mark the old extension ctx stale; every later call through the old `pi`
	 * throws. The extension factory is re-run for the replacement session, so the
	 * NEW instance paints correctly — but the OLD closure's interval is owned by
	 * nothing and keeps firing against the dead runtime until it kills pi.
	 *
	 * pi emits session_shutdown BEFORE invalidating, which is the only window in
	 * which this teardown is legal.
	 */
	pi.on("session_shutdown", async () => {
		stop();
		// paint() is a no-op without a ctx, so a timer that somehow outlives
		// stop() still cannot reach the stale runtime.
		ctxRef = null;
		lastClock = null;
		lastLabel = null;
		lastInUse = null;
		deepseekRunLive = false;
		stopWatchingRuns();
	});

	// switching to/from deepseek changes the label's urgency color
	pi.on("model_select", async (_event, ctx) => {
		ctxRef = ctx;
		paintSafely(true);
	});

	pi.registerCommand("deepseek", {
		description:
			"DeepSeek peak/off-peak pricing clock — current phase, time until it flips, " +
			"peak windows in your local timezone, and the rate card. '/deepseek off' hides the border label + clock.",
		handler: async (args, ctx) => {
			ctxRef = ctx;
			const cmd = (args || "").trim().toLowerCase();

			if (cmd === "off" || cmd === "hide") {
				enabled = false;
				stop();
				lastClock = null;
				lastLabel = null;
				lastInUse = null;
				// the clock is a separate label and must be cleared separately, or
				// "/deepseek off" leaves behind a clock that no longer ticks.
				pi.events.emit("editor:remove-label", { key: LABEL_KEY });
				pi.events.emit("editor:remove-label", { key: CLOCK_KEY });
				ctx.ui.notify("DeepSeek label + clock hidden. '/deepseek on' to restore.", "info");
				return;
			}

			if (cmd === "on" || cmd === "show") {
				enabled = true;
				stop();
				paintSafely(true);
				timer = setInterval(() => paintSafely(), POLL_MS);
				timer.unref?.();
				ctx.ui.notify("DeepSeek label + clock restored.", "info");
				return;
			}

			ctx.ui.notify(buildReport(new Date(), ctx), "info");
		},
	});
}

// re-exported so the numbers have exactly one home
export { EFFECTIVE_FROM_MS, PEAK_WINDOWS_UTC, computeState, utcHourToLocal };
