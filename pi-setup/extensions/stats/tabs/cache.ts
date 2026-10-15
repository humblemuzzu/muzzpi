import { cacheHit, cacheSavings } from "../aggregate";
import { BAD, type ColSpec, compact, dot, duration, fg, GOOD, int, money, note, OTHER, pct, type RGB, segmentBar, table, WARN } from "../draw";
import { U } from "../record";
import { metrics, page, section } from "../ui";
import { type Ctx, modelLabel, plot } from "../widgets";
import { C, netSaved, PARTS, projectLabel, sessionName, share, type Tab, vs, when } from "./common";

const hitColor = (h: number): RGB => (!Number.isFinite(h) ? OTHER : h >= 0.93 ? GOOD : h >= 0.85 ? C.mint : h >= 0.7 ? WARN : BAD);

/** The same four parts as a share of tokens and as a share of spend. */
function mix(ctx: Ctx, w: number): string[] {
	const { s, ink } = ctx;
	const u = s.usage;
	const tokens = [u[U.input], u[U.output], u[U.cacheRead], u[U.cacheWrite]];
	const costs = [u[U.costInput], u[U.costOutput], u[U.costCacheRead], u[U.costCacheWrite]];
	const tokTotal = tokens.reduce((a, b) => a + b, 0);
	const costTotal = costs.reduce((a, b) => a + b, 0);
	const labelW = 8;
	const barW = Math.max(10, w - labelW - 10);
	const legend = PARTS.map((p, i) => `${dot(p.color)} ${p.name} ${ink.dim(`${pct(share(tokens[i], tokTotal), 0)} of tokens, ${pct(share(costs[i], costTotal), 0)} of spend`)}`);
	return [
		`${ink.muted("tokens".padEnd(labelW))}${segmentBar(PARTS.map((p, i) => [p.color, tokens[i]]), barW)}  ${ink.dim(compact(tokTotal))}`,
		`${ink.muted("spend".padEnd(labelW))}${segmentBar(PARTS.map((p, i) => [p.color, costs[i]]), barW)}  ${ink.dim(money(costTotal))}`,
		"",
		...(w >= 110 ? [legend.slice(0, 2).join("      "), legend.slice(2).join("      ")] : legend),
		"",
		ink.dim(`${compact(u[U.reasoning])} of the output tokens were thinking.`),
	];
}

function byModel(ctx: Ctx, w: number): string[] {
	const { s, ink } = ctx;
	const save = cacheSavings(s.models);
	const list = [...s.models].filter(([, m]) => m[U.cacheRead] + m[U.cacheWrite] > 0).sort((a, b) => b[1][U.cost] - a[1][U.cost]).slice(0, 14);
	if (!list.length) return [ink.muted("No cached prompts in this range.")];
	const cols: ColSpec[] = [
		{ title: "Model", w: 0, flex: true },
		{ title: "Hit", w: 6, right: true },
		{ title: "Read", w: 7, right: true },
		{ title: "Written", w: 7, right: true },
		{ title: "Net saved", w: 9, right: true },
		{ title: "Busts", w: 6, right: true },
		{ title: "Idle", w: 5, right: true, drop: 1 },
		{ title: "Rewrite $", w: 9, right: true, drop: 1 },
	];
	const rows = list.map(([key, m]) => [
		`${dot(ctx.color(key))} ${modelLabel(key)}`,
		fg(hitColor(cacheHit(m)), pct(cacheHit(m), 1)),
		compact(m[U.cacheRead]),
		compact(m[U.cacheWrite]),
		save.byModel.has(key) ? money(save.byModel.get(key)!) : ink.dim("—"),
		int(m[U.busts]),
		int(m[U.idleBusts]),
		money(m[U.bustCost]),
	]);
	return [
		...table(ink, cols, rows, w),
		"",
		...note(
			ink,
			"Net saved: cache reads at the model's input rate, minus what writes cost above it. A bust is a turn on a warm context (20K+) that rewrote at least half of it: idle when the gap outlived the cache TTL, prefix when something early in the prompt changed. Turns after a compaction or a model switch never count.",
			w,
		),
	];
}

