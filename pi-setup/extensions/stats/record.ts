import path from "node:path";

/**
 * One session reduced to day-keyed buckets; any date range is a filter on the
 * key prefix. Every harness parser writes through the functions below, so a
 * bucket means the same thing whichever tool produced it.
 */

export type Harness = "pi" | "claude" | "codex" | "opencode";
export const HARNESSES: readonly Harness[] = ["pi", "claude", "codex", "opencode"];
export const HARNESS_LABEL: Record<Harness, string> = { pi: "pi", claude: "Claude Code", codex: "Codex", opencode: "OpenCode" };

export const U = {
	turns: 0,
	input: 1,
	output: 2,
	cacheRead: 3,
	cacheWrite: 4,
	reasoning: 5,
	cost: 6,
	costInput: 7,
	costOutput: 8,
	costCacheRead: 9,
	costCacheWrite: 10,
	durationMs: 11,
	timedOutput: 12,
	errors: 13,
	aborted: 14,
	busts: 15,
	bustCost: 16,
	idleBusts: 17,
	/** Cost priced from pi's model catalog because the harness recorded none. */
	estimated: 18,
	/** Turns with tokens but no recorded cost and no catalog price. */
	unpriced: 19,
} as const;
export const U_LEN = 20;

export const A = { runs: 0, cost: 1, input: 2, output: 3, cacheRead: 4, cacheWrite: 5, turns: 6, failures: 7, durationMs: 8, estimated: 9 } as const;
export const A_LEN = 10;

/** `checked`: calls whose outcome the harness recorded, the denominator of the error rate. */
export const T = { calls: 0, errors: 1, durationMs: 2, timed: 3, checked: 4 } as const;
export const T_LEN = 5;

const AGENT_TOOLS = new Set(["Task", "Agent", "task", "delegate", "chad", "oracle", "finder", "code_review", "librarian"]);

const IDLE_GAP_MS = 10 * 60_000;
const CACHE_TTL_MS = 5 * 60_000;
const CACHE_TTL_1H_MS = 60 * 60_000;
const BUST_MIN_CONTEXT = 20_000;
export const UNKNOWN_MODEL = "unknown/unknown";

interface PrevTurn {
	ms: number;
	context: number;
	model: string;
	ttlMs: number;
}

export interface ParseState {
	model?: string;
	/** Model of the latest assistant turn: the caller of the tool results that follow it. */
	lastModel?: string;
	thinking?: string;
	provider?: string;
	lastMs?: number;
	prevTurn?: PrevTurn;
	afterCompaction?: boolean;
	headerSeen?: boolean;
	/** The agent run of an agent record has been counted, and whether it has failed. */
	runCounted?: boolean;
	runFailed?: boolean;
	/** Codex: the last cumulative token totals. */
	totals?: number[];
	/** Codex: still inside a prefix replayed from another rollout. */
	replay?: boolean;
	/** Tool call id → tool name, for results that only carry the id. */
	calls?: Record<string, string>;
}

export type BustEvent = [ms: number, model: string, context: number, cacheWriteCost: number, gapMs: number, idle: boolean];
export type Compaction = [ms: number, tokensBefore: number, model: string];

/** session: a conversation · agent: a sub-agent's own transcript, all spend is agent spend · archive: day totals with no sessions. */
export type Role = "session" | "agent" | "archive";

