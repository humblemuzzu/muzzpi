import { cacheHit } from "../aggregate";
import { BAD, compact, type ColSpec, delta, duration, fg, GOOD, HARNESS_COLOR, hbar, int, money, pct, type RGB, table, WARN } from "../draw";
import { A, HARNESS_LABEL, HARNESSES, U } from "../record";
import { grid, metrics, page, section, shareList } from "../ui";
import { type Ctx, dayPanel, HEATMAP_WIDTH, heatmap, modelLabel, skyline, timeline, unscoped } from "../widgets";
import { C, netSaved, share, type Tab, vs, vsUnscoped } from "./common";

const DAY_PANEL = 34;
const MIN_HEATMAP = 74;

/** How much of the spend was priced by the catalog, and how many turns could not be priced at all. */
function pricingNote(ctx: Ctx): string {
	const { s } = ctx;
	const est = share([...s.harnesses.values()].reduce((a, h) => a + h.estimated, 0), s.cost);
	const parts = [est === 0 ? "as recorded" : est < 0.01 ? "<1% estimated" : `${pct(est, 0)} estimated`];
	if (s.usage[U.unpriced] > 0) parts.push(`${int(s.usage[U.unpriced])} unpriced`);
	return parts.join(" · ");
}

/** This month at a glance; always every harness, because a budget is. */
function monthLine(ctx: Ctx): string {
	const { ink, burn: b, width, s } = ctx;
	const tone: RGB = !b.budget ? C.sky : b.spent > b.budget ? BAD : b.projection > b.budget ? WARN : GOOD;
	const filtered = Object.values(s.filter).some((v) => v !== undefined);
	const parts = [
		`${ink.muted(filtered ? "This month, all harnesses" : "This month")}  ${fg(tone, money(b.spent))}`,
		ink.dim(`day ${b.elapsed} of ${b.daysInMonth}`),
		`${ink.dim("on pace for")} ${money(b.projection)}`,
	];
	if (!b.budget) parts.push(ink.dim("no budget · /stats budget <usd>"));
	else parts.push(`${ink.dim("budget")} ${money(b.budget)}${width >= 110 ? ` ${hbar(b.spent / b.budget, 12, tone)}` : ""} ${fg(tone, pct(b.spent / b.budget, 0))}`);
	return parts.join(ink.dim(width >= 110 ? "   ·   " : " · "));
}

function whereItRan(ctx: Ctx): string[] {
	const { s, ink, width } = ctx;
	if (s.filter.harness === undefined && s.harnesses.size >= 2) {
		const parts = HARNESSES.filter((h) => s.harnesses.has(h)).map((h) => {
			const x = s.harnesses.get(h)!;
			return { label: HARNESS_LABEL[h], value: x.cost + x.agentCost, color: HARNESS_COLOR[h], detail: `${int(x.sessions)} sessions · ${compact(x.tokens)} tokens · ${int(x.turns)} turns` };
		});
		return section(ink, width, { title: "Where it ran", meta: `${s.label} · spend by harness · h to focus one`, body: (w) => shareList(ink, w, parts, money) });
	}
	const top = [...s.models].sort((a, b) => b[1][U.cost] - a[1][U.cost]).slice(0, 6);
	const parts = top.map(([k, u]) => ({ label: modelLabel(k), value: u[U.cost], color: ctx.color(k), detail: `${int(u[U.turns])} turns · ${compact(u[U.input] + u[U.output] + u[U.cacheRead] + u[U.cacheWrite])} tokens` }));
	const scope = s.filter.harness ? HARNESS_LABEL[s.filter.harness] : s.label;
	return section(ink, width, { title: "Models", meta: `${scope} · main-session spend by model`, body: (w) => shareList(ink, w, parts, money) });
}

