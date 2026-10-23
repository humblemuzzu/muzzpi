import { cacheHit, weekday } from "../aggregate";
import { AGENT, bg, bold, card, center, compact, duration, fg, GOOD, gradientText, HARNESS_COLOR, hbar, hstack, int, money, pct, rampAt, rampColor, type RGB, SERIES, spread, split, WHITE } from "../draw";
import { openers } from "../persona";
import { A, HARNESS_LABEL, T, U } from "../record";
import { metrics } from "../ui";
import { commitsKnown, type Ctx, dayGrader, longDate, modelLabel, unscoped } from "../widgets";
import { busiestDay, C, projectPath, share, type Tab, turnsShare } from "./common";

interface Badge {
	name: string;
	about: string;
	progress: number;
	have: string;
}

function badges(ctx: Ctx): Badge[] {
	const { s, streak } = ctx;
	const known = s.filter.provider === undefined;
	const calls = [...s.tools.values()].reduce((a, t) => a + t[T.calls], 0);
	const checked = [...s.tools.values()].reduce((a, t) => a + t[T.checked], 0);
	const errs = [...s.tools.values()].reduce((a, t) => a + t[T.errors], 0);
	const maxDayTokens = Math.max(0, ...[...s.daily.values()].map((d) => d.tokens));
	const longestSession = Math.max(0, ...s.sessions.map((x) => x.activeMs));
	const maxFan = Math.max(0, ...s.fanout.keys());
	const hit = cacheHit(s.usage);
	const errRate = share(errs, checked);
	const b = (name: string, about: string, value: number, target: number, have: string): Badge => ({ name, about, progress: Number.isFinite(value) ? Math.min(1, share(value, target)) : 0, have });
	return [
		b("Cache Lord", "95% cache hits", hit, 0.95, pct(hit)),
		b("Swarm Commander", "5 agents at once", maxFan, 5, `${maxFan}`),
		b("Billion-token Day", "1B in a day", maxDayTokens, 1e9, compact(maxDayTokens)),
		b("Streak Master", "30-day streak", streak.longestStreak, 30, `${streak.longestStreak}d`),
		b("Polyglot", "10 models", s.models.size, 10, `${s.models.size}`),
		b("Harness Hopper", "3 harnesses", s.harnesses.size, 3, `${s.harnesses.size}`),
		...(commitsKnown(ctx) ? [b("Shipper", "100 AI commits", s.aiCommits, 100, int(s.aiCommits))] : []),
		...(known ? [b("Goal Getter", "10 goals done", s.goalsDone, 10, `${s.goalsDone}`)] : []),
		b("Toolsmith", "100K tool calls", calls, 100_000, compact(calls)),
		b("Steady Hands", "under 2% tool errors", checked ? Math.min(1, 0.02 / Math.max(errRate, 1e-9)) : 0, 1, pct(errRate)),
		b("Night Owl", "20% of turns 0–5h", turnsShare(s, 0, 5), 0.2, pct(turnsShare(s, 0, 5), 0)),
		...(known ? [b("Marathoner", "8h in one session", longestSession, 8 * 3_600_000, duration(longestSession)), b("Delegator", "1,000 agent runs", s.agentTotal[A.runs], 1000, int(s.agentTotal[A.runs]))] : []),
	];
}

/** Facts about how you in particular worked this range; each only when its numbers exist. */
function personal(ctx: Ctx): string[] {
	const { s } = ctx;
	const out: string[] = [];
	const o = openers(s.sessions.map((x) => x.title), 1);
	if (o.sessions >= 10 && o.first[0]) out.push(`You opened ${bold(pct(o.first[0][1] / o.sessions, 0))} of your sessions with \u201c${bold(o.first[0][0])}\u201d.`);
	const harnesses = [...s.harnesses].filter(([, h]) => h.turns > 0);
	const turns = harnesses.reduce((a, [, h]) => a + h.turns, 0);
	const lead = harnesses.sort((a, b) => b[1].turns - a[1].turns)[0];
	if (harnesses.length > 1 && lead) out.push(`${bold(HARNESS_LABEL[lead[0]])} carried ${bold(pct(lead[1].turns / turns, 0))} of your turns; ${harnesses.length - 1} other ${harnesses.length === 2 ? "tool" : "tools"} took the rest.`);
	const file = [...s.edits].sort((a, b) => b[1] - a[1])[0];
	if (file && file[1] >= 5) out.push(`Most rewritten file: ${bold(projectPath(ctx, file[0]).split("/").pop() ?? file[0])}, ${bold(int(file[1]))} edits.`);
	if (s.usage[U.aborted] > 0) out.push(`You stopped ${bold(int(s.usage[U.aborted]))} replies mid-way.`);
	return out;
}

/** The year at half-block resolution: two weekdays per terminal row. */
function miniYear(ctx: Ctx): string[] {
	const { year, ramp, metric } = ctx;
	const grade = dayGrader(year, metric);
	const color = (day: string | undefined): RGB | undefined => (day ? rampColor(ramp, grade(day)) : undefined);
	const cells: Array<string | undefined> = [...new Array(weekday(year.days[0])).fill(undefined), ...year.days];
	const weeks = Math.ceil(cells.length / 7);
	const out: string[] = [];
	for (let r = 0; r < 7; r += 2) {
		let line = "";
		for (let w = 0; w < weeks; w++) {
			const top = color(cells[w * 7 + r]);
			const bottom = r + 1 < 7 ? color(cells[w * 7 + r + 1]) : undefined;
			if (top && bottom) line += bg(bottom, fg(top, "▀"));
			else if (top) line += fg(top, "▀");
			else if (bottom) line += fg(bottom, "▄");
			else line += " ";
		}
		out.push(line);
	}
	return out;
}

