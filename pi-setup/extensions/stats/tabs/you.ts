import { visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import { addDays, cacheSavings, parseDay, type Summary } from "../aggregate";
import { BAD, bold, center, compact, type ColSpec, dot, duration, EMPTY, fg, GOOD, gradientText, HARNESS_COLOR, hbar, hstack, int, money, OTHER, pad, pct, type RGB, SERIES, segmentBar, spread, split, table, WARN } from "../draw";
import { type Best, persona, type Persona, type Trait, type TraitKey, type Unit } from "../persona";
import { dayKey, HARNESS_LABEL, type Harness, T, U } from "../record";
import { barList, grid, page, section } from "../ui";
import { commitsKnown, type Ctx, modelLabel } from "../widgets";
import { C, projectPath, share, type Tab } from "./common";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LABEL_W = 8;
const KIND_COLOR: Record<string, RGB> = { reading: C.sky, editing: C.lavender, shell: C.amber, delegating: C.rose, "the web": C.mint, other: OTHER };
/** Runs that look like keys or tokens are blanked before a pasted prompt is quoted on screen. */
const SECRETISH = /[A-Za-z0-9_\-+/=]{20,}/g;

const TRAIT: Record<TraitKey, { noun: string; adjective: string; color: RGB; art: string[] }> = {
	night: { noun: "Night Owl", adjective: "Nocturnal", color: C.periwinkle, art: [" ,___,", " (O,O)", " /)__)", ' -"-"-'] },
	swarm: { noun: "Swarm Lord", adjective: "Delegating", color: C.rose, art: ["[o_o][o_o]", " /||\\ /||\\", "  [o_o]", "  /||\\"] },
	grind: { noun: "Grinder", adjective: "Relentless", color: C.amber, art: [" (\\_/)", " (•ᴥ•)", " /|  |\\", "  |__|"] },
	loyal: { noun: "Loyalist", adjective: "Devoted", color: C.peach, art: ["  /^ ^\\", " / 0 0 \\", " V\\ Y /V", "  / - \\"] },
	explore: { noun: "Model Hopper", adjective: "Curious", color: C.mint, art: ["  /\\_/\\", " ( o.o )", "  > ^ <", " /     \\"] },
	ship: { noun: "Shipper", adjective: "Shipping", color: C.lime, art: ["   /\\", "  |==|", "  |  |", " /_/\\_\\"] },
	cache: { noun: "Cache Hoarder", adjective: "Thrifty", color: C.sky, art: ["  ______", " |$$$$$$|", " |__()__|", " |______|"] },
	calm: { noun: "Zen Master", adjective: "Unbothered", color: C.lavender, art: ["  (-_-)", " __|_|__", "   / \\", "   zZz"] },
};

function date(ctx: Ctx, day: string): string {
	const withYear = day.slice(0, 4) !== ctx.ds.today.slice(0, 4);
	return parseDay(day).toLocaleDateString("en-US", { month: "short", day: "numeric", ...(withYear ? { year: "2-digit" } : {}) }).replace(/, (\d\d)$/, " '$1");
}

/** Minutes past the work day's midnight as a clock; 1:30 the next morning stays 1:30 am. */
function clock(minutes: number): string {
	const m = Math.floor(minutes) % (24 * 60);
	const h = Math.floor(m / 60);
	return `${h % 12 || 12}:${String(m % 60).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
}

function value(unit: Unit, v: number): string {
	return unit === "money" ? money(v) : unit === "tokens" ? compact(v) : unit === "duration" ? duration(v) : unit === "pct" ? pct(v) : int(v);
}

const harnessName = (h: string) => HARNESS_LABEL[h as Harness] ?? h;
const plural = (n: number, one: string, many = `${one}s`) => `${int(n)} ${n === 1 ? one : many}`;

/** Items joined on lines no wider than `w`. */
function flow(items: string[], w: number, gap = "   "): string[] {
	const out: string[] = [];
	let line = "";
	for (const it of items) {
		const next = line ? `${line}${gap}${it}` : it;
		if (line && visibleWidth(next) > w) {
			out.push(line);
			line = it;
		} else line = next;
	}
	if (line) out.push(line);
	return out;
}

/** The class: the noun of the strongest trait, the adjective of the second. */
function archetype(traits: Trait[]): { title: string; lead?: Trait; second?: Trait } {
	const [lead, second] = [...traits].sort((a, b) => b.score - a.score);
	if (!lead) return { title: "The Newcomer" };
	return { title: `The ${second ? `${TRAIT[second.key].adjective} ` : ""}${TRAIT[lead.key].noun}`, lead, second };
}

function characterCard(ctx: Ctx, p: Persona, s: Summary): string[] {
	const { ink, width } = ctx;
	const { title, lead, second } = archetype(p.traits);
	const look = lead ? TRAIT[lead.key] : TRAIT.calm;
	const art = [...look.art.map((l) => fg(look.color, l)), "", ink.dim("  your class")];
	const artW = 14;
	const right = width - artW - 4;
	const days = Math.round((parseDay(ctx.ds.today).getTime() - parseDay(p.firstDay!).getTime()) / 86_400_000) + 1;
	const tools = [...p.harnessSpan.keys()];
	const labelW = 18;
	const shownW = Math.max(...p.traits.map((t) => visibleWidth(t.shown)), 0);
	const barW = Math.max(8, Math.min(28, right - labelW - shownW - 4));
	const traits = [...p.traits]
		.sort((a, b) => b.score - a.score)
		.map((t) => `${pad(t === lead || t === second ? bold(ink.text(t.label)) : ink.muted(t.label), labelW)}${hbar(t.score, barW, TRAIT[t.key].color)}  ${ink.dim(t.shown)}`);
	const body = [
		bold(gradientText(title.toUpperCase().split("").join(" "), look.color, second ? TRAIT[second.key].color : C.rose)),
		ink.dim(`${int(days)} days since ${date(ctx, p.firstDay!)} · ${int(p.activeDays)} active · ${tools.length > 1 ? `${tools.length} tools` : harnessName(tools[0] ?? "")} · ${int(p.models.length)} models · ${int(s.sessions.length)} sessions · ${money(s.cost)} at API prices`),
		"",
		...traits,
	];
	return hstack([art, body], [artW, right], 4);
}

function bubble(ctx: Ctx, text: string, w: number): string[] {
	const inner = Math.min(w - 4, visibleWidth(text) + 2);
	const t = pad(` ${text}`, inner);
	return [ctx.ink.border(`╭${"─".repeat(inner)}╮`), `${ctx.ink.border("│")}${ctx.ink.text(t)}${ctx.ink.border("│")}`, ctx.ink.border(`╰──┬${"─".repeat(Math.max(0, inner - 3))}╯`)];
}

function talk(ctx: Ctx, p: Persona, w: number): string[] {
	const { ink } = ctx;
	const o = p.openers;
	if (!o.sessions) return [ink.muted("(・_・) no prompts to read yet")];
	const out: string[] = [];
	const phrase = o.phrases[0];
	if (phrase && phrase[1] >= 3) {
		out.push(...bubble(ctx, `${phrase[0]} …`, w));
		out.push(`   ${fg(C.amber, "(•ᴥ•)")}  ${ink.dim(`your signature opener · ${plural(phrase[1], "session")}`)}`, "");
	}
	out.push(ink.muted("First word of a session"));
	out.push(...barList(ink, o.first.slice(0, 5).map(([word, n], i) => ({ label: `“${word}”`, value: n, text: pct(n / o.sessions, 0), color: SERIES[i % SERIES.length] })), w, 10));
	if (o.words.length) out.push("", ink.muted("Words you keep coming back to"), ...flow(o.words.slice(0, 10).map(([word, n]) => `${ink.text(word)} ${ink.dim(`×${n}`)}`), w));
	out.push("", ink.dim(`${plural(o.sessions, "session")} read${o.scripted ? `, ${int(o.scripted)} scripted ones left out` : ""}.`));
	return out;
}

function pottyMouth(ctx: Ctx, s: Summary, w: number): string[] {
	const { ink } = ctx;
	const total = [...s.swears.values()].reduce((a, b) => a + b, 0);
	if (!s.prompts) return [ink.muted("(・_・) no prompts to read yet")];
	if (!total) return [`${fg(GOOD, "(｡•ᴗ•｡)")}  ${ink.text("not one swear word")} ${ink.dim(`in ${plural(s.prompts, "prompt")}`)}`];
	const per100 = (total / s.prompts) * 100;
	const face = per100 >= 10 ? fg(BAD, "(╯°□°)╯︵ ┻━┻") : per100 >= 3 ? fg(WARN, "(¬_¬)") : fg(GOOD, "(¬‿¬)");
	const out = [`${face}  ${bold(ink.text(int(total)))} ${ink.muted("swears in")} ${ink.text(plural(s.prompts, "prompt"))} ${ink.dim(`· ${per100.toFixed(1)} per 100`)}`, ""];
	const words = [...s.swears].sort((a, b) => b[1] - a[1]).slice(0, 6);
	out.push(...barList(ink, words.map(([word, n], i) => ({ label: word, value: n, text: int(n), color: [BAD, WARN, C.peach, C.rose, C.amber, OTHER][i] })), w, 8), "");
	const worst = [...s.daily.values()].reduce<[string, number] | undefined>((best, d) => (d.swears > (best?.[1] ?? 0) ? [d.day, d.swears] : best), undefined);
	if (worst) out.push(spread(ink.muted("Worst day"), `${int(worst[1])} ${ink.dim(`· ${date(ctx, worst[0])}`)}`, w));
	const rates = [...s.harnesses].filter(([, h]) => h.prompts >= 20).map(([h, x]) => [h, (x.swears / x.prompts) * 100] as const).sort((a, b) => b[1] - a[1]);
	if (rates.length > 1) out.push(spread(ink.muted("Cussed at most"), `${harnessName(rates[0][0])} ${ink.dim(`· ${rates[0][1].toFixed(1)} per 100, ${harnessName(rates[rates.length - 1][0])} ${rates[rates.length - 1][1].toFixed(1)}`)}`, w));
	return out;
}

/** One coloured cell per week (or per group of weeks when there are more weeks than columns). */
function strip(ink: Ctx["ink"], keys: Array<string | undefined>, color: (k: string) => RGB, w: number): string {
	if (!keys.length) return "";
	const per = Math.ceil(keys.length / Math.max(1, w));
	const cells: Array<string | undefined> = [];
	for (let i = 0; i < keys.length; i += per) {
		const counts = new Map<string, number>();
		for (const k of keys.slice(i, i + per)) if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
		cells.push([...counts].sort((a, b) => b[1] - a[1])[0]?.[0]);
	}
	const cw = Math.max(1, Math.min(3, Math.floor(w / cells.length)));
	return cells.map((k) => (k ? fg(color(k), "█".repeat(cw)) : ink.dim("·".padEnd(cw)))).join("");
}

function monthAxis(ctx: Ctx, starts: string[], w: number): string {
	const per = Math.ceil(starts.length / Math.max(1, w));
	const cells = starts.filter((_, i) => i % per === 0);
	const cw = Math.max(1, Math.min(3, Math.floor(w / cells.length)));
	let out = "";
	let last = "";
	cells.forEach((start, i) => {
		const month = start.slice(0, 7);
		if (month === last || out.length > i * cw) return;
		const m = Number(start.slice(5, 7)) - 1;
		out = out.padEnd(i * cw) + (m === 0 || !last ? `${MONTHS[m]} '${start.slice(2, 4)}` : MONTHS[m]);
		last = month;
	});
	return ctx.ink.dim(out.slice(0, w));
}