/** Months newest first; the change compares spend per day in range, so a partial month is not a drop. */
function monthRows(ctx: Ctx): string[][] {
	const months = new Map<string, { cost: number; tokens: number; turns: number; days: number; span: number; agent: number; cr: number; den: number }>();
	for (const d of ctx.s.daily.values()) {
		const key = d.day.slice(0, 7);
		const m = months.get(key) ?? { cost: 0, tokens: 0, turns: 0, days: 0, span: 0, agent: 0, cr: 0, den: 0 };
		m.cost += d.cost + d.agentCost;
		m.agent += d.agentCost;
		m.tokens += d.tokens;
		m.turns += d.turns;
		m.days += d.tokens > 0 ? 1 : 0;
		m.span++;
		m.cr += d.cacheRead;
		m.den += d.cacheDenom;
		months.set(key, m);
	}
	const list = [...months].sort((a, b) => b[0].localeCompare(a[0]));
	const max = Math.max(0, ...list.map(([, m]) => m.cost));
	return list.map(([key, m], i) => {
		const prev = list[i + 1]?.[1];
		const label = new Date(Number(key.slice(0, 4)), Number(key.slice(5)) - 1, 1).toLocaleDateString("en-US", { month: "short", year: "numeric" });
		return [
			label,
			hbar(share(m.cost, max), 20, C.sky),
			money(m.cost),
			prev ? delta(ctx.ink, m.cost / m.span, prev.cost / prev.span, "either") : ctx.ink.dim("—"),
			compact(m.tokens),
			int(m.turns),
			String(m.days),
			m.den ? pct(m.cr / m.den, 0) : "—",
			unscoped(ctx, money(m.agent)),
		];
	});
}

export const overview: Tab = {
	title: "Overview",
	hint: "←→ week  ↑↓ day  t today  v skyline  m metric  g group  c colours",
	render(ctx) {
		const { s, ink, width, streak } = ctx;
		const hero = metrics(ink, [
			{ label: "Spend", value: money(s.cost), sub: `API prices · ${pricingNote(ctx)}`, delta: vs(ctx, (x) => x.cost, "either"), color: C.sky },
			{ label: "Tokens", value: compact(s.tokens), sub: `${compact(s.usage[U.output] + s.agentTotal[A.output])} written`, delta: vs(ctx, (x) => x.tokens, "either") },
			{ label: "Sessions", value: int(s.sessions.length), sub: `${unscoped(ctx, int(s.prompts))} prompts`, delta: vs(ctx, (x) => x.sessions.length, "either") },
			{ label: "Active days", value: int(s.activeDays), sub: `of ${s.days.length} · streak ${streak.currentStreak}d`, delta: vs(ctx, (x) => x.activeDays, "either") },
			{ label: "Time active", value: unscoped(ctx, duration(s.activeMs)), sub: "any session open", delta: vsUnscoped(ctx, (x) => x.activeMs, "either") },
			{ label: "Cache hit", value: pct(cacheHit(s.usage)), sub: `saved ${money(netSaved(s))}`, delta: vs(ctx, (x) => cacheHit(x.usage), "up", true) },
		], width);

		const heatW = Math.min(HEATMAP_WIDTH, width - 6 - DAY_PANEL);
		const activity = grid(ink, width, [
			{ title: "Activity", meta: `${int(ctx.year.activeDays)} active days in 365 · ${ctx.metric}/day`, width: heatW >= MIN_HEATMAP ? heatW : width, body: (w) => (ctx.skyline ? skyline(ctx, w) : heatmap(ctx, w)) },
			{ title: "Day", meta: "arrows move", body: (w) => dayPanel(ctx, ctx.cursor, Math.min(w, 64)) },
		], DAY_PANEL);

		const cols: ColSpec[] = [
			{ title: "Month", w: 9 },
			{ title: "", w: 20, drop: 2 },
			{ title: "Spend", w: 9, right: true },
			{ title: "Per day", w: 7, right: true, drop: 1 },
			{ title: "Tokens", w: 8, right: true },
			{ title: "Turns", w: 8, right: true },
			{ title: "Days", w: 4, right: true },
			{ title: "Cache", w: 5, right: true, drop: 1 },
			{ title: "Agents", w: 8, right: true, drop: 3 },
		];
		return page([
			hero,
			[monthLine(ctx)],
			whereItRan(ctx),
			activity,
			section(ink, width, { title: "Over time", meta: `${ctx.metric} by ${ctx.group} · m metric · g group`, body: (w) => timeline(ctx, w, 12) }),
			section(ink, width, { title: "By month", meta: `${s.label} · change is spend per day against the month before`, body: (w) => table(ink, cols, monthRows(ctx), w) }),
		]);
	},
};
