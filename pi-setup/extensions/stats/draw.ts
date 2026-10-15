import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import type { Harness } from "./record";

export type RGB = readonly [number, number, number];

export interface Ink {
	text(s: string): string;
	muted(s: string): string;
	dim(s: string): string;
	accent(s: string): string;
	border(s: string): string;
}

export const plainInk: Ink = {
	text: (s) => s,
	muted: (s) => s,
	dim: (s) => s,
	accent: (s) => s,
	border: (s) => s,
};

export const fg = (c: RGB, s: string) => `\x1b[38;2;${c[0]};${c[1]};${c[2]}m${s}\x1b[39m`;
export const bg = (c: RGB, s: string) => `\x1b[48;2;${c[0]};${c[1]};${c[2]}m${s}\x1b[49m`;
export const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;

export const SERIES: RGB[] = [
	[125, 211, 252],
	[196, 181, 253],
	[252, 211, 77],
	[110, 231, 183],
	[251, 146, 160],
	[253, 186, 116],
	[165, 180, 252],
	[190, 242, 100],
];
export const OTHER: RGB = [120, 113, 108];
export const AGENT: RGB = [244, 114, 182];
export const WHITE: RGB = [250, 250, 250];
export const EMPTY: RGB = [58, 56, 54];
export const GOOD: RGB = [74, 222, 128];
export const WARN: RGB = [251, 191, 36];
export const BAD: RGB = [248, 113, 113];

export const HARNESS_COLOR: Record<Harness, RGB> = {
	pi: [167, 139, 250],
	claude: [217, 119, 87],
	codex: [52, 211, 153],
	opencode: [96, 165, 250],
};

export interface Ramp {
	name: string;
	stops: [RGB, RGB, RGB, RGB];
}

export const RAMPS: Ramp[] = [
	{ name: "Ocean", stops: [[30, 58, 95], [37, 99, 160], [56, 154, 214], [147, 220, 250]] },
	{ name: "GitHub", stops: [[14, 68, 41], [0, 109, 50], [38, 166, 65], [57, 211, 83]] },
	{ name: "Ember", stops: [[104, 58, 18], [175, 58, 3], [214, 93, 14], [250, 189, 47]] },
	{ name: "Grape", stops: [[61, 43, 107], [100, 64, 170], [150, 100, 230], [215, 180, 255]] },
];

export function mix(a: RGB, b: RGB, t: number): RGB {
	const k = Math.max(0, Math.min(1, t));
	return [Math.round(a[0] + (b[0] - a[0]) * k), Math.round(a[1] + (b[1] - a[1]) * k), Math.round(a[2] + (b[2] - a[2]) * k)];
}

export function shade(c: RGB, k: number): RGB {
	return [Math.round(c[0] * k), Math.round(c[1] * k), Math.round(c[2] * k)];
}

/** Grade 0 (empty) … 4 by quartiles of the non-zero values, like GitHub's graph. */
export function quartiles(values: number[]): (v: number) => number {
	const nz = values.filter((v) => v > 0).sort((a, b) => a - b);
	const q = (p: number) => nz[Math.min(nz.length - 1, Math.floor(p * nz.length))] ?? 0;
	const [q1, q2, q3] = [q(0.25), q(0.5), q(0.75)];
	return (v) => (v <= 0 ? 0 : v <= q1 ? 1 : v <= q2 ? 2 : v <= q3 ? 3 : 4);
}

export function rampColor(ramp: Ramp, grade: number): RGB {
	return grade <= 0 ? EMPTY : ramp.stops[Math.min(3, grade - 1)];
}

/** Continuous position 0..1 along a ramp, for charts coloured by value. */
export function rampAt(ramp: Ramp, t: number): RGB {
	const x = Math.max(0, Math.min(1, t)) * 3;
	const i = Math.min(2, Math.floor(x));
	return mix(ramp.stops[i], ramp.stops[i + 1], x - i);
}