function journey(ctx: Ctx, p: Persona, w: number): string[] {
	const { ink, s } = ctx;
	const stripW = w - LABEL_W;
	const weeksOf = new Map<string, number>();
	for (const e of p.modelEras) weeksOf.set(e.key, (weeksOf.get(e.key) ?? 0) + e.weeks);
	const ranked = [...weeksOf].sort((a, b) => b[1] - a[1]).map(([k]) => k);
	const modelColor = (k: string) => {
		const i = ranked.indexOf(k);
		return i !== -1 && i < SERIES.length ? SERIES[i] : OTHER;
	};
	const showTools = s.filter.harness === undefined;
	const out: string[] = [];
	if (showTools) {
		const tools = strip(ink, p.weeks.map((x) => x.harness), (k) => HARNESS_COLOR[k as Harness], stripW);
		out.push(`${pad(ink.muted("tools"), LABEL_W)}${tools}`, `${" ".repeat(LABEL_W)}${tools}`);
	}
	const models = strip(ink, p.weeks.map((x) => x.model), modelColor, stripW);
	out.push(`${pad(ink.muted("models"), LABEL_W)}${models}`, `${" ".repeat(LABEL_W)}${models}`);
	out.push(" ".repeat(LABEL_W) + monthAxis(ctx, p.weeks.map((x) => x.start), stripW), "");
	const legend = [
		...(showTools ? [...p.harnessSpan.keys()].map((h) => `${dot(HARNESS_COLOR[h])} ${harnessName(h)}`) : []),
		...ranked.slice(0, SERIES.length).map((k) => `${fg(modelColor(k), "■")} ${modelLabel(k)}`),
	];
	out.push(...flow(legend, w - LABEL_W).map((l) => " ".repeat(LABEL_W) + l));
	out.push(...wrapTextWithAnsi("one cell per week, coloured by whatever took most of its turns; · means nothing ran", w - LABEL_W).map((l) => " ".repeat(LABEL_W) + ink.dim(l)), "");

	if (showTools && p.harnessEras.length) {
		const cols: ColSpec[] = [
			{ title: "Tool era", w: 16 },
			{ title: "From", w: 11 },
			{ title: "To", w: 11 },
			{ title: "", w: 0, flex: true, drop: 2 },
			{ title: "Weeks", w: 6, right: true },
			{ title: "Turns", w: 9, right: true },
		];
		const totalWeeks = Math.max(1, ...p.harnessEras.map((e) => e.weeks));
		const rows = p.harnessEras.slice(-7).map((e) => [
			`${dot(HARNESS_COLOR[e.key])} ${harnessName(e.key)}`,
			ink.dim(date(ctx, e.from)),
			ink.dim(e.to === ctx.ds.today ? "now" : date(ctx, e.to)),
			hbar(e.weeks / totalWeeks, Math.max(4, w - 70), HARNESS_COLOR[e.key]),
			int(e.weeks),
			int(e.turns),
		]);
		out.push(...table(ink, cols, rows, w));
		const facts = [`main tool changed ${plural(p.harnessEras.length - 1, "time")}`, `${plural(p.multiToolDays, "day")} on two tools or more`];
		if (p.mostTools && p.mostTools.count > 2) facts.push(`${p.mostTools.count} tools in one day on ${date(ctx, p.mostTools.day)}`);
		out.push("", ink.dim(facts.join("  ·  ")), "");
	}

	if (p.modelEras.length) {
		const chain: string[] = [];
		for (const e of p.modelEras) if (chain[chain.length - 1] !== e.key) chain.push(e.key);
		const shown = chain.slice(-8);
		const loyal = [...p.modelEras].sort((a, b) => b.weeks - a.weeks)[0];
		const once = p.models.filter((m) => m.days === 1).length;
		out.push(ink.muted("Model eras, oldest to newest"));
		const text = `${chain.length > shown.length ? "… → " : ""}${shown.map((k) => modelLabel(k)).join(" → ")}`;
		out.push(...wrapTextWithAnsi(text, w).map((l) => ink.text(l)));
		out.push(ink.dim(`${int(p.models.length)} models met · ${once} only ever used on one day · most loyal: ${modelLabel(loyal.key)}, ${plural(loyal.weeks, "week")} straight`));
	}
	return out;
}

