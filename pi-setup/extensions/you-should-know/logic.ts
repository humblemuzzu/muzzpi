/**
 * Pure half of you-should-know: the cadence numbers, the reply parser, and the
 * sub-agent evidence extractor.
 *
 * No pi imports and no I/O, so `bun test logic.test.ts` runs instantly and the
 * parts that must never regress are testable in isolation.
 */

/** model responses between checks, counted across prompts rather than within one run */
export const CHECK_EVERY_TURNS = 6;
/** user prompts a note can survive before it starts counting against us */
export const FREE_IGNORES = 2;
/** hard ceiling on the ignore backoff, in skipped checks */
export const MAX_SKIP = 16;
/** notes visible at once; the oldest is dropped past this */
export const MAX_NOTES = 5;
/** dedup memory, in entries */
export const HISTORY_MAX = 50;
/** sub-agent reports inlined per check — the newest, and only the newest */
export const SUB_AGENT_REPORTS = 3;
/** how many of a child's tool calls get listed before the rest are dropped */
const SUB_AGENT_TOOL_SAMPLE = 14;
export const REQUEST_TIMEOUT_MS = 120_000;

const TAG_HEADS_UP = "Heads up";
const TAG_YOU_SHOULD_KNOW = "You should know";

/** tools whose sub-agent use means a file actually changed */
const EDIT_TOOLS = new Set(["edit", "write", "notebook_edit"]);
const ARG_HINTS = ["path", "file", "filePattern", "pattern", "query", "cmd", "command"];

export interface State {
	enabled: boolean;
	/** learn lines already offered; never offered twice */
	seen: string[];
	/** learn lines the user said they knew; also never offered again */
	known: string[];
	ignoredInARow: number;
	skip: number;
	checks: number;
	shown: number;
}

export interface Note {
	line: string;
	tag: string;
	evidence?: string;
	explain?: string;
	/** user prompts this note has survived unanswered */
	waited: number;
	counted: boolean;
}

export interface SubAgentReport {
	agent: string;
	task: string;
	exitCode?: number;
	edits: string[];
	calls: string[];
	final: string;
}

export interface ParsedNote {
	line: string;
	tag: string;
	evidence?: string;
	explain?: string;
}

export function emptyState(): State {
	// Off until asked for. This spends real money on a schedule, and anyone who
	// clones the setup should have to opt in rather than discover the bill.
	return { enabled: false, seen: [], known: [], ignoredInARow: 0, skip: 0, checks: 0, shown: 0 };
}

