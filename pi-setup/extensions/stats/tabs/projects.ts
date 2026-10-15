import type { Summary } from "../aggregate";
import { BAD, type ColSpec, compact, dot, duration, fg, GOOD, hbar, int, money, note, OTHER, SERIES, table } from "../draw";
import { barList, grid, metrics, page, section } from "../ui";
import { commitsKnown, harnessDots, plot, unscoped } from "../widgets";
import { C, projectLabel, rate, relative, sessionName, share, type Tab, vs, vsUnscoped } from "./common";

const COMMIT_TYPES = ["feat", "fix", "refactor", "docs", "test", "chore", "perf", "style", "build", "ci"];

export const projectsTab: Tab = {
	title: "Projects",
	hint: "p filter by project",
	render(ctx) {
		const { s, ds, ink, width } = ctx;
		const known = commitsKnown(ctx);
		const added = (x: Summary) => x.commits.reduce((n, c) => n + c.added, 0);
		const deleted = (x: Summary) => x.commits.reduce((n, c) => n + c.deleted, 0);
		const perAiCommit = (x: Summary) => rate(x.cost, x.aiCommits);
		const commitText = (t: string) => (known ? t : "—");

		const list = s.projects.filter((p) => p.cost >= 1 || p.commits > 0).slice(0, 16);
		const rest = s.projects.filter((p) => !list.includes(p));
		const max = Math.max(0, ...list.map((p) => p.cost));
		const cols: ColSpec[] = [
			{ title: "Project", w: 0, flex: true },
			{ title: "Ran in", w: 6, drop: 5 },
			{ title: "", w: 12, drop: 4 },
			{ title: "Spend", w: 9, right: true },
			{ title: "Sessions", w: 8, right: true, drop: 2 },
			{ title: "Days", w: 4, right: true, drop: 3 },
			{ title: "Commits", w: 7, right: true },
			{ title: "With AI", w: 7, right: true, drop: 1 },
			{ title: "+lines", w: 7, right: true, drop: 1 },
			{ title: "−lines", w: 7, right: true, drop: 1 },
			{ title: "Last", w: 10, right: true, drop: 3 },
		];
		const rows = list.map((p) => [
			`${dot(ctx.color(p.root))} ${p.name}`,
			harnessDots(p.harnesses),
			hbar(share(p.cost, max), 12, ctx.color(p.root)),
			money(p.cost),
			int(p.sessions),
			int(p.activeDays),
			commitText(int(p.commits)),
			commitText(int(p.aiCommits)),
			!known ? "—" : p.added ? fg(GOOD, compact(p.added)) : ink.dim("0"),
			!known ? "—" : p.deleted ? fg(BAD, compact(p.deleted)) : ink.dim("0"),
			ink.dim(p.lastMs ? relative(p.lastMs, ds.generatedAt) : "—"),
		]);
		const projectBody = (w: number) => {
			if (!list.length) return [ink.muted("Nothing in this range.")];
			const out = table(ink, cols, rows, w);
			if (rest.length) out.push(ink.dim(`+ ${rest.length} more, ${money(rest.reduce((x, p) => x + p.cost, 0))} together`));
			if (known) out.push("", ...note(ink, "Commits: yours in each repo since its first session. With AI: made by a session (Session-Id trailer) or while any session was open in that repo.", w));
			return out;
		};

		const types = new Map<string, number>();
		for (const c of s.commits) {
			const t = c.subject.match(/^(\w+)(\([^)]*\))?!?:/)?.[1]?.toLowerCase();
			const key = t && COMMIT_TYPES.includes(t) ? t : "other";
			types.set(key, (types.get(key) ?? 0) + 1);
		}

		const top = s.sessions.slice(0, 12);
		const sessionCols: ColSpec[] = [
			{ title: "Session", w: 0, flex: true },
			{ title: "Project", w: 18, drop: 1 },
			{ title: "Spend", w: 9, right: true },
			{ title: "Turns", w: 6, right: true },
			{ title: "Agents", w: 6, right: true, drop: 2 },
			{ title: "Active", w: 8, right: true },
			{ title: "When", w: 10, right: true, drop: 1 },
		];
		const sessionRows = top.map((x) => [
			sessionName(ink, x),
			ink.dim(projectLabel(ctx, x.project)),
			money(x.cost),
			int(x.turns),
			unscoped(ctx, int(x.agentRuns)),
			unscoped(ctx, duration(x.activeMs)),
			ink.dim(x.lastMs ? relative(x.lastMs, ds.generatedAt) : "—"),
		]);

		return page([
			metrics(ink, [
				{ label: "Projects", value: int(s.projects.filter((p) => p.sessions).length), sub: `${commitText(int(s.projects.filter((p) => p.commits).length))} with commits`, delta: vs(ctx, (x) => x.projects.filter((p) => p.sessions).length, "either") },
				{ label: "Commits", value: commitText(int(s.commits.length)), sub: known ? `${int(s.aiCommits)} with AI · ${int(s.taggedCommits)} tagged` : "commits have no harness", delta: known ? vsUnscoped(ctx, (x) => x.commits.length, "up") : "" },
				{ label: "Lines added", value: commitText(compact(added(s))), sub: `${commitText(compact(deleted(s)))} removed`, delta: known ? vsUnscoped(ctx, added, "either") : "" },
				{ label: "Per AI commit", value: known && s.aiCommits ? money(perAiCommit(s)) : "—", sub: "all spend ÷ AI commits", delta: known ? vsUnscoped(ctx, perAiCommit, "down") : "" },
			], width),
			section(ink, width, { title: "Projects", meta: s.label, body: projectBody }),
			known
				? grid(ink, width, [
						{ title: "Commit types", body: (w) => barList(ink, [...types].sort((x, y) => y[1] - x[1]).map(([t, n], i) => ({ label: t, value: n, text: int(n), color: SERIES[i % SERIES.length] })), w, 10, "No commits in this range.") },
						{
							title: "Commits per day",
							meta: `${fg(C.lime, "■")} with AI  ${fg(OTHER, "■")} without`,
							body: (w) =>
								plot(ctx, (day) => {
									const d = s.daily.get(day)!;
									return [[C.lime, d.aiCommits], [OTHER, d.commits - d.aiCommits]];
								}, w, 7, { format: (v) => int(v) }),
						},
					])
				: section(ink, width, { title: "Commits", body: (w) => note(ink, "Commits carry no harness or provider, so they are left out under either filter. With AI: made by a session (Session-Id trailer) or while any session was active in that repo.", w) }),
			section(ink, width, { title: "Most expensive sessions", meta: s.label, body: (w) => (top.length ? table(ink, sessionCols, sessionRows, w) : [ink.muted("No sessions in this range.")]) }),
		]);
	},
};