export const wrappedTab: Tab = {
	title: "Wrapped",
	hint: "badges earned in this range",
	render(ctx) {
		const { s, ink, width, planUsd } = ctx;
		const known = s.filter.provider === undefined;
		const w = Math.min(width, 100);
		const inner = w - 4;
		const scope = s.filter.harness ? `${s.label} · ${HARNESS_LABEL[s.filter.harness]}` : s.label;
		const body: string[] = ["", center(bold(gradientText("w r a p p e d", C.sky, AGENT)), inner), center(ink.dim(scope), inner), ""];
		body.push(...metrics(ink, [
			{ label: "Spent at API prices", value: money(s.cost), color: C.sky },
			{ label: "Tokens", value: compact(s.tokens), color: C.lavender },
			{ label: "Time active", value: unscoped(ctx, duration(s.activeMs)), color: C.peach },
			{ label: "Sessions", value: int(s.sessions.length), color: C.lime },
		], inner, 16));
		body.push("");

		const models = [...s.models].sort((a, b) => b[1][U.cost] - a[1][U.cost]).slice(0, 3);
		const harnesses = [...s.harnesses].map(([h, x]) => [h, x.cost + x.agentCost] as const).sort((a, b) => b[1] - a[1]).slice(0, 3);
		const projects = s.projects.filter((p) => p.cost > 0).slice(0, 3);
		const cw = split(inner, 3, 3);
		const list = (title: string, rows: Array<[string, string, RGB?]>, width: number) => [
			ink.muted(title),
			...rows.map(([a, b, c], i) => spread(`${bold(fg(c ?? SERIES[i], String(i + 1)))} ${a}`, ink.dim(b), width)),
		];
		body.push(...hstack([
			list("Top models", models.map(([k, u]) => [modelLabel(k), money(u[U.cost])]), cw[0]),
			list("Top harnesses", harnesses.map(([h, v]) => [HARNESS_LABEL[h], money(v), HARNESS_COLOR[h]]), cw[1]),
			list("Top projects", projects.map((p) => [p.name, money(p.cost)]), cw[2]),
		], cw, 3));
		body.push("", ink.muted("Your year"), ...miniYear(ctx).map((l) => center(l, inner)), "");

		const busy = busiestDay(s);
		const written = s.usage[U.output] + s.agentTotal[A.output];
		const cached = s.usage[U.cacheRead] + s.agentTotal[A.cacheRead];
		const novels = (written * 0.75) / 90_000;
		const months = Math.max(s.days.length / 30.44, 1 / 30.44);
		const facts = [
			`The models wrote ${bold(compact(written))} tokens, about ${bold(novels.toFixed(novels >= 10 ? 0 : 1))} novels of text.`,
			`${bold(compact(cached))} tokens came back from cache: War and Peace, re-read ${bold(int(cached / 780_000))} times.`,
			`At API prices that is ${bold(`${(s.cost / (planUsd * months)).toFixed(1)}×`)} a $${planUsd}/month plan.`,
			known ? `Agents ran ${bold(int(s.agentTotal[A.runs]))} times and took ${bold(int(s.agentTotal[A.turns]))} turns for you.` : "",
			busy ? `Your biggest day was ${bold(longDate(busy[0]))}: ${bold(money(busy[1]))}.` : "",
			`${bold(pct(turnsShare(s, 0, 5), 0))} of your turns happened between midnight and 5am.`,
			...personal(ctx),
		].filter(Boolean);
		body.push(ink.muted("Fun facts"), ...facts.map((f) => `${fg(C.amber, "✦")} ${f}`), "");

		body.push(ink.muted("Badges"));
		const all = badges(ctx);
		const bw = split(inner, 2, 3);
		const cell = (b: Badge | undefined, width: number) => {
			if (!b) return "";
			const earned = b.progress >= 1;
			const icon = earned ? fg(C.amber, "◆") : ink.dim("◇");
			const name = earned ? bold(ink.text(b.name)) : ink.muted(b.name);
			const meter = earned ? fg(GOOD, "earned") : `${hbar(b.progress, 8, rampAt(ctx.ramp, b.progress))} ${ink.dim(b.have)}`;
			return spread(`${icon} ${name} ${ink.dim(b.about)}`, meter, width);
		};
		for (let i = 0; i < all.length; i += 2) body.push(hstack([[cell(all[i], bw[0])], [cell(all[i + 1], bw[1])]], bw, 3)[0]);
		body.push("");
		const earned = all.filter((b) => b.progress >= 1).length;
		const lines = card(ink, { title: "stats wrapped", right: fg(WHITE, `${earned}/${all.length} badges`), width: w, body });
		const left = Math.floor((width - w) / 2);
		return lines.map((l) => " ".repeat(left) + l);
	},
};
