import path from "node:path";
import type { Commit, GitData } from "./git";
import { A, A_LEN, dayKey, HARNESSES, type Harness, providerOf, type SessionRecord, T_LEN, U, U_LEN } from "./record";

export const RANGES = [
	{ id: "7d", label: "Last 7 days", days: 7 },
	{ id: "30d", label: "Last 30 days", days: 30 },
	{ id: "90d", label: "Last 90 days", days: 90 },
	{ id: "1y", label: "Last 365 days", days: 365 },
	{ id: "all", label: "Lifetime", days: 0 },
] as const;
export type RangeId = (typeof RANGES)[number]["id"];

/** The timeline's pseudo-model for sub-agent spend. */
export const AGENTS_SERIES = "agents";

export type Span = [number, number];

export interface Filter {
	harness?: Harness;
	/** A project root: sessions, agents, spans and commits of that repo only. */
	project?: string;
	/** Main-session turns of that provider only; sub-agent rows carry no provider, so agents are left out. */
	provider?: string;
}

/** Inclusive local-date bounds. */
export interface Window {
	start: string;
	end: string;
}

export interface DayStat {
	day: string;
	cost: number;
	agentCost: number;
	tokens: number;
	turns: number;
	sessions: number;
	agentRuns: number;
	activeMs: number;
	commits: number;
	aiCommits: number;
	cacheRead: number;
	cacheDenom: number;
	busts: number;
	prompts: number;
	swears: number;
	/** Replies stopped mid-way, and replies that ended in an error. */
	aborted: number;
	errors: number;
	/** [input, output, cacheRead, cacheWrite] cost of main turns. */
	parts: number[];
	/** series → [cost, tokens, turns]; sub-agents under AGENTS_SERIES. */
	byModel: Map<string, number[]>;
	byProject: Map<string, number[]>;
	byHarness: Map<string, number[]>;
}

export interface SessionStat {
	harness: Harness;
	id: string;
	name?: string;
	/** First line of the first prompt: the user's own words, unlike an auto-generated name. */
	title?: string;
	project: string;
	cost: number;
	turns: number;
	tokens: number;
	agentRuns: number;
	firstMs: number;
	lastMs: number;
	activeMs: number;
	peakContext: number;
	peakModel: string;
	compactions: number;
}

export interface BustRow {
	ms: number;
	model: string;
	context: number;
	cost: number;
	gapMs: number;
	idle: boolean;
	session: SessionStat;
}

export interface ProjectStat {
	root: string;
	name: string;
	cost: number;
	turns: number;
	tokens: number;
	sessions: number;
	activeDays: number;
	lastMs: number;
	commits: number;
	aiCommits: number;
	added: number;
	deleted: number;
	harnesses: Set<Harness>;
}

export interface HarnessStat {
	cost: number;
	agentCost: number;
	tokens: number;
	turns: number;
	sessions: number;
	estimated: number;
	prompts: number;
	swears: number;
}

export interface Streaks {
	currentStreak: number;
	longestStreak: number;
	longestStreakEnd: string;
}

export interface Lifetime extends Streaks {
	firstDay: string;
	activeDays: Set<string>;
	/** Every main-session model, by lifetime cost. */
	modelRank: string[];
	providerRank: string[];
	projectRank: string[];
	/** Harnesses with any usage, by lifetime cost. */
	harnessRank: Harness[];
}

export interface Dataset {
	records: SessionRecord[];
	git: GitData;
	today: string;
	generatedAt: number;
	projectOf: Map<SessionRecord, string>;
	projectName: Map<string, string>;
	/** Active spans of every session in each repo, for commits made while an agent was at work. */
	rootSpans: Map<string, Span[]>;
	sessionIds: Set<string>;
	/** Session id → the model with the largest main-session cost in it (ties: most turns). */
	leadModel: Map<string, string>;
	lifetime: Lifetime;
}

