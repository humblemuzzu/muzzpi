/**
 * A pi session file as text a model can read whole. Nothing the user typed, no
 * reply the agent wrote and no sub-agent answer is ever shortened; tool calls
 * are one line each, and only tool output, file bodies and thinking are cut,
 * all to one shared length so the transcript fits the reader's budget. Every
 * piece of text is scrubbed of secrets before it is cut, so a cut can never
 * leave half a secret behind.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { injectedKind } from "./injected-prompts";
import { createSlicer, forEachLine, listSessionFiles, readSessionHeader, sessionRoots } from "./session-index";

export type Scrub = (text: string) => string;

interface Entry {
	type: string;
	id: string;
	parentId: string | null;
	timestamp?: string;
	[key: string]: any;
}

/** text that is always shown whole, or text that is cut to `weight` × the shared limit */
type Piece = { text: string } | Cut;

interface Cut {
	length: number;
	weight: number;
	/** the whole text when short enough to ever be shown whole, else its two ends */
	full?: string;
	head?: string;
	tail?: string;
}

interface Block {
	id: string;
	ts: string;
	pieces: Piece[];
	/** the text of a prompt the user typed: parts are split before these when possible */
	prompt?: string;
}

export interface Section {
	title: string;
	blocks: Block[];
}

export interface Transcript {
	sessionId: string;
	sessionName: string;
	file: string;
	header: string;
	sections: Section[];
	footer: string;
}

export interface TranscriptOptions {
	leafId?: string;
	lastTurns?: number;
	aroundEntry?: string;
}

const MAX_CUT = 12_000;
/** with `around_entry` the caller wants the exact output, so cut pieces may be this long */
const MAX_CUT_FOCUS = 60_000;
const MIN_CUT = 200;
/** the ends kept of a long piece are scrubbed with this much extra, so no secret straddles the cut */
const SCRUB_MARGIN = 16_384;
const AROUND_ENTRIES = 60;
const LIVE_MS = 2 * 60_000;
const MAX_SUB_AGENTS_LISTED = 80;

