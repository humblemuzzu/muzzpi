/**
 * Replays a chart spec, a JSON list of [method, args, kwargs] calls, onto an mpl Figure.
 * Adapted from mpl's tools/replay-core.ts (buildWith, not exported by the package) and
 * dmmulroy's pi mpl extension: every method name is checked against matplotlib-style
 * Axes and Figure methods, and an error names the call index so the model can fix it.
 */
import type * as MplModule from "mpl";
import type { Axes, Figure } from "mpl";

export type Mpl = typeof MplModule;

export type MplCall = readonly [method: string, args?: readonly unknown[], kwargs?: Readonly<Record<string, unknown>>];

export interface MplGrid {
	readonly rows: number;
	readonly cols: number;
	readonly sharex?: boolean | string;
	readonly sharey?: boolean | string;
	readonly width_ratios?: readonly number[];
	readonly height_ratios?: readonly number[];
}

export interface MplFigureSpec {
	/** subplots({ style }): a bundled style name, an rc object, or a list of those. */
	readonly style: unknown;
	readonly rc?: Readonly<Record<string, unknown>>;
	readonly grid?: MplGrid;
	readonly calls: readonly MplCall[];
}

export class MplSpecError extends Error {
	override readonly name = "MplSpecError";
}

type Dyn = Record<string, (...args: unknown[]) => unknown>;

export const MPL_FIGURE_METHODS = [
	"text",
	"suptitle",
	"supxlabel",
	"supylabel",
	"subplots_adjust",
	"autofmt_xdate",
	"tight_layout",
	"colorbar",
] as const;

export const MPL_SPECIAL_CALLS = ["sca", "twinx", "spine", "$concise_x", "$date_x"] as const;

const DATE_LOCATORS = ["AutoDateLocator", "YearLocator", "MonthLocator", "DayLocator", "HourLocator", "MinuteLocator", "SecondLocator"] as const;

// lower-case public methods of mpl's Axes that are its own plumbing, not matplotlib API
const AXES_INTERNALS = new Set(["bars", "lines", "next", "settle"]);

const axesMethodCache = new WeakMap<object, ReadonlySet<string>>();

/** Axes methods a spec may call: matplotlib's snake_case API as mpl implements it. */
export function axesMethods(mpl: Mpl): ReadonlySet<string> {
	const cached = axesMethodCache.get(mpl.Axes.prototype);
	if (cached) return cached;
	const names = new Set<string>();
	for (let p: object | null = mpl.Axes.prototype; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
		for (const name of Object.getOwnPropertyNames(p)) {
			if (!/^[a-z][a-z0-9_]*$/.test(name) || AXES_INTERNALS.has(name)) continue;
			const d = Object.getOwnPropertyDescriptor(p, name);
			if (d && typeof d.value === "function") names.add(name);
		}
	}
	axesMethodCache.set(mpl.Axes.prototype, names);
	return names;
}

/** A naive ISO date-time is UTC, as numpy's datetime64 (a date alone is midnight); an offset or Z is kept. */
function toDate(s: unknown): Date {
	if (typeof s === "number") return new Date(s);
	if (typeof s !== "string") throw new MplSpecError(`$date/$dates expects ISO strings or epoch ms, got ${JSON.stringify(s)}`);
	const hasZone = /([zZ]|[+-]\d\d:?\d\d)$/.test(s);
	const iso = s.includes("T") || s.includes(" ") ? s.replace(" ", "T") : `${s}T00:00`;
	const d = new Date(hasZone ? iso : `${iso}Z`);
	if (Number.isNaN(d.getTime())) throw new MplSpecError(`invalid date ${JSON.stringify(s)}`);
	return d;
}

