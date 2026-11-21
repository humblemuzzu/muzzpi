/**
 * mpl_render: a codemode tool that draws matplotlib charts with mpl (github.com/ivarvong/mpl)
 * from a JSON call list, after dmmulroy's pi extension. Files go to <agent dir>/charts/<date>/;
 * the script gets the PNG, fitted to the model's image limits, to show with image().
 */
import path from "node:path";
import { getAgentDir, type ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { defaultOutDir, fitImageFile, pruneOutDir } from "./lib/image-fit";
import { planToolImages, recordReturnedImages, sessionNote } from "./lib/image-budget";
import { chartDir, MPL_DEFAULT_THEME, MPL_THEMES, type MplRenderInput, renderChart } from "./lib/mpl-render";
import { MPL_FIGURE_METHODS } from "./lib/mpl-replay";

export const MPL_INSTRUCTIONS = `Reference for mpl_render. mpl is a pixel-exact TypeScript port of matplotlib 3.11: calls follow matplotlib's object API (ax.<method>(*args, **kwargs)), kwargs and rc keys included.

Spec: { calls, theme?, rc?, grid?, scale?, name?, svg?, html?, tight_layout? }
- calls: [method, [positional args], {kwargs}], applied in order to the current Axes. ax.plot(x, y, 'o-', label='a') is ["plot", [x, y, "o-"], { label: "a" }].
- grid: { rows, cols, sharex?, sharey?, width_ratios?, height_ratios? }. Axes are numbered row-major from 0; ["sca", [i]] makes Axes i current; ["twinx", []] adds a twin and makes it current.
- Figure calls take a "fig." prefix: ${MPL_FIGURE_METHODS.map((m) => `fig.${m}`).join(", ")}. fig.colorbar maps the last imshow or colour-mapped scatter on the current Axes; kwarg ax: {"$axes": [0, 1]} spans Axes.
- Spines: ["spine", ["left", "set_visible", true]] (set_visible, set_color, set_linewidth, set_position).
- Values: {"$float": "nan"} is NaN; {"$arange": [n, step?, start?]} is n evenly spaced numbers. Kwarg {"$transform": "axes"} is ax.transAxes.
- theme: "${MPL_DEFAULT_THEME}" (default, dark, matches the terminal), "gruvbox-light" for docs and light pages, ${MPL_THEMES.slice(2).map((t) => `"${t}"`).join(", ")}, or any matplotlib style name (ggplot, seaborn-v0_8-whitegrid, ...). rc overrides keys, e.g. { "figure.figsize": [9, 4] }.
- scale: PNG pixel multiplier from 0.25 to 4, default 2 (1440x840 at the default 7.2x4.2 in); 3 for print. The image you get is fitted to your vision limits; the file keeps full size.
- svg: true also writes an SVG; html: true writes a standalone page with hover tooltips, crosshair and legend toggles (open it with \`open <path>\`).
- tight_layout runs unless the calls call fig.tight_layout or fig.subplots_adjust.

Dates:
- {"$dates": ["2026-01-01", ...]} is Date[], {"$date": "..."} one Date; naive ISO strings are UTC. plot, bar, text, axvline and fill_between take them.
- Ticks: ["$concise_x", []] for ConciseDateFormatter, or ["$date_x", ["MonthLocator", { interval: 1 }, "%b %d" | "concise"]].
- annotate takes epoch days (ms / 86400000) as coordinates.

Gruvbox cycle C0..C7: blue #83a598, orange #fe8019, green #b8bb26, red #fb4934, purple #d3869b, aqua #8ec07c, yellow #fabd2f, grey #a89984 (C0..C4 in matplotlib's own order). Muted text #a89984, grid #3c3836.

Chart types: line, step, scatter, bar/barh (bottom/left for stacks), hist, boxplot, errorbar, fill_between, pie, imshow + fig.colorbar, axhline/axvline/axhspan/axvspan, hlines/vlines, text, annotate; log scales via set_xscale/set_yscale. For shares prefer barh; for distributions hist or boxplot; for legend placement loc and ncols.

Gotchas:
- Unknown kwargs and rc keys throw, as in matplotlib; the error names the call index and the key.
- imshow: the themes grid the y axis, and grid lines draw over images; add ["grid", [false]] on that Axes.
- Scatter legend: label a proxy ["plot", [[], [], "o"], { color: "C0", label: "name" }] rather than the scatter.
- Text: Latin, Greek, arrows and math symbols only (Inter and DejaVu); use ASCII for tree labels and ~ for approximations.
- Keep each series under ~100k points.

Done when: the image you showed has no overlapping or clipped labels, no legend covering data, and readable ticks; otherwise adjust (figsize, ticks, legend loc, ylim headroom, $concise_x for dates) and render again.`;

const imageBlock = Type.Object({ type: Type.Literal("image"), data: Type.String(), mimeType: Type.String() });

export const mplRenderOutput = Type.Object({
	image: Type.Optional(imageBlock),
	png: Type.Optional(Type.String()),
	svg: Type.Optional(Type.String()),
	html: Type.Optional(Type.String()),
	width: Type.Optional(Type.Number()),
	height: Type.Optional(Type.Number()),
	note: Type.Optional(Type.String()),
	error: Type.Optional(Type.String()),
});

export function createMplRenderTool(chartsRoot: () => string = () => path.join(getAgentDir(), "charts")): ToolDefinition {
	return {
		name: "mpl_render",
		label: "mpl render",
		description:
			'Draw a chart from data as PNG (plus SVG or an interactive HTML page) through the matplotlib API. Read describeNamespace("mpl") before the first chart; show the result with image(r.image) and check it.',
		parameters: Type.Object({
			calls: Type.Array(Type.Array(Type.Unknown(), { minItems: 1, maxItems: 3 }), {
				description: '[method, [positional args], {kwargs}], e.g. ["bar", [names, values], { color: "C1" }]',
			}),
			theme: Type.Optional(Type.String({ description: `default ${MPL_DEFAULT_THEME}` })),
			rc: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
			grid: Type.Optional(
				Type.Object({
					rows: Type.Integer({ minimum: 1 }),
					cols: Type.Integer({ minimum: 1 }),
					sharex: Type.Optional(Type.Union([Type.Boolean(), Type.String()])),
					sharey: Type.Optional(Type.Union([Type.Boolean(), Type.String()])),
					width_ratios: Type.Optional(Type.Array(Type.Number())),
					height_ratios: Type.Optional(Type.Array(Type.Number())),
				}),
			),
			scale: Type.Optional(Type.Number()),
			name: Type.Optional(Type.String({ description: 'file stem, e.g. "latency-by-region"' })),
			svg: Type.Optional(Type.Boolean()),
			html: Type.Optional(Type.Boolean()),
			tight_layout: Type.Optional(Type.Boolean()),
		}),
		outputSchema: mplRenderOutput,
		exposure: "codemode",
		namespace: { name: "mpl", description: "matplotlib charts", instructions: MPL_INSTRUCTIONS },
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },

		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const files = await renderChart(params as MplRenderInput, chartDir(chartsRoot()));
				const saved = [files.png, files.svg, files.html].filter(Boolean).join("\n");
				const images = planToolImages(ctx);
				if (!images.ok) {
					return {
						content: [{ type: "text" as const, text: `${saved}\n${images.reason}` }],
						structuredContent: { ...files, note: images.reason },
						details: undefined,
					};
				}
				pruneOutDir(defaultOutDir());
				const fit = fitImageFile(files.png, {
					tier: images.tier,
					limits: images.limits,
					budget: images.budget,
					basename: `mpl-${Date.now()}`,
					// a chart is read whole: downscale it, never cut it into slices
					minLongEdge: 0,
				});
				const shown = fit.outputs[0]!;
				recordReturnedImages(ctx, toolCallId, fit.totalBase64, 1);
				const note = [shown.path === files.png ? undefined : fit.summary, ...fit.notes, sessionNote(images.limits, images.usage, fit.totalBase64)]
					.filter(Boolean)
					.join("\n");
				return {
					content: [{ type: "text" as const, text: [saved, note].filter(Boolean).join("\n") }],
					structuredContent: {
						image: { type: "image", data: shown.base64, mimeType: shown.mimeType },
						...files,
						...(note && { note }),
					},
					details: undefined,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text" as const, text: `mpl_render failed: ${message}` }],
					structuredContent: { error: message },
					details: undefined,
					isError: true,
				};
			}
		},
	} as ToolDefinition;
}
