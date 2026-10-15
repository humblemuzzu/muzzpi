/**
 * /stats — usage analytics over every session pi, Claude Code, Codex and
 * OpenCode left on this Mac: spend, tokens, cache, models, tools, agents,
 * projects and commits, rhythm, wrapped.
 *
 * Read-only over each harness's own files and the repos sessions ran in;
 * the only writes are its own ledgers, settings and exports under
 * <agent dir>/cache/stats. No network. Nothing here reaches the model: no
 * tool, no prompt text, no session message.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { decodeKittyPrintable, Key, matchesKey, type TUI } from "@mariozechner/pi-tui";
import { burn, type Dataset, monthWindow, prepare, RANGES, type RangeId, summarize, summarizeWindow } from "./aggregate";
import { bold, card, center, clampLines, dot, HARNESS_COLOR, hbar, type Ink, int, money, pad, plain } from "./draw";
import { commitsSince, loadGit } from "./git";
import { type IngestProgress, ingestAll, ingestPiWarm, type SourceStatus } from "./ingest";
import { type CatalogModel, PriceBook } from "./pricing";
import { dayKey, HARNESS_LABEL, HARNESSES } from "./record";
import { markdownReport } from "./report";
import { readSettings, todayText, widgetLine, writeSettings } from "./today";
import { StatsView, terminalRows } from "./view";
import { writeWrappedPng } from "./wrapped";

const SHORTCUT = "ctrl+shift+s";
const WIDGET_KEY = "stats-today";
const WIDGET_DEBOUNCE_MS = 1500;

const cacheDir = () => path.join(getAgentDir(), "cache", "stats");
const sessionsDir = () => path.join(getAgentDir(), "sessions");

function inkFrom(theme: Theme): Ink {
	return {
		text: (s) => theme.fg("text", s),
		muted: (s) => theme.fg("muted", s),
		dim: (s) => theme.fg("dim", s),
		accent: (s) => theme.fg("accent", s),
		border: (s) => theme.fg("borderMuted", s),
	};
}

function planUsd(): number {
	const n = Number(process.env.PI_STATS_PLAN_USD);
	return Number.isFinite(n) && n > 0 ? n : 200;
}

const USAGE = "/stats [export|wrapped] [7d|30d|90d|1y|all] \u00b7 /stats widget on|off \u00b7 /stats budget <usd>|off";

/** The range named on the command line: 30 days when none is, undefined for one that does not exist. */
function rangeArg(arg: string | undefined): RangeId | undefined {
	return arg ? RANGES.find((r) => r.id === arg)?.id : "30d";
}

/** pi's model catalog, the only price list used: local, and the same one pi prices its own turns from. */
function priceBook(ctx: ExtensionContext): PriceBook {
	return new PriceBook(ctx.modelRegistry.getAll() as unknown as CatalogModel[]);
}

interface Loaded {
	ds: Dataset;
	problems: string[];
}

async function load(ctx: ExtensionContext, onProgress?: (p: IngestProgress) => void, signal?: AbortSignal): Promise<Loaded> {
	const { records, status } = await ingestAll({ piSessions: sessionsDir(), cacheDir: cacheDir(), prices: priceBook(ctx), onProgress, signal });
	const firstSeen = new Map<string, number>();
	for (const r of records) if (r.cwd && r.startMs) firstSeen.set(r.cwd, Math.min(firstSeen.get(r.cwd) ?? Infinity, r.startMs));
	const problems = HARNESSES.filter((h) => status[h].state === "failed").map((h) => `${HARNESS_LABEL[h]} could not be read (${status[h].error}); showing what was read before.`);
	return { ds: prepare(records, await loadGit(firstSeen, cacheDir())), problems };
}

/** Context window per `provider/model` the dataset has seen, from pi's model registry; unknown models are left out. */
function contextWindows(ctx: ExtensionContext, models: string[]): Map<string, number> {
	const out = new Map<string, number>();
	for (const key of models) {
		const slash = key.indexOf("/");
		const size = ctx.modelRegistry.find(key.slice(0, slash), key.slice(slash + 1))?.contextWindow;
		if (typeof size === "number" && size > 0) out.set(key, size);
	}
	return out;
}

function size(bytes: number): string {
	return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : bytes >= 1e6 ? `${Math.round(bytes / 1e6)} MB` : `${Math.round(bytes / 1e3)} KB`;
}

function sourceLine(ink: Ink, s: SourceStatus): string {
	switch (s.state) {
		case "waiting":
			return ink.dim("waiting");
		case "absent":
			return ink.dim("not installed");
		case "failed":
			return ink.accent(`could not read: ${s.error ?? "unknown error"}`);
		case "done":
			return ink.dim(s.totalBytes && s.parsed ? `${int(s.files)} sessions · read ${size(s.bytes)}` : `${int(s.files)} sessions · up to date`);
		default:
			return ink.dim(s.totalBytes ? `${size(s.bytes)} of ${size(s.totalBytes)}` : "looking…");
	}
}

