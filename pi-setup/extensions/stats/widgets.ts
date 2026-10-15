import { visibleWidth } from "@mariozechner/pi-tui";
import { AGENTS_SERIES, addDays, type Burn, type DayStat, type Dataset, type Filter, parseDay, type Streaks, type Summary, weekday } from "./aggregate";
import {
	AGENT,
	bold,
	columnChart,
	compact,
	dot,
	duration,
	fg,
	HARNESS_COLOR,
	hbar,
	type Ink,
	int,
	money,
	OTHER,
	pad,
	padStart,
	quartiles,
	type Ramp,
	rampAt,
	rampColor,
	type RGB,
	SERIES,
	shade,
	spread,
	WHITE,
} from "./draw";
import { HARNESS_LABEL, HARNESSES, type Harness, U } from "./record";
import { kv } from "./ui";

export type Metric = "cost" | "tokens" | "turns";
export const METRICS: Metric[] = ["cost", "tokens", "turns"];
const METRIC_INDEX: Record<Metric, number> = { cost: 0, tokens: 1, turns: 2 };
export type Group = "harness" | "model" | "project";
export const GROUPS: Group[] = ["harness", "model", "project"];
export type BustOrder = "cost" | "recent";

export interface Ctx {
	ds: Dataset;
	s: Summary;
	/** The window of the same length before `s`; absent for the lifetime range. */
	prev?: Summary;
	year: Summary;
	streak: Streaks;
	/** Account-wide month to date, whatever the filter. */
	burn: Burn;
	/** `provider/model` → context window from pi's model registry. */
	windows: Map<string, number>;
	width: number;
	ink: Ink;
	metric: Metric;
	ramp: Ramp;
	skyline: boolean;
	group: Group;
	cursor: string;
	bustOrder: BustOrder;
	planUsd: number;
	color(series: string): RGB;
	label(series: string): string;
}

const isHarness = (k: string): k is Harness => (HARNESSES as readonly string[]).includes(k);

/** Under a provider filter, numbers no provider owns (time, prompts, goals, agents) are not known. */
export function unscoped(ctx: Ctx, text: string): string {
	return ctx.s.filter.provider === undefined ? text : "—";
}

/** Commits carry neither a provider nor a harness, so either filter hides them. */
export function commitsKnown(ctx: Ctx): boolean {
	return ctx.s.filter.provider === undefined && ctx.s.filter.harness === undefined;
}

export function filterChips(ds: Dataset, filter: Filter): Array<[string, keyof Filter]> {
	const out: Array<[string, keyof Filter]> = [];
	if (filter.project !== undefined) out.push([`project ${ds.projectName.get(filter.project) ?? filter.project}`, "project"]);
	if (filter.provider !== undefined) out.push([`provider ${filter.provider}`, "provider"]);
	return out;
}

export function formatMetric(metric: Metric, v: number): string {
	return metric === "cost" ? money(v) : metric === "tokens" ? compact(v) : int(v);
}

export function modelLabel(key: string): string {
	if (key === AGENTS_SERIES) return "sub-agents";
	if (isHarness(key)) return HARNESS_LABEL[key];
	const i = key.indexOf("/");
	return i === -1 ? key : key.slice(i + 1);
}

export function harnessDots(set: Set<Harness> | undefined): string {
	return HARNESSES.filter((h) => set?.has(h)).map((h) => dot(HARNESS_COLOR[h])).join("");
}

/** Harnesses keep their own colour; the top models and projects of a range get the palette in cost order. */
export function seriesColors(s: Summary): (key: string) => RGB {
	const rank = new Map<string, number>();
	[...s.models].sort((a, b) => b[1][U.cost] - a[1][U.cost]).slice(0, SERIES.length).forEach(([k], i) => rank.set(k, i));
	const projects = new Map<string, number>();
	s.projects.slice(0, SERIES.length).forEach((p, i) => projects.set(p.root, i));
	return (key) => {
		if (key === AGENTS_SERIES) return AGENT;
		if (isHarness(key)) return HARNESS_COLOR[key];
		const i = rank.get(key) ?? projects.get(key);
		return i === undefined ? OTHER : SERIES[i];
	};
}