export interface Summary {
	label: string;
	filter: Filter;
	days: string[];
	daily: Map<string, DayStat>;
	usage: number[];
	agentTotal: number[];
	cost: number;
	tokens: number;
	models: Map<string, number[]>;
	providers: Map<string, number[]>;
	thinking: Map<string, number[]>;
	harnesses: Map<Harness, HarnessStat>;
	agents: Map<string, number[]>;
	agentModels: Map<string, number[]>;
	/** `${agent}\t${model}` → agent row. */
	agentPairs: Map<string, number[]>;
	/** Agent name → the harnesses that ran it. */
	agentHarness: Map<string, Set<Harness>>;
	/** Model → the harnesses that used it. */
	modelHarness: Map<string, Set<Harness>>;
	tools: Map<string, number[]>;
	agentTools: Map<string, number[]>;
	bash: Map<string, number>;
	edits: Map<string, number>;
	/** [weekday Mon=0][hour] → turns. */
	punch: number[][];
	hourlyCost: number[];
	weekdayCost: number[];
	prompts: number;
	promptChars: number;
	/** Swear word (by root) to how often it was typed. */
	swears: Map<string, number>;
	sessions: SessionStat[];
	projects: ProjectStat[];
	compactions: number;
	compactionMax: number;
	/** Model → tokensBefore of each compaction. */
	compactionTokens: Map<string, number[]>;
	/** Model → context size of each main turn. */
	contexts: Map<string, number[]>;
	busts: BustRow[];
	fanout: Map<number, number>;
	goalsSet: number;
	goalsDone: number;
	goalSeconds: number;
	activeMs: number;
	sessionMs: number;
	commits: Commit[];
	/** Commits tagged with one of our session ids, or made while a session was active in that repo. */
	aiCommits: number;
	/** Lines added plus removed by those commits. */
	aiLines: number;
	taggedCommits: number;
	/** Tagged commits per lead model of the tagging session; untagged commits are in no model's count. */
	modelCommits: Map<string, number>;
	activeDays: number;
}

export function tokensOf(u: number[]): number {
	return u[U.input] + u[U.output] + u[U.cacheRead] + u[U.cacheWrite];
}

export function agentTokens(a: number[]): number {
	return a[A.input] + a[A.output] + a[A.cacheRead] + a[A.cacheWrite];
}

/** NaN, which formats as "—", when there were no prompt tokens to hit. */
export function cacheHit(u: number[]): number {
	const denom = u[U.input] + u[U.cacheRead] + u[U.cacheWrite];
	return denom > 0 ? u[U.cacheRead] / denom : NaN;
}

function addRow(map: Map<string, number[]>, key: string, row: number[], len: number): void {
	let acc = map.get(key);
	if (!acc) map.set(key, (acc = new Array(len).fill(0)));
	for (let i = 0; i < len; i++) acc[i] += row[i];
}

function addNum<K>(map: Map<K, number>, key: K, n: number): void {
	map.set(key, (map.get(key) ?? 0) + n);
}

function addTo<K, V>(map: Map<K, Set<V>>, key: K, v: V): void {
	const set = map.get(key);
	if (set) set.add(v);
	else map.set(key, new Set([v]));
}

/** `day\tprovider\tvalue` → [provider, value]; the value may itself hold tabs. */
function afterDay(key: string): [string, string] {
	const tab = key.indexOf("\t", 11);
	return [key.slice(11, tab), key.slice(tab + 1)];
}