class Loading {
	progress?: IngestProgress;
	constructor(private readonly ink: Ink) {}

	render(width: number): string[] {
		const rows = terminalRows();
		const w = Math.min(72, width - 2);
		const inner = w - 4;
		const body = ["", this.ink.muted("Reading every session on this Mac"), ""];
		for (const h of HARNESSES) {
			const s = this.progress?.[h];
			const frac = !s ? 0 : s.state === "done" || s.state === "absent" ? 1 : s.totalBytes ? s.bytes / s.totalBytes : 0;
			const color = s?.state === "absent" ? [70, 66, 64] as const : HARNESS_COLOR[h];
			body.push(`${dot(color)} ${pad(HARNESS_LABEL[h], 13)}${hbar(frac, Math.max(8, inner - 48), color)}  ${s ? sourceLine(this.ink, s) : this.ink.dim("waiting")}`);
		}
		body.push("", this.ink.dim("The first run reads everything once; after that only what changed."), "");
		const box = card(this.ink, { title: "stats", right: this.ink.dim("esc to cancel"), width: w, body });
		const top = Math.max(0, Math.floor((rows - box.length) / 2));
		return [...new Array(top).fill(""), ...box.map((l) => center(l, width))];
	}
}

async function open(ctx: ExtensionContext): Promise<void> {
	const { budget } = await readSettings(cacheDir());
	await ctx.ui.custom<null>(
		(tui: TUI, theme: Theme, _kb, done) => {
			const ink = inkFrom(theme);
			const loading = new Loading(ink);
			const controller = new AbortController();
			let view: StatsView | undefined;
			let failed: string | undefined;

			load(ctx, (p) => {
				loading.progress = p;
				tui.requestRender();
			}, controller.signal)
				.then(({ ds, problems }) => {
					if (controller.signal.aborted) return;
					view = new StatsView(ds, ink, { planUsd: planUsd(), windows: contextWindows(ctx, ds.lifetime.modelRank), budget, problems }, () => done(null));
					tui.requestRender();
				})
				.catch((err) => {
					failed = err instanceof Error ? err.message : String(err);
					tui.requestRender();
				});

			return {
				render: (width: number) =>
					view?.render(width) ?? clampLines((failed ? ["", ` ${bold(ink.accent("stats failed"))}  ${ink.dim(failed)}`, ink.dim(" esc to close")] : loading.render(width)).map(plain), width),
				handleInput: (data: string) => {
					if (view) view.handleInput(data);
					else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || (decodeKittyPrintable(data) ?? data) === "q") {
						controller.abort();
						done(null);
					}
					tui.requestRender();
				},
				handleMouse: (event) => view?.handleMouse(event),
				invalidate: () => view?.invalidate(),
				dispose: () => controller.abort(),
			};
		},
		{ overlay: true, overlayOptions: { anchor: "top-left", row: 0, col: 0, width: "100%", maxHeight: "100%" } },
	);
}

/** A notification only: nothing /stats says may land in the session, where the model would read it. */
function tell(ctx: ExtensionContext, text: string, level: "info" | "error" = "info"): void {
	ctx.ui.notify(text, level);
}

/** Where an export landed, and any harness it had to leave out. */
function written(ctx: ExtensionContext, what: string, file: string, problems: string[]): void {
	tell(ctx, [`${what} written to ${file}`, ...problems].join("\n"), problems.length ? "error" : "info");
}

async function exportReport(ctx: ExtensionContext, range: RangeId): Promise<void> {
	const { ds, problems } = await load(ctx);
	const file = path.join(cacheDir(), `report-${ds.today}-${range}.md`);
	await fs.writeFile(file, markdownReport(ds, summarize(ds, range), problems), { mode: 0o600 });
	written(ctx, "stats report", file, problems);
}

async function exportWrapped(ctx: ExtensionContext, range: RangeId): Promise<void> {
	tell(ctx, `Rendering wrapped (${range})…`);
	const { ds, problems } = await load(ctx);
	const file = path.join(cacheDir(), `wrapped-${ds.today}-${range}.png`);
	try {
		await writeWrappedPng(ds, range, planUsd(), file);
	} catch (err) {
		return tell(ctx, `wrapped PNG failed: ${err instanceof Error ? err.message : String(err)}`, "error");
	}
	written(ctx, "wrapped", file, problems);
}

/** The widget's line, or undefined while pi has no ledger: the widget never triggers a full read. */
async function todayLine(ctx: ExtensionContext, budget: number | undefined): Promise<string | undefined> {
	const records = await ingestPiWarm(sessionsDir(), cacheDir(), priceBook(ctx));
	if (!records) return undefined;
	const now = Date.now();
	const today = dayKey(now);
	const midnight = new Date(now).setHours(0, 0, 0, 0);
	const cwds = [...new Set(records.filter((r) => r.spans.some(([, end]) => end >= midnight)).map((r) => r.cwd))];
	const ds = prepare(records, { commits: await commitsSince(cwds, midnight), roots: new Map() }, now);
	const s = summarizeWindow(ds, { start: today, end: today });
	return todayText(s, budget ? burn(summarizeWindow(ds, monthWindow(today)).cost, today, budget) : undefined);
}