/** Records as trophies on a shelf, three or four to a row. */
function shelf(ctx: Ctx, list: Best[], w: number): string[] {
	const { ink } = ctx;
	if (!list.length) return [ink.muted("No records yet.")];
	const per = Math.max(1, Math.min(4, Math.floor((w + 4) / 30)));
	const widths = split(w, per, 4);
	const fresh = addDays(ctx.ds.today, -6);
	const out: string[] = [];
	for (let i = 0; i < list.length; i += per) {
		const row = list.slice(i, i + per).map((b) => {
			const isNew = b.day >= fresh;
			const star = isNew ? fg(GOOD, "★") : fg(C.amber, "★");
			return [
				`${star} ${bold(ink.text(value(b.unit, b.value)))}${isNew ? fg(GOOD, "  new!") : ""}`,
				`  ${ink.muted(b.label.toLowerCase())}`,
				`  ${ink.dim([date(ctx, b.day), b.detail].filter(Boolean).join(" · "))}`,
			];
		});
		if (i) out.push("");
		out.push(...hstack(row, widths.slice(0, row.length), 4));
	}
	return out;
}

function timeline(ctx: Ctx, p: Persona, w: number): string[] {
	const { ink } = ctx;
	if (!p.firsts.length) return [ink.muted("Nothing yet.")];
	return p.firsts.map((f, i) => {
		const glyph = p.firsts.length === 1 ? "●" : i === 0 ? "┬" : i === p.firsts.length - 1 ? "┴" : "├";
		const harness = (Object.entries(HARNESS_LABEL) as Array<[Harness, string]>).find(([, l]) => f.label === `First ${l} day`)?.[0];
		const mark = harness ? fg(HARNESS_COLOR[harness], glyph) : fg(C.amber, glyph);
		return spread(`${ink.dim(pad(date(ctx, f.day), 11))}${mark} ${f.label[0].toLowerCase()}${f.label.slice(1)}`, f.detail ? ink.dim(f.detail) : "", w);
	});
}