function dayValue(d: DayStat | undefined, metric: Metric): number {
	if (!d) return 0;
	return metric === "cost" ? d.cost + d.agentCost : metric === "tokens" ? d.tokens : d.turns;
}

/** Quartile grade per day; a day with usage but no recorded price still shows as active. */
export function dayGrader(year: Summary, metric: Metric): (day: string) => number {
	const grade = quartiles(year.days.map((d) => dayValue(year.daily.get(d), metric)));
	return (day) => {
		const d = year.daily.get(day);
		const g = grade(dayValue(d, metric));
		return g === 0 && d && (d.tokens > 0 || d.agentRuns > 0) ? 1 : g;
	};
}

function shortDate(day: string, withYear = false): string {
	return parseDay(day).toLocaleDateString("en-US", { month: "short", day: "numeric", ...(withYear ? { year: "numeric" } : {}) });
}

/** Axis end labels; both carry the year when the span crosses one. */
function axisEnds(from: string, to: string): [string, string] {
	const y = from.slice(0, 4) !== to.slice(0, 4);
	return [shortDate(from, y), shortDate(to, y)];
}

export function longDate(day: string): string {
	return parseDay(day).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ROW_LABELS = ["Mon", "", "Wed", "", "Fri", "", "Sun"];

/** The last 52-ish weeks that fit, Monday-first columns, ending today. */
function yearGrid(ctx: Ctx, inner: number): { start: string; weeks: number } {
	const today = ctx.ds.today;
	const fit = Math.max(4, Math.floor((inner - 4) / 2));
	const first = addDays(today, -364);
	let start = addDays(first, -weekday(first));
	let weeks = Math.ceil((Math.round((parseDay(today).getTime() - parseDay(start).getTime()) / 86_400_000) + 1) / 7);
	if (weeks > fit) {
		start = addDays(start, (weeks - fit) * 7);
		weeks = fit;
	}
	return { start, weeks };
}

/** Columns a full year of the heatmap needs. */
export const HEATMAP_WIDTH = 4 + 2 * 53;

export function heatmap(ctx: Ctx, inner: number): string[] {
	const { ds, year, ink, ramp, metric, cursor } = ctx;
	const { start, weeks } = yearGrid(ctx, inner);
	const grade = dayGrader(year, metric);

	let months = "    ";
	let lastMonth = -1;
	for (let w = 0; w < weeks; w++) {
		const m = parseDay(addDays(start, w * 7)).getMonth();
		if (m !== lastMonth && months.length <= 4 + w * 2) {
			months += " ".repeat(4 + w * 2 - months.length) + MONTHS[m];
			lastMonth = m;
		}
	}
	const out = [ink.dim(months.slice(0, 4 + weeks * 2))];
	for (let r = 0; r < 7; r++) {
		let line = ink.dim(pad(ROW_LABELS[r], 4));
		for (let w = 0; w < weeks; w++) {
			const day = addDays(start, w * 7 + r);
			if (day > ds.today) {
				line += "  ";
				continue;
			}
			line += (day === cursor ? bold(fg(WHITE, "◆")) : fg(rampColor(ramp, grade(day)), "■")) + " ";
		}
		out.push(line);
	}
	const legend = [0, 1, 2, 3, 4].map((g) => fg(rampColor(ramp, g), "■")).join(" ");
	const w = Math.min(inner, 4 + weeks * 2);
	out.push("", spread(ink.dim(`Less ${legend} More`), ink.dim(`${ramp.name} · c`), w));
	return out;
}

/** Weekly totals as shaded bars: a lit front face and a darker side face. */
export function skyline(ctx: Ctx, inner: number): string[] {
	const { year, ink, ramp, metric, ds } = ctx;
	const { start, weeks } = yearGrid(ctx, inner);
	const totals: number[] = [];
	for (let w = 0; w < weeks; w++) {
		let sum = 0;
		for (let r = 0; r < 7; r++) sum += dayValue(year.daily.get(addDays(start, w * 7 + r)), metric);
		totals.push(sum);
	}
	const max = Math.max(0, ...totals);
	const columns = totals.flatMap((v) => {
		const c = rampAt(ramp, max > 0 ? v / max : 0);
		return [[[c, v]], [[shade(c, 0.55), v]]] as Array<Array<[RGB, number]>>;
	});
	const chart = columnChart(columns, 7, 1, max);
	const peak = totals.indexOf(max);
	return [
		ink.dim(max > 0 ? spread(`peak week ${formatMetric(metric, max)}`, `w/c ${shortDate(addDays(start, peak * 7))}`, 4 + weeks * 2) : "no activity this year"),
		...chart.map((l) => "    " + l),
		ink.dim("    " + spread(...axisEnds(start, ds.today), weeks * 2)),
		"",
		ink.dim(`    weekly ${metric} · v grid`),
	];
}

function legend(ink: Ink, color: (k: string) => RGB, label: (k: string) => string, keys: Array<[string, number]>, total: number, inner: number): string[] {
	const items = keys.map(([k, v]) => `${dot(color(k))} ${label(k)} ${ink.dim(total > 0 ? `${Math.round((v / total) * 100)}%` : "")}`);
	const lines: string[] = [];
	let line = "";
	for (const it of items) {
		const next = line ? `${line}    ${it}` : it;
		if (line && visibleWidth(next) > inner) {
			lines.push(line);
			line = it;
		} else line = next;
	}
	if (line) lines.push(line);
	return lines;
}

export interface PlotOptions {
	format(v: number): string;
	/** Fixed top of the y axis, e.g. 1 for a rate. */
	max?: number;
	/** Average a bucket's days instead of summing them (rates). */
	average?: boolean;
	/** Colour a single-series column by its value, after bucketing. */
	colorOf?: (v: number) => RGB;
}

/**
 * Per-day stacked columns over the summary's days with a y axis and date
 * labels. Days are bucketed when the range is wider than the plot.
 */
export function plot(ctx: Ctx, perDay: (day: string) => Array<[RGB, number]>, inner: number, height: number, opts: PlotOptions): string[] {
	const { s, ink } = ctx;
	const axisW = 9;
	const avail = Math.max(10, inner - axisW);
	const n = s.days.length;
	const per = Math.ceil(n / avail);
	const slot = per === 1 ? Math.max(1, Math.min(8, Math.floor((avail + 1) / n))) : 1;
	const gap = slot >= 3 ? 1 : 0;
	const columns: Array<Array<[RGB, number]>> = [];
	for (let i = 0; i < n; i += per) {
		const days = s.days.slice(i, i + per).map(perDay);
		const filled = days.filter((segs) => segs.some(([, v]) => v > 0)).length;
		const col = (days[0] ?? []).map(([c], k) => [c, days.reduce((a, segs) => a + (segs[k]?.[1] ?? 0), 0)] as [RGB, number]);
		const value = opts.average && filled > 0 ? col.map(([c, v]) => [c, v / filled] as [RGB, number]) : col;
		columns.push(opts.colorOf ? value.map(([, v]) => [opts.colorOf!(v), v]) : value);
	}
	const max = opts.max ?? Math.max(0, ...columns.map((c) => c.reduce((a, [, v]) => a + v, 0)));
	const chart = columnChart(columns, height, slot - gap, max, gap);
	const axis = (r: number) => (r === 0 ? opts.format(max) : r === Math.floor(height / 2) ? opts.format(max / 2) : "");
	const plotW = columns.length * slot - gap;
	const out = chart.map((line, r) => ink.dim(padStart(axis(r), axisW - 2) + " ┤") + line);
	out.push(ink.dim(" ".repeat(axisW - 1) + "└" + "─".repeat(plotW)));
	const note = per > 1 ? `${per} days per column` : "";
	const [first, last] = axisEnds(s.days[0], s.days[n - 1]);
	out.push(ink.dim(" ".repeat(axisW) + spread(`${first}   ${note}`, last, plotW)));
	return out;
}

/** Stacked usage over the range, one series per harness, model or project. */
export function timeline(ctx: Ctx, inner: number, height: number): string[] {
	const { s, metric, ink, group } = ctx;
	const mi = METRIC_INDEX[metric];
	const series = (d: DayStat) => (group === "harness" ? d.byHarness : group === "model" ? d.byModel : d.byProject);
	const totals = new Map<string, number>();
	for (const d of s.daily.values()) for (const [k, v] of series(d)) totals.set(k, (totals.get(k) ?? 0) + v[mi]);
	const ranked = [...totals].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
	const named = ranked.slice(0, 7);
	const otherTotal = ranked.slice(7).reduce((a, [, v]) => a + v, 0);
	const grand = named.reduce((a, [, v]) => a + v, 0) + otherTotal;
	if (grand <= 0) return [ink.muted("No activity in this range.")];

	const out = plot(
		ctx,
		(day) => {
			const m = series(s.daily.get(day)!);
			let other = 0;
			for (const [k, v] of m) if (!named.some(([n]) => n === k)) other += v[mi];
			return [...named.map(([k]) => [ctx.color(k), m.get(k)?.[mi] ?? 0] as [RGB, number]), [OTHER, other]];
		},
		inner,
		height,
		{ format: (v) => formatMetric(ctx.metric, v) },
	);
	out.push("");
	const OTHER_KEY = "\0other";
	const legendKeys: Array<[string, number]> = otherTotal > 0 ? [...named, [OTHER_KEY, otherTotal]] : named;
	out.push(...legend(ink, (k) => (k === OTHER_KEY ? OTHER : ctx.color(k)), (k) => (k === OTHER_KEY ? `${ranked.length - 7} more` : ctx.label(k)), legendKeys, grand, inner));
	return out;
}

export function dayPanel(ctx: Ctx, day: string, inner: number): string[] {
	const { ink, year } = ctx;
	const d = year.daily.get(day);
	const out = [bold(ink.text(longDate(day))), ""];
	if (!d || (d.tokens === 0 && d.agentRuns === 0 && d.commits === 0)) {
		out.push(ink.muted("Nothing ran. A rest day."));
		return out;
	}
	const pairs: Array<[string, string]> = [
		["Spend", `${bold(money(d.cost + d.agentCost))}${d.agentCost > 0 ? ink.dim(`  agents ${money(d.agentCost)}`) : ""}`],
		["Tokens", compact(d.tokens)],
		["Turns", int(d.turns)],
		["Sessions", int(d.sessions)],
		["Time active", unscoped(ctx, duration(d.activeMs))],
	];
	if (d.commits && commitsKnown(ctx)) pairs.push(["Commits", int(d.commits)]);
	if (d.cacheDenom > 0) pairs.push(["Cache hit", `${((d.cacheRead / d.cacheDenom) * 100).toFixed(1)}%`]);
	out.push(...kv(ink, pairs, Math.min(inner, 74)));
	const rows = (map: Map<string, number[]>, title: string, n: number) => {
		const list = [...map].filter(([, v]) => v[0] > 0 || v[1] > 0).sort((a, b) => b[1][0] - a[1][0] || b[1][1] - a[1][1]).slice(0, n);
		if (!list.length) return;
		const top = list[0][1][0];
		const labelW = Math.min(18, Math.max(...list.map(([k]) => visibleWidth(ctx.label(k)))));
		const barW = Math.max(4, inner - labelW - 13);
		out.push("", ink.muted(title));
		for (const [k, v] of list) out.push(`${dot(ctx.color(k))} ${pad(ctx.label(k), labelW)} ${hbar(top > 0 ? v[0] / top : 0, barW, ctx.color(k))} ${padStart(money(v[0]), 8)}`);
	};
	if (ctx.s.filter.harness === undefined && d.byHarness.size > 1) rows(d.byHarness, "By harness", 4);
	rows(d.byModel, "By model", 4);
	return out;
}

const PUNCH_GLYPHS = [" ", "•", "•", "●", "●"];

export function punchcard(ctx: Ctx, inner: number): string[] {
	const { s, ink, ramp } = ctx;
	const cell = Math.max(2, Math.min(6, Math.floor((inner - 4) / 24)));
	const grade = quartiles(s.punch.flat());
	let header = "    ";
	for (let h = 0; h < 24; h++) header += pad(h % 3 === 0 ? String(h) : "", cell);
	const out = [ink.dim(header)];
	const names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
	for (let r = 0; r < 7; r++) {
		let line = ink.dim(pad(names[r], 4));
		for (let h = 0; h < 24; h++) {
			const g = grade(s.punch[r][h]);
			line += pad(g ? fg(rampColor(ramp, g), PUNCH_GLYPHS[g]) : ink.dim("·"), cell);
		}
		out.push(line);
	}
	return out;
}
