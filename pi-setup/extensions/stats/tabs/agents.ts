import { BAD, type ColSpec, dot, fg, hbar, int, money, note, pct, rampAt, SERIES, table } from "../draw";
import { A } from "../record";
import { barList, grid, metrics, page, section } from "../ui";
import { harnessDots, plot } from "../widgets";
import { AGENTS_EXCLUDED, C, rate, share, type Tab, vs } from "./common";

const color = (i: number) => SERIES[i % SERIES.length];

export const agentsTab: Tab = {
	title: "Agents",
	hint: "j k scroll",
	render(ctx) {
		const { s, ink, width } = ctx;
		if (s.filter.provider !== undefined) {
			return section(ink, width, { title: "Sub-agents", meta: s.label, body: (w) => note(ink, `${AGENTS_EXCLUDED} Press O to clear the provider filter.`, w) });
		}
		const a = s.agentTotal;
		const maxFan = Math.max(0, ...s.fanout.keys());
		const list = [...s.agents].filter(([, v]) => v[A.runs] > 0 || v[A.cost] > 0).sort((x, y) => y[1][A.cost] - x[1][A.cost]);
		const topModel = (agent: string) => {
			let best: [string, number] | undefined;
			for (const [k, v] of s.agentPairs) {
				const [ag, model] = k.split("\t");
				if (ag === agent && (!best || v[A.runs] > best[1])) best = [model, v[A.runs]];
			}
			return best && best[0] !== "unknown" ? best[0] : "—";
		};
		const maxRuns = Math.max(0, ...list.map(([, v]) => v[A.runs]));
		const cols: ColSpec[] = [
			{ title: "Agent", w: 0, flex: true },
			{ title: "Ran in", w: 6, drop: 4 },
			{ title: "", w: 16, drop: 5 },
			{ title: "Runs", w: 6, right: true },
			{ title: "Spend", w: 9, right: true },
			{ title: "Share", w: 5, right: true, drop: 2 },
			{ title: "$/run", w: 7, right: true },
			{ title: "Turns/run", w: 9, right: true, drop: 1 },
			{ title: "Fail", w: 5, right: true },
			{ title: "Top model", w: 22, drop: 3 },
		];
		const rows = list.map(([name, v], i) => [
			`${dot(color(i))} ${name}`,
			harnessDots(s.agentHarness.get(name)),
			hbar(share(v[A.runs], maxRuns), 16, color(i)),
			int(v[A.runs]),
			money(v[A.cost]),
			pct(share(v[A.cost], a[A.cost]), 0),
			money(share(v[A.cost], v[A.runs])),
			share(v[A.turns], v[A.runs]).toFixed(1),
			share(v[A.failures], v[A.runs]) > 0.1 ? fg(BAD, pct(share(v[A.failures], v[A.runs]), 0)) : ink.dim(pct(share(v[A.failures], v[A.runs]), 0)),
			ink.dim(topModel(name)),
		]);
		const fan = [1, 2, 3, 4, 5].map((n) => {
			const count = n < 5 ? (s.fanout.get(n) ?? 0) : [...s.fanout].filter(([k]) => k >= 5).reduce((x, [, c]) => x + c, 0);
			return { label: n === 1 ? "1 agent" : n < 5 ? `${n} agents` : "5+ agents", value: count, text: int(count), color: rampAt(ctx.ramp, n / 5) };
		});
		const models = [...s.agentModels].sort((x, y) => y[1][A.cost] - x[1][A.cost]).slice(0, 8);
		return page([
			metrics(ink, [
				{ label: "Agent runs", value: int(a[A.runs]), sub: `${int(list.length)} kinds`, delta: vs(ctx, (x) => x.agentTotal[A.runs], "either") },
				{ label: "Agent spend", value: money(a[A.cost]), sub: `${pct(share(a[A.cost], s.cost), 0)} of all spend`, delta: vs(ctx, (x) => x.agentTotal[A.cost], "either") },
				{ label: "Per run", value: money(share(a[A.cost], a[A.runs])), sub: `${share(a[A.turns], a[A.runs]).toFixed(1)} turns each`, delta: vs(ctx, (x) => rate(x.agentTotal[A.cost], x.agentTotal[A.runs]), "down") },
				{ label: "Failures", value: pct(rate(a[A.failures], a[A.runs])), sub: `${int(a[A.failures])} runs`, delta: vs(ctx, (x) => rate(x.agentTotal[A.failures], x.agentTotal[A.runs]), "down", true) },
				{ label: "Biggest swarm", value: maxFan ? `${maxFan} at once` : "—", sub: "agents started by one reply" },
			], width),
			section(ink, width, { title: "Sub-agents", meta: s.label, body: (w) => (list.length ? table(ink, cols, rows, w) : [ink.muted("No sub-agent runs in this range.")]) }),
			grid(ink, width, [
				{ title: "Swarm size", meta: "agents started by one reply", body: (w) => barList(ink, fan, w, 10) },
				{ title: "Agent models", meta: "by spend", body: (w) => barList(ink, models.map(([m, v], i) => ({ label: m === "unknown" ? "—" : m, value: v[A.cost], text: `${money(v[A.cost])} · ${int(v[A.runs])}`, color: color(i) })), w, 22) },
			]),
			section(ink, width, {
				title: "You and your agents",
				meta: `${fg(C.sky, "■")} main sessions  ${fg(C.rose, "■")} agents`,
				body: (w) =>
					plot(ctx, (day) => {
						const d = s.daily.get(day)!;
						return [[C.sky, d.cost], [C.rose, d.agentCost]];
					}, w, 7, { format: money }),
			}),
		]);
	},
};