interface TodayWidget {
	refresh(ctx: ExtensionContext): void;
}

function todayWidget(pi: ExtensionAPI): TodayWidget {
	let ctxRef: ExtensionContext | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let running = false;
	let pending = false;
	let generation = 0;

	const show = (ctx: ExtensionContext, text: string | undefined) => {
		ctx.ui.setWidget(
			WIDGET_KEY,
			text ? (_tui, theme) => ({ render: (width: number) => [widgetLine(theme.fg("dim", text), width)], invalidate() {} }) : undefined,
			{ placement: "belowEditor" },
		);
	};

	const run = async () => {
		if (running) {
			pending = true;
			return;
		}
		running = true;
		const gen = generation;
		try {
			const ctx = ctxRef;
			const settings = await readSettings(cacheDir());
			const text = settings.widget && ctx ? await todayLine(ctx, settings.budget) : undefined;
			if (gen === generation && ctxRef) show(ctxRef, text);
		} catch {
			// a failed refresh keeps the last line; the next agent turn tries again
		} finally {
			running = false;
			if (pending) {
				pending = false;
				schedule(WIDGET_DEBOUNCE_MS);
			}
		}
	};

	const schedule = (ms: number) => {
		if (!ctxRef) return;
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = undefined;
			void run();
		}, ms);
		timer.unref?.();
	};

	const refresh = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		ctxRef = ctx;
		generation++;
		schedule(0);
	};

	pi.on("session_start", async (_event, ctx) => refresh(ctx));
	pi.on("agent_end", async (_event, ctx) => {
		if (!ctxRef) return;
		ctxRef = ctx;
		schedule(WIDGET_DEBOUNCE_MS);
	});
	pi.on("session_shutdown", async () => {
		if (timer) clearTimeout(timer);
		timer = undefined;
		ctxRef = undefined;
		pending = false;
		generation++;
	});

	return { refresh };
}

async function setWidget(ctx: ExtensionContext, arg: string | undefined, widget: TodayWidget): Promise<void> {
	const settings = await readSettings(cacheDir());
	if (arg !== "on" && arg !== "off") return tell(ctx, `stats widget is ${settings.widget ? "on" : "off"} · /stats widget on|off`);
	await writeSettings(cacheDir(), { ...settings, widget: arg === "on" });
	widget.refresh(ctx);
	tell(ctx, arg === "on" ? "stats widget on: today's pi spend under the editor, updated after each agent run (needs /stats to have run once)" : "stats widget off");
}

async function setBudget(ctx: ExtensionContext, arg: string | undefined, widget: TodayWidget): Promise<void> {
	const settings = await readSettings(cacheDir());
	if (!arg) return tell(ctx, settings.budget ? `monthly budget ${money(settings.budget)} (API-price spend, all harnesses) · /stats budget <usd>|off` : "no monthly budget · /stats budget <usd>");
	const usd = Number(arg.replace(/^\$/, ""));
	if (arg !== "off" && !(Number.isFinite(usd) && usd > 0)) return tell(ctx, `not a budget: ${arg} · /stats budget <usd>|off`, "error");
	await writeSettings(cacheDir(), { ...settings, budget: arg === "off" ? undefined : usd });
	widget.refresh(ctx);
	tell(ctx, arg === "off" ? "monthly budget cleared" : `monthly budget set to ${money(usd)} of API-price spend`);
}

export default function statsExtension(pi: ExtensionAPI): void {
	const widget = todayWidget(pi);
	pi.registerCommand("stats", {
		description: "Usage across pi, Claude Code, Codex and OpenCode · /stats export|wrapped [7d|30d|90d|1y|all] · widget on|off · budget <usd>|off",
		handler: async (args, ctx) => {
			const [sub = "", arg] = (args ?? "").trim().split(/\s+/);
			if (sub === "widget") return setWidget(ctx, arg, widget);
			if (sub === "budget") return setBudget(ctx, arg, widget);
			const exporting = sub === "export" || sub === "wrapped";
			if (sub && !exporting) return tell(ctx, `unknown: ${sub} \u00b7 ${USAGE}`, "error");
			const range = rangeArg(exporting ? arg : undefined);
			if (!range) return tell(ctx, `unknown range: ${arg} \u00b7 ${USAGE}`, "error");
			if (sub === "wrapped") return exportWrapped(ctx, range);
			if (sub === "export" || !ctx.hasUI) return exportReport(ctx, range);
			return open(ctx);
		},
	});
	pi.registerShortcut(SHORTCUT, {
		description: "Open stats",
		handler: async (ctx) => {
			if (ctx.hasUI) await open(ctx);
		},
	});
}