function busts(ctx: Ctx, w: number): string[] {
	const { s, ink, bustOrder } = ctx;
	const list = [...s.busts].sort(bustOrder === "cost" ? (a, b) => b.cost - a.cost : (a, b) => b.ms - a.ms).slice(0, 12);
	if (!list.length) return [ink.muted("No cache busts in this range.")];
	const cols: ColSpec[] = [
		{ title: "When", w: 12 },
		{ title: "Session", w: 0, flex: true },
		{ title: "Project", w: 14, drop: 2 },
		{ title: "Model", w: 18, drop: 3 },
		{ title: "Context", w: 7, right: true },
		{ title: "Rewrite $", w: 9, right: true },
		{ title: "Gap", w: 7, right: true, drop: 1 },
		{ title: "Kind", w: 6, drop: 1 },
	];
	const rows = list.map((b) => [
		ink.dim(when(b.ms)),
		sessionName(ink, b.session),
		ink.dim(projectLabel(ctx, b.session.project)),
		ink.dim(modelLabel(b.model)),
		compact(b.context),
		money(b.cost),
		duration(b.gapMs),
		b.idle ? fg(WARN, "idle") : "prefix",
	]);
	const out = table(ink, cols, rows, w);
	if (s.busts.length > list.length) out.push(ink.dim(`+ ${int(s.busts.length - list.length)} more in this range`));
	return out;
}

export const cacheTab: Tab = {
	title: "Cache",
	hint: "b sort busts",
	render(ctx) {
		const { s, ink, width } = ctx;
		const u = s.usage;
		const save = cacheSavings(s.models);
		return page([
			metrics(ink, [
				{ label: "Hit rate", value: pct(cacheHit(u)), sub: "cache reads ÷ prompt tokens", delta: vs(ctx, (x) => cacheHit(x.usage), "up", true), color: hitColor(cacheHit(u)) },
				{ label: "Net saved", value: money(save.saved - save.premium), sub: `+${money(save.premium)} on writes`, delta: vs(ctx, netSaved, "up") },
				{ label: "Read from cache", value: compact(u[U.cacheRead]), sub: money(u[U.costCacheRead]), delta: vs(ctx, (x) => x.usage[U.cacheRead], "either") },
				{ label: "Written to cache", value: compact(u[U.cacheWrite]), sub: money(u[U.costCacheWrite]), delta: vs(ctx, (x) => x.usage[U.cacheWrite], "either") },
				{ label: "Busts", value: int(u[U.busts]), sub: `${int(u[U.idleBusts])} idle · ${int(u[U.busts] - u[U.idleBusts])} prefix`, delta: vs(ctx, (x) => x.usage[U.busts], "down") },
				{ label: "Bust rewrites", value: money(u[U.bustCost]), sub: `${pct(share(u[U.bustCost], u[U.cost]), 0)} of main spend`, delta: vs(ctx, (x) => x.usage[U.bustCost], "down") },
			], width),
			section(ink, width, { title: "Tokens vs spend", meta: "where tokens go, and where the money goes", body: (w) => mix(ctx, w) }),
			section(ink, width, {
				title: "Hit rate by day",
				meta: `${fg(GOOD, "■")} 93%+  ${fg(C.mint, "■")} 85%+  ${fg(WARN, "■")} 70%+  ${fg(BAD, "■")} below`,
				body: (w) =>
					plot(ctx, (day) => {
						const d = s.daily.get(day)!;
						return [[OTHER, d.cacheDenom > 0 ? d.cacheRead / d.cacheDenom : 0]];
					}, w, 7, { format: (v) => pct(v, 0), max: 1, average: true, colorOf: hitColor }),
			}),
			section(ink, width, {
				title: "Spend by part",
				meta: PARTS.map((p) => `${fg(p.color, "■")} ${p.name}`).join("  "),
				body: (w) => plot(ctx, (day) => s.daily.get(day)!.parts.map((v, i) => [PARTS[i].color, v] as [RGB, number]), w, 7, { format: money }),
			}),
			section(ink, width, { title: "By model", body: (w) => byModel(ctx, w) }),
			section(ink, width, { title: "Cache busts", meta: ctx.bustOrder === "cost" ? "costliest first · b for latest" : "latest first · b for costliest", body: (w) => busts(ctx, w) }),
		]);
	},
};