/** A 24-hour track from 6 am to 6 am with the typical day filled in. */
function clockBar(ctx: Ctx, start: number, end: number, w: number): string[] {
	const from = 6 * 60;
	const span = 24 * 60;
	const at = (m: number) => Math.max(0, Math.min(w, Math.round((((m - from + span) % span) / span) * w)));
	const a = at(start);
	const b = Math.max(a + 1, end - from >= span ? w : at(end));
	const bar = fg(EMPTY, "─".repeat(a)) + fg(C.amber, "█".repeat(b - a)) + fg(EMPTY, "─".repeat(Math.max(0, w - b)));
	let axis = "";
	["6am", "noon", "6pm", "midnight", "6am"].forEach((m, i) => {
		const x = Math.round((i / 4) * (w - 1));
		const pos = i === 4 ? w - m.length : i === 0 ? 0 : x - Math.floor(m.length / 2);
		if (pos >= axis.length) axis = axis.padEnd(pos) + m;
	});
	return [bar, ctx.ink.dim(axis.slice(0, w))];
}

function yourClock(ctx: Ctx, p: Persona, w: number): string[] {
	const { ink, s } = ctx;
	const c = p.chronotype;
	if (!c) return [ink.muted("(・_・) not enough prompts to read your clock")];
	const names = ["Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays", "Sundays"];
	const hardest = s.weekdayCost.indexOf(Math.max(...s.weekdayCost));
	const kv = (k: string, v: string) => spread(ink.muted(k), v, w);
	const owl = c.end >= 24 * 60;
	return [
		`${owl ? fg(C.periwinkle, "(O,O)") : fg(C.amber, "\\(•◡•)/")}  ${ink.muted("you usually type from")} ${bold(ink.text(clock(c.start)))} ${ink.muted("to")} ${bold(ink.text(clock(c.end)))}`,
		"",
		...clockBar(ctx, c.start, c.end, w),
		"",
		kv("Latest you called it a night", c.latest ? `${clock(c.latest.at)} ${ink.dim(`· ${date(ctx, c.latest.day)}`)}` : "—"),
		kv("Earliest you started", c.earliest ? `${clock(c.earliest.at)} ${ink.dim(`· ${date(ctx, c.earliest.day)}`)}` : "—"),
		kv("Longest day, first prompt to last", c.longest ? `${duration(c.longest.ms)} ${ink.dim(`· ${date(ctx, c.longest.day)}`)}` : "—"),
		kv("Straight through the night", c.allNighters ? `${plural(c.allNighters, "time")}${c.lastAllNighter ? ink.dim(` · last ${date(ctx, c.lastAllNighter)}`) : ""}` : "never"),
		kv("You go hardest on", s.weekdayCost[hardest] > 0 ? names[hardest] : "—"),
		"",
		ink.dim("from your prompts; a day ends after 3 quiet hours"),
	];
}

