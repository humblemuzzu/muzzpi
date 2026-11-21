/**
 * Renders an mpl chart spec (github.com/ivarvong/mpl, a pixel-exact port of matplotlib)
 * to files. mpl loads on the first chart, not at pi startup.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { buildFigure, type Mpl, type MplCall, type MplGrid, MplSpecError } from "./mpl-replay";

type Rc = Readonly<Record<string, unknown>>;

interface Palette {
	bg: string;
	grid: string;
	edge: string;
	tick: string;
	muted: string;
	label: string;
	ink: string;
	cycle: readonly string[];
}

function gruvboxStyle(p: Palette): Rc {
	return {
		"figure.facecolor": p.bg,
		"axes.facecolor": p.bg,
		"savefig.facecolor": p.bg,
		"axes.edgecolor": p.edge,
		"grid.color": p.grid,
		"text.color": p.ink,
		"axes.titlecolor": p.ink,
		"axes.labelcolor": p.label,
		"xtick.color": p.tick,
		"ytick.color": p.tick,
		"xtick.labelcolor": p.muted,
		"ytick.labelcolor": p.muted,
		"patch.edgecolor": p.bg,
		"legend.labelcolor": p.label,
		"axes.prop_cycle": p.cycle,
		"font.family": "Inter",
		"font.size": 9,
		"figure.figsize": [7.2, 4.2],
		"axes.spines.top": false,
		"axes.spines.right": false,
		"axes.spines.left": false,
		"axes.grid": true,
		"axes.grid.axis": "y",
		"axes.axisbelow": true,
		"axes.linewidth": 0.8,
		"axes.titlesize": 12,
		"axes.titleweight": "semibold",
		"axes.titlelocation": "left",
		"axes.titlepad": 10,
		"axes.labelsize": 9,
		"axes.labelpad": 6,
		"grid.linestyle": "-",
		"grid.linewidth": 0.6,
		"lines.linewidth": 1.6,
		"lines.solid_capstyle": "round",
		"lines.markersize": 5,
		"patch.linewidth": 0,
		"xtick.major.size": 3,
		"xtick.major.width": 0.8,
		"xtick.major.pad": 5,
		"xtick.labelsize": 8.5,
		"xtick.direction": "out",
		"ytick.major.size": 0,
		"ytick.major.pad": 6,
		"ytick.labelsize": 8.5,
		"legend.frameon": false,
		"legend.fontsize": 8.5,
		"legend.handlelength": 1.4,
		"legend.handletextpad": 0.6,
		"legend.columnspacing": 1.4,
	};
}

/** Gruvbox, pi's default theme here. The cycle keeps matplotlib's order: blue, orange, green, red, purple first. */
const GRUVBOX = gruvboxStyle({
	bg: "#282828",
	grid: "#3c3836",
	edge: "#504945",
	tick: "#665c54",
	muted: "#a89984",
	label: "#d5c4a1",
	ink: "#ebdbb2",
	cycle: ["#83a598", "#fe8019", "#b8bb26", "#fb4934", "#d3869b", "#8ec07c", "#fabd2f", "#a89984"],
});

const GRUVBOX_LIGHT = gruvboxStyle({
	bg: "#fbf1c7",
	grid: "#ebdbb2",
	edge: "#d5c4a1",
	tick: "#bdae93",
	muted: "#7c6f64",
	label: "#504945",
	ink: "#3c3836",
	cycle: ["#076678", "#af3a03", "#79740e", "#9d0006", "#8f3f71", "#427b58", "#b57614", "#7c6f64"],
});

export const MPL_DEFAULT_THEME = "gruvbox";
export const MPL_DEFAULT_SCALE = 2;

/** Themes named in the tool's instructions; any matplotlib style mpl bundles works too. */
export const MPL_THEMES = [
	"gruvbox",
	"gruvbox-light",
	"pro-dark",
	"pro-slate",
	"pro-mono",
	"pro-ember",
	"modern",
	"modern-dark",
	"paper-modern",
	"paper-classic",
] as const;

function themeStyle(mpl: Mpl, theme: string): unknown {
	switch (theme) {
		case "gruvbox":
			return GRUVBOX;
		case "gruvbox-light":
			return GRUVBOX_LIGHT;
		case "modern":
			return mpl.modern;
		case "modern-dark":
			return mpl.modernDark;
		case "paper-modern":
			return mpl.paperModern;
		case "paper-classic":
			return mpl.paperClassic;
		case "default":
			return [];
	}
	if (mpl.availableStyles().includes(theme)) return theme;
	const all = [...MPL_THEMES, ...mpl.availableStyles().filter((s) => !s.startsWith("pro-")), "default"];
	throw new MplSpecError(`unknown theme "${theme}"; use one of ${all.join(", ")}`);
}

let loading: Promise<{ mpl: Mpl; client: string }> | undefined;

