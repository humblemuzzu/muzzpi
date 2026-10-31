import os from "node:os";
import { AGENTS_SERIES, addDays, cacheHit, type Dataset, type DayStat, type Filter, isAiCommit, parseDay, type Streaks, type Summary, weekday } from "./aggregate";
import { pct } from "./draw";
import { A, dayKey, type Harness, HARNESS_LABEL, HARNESSES, type SessionRecord, T, U } from "./record";

/**
 * The lifetime read as behaviour: which tool and model ruled each week, the
 * records, the firsts, when the day starts and ends, what got abandoned.
 * Everything is counted from the summary and the records; nothing is a
 * guess, and anything without data is left out rather than filled in.
 */

const DAY_MS = 86_400_000;
const DEAD_AFTER_DAYS = 60;
/** A first line seen this often is a script talking, not a person. */
const SCRIPTED = 3;
/** A work day only starts or ends where there were this many hours without a prompt. */
const CLEAN_GAP_MS = 3 * 3_600_000;
const COMEBACK_DAYS = 21;

export type Unit = "money" | "tokens" | "int" | "duration" | "pct";

export interface Best {
	label: string;
	value: number;
	unit: Unit;
	day: string;
	detail?: string;
}

export interface Era<K> {
	key: K;
	from: string;
	to: string;
	weeks: number;
	turns: number;
}

export interface Week {
	start: string;
	harness?: Harness;
	model?: string;
}

export type TraitKey = "night" | "swarm" | "grind" | "loyal" | "explore" | "ship" | "cache" | "calm";

export interface Trait {
	key: TraitKey;
	label: string;
	/** 0..1 against a fixed bar, so two traits can be compared. */
	score: number;
	/** The real number behind the score. */
	shown: string;
}

export interface Persona {
	firstDay?: string;
	traits: Trait[];
	activeDays: number;
	weeks: Week[];
	harnessEras: Era<Harness>[];
	modelEras: Era<string>[];
	harnessSpan: Map<Harness, { first: string; last: string; days: number; turns: number }>;
	multiToolDays: number;
	mostTools?: { count: number; day: string };
	models: Array<{ model: string; first: string; last: string; days: number }>;
	records: Best[];
	firsts: Array<{ label: string; day: string; detail?: string }>;
	/** Minutes past the work day's midnight. Only days with a clean start and end (3 h without prompts on either side) set the times. */
	chronotype?: {
		start: number;
		end: number;
		days: number;
		latest?: { at: number; day: string };
		earliest?: { at: number; day: string };
		longest?: { ms: number; day: string };
		allNighters: number;
		lastAllNighter?: string;
	};
	onThisDay: Array<{ ago: number; day: string; d?: { spend: number; sessions: number; turns: number; project?: string; model?: string } }>;
	graveyard: { list: Array<{ name: string; cost: number; sessions: number; lastMs: number }>; count: number; cost: number };
	comebacks: Array<{ name: string; gap: number; from: string; to: string }>;
	longestBreak?: { days: number; from: string; to: string };
	idleDays: number;
	openers: Openers;
	aborts: { total: number; turns: number; worst?: [string, number] };
	toolKinds: Array<[string, number]>;
	priciestReply?: { ms: number; cost: number; model: string; session: string };
	longestPrompt?: { ms: number; chars: number; head: string; session: string };
	fixVsFeat?: [fix: number, feat: number];
}

const TOOL_KINDS: Array<[string, RegExp]> = [
	["reading", /^(read|grep|glob|find|ls|list|view|lsp|codesearch|read_github|search_github|glob_github|list_directory_github|read_session|search_sessions)/],
	["editing", /^(edit|write|apply_patch|multiedit|notebookedit|undo_edit|redo_edit|format_file)/],
	["shell", /^(bash|exec_command|shell|shell_command|write_stdin|execute|exec)$/],
	["delegating", /^(task|agent|delegate|chad|oracle|finder|review_code|code_review|librarian|spawn_agent)$/],
	["the web", /^(web_?search|web_?fetch|read_web_page|fetch|screenshot)/],
];