function onThisDay(ctx: Ctx, p: Persona, w: number): string[] {
	const { ink } = ctx;
	return p.onThisDay.flatMap((o, i) => {
		const when = `${bold(ink.text(o.ago === 365 ? "a year ago" : `${o.ago} days ago`))} ${ink.dim(date(ctx, o.day))}`;
		const lines = o.d
			? [spread(when, bold(money(o.d.spend)), w), ink.dim(`  ${[o.d.project, o.d.model].filter(Boolean).join(" with ") || "—"} · ${plural(o.d.sessions, "session")}`)]
			: [spread(when, ink.dim("zZz"), w), ink.dim("  nothing ran")];
		return i ? ["", ...lines] : lines;
	});
}

function tombstones(ctx: Ctx, p: Persona, w: number): string[] {
	const { ink } = ctx;
	const g = p.graveyard;
	if (!g.count) return [`${fg(GOOD, "(•‿•)")}  ${ink.text("no graveyard")} ${ink.dim("· every project with spend was touched in the last 60 days")}`];
	const stoneW = 11;
	const fit = Math.max(1, Math.min(g.list.length, Math.floor((w + 3) / (stoneW + 3))));
	const stones = g.list.slice(0, fit).map((x) => {
		const inside = (t: string) => `${ink.dim("|")}${pad(center(t, stoneW - 2), stoneW - 2)}${ink.dim("|")}`;
		return [
			ink.dim(" .-------. "),
			ink.dim("/  R.I.P  \\"),
			inside(bold(ink.text(x.name.length > 9 ? `${x.name.slice(0, 8)}…` : x.name))),
			inside(ink.text(money(x.cost))),
			inside(ink.dim(date(ctx, dayKey(x.lastMs)))),
			ink.dim("|_________|"),
			fg(C.mint, " \\|/ \\|/ "),
		];
	});
	return [...hstack(stones, stones.map(() => stoneW), 3), "", ink.dim(`${plural(g.count, "project")} untouched for 60+ days · ${money(g.cost)} spent on them · temp folders skipped`)];
}