/** Nearest-rank percentile of an ascending list. */
export function percentile(sorted: number[], p: number): number | undefined {
	if (!sorted.length) return undefined;
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

export interface Burn {
	spent: number;
	/** Days of the month so far, today included. */
	elapsed: number;
	daysInMonth: number;
	/** spent ÷ elapsed × daysInMonth: a straight line, not a forecast. */
	projection: number;
	budget?: number;
}

export function burn(spent: number, today: string, budget?: number): Burn {
	const d = parseDay(today);
	const elapsed = d.getDate();
	const daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
	return { spent, elapsed, daysInMonth, projection: (spent / elapsed) * daysInMonth, budget };
}

export function parseDay(day: string): Date {
	return new Date(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
}

export function addDays(day: string, n: number): string {
	const d = parseDay(day);
	d.setDate(d.getDate() + n);
	return dayKey(d.getTime());
}

/** Mon=0 … Sun=6. */
export function weekday(day: string): number {
	return (parseDay(day).getDay() + 6) % 7;
}

function mergeSpans(spans: Span[]): Span[] {
	const sorted = [...spans].sort((a, b) => a[0] - b[0]);
	const out: Span[] = [];
	for (const s of sorted) {
		const last = out[out.length - 1];
		if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
		else out.push([s[0], s[1]]);
	}
	return out;
}

function clippedMs(spans: Span[], from: number, to: number): number {
	let ms = 0;
	for (const [a, b] of spans) ms += Math.max(0, Math.min(b, to) - Math.max(a, from));
	return ms;
}

const COMMIT_GRACE_MS = 10 * 60_000;

function insideSpans(spans: Span[] | undefined, ms: number): boolean {
	if (!spans) return false;
	let lo = 0;
	let hi = spans.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const [a, b] = spans[mid];
		if (ms < a) hi = mid - 1;
		else if (ms > b + COMMIT_GRACE_MS) lo = mid + 1;
		else return true;
	}
	return false;
}

export function streaks(active: Set<string>, today: string): Streaks {
	const days = [...active].sort();
	let longest = 0;
	let longestEnd = "";
	let run = 0;
	let prev = "";
	for (const d of days) {
		run = prev && addDays(prev, 1) === d ? run + 1 : 1;
		if (run > longest) {
			longest = run;
			longestEnd = d;
		}
		prev = d;
	}
	let current = 0;
	let cursor = active.has(today) ? today : addDays(today, -1);
	while (active.has(cursor)) {
		current++;
		cursor = addDays(cursor, -1);
	}
	return { currentStreak: current, longestStreak: longest, longestStreakEnd: longestEnd };
}

function uniqueNames(roots: string[]): Map<string, string> {
	const byBase = new Map<string, string[]>();
	for (const r of roots) {
		const base = path.basename(r) || r;
		byBase.set(base, [...(byBase.get(base) ?? []), r]);
	}
	const out = new Map<string, string>();
	for (const [base, list] of byBase) {
		for (const r of list) out.set(r, list.length > 1 ? `${path.basename(path.dirname(r))}/${base}` : base);
	}
	return out;
}

/** Where a record's spend is grouped as one session: its harness and the session it belongs to. */
export const sessionKey = (r: { harness: Harness; id: string }) => `${r.harness}\t${r.id}`;

const active = (u: number[]) => u[U.turns] > 0 || tokensOf(u) > 0;

export function prepare(records: SessionRecord[], git: GitData, now = Date.now()): Dataset {
	const today = dayKey(now);
	const projectOf = new Map<SessionRecord, string>();
	const rootSpanLists = new Map<string, Span[]>();
	const activeDays = new Set<string>();
	const modelCost = new Map<string, number>();
	const providerCost = new Map<string, number>();
	const projectCost = new Map<string, number>();
	const harnessCost = new Map<Harness, number>();
	const used = new Set<Harness>();
	const sessionModels = new Map<string, Map<string, [number, number]>>();
	let firstDay = today;

	for (const rec of records) {
		const root = git.roots.get(rec.cwd) ?? rec.cwd;
		projectOf.set(rec, root);
		if (rec.role !== "archive") {
			const spans = rootSpanLists.get(root) ?? [];
			spans.push(...rec.spans);
			rootSpanLists.set(root, spans);
		}
		let perModel = sessionModels.get(rec.id);
		if (!perModel) sessionModels.set(rec.id, (perModel = new Map()));
		for (const [key, v] of Object.entries(rec.usage)) {
			const day = key.slice(0, 10);
			const model = key.split("\t")[1];
			if (active(v)) {
				activeDays.add(day);
				used.add(rec.harness);
			}
			if (day < firstDay) firstDay = day;
			addNum(modelCost, model, v[U.cost]);
			addNum(providerCost, providerOf(model), v[U.cost]);
			addNum(harnessCost, rec.harness, v[U.cost]);
			if (rec.role !== "archive") addNum(projectCost, root, v[U.cost]);
			const acc = perModel.get(model) ?? [0, 0];
			acc[0] += v[U.cost];
			acc[1] += v[U.turns];
			perModel.set(model, acc);
		}
		for (const [key, v] of Object.entries(rec.agents)) {
			const day = key.slice(0, 10);
			if (v[A.turns] > 0 || v[A.runs] > 0) {
				activeDays.add(day);
				used.add(rec.harness);
			}
			if (day < firstDay) firstDay = day;
			addNum(projectCost, root, v[A.cost]);
			addNum(harnessCost, rec.harness, v[A.cost]);
		}
	}

	const rootSpans = new Map<string, Span[]>();
	for (const [root, spans] of rootSpanLists) rootSpans.set(root, mergeSpans(spans));
	const rank = <K>(m: Map<K, number>) => [...m].sort((a, b) => b[1] - a[1]).map(([k]) => k);
	const leadModel = new Map<string, string>();
	for (const [id, perModel] of sessionModels) {
		let best: [string, number, number] | undefined;
		for (const [model, [cost, turns]] of perModel) {
			if (turns > 0 && (!best || cost > best[1] || (cost === best[1] && turns > best[2]))) best = [model, cost, turns];
		}
		if (best) leadModel.set(id, best[0]);
	}

	return {
		records,
		git,
		today,
		generatedAt: now,
		projectOf,
		projectName: uniqueNames([...new Set(records.filter((r) => r.role !== "archive").map((r) => projectOf.get(r)!))]),
		rootSpans,
		sessionIds: new Set(records.map((r) => r.id)),
		leadModel,
		lifetime: {
			firstDay,
			activeDays,
			...streaks(activeDays, today),
			modelRank: rank(modelCost),
			providerRank: rank(providerCost),
			projectRank: rank(projectCost).filter((p) => p),
			harnessRank: HARNESSES.filter((h) => used.has(h)).sort((a, b) => (harnessCost.get(b) ?? 0) - (harnessCost.get(a) ?? 0)),
		},
	};
}

function emptyDay(day: string): DayStat {
	return {
		day,
		cost: 0,
		agentCost: 0,
		tokens: 0,
		turns: 0,
		sessions: 0,
		agentRuns: 0,
		activeMs: 0,
		commits: 0,
		aiCommits: 0,
		cacheRead: 0,
		cacheDenom: 0,
		busts: 0,
		prompts: 0,
		swears: 0,
		aborted: 0,
		errors: 0,
		parts: [0, 0, 0, 0],
		byModel: new Map(),
		byProject: new Map(),
		byHarness: new Map(),
	};
}

export function rangeWindow(ds: Dataset, rangeId: RangeId): Window {
	const range = RANGES.find((r) => r.id === rangeId)!;
	return { start: range.days ? addDays(ds.today, -(range.days - 1)) : ds.lifetime.firstDay, end: ds.today };
}

export function dayCount(w: Window): number {
	return Math.round((parseDay(w.end).getTime() - parseDay(w.start).getTime()) / 86_400_000) + 1;
}

/** The window of the same length that ends the day before `w` starts. */
export function previousWindow(w: Window): Window {
	const end = addDays(w.start, -1);
	return { start: addDays(end, -(dayCount(w) - 1)), end };
}

export function monthWindow(today: string): Window {
	return { start: `${today.slice(0, 8)}01`, end: today };
}

export function summarize(ds: Dataset, rangeId: RangeId, filter: Filter = {}): Summary {
	return summarizeWindow(ds, rangeWindow(ds, rangeId), filter, RANGES.find((r) => r.id === rangeId)!.label);
}

function emptyHarness(): HarnessStat {
	return { cost: 0, agentCost: 0, tokens: 0, turns: 0, sessions: 0, estimated: 0, prompts: 0, swears: 0 };
}

export function summarizeWindow(ds: Dataset, { start, end }: Window, filter: Filter = {}, label = `${start} → ${end}`): Summary {
	const days: string[] = [];
	for (let d = start; d <= end; d = addDays(d, 1)) days.push(d);
	const inRange = (day: string) => day >= start && day <= end;
	const fromMs = parseDay(start).getTime();
	const toMs = parseDay(addDays(end, 1)).getTime();
	const byProvider = filter.provider !== undefined;
	const providerOk = (provider: string) => !byProvider || provider === filter.provider;

	const daily = new Map(days.map((d) => [d, emptyDay(d)]));
	const weekdayOf = new Map(days.map((d) => [d, weekday(d)]));
	const s: Summary = {
		label,
		filter,
		days,
		daily,
		usage: new Array(U_LEN).fill(0),
		agentTotal: new Array(A_LEN).fill(0),
		cost: 0,
		tokens: 0,
		models: new Map(),
		providers: new Map(),
		thinking: new Map(),
		harnesses: new Map(),
		agents: new Map(),
		agentModels: new Map(),
		agentPairs: new Map(),
		agentHarness: new Map(),
		modelHarness: new Map(),
		tools: new Map(),
		agentTools: new Map(),
		bash: new Map(),
		edits: new Map(),
		punch: Array.from({ length: 7 }, () => new Array(24).fill(0)),
		hourlyCost: new Array(24).fill(0),
		weekdayCost: new Array(7).fill(0),
		prompts: 0,
		promptChars: 0,
		swears: new Map(),
		sessions: [],
		projects: [],
		compactions: 0,
		compactionMax: 0,
		compactionTokens: new Map(),
		contexts: new Map(),
		busts: [],
		fanout: new Map(),
		goalsSet: 0,
		goalsDone: 0,
		goalSeconds: 0,
		activeMs: 0,
		sessionMs: 0,
		commits: [],
		aiCommits: 0,
		aiLines: 0,
		taggedCommits: 0,
		modelCommits: new Map(),
		activeDays: 0,
	};

	const projects = new Map<string, ProjectStat & { dayset: Set<string> }>();
	const project = (root: string) => {
		let p = projects.get(root);
		if (!p) {
			p = { root, name: ds.projectName.get(root) ?? root, cost: 0, turns: 0, tokens: 0, sessions: 0, activeDays: 0, lastMs: 0, commits: 0, aiCommits: 0, added: 0, deleted: 0, harnesses: new Set(), dayset: new Set() };
			projects.set(root, p);
		}
		return p;
	};
	const harness = (h: Harness) => s.harnesses.get(h) ?? s.harnesses.set(h, emptyHarness()).get(h)!;
	const goals = new Map<string, [string, number, number]>();
	const push = <K, V>(map: Map<K, V[]>, key: K, v: V) => {
		const list = map.get(key);
		if (list) list.push(v);
		else map.set(key, [v]);
	};
	const sessions = new Map<string, { ss: SessionStat; days: Set<string>; spans: Span[]; busts: BustRow[] }>();
	const allSpans: Span[] = [];

	for (const rec of ds.records) {
		if (filter.harness !== undefined && rec.harness !== filter.harness) continue;
		const root = ds.projectOf.get(rec)!;
		if (filter.project !== undefined && root !== filter.project) continue;
		const archive = rec.role === "archive";
		const sk = sessionKey(rec);
		let entry = archive ? undefined : sessions.get(sk);
		if (!archive && !entry) {
			const ss: SessionStat = { harness: rec.harness, id: rec.id, project: root, cost: 0, turns: 0, tokens: 0, agentRuns: 0, firstMs: 0, lastMs: 0, activeMs: 0, peakContext: 0, peakModel: "", compactions: 0 };
			sessions.set(sk, (entry = { ss, days: new Set(), spans: [], busts: [] }));
		}
		const ss = entry?.ss;
		if (ss && rec.role === "session") {
			ss.name ??= rec.name ?? rec.title;
			ss.title ??= rec.title;
			if (root) ss.project = root;
		}
		const hs = harness(rec.harness);

		for (const [key, v] of Object.entries(rec.usage)) {
			const day = key.slice(0, 10);
			if (!inRange(day)) continue;
			const [, model, thinking] = key.split("\t");
			if (!providerOk(providerOf(model))) continue;
			const tokens = tokensOf(v);
			for (let i = 0; i < U_LEN; i++) s.usage[i] += v[i];
			addRow(s.models, model, v, U_LEN);
			addRow(s.providers, providerOf(model), v, U_LEN);
			addRow(s.thinking, thinking, v, U_LEN);
			addTo(s.modelHarness, model, rec.harness);
			hs.cost += v[U.cost];
			hs.tokens += tokens;
			hs.turns += v[U.turns];
			hs.estimated += v[U.estimated];
			const d = daily.get(day)!;
			d.cost += v[U.cost];
			d.tokens += tokens;
			d.turns += v[U.turns];
			d.cacheRead += v[U.cacheRead];
			d.cacheDenom += v[U.input] + v[U.cacheRead] + v[U.cacheWrite];
			d.busts += v[U.busts];
			d.aborted += v[U.aborted];
			d.errors += v[U.errors];
			d.parts[0] += v[U.costInput];
			d.parts[1] += v[U.costOutput];
			d.parts[2] += v[U.costCacheRead];
			d.parts[3] += v[U.costCacheWrite];
			const row = [v[U.cost], tokens, v[U.turns]];
			addRow(d.byModel, model, row, 3);
			addRow(d.byHarness, rec.harness, row, 3);
			if (!archive) addRow(d.byProject, root, row, 3);
			if (ss) {
				ss.cost += v[U.cost];
				ss.turns += v[U.turns];
				ss.tokens += tokens;
				if (active(v)) entry!.days.add(day);
			}
		}

		for (const [key, v] of byProvider ? [] : Object.entries(rec.agents)) {
			const day = key.slice(0, 10);
			if (!inRange(day)) continue;
			const [, agent, model] = key.split("\t");
			const tokens = agentTokens(v);
			for (let i = 0; i < A_LEN; i++) s.agentTotal[i] += v[i];
			addRow(s.agents, agent, v, A_LEN);
			addRow(s.agentModels, model, v, A_LEN);
			addRow(s.agentPairs, `${agent}\t${model}`, v, A_LEN);
			addTo(s.agentHarness, agent, rec.harness);
			hs.agentCost += v[A.cost];
			hs.estimated += v[A.estimated];
			hs.tokens += tokens;
			const d = daily.get(day)!;
			d.agentCost += v[A.cost];
			d.agentRuns += v[A.runs];
			d.tokens += tokens;
			const row = [v[A.cost], tokens, v[A.turns]];
			addRow(d.byModel, AGENTS_SERIES, row, 3);
			addRow(d.byHarness, rec.harness, row, 3);
			addRow(d.byProject, root, row, 3);
			if (ss) {
				ss.cost += v[A.cost];
				ss.tokens += tokens;
				ss.agentRuns += v[A.runs];
				if (v[A.turns] > 0 || v[A.runs] > 0) entry!.days.add(day);
			}
		}

		for (const [key, v] of Object.entries(rec.hours)) {
			const day = key.slice(0, 10);
			if (!inRange(day)) continue;
			const [, hourText, provider] = key.split("\t");
			if (!providerOk(provider)) continue;
			const hour = Number(hourText);
			const wd = weekdayOf.get(day)!;
			s.punch[wd][hour] += v[0];
			s.hourlyCost[hour] += v[1];
			s.weekdayCost[wd] += v[1];
		}

		for (const [key, v] of Object.entries(rec.tools)) {
			const day = key.slice(0, 10);
			if (!inRange(day)) continue;
			const [, scope, provider, tool] = key.split("\t");
			if (scope === "main" ? !providerOk(provider) : byProvider) continue;
			addRow(scope === "main" ? s.tools : s.agentTools, tool, v, T_LEN);
		}
		for (const [key, n] of Object.entries(rec.bash)) {
			const [provider, word] = afterDay(key);
			if (inRange(key.slice(0, 10)) && providerOk(provider)) addNum(s.bash, word, n);
		}
		for (const [key, n] of Object.entries(rec.edits)) {
			const [provider, file] = afterDay(key);
			if (inRange(key.slice(0, 10)) && providerOk(provider)) addNum(s.edits, file, n);
		}
		for (const [key, n] of Object.entries(rec.fanout)) {
			const [provider, agents] = afterDay(key);
			if (inRange(key.slice(0, 10)) && providerOk(provider)) addNum(s.fanout, Number(agents), n);
		}
		for (const [day, v] of byProvider ? [] : Object.entries(rec.prompts)) {
			if (!inRange(day)) continue;
			s.prompts += v[0];
			s.promptChars += v[1];
			daily.get(day)!.prompts += v[0];
			hs.prompts += v[0];
		}
		for (const [key, n] of byProvider ? [] : Object.entries(rec.swears ?? {})) {
			const day = key.slice(0, 10);
			if (!inRange(day)) continue;
			addNum(s.swears, key.slice(11), n);
			daily.get(day)!.swears += n;
			hs.swears += n;
		}
		for (const [ms, before, model] of rec.compactions) {
			if (!inRange(dayKey(ms)) || !providerOk(providerOf(model))) continue;
			s.compactions++;
			s.compactionMax = Math.max(s.compactionMax, before);
			push(s.compactionTokens, model, before);
			if (ss) ss.compactions++;
		}
		for (const [key, list] of Object.entries(rec.contexts)) {
			const model = key.slice(11);
			if (!inRange(key.slice(0, 10)) || !providerOk(providerOf(model))) continue;
			for (const c of list) {
				push(s.contexts, model, c);
				if (ss && c > ss.peakContext) {
					ss.peakContext = c;
					ss.peakModel = model;
				}
			}
		}
		if (ss) {
			for (const [ms, model, context, cost, gapMs, idle] of rec.busts) {
				if (inRange(dayKey(ms)) && providerOk(providerOf(model))) entry!.busts.push({ ms, model, context, cost, gapMs, idle, session: ss });
			}
			for (const sp of rec.spans) if (sp[1] >= fromMs && sp[0] < toMs) entry!.spans.push(sp);
		}
		if (!byProvider) for (const [id, g] of Object.entries(rec.goals)) if (!goals.has(id) || goals.get(id)![2] < g[2]) goals.set(id, g);
	}

	for (const { ss, days: sessionDays, spans, busts } of sessions.values()) {
		if (ss.turns === 0 && ss.agentRuns === 0 && ss.cost === 0) continue;
		const merged = mergeSpans(spans);
		ss.firstMs = merged[0]?.[0] ?? 0;
		ss.lastMs = merged[merged.length - 1]?.[1] ?? 0;
		ss.activeMs = byProvider ? 0 : clippedMs(merged, fromMs, toMs);
		s.sessionMs += ss.activeMs;
		s.sessions.push(ss);
		s.busts.push(...busts);
		allSpans.push(...merged);
		harness(ss.harness).sessions++;
		for (const day of sessionDays) daily.get(day)!.sessions++;
		const p = project(ss.project);
		p.cost += ss.cost;
		p.turns += ss.turns;
		p.tokens += ss.tokens;
		p.sessions++;
		p.lastMs = Math.max(p.lastMs, ss.lastMs);
		p.harnesses.add(ss.harness);
		for (const d of sessionDays) p.dayset.add(d);
	}

	for (const [, g] of goals) {
		if (!inRange(dayKey(g[2]))) continue;
		s.goalsSet++;
		if (g[0] === "complete") s.goalsDone++;
		s.goalSeconds += g[1];
	}

	const union = byProvider ? [] : mergeSpans(allSpans);
	s.activeMs = clippedMs(union, fromMs, toMs);
	for (const [a, b] of union) {
		for (let t = Math.max(a, fromMs); t < Math.min(b, toMs); ) {
			const day = dayKey(t);
			const next = parseDay(addDays(day, 1)).getTime();
			const stop = Math.min(b, toMs, next);
			daily.get(day)!.activeMs += stop - t;
			t = stop;
		}
	}

	for (const c of ds.git.commits) {
		const day = dayKey(c.ms);
		if (!inRange(day) || (filter.project !== undefined && c.root !== filter.project)) continue;
		const lead = c.sessionId ? ds.leadModel.get(c.sessionId) : undefined;
		if (lead && providerOk(providerOf(lead))) addNum(s.modelCommits, lead, 1);
		if (byProvider || filter.harness !== undefined) continue;
		s.commits.push(c);
		const d = daily.get(day)!;
		d.commits++;
		const p = project(c.root);
		p.commits++;
		p.added += c.added;
		p.deleted += c.deleted;
		if (c.sessionId && ds.sessionIds.has(c.sessionId)) s.taggedCommits++;
		if (isAiCommit(ds, c)) {
			p.aiCommits++;
			d.aiCommits++;
			s.aiCommits++;
			s.aiLines += c.added + c.deleted;
		}
	}

	s.cost = s.usage[U.cost] + s.agentTotal[A.cost];
	s.tokens = tokensOf(s.usage) + agentTokens(s.agentTotal);
	s.activeDays = days.filter((d) => {
		const x = daily.get(d)!;
		return x.turns > 0 || x.tokens > 0;
	}).length;
	for (const [h, x] of s.harnesses) if (x.sessions === 0 && x.tokens === 0) s.harnesses.delete(h);
	s.sessions.sort((a, b) => b.cost - a.cost);
	s.projects = [...projects.values()]
		.filter((p) => p.root)
		.map(({ dayset, ...p }) => ({ ...p, activeDays: dayset.size }))
		.sort((a, b) => b.cost - a.cost || b.commits - a.commits);
	return s;
}

/**
 * What cache reads saved against paying the input rate for the same tokens,
 * and what cache writes cost above it, per model, from the prices each turn
 * was charged at. A model with no priced input in range has no rate and
 * contributes nothing.
 */
export function cacheSavings(models: Map<string, number[]>): { saved: number; premium: number; byModel: Map<string, number> } {
	let saved = 0;
	let premium = 0;
	const byModel = new Map<string, number>();
	for (const [model, u] of models) {
		if (u[U.input] <= 0 || u[U.costInput] <= 0) continue;
		const rate = u[U.costInput] / u[U.input];
		const sv = u[U.cacheRead] * rate - u[U.costCacheRead];
		const p = u[U.costCacheWrite] - u[U.cacheWrite] * rate;
		saved += sv;
		premium += p;
		byModel.set(model, sv - p);
	}
	return { saved, premium, byModel };
}

/** Commits a session made (Session-Id trailer) or landed while any session was active in that repo. */
export function isAiCommit(ds: Dataset, c: Commit): boolean {
	return (!!c.sessionId && ds.sessionIds.has(c.sessionId)) || insideSpans(ds.rootSpans.get(c.root), c.ms);
}