const STOPWORDS = new Set(
	`the a an and or but to of in on at for with from by as is are was were be been it its this that these those i im i'm me my we our you your u ur it's
	can could would should will just so do does did not no yes all any some what how why when where which who there here then than also into out up
	about over like get got make made use using have has had need want let lets let's please now still very more most much one two new please thing
	things stuff way what's that's dont don't isn't it's i'll i've you're we're they them their he she his her if else okay ok yeah yea
	com www http https html json md ts js tsx png org net io dev`.split(/\s+/),
);

export interface Openers {
	/** First word of the first prompt line, per session. */
	first: Array<[string, number]>;
	/** First three words, for sessions that open with at least three. */
	phrases: Array<[string, number]>;
	/** Words that show up across sessions' first lines, counted once per session. */
	words: Array<[string, number]>;
	sessions: number;
	/** Sessions whose first line repeats verbatim in many others: scripted runs, left out. */
	scripted: number;
}

/** How you open sessions, from the first line of each session's first prompt. */
export function openers(titles: Array<string | undefined>, top = 6): Openers {
	const lines = titles.map((t) => t?.trim().toLowerCase()).filter((t): t is string => !!t && !/^[[</!@{]/.test(t));
	const repeats = new Map<string, number>();
	for (const l of lines) repeats.set(l, (repeats.get(l) ?? 0) + 1);
	const first = new Map<string, number>();
	const phrases = new Map<string, number>();
	const words = new Map<string, number>();
	let sessions = 0;
	let scripted = 0;
	for (const l of lines) {
		if (repeats.get(l)! >= SCRIPTED) {
			scripted++;
			continue;
		}
		const ws = l.match(/[a-z][a-z']*/g);
		if (!ws?.length) continue;
		sessions++;
		first.set(ws[0], (first.get(ws[0]) ?? 0) + 1);
		if (ws.length >= 3) {
			const phrase = ws.slice(0, 3).join(" ");
			phrases.set(phrase, (phrases.get(phrase) ?? 0) + 1);
		}
		for (const w of new Set(ws)) if (w.length > 2 && !STOPWORDS.has(w)) words.set(w, (words.get(w) ?? 0) + 1);
	}
	const rank = (m: Map<string, number>, n: number) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n);
	return { first: rank(first, top), phrases: rank(phrases, 3), words: rank(words, 12), sessions, scripted };
}

function tempRoot(root: string): boolean {
	return root.startsWith("/private/") || root.startsWith("/tmp") || root.startsWith("/var/folders") || root.startsWith(os.tmpdir());
}

function used(d: DayStat | undefined): boolean {
	return !!d && (d.turns > 0 || d.tokens > 0);
}

/** The heaviest key of a week: turns where there were any, tokens for days known only by totals. */
function dominant(rows: Array<Map<string, number[]>>, skip?: string): string | undefined {
	const score = new Map<string, [number, number]>();
	for (const m of rows) {
		for (const [k, v] of m) {
			if (k === skip) continue;
			const s = score.get(k) ?? [0, 0];
			s[0] += v[2];
			s[1] += v[1];
			score.set(k, s);
		}
	}
	const byTurns = [...score].some(([, s]) => s[0] > 0);
	let best: [string, number] | undefined;
	for (const [k, [turns, tokens]] of score) {
		const v = byTurns ? turns : tokens;
		if (v > 0 && (!best || v > best[1])) best = [k, v];
	}
	return best?.[0];
}

function eras<K extends string>(weeks: Week[], pick: (w: Week) => K | undefined, turns: (w: Week, k: K) => number, today: string): Era<K>[] {
	const out: Era<K>[] = [];
	for (const w of weeks) {
		const k = pick(w);
		if (!k) continue;
		const last = out[out.length - 1];
		const end = addDays(w.start, 6) > today ? today : addDays(w.start, 6);
		if (last?.key === k) {
			last.to = end;
			last.weeks++;
			last.turns += turns(w, k);
		} else out.push({ key: k, from: w.start, to: end, weeks: 1, turns: turns(w, k) });
	}
	return out;
}

function median(xs: number[]): number {
	const s = [...xs].sort((a, b) => a - b);
	return s.length ? s[Math.floor(s.length / 2)] : NaN;
}

function argmax<T>(items: Iterable<T>, value: (t: T) => number): T | undefined {
	let best: T | undefined;
	let bv = -Infinity;
	for (const t of items) {
		const v = value(t);
		if (v > bv) {
			best = t;
			bv = v;
		}
	}
	return bv > 0 ? best : undefined;
}

export function persona(ds: Dataset, all: Summary, filter: Filter, streak: Streaks): Persona {
	const today = ds.today;
	const days = all.days.filter((d) => used(all.daily.get(d)));
	const records: SessionRecord[] = ds.records.filter((r) => (filter.harness === undefined || r.harness === filter.harness) && (filter.project === undefined || ds.projectOf.get(r) === filter.project));
	const nameOf = (root: string) => ds.projectName.get(root) ?? root;
	const sessionName = (r: SessionRecord) => r.name ?? r.title ?? "untitled";
	const commitsKnown = filter.harness === undefined && filter.provider === undefined;

	const weeks: Week[] = [];
	if (days.length) {
		for (let start = addDays(days[0], -weekday(days[0])); start <= today; start = addDays(start, 7)) {
			const ds7 = Array.from({ length: 7 }, (_, i) => all.daily.get(addDays(start, i))).filter((d): d is DayStat => !!d);
			weeks.push({ start, harness: dominant(ds7.map((d) => d.byHarness)) as Harness | undefined, model: dominant(ds7.map((d) => d.byModel), AGENTS_SERIES) });
		}
	}
	const weekTurns = (w: Week, key: string, of: (d: DayStat) => Map<string, number[]>) => {
		let n = 0;
		for (let i = 0; i < 7; i++) {
			const d = all.daily.get(addDays(w.start, i));
			if (d) n += of(d).get(key)?.[2] ?? 0;
		}
		return n;
	};

	const harnessSpan = new Map<Harness, { first: string; last: string; days: number; turns: number }>();
	const modelSpan = new Map<string, { first: string; last: string; days: number }>();
	let multiToolDays = 0;
	let mostTools: { count: number; day: string } | undefined;
	for (const day of days) {
		const d = all.daily.get(day)!;
		const tools = [...d.byHarness].filter(([, v]) => v[2] > 0 || v[1] > 0);
		if (tools.length >= 2) multiToolDays++;
		if (tools.length > (mostTools?.count ?? 1)) mostTools = { count: tools.length, day };
		for (const [h, v] of tools) {
			const s = harnessSpan.get(h as Harness) ?? { first: day, last: day, days: 0, turns: 0 };
			s.last = day;
			s.days++;
			s.turns += v[2];
			harnessSpan.set(h as Harness, s);
		}
		for (const [m, v] of d.byModel) {
			if (m === AGENTS_SERIES || (v[2] <= 0 && v[1] <= 0)) continue;
			const s = modelSpan.get(m) ?? { first: day, last: day, days: 0 };
			s.last = day;
			s.days++;
			modelSpan.set(m, s);
		}
	}

	const bestDay = (label: string, unit: Unit, value: (d: DayStat) => number, detail?: (d: DayStat) => string): Best | undefined => {
		const d = argmax(days.map((x) => all.daily.get(x)!), value);
		return d && { label, value: value(d), unit, day: d.day, detail: detail?.(d) };
	};
	const topOf = (m: Map<string, number[]>, skip?: string) => argmax([...m].filter(([k]) => k !== skip), ([, v]) => v[0])?.[0];
	const spendDetail = (d: DayStat) => [topOf(d.byProject) && nameOf(topOf(d.byProject)!), topOf(d.byModel, AGENTS_SERIES)?.split("/").pop()].filter(Boolean).join(" · ");

	let swarm: Best | undefined;
	let reply: Persona["priciestReply"];
	let prompt: Persona["longestPrompt"];
	for (const r of records) {
		for (const [key, n] of Object.entries(r.fanout)) {
			const size = Number(key.slice(key.lastIndexOf("\t") + 1));
			if (n > 0 && size > (swarm?.value ?? 1)) swarm = { label: "Biggest swarm", value: size, unit: "int", day: key.slice(0, 10), detail: "agents from one reply" };
		}
		const p = r.peak;
		if (p?.reply && p.reply[1] > (reply?.cost ?? 0)) reply = { ms: p.reply[0], cost: p.reply[1], model: p.reply[2], session: sessionName(r) };
		if (p?.prompt && p.prompt[1] > (prompt?.chars ?? 0)) prompt = { ms: p.prompt[0], chars: p.prompt[1], head: p.prompt[2], session: sessionName(r) };
	}

	const longest = argmax(all.sessions, (x) => x.activeMs);
	const cacheDay = argmax(
		days.map((x) => all.daily.get(x)!).filter((d) => d.cacheDenom >= 1e6),
		(d) => d.cacheRead / d.cacheDenom,
	);
	const records_: Array<Best | undefined> = [
		bestDay("Biggest day", "money", (d) => d.cost + d.agentCost, spendDetail),
		bestDay("Most tokens", "tokens", (d) => d.tokens),
		bestDay("Most turns", "int", (d) => d.turns),
		bestDay("Most prompts", "int", (d) => d.prompts),
		bestDay("Most sessions", "int", (d) => d.sessions),
		filter.provider === undefined ? bestDay("Most agent time", "duration", (d) => d.activeMs, () => "agents running") : undefined,
		commitsKnown ? bestDay("Most commits", "int", (d) => d.commits, (d) => `${d.aiCommits.toLocaleString("en-US")} with AI`) : undefined,
		longest && longest.activeMs > 0 ? { label: "Longest-running", value: longest.activeMs, unit: "duration", day: dayKey(longest.lastMs || longest.firstMs), detail: longest.name } : undefined,
		streak.longestStreak > 1 ? { label: "Longest streak", value: streak.longestStreak, unit: "int", day: streak.longestStreakEnd, detail: "days in a row" } : undefined,
		swarm,
		cacheDay ? { label: "Best cache day", value: cacheDay.cacheRead / cacheDay.cacheDenom, unit: "pct", day: cacheDay.day, detail: "of 1M+ prompt tokens" } : undefined,
		reply ? { label: "Priciest reply", value: reply.cost, unit: "money", day: dayKey(reply.ms), detail: reply.model.split("/").pop() } : undefined,
		prompt ? { label: "Longest prompt", value: prompt.chars, unit: "int", day: dayKey(prompt.ms), detail: "characters" } : undefined,
	];

	const firsts: Persona["firsts"] = [];
	if (days.length) firsts.push({ label: "First recorded day", day: days[0] });
	for (const h of HARNESSES) {
		const s = harnessSpan.get(h);
		if (s && filter.harness === undefined) firsts.push({ label: `First ${HARNESS_LABEL[h]} day`, day: s.first });
	}
	for (const amount of [100, 1000]) {
		const d = days.find((x) => {
			const s = all.daily.get(x)!;
			return s.cost + s.agentCost >= amount;
		});
		if (d) firsts.push({ label: `First $${amount.toLocaleString("en-US")} day`, day: d });
	}
	let spent = 0;
	let tokens = 0;
	const moneyMarks = [1e3, 1e4, 2.5e4, 5e4, 1e5, 2.5e5];
	const tokenMarks = [1e9, 1e10, 5e10, 1e11, 5e11];
	for (const day of days) {
		const d = all.daily.get(day)!;
		const before = [spent, tokens];
		spent += d.cost + d.agentCost;
		tokens += d.tokens;
		for (const m of moneyMarks) if (before[0] < m && spent >= m) firsts.push({ label: `Lifetime passed $${m >= 1e3 ? `${m / 1e3}K` : m}`, day });
		for (const m of tokenMarks) if (before[1] < m && tokens >= m) firsts.push({ label: `Lifetime passed ${m / 1e9}B tokens`, day });
	}
	if (commitsKnown) {
		const c = [...all.commits].sort((a, b) => a.ms - b.ms).find((x) => isAiCommit(ds, x));
		if (c) firsts.push({ label: "First AI-assisted commit", day: dayKey(c.ms), detail: c.subject.slice(0, 48) });
	}
	const newest = argmax(modelSpan, ([, s]) => parseDay(s.first).getTime());
	if (newest) firsts.push({ label: "Newest model met", day: newest[1].first, detail: newest[0].split("/").pop() });
	firsts.sort((a, b) => a.day.localeCompare(b.day));

	const work = new Map<string, [number, number]>();
	for (const r of records) {
		for (const [wd, [a, b]] of Object.entries(r.awake ?? {})) {
			const w = work.get(wd);
			if (w) {
				w[0] = Math.min(w[0], a);
				w[1] = Math.max(w[1], b);
			} else work.set(wd, [a, b]);
		}
	}
	let chronotype: Persona["chronotype"];
	if (work.size && filter.provider === undefined) {
		const offset = (wd: string, ms: number) => (ms - parseDay(wd).getTime()) / 60_000;
		const list = [...work].sort((a, b) => a[0].localeCompare(b[0]));
		const entries = list.map(([wd, [a, b]], i) => {
			const prev = list[i - 1]?.[1];
			const next = list[i + 1]?.[1];
			return { wd, start: offset(wd, a), end: offset(wd, b), len: b - a, fresh: !prev || a - prev[1] >= CLEAN_GAP_MS, clean: !next || next[0] - b >= CLEAN_GAP_MS };
		});
		const whole = entries.filter((e) => e.fresh && e.clean);
		const late = argmax(entries.filter((e) => e.clean), (e) => e.end);
		const early = argmax(entries.filter((e) => e.fresh), (e) => 24 * 60 - e.start);
		const long = argmax(whole, (e) => e.len);
		const nighters = entries.filter((e) => !e.clean);
		if (whole.length)
			chronotype = {
				start: median(whole.map((e) => e.start)),
				end: median(whole.map((e) => e.end)),
				days: whole.length,
				latest: late && { at: late.end, day: late.wd },
				earliest: early && { at: early.start, day: early.wd },
				longest: long && { ms: long.len, day: long.wd },
				allNighters: nighters.length,
				lastAllNighter: nighters[nighters.length - 1]?.wd,
			};
	}

	const onThisDay = [30, 90, 180, 365].map((ago) => {
		const day = addDays(today, -ago);
		const d = all.daily.get(day);
		if (!used(d)) return { ago, day };
		const project = topOf(d!.byProject);
		return { ago, day, d: { spend: d!.cost + d!.agentCost, sessions: d!.sessions, turns: d!.turns, project: project && nameOf(project), model: topOf(d!.byModel, AGENTS_SERIES)?.split("/").pop() } };
	});

	const dead = all.projects.filter((p) => !tempRoot(p.root) && p.lastMs > 0 && parseDay(today).getTime() - p.lastMs > DEAD_AFTER_DAYS * DAY_MS && p.cost >= 1);
	const graveyard = { list: dead.slice(0, 6).map((p) => ({ name: p.name, cost: p.cost, sessions: p.sessions, lastMs: p.lastMs })), count: dead.length, cost: dead.reduce((a, p) => a + p.cost, 0) };

	const projectDays = new Map<string, string[]>();
	for (const day of days) for (const [root, v] of all.daily.get(day)!.byProject) if (v[2] > 0 || v[1] > 0) (projectDays.get(root) ?? projectDays.set(root, []).get(root)!).push(day);
	const comebacks: Persona["comebacks"] = [];
	for (const [root, list] of projectDays) {
		if (tempRoot(root)) continue;
		let best: { gap: number; from: string; to: string } | undefined;
		for (let i = 1; i < list.length; i++) {
			const gap = Math.round((parseDay(list[i]).getTime() - parseDay(list[i - 1]).getTime()) / DAY_MS);
			if (gap >= COMEBACK_DAYS && gap > (best?.gap ?? 0)) best = { gap, from: list[i - 1], to: list[i] };
		}
		if (best) comebacks.push({ name: nameOf(root), ...best });
	}
	comebacks.sort((a, b) => b.gap - a.gap);

	let longestBreak: Persona["longestBreak"];
	for (let i = 1; i < days.length; i++) {
		const gap = Math.round((parseDay(days[i]).getTime() - parseDay(days[i - 1]).getTime()) / DAY_MS) - 1;
		if (gap > (longestBreak?.days ?? 0)) longestBreak = { days: gap, from: days[i - 1], to: days[i] };
	}
	const idleDays = days.length ? Math.round((parseDay(today).getTime() - parseDay(days[days.length - 1]).getTime()) / DAY_MS) : 0;


	const worstAbort = argmax(days.map((x) => all.daily.get(x)!), (d) => d.aborted);
	const kinds = new Map<string, number>();
	for (const [name, t] of all.tools) {
		const kind = TOOL_KINDS.find(([, re]) => re.test(name))?.[0] ?? "other";
		kinds.set(kind, (kinds.get(kind) ?? 0) + t[T.calls]);
	}

	let fixVsFeat: [number, number] | undefined;
	if (commitsKnown) {
		const typeOf = (s: string) => s.match(/^(\w+)(\([^)]*\))?!?:/)?.[1]?.toLowerCase();
		const fix = all.commits.filter((c) => typeOf(c.subject) === "fix").length;
		const feat = all.commits.filter((c) => typeOf(c.subject) === "feat").length;
		if (fix + feat >= 10) fixVsFeat = [fix, feat];
	}

	const traits: Trait[] = [];
	const trait = (key: TraitKey, label: string, score: number, shown: string) => {
		if (Number.isFinite(score)) traits.push({ key, label, score: Math.max(0, Math.min(1, score)), shown });
	};
	const allTurns = all.punch.flat().reduce((a, b) => a + b, 0);
	const night = allTurns ? all.punch.reduce((a, r) => a + r.slice(0, 5).reduce((x, y) => x + y, 0), 0) / allTurns : NaN;
	trait("night", "Night owl", night / 0.25, `${pct(night, 0)} of turns after midnight`);
	const agentShare = all.cost > 0 ? all.agentTotal[A.cost] / all.cost : NaN;
	if (filter.provider === undefined) trait("swarm", "Delegation", agentShare / 0.5, `${pct(agentShare, 0)} of spend went to sub-agents`);
	if (days.length) {
		const span = Math.round((parseDay(today).getTime() - parseDay(days[0]).getTime()) / DAY_MS) + 1;
		trait("grind", "Grind", days.length / span, `active ${days.length} of ${span} days`);
	}
	const topModel = argmax(all.models, ([, u]) => u[U.turns]);
	if (topModel && all.usage[U.turns]) trait("loyal", "Loyalty", topModel[1][U.turns] / all.usage[U.turns], `${pct(topModel[1][U.turns] / all.usage[U.turns], 0)} of turns on ${topModel[0].split("/").pop()}`);
	trait("explore", "Curiosity", modelSpan.size / 60, `${modelSpan.size} models tried`);
	if (commitsKnown && days.length && all.commits.length) trait("ship", "Shipping", all.aiCommits / days.length / 8, `${(all.aiCommits / days.length).toFixed(1)} AI commits per active day`);
	const hit = cacheHit(all.usage);
	trait("cache", "Cache discipline", (hit - 0.5) / 0.5, `${pct(hit, 0)} cache hit`);
	if (all.usage[U.turns]) {
		const stopped = all.usage[U.aborted] / all.usage[U.turns];
		trait("calm", "Patience", 1 - stopped / 0.03, `${pct(stopped, 1)} of replies stopped`);
	}

	return {
		traits,
		firstDay: days[0],
		activeDays: days.length,
		weeks,
		harnessEras: eras(weeks, (w) => w.harness, (w, k) => weekTurns(w, k, (d) => d.byHarness), today),
		modelEras: eras(weeks, (w) => w.model, (w, k) => weekTurns(w, k, (d) => d.byModel), today),
		harnessSpan,
		multiToolDays,
		mostTools,
		models: [...modelSpan].map(([model, s]) => ({ model, ...s })).sort((a, b) => a.first.localeCompare(b.first)),
		records: records_.filter((b): b is Best => !!b && b.value > 0),
		firsts,
		chronotype,
		onThisDay,
		graveyard,
		comebacks: comebacks.slice(0, 5),
		longestBreak: longestBreak && longestBreak.days > 0 ? longestBreak : undefined,
		idleDays,
		openers: openers(all.sessions.map((x) => x.title)),
		aborts: { total: all.usage[U.aborted], turns: all.usage[U.turns], worst: worstAbort && [worstAbort.day, worstAbort.aborted] },
		toolKinds: [...kinds].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]),
		priciestReply: reply,
		longestPrompt: prompt,
		fixVsFeat,
	};
}