function comebacks(ctx: Ctx, p: Persona, w: number): string[] {
	const { ink } = ctx;
	const out = p.comebacks.map((c) => spread(`${fg(GOOD, "↻")} ${pad(c.name, 22)} ${ink.dim(`${date(ctx, c.from)} → ${date(ctx, c.to)}`)}`, `${bold(ink.text(int(c.gap)))} ${ink.dim("days away")}`, w));
	if (!out.length) out.push(ink.muted("No project came back after 3+ weeks away."));
	out.push("");
	if (p.longestBreak) out.push(spread(ink.muted("Longest break from all of it"), `${plural(p.longestBreak.days, "day")} ${ink.dim(`· ${date(ctx, p.longestBreak.from)} → ${date(ctx, p.longestBreak.to)}`)}`, w));
	out.push(spread(ink.muted("Last active"), p.idleDays === 0 ? fg(GOOD, "today") : p.idleDays === 1 ? "yesterday" : `${p.idleDays} days ago`, w));
	return out;
}

function work(ctx: Ctx, p: Persona, w: number): string[] {
	const { ink } = ctx;
	const out: string[] = [];
	const totalCalls = p.toolKinds.reduce((a, [, n]) => a + n, 0);
	if (totalCalls) {
		const [kind, n] = p.toolKinds[0];
		out.push(`${ink.muted("Mostly")} ${bold(fg(KIND_COLOR[kind] ?? OTHER, kind))} ${ink.dim(`· ${pct(n / totalCalls, 0)} of ${compact(totalCalls)} tool calls`)}`, "");
		out.push(segmentBar(p.toolKinds.map(([k, v]) => [KIND_COLOR[k] ?? OTHER, v]), w));
		out.push(...flow(p.toolKinds.map(([k, v]) => `${dot(KIND_COLOR[k] ?? OTHER)} ${k} ${ink.dim(pct(v / totalCalls, 0))}`), w), "");
	}
	const kv = (k: string, v: string) => spread(ink.muted(k), v, w);
	const a = p.aborts;
	if (a.turns) {
		const r = a.total / a.turns;
		out.push(kv("Replies you stopped mid-way", `${fg(r > 0.05 ? BAD : r > 0.02 ? WARN : GOOD, int(a.total))} ${ink.dim(`· ${pct(r, 1)}`)}`));
		if (a.worst && a.worst[1] > 0) out.push(kv("Most stops in one day", `${int(a.worst[1])} ${ink.dim(`· ${date(ctx, a.worst[0])}`)}`));
	}
	if (p.priciestReply) out.push(kv("Priciest single reply", `${money(p.priciestReply.cost)} ${ink.dim(`· ${modelLabel(p.priciestReply.model)}`)}`));
	if (p.longestPrompt) {
		out.push(kv("Longest prompt", `${int(p.longestPrompt.chars)} chars ${ink.dim(`· ${date(ctx, dayKey(p.longestPrompt.ms))}`)}`));
		const head = p.longestPrompt.head.replace(SECRETISH, "…");
		if (head) out.push(ink.dim(`  “${head}…”`.slice(0, w)));
	}
	return out.length ? out : [ink.muted("No tool calls yet.")];
}

