import { visibleWidth } from "@mariozechner/pi-tui";
import { bold, dot, fg, type Ink, hbar, hstack, pad, type RGB, segmentBar, spread, split } from "./draw";

/**
 * The layout kit every tab is built from. A tab returns blocks; the page
 * puts the same air between them everywhere, so spacing is decided here and
 * nowhere else.
 */

/** Something drawn at a width chosen by its container. */
export type Body = (w: number) => string[];

export interface Section {
	title: string;
	meta?: string;
	body: Body;
	/** A fixed width inside a grid; cells without one share what is left. */
	width?: number;
}

const SECTION_GAP = 2;
const GRID_GAP = 6;

export function section(ink: Ink, w: number, s: Section): string[] {
	return [spread(bold(ink.text(s.title)), s.meta ? ink.dim(s.meta) : "", w), "", ...s.body(w)];
}

/** Blocks top to bottom with a fixed breath between them. */
export function page(blocks: string[][]): string[] {
	const out: string[] = [];
	for (const b of blocks) {
		if (!b.length) continue;
		if (out.length) out.push(...new Array(SECTION_GAP).fill(""));
		out.push(...b);
	}
	return out;
}

/** Sections side by side when every flexible cell gets `min` columns, else stacked. */
export function grid(ink: Ink, w: number, cells: Section[], min = 52): string[] {
	const fixed = cells.reduce((a, c) => a + (c.width ?? 0), 0);
	const flexible = cells.filter((c) => c.width === undefined).length;
	const left = w - fixed - GRID_GAP * (cells.length - 1);
	if (cells.length === 1 || (flexible ? left < min * flexible : left < 0)) {
		return page(cells.map((c) => section(ink, w, c)));
	}
	const shares = flexible ? split(left + GRID_GAP * (flexible - 1), flexible, GRID_GAP) : [];
	let next = 0;
	const widths = cells.map((c) => c.width ?? shares[next++]);
	return hstack(cells.map((c, i) => section(ink, widths[i], c)), widths, GRID_GAP);
}

export interface Metric {
	label: string;
	value: string;
	/** Under the value: context, then the change against the previous window. */
	sub?: string;
	delta?: string;
	color?: RGB;
}

/** The headline numbers: label, a bold value, a quiet line under it. */
export function metrics(ink: Ink, items: Metric[], w: number, minWidth = 22): string[] {
	const subLine = (m: Metric) => [m.delta, m.sub ? ink.dim(m.sub) : ""].filter(Boolean).join(ink.dim("  "));
	const need = Math.max(minWidth, ...items.map((m) => Math.max(visibleWidth(m.label), visibleWidth(m.value), visibleWidth(subLine(m))) + 2));
	const fit = Math.max(1, Math.min(items.length, Math.floor((w + 4) / (need + 4))));
	const perRow = Math.ceil(items.length / Math.ceil(items.length / fit));
	const widths = split(w, perRow, 4);
	const out: string[] = [];
	for (let i = 0; i < items.length; i += perRow) {
		const chunk = items.slice(i, i + perRow);
		const blocks = chunk.map((m) => [ink.muted(m.label), bold(m.color ? fg(m.color, m.value) : ink.text(m.value)), subLine(m)]);
		if (i) out.push("");
		out.push(...hstack(blocks, widths.slice(0, chunk.length), 4));
	}
	return out;
}

/** Label/value pairs, in two columns once there is room. */
export function kv(ink: Ink, pairs: Array<[string, string]>, w: number): string[] {
	if (w < 76) return pairs.map(([k, v]) => spread(ink.muted(k), v, w));
	const [lw, rw] = split(w, 2, GRID_GAP);
	const half = Math.ceil(pairs.length / 2);
	const left = pairs.slice(0, half).map(([k, v]) => spread(ink.muted(k), v, lw));
	const right = pairs.slice(half).map(([k, v]) => spread(ink.muted(k), v, rw));
	return hstack([left, right], [lw, rw], GRID_GAP);
}

export interface Bar {
	label: string;
	value: number;
	text: string;
	color: RGB;
}

/** Ranked rows: label, a bar against the largest, the value. */
export function barList(ink: Ink, items: Bar[], w: number, labelW = 18, empty = "Nothing here yet."): string[] {
	if (!items.length) return [ink.muted(empty)];
	const max = Math.max(...items.map((i) => i.value));
	const textW = Math.max(...items.map((i) => visibleWidth(i.text)), 4);
	const barW = Math.max(4, w - labelW - textW - 4);
	return items.map((i) => `${pad(i.label, labelW)}  ${hbar(max > 0 ? i.value / max : 0, barW, i.color)}  ${ink.text(i.text.padStart(textW))}`);
}

/** A proportion bar and the legend that names every part, including parts too small to show. */
export function shareList(ink: Ink, w: number, parts: Array<{ label: string; value: number; color: RGB; detail?: string }>, format: (v: number) => string): string[] {
	const total = parts.reduce((a, p) => a + p.value, 0);
	const live = parts.filter((p) => p.value > 0);
	if (!parts.length) return [ink.muted("Nothing in this range.")];
	const labelW = Math.max(...parts.map((p) => visibleWidth(p.label))) + 2;
	const valueW = Math.max(...parts.map((p) => format(p.value).length)) + 2;
	const rows = [...live, ...parts.filter((p) => p.value <= 0)].map((p) => {
		const head = `${dot(p.color)} ${pad(p.label, labelW)}${ink.text(format(p.value).padStart(valueW))}  ${ink.dim(`${total > 0 ? Math.round((p.value / total) * 100) : 0}%`.padStart(4))}`;
		return p.detail ? spread(head, ink.dim(p.detail), w) : head;
	});
	return [segmentBar(live.map((p) => [p.color, p.value]), w), "", ...rows];
}