/** JSON to mpl values at any depth: {$date}, {$dates}, {$float}, {$arange: [n, step]}, {$tuple}. */
export function decodeValue(a: unknown): unknown {
	if (Array.isArray(a)) return a.map(decodeValue);
	if (a === null || typeof a !== "object") return a;
	const o = a as Record<string, unknown>;
	if ("$dates" in o) {
		if (!Array.isArray(o.$dates)) throw new MplSpecError("$dates expects an array");
		return o.$dates.map(toDate);
	}
	if ("$date" in o) return toDate(o.$date);
	if ("$float" in o) {
		const s = String(o.$float);
		return s === "nan" ? NaN : s === "inf" ? Infinity : s === "-inf" ? -Infinity : Number(s);
	}
	if ("$arange" in o) {
		const [n, step = 1, start = 0] = (Array.isArray(o.$arange) ? o.$arange : []) as number[];
		if (!Number.isInteger(n) || n! < 0 || n! > 1_000_000) throw new MplSpecError("$arange expects [n, step?, start?] with 0 <= n <= 1000000");
		return Array.from({ length: n! }, (_, i) => start + i * step);
	}
	if ("$tuple" in o) return decodeValue(o.$tuple);
	return a;
}

function decodeKwargs(kwargs: Readonly<Record<string, unknown>> | undefined, ax: Axes, axes: readonly Axes[]): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(kwargs ?? {})) {
		if (v && typeof v === "object" && "$transform" in v) {
			const t = (v as { $transform: unknown }).$transform;
			if (t !== "axes" && t !== "data") throw new MplSpecError(`$transform must be "axes" or "data"`);
			out[k] = t === "axes" ? ax.transAxes : ax.transData;
		} else if (v && typeof v === "object" && "$axes" in v) {
			const ids = (v as { $axes: unknown }).$axes;
			const list = (Array.isArray(ids) ? ids : [ids]).map((i) => {
				const found = typeof i === "number" ? axes[i] : undefined;
				if (!found) throw new MplSpecError(`$axes: no Axes ${String(i)} (have ${axes.length})`);
				return found;
			});
			out[k] = Array.isArray(ids) ? list : list[0];
		} else out[k] = decodeValue(v);
	}
	return out;
}

function withKwargs(args: readonly unknown[], kw: Record<string, unknown>): unknown[] {
	return Object.keys(kw).length > 0 ? [...args, kw] : [...args];
}

function unknownMethod(fn: string, mpl: Mpl): MplSpecError {
	return new MplSpecError(
		`unknown call "${fn}". Axes methods: ${[...axesMethods(mpl)].sort().join(", ")}. ` +
			`Figure methods (prefix "fig."): ${MPL_FIGURE_METHODS.join(", ")}. Special: ${MPL_SPECIAL_CALLS.join(", ")}.`,
	);
}

function lastMappable(ax: Axes): unknown {
	for (let i = ax.artists.length - 1; i >= 0; i--) {
		const a = ax.artists[i] as { kind: string; mappable?: { kind: string } };
		if (a.kind === "image" || (a.kind === "scatter" && a.mappable?.kind === "some")) return a;
	}
	return undefined;
}