const AGENT_TOOLS = new Set(["chad", "delegate", "oracle", "finder", "librarian", "review_code"]);
const SUB_AGENT_ID = /^(chad|delegate|oracle|finder|librarian|review_code)-/;
const ANSWER_TOOLS = new Set(["read_session", "read_web_page", "web_search", "x_search"]);
const BACKGROUND_STUB = /^(?:The user moved this \w+ to the background with Ctrl\+B\. )?(\w+) (?:is running in the background|is queued behind)[^(]*\(continueId: ([\w.-]+)\)/;
const AGENT_RESULT_PREAMBLE = /^\[Automated agent event\.[^\n]*\]\n\n[^\n]*background sub-agents? finished\.[^\n]*\n\n/;
const JOB_EVENT_PREAMBLE = /^\[Automated bash-job event\.[^\n]*\]\n\n/;

// --- finding the file ---

/** the session whose header id or file-name id is exactly `sessionId`, user sessions first */
export async function findSessionFile(sessionId: string, signal?: AbortSignal, roots = sessionRoots()): Promise<string | null> {
	const id = sessionId.trim();
	if (!id) return null;
	const files = await listSessionFiles(roots);
	const named = files.find((file) => {
		const base = path.basename(file, ".jsonl");
		return base === id || base.endsWith(`_${id}`);
	});
	if (named) return named;
	const slice = createSlicer();
	for (const file of files) {
		signal?.throwIfAborted();
		if ((await readSessionHeader(file))?.id === id) return file;
		await slice();
	}
	return null;
}

// --- text helpers ---

/** a cut at `at` that does not split a surrogate pair */
function safeAt(text: string, at: number): number {
	const code = text.charCodeAt(at - 1);
	return code >= 0xd800 && code <= 0xdbff ? at - 1 : at;
}

function headOf(text: string, n: number): string {
	return n >= text.length ? text : text.slice(0, safeAt(text, n));
}

function tailOf(text: string, n: number): string {
	if (n >= text.length) return text;
	const from = text.length - n;
	const code = text.charCodeAt(from);
	return text.slice(code >= 0xdc00 && code <= 0xdfff ? from + 1 : from);
}

function clipOneLine(text: string, n: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > n ? `${headOf(flat, n)}…` : flat;
}

function count(n: number): string {
	return n.toLocaleString("en-US");
}

function cutPiece(text: string, weight: number, scrub: Scrub, maxCut: number): Cut | undefined {
	if (!text) return undefined;
	const keep = Math.ceil(maxCut * weight) + SCRUB_MARGIN;
	if (text.length <= keep * 2) {
		const full = scrub(text);
		return { length: full.length, weight, full };
	}
	return { length: text.length, weight, head: scrub(headOf(text, keep)), tail: scrub(tailOf(text, keep)) };
}

function shownLength(piece: Piece, limit: number): number {
	if ("text" in piece) return piece.text.length;
	const max = Math.floor(limit * piece.weight);
	if (piece.length <= max) return piece.length;
	return max < 40 ? 30 : max + 40;
}

function showPiece(piece: Piece, limit: number): string {
	if ("text" in piece) return piece.text;
	const max = Math.floor(limit * piece.weight);
	if (piece.length <= max && piece.full !== undefined) return piece.full;
	const cut = count(piece.length - max);
	if (max < 40) return `[${count(piece.length)} chars cut]`;
	const head = Math.ceil(max * 0.6);
	const start = piece.full ?? piece.head ?? "";
	const end = piece.full ?? piece.tail ?? "";
	return `${headOf(start, head)}\n… [${cut} chars cut] …\n${tailOf(end, max - head)}`;
}

function blockLength(block: Block, limit: number): number {
	let n = 1;
	for (const piece of block.pieces) n += shownLength(piece, limit) + 1;
	return n;
}

export function renderBlock(block: Block, limit: number): string {
	return block.pieces.map((piece) => showPiece(piece, limit)).join("\n");
}

function hasCuts(blocks: Block[]): boolean {
	return blocks.some((block) => block.pieces.some((piece) => !("text" in piece)));
}

/** the longest cut limit at which everything fits in `budget` characters, but never under MIN_CUT */
export function fitLimit(transcript: Transcript, budget: number, maxCut: number): number {
	const blocks = transcript.sections.flatMap((section) => section.blocks);
	if (!hasCuts(blocks)) return maxCut;
	const fixed = transcript.header.length + transcript.footer.length + transcript.sections.reduce((n, s) => n + s.title.length + 2, 0);
	const total = (limit: number) => blocks.reduce((n, block) => n + blockLength(block, limit), fixed);
	if (total(maxCut) <= budget) return maxCut;
	let lo = MIN_CUT;
	let hi = maxCut;
	if (total(lo) > budget) return lo;
	while (hi - lo > 50) {
		const mid = Math.floor((lo + hi) / 2);
		if (total(mid) <= budget) lo = mid;
		else hi = mid;
	}
	return lo;
}

// --- one entry as a block ---

function hhmm(ts: string | undefined): string {
	if (!ts) return "--:--";
	const d = new Date(ts);
	return Number.isNaN(d.getTime()) ? "--:--" : `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function when(ts: string | number | undefined): string {
	if (ts === undefined || ts === "") return "?";
	const iso = typeof ts === "number" ? new Date(ts).toISOString() : ts;
	return `${day(iso)} ${hhmm(iso)}`;
}

function utcOffset(): string {
	const minutes = -new Date().getTimezoneOffset();
	const sign = minutes < 0 ? "-" : "+";
	const abs = Math.abs(minutes);
	return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

function day(ts: string | undefined): string {
	if (!ts) return "";
	const d = new Date(ts);
	return Number.isNaN(d.getTime()) ? "" : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function textParts(content: unknown): { text: string; images: number } {
	if (typeof content === "string") return { text: content, images: 0 };
	if (!Array.isArray(content)) return { text: "", images: 0 };
	const texts: string[] = [];
	let images = 0;
	for (const part of content) {
		if (part?.type === "text" && typeof part.text === "string") texts.push(part.text);
		else if (part?.type === "image") images++;
	}
	return { text: texts.join("\n"), images };
}

function imageNote(n: number): string {
	return n === 1 ? "[1 image]" : `[${n} images]`;
}

const str = (value: unknown): string => (typeof value === "string" ? value : "");

function filePathOf(args: any): string {
	return str(args?.path) || str(args?.file_path) || str(args?.filePath);
}

function readRange(args: any): string {
	if (Array.isArray(args?.read_range)) return `:${args.read_range[0]}-${args.read_range[1]}`;
	if (args?.offset !== undefined || args?.limit !== undefined) return `:${args.offset ?? 1}${args.limit !== undefined ? `+${args.limit}` : ""}`;
	return "";
}

function agentPrompt(args: any): string {
	return str(args?.prompt) || str(args?.task) || str(args?.query) || str(args?.diff_description) || str(args?.instructions) || str(args?.question);
}

interface Context {
	scrub: Scrub;
	/** what a user-role prompt is: the person's own words, or a sub-agent's task from the main agent */
	userLabel: string;
	maxCut: number;
	calls: Map<string, string>;
	lastModel: string;
	goal: { objective: string; status: string };
}

function scrubDeep(value: unknown, s: Scrub): unknown {
	if (typeof value === "string") return s(value);
	if (Array.isArray(value)) return value.map((item) => scrubDeep(item, s));
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [s(key), scrubDeep(item, s)]));
	return value;
}

/** a tool call as one line, plus its file body or prompt where that is the point of the call */
function callPieces(call: any, ctx: Context): Piece[] {
	const s = ctx.scrub;
	const name = s(str(call?.name)) || "?";
	const args = call?.arguments ?? {};
	// every argument is scrubbed before it is clipped: a clip through a secret leaves a piece no scrubber knows
	const arg = (...keys: string[]) => s(keys.map((key) => str(args[key])).find(Boolean) ?? "");
	const line = (text: string): Piece => ({ text });
	switch (name) {
		case "bash": {
			const cmd = arg("cmd", "command");
			ctx.calls.set(call.id, `bash: ${clipOneLine(cmd, 80)}`);
			const body = cmd.length > 4000 ? `${headOf(cmd, 3000)}\n… [${count(cmd.length - 4000)} chars of command cut] …\n${tailOf(cmd, 1000)}` : cmd;
			return [line(`→ bash: ${body}`)];
		}
		case "edit": {
			const file = arg("path", "file_path", "filePath");
			ctx.calls.set(call.id, `edit ${file}`);
			const edits: any[] = Array.isArray(args.edits) ? args.edits : [{ oldText: args.oldText ?? args.old_string, newText: args.newText ?? args.new_string }];
			const pieces: Piece[] = [line(`→ edit ${file} (${edits.length} change${edits.length === 1 ? "" : "s"})`)];
			for (const edit of edits) {
				const removed = cutPiece(str(edit?.oldText), 0.5, s, ctx.maxCut);
				const added = cutPiece(str(edit?.newText), 1, s, ctx.maxCut);
				if (removed) pieces.push({ text: "  - old:" }, removed);
				if (added) pieces.push({ text: "  + new:" }, added);
			}
			return pieces;
		}
		case "write": {
			const file = arg("path", "file_path", "filePath");
			const content = str(args.content);
			ctx.calls.set(call.id, `write ${file}`);
			const body = cutPiece(content, 1, s, ctx.maxCut);
			return [line(`→ write ${file} (${count(content.split("\n").length)} lines)`), ...(body ? [body] : [])];
		}
		case "read": {
			const file = arg("path", "file_path", "filePath");
			ctx.calls.set(call.id, `read ${file}`);
			return [line(`→ read ${file}${readRange(args)}`)];
		}
		case "grep": {
			const pattern = arg("pattern");
			ctx.calls.set(call.id, `grep ${clipOneLine(pattern, 60)}`);
			return [line(`→ grep ${JSON.stringify(pattern)} in ${arg("path") || "."}${args.glob ? ` (${arg("glob")})` : ""}`)];
		}
		case "find":
		case "glob": {
			const pattern = arg("pattern", "filePattern");
			ctx.calls.set(call.id, `find ${pattern}`);
			return [line(`→ find ${pattern} in ${arg("path") || "."}`)];
		}
		case "codemode": {
			const code = str(args.code);
			ctx.calls.set(call.id, "codemode");
			return [line("→ codemode script:"), cutPiece(code, 1, s, ctx.maxCut) ?? { text: "" }];
		}
		default: {
			if (AGENT_TOOLS.has(name)) {
				const prompt = s(agentPrompt(args));
				const extras = Object.entries(args)
					.filter(([key, value]) => value !== undefined && typeof value !== "object" && !["prompt", "task", "query", "diff_description", "instructions", "question"].includes(key))
					.map(([key, value]) => `${s(key)}: ${clipOneLine(s(String(value)), 200)}`);
				ctx.calls.set(call.id, `${name}${args.continueId ? ` ${arg("continueId")}` : ""}`);
				const head = `→ ${name}${extras.length ? ` (${extras.join(", ")})` : ""}${prompt ? " — prompt:" : ""}`;
				return prompt ? [line(head), line(prompt.length > 20_000 ? `${headOf(prompt, 20_000)}\n… [${count(prompt.length - 20_000)} chars of prompt cut]` : prompt)] : [line(head)];
			}
			const json = JSON.stringify(scrubDeep(args, s)) ?? "";
			ctx.calls.set(call.id, `${name} ${clipOneLine(json, 80)}`);
			return [line(`→ ${name} ${json.length > 1500 ? `${headOf(json, 1500)}…` : json}`)];
		}
	}
}

function block(entry: Entry, label: string, pieces: Piece[], prompt?: string): Block {
	return { id: entry.id, ts: entry.timestamp ?? "", pieces: [{ text: `[${entry.id} ${hhmm(entry.timestamp)}] ${label}` }, ...pieces], prompt };
}

function messageBlock(entry: Entry, ctx: Context): Block | undefined {
	const message = entry.message;
	const role = message?.role;
	const s = ctx.scrub;
	if (role === "user") {
		const { text, images } = textParts(message.content);
		const kind = injectedKind(text.trimStart());
		if (kind === "goal") return block(entry, "GOAL CONTINUATION (sent by the goal extension, not typed by the user)", []);
		if (kind === "ysk") return block(entry, "SIDE-AGENT NOTE (sent by /ysk, not typed by the user)", [{ text: s(text) }]);
		const typed = s(text);
		const pieces: Piece[] = typed ? [{ text: typed }] : [];
		if (images) pieces.push({ text: imageNote(images) });
		return block(entry, ctx.userLabel, pieces, typed || imageNote(images));
	}
	if (role === "assistant") {
		const model = message.provider && message.model ? `${message.provider}/${message.model}` : str(message.model);
		const label = model && model !== ctx.lastModel ? `ASSISTANT (${model})` : "ASSISTANT";
		if (model) ctx.lastModel = model;
		const pieces: Piece[] = [];
		for (const part of Array.isArray(message.content) ? message.content : []) {
			if (part?.type === "text" && part.text) pieces.push({ text: s(part.text) });
			else if (part?.type === "thinking" && part.thinking) {
				const thought = cutPiece(part.thinking, 0.5, s, ctx.maxCut);
				if (thought) pieces.push({ text: "(thinking)" }, thought);
			} else if (part?.type === "toolCall") pieces.push(...callPieces(part, ctx));
		}
		if (message.stopReason === "error") pieces.push({ text: `[reply failed: ${clipOneLine(s(str(message.errorMessage)) || "error", 400)}]` });
		else if (message.stopReason === "aborted") pieces.push({ text: "[reply stopped before it finished]" });
		return pieces.length ? block(entry, label, pieces) : undefined;
	}
	if (role === "toolResult") {
		const tool = s(str(message.toolName)) || "?";
		const { text, images } = textParts(message.content);
		const status = message.isError ? " ERROR" : "";
		const target = ctx.calls.get(str(message.toolCallId)) ?? tool;
		if (AGENT_TOOLS.has(tool)) {
			const stub = BACKGROUND_STUB.exec(text);
			if (stub) return block(entry, `← ${tool} started in the background (continueId: ${stub[2]}); its answer arrives later as SUB-AGENT RESULTS`, []);
			const task = s(str(message.details?.task));
			return block(entry, `SUB-AGENT ANSWER from ${target}${task ? ` — ${clipOneLine(task, 160)}` : ""}${status}`, [{ text: s(text) }]);
		}
		if (tool === "agents") return block(entry, `← agents${status}`, [{ text: s(text) }]);
		const pieces: Piece[] = [];
		const body = cutPiece(text, message.isError ? 2 : ANSWER_TOOLS.has(tool) ? 2 : 1, s, ctx.maxCut);
		if (body) pieces.push(body);
		if (images) pieces.push({ text: imageNote(images) });
		return block(entry, `← ${target}${status}`, pieces);
	}
	if (role === "system" || !role) return undefined;
	const { text } = textParts(message.content);
	const body = cutPiece(text || JSON.stringify(message), 1, s, ctx.maxCut);
	return block(entry, `${s(String(role)).toUpperCase()} MESSAGE`, body ? [body] : []);
}

function entryBlock(entry: Entry, ctx: Context): Block | undefined {
	const s = ctx.scrub;
	switch (entry.type) {
		case "message":
			return messageBlock(entry, ctx);
		case "custom_message": {
			const { text } = textParts(entry.content);
			if (entry.customType === "agent-result") return block(entry, "SUB-AGENT RESULTS ARRIVED", [{ text: s(text.replace(AGENT_RESULT_PREAMBLE, "")) }]);
			if (entry.customType === "bash-job") {
				const body = cutPiece(text.replace(JOB_EVENT_PREAMBLE, ""), 1, s, ctx.maxCut);
				return block(entry, "BACKGROUND BASH JOB REPORTED (automated, not typed by the user)", body ? [body] : []);
			}
			if (entry.customType === "pi-codex-goal") return block(entry, "GOAL CONTINUATION (sent by the goal extension, not typed by the user)", []);
			if (entry.customType === "agent-message") return block(entry, "MESSAGE FROM ANOTHER SESSION", [{ text: s(text) }]);
			const body = cutPiece(text, 1, s, ctx.maxCut);
			return block(entry, `EXTENSION MESSAGE (${s(str(entry.customType)) || "?"})`, body ? [body] : []);
		}
		case "custom": {
			if (entry.customType !== "pi-codex-goal" || entry.data?.kind !== "set") return undefined;
			const goal = entry.data.goal ?? {};
			const objective = str(goal.objective);
			const status = str(goal.status);
			if (objective && objective !== ctx.goal.objective) {
				ctx.goal = { objective, status };
				return block(entry, `GOAL SET (${s(status) || "?"})${goal.tokenBudget ? `, token budget ${count(Number(goal.tokenBudget) || 0)}` : ""}`, [{ text: s(objective) }]);
			}
			if (status && status !== ctx.goal.status) {
				ctx.goal.status = status;
				return block(entry, `GOAL STATUS → ${s(status)}${goal.reason ? `: ${clipOneLine(s(str(goal.reason)), 300)}` : ""}`, []);
			}
			return undefined;
		}
		case "compaction":
			return block(entry, `COMPACTION (${count(Number(entry.tokensBefore) || 0)} tokens summarized; from here the agent saw this summary instead of the earlier messages, which are still shown above)`, [{ text: s(str(entry.summary)) }]);
		case "branch_summary":
			return block(entry, `BRANCH SUMMARY (of the path left at ${str(entry.fromId)})`, [{ text: s(str(entry.summary)) }]);
		case "label":
			return entry.label ? block(entry, `LABEL "${s(str(entry.label))}" on [${str(entry.targetId)}]`, []) : undefined;
		case "session_info":
			return entry.name ? block(entry, `SESSION NAMED "${s(str(entry.name))}"`, []) : undefined;
		case "model_change":
			return block(entry, s(`model set to ${str(entry.provider)}/${str(entry.modelId)}`), []);
		case "thinking_level_change":
			return block(entry, s(`thinking level set to ${str(entry.thinkingLevel)}`), []);
		default:
			return undefined;
	}
}

// --- the tree ---

interface Tree {
	header: any;
	name: string;
	entries: Entry[];
	byId: Map<string, Entry>;
	children: Map<string, Entry[]>;
	order: Map<string, number>;
}

async function readTree(file: string, signal?: AbortSignal): Promise<Tree> {
	const entries: Entry[] = [];
	let header: any = null;
	let name = "";
	const slice = createSlicer();
	await forEachLine(file, async (line) => {
		await slice();
		let entry: any;
		try {
			entry = JSON.parse(line.toString("utf8"));
		} catch {
			return;
		}
		if (!entry || typeof entry !== "object") return;
		if (entry.type === "session") header = entry;
		else if (entry.type === "session_info" && typeof entry.name === "string") name = entry.name;
		if (typeof entry.id !== "string" || entry.type === "session") return;
		for (const part of Array.isArray(entry.message?.content) ? entry.message.content : []) if (part?.type === "image") part.data = "";
		entries.push(entry);
	}, signal);
	const byId = new Map<string, Entry>();
	const children = new Map<string, Entry[]>();
	const order = new Map<string, number>();
	entries.forEach((entry, i) => {
		byId.set(entry.id, entry);
		order.set(entry.id, i);
	});
	for (const entry of entries) {
		if (!entry.parentId || !byId.has(entry.parentId)) continue;
		const kids = children.get(entry.parentId) ?? [];
		kids.push(entry);
		children.set(entry.parentId, kids);
	}
	return { header, name, entries, byId, children, order };
}

/** root → entry; a corrupt file whose parents loop stops at the first repeat */
function pathTo(tree: Tree, id: string): Entry[] {
	const out: Entry[] = [];
	const seen = new Set<string>();
	for (let at = tree.byId.get(id); at && !seen.has(at.id); at = at.parentId ? tree.byId.get(at.parentId) : undefined) {
		seen.add(at.id);
		out.push(at);
	}
	return out.reverse();
}

/** the path continued below `id` through each newest child, so a branch reads to its end */
function pathThrough(tree: Tree, id: string): Entry[] {
	const out = pathTo(tree, id);
	const seen = new Set(out.map((entry) => entry.id));
	for (let kids = tree.children.get(id); kids?.length; ) {
		const next = kids[kids.length - 1]!;
		if (seen.has(next.id)) break;
		seen.add(next.id);
		out.push(next);
		kids = tree.children.get(next.id);
	}
	return out;
}

/** an entry that adds something a reader sees; a branch of only bookkeeping entries is left out */
function readable(entry: Entry): boolean {
	if (entry.type === "message") return entry.message?.role !== "system";
	return ["custom_message", "compaction", "branch_summary", "label"].includes(entry.type);
}

interface Abandoned {
	forkId: string | null;
	entries: Entry[];
}

/** every branch off `main`, as the part below where it left the main path or an earlier branch */
function abandonedBranches(tree: Tree, main: Entry[]): Abandoned[] {
	const claimed = new Set(main.map((entry) => entry.id));
	const out: Abandoned[] = [];
	for (const leaf of tree.entries) {
		if (claimed.has(leaf.id) || tree.children.has(leaf.id)) continue;
		const segment: Entry[] = [];
		let at: Entry | undefined = leaf;
		while (at && !claimed.has(at.id)) {
			claimed.add(at.id);
			segment.push(at);
			at = at.parentId ? tree.byId.get(at.parentId) : undefined;
		}
		out.push({ forkId: at?.id ?? null, entries: segment.reverse() });
	}
	return out.sort((a, b) => (tree.order.get(a.entries[0]!.id) ?? 0) - (tree.order.get(b.entries[0]!.id) ?? 0));
}

// --- header and footer ---

function promptIndex(sections: Section[], by: string): string[] {
	const lines: string[] = [];
	for (const section of sections) {
		const where = section.title.startsWith("Abandoned") ? ` (${section.title.split(" (")[0]!.toLowerCase()})` : "";
		for (const b of section.blocks) if (b.prompt !== undefined) lines.push(`- [${b.id} ${day(b.ts)} ${hhmm(b.ts)}]${where} ${clipOneLine(b.prompt, 200)}`);
	}
	return lines.length ? [`${by} (${lines.length}; each is shown in full in the transcript):`, ...lines] : [`${by}: none in what is shown`];
}

function describeHeader(tree: Tree, file: string, mainCount: number, branches: number, scope: string, scrub: Scrub, sections: Section[], agent?: string): string {
	const h = tree.header ?? {};
	const toolCounts = new Map<string, number>();
	const changed = new Set<string>();
	const models = new Set<string>();
	let prompts = 0;
	let replies = 0;
	let errors = 0;
	let compactions = 0;
	const runs = new Map<string, any>();
	for (const entry of tree.entries) {
		const message = entry.message;
		if (entry.type === "compaction") compactions++;
		if (entry.type === "custom" && entry.customType === "agent-run" && entry.data?.continueId) runs.set(entry.data.continueId, entry.data);
		if (entry.type !== "message" || !message) continue;
		if (message.role === "user" && !injectedKind(textParts(message.content).text.trimStart())) prompts++;
		if (message.role === "toolResult" && message.isError) errors++;
		if (message.role !== "assistant") continue;
		replies++;
		if (message.provider && message.model) models.add(`${message.provider}/${message.model}`);
		for (const part of Array.isArray(message.content) ? message.content : []) {
			if (part?.type !== "toolCall") continue;
			toolCounts.set(part.name, (toolCounts.get(part.name) ?? 0) + 1);
			if ((part.name === "edit" || part.name === "write") && filePathOf(part.arguments)) changed.add(filePathOf(part.arguments));
		}
	}
	const tools = [...toolCounts].sort((a, b) => b[1] - a[1]).map(([name, n]) => `${name} ${n}`);
	const lines = [
		`==== SESSION ${tree.name ? `"${scrub(tree.name)}"` : h.id ?? ""} ====`,
		`id: ${h.id ?? "?"}`,
		...(agent
			? [`kind: the own session of a ${agent} sub-agent. Its TASK FROM THE MAIN AGENT entries are the task and follow-ups the main agent sent it, not prompts a person typed.`]
			: []),
		`file: ${file}`,
		`workspace: ${h.cwd ?? "?"}`,
		...(h.parentSession ? [`forked from: ${h.parentSession}`] : []),
		`started: ${when(h.timestamp)} (every time in this transcript is local time, ${utcOffset()})`,
		`models: ${[...models].join(", ") || "none"}`,
		`${agent ? "tasks from the main agent" : "user prompts"}: ${prompts} · assistant replies: ${replies} · tool calls: ${[...toolCounts.values()].reduce((a, b) => a + b, 0)} (${tools.join(", ") || "none"}) · failed tool calls: ${errors} · compactions: ${compactions}`,
		`main branch: ${count(mainCount)} entries · abandoned branches: ${branches}`,
		`shown: ${scope}`,
	];
	if (changed.size) lines.push(`files changed with edit/write (${changed.size}): ${[...changed].join(", ")}`);
	if (runs.size) {
		const list = [...runs.values()].slice(-MAX_SUB_AGENTS_LISTED).map((run) => {
			const took = Number(run.durationMs) ? ` ${Math.round(Number(run.durationMs) / 1000)}s` : "";
			return `- ${run.continueId} (${run.agent}, ${run.status ?? "?"}${took}${run.model ? `, ${run.model}` : ""}): ${clipOneLine(scrub(str(run.label)), 140)}`;
		});
		const more = runs.size > MAX_SUB_AGENTS_LISTED ? [`- … and ${runs.size - MAX_SUB_AGENTS_LISTED} earlier ones`] : [];
		lines.push(`background sub-agent runs (${runs.size}; each id is a session read_session can open):`, ...more, ...list);
	}
	lines.push(...promptIndex(sections, agent ? "tasks the main agent sent" : "prompts the user typed"));
	return scrub(lines.join("\n"));
}

function describeFooter(tree: Tree, mtimeMs: number, now: number): string {
	const last = tree.entries.at(-1);
	const live = now - mtimeMs < LIVE_MS;
	return [
		"==== END OF SESSION ====",
		`last entry: ${last ? `[${last.id}] ${when(last.timestamp)}` : "none"}`,
		`file last written: ${when(mtimeMs)}${live ? " — less than 2 minutes ago, so the session is probably still running" : ""}`,
	].join("\n");
}

// --- building ---

async function blocksOf(entries: Entry[], ctx: Context, forks: Map<string, number[]>, slice: () => Promise<void>, signal?: AbortSignal): Promise<Block[]> {
	const out: Block[] = [];
	let lastDay = "";
	for (const entry of entries) {
		signal?.throwIfAborted();
		await slice();
		const d = day(entry.timestamp);
		const made = entryBlock(entry, ctx);
		if (made) {
			if (d && d !== lastDay) {
				made.pieces.unshift({ text: `--- ${d} ---` });
				lastDay = d;
			}
			out.push(made);
		}
		const branches = forks.get(entry.id);
		if (branches?.length) {
			const note = `↳ ${branches.map((n) => `abandoned branch ${n}`).join(", ")} forks off here (shown after the main branch)`;
			if (made) made.pieces.push({ text: note });
			else out.push({ id: entry.id, ts: entry.timestamp ?? "", pieces: [{ text: note }] });
		}
	}
	return out;
}

export async function buildTranscript(file: string, scrub: Scrub, options: TranscriptOptions = {}, signal?: AbortSignal): Promise<Transcript> {
	const tree = await readTree(file, signal);
	const stat = await fs.stat(file);
	const maxCut = options.aroundEntry ? MAX_CUT_FOCUS : MAX_CUT;
	const agent = SUB_AGENT_ID.exec(String(tree.header?.id ?? path.basename(file)))?.[1];
	const userLabel = agent ? "TASK FROM THE MAIN AGENT" : "USER";
	const newCtx = (): Context => ({ scrub, userLabel, maxCut, calls: new Map(), lastModel: "", goal: { objective: "", status: "" } });
	const slice = createSlicer();

	if (options.leafId && !tree.byId.has(options.leafId)) throw new Error(`leaf_id ${options.leafId} is not an entry of this session`);
	if (options.aroundEntry && !tree.byId.has(options.aroundEntry)) throw new Error(`around_entry ${options.aroundEntry} is not an entry of this session`);

	const leaf = options.leafId ?? tree.entries.at(-1)?.id;
	const main = leaf ? pathTo(tree, leaf) : [];
	const sections: Section[] = [];
	let scope: string;
	let branchCount = 0;

	if (options.aroundEntry) {
		const along = pathThrough(tree, options.aroundEntry);
		const at = along.findIndex((entry) => entry.id === options.aroundEntry);
		const from = Math.max(0, at - AROUND_ENTRIES);
		const window = along.slice(from, at + AROUND_ENTRIES + 1);
		scope = `${window.length} entries around [${options.aroundEntry}] on its branch, tool output up to ${count(MAX_CUT_FOCUS)} chars each`;
		sections.push({ title: `Entries around [${options.aroundEntry}]`, blocks: await blocksOf(window, newCtx(), new Map(), slice, signal) });
	} else if (options.lastTurns) {
		const ctx = newCtx();
		const all = await blocksOf(main, ctx, new Map(), slice, signal);
		let prompts = 0;
		let start = 0;
		for (let i = all.length - 1; i >= 0; i--) {
			if (all[i]!.prompt !== undefined && ++prompts === options.lastTurns) {
				start = i;
				break;
			}
		}
		const shown = all.slice(start);
		scope = `the last ${options.lastTurns} user prompt${options.lastTurns === 1 ? "" : "s"} of the main branch and everything after${start > 0 ? `; ${count(start)} earlier entries left out` : " (that is the whole branch)"}`;
		sections.push({ title: "Main branch (latest part)", blocks: shown });
	} else {
		const branches = abandonedBranches(tree, main).filter((branch) => branch.entries.some(readable));
		branchCount = branches.length;
		const forks = new Map<string, number[]>();
		branches.forEach((branch, i) => {
			if (!branch.forkId) return;
			forks.set(branch.forkId, [...(forks.get(branch.forkId) ?? []), i + 1]);
		});
		const mainBlocks = await blocksOf(main, newCtx(), forks, slice, signal);
		sections.push({ title: leaf === tree.entries.at(-1)?.id ? "Main branch (the path to the latest entry)" : `Target branch (the path to [${leaf}])`, blocks: mainBlocks });
		for (const [i, branch] of branches.entries()) {
			const first = branch.entries[0]!;
			const lastEntry = branch.entries.at(-1)!;
			const from = branch.forkId ? `forks after [${branch.forkId}]` : "has no parent in this file";
			sections.push({
				title: `Abandoned branch ${i + 1} (${from}; ${branch.entries.length} entries, [${first.id}] ${hhmm(first.timestamp)} → [${lastEntry.id}] ${hhmm(lastEntry.timestamp)})`,
				blocks: await blocksOf(branch.entries, newCtx(), forks, slice, signal),
			});
		}
		scope = "the whole session: every branch";
	}

	return {
		sessionId: tree.header?.id ?? "",
		sessionName: scrub(tree.name),
		file,
		header: describeHeader(tree, file, main.length, branchCount, scope, scrub, sections, agent),
		sections,
		footer: describeFooter(tree, stat.mtimeMs, Date.now()),
	};
}

// --- splitting into parts ---

export interface Part {
	text: string;
	first: string;
	last: string;
}

function sectionText(section: Section, blocks: Block[], limit: number): string {
	return [`==== ${section.title} ====`, ...blocks.map((b) => renderBlock(b, limit))].join("\n\n");
}

/** the whole transcript as one text at the given cut limit */
export function renderTranscript(transcript: Transcript, limit: number): string {
	return [transcript.header, ...transcript.sections.map((section) => sectionText(section, section.blocks, limit)), transcript.footer].join("\n\n");
}

/**
 * The transcript in parts of at most `budget` characters, each led by the
 * header. A part ends before a user prompt when one falls in its second half;
 * a block longer than a part goes alone.
 */
export function splitTranscript(transcript: Transcript, limit: number, budget: number): Part[] {
	const room = Math.max(10_000, budget - transcript.header.length - transcript.footer.length - 2_000);
	const flat = transcript.sections.flatMap((section) => section.blocks.map((block) => ({ section, block, size: blockLength(block, limit) + 2 })));
	const groups: Array<typeof flat> = [];
	let current: typeof flat = [];
	let size = 0;
	for (const item of flat) {
		if (current.length && size + item.size > room) {
			let cut = current.length;
			for (let i = current.length - 1; i > current.length / 2; i--) {
				if (current[i]!.block.prompt !== undefined) {
					cut = i;
					break;
				}
			}
			groups.push(current.slice(0, cut));
			current = current.slice(cut);
			size = current.reduce((n, c) => n + c.size, 0);
		}
		current.push(item);
		size += item.size;
	}
	if (current.length) groups.push(current);
	return groups.map((group, i) => {
		const bySection: Array<{ section: Section; blocks: Block[] }> = [];
		for (const { section, block } of group) {
			const tail = bySection.at(-1);
			if (tail?.section === section) tail.blocks.push(block);
			else bySection.push({ section, blocks: [block] });
		}
		const body = bySection.map(({ section, blocks }) => sectionText(section, blocks, limit));
		const first = group[0]!.block;
		const last = group.at(-1)!.block;
		return {
			text: [transcript.header, ...body, i === groups.length - 1 ? transcript.footer : "==== (the session continues in the next part) ===="].join("\n\n"),
			first: `[${first.id}] ${when(first.ts)}`,
			last: `[${last.id}] ${when(last.ts)}`,
		};
	});
}