/** You in the selected range, in one glance. */
function lately(ctx: Ctx, w: number): string[] {
	const { ink, s } = ctx;
	if (!s.sessions.length) return [`${fg(C.lavender, "(-_-) zZz")}  ${ink.muted("nothing ran in this range")}`];
	const top = <T>(entries: Iterable<[string, T]>, v: (t: T) => number) => [...entries].sort((a, b) => v(b[1]) - v(a[1]))[0];
	const tool = top(s.harnesses, (h) => h.turns);
	const model = top(s.models, (u) => u[U.turns]);
	const project = s.projects[0];
	const swears = [...s.swears.values()].reduce((a, b) => a + b, 0);
	const kv = (k: string, v: string) => spread(ink.muted(k), v, w);
	return [
		kv("Living in", tool ? `${dot(HARNESS_COLOR[tool[0] as Harness])} ${harnessName(tool[0])}` : "\u2014"),
		kv("Talking to", model ? modelLabel(model[0]) : "\u2014"),
		kv("Building", project ? `${project.name} ${ink.dim(`\u00b7 ${money(project.cost)}`)}` : "\u2014"),
		kv("Sessions, prompts", `${int(s.sessions.length)}, ${int(s.prompts)}`),
		kv("Spent", money(s.cost)),
		kv("Swears", s.prompts ? `${int(swears)} ${ink.dim(`\u00b7 ${((swears / s.prompts) * 100).toFixed(1)} per 100 prompts`)}` : "\u2014"),
		kv("Replies stopped", int(s.usage[U.aborted])),
	];
}

