import os from "node:os";
import { cacheSavings, type SessionStat, type Summary } from "../aggregate";
import { type Better, delta, dot, HARNESS_COLOR, type Ink, SERIES } from "../draw";
import type { Ctx } from "../widgets";

export interface Tab {
	title: string;
	hint: string;
	render(ctx: Ctx): string[];
}

export const C = {
	sky: SERIES[0],
	lavender: SERIES[1],
	amber: SERIES[2],
	mint: SERIES[3],
	rose: SERIES[4],
	peach: SERIES[5],
	periwinkle: SERIES[6],
	lime: SERIES[7],
};

/** What each cost part is drawn in, wherever cost is split. */
export const PARTS = [
	{ name: "input", color: C.sky },
	{ name: "output", color: C.lavender },
	{ name: "cache read", color: C.mint },
	{ name: "cache write", color: C.amber },
] as const;

export const AGENTS_EXCLUDED = "Sub-agent rows carry no provider, so agent runs and spend are left out under a provider filter.";

const HOME = os.homedir();

export function share(part: number, whole: number): number {
	return whole > 0 ? part / whole : 0;
}

/** Like `share`, but NaN (shown as "—") when there is no whole to take a share of. */
export function rate(part: number, whole: number): number {
	return whole > 0 ? part / whole : NaN;
}

export function netSaved(s: Summary): number {
	const save = cacheSavings(s.models);
	return save.saved - save.premium;
}

/** Change of `pick` against the previous window; empty for the lifetime range. */
export function vs(ctx: Ctx, pick: (s: Summary) => number, better: Better, points = false): string {
	return delta(ctx.ink, pick(ctx.s), ctx.prev && pick(ctx.prev), better, points);
}

/** `vs` for a number that has no provider: nothing to compare under a provider filter. */
export function vsUnscoped(ctx: Ctx, pick: (s: Summary) => number, better: Better): string {
	return ctx.s.filter.provider === undefined ? vs(ctx, pick, better) : "";
}

export function sessionName(ink: Ink, x: SessionStat): string {
	return `${dot(HARNESS_COLOR[x.harness])} ${x.name ?? ink.dim(`untitled ${x.id.slice(0, 8)}`)}`;
}

export function when(ms: number): string {
	const d = new Date(ms);
	return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function relative(ms: number, now: number): string {
	const days = Math.floor((now - ms) / 86_400_000);
	if (days <= 0) return "today";
	if (days === 1) return "yesterday";
	if (days < 30) return `${days}d ago`;
	return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: days > 300 ? "2-digit" : undefined });
}

export function peakHour(s: Summary): number {
	const byHour = Array.from({ length: 24 }, (_, h) => s.punch.reduce((a, r) => a + r[h], 0));
	return byHour.indexOf(Math.max(...byHour));
}

export function turnsShare(s: Summary, from: number, to: number): number {
	let part = 0;
	let all = 0;
	for (const r of s.punch) {
		for (let h = 0; h < 24; h++) {
			all += r[h];
			if (h >= from && h < to) part += r[h];
		}
	}
	return share(part, all);
}

export function busiestDay(s: Summary): [string, number] | undefined {
	let best: [string, number] | undefined;
	for (const d of s.daily.values()) {
		const v = d.cost + d.agentCost;
		if (v > 0 && (!best || v > best[1])) best = [d.day, v];
	}
	return best;
}

export function hourLabel(h: number): string {
	return `${String(h).padStart(2, "0")}:00–${String((h + 1) % 24).padStart(2, "0")}:00`;
}

/** "sfrog/crates/core/src/store.rs" when the file is inside a known project, else a ~ path. */
export function projectPath(ctx: Ctx, file: string): string {
	let best = "";
	for (const root of ctx.ds.projectName.keys()) {
		if (root.length > best.length && file.startsWith(`${root}/`)) best = root;
	}
	if (best) return `${ctx.ds.projectName.get(best)}${file.slice(best.length)}`;
	return file.startsWith(HOME) ? `~${file.slice(HOME.length)}` : file;
}

export function projectLabel(ctx: Ctx, root: string): string {
	return ctx.ds.projectName.get(root) ?? (root || "—");
}