function loadMpl(): Promise<{ mpl: Mpl; client: string }> {
	loading ??= (async () => {
		const require = createRequire(import.meta.url);
		let clientPath: string;
		try {
			clientPath = require.resolve("mpl/interactive");
		} catch {
			throw new Error(
				`mpl is not installed beside the tools extension (${path.dirname(new URL(import.meta.url).pathname)}). ` +
					"Run ./install.sh pi, which installs github:ivarvong/mpl from tools/package.json.",
			);
		}
		const [mpl, fonts, colormaps, colormapRgba, annotate] = await Promise.all([
			import("mpl"),
			import("mpl/fonts/all"),
			import("mpl/colormaps/all"),
			import("mpl/colormaps/all.rgba"),
			import("mpl/annotate"),
		]);
		mpl.registerFonts(...fonts.allFonts);
		mpl.registerColormaps(...colormaps.allColormaps);
		mpl.registerColormapRgba(...colormapRgba.allColormapRgba);
		mpl.registerSidecar(annotate.sidecar);
		return { mpl: mpl as Mpl, client: readFileSync(clientPath, "utf8") };
	})();
	loading.catch(() => {
		loading = undefined;
	});
	return loading;
}

export interface MplRenderInput {
	readonly calls: readonly MplCall[];
	readonly theme?: string;
	readonly rc?: Rc;
	readonly grid?: MplGrid;
	readonly scale?: number;
	readonly name?: string;
	readonly svg?: boolean;
	readonly html?: boolean;
	readonly tight_layout?: boolean;
}

export interface MplRenderOutput {
	readonly png: string;
	readonly svg?: string;
	readonly html?: string;
	readonly width: number;
	readonly height: number;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** <dir>/<YYYY-MM-DD>, local time: the day the user made the chart. */
export function chartDir(root: string, now = new Date()): string {
	return path.join(root, `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`);
}

function fileStem(dir: string, name: string | undefined, now: Date): string {
	const slug = (name ?? "chart").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|-+$/g, "").slice(0, 60) || "chart";
	const base = `${slug}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
	let stem = base;
	for (let n = 2; existsSync(path.join(dir, `${stem}.png`)); n++) stem = `${base}-${n}`;
	return stem;
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => `&${{ "&": "amp", "<": "lt", ">": "gt", '"': "quot" }[c]};`);

function isDark(hex: string): boolean {
	const full = hex.length === 4 ? hex.replace(/[0-9a-f]/gi, (c) => c + c) : hex;
	const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(full.slice(i, i + 2), 16) / 255) as [number, number, number];
	return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.5;
}

/** One self-contained page: the annotated SVG and mpl's hover client (crosshair, tooltips, legend toggles). */
function interactivePage(title: string, svg: string, client: string): string {
	const head = /^<svg [^>]*width="([\d.]+)" height="([\d.]+)"[^>]*>\s*<rect [^>]*fill="(#[0-9a-fA-F]{3,6})"/.exec(svg);
	const [width, height, bg] = head ? [Number(head[1]), Number(head[2]), head[3]!] : [4, 3, "#ffffff"];
	return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title>
<style>:root{color-scheme:${isDark(bg) ? "dark" : "light"}}body{margin:0;min-height:100vh;display:grid;place-items:center;background:${bg}}svg{width:min(96vw,1600px,calc(94vh * ${(width / height).toFixed(4)}));height:auto}</style>
</head><body>
${svg}
<script type="module">
${client}
attach(document);
</script>
</body></html>
`;
}

export async function renderChart(input: MplRenderInput, dir: string): Promise<MplRenderOutput> {
	const scale = input.scale ?? MPL_DEFAULT_SCALE;
	if (!(scale >= 0.25 && scale <= 4)) throw new MplSpecError(`scale must be between 0.25 and 4, got ${scale}`);
	const { mpl, client } = await loadMpl();
	const fig = buildFigure(mpl, {
		style: themeStyle(mpl, input.theme ?? MPL_DEFAULT_THEME),
		// glyph outlines: an SVG's text looks the same without Inter installed
		rc: { "svg.fonttype": "path", ...input.rc },
		grid: input.grid,
		calls: input.calls,
	});
	const laidOut = input.calls.some((c) => c[0] === "fig.tight_layout" || c[0] === "fig.subplots_adjust");
	if (input.tight_layout ?? !laidOut) {
		try {
			fig.tight_layout();
		} catch (error) {
			throw new MplSpecError(`tight_layout: ${error instanceof Error ? error.message : String(error)}; pass tight_layout: false`);
		}
	}

	let png: Uint8Array;
	try {
		png = fig.toPNGSync({ scale });
	} catch (error) {
		throw new MplSpecError(`drawing the PNG: ${error instanceof Error ? error.message : String(error)}`);
	}
	const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
	const now = new Date();
	mkdirSync(dir, { recursive: true });
	const stem = fileStem(dir, input.name, now);
	const out = { png: path.join(dir, `${stem}.png`), width: view.getUint32(16), height: view.getUint32(20) };
	writeFileSync(out.png, png);
	const svg = input.svg ? path.join(dir, `${stem}.svg`) : undefined;
	if (svg) writeFileSync(svg, fig.toSVG());
	const html = input.html ? path.join(dir, `${stem}.html`) : undefined;
	if (html) writeFileSync(html, interactivePage(input.name ?? stem, fig.toSVG({ interactive: true }), client));
	return { ...out, ...(svg && { svg }), ...(html && { html }) };
}