export function money(n: number): string {
	const a = Math.abs(n);
	if (a >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
	if (a >= 1e4) return `$${(n / 1e3).toFixed(1)}K`;
	if (a >= 100) return `$${Math.round(n).toLocaleString("en-US")}`;
	if (a >= 1) return `$${n.toFixed(2)}`;
	if (a === 0) return "$0";
	return `$${n.toFixed(a >= 0.01 ? 2 : 3)}`;
}

/** 1.2K, 34.5M, 120B; rounding never lands on "1000K" or "100.0K". */
export function compact(n: number): string {
	const a = Math.abs(n);
	if (a < 1e4) return Math.round(n).toLocaleString("en-US");
	const units: Array<[number, string]> = [
		[1e3, "K"],
		[1e6, "M"],
		[1e9, "B"],
		[1e12, "T"],
	];
	for (let i = 0; i < units.length; i++) {
		const [size, unit] = units[i];
		const v = a / size;
		const text = v >= 100 ? Math.round(v).toString() : v.toFixed(1);
		if (Number(text) < 1000 || i === units.length - 1) return `${n < 0 ? "-" : ""}${text === "100.0" ? "100" : text}${unit}`;
	}
	return String(n);
}

export function int(n: number): string {
	return Math.round(n).toLocaleString("en-US");
}

export function pct(x: number, digits = 1): string {
	return Number.isFinite(x) ? `${(x * 100).toFixed(digits)}%` : "—";
}

export type Better = "up" | "down" | "either";

/** Relative change; "new" from a zero base; undefined when there is nothing to compare. */
export function relChange(cur: number, prev: number): number | "new" | undefined {
	if (!Number.isFinite(cur) || !Number.isFinite(prev) || cur < 0 || prev < 0) return undefined;
	if (prev === 0) return cur > 0 ? "new" : undefined;
	return (cur - prev) / prev;
}

/** ▲/▼ against the previous window, coloured by which direction is `better`; `points` compares two rates. */
export function delta(ink: Ink, cur: number, prev: number | undefined, better: Better, points = false): string {
	if (prev === undefined) return "";
	const change = points ? (Number.isFinite(cur) && Number.isFinite(prev) ? cur - prev : undefined) : relChange(cur, prev);
	if (change === undefined) return ink.dim("—");
	const paint = (up: boolean, text: string) => (better === "either" ? ink.dim(text) : fg((better === "up") === up ? GOOD : WARN, text));
	if (change === "new") return paint(true, "new");
	const shown = points ? Math.round(change * 1000) / 10 : Math.round(change * 100);
	if (shown === 0) return ink.dim(points ? "±0pp" : "±0%");
	const size = Math.abs(shown);
	return paint(shown > 0, `${shown > 0 ? "▲" : "▼"}${points ? `${size.toFixed(1)}pp` : size > 999 ? ">999%" : `${size}%`}`);
}

export function duration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
	const m = Math.round(ms / 60_000);
	if (m < 1) return `${Math.round(ms / 1000)}s`;
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h >= 100) return `${int(h)}h`;
	return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

/** Exactly `w` columns: truncated with an ellipsis, then padded. */
export function pad(s: string, w: number): string {
	if (w <= 0) return "";
	const t = visibleWidth(s) > w ? truncateToWidth(s, w) : s;
	return t + " ".repeat(Math.max(0, w - visibleWidth(t)));
}

export function padStart(s: string, w: number): string {
	if (w <= 0) return "";
	const t = visibleWidth(s) > w ? truncateToWidth(s, w) : s;
	return " ".repeat(Math.max(0, w - visibleWidth(t))) + t;
}

export function center(s: string, w: number): string {
	const vw = Math.min(w, visibleWidth(s));
	const left = Math.floor((w - vw) / 2);
	return pad(" ".repeat(left) + s, w);
}