export interface SessionRecord {
	harness: Harness;
	/** Ledger identity: stable across moves and renames of the source. */
	key: string;
	role: Role;
	/** The file or database the record was read from. */
	source: string;
	size: number;
	mtimeMs: number;
	offset: number;
	/** The session the spend belongs to; an agent record carries its parent's id. */
	id: string;
	agentName?: string;
	/** A copy of another harness's session (pi's `[opencode] …` imports); dropped when the original is on disk. */
	importOf?: Harness;
	cwd: string;
	name?: string;
	/** First line of the first prompt, for sessions that never got a name. */
	title?: string;
	startMs: number;
	/** Entries before this instant are copies of the fork's parent. */
	skipBeforeMs?: number;
	state: ParseState;
	usage: Record<string, number[]>;
	/** `day\thour\tprovider` → [turns, cost]. */
	hours: Record<string, number[]>;
	/** `day\tscope\tprovider\ttool`; agent-scope keys have no provider. */
	tools: Record<string, number[]>;
	agents: Record<string, number[]>;
	prompts: Record<string, number[]>;
	/** bash, edits and fanout are keyed `day\tprovider\tvalue`. */
	bash: Record<string, number>;
	edits: Record<string, number>;
	fanout: Record<string, number>;
	compactions: Compaction[];
	/** `day\tmodel` → context size (input + cache read + cache write) of each main turn. */
	contexts: Record<string, number[]>;
	busts: BustEvent[];
	goals: Record<string, [string, number, number]>;
	spans: Array<[number, number]>;
	/**
	 * Identities of the turns (and Claude prompts) this record counted, so another record replaying
	 * them counts nothing. A Claude value is the largest usage counted for that response so far, as
	 * CSV, because copies of one streamed response in different files can carry different counts.
	 */
	dedup: Record<string, string>;
	/** Model → signature of the catalog rates its estimates used; a changed rate re-reads the record. */
	rates: Record<string, string>;
	/** `day\tword` to swear words in the prompts typed that day, by root word. */
	swears?: Record<string, number>;
	/** Work day (4 am to 4 am) to first and last prompt: when the person was typing, as opposed to agents running. */
	awake?: Record<string, [number, number]>;
	/** The session's single most expensive reply and longest prompt. */
	peak?: { reply?: [ms: number, cost: number, model: string]; prompt?: [ms: number, chars: number, head: string] };
}

export function emptyRecord(harness: Harness, source: string, role: Role = "session"): SessionRecord {
	return {
		harness,
		key: "",
		role,
		source,
		size: 0,
		mtimeMs: 0,
		offset: 0,
		id: "",
		cwd: "",
		startMs: 0,
		state: {},
		usage: {},
		hours: {},
		tools: {},
		agents: {},
		prompts: {},
		bash: {},
		edits: {},
		fanout: {},
		compactions: [],
		contexts: {},
		busts: [],
		goals: {},
		spans: [],
		dedup: {},
		rates: {},
	};
}

