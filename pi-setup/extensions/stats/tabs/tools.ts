import { BAD, type ColSpec, duration, fg, hbar, int, pct, spread, table, tail } from "../draw";
import { T, U } from "../record";
import { barList, grid, metrics, page } from "../ui";
import { type Ctx, unscoped } from "../widgets";
import { AGENTS_EXCLUDED, C, projectPath, share, type Tab } from "./common";

function toolRows(ctx: Ctx, tools: Map<string, number[]>, w: number, limit: number): string[] {
	const { ink } = ctx;
	const list = [...tools].sort((a, b) => b[1][T.calls] - a[1][T.calls]).slice(0, limit);
	if (!list.length) return [ink.muted("No tool calls in this range.")];
	const max = list[0][1][T.calls];
	const barW = Math.max(6, Math.min(24, w - 46));
	const cols: ColSpec[] = [
		{ title: "Tool", w: 0, flex: true },
		{ title: "", w: barW, drop: 2 },
		{ title: "Calls", w: 7, right: true },
		{ title: "Err", w: 5, right: true },
		{ title: "Avg", w: 6, right: true, drop: 1 },
	];
	return table(
		ink,
		cols,
		list.map(([name, t]) => {
			const err = t[T.checked] ? t[T.errors] / t[T.checked] : NaN;
			return [
				name,
				hbar(share(t[T.calls], max), barW, C.sky),
				int(t[T.calls]),
				!Number.isFinite(err) ? ink.dim("—") : err > 0.05 ? fg(BAD, pct(err, 0)) : ink.dim(pct(err, 0)),
				t[T.timed] ? duration(t[T.durationMs] / t[T.timed]) : ink.dim("—"),
			];
		}),
		w,
	);
}

export const toolsTab: Tab = {
	title: "Tools",
	hint: "j k scroll",
	render(ctx) {
		const { s, ink, width } = ctx;
		const sum = (m: Map<string, number[]>, i: number) => [...m.values()].reduce((a, t) => a + t[i], 0);
		const calls = sum(s.tools, T.calls);
		const checked = sum(s.tools, T.checked);
		const editsTotal = [...s.edits.values()].reduce((a, b) => a + b, 0);
		const commands = [...s.bash].sort((a, b) => b[1] - a[1]).slice(0, 14);
		const edits = [...s.edits].sort((a, b) => b[1] - a[1]).slice(0, 14);
		return page([
			metrics(ink, [
				{ label: "Tool calls", value: int(calls), sub: `${share(calls, s.usage[U.turns]).toFixed(1)} per turn` },
				{ label: "Error rate", value: checked ? pct(sum(s.tools, T.errors) / checked) : "—", sub: `${int(sum(s.tools, T.errors))} failed` },
				{ label: "Tool time", value: duration(sum(s.tools, T.durationMs)), sub: "where timed" },
				{ label: "Agent tool calls", value: unscoped(ctx, int(sum(s.agentTools, T.calls))), sub: "made inside sub-agents" },
				{ label: "File edits", value: int(editsTotal), sub: `${int(s.edits.size)} files` },
				{ label: "Shell commands", value: int([...s.bash.values()].reduce((a, b) => a + b, 0)), sub: `${int(s.bash.size)} distinct` },
			], width),
			grid(ink, width, [
				{ title: "Your tools", meta: "main sessions", body: (w) => toolRows(ctx, s.tools, w, 14) },
				{ title: "Inside agents", meta: "sub-agent transcripts", body: (w) => (s.filter.provider === undefined ? toolRows(ctx, s.agentTools, w, 14) : [ink.muted(AGENTS_EXCLUDED)]) },
			], 56),
			grid(ink, width, [
				{ title: "Shell commands", meta: "first word, plus its subcommand", body: (w) => barList(ink, commands.map(([c, n]) => ({ label: c, value: n, text: int(n), color: C.amber })), w, 18, "No shell commands in this range.") },
				{ title: "Most edited files", body: (w) => (edits.length ? edits.map(([p, n]) => spread(tail(projectPath(ctx, p), w - 8), ink.dim(int(n)), w)) : [ink.muted("No edits in this range.")]) },
			], 56),
		]);
	},
};
