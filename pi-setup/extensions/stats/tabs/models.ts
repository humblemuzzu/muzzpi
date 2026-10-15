import { cacheHit, percentile } from "../aggregate";
import { BAD, type ColSpec, compact, dot, fg, hbar, int, money, note, pct, rampAt, SERIES, table } from "../draw";
import { providerOf, U } from "../record";
import { barList, grid, page, section } from "../ui";
import { type Ctx, harnessDots, modelLabel } from "../widgets";
import { projectLabel, sessionName, share, type Tab } from "./common";

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "unknown"];

/** `v` tokens, with its share of the model's context window when the registry knows it. */
function ofWindow(ctx: Ctx, model: string, v: number | undefined): string {
	if (v === undefined) return "—";
	const win = ctx.windows.get(model);
	return win ? `${compact(v)} ${ctx.ink.dim(pct(v / win, 0))}` : compact(v);
}

function leaderboard(ctx: Ctx, w: number): string[] {
	const { s, ink } = ctx;
	const total = s.usage[U.cost];
	const list = [...s.models].sort((a, b) => b[1][U.cost] - a[1][U.cost] || b[1][U.turns] - a[1][U.turns]);
	if (!list.length) return [ink.muted("No turns in this range.")];
	const max = list[0][1][U.cost];
	const errCell = (n: number, turns: number) => {
		const r = share(n, turns);
		return r > 0.05 ? fg(BAD, pct(r, 0)) : ink.dim(pct(r, 0));
	};
	const rows = list.slice(0, 24).map(([key, u]) => {
		const tps = u[U.durationMs] > 0 ? u[U.timedOutput] / (u[U.durationMs] / 1000) : NaN;
		const estimated = u[U.estimated] > 0 && u[U.estimated] >= u[U.cost] * 0.5;
		return [
			`${dot(ctx.color(key))} ${modelLabel(key)}`,
			harnessDots(s.modelHarness.get(key)),
			ink.dim(providerOf(key)),
			hbar(share(u[U.cost], max), 14, ctx.color(key)),
			`${money(u[U.cost])}${estimated ? ink.dim("~") : u[U.unpriced] ? ink.dim("?") : " "}`,
			pct(share(u[U.cost], total), 0),
			int(u[U.turns]),
			compact(u[U.input] + u[U.output] + u[U.cacheRead] + u[U.cacheWrite]),
			pct(cacheHit(u), 0),
			Number.isFinite(tps) ? tps.toFixed(0) : ink.dim("—"),
			money(share(u[U.cost], u[U.turns])),
			errCell(u[U.errors], u[U.turns]),
			int(s.modelCommits.get(key) ?? 0),
		];
	});
	const cols: ColSpec[] = [
		{ title: "Model", w: 0, flex: true },
		{ title: "Ran in", w: 6, drop: 5 },
		{ title: "Provider", w: 14, drop: 4 },
		{ title: "", w: 14, drop: 6 },
		{ title: "Spend", w: 10, right: true },
		{ title: "Share", w: 5, right: true, drop: 3 },
		{ title: "Turns", w: 7, right: true },
		{ title: "Tokens", w: 7, right: true, drop: 1 },
		{ title: "Cache", w: 5, right: true, drop: 2 },
		{ title: "Tok/s", w: 5, right: true, drop: 3 },
		{ title: "$/turn", w: 7, right: true, drop: 2 },
		{ title: "Err", w: 4, right: true, drop: 1 },
		{ title: "Commits", w: 7, right: true, drop: 2 },
	];
	const unpriced = list.reduce((a, [, u]) => a + u[U.unpriced], 0);
	return [
		...table(ink, cols, rows, w),
		...(list.length > rows.length ? [ink.dim(`+ ${list.length - rows.length} more models`)] : []),
		"",
		...note(
			ink,
			`~ estimated: the harness recorded no price (Claude Code, Codex, subscription plans), so pi's model catalog priced the tokens. ? unpriced: ${int(unpriced)} turns of models the catalog does not list, counted as $0. Tok/s only where the harness timed replies. Commits: commits whose Session-Id trailer names a session this model led.`,
			w,
		),
	];
}