/** Plain sentences, each only when its numbers exist. */
function verdicts(ctx: Ctx, p: Persona, s: Summary): string[] {
	const out: string[] = [];
	const b = (t: string) => bold(t);
	if (p.fixVsFeat) {
		const [fix, feat] = p.fixVsFeat;
		out.push(fix > feat ? `${b("fix")} commits outnumber ${b("feat")} ${(fix / Math.max(1, feat)).toFixed(1)} to 1. Shipping is the easy part.` : `${b(int(feat))} feat commits to ${b(int(fix))} fixes. You build more than you repair.`);
	}
	if (s.prompts > 0 && s.cost > 0) out.push(`Each prompt you typed cost ${b(money(s.cost / s.prompts))} on average, at API prices.`);
	if (s.activeMs > 3_600_000 && s.cost > 0) out.push(`An hour with an agent open runs ${b(money(s.cost / (s.activeMs / 3_600_000)))}.`);
	const save = cacheSavings(s.models);
	if (save.saved > 0) out.push(`Caching saved ${b(money(save.saved - save.premium))}, ${b(`${(save.saved / Math.max(1e-9, save.premium)).toFixed(0)}×`)} what the cache writes cost.`);
	const file = [...s.edits].sort((a, x) => x[1] - a[1])[0];
	if (file && file[1] >= 5) out.push(`${b(projectPath(ctx, file[0]))} is your most rewritten file: ${b(int(file[1]))} edits.`);
	const cmd = [...s.bash].sort((a, x) => x[1] - a[1]);
	if (cmd[0]) out.push(`The shell command your sessions ran most: ${b(`\`${cmd[0][0]}\``)}, ${b(int(cmd[0][1]))} times.`);
	const sleep = s.bash.get("sleep");
	if (sleep && sleep >= 10) out.push(`${b("`sleep`")} ran ${b(int(sleep))} times. Waiting is part of the job.`);
	const weekend = share(s.punch.slice(5).flat().reduce((a, x) => a + x, 0), s.punch.flat().reduce((a, x) => a + x, 0));
	if (s.usage[U.turns] > 100) out.push(weekend >= 0.3 ? `${b(pct(weekend, 0))} of your turns land on weekends. Weekends are a suggestion.` : `Only ${b(pct(weekend, 0))} of your turns land on weekends.`);
	const agentCalls = [...s.agentTools.values()].reduce((a, t) => a + t[T.calls], 0);
	const ownCalls = [...s.tools.values()].reduce((a, t) => a + t[T.calls], 0);
	if (agentCalls > ownCalls && ownCalls > 0) out.push(`Sub-agents made ${b(`${(agentCalls / ownCalls).toFixed(1)}×`)} as many tool calls as your own sessions did.`);
	if (commitsKnown(ctx) && s.commits.length >= 10) out.push(`${b(pct(share(s.aiCommits, s.commits.length), 0))} of your ${int(s.commits.length)} commits landed with an agent in the room.`);
	const swears = [...s.swears].sort((a, x) => x[1] - a[1])[0];
	if (swears && swears[1] >= 5) out.push(`Your agents have heard ${b(`“${swears[0]}”`)} ${b(int(swears[1]))} times. They are still here.`);
	return out.map((t) => `${fg(C.amber, "✦")} ${t}`);
}

export const youTab: Tab = {
	title: "You",
	hint: "your whole history · h harness · p project",
	render(ctx) {
		const { ink, width, ds } = ctx;
		const s = ctx.all;
		const p = persona(ds, s, s.filter, ctx.streak);
		if (!p.firstDay) return section(ink, width, { title: "You", body: () => [ink.muted("(・_・) nothing recorded yet")] });
		const half = 56;
		return page([
			characterCard(ctx, p, s),
			grid(ink, width, [
				{ title: "How you talk", meta: "the first line of each session", body: (w) => talk(ctx, p, w) },
				{ title: "Potty mouth", meta: "every prompt you typed", body: (w) => pottyMouth(ctx, s, w) },
			], half),
			section(ink, width, { title: "Your journey", meta: "lifetime, week by week", body: (w) => journey(ctx, p, w) }),
			section(ink, width, { title: "Trophy shelf", meta: `${fg(GOOD, "★ new!")} = set this week`, body: (w) => shelf(ctx, p.records, w) }),
			grid(ink, width, [
				{ title: "Your clock", body: (w) => yourClock(ctx, p, w) },
				{ title: "Firsts and milestones", body: (w) => timeline(ctx, p, w) },
			], half),
			grid(ink, width, [
				{ title: "On this day", body: (w) => onThisDay(ctx, p, w) },
				{ title: "Comebacks", meta: "(ﾉ◕ヮ◕)ﾉ projects you came back to", body: (w) => comebacks(ctx, p, w) },
			], half),
			section(ink, width, { title: "Graveyard", meta: "(x_x) projects you walked away from", body: (w) => tombstones(ctx, p, w) }),
			grid(ink, width, [
				{ title: "How you work", body: (w) => work(ctx, p, w) },
				{ title: "This range", meta: ctx.s.label, body: (w) => lately(ctx, w) },
			], half),
			section(ink, width, { title: "Verdicts", meta: "lifetime, from the numbers above", body: () => verdicts(ctx, p, s) }),
		]);
	},
};