/** `left` and `right` on one line of width `w`; the left side yields first. */
export function spread(left: string, right: string, w: number): string {
	const rw = visibleWidth(right);
	if (rw + 1 >= w) return pad(left, w);
	return pad(left, w - rw - 1) + " " + right;
}

/** Split `total` columns into `n` widths with `gap` between them. */
export function split(total: number, n: number, gap = 2): number[] {
	const usable = total - gap * (n - 1);
	const base = Math.floor(usable / n);
	return Array.from({ length: n }, (_, i) => base + (i < usable - base * n ? 1 : 0));
}

export function hstack(blocks: string[][], widths: number[], gap = 2): string[] {
	const height = Math.max(0, ...blocks.map((b) => b.length));
	const out: string[] = [];
	for (let r = 0; r < height; r++) {
		out.push(blocks.map((b, i) => pad(b[r] ?? "", widths[i])).join(" ".repeat(gap)));
	}
	return out;
}

/** A rounded box; kept for the two framed surfaces, the loading card and Wrapped. */
export function card(ink: Ink, { title, right, width, body }: { title: string; right?: string; width: number; body: string[] }): string[] {
	const inner = Math.max(1, width - 4);
	const head = ` ${bold(ink.text(title))} `;
	const tail = right ? ` ${right} ` : "";
	const fill = Math.max(0, width - 3 - visibleWidth(head) - visibleWidth(tail));
	const top = ink.border("╭─") + head + ink.border("─".repeat(fill)) + tail + ink.border("╮");
	const lines = [visibleWidth(top) > width ? truncateToWidth(top, width) : top];
	for (const line of body) lines.push(ink.border("│") + " " + pad(line, inner) + " " + ink.border("│"));
	lines.push(ink.border(`╰${"─".repeat(Math.max(0, width - 2))}╯`));
	return lines;
}

const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
const LOWER = ["", "▁", "▂", "▃", "▄", "▅", "▆", "▇"];

/** A horizontal bar `frac` of `w` columns, resolved to eighths, over a faint track. */
export function hbar(frac: number, w: number, color: RGB, track = true): string {
	const units = Math.round(Math.max(0, Math.min(1, frac)) * w * 8);
	const full = Math.floor(units / 8);
	const rest = units % 8;
	const used = full + (rest ? 1 : 0);
	const rail = Math.max(0, w - used);
	return fg(color, "█".repeat(full) + EIGHTHS[rest]) + (track ? fg(EMPTY, "─".repeat(rail)) : " ".repeat(rail));
}

/** One bar split into coloured segments, e.g. spend by harness. */
export function segmentBar(parts: Array<[RGB, number]>, w: number, glyph = "█"): string {
	const total = parts.reduce((a, [, v]) => a + v, 0);
	if (total <= 0 || w <= 0) return fg(EMPTY, "─".repeat(Math.max(0, w)));
	let used = 0;
	let acc = 0;
	let out = "";
	for (const [c, v] of parts) {
		acc += v;
		const end = Math.round((acc / total) * w);
		if (end > used) out += fg(c, glyph.repeat(end - used));
		used = Math.max(used, end);
	}
	return out + " ".repeat(Math.max(0, w - used));
}

export type Column = Array<[RGB, number]>;

/**
 * Stacked columns, `height` rows tall, at 1/8-row resolution. A cell where
 * two segments meet draws the lower one as a partial block over the upper
 * one's colour as background.
 */