function contextTable(ctx: Ctx, w: number): string[] {
	const { s, ink } = ctx;
	const sorted = (list: number[] | undefined) => [...(list ?? [])].sort((a, b) => a - b);
	const models = [...new Set([...s.contexts.keys(), ...s.compactionTokens.keys()])]
		.map((model) => ({ model, turns: sorted(s.contexts.get(model)), compactions: sorted(s.compactionTokens.get(model)) }))
		.sort((a, b) => b.turns.length - a.turns.length || b.compactions.length - a.compactions.length)
		.slice(0, 12);
	if (!models.length) return [ink.muted("No main turns in this range.")];
	const cols: ColSpec[] = [
		{ title: "Model", w: 0, flex: true },
		{ title: "Window", w: 7, right: true },
		{ title: "Turns", w: 7, right: true, drop: 2 },
		{ title: "Median", w: 11, right: true, drop: 1 },
		{ title: "p90", w: 11, right: true },
		{ title: "Peak", w: 11, right: true },
		{ title: "Near full", w: 9, right: true, drop: 2 },
		{ title: "Compactions", w: 11, right: true, drop: 3 },
	];
	const rows = models.map(({ model, turns, compactions }) => {
		const win = ctx.windows.get(model);
		return [
			`${dot(ctx.color(model))} ${modelLabel(model)}`,
			win ? compact(win) : ink.dim("—"),
			int(turns.length),
			ofWindow(ctx, model, percentile(turns, 0.5)),
			ofWindow(ctx, model, percentile(turns, 0.9)),
			ofWindow(ctx, model, turns[turns.length - 1]),
			win ? int(turns.filter((c) => c >= 0.8 * win).length) : ink.dim("—"),
			int(compactions.length),
		];
	});
	return [
		...table(ink, cols, rows, w),
		"",
		...note(ink, "Context = input + cache read + cache write of one main turn; % of the window pi's model registry lists. Near full: turns at 80% or more of it.", w),
	];
}

function fullest(ctx: Ctx, w: number): string[] {
	const { s, ink } = ctx;
	const top = s.sessions.filter((x) => x.peakContext > 0).sort((a, b) => b.peakContext - a.peakContext).slice(0, 8);
	if (!top.length) return [ink.muted("No main turns in this range.")];
	const cols: ColSpec[] = [
		{ title: "Session", w: 0, flex: true },
		{ title: "Project", w: 16, drop: 1 },
		{ title: "Model", w: 18, drop: 2 },
		{ title: "Peak", w: 11, right: true },
		{ title: "Compactions", w: 11, right: true, drop: 1 },
	];
	return table(ink, cols, top.map((x) => [sessionName(ink, x), ink.dim(projectLabel(ctx, x.project)), ink.dim(modelLabel(x.peakModel)), ofWindow(ctx, x.peakModel, x.peakContext), int(x.compactions)]), w);
}

export const modelsTab: Tab = {
	title: "Models",
	hint: "o filter by provider",
	render(ctx) {
		const { s, ink, width } = ctx;
		const level = (l: string) => (LEVELS.includes(l) ? LEVELS.indexOf(l) : LEVELS.length - 1);
		const thinking = [...s.thinking].sort((a, b) => level(a[0]) - level(b[0]));
		const providers = [...s.providers].sort((a, b) => b[1][U.cost] - a[1][U.cost]).slice(0, 8);
		return page([
			section(ink, width, { title: "Leaderboard", meta: `${s.models.size} main-session models (agents' are in Agents) · ${s.label}`, body: (w) => leaderboard(ctx, w) }),
			section(ink, width, { title: "Context pressure", meta: "how full each model's window ran", body: (w) => contextTable(ctx, w) }),
			section(ink, width, { title: "Fullest sessions", meta: "largest single-turn context", body: (w) => fullest(ctx, w) }),
			grid(ink, width, [
				{
					title: "Thinking levels",
					meta: "by turns",
					body: (w) => barList(ink, thinking.map(([lvl, u]) => ({ label: lvl, value: u[U.turns], text: `${int(u[U.turns])} · ${money(u[U.cost])}`, color: rampAt(ctx.ramp, (level(lvl) + 1) / LEVELS.length) })), w, 10),
				},
				{
					title: "Providers",
					meta: "by spend",
					body: (w) => barList(ink, providers.map(([p, u], i) => ({ label: p, value: u[U.cost], text: money(u[U.cost]), color: SERIES[i % SERIES.length] })), w, 18),
				},
			]),
		]);
	},
};