/** Builds the Figure for a spec. Throws MplSpecError, naming the call, for spec mistakes and mpl's own errors. */
export function buildFigure(mpl: Mpl, spec: MplFigureSpec): Figure {
	const base = { style: spec.style, rc: spec.rc ?? {} };
	let fig: Figure;
	let axes: Axes[];
	try {
		if (spec.grid) {
			const { rows, cols, width_ratios, height_ratios, ...gridKw } = spec.grid;
			const ratios = { ...(width_ratios && { width_ratios }), ...(height_ratios && { height_ratios }) };
			const gridspec_kw = Object.keys(ratios).length > 0 ? { gridspec_kw: ratios } : {};
			const [f, made] = mpl.subplots(rows, cols, { ...gridKw, ...gridspec_kw, ...base, squeeze: false } as never);
			fig = f;
			axes = (made as unknown as Axes[][]).flat();
		} else {
			const [f, ax] = mpl.subplots(base as never);
			fig = f;
			axes = [ax as unknown as Axes];
		}
	} catch (error) {
		throw new MplSpecError(`figure (theme, rc or grid): ${error instanceof Error ? error.message : String(error)}`);
	}
	let ax = axes[0]!;
	const allowed = axesMethods(mpl);

	spec.calls.forEach((call, index) => {
		if (!Array.isArray(call) || typeof call[0] !== "string") {
			throw new MplSpecError(`calls[${index}] must be [method, args?, kwargs?], got ${JSON.stringify(call)}`);
		}
		const [fn, args0 = [], kwargs] = call;
		if (!Array.isArray(args0) || Array.isArray(kwargs) || (kwargs !== undefined && typeof kwargs !== "object") || call.length > 3) {
			throw new MplSpecError(
				`calls[${index}] ${fn}: expected [method, [positional args], {kwargs}]; wrap all positional args in one array, ` +
					`e.g. ["bar", [["a", "b"], [3, 7]], { color: "C1" }]`,
			);
		}
		try {
			const args = args0.map(decodeValue);
			if (fn === "sca") {
				const i = args[0];
				if (typeof i !== "number" || !axes[i]) throw new MplSpecError(`no Axes ${String(i)} (have ${axes.length})`);
				ax = axes[i]!;
				return;
			}
			if (fn === "twinx") {
				ax = ax.twinx();
				axes.push(ax);
				return;
			}
			if (fn === "spine") {
				const [side, method, value] = args as [string, string, unknown];
				const spine = (ax.spines as unknown as Record<string, Dyn | undefined>)[side];
				if (!spine || typeof spine[method] !== "function") {
					throw new MplSpecError(`expected ["spine", [left|right|top|bottom, set_visible|set_color|set_linewidth|set_position, value]]`);
				}
				spine[method]!(value);
				return;
			}
			if (fn === "$concise_x") {
				const loc = new mpl.AutoDateLocator();
				ax.xaxis.set_major_locator(loc as never);
				ax.xaxis.set_major_formatter(new mpl.ConciseDateFormatter(loc as never, (kwargs ?? {}) as never) as never);
				return;
			}
			if (fn === "$date_x") {
				const [name, lkw, fmt] = args0 as [string, Record<string, unknown> | undefined, string | undefined];
				if (!(DATE_LOCATORS as readonly string[]).includes(name)) {
					throw new MplSpecError(`unknown locator ${name}; use one of ${DATE_LOCATORS.join(", ")}`);
				}
				const Loc = (mpl as unknown as Record<string, new (kw?: unknown) => unknown>)[name]!;
				const loc = new Loc(lkw ?? {});
				ax.xaxis.set_major_locator(loc as never);
				if (fmt === "concise") ax.xaxis.set_major_formatter(new mpl.ConciseDateFormatter(loc as never, {}) as never);
				else if (typeof fmt === "string") ax.xaxis.set_major_formatter(new mpl.DateFormatter(fmt) as never);
				return;
			}
			const kw = decodeKwargs(kwargs, ax, axes);
			if (fn.startsWith("fig.")) {
				const name = fn.slice(4);
				if (!(MPL_FIGURE_METHODS as readonly string[]).includes(name)) throw unknownMethod(fn, mpl);
				if (name === "colorbar") {
					const mappable = lastMappable(ax);
					if (!mappable) throw new MplSpecError("no imshow or colour-mapped scatter on the current Axes");
					fig.colorbar(mappable, Object.keys(kw).length > 0 ? kw : undefined);
					return;
				}
				(fig as unknown as Dyn)[name]!(...withKwargs(args, kw));
				return;
			}
			if (!allowed.has(fn)) throw unknownMethod(fn, mpl);
			(ax as unknown as Dyn)[fn]!(...withKwargs(args, kw));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new MplSpecError(`calls[${index}] ${fn}: ${message}`);
		}
	});
	return fig;
}
