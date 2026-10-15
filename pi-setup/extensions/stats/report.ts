import { cacheHit, cacheSavings, type Dataset, type Summary } from "./aggregate";
import { compact, duration, int, money, pct } from "./draw";
import { A, HARNESS_LABEL, T, U } from "./record";
import { modelLabel } from "./widgets";

const cell = (c: string) => c.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");

function tableMd(head: string[], rows: string[][]): string[] {
	return [`| ${head.map(cell).join(" | ")} |`, `|${head.map(() => " --- ").join("|")}|`, ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`)];
}

/** A heading that says when the table below it is cut short. */
function heading(title: string, shown: number, total: number): string {
	return total > shown ? `## ${title} (top ${shown} of ${total})` : `## ${title}`;
}

/** The range as plain markdown, for `/stats export` and runs without a UI. */
export function markdownReport(ds: Dataset, s: Summary, problems: string[] = []): string {
	const save = cacheSavings(s.models);
	const calls = [...s.tools.values()].reduce((a, t) => a + t[T.calls], 0);
	const estimated = [...s.harnesses.values()].reduce((a, h) => a + h.estimated, 0);
	const models = [...s.models].sort((a, b) => b[1][U.cost] - a[1][U.cost]);
	const lines = [
		`# stats · ${s.label}`,
		"",
		`${s.days[0]} → ${s.days[s.days.length - 1]} · generated ${new Date(ds.generatedAt).toLocaleString("en-US")}`,
		"",
		...(problems.length ? ["## Warnings", "", ...problems.map((p) => `- ${p}`), ""] : []),
		...tableMd(["Metric", "Value"], [
			["Spend (API prices)", `${money(s.cost)} (main ${money(s.usage[U.cost])}, agents ${money(s.agentTotal[A.cost])}; ${money(estimated)} estimated from pi's catalog; ${int(s.usage[U.unpriced])} turns unpriced)`],
			["Tokens", `${compact(s.tokens)} (cache read ${compact(s.usage[U.cacheRead] + s.agentTotal[A.cacheRead])}, output ${compact(s.usage[U.output] + s.agentTotal[A.output])})`],
			["Cache hit (main sessions)", `${pct(cacheHit(s.usage))}, net saved ${money(save.saved - save.premium)}`],
			["Cache busts", `${int(s.usage[U.busts])} (${int(s.usage[U.idleBusts])} idle), rewrites ${money(s.usage[U.bustCost])}`],
			["Active days", `${s.activeDays} of ${s.days.length}`],
			["Sessions / prompts / turns", `${int(s.sessions.length)} / ${int(s.prompts)} / ${int(s.usage[U.turns])}`],
			["Time active", duration(s.activeMs)],
			["Agent runs", `${int(s.agentTotal[A.runs])}, ${int(s.agentTotal[A.turns])} turns`],
			["Tool calls", int(calls)],
			["Commits", `${int(s.commits.length)} (${int(s.aiCommits)} with AI)`],
			["Streak", `${ds.lifetime.currentStreak} days (best ${ds.lifetime.longestStreak})`],
		]),
		"",
		"## Harnesses",
		"",
		...tableMd(["Harness", "Spend", "Sessions", "Turns", "Tokens"], [...s.harnesses].sort((a, b) => b[1].cost + b[1].agentCost - a[1].cost - a[1].agentCost).map(([h, x]) => [HARNESS_LABEL[h], money(x.cost + x.agentCost), int(x.sessions), int(x.turns), compact(x.tokens)])),
		"",
		heading("Models", Math.min(12, models.length), models.length),
		"",
		...tableMd(["Model", "Spend", "Turns", "Cache hit"], models.slice(0, 12).map(([k, u]) => [modelLabel(k), money(u[U.cost]), int(u[U.turns]), pct(cacheHit(u))])),
		"",
		"## Agents",
		"",
		...tableMd(["Agent", "Runs", "Spend", "Turns"], [...s.agents].sort((a, b) => b[1][A.cost] - a[1][A.cost]).map(([k, a]) => [k, int(a[A.runs]), money(a[A.cost]), int(a[A.turns])])),
		"",
		heading("Projects", Math.min(15, s.projects.length), s.projects.length),
		"",
		...tableMd(["Project", "Spend", "Sessions", "Commits", "With AI"], s.projects.slice(0, 15).map((p) => [p.name, money(p.cost), int(p.sessions), int(p.commits), int(p.aiCommits)])),
		"",
	];
	return lines.join("\n");
}
