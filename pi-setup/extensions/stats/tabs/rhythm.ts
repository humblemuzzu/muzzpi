import { columnChart, compact, duration, int, money, pad, pct, rampAt, type RGB } from "../draw";
import { U } from "../record";
import { barList, grid, metrics, page, section } from "../ui";
import { punchcard, unscoped } from "../widgets";
import { C, hourLabel, peakHour, share, type Tab, turnsShare } from "./common";

const NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export const rhythmTab: Tab = {
	title: "Rhythm",
	hint: "c colours",
	render(ctx) {
		const { s, ink, width, streak } = ctx;
		const ph = peakHour(s);
		const allTurns = s.punch.flat().reduce((a, b) => a + b, 0);
		const weekendTurns = s.punch.slice(5).flat().reduce((a, b) => a + b, 0);
		const maxH = Math.max(0, ...s.hourlyCost);
		return page([
			metrics(ink, [
				{ label: "Time active", value: unscoped(ctx, duration(s.activeMs)), sub: "a session open, idle 10m+ cut" },
				{ label: "Session time", value: unscoped(ctx, duration(s.sessionMs)), sub: "summed over sessions" },
				{ label: "Parallelism", value: s.activeMs ? `${(s.sessionMs / s.activeMs).toFixed(2)}×` : "—", sub: "sessions open at once" },
				{ label: "Peak hour", value: allTurns ? hourLabel(ph) : "—", sub: `${pct(turnsShare(s, ph, ph + 1), 0)} of turns` },
				{ label: "Night owl", value: pct(turnsShare(s, 0, 5), 0), sub: "of turns 00:00–05:00" },
				{ label: "Weekends", value: pct(share(weekendTurns, allTurns), 0), sub: "of turns" },
				{ label: "Streak", value: `${streak.currentStreak} days`, sub: `best ${streak.longestStreak}` },
				{ label: "Prompts", value: unscoped(ctx, int(s.prompts)), sub: unscoped(ctx, `${s.activeDays ? Math.round(s.prompts / s.activeDays) : 0}/day · ${s.prompts ? Math.round(s.promptChars / s.prompts) : 0} chars`) },
				{ label: "Goals done", value: unscoped(ctx, `${s.goalsDone}/${s.goalsSet}`), sub: `${unscoped(ctx, duration(s.goalSeconds * 1000))} of goal time` },
				{ label: "Compactions", value: int(s.compactions), sub: s.compactionMax ? `largest ${compact(s.compactionMax)} tokens` : "" },
				{ label: "Model time", value: duration(s.usage[U.durationMs]), sub: "where replies were timed" },
			], width),
			section(ink, width, { title: "When you work", meta: "turns by weekday and hour", body: (w) => punchcard(ctx, w) }),
			grid(ink, width, [
				{ title: "By weekday", meta: "spend", body: (w) => barList(ink, NAMES.map((n, i) => ({ label: n, value: s.weekdayCost[i], text: money(s.weekdayCost[i]), color: i >= 5 ? C.rose : C.sky })), w, 5) },
				{
					title: "By hour",
					meta: "spend",
					body: (w) => {
						const cw = Math.max(1, Math.min(3, Math.floor(w / 24)));
						const hours = Array.from({ length: 24 }, (_, h) => [[rampAt(ctx.ramp, share(s.hourlyCost[h], maxH)), s.hourlyCost[h]]] as Array<[RGB, number]>);
						let labels = "";
						for (let h = 0; h < 24; h++) labels += pad(h % 6 === 0 ? String(h) : "", cw);
						return [...columnChart(hours, 7, cw), ink.dim(labels)];
					},
				},
			]),
		]);
	},
};
