/**
 * /stats — usage analytics over every session pi, Claude Code, Codex and
 * OpenCode left on this Mac: spend, tokens, cache, models, tools, agents,
 * projects and commits, rhythm, and a yearly-review card.
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
import { completeWords, findWord, splitArgs, type Word } from "../tools/lib/command-args";
import { askText, canShowMenu, type MenuSpec, menuAsText, showMenu } from "../tools/lib/command-menu";
import { contributeHelp } from "../tools/lib/help-channel";

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

const USAGE = [
	"/stats 7d            open the view at a range: 7d, 30d, 90d, 1y or all",
	"/stats export 30d    write a Markdown report for a range",
	"/stats widget on     show today's spend under the prompt (off hides it)",
	"/stats budget 500    set a monthly budget in USD (off clears it)",
];

const RANGE_LABEL: Record<RangeId, string> = { "7d": "last 7 days", "30d": "last 30 days", "90d": "last 90 days", "1y": "last year", all: "all time" };

function rangeOf(text: string): RangeId | undefined {
	const wanted = text.toLowerCase();
	return RANGES.find((r) => r.id === wanted)?.id;
}

const rangeSuggestions = () => RANGES.map((r) => ({ value: r.id, description: RANGE_LABEL[r.id] }));

const WORDS: Word[] = [
	{ name: "export", description: "write a Markdown report", next: rangeSuggestions },
	{ name: "widget", description: "today's spend under the prompt", next: () => [{ value: "on" }, { value: "off" }] },
	{ name: "budget", description: "a monthly budget in USD", next: () => [{ value: "off", description: "clear the budget" }] },
	...RANGES.map((r) => ({ name: r.id, description: `open the view at the ${RANGE_LABEL[r.id]}` })),
];

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

async function open(ctx: ExtensionContext, range?: RangeId): Promise<void> {
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
					view = new StatsView(ds, ink, { planUsd: planUsd(), windows: contextWindows(ctx, ds.lifetime.modelRank), budget, problems, range }, () => done(null));
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

async function setWidget(ctx: ExtensionContext, on: boolean, widget: TodayWidget): Promise<void> {
	const settings = await readSettings(cacheDir());
	await writeSettings(cacheDir(), { ...settings, widget: on });
	widget.refresh(ctx);
	tell(
		ctx,
		on
			? "Today's spend now shows under the prompt, updated after each agent run. It needs /stats to have run once. Remembered across sessions."
			: "Today's spend is hidden. Remembered across sessions.",
	);
}

/** `off` clears the budget; a number, with or without a $, sets it. */
export function parseBudget(text: string): { ok: true; usd: number | undefined } | { ok: false } {
	if (text.toLowerCase() === "off") return { ok: true, usd: undefined };
	const usd = Number(text.replace(/^\$/, ""));
	return Number.isFinite(usd) && usd > 0 ? { ok: true, usd } : { ok: false };
}

async function setBudget(ctx: ExtensionContext, text: string, widget: TodayWidget): Promise<void> {
	const parsed = parseBudget(text);
	if (!parsed.ok) return tell(ctx, `"${text}" isn't a budget: give a number of US dollars, like /stats budget 500, or off.`, "error");
	const settings = await readSettings(cacheDir());
	await writeSettings(cacheDir(), { ...settings, budget: parsed.usd });
	widget.refresh(ctx);
	tell(ctx, parsed.usd === undefined ? "Monthly budget cleared." : `Monthly budget set to ${money(parsed.usd)} of API-price spend, across every harness.`);
}

export function statsMenu(widgetOn: boolean, budget: number | undefined): MenuSpec {
	return {
		title: "Stats",
		status: ["Spend, tokens, cache, models, tools and projects across pi, Claude Code, Codex and OpenCode."],
		items: [
			{ id: "open", label: "Open stats", note: SHORTCUT },
			{ id: "export", label: "Write a report", description: "A Markdown file for a time range you pick." },
			{
				id: "widget",
				label: widgetOn ? "Hide today's spend under the prompt" : "Show today's spend under the prompt",
				note: widgetOn ? "shown now" : "hidden now",
			},
			{ id: "budget", label: "Set a monthly budget", note: budget ? `now ${money(budget)}` : "none now", description: "Shown as month-to-date spend against it." },
		],
	};
}

async function pickRange(ctx: ExtensionContext): Promise<RangeId | undefined> {
	const choice = await showMenu(ctx, {
		title: "Write a report for",
		items: RANGES.map((r) => ({ id: r.id, label: RANGE_LABEL[r.id] })),
		initial: "30d",
	});
	return choice ? rangeOf(choice.id) : undefined;
}

async function menu(ctx: ExtensionContext, widget: TodayWidget): Promise<void> {
	const settings = await readSettings(cacheDir());
	const spec = statsMenu(settings.widget, settings.budget);
	if (!canShowMenu(ctx)) return tell(ctx, menuAsText(spec, USAGE));
	const choice = await showMenu(ctx, spec);
	if (choice?.id === "open") return open(ctx);
	if (choice?.id === "widget") return setWidget(ctx, !settings.widget, widget);
	if (choice?.id === "export") {
		const range = await pickRange(ctx);
		if (range) await exportReport(ctx, range);
		return;
	}
	if (choice?.id === "budget") {
		const text = (await askText(ctx, "Monthly budget in US dollars", settings.budget ? `now ${money(settings.budget)}; type off to clear it` : "a number, like 500"))?.trim();
		if (text) await setBudget(ctx, text, widget);
	}
}

export default function statsExtension(pi: ExtensionAPI): void {
	const widget = todayWidget(pi);
	pi.registerCommand("stats", {
		description: "Spend, tokens and cache across your coding agents, with a report and a budget",
		getArgumentCompletions: (prefix) => completeWords(WORDS, prefix),
		handler: async (args, ctx) => {
			const { word, rest } = splitArgs(args);
			if (!word) return menu(ctx, widget);
			const found = findWord(WORDS, word);
			if (!found) return tell(ctx, `/stats has no "${word}". Try: 7d, 30d, 90d, 1y, all, export, widget, budget, or /stats on its own for the menu.`, "error");
			if (found.name === "widget") {
				const on = rest.toLowerCase();
				if (on !== "on" && on !== "off") {
					const { widget: shown } = await readSettings(cacheDir());
					return tell(ctx, `Today's spend is ${shown ? "shown" : "hidden"} under the prompt. /stats widget on or /stats widget off changes it.`);
				}
				return setWidget(ctx, on === "on", widget);
			}
			if (found.name === "budget") {
				if (rest) return setBudget(ctx, rest, widget);
				const { budget } = await readSettings(cacheDir());
				return tell(ctx, budget ? `Monthly budget: ${money(budget)} of API-price spend. /stats budget off clears it.` : "No monthly budget. Set one with /stats budget 500.");
			}
			if (found.name === "export") {
				const range = rest ? rangeOf(rest) : "30d";
				if (!range) return tell(ctx, `"${rest}" isn't a range. Use 7d, 30d, 90d, 1y or all.`, "error");
				return exportReport(ctx, range);
			}
			if (!canShowMenu(ctx)) return tell(ctx, `The stats view needs the interactive TUI. /stats export ${found.name} writes a report instead.`);
			return open(ctx, rangeOf(found.name));
		},
	});
	pi.registerShortcut(SHORTCUT, {
		description: "Open stats",
		handler: async (ctx) => {
			if (ctx.hasUI) await open(ctx);
		},
	});
	contributeHelp(pi, (help) => help.shortcut({ command: "stats", key: SHORTCUT }));
}