export function columnChart(columns: Column[], height: number, colWidth = 1, max?: number, gap = 0): string[] {
	const top = max ?? Math.max(0, ...columns.map((c) => c.reduce((a, [, v]) => a + v, 0)));
	const levels = height * 8;
	const bounds = columns.map((col) => {
		let acc = 0;
		return col.filter(([, v]) => v > 0).map(([color, v]) => {
			acc += v;
			return { color, end: top > 0 ? Math.round((acc / top) * levels) : 0 };
		});
	});
	const spacer = " ".repeat(gap);
	const rows: string[] = [];
	for (let r = height - 1; r >= 0; r--) {
		const lo = r * 8;
		let line = "";
		for (const [i, segs] of bounds.entries()) {
			if (i) line += spacer;
			const at = segs.findIndex((s) => s.end > lo);
			if (at === -1) {
				line += " ".repeat(colWidth);
				continue;
			}
			const seg = segs[at];
			const k = Math.min(8, seg.end - lo);
			const above = segs[at + 1]?.end > seg.end ? segs[at + 1] : undefined;
			if (k >= 8) line += fg(seg.color, "█".repeat(colWidth));
			else if (above) line += bg(above.color, fg(seg.color, LOWER[k].repeat(colWidth)));
			else line += fg(seg.color, LOWER[k].repeat(colWidth));
		}
		rows.push(line);
	}
	return rows;
}

export interface ColSpec {
	title: string;
	w: number;
	right?: boolean;
	/** Takes the leftover width; at most one per table. */
	flex?: boolean;
	/** Columns with the highest value are dropped first when the table does not fit. */
	drop?: number;
}

/** Header, a hairline, then rows; low-priority columns drop out until the table fits. */
export function table(ink: Ink, cols: ColSpec[], rows: string[][], inner: number, gap = 2): string[] {
	const keep = cols.map((_, i) => i);
	const need = () => keep.reduce((a, i) => a + (cols[i].flex ? 12 : cols[i].w), 0) + gap * (keep.length - 1);
	while (need() > inner) {
		let worst = -1;
		for (const i of keep) if ((cols[i].drop ?? 0) > 0 && (worst === -1 || (cols[i].drop ?? 0) > (cols[worst].drop ?? 0))) worst = i;
		if (worst === -1) break;
		keep.splice(keep.indexOf(worst), 1);
	}
	const fixed = keep.reduce((a, i) => a + (cols[i].flex ? 0 : cols[i].w), 0) + gap * (keep.length - 1);
	const width = (i: number) => (cols[i].flex ? Math.max(8, inner - fixed) : cols[i].w);
	const line = (cells: string[]) => keep.map((i) => (cols[i].right ? padStart(cells[i] ?? "", width(i)) : pad(cells[i] ?? "", width(i)))).join(" ".repeat(gap));
	const total = keep.reduce((a, i) => a + width(i), 0) + gap * (keep.length - 1);
	return [ink.muted(line(cols.map((c) => c.title))), ink.border("─".repeat(Math.min(inner, total))), ...rows.map(line)];
}

/** "~/a/b/c/file.ts" cut from the left so the file name survives. */
export function tail(s: string, w: number): string {
	const chars = [...s];
	return chars.length <= w ? s : `…${chars.slice(chars.length - w + 1).join("")}`;
}

export function dot(color: RGB): string {
	return fg(color, "●");
}

export function gradientText(s: string, from: RGB, to: RGB): string {
	const chars = [...s];
	return chars.map((ch, i) => fg(mix(from, to, chars.length > 1 ? i / (chars.length - 1) : 0), ch)).join("");
}

/**
 * Keeps the colour codes this extension draws with and drops every other
 * escape and control character: a stray \n or cursor move inside one row
 * would smear the screen, and width checks count it as zero columns.
 */
export function plain(s: string): string {
	return s.replace(/\x1b\[[0-9;]*m|\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|.?)|[\x00-\x08\x0a-\x1a\x1c-\x1f\x7f]/g, (m) => (/^\x1b\[[0-9;]*m$/.test(m) ? m : "")).replace(/\t/g, " ");
}

export function clampLines(lines: string[], width: number): string[] {
	return lines.map((l) => (visibleWidth(l) > width ? truncateToWidth(l, width) : l));
}

/** Plain explanatory text, word-wrapped to `w` and dimmed. */
export function note(ink: Ink, text: string, w: number): string[] {
	return wrapTextWithAnsi(text, Math.max(1, w)).map((l) => ink.dim(l));
}