function asRecord(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/**
 * A widget row is ONE terminal line. Newlines and control characters are
 * width-0 to every width check and still move the cursor, which is the screen
 * smear this extension must never cause. Labels keep \x1b so colors survive.
 */
export function flatten(text: string): string {
	return text
		.replace(/[\r\n\t\v\f]+/g, " ")
		.replace(/[\x00-\x08\x0e-\x1a\x1c-\x1f\x7f]+/g, "")
		.replace(/ {2,}/g, " ")
		.trim();
}

function clip(text: string, max: number): string {
	const flat = flatten(text);
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function normalizeLine(text: string): string {
	return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Two free ignores, then a doubling skip capped at 16. */
export function nextSkip(ignoredInARow: number): number {
	return ignoredInARow <= FREE_IGNORES ? 0 : Math.min(MAX_SKIP, 2 ** (ignoredInARow - FREE_IGNORES - 1));
}

export function pushCapped(list: string[], value: string): void {
	list.push(value);
	while (list.length > HISTORY_MAX) list.shift();
}

/**
 * Finds the first line carrying a `learn:` label, tolerating the markdown and
 * quoting the model sometimes wraps it in. Returns null when the reply carried
 * no such line at all, which is a different outcome from `learn: none`.
 */
export function parseNote(text: string): ParsedNote | "none" | null {
	const lines = text.split("\n");
	let line: string | undefined;
	let tag: string | undefined;
	let evidence: string | undefined;
	let explainAt = -1;

	for (let index = 0; index < lines.length; index++) {
		const raw = (lines[index] ?? "").replace(/^[\s>*_`"'\u201c\u201d\u2018\u2019-]+/, "").trim();
		const lower = raw.toLowerCase();
		if (line === undefined && lower.startsWith("learn:")) {
			line = raw.slice(raw.indexOf(":") + 1).trim();
		} else if (tag === undefined && lower.startsWith("tag:")) {
			tag = raw.slice(raw.indexOf(":") + 1).replace(/[*_`"']/g, "").trim();
		} else if (evidence === undefined && lower.startsWith("evidence:")) {
			evidence = raw.slice(raw.indexOf(":") + 1).trim();
		} else if (explainAt === -1 && lower.startsWith("explain:")) {
			explainAt = index;
		}
	}

	if (line === undefined) return null;
	// One pass, with whitespace in the class: stripping `**` off `** "text"`
	// first would leave the quote behind for the trim to uncover.
	const cleaned = line.replace(/^[\s"'`*_]+|[\s"'`*_]+$/g, "");
	if (!cleaned || /^none[\s.!?]*$/i.test(cleaned) || cleaned.length < 8) return "none";

	let explain: string | undefined;
	if (explainAt !== -1) {
		const current = lines[explainAt] ?? "";
		const body = [current.slice(current.indexOf(":") + 1), ...lines.slice(explainAt + 1)].join("\n").trim();
		if (body) explain = body;
	}

	return {
		line: clip(cleaned, 300),
		tag: /heads[\s-]*up/i.test(tag ?? "") ? TAG_HEADS_UP : TAG_YOU_SHOULD_KNOW,
		evidence: evidence && !/^none/i.test(evidence) ? clip(evidence, 200) : undefined,
		explain,
	};
}

export function describeCall(name: string, args: unknown): string {
	const record = asRecord(args);
	for (const key of ARG_HINTS) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) {
			// First line only: a bash `cmd` is often a whole script, and the first
			// line is the part worth showing in a one-line report.
			return `${name}(${clip(value.trim().split("\n")[0], 56)})`;
		}
	}
	return name;
}

export function editPaths(name: string, args: unknown): string[] {
	if (!EDIT_TOOLS.has(name)) return [];
	const record = asRecord(args);
	const direct = record.path ?? record.file_path ?? record.file;
	return typeof direct === "string" && direct.trim() ? [clip(direct, 80)] : [];
}

export function textOf(message: unknown): string {
	const content = asRecord(message).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => asRecord(block))
		.filter((block) => block.type === "text")
		.map((block) => (typeof block.text === "string" ? block.text : ""))
		.join("\n")
		.trim();
}

/**
 * A sub-agent hands its parent a summary, and that summary is a claim. The
 * child's own tool calls are the evidence, and they ride along in the tool
 * result's `details`, so both are available without touching the disk.
 */
export function collectSubAgentReports(entries: readonly unknown[], limit: number): SubAgentReport[] {
	const reports: SubAgentReport[] = [];
	for (const entry of entries) {
		const message = asRecord(asRecord(entry).message);
		if (message.role !== "toolResult") continue;
		const details = asRecord(message.details);
		const agent = details.agent;
		const messages = details.messages;
		if (typeof agent !== "string" || !Array.isArray(messages)) continue;

		const edits = new Set<string>();
		const calls: string[] = [];
		let final = "";
		for (const raw of messages) {
			const child = asRecord(raw);
			if (child.role !== "assistant") continue;
			if (Array.isArray(child.content)) {
				for (const block of child.content) {
					const item = asRecord(block);
					if (item.type !== "toolCall") continue;
					const name = typeof item.name === "string" ? item.name : "tool";
					for (const path of editPaths(name, item.arguments)) edits.add(path);
					if (calls.length < SUB_AGENT_TOOL_SAMPLE) calls.push(describeCall(name, item.arguments));
				}
			}
			const text = textOf(raw);
			if (text) final = text;
		}

		reports.push({
			agent,
			task: typeof details.task === "string" ? details.task : "(no task recorded)",
			exitCode: typeof details.exitCode === "number" ? details.exitCode : undefined,
			edits: [...edits],
			calls,
			final,
		});
	}
	return reports.slice(-limit);
}

export function renderSubAgents(reports: SubAgentReport[]): string {
	if (reports.length === 0) return "";
	const blocks = reports.map((report) => {
		const lines = [
			`### sub-agent "${report.agent}" — task: ${clip(report.task, 160)}`,
			report.exitCode === undefined ? "" : `exit code: ${report.exitCode}`,
			report.edits.length > 0 ? `files it edited: ${report.edits.join(", ")}` : "files it edited: none",
			report.calls.length > 0 ? `tool calls, in order: ${report.calls.join(" → ")}` : "tool calls: none",
			report.final ? `its own final answer (a claim, not evidence):\n${clip(report.final, 700)}` : "",
		];
		return lines.filter(Boolean).join("\n");
	});
	return [
		"",
		"## What the sub-agents actually did",
		"",
		"The block below is not part of the conversation above. It is evidence pulled",
		"from each sub-agent's own tool calls, and it is where a sub-agent's claim can",
		"be checked against what it really did. A sub-agent's summary is not proof of",
		"anything; its tool calls are.",
		"",
		blocks.join("\n\n"),
		"",
	].join("\n");
}

export function renderPrompt(template: string, state: State, reports: SubAgentReport[]): string {
	const block = renderSubAgents(reports);
	return template
		.replace("{{SEEN}}", state.seen.length > 0 ? state.seen.map((s) => `- ${s}`).join("\n") : "- (none yet)")
		.replace("{{KNOWN}}", state.known.length > 0 ? state.known.map((s) => `- ${s}`).join("\n") : "- (none yet)")
		.replace("{{SUBAGENTS}}", block);
}