export function dayKey(ms: number): string {
	const d = new Date(ms);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function num(v: unknown): number {
	const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : 0;
	return Number.isFinite(n) ? n : 0;
}

export function msOf(t: unknown): number {
	const ms = typeof t === "number" ? t : typeof t === "string" ? Date.parse(t) : NaN;
	return Number.isFinite(ms) ? ms : NaN;
}

export function bump(map: Record<string, number[]>, key: string, len: number, values: Array<[number, number]>): void {
	let row = map[key];
	if (!row) {
		row = new Array(len).fill(0);
		map[key] = row;
	}
	for (const [i, v] of values) row[i] += v;
}

function count(map: Record<string, number>, key: string): void {
	map[key] = (map[key] ?? 0) + 1;
}

export function providerOf(model: string): string {
	const slash = model.indexOf("/");
	return slash === -1 ? model : model.slice(0, slash);
}

/** A bare model id, without the provider prefix sub-agent configs carry. */
export function agentModel(model: unknown): string {
	if (typeof model !== "string" || !model) return "unknown";
	const slash = model.indexOf("/");
	return slash === -1 ? model : model.slice(slash + 1);
}

/** `provider/model`, with Anthropic's dated snapshot suffix folded into the model it snapshots. */
export function modelKey(provider: string | undefined, model: string): string {
	const id = /^claude-/.test(model) ? model.replace(/-\d{8}$/, "") : model;
	return `${provider || "unknown"}/${id}`;
}

const WRAPPERS = new Set(["sudo", "time", "env", "command", "exec", "nohup", "caffeinate", "do", "then", "else", "{", "("]);
const SKIP_SEGMENTS = new Set([
	"cd", "export", "source", "set", "pushd", "popd", "true", ":", "echo", "printf",
	"for", "while", "until", "if", "elif", "case", "done", "fi", "esac", "}", ")",
]);
const WITH_SUBCOMMAND = new Set([
	"git", "bun", "npm", "pnpm", "yarn", "npx", "bunx", "cargo", "go", "docker", "gh", "brew",
	"uv", "pip", "make", "kubectl", "wrangler", "flutter", "dart", "swift", "xcodebuild", "pi",
]);

/** "cd x && FOO=1 bun test --watch | tee" → "bun test". */
export function commandWord(cmd: string): string | undefined {
	for (const segment of cmd.split(/&&|\|\||;|\||\n/)) {
		const tokens = (segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((t) => t.replace(/^[({]+(?=.)/, "").replace(/^["']|["']$/g, ""));
		while (tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]) || WRAPPERS.has(tokens[0]))) tokens.shift();
		if (!tokens.length) continue;
		const word = path.basename(tokens[0]);
		if (!word || SKIP_SEGMENTS.has(word)) continue;
		const sub = tokens[1];
		if (WITH_SUBCOMMAND.has(word) && sub && /^[a-z][\w:.-]*$/.test(sub)) return `${word} ${sub}`;
		return word;
	}
	return undefined;
}

const SHELL_TOOLS = new Set(["bash", "Bash", "shell", "exec_command", "shell_command"]);
const EDIT_TOOLS = new Set(["edit", "write", "Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** The command a shell tool call ran, whatever shape the harness gave its arguments. */
export function shellCommand(tool: string, args: any): string | undefined {
	if (!SHELL_TOOLS.has(tool) || !args || typeof args !== "object") return undefined;
	const c = args.cmd ?? args.command;
	if (typeof c === "string") return c;
	if (Array.isArray(c)) {
		const parts = c.filter((p): p is string => typeof p === "string");
		const script = parts.findIndex((p) => p === "-lc" || p === "-c");
		return script !== -1 ? parts[script + 1] : parts.join(" ");
	}
	return undefined;
}

export function editedPaths(tool: string, args: any): string[] {
	if (tool === "apply_patch") {
		const out: string[] = [];
		const text = typeof args === "string" ? args : typeof args?.input === "string" ? args.input : typeof args?.patch === "string" ? args.patch : "";
		if (args && typeof args === "object") {
			if (typeof args.path === "string") out.push(args.path);
			if (Array.isArray(args.ops)) for (const op of args.ops) if (typeof op?.path === "string") out.push(op.path);
		}
		for (const m of text.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) out.push(m[1].trim());
		return out;
	}
	if (!args || typeof args !== "object") return [];
	if (EDIT_TOOLS.has(tool)) {
		const p = args.path ?? args.file_path ?? args.filePath ?? args.notebook_path;
		return typeof p === "string" ? [p] : [];
	}
	return [];
}

export function touch(rec: SessionRecord, ms: number): void {
	const last = rec.state.lastMs;
	const spans = rec.spans;
	const open = spans[spans.length - 1];
	if (open && last !== undefined && ms - last <= IDLE_GAP_MS && ms >= open[0]) {
		open[1] = Math.max(open[1], ms);
	} else {
		spans.push([ms, ms]);
	}
	rec.state.lastMs = Math.max(last ?? ms, ms);
}

export interface Cost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
}

export const ZERO_COST: Cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

export interface ToolCall {
	name: string;
	args: unknown;
}

/** One model response. Token buckets do not overlap; `reasoning` is the part of `output` that was thinking. */
export interface Turn {
	ms: number;
	model: string;
	thinking: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cacheWrite1h: number;
	reasoning: number;
	cost: Cost;
	/** The cost came from the catalog, not from the harness. */
	estimated: boolean;
	/** Tokens with neither a recorded cost nor a catalog price. */
	unpriced: boolean;
	durationMs: number;
	stop?: "error" | "aborted";
	calls: ToolCall[];
}

/**
 * A model response. `counted` false keeps the state current (context,
 * last model) without counting it: a fork's copied prefix. `extra` true adds
 * tokens and cost to an already counted turn: a streamed response whose
 * later copy reported more.
 */
export function addTurn(rec: SessionRecord, t: Turn, counted = true, extra = false): void {
	const st = rec.state;
	const provider = providerOf(t.model);
	const context = t.input + t.cacheRead + t.cacheWrite;
	const prev = st.prevTurn;

	const bust =
		!extra &&
		rec.role === "session" &&
		!!prev &&
		!st.afterCompaction &&
		prev.model === t.model &&
		prev.context >= BUST_MIN_CONTEXT &&
		context > 0 &&
		t.cacheWrite >= 0.5 * context &&
		t.cacheRead < 0.5 * prev.context;
	const idle = bust && t.ms - prev!.ms > prev!.ttlMs;

	if (!extra) {
		if (context > 0) st.prevTurn = { ms: t.ms, context, model: t.model, ttlMs: t.cacheWrite1h > 0 ? CACHE_TTL_1H_MS : CACHE_TTL_MS };
		st.afterCompaction = false;
		st.lastModel = t.model;
	}
	if (!counted) return;

	const day = dayKey(t.ms);
	const turns = extra ? 0 : 1;
	if (rec.role === "agent") {
		const firstRun = !st.runCounted;
		const failedNow = t.stop === "error" && !st.runFailed;
		st.runCounted = true;
		if (failedNow) st.runFailed = true;
		bump(rec.agents, `${day}\t${rec.agentName ?? "agent"}\t${agentModel(t.model)}`, A_LEN, [
			[A.runs, firstRun ? 1 : 0],
			[A.cost, t.cost.total],
			[A.input, t.input],
			[A.output, t.output],
			[A.cacheRead, t.cacheRead],
			[A.cacheWrite, t.cacheWrite],
			[A.turns, turns],
			[A.failures, failedNow ? 1 : 0],
			[A.durationMs, t.durationMs],
			[A.estimated, t.estimated ? t.cost.total : 0],
		]);
		touch(rec, t.ms);
		return;
	}

	bump(rec.usage, `${day}\t${t.model}\t${t.thinking}`, U_LEN, [
		[U.turns, turns],
		[U.input, t.input],
		[U.output, t.output],
		[U.cacheRead, t.cacheRead],
		[U.cacheWrite, t.cacheWrite],
		[U.reasoning, t.reasoning],
		[U.cost, t.cost.total],
		[U.costInput, t.cost.input],
		[U.costOutput, t.cost.output],
		[U.costCacheRead, t.cost.cacheRead],
		[U.costCacheWrite, t.cost.cacheWrite],
		[U.durationMs, t.durationMs],
		[U.timedOutput, t.durationMs > 0 ? t.output : 0],
		[U.errors, !extra && t.stop === "error" ? 1 : 0],
		[U.aborted, !extra && t.stop === "aborted" ? 1 : 0],
		[U.busts, bust ? 1 : 0],
		[U.bustCost, bust ? t.cost.cacheWrite : 0],
		[U.idleBusts, idle ? 1 : 0],
		[U.estimated, t.estimated ? t.cost.total : 0],
		[U.unpriced, !extra && t.unpriced ? 1 : 0],
	]);
	if (extra) return;
	const peak = (rec.peak ??= {});
	if (t.cost.total > (peak.reply?.[1] ?? 0)) peak.reply = [t.ms, t.cost.total, t.model];
	if (context > 0) (rec.contexts[`${day}\t${t.model}`] ??= []).push(context);
	if (bust) rec.busts.push([t.ms, t.model, context, t.cost.cacheWrite, t.ms - prev!.ms, idle]);
	bump(rec.hours, `${day}\t${new Date(t.ms).getHours()}\t${provider}`, 2, [
		[0, 1],
		[1, t.cost.total],
	]);

	const agents = countCalls(rec, day, provider, t.calls);
	if (agents > 0) count(rec.fanout, `${day}\t${provider}\t${agents}`);
	touch(rec, t.ms);
}

/** A cache keep-alive read: spend, not a turn. It renews the cache, so a rebuild after it is not idle. */
export function addCacheRead(rec: SessionRecord, t: Turn, counted = true): void {
	if (rec.state.prevTurn) rec.state.prevTurn.ms = t.ms;
	addTurn(rec, t, counted, true);
}

/** Shell commands and edited files; returns how many of the calls started a sub-agent. */
function countCalls(rec: SessionRecord, day: string, provider: string, calls: ToolCall[]): number {
	let agents = 0;
	for (const c of calls) {
		if (AGENT_TOOLS.has(c.name)) agents++;
		const cmd = shellCommand(c.name, c.args);
		const word = cmd && commandWord(cmd);
		if (word) count(rec.bash, `${day}\t${provider}\t${word}`);
		for (const p of editedPaths(c.name, c.args)) {
			count(rec.edits, `${day}\t${provider}\t${path.isAbsolute(p) || !rec.cwd ? p : path.join(rec.cwd, p)}`);
		}
	}
	return agents;
}

/**
 * Tool calls a main session logged apart from the turn's usage line. `agentsBefore` is how many
 * sub-agent calls the same response already had, so a response's swarm size lands in one bucket.
 */
export function addCalls(rec: SessionRecord, ms: number, calls: ToolCall[], agentsBefore = 0): number {
	if (rec.role !== "session" || !calls.length) return agentsBefore;
	const day = dayKey(ms);
	const provider = providerOf(rec.state.lastModel ?? rec.state.model ?? UNKNOWN_MODEL);
	const agents = agentsBefore + countCalls(rec, day, provider, calls);
	if (agents !== agentsBefore) {
		if (agentsBefore > 0) {
			const old = `${day}\t${provider}\t${agentsBefore}`;
			if ((rec.fanout[old] ?? 0) > 1) rec.fanout[old]--;
			else delete rec.fanout[old];
		}
		count(rec.fanout, `${day}\t${provider}\t${agents}`);
	}
	return agents;
}

/** Claude's `Bash` and pi's `bash` are the same tool; counted under one name. */
export const toolName = (name: string) => name.toLowerCase();

/** A finished tool call of the main session, attributed to the provider of the turn that made it. */
export function addToolResult(rec: SessionRecord, ms: number, name: string, outcome: { error?: boolean; durationMs?: number; known?: boolean }): void {
	const tool = toolName(name);
	const day = dayKey(ms);
	const dur = outcome.durationMs ?? 0;
	const known = outcome.known ?? true;
	const scope = rec.role === "agent" ? `agent\t` : `main\t${providerOf(rec.state.lastModel ?? rec.state.model ?? UNKNOWN_MODEL)}`;
	bump(rec.tools, `${day}\t${scope}\t${tool}`, T_LEN, [
		[T.calls, 1],
		[T.errors, outcome.error ? 1 : 0],
		[T.durationMs, dur],
		[T.timed, dur > 0 ? 1 : 0],
		[T.checked, known ? 1 : 0],
	]);
	touch(rec, ms);
}

/** One printable line: names and prompts come from other tools' files and end up in single-row table cells. */
export function cleanText(s: string, max = 120): string | undefined {
	const line = s
		.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|.)/g, "")
		.replace(/[\x00-\x1f\x7f-\x9f]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return line ? line.slice(0, max) : undefined;
}

/** OpenCode puts file contents into the user turn as text like this; nobody typed it. */
const TOOL_REPLAY = /^\s*Called the \S+ tool with the following input:/;

const SWEAR = /\b(motherf\w*|f+u+c+k+\w*|fk|fkin|fking|fuk\w*|bullshit\w*|shit\w*|shi|asshole\w*|dumbass\w*|jackass\w*|ass|goddamn\w*|damn\w*|dammit|hell|wtf|wth|stfu|crap\w*|bitch\w*|bastard\w*|dick(?:head)?s?|piss\w*)\b/gi;

function swearRoot(word: string): string {
	const w = word.toLowerCase();
	if (/^(motherf|f+u+c+k|fk|fuk)/.test(w)) return "fuck";
	if (/^(bull)?shi/.test(w)) return "shit";
	if (/ass/.test(w)) return "ass";
	if (/damn|dammit/.test(w)) return "damn";
	if (/^(wtf|wth|stfu)$/.test(w)) return "wtf";
	return ["crap", "bitch", "bastard", "piss", "dick"].find((root) => w.startsWith(root)) ?? w;
}

/** Pasted files, code blocks, and paths, file names and URLs: in a prompt, but not typed. */
const PASTED = /<file\b[\s\S]*?<\/file>|```[\s\S]*?```|\S*\w[./@]\w\S*/gi;

/** Swear words in what the person typed, by root, for the potty-mouth count. */
export function countSwears(text: string): Map<string, number> {
	const out = new Map<string, number>();
	for (const m of text.replace(PASTED, " ").matchAll(SWEAR)) {
		const root = swearRoot(m[1]);
		out.set(root, (out.get(root) ?? 0) + 1);
	}
	return out;
}

/** A prompt as the person typed it. */
export function addPrompt(rec: SessionRecord, ms: number, text: string): void {
	const chars = text.length;
	if (rec.role !== "session" || TOOL_REPLAY.test(text)) return;
	const day = dayKey(ms);
	bump(rec.prompts, day, 2, [
		[0, 1],
		[1, chars],
	]);
	for (const [root, n] of countSwears(text)) {
		const key = `${day}\t${root}`;
		(rec.swears ??= {})[key] = (rec.swears[key] ?? 0) + n;
	}
	rec.title ??= cleanText(text.trim().split("\n")[0] ?? "");
	const peak = (rec.peak ??= {});
	if (chars > (peak.prompt?.[1] ?? 0)) peak.prompt = [ms, chars, cleanText(text, 70) ?? ""];
	const wd = workday(ms);
	const a = (rec.awake ??= {})[wd];
	if (a) {
		a[0] = Math.min(a[0], ms);
		a[1] = Math.max(a[1], ms);
	} else rec.awake[wd] = [ms, ms];
	touch(rec, ms);
}

/** The day a moment belongs to when days run 4 am to 4 am, so 1 am is still last night. */
export function workday(ms: number): string {
	return dayKey(ms - 4 * 3_600_000);
}

export function addCompaction(rec: SessionRecord, ms: number, tokensBefore: number): void {
	rec.state.afterCompaction = true;
	if (rec.role === "session") rec.compactions.push([ms, tokensBefore, rec.state.lastModel ?? rec.state.model ?? UNKNOWN_MODEL]);
}

/** A sub-agent run reported by the parent session (pi's tool results carry the child's usage). */
export function addAgentRun(
	rec: SessionRecord,
	day: string,
	agent: string,
	model: unknown,
	u: { cost?: unknown; input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown; turns?: unknown },
	failed: boolean,
	durationMs: number,
	runs = 1,
): void {
	bump(rec.agents, `${day}\t${agent}\t${agentModel(model)}`, A_LEN, [
		[A.runs, runs],
		[A.cost, num(u.cost)],
		[A.input, num(u.input)],
		[A.output, num(u.output)],
		[A.cacheRead, num(u.cacheRead)],
		[A.cacheWrite, num(u.cacheWrite)],
		[A.turns, num(u.turns)],
		[A.failures, failed ? 1 : 0],
		[A.durationMs, durationMs],
	]);
}

export function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c) => (c?.type === "text" || c?.type === "input_text") && typeof c.text === "string")
		.map((c) => c.text)
		.join("\n");
}
