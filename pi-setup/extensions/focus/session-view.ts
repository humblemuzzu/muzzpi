/**
 * The session as focus mode shows it: every prompt with the work and answer
 * that followed it, across every /tree branch and every compaction. pi keeps
 * all of that in memory (`getEntries()`), it only stops drawing it, so this
 * builds an index of references into pi's own entries and copies nothing.
 */

import type { SessionEntry } from "@mariozechner/pi-coding-agent";
import { injectedKind, type InjectedKind } from "../tools/lib/injected-prompts";

export type PromptKind = "human" | InjectedKind;

export const MARK_LABEL = "★";

type LabelEntry = Extract<SessionEntry, { type: "label" }>;

export interface Turn {
	id: string;
	number: number;
	kind: PromptKind;
	prompt: string;
	at: number;
	onPath: boolean;
	/** 0 while the model still sees it; n when compaction n summarised it away */
	compacted: number;
	/** what followed the prompt: replies, tool results, agent results, compactions and, folded in, prompts sent by goal or /ysk */
	steps: SessionEntry[];
	/** the newest entry of the turn, where /tree lands to continue from it */
	lastId: string;
	toolCalls: number;
	label?: string;
}

export type MarkKind = "label" | "goal" | "summary" | "branch";

export interface Mark {
	kind: MarkKind;
	id: string;
	title: string;
	/** a summary's whole text; labels and goals open their turn instead */
	text?: string;
	at: number;
	turn?: Turn;
}

export interface SessionView {
	turns: Turn[];
	marks: Mark[];
	compactions: number;
	/** the turn the session is on now: the last one on the current branch */
	active: Turn | undefined;
}

export type AnswerState = "done" | "cut" | "failed" | "interrupted" | "none";

export interface Answer {
	state: AnswerState;
	text: string;
	error?: string;
}

interface MessageLike {
	role?: string;
	content?: unknown;
	stopReason?: string;
	errorMessage?: string;
	timestamp?: number;
}

/** a message's text blocks joined; images and tool calls left out. For a reply still streaming, whose object pi keeps filling in. */
export function freshText(message: MessageLike): string {
	const { content } = message;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: "text"; text: string } => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}

const textCache = new WeakMap<object, string>();

/** `freshText`, kept per message: only for messages pi has saved, which never change again */
export function messageText(message: MessageLike): string {
	let text = textCache.get(message);
	if (text === undefined) {
		text = freshText(message);
		textCache.set(message, text);
	}
	return text;
}

const lowerCache = new WeakMap<object, string>();

function lower(message: MessageLike): string {
	let text = lowerCache.get(message);
	if (text === undefined) {
		text = messageText(message).toLowerCase();
		lowerCache.set(message, text);
	}
	return text;
}

function messageOf(entry: SessionEntry): MessageLike | undefined {
	return entry.type === "message" ? (entry.message as MessageLike) : undefined;
}

function isPrompt(entry: SessionEntry): boolean {
	return messageOf(entry)?.role === "user";
}

function promptKind(entry: SessionEntry): PromptKind {
	return injectedKind(messageText(messageOf(entry)!)) ?? "human";
}

function isStep(entry: SessionEntry): boolean {
	if (entry.type === "compaction") return true;
	if (entry.type === "custom_message") return entry.display;
	const role = messageOf(entry)?.role;
	return role === "assistant" || role === "toolResult" || role === "bashExecution" || role === "user";
}

function timeOf(entry: SessionEntry): number {
	const stamp = messageOf(entry)?.timestamp;
	return typeof stamp === "number" ? stamp : Date.parse(entry.timestamp) || 0;
}

function countToolCalls(steps: readonly SessionEntry[]): number {
	let count = 0;
	for (const step of steps) {
		const content = messageOf(step)?.role === "assistant" ? messageOf(step)!.content : undefined;
		if (Array.isArray(content)) for (const block of content) if (block?.type === "toolCall") count++;
	}
	return count;
}

function firstLine(text: string): string {
	return text.trim().split("\n", 1)[0] ?? "";
}

interface Cut {
	number: number;
	/** path depth of the first entry the compaction kept */
	before: number;
}

/** what a built view keeps so that entries appended along the current branch can extend it */
interface IndexState {
	fold: boolean;
	leafId: string | null;
	count: number;
	lastId: string | undefined;
	byId: Map<string, SessionEntry>;
	order: Map<string, number>;
	position: Map<string, number>;
	compactionNumber: Map<string, number>;
	cuts: Cut[];
	turnOf: Map<string, Turn>;
	turns: Turn[];
	labels: Map<string, LabelEntry>;
	/** compactions, branch summaries and goals, in file order */
	sources: SessionEntry[];
	view: SessionView;
}

type IndexData = Omit<IndexState, "view">;

function startsTurn(entry: SessionEntry, fold: boolean): boolean {
	return isPrompt(entry) && (!fold || promptKind(entry) === "human");
}

function compactedAt(depth: number, cuts: readonly Cut[]): number {
	return cuts.find((cut) => depth < cut.before)?.number ?? 0;
}

function isMarkSource(entry: SessionEntry): boolean {
	return entry.type === "compaction" || entry.type === "branch_summary" || (entry.type === "custom" && entry.customType === "pi-codex-goal");
}

function applyLabel(state: IndexData, entry: LabelEntry): void {
	state.labels.set(entry.targetId, entry);
	const turn = state.turnOf.get(entry.targetId);
	if (turn && turn.id === entry.targetId) turn.label = entry.label || undefined;
}

function collectMarks(state: IndexData): Mark[] {
	const marks: Mark[] = [];
	for (const entry of state.sources) {
		if (entry.type === "compaction") {
			const number = state.compactionNumber.get(entry.id)!;
			marks.push({ kind: "summary", id: entry.id, title: `Summary ${number}: ${Math.round(entry.tokensBefore / 1000)}k tokens before`, text: entry.summary, at: timeOf(entry), turn: state.turnOf.get(entry.id) });
		} else if (entry.type === "branch_summary") {
			marks.push({ kind: "branch", id: entry.id, title: `Branch summary: ${firstLine(entry.summary)}`, text: entry.summary, at: timeOf(entry), turn: state.turnOf.get(entry.id) });
		} else if (entry.type === "custom") {
			const objective = goalObjective(entry.data);
			if (objective) marks.push({ kind: "goal", id: entry.id, title: `Goal: ${firstLine(objective)}`, text: objective, at: timeOf(entry), turn: nearestTurn(entry, state.byId, state.turnOf) });
		}
	}
	for (const [targetId, entry] of state.labels) {
		if (!entry.label || !state.byId.has(targetId)) continue;
		const turn = state.turnOf.get(targetId);
		const about = turn ? firstLine(turn.prompt) : "";
		const title = !about ? entry.label : entry.label === MARK_LABEL ? about : `${entry.label}: ${about}`;
		marks.push({ kind: "label", id: targetId, title, at: timeOf(entry), turn });
	}
	return marks.sort((a, b) => (state.order.get(a.id) ?? 0) - (state.order.get(b.id) ?? 0));
}

function viewOf(state: IndexData, marks: Mark[]): SessionView {
	return { turns: state.turns, marks, compactions: state.compactionNumber.size, active: state.turns.findLast((turn) => turn.onPath) };
}

/**
 * `foldInjected` keeps goal and /ysk prompts inside the turn of the prompt you
 * typed before them, so a long goal run reads as the one request it is.
 */
export function buildSessionView(entries: readonly SessionEntry[], leafId: string | null, foldInjected: boolean): SessionView {
	return buildIndex(entries, leafId, foldInjected).view;
}

function buildIndex(entries: readonly SessionEntry[], leafId: string | null, foldInjected: boolean): IndexState {
	const byId = new Map<string, SessionEntry>();
	const children = new Map<string, SessionEntry[]>();
	for (const entry of entries) {
		byId.set(entry.id, entry);
		if (!entry.parentId || entry.parentId === entry.id) continue;
		const siblings = children.get(entry.parentId);
		if (siblings) siblings.push(entry);
		else children.set(entry.parentId, [entry]);
	}

	const path: string[] = [];
	const seen = new Set<string>();
	for (let entry = leafId ? byId.get(leafId) : undefined; entry && !seen.has(entry.id); entry = entry.parentId ? byId.get(entry.parentId) : undefined) {
		seen.add(entry.id);
		path.push(entry.id);
	}
	const position = new Map(path.reverse().map((id, index) => [id, index]));

	const compactionNumber = new Map<string, number>();
	const cuts: Cut[] = [];
	for (const entry of entries) {
		if (entry.type !== "compaction") continue;
		compactionNumber.set(entry.id, compactionNumber.size + 1);
		const depth = position.get(entry.id);
		if (depth === undefined) continue;
		cuts.push({ number: compactionNumber.size, before: position.get(entry.firstKeptEntryId) ?? depth });
	}

	const turnOf = new Map<string, Turn>();
	const turns: Turn[] = [];

	// From the prompt down: the child on the current branch, else the newest one, until the next prompt.
	const walk = (prompt: SessionEntry) => {
		const passed: SessionEntry[] = [prompt];
		const ids = new Set([prompt.id]);
		let last = prompt;
		for (;;) {
			const next = children.get(last.id);
			if (!next) break;
			const child = next.find((entry) => position.has(entry.id)) ?? next[next.length - 1]!;
			if (startsTurn(child, foldInjected) || turnOf.has(child.id) || ids.has(child.id)) break;
			passed.push(child);
			ids.add(child.id);
			last = child;
		}
		const steps = passed.slice(1).filter(isStep);
		const onPath = position.has(prompt.id);
		const depth = position.get(prompt.id) ?? -1;
		const turn: Turn = {
			id: prompt.id,
			number: 0,
			kind: promptKind(prompt),
			prompt: messageText(messageOf(prompt)!),
			at: timeOf(prompt),
			onPath,
			compacted: onPath ? compactedAt(depth, cuts) : 0,
			steps,
			lastId: last.id,
			toolCalls: countToolCalls(steps),
		};
		for (const entry of passed) turnOf.set(entry.id, turn);
		turns.push(turn);
	};

	for (const entry of entries) if (startsTurn(entry, foldInjected)) walk(entry);
	for (const entry of entries) if (isPrompt(entry) && !turnOf.has(entry.id)) walk(entry);

	const order = new Map(entries.map((entry, index) => [entry.id, index]));
	turns.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
	turns.forEach((turn, index) => (turn.number = index + 1));

	const data: IndexData = {
		fold: foldInjected,
		leafId,
		count: entries.length,
		lastId: entries.at(-1)?.id,
		byId,
		order,
		position,
		compactionNumber,
		cuts,
		turnOf,
		turns,
		labels: new Map(),
		sources: entries.filter(isMarkSource),
	};
	for (const entry of entries) if (entry.type === "label") applyLabel(data, entry);
	return { ...data, view: viewOf(data, collectMarks(data)) };
}

/**
 * Extends `state` in place with entries pi appended along the current branch,
 * each the child of the one before, which is how every message, tool result,
 * label and compaction arrives. Anything else (a /tree move, a fork) returns
 * false and is rebuilt whole.
 */
function extend(state: IndexState, entries: readonly SessionEntry[], leafId: string | null): boolean {
	const start = state.count;
	if (entries.length <= start || entries[start - 1]?.id !== state.lastId) return false;
	let parent = state.leafId;
	for (let index = start; index < entries.length; index++) {
		if (entries[index]!.parentId !== parent) return false;
		parent = entries[index]!.id;
	}
	if (parent !== leafId) return false;

	let marksChanged = false;
	for (let index = start; index < entries.length; index++) {
		const entry = entries[index]!;
		const depth = state.position.size;
		state.byId.set(entry.id, entry);
		state.order.set(entry.id, index);
		state.position.set(entry.id, depth);
		if (entry.type === "compaction") {
			state.compactionNumber.set(entry.id, state.compactionNumber.size + 1);
			state.cuts.push({ number: state.compactionNumber.size, before: state.position.get(entry.firstKeptEntryId) ?? depth });
			for (const turn of state.turns) if (turn.onPath) turn.compacted = compactedAt(state.position.get(turn.id)!, state.cuts);
		}
		const active = state.turns.findLast((turn) => turn.onPath);
		if (startsTurn(entry, state.fold) || (!active && isPrompt(entry))) {
			const turn: Turn = {
				id: entry.id,
				number: state.turns.length + 1,
				kind: promptKind(entry),
				prompt: messageText(messageOf(entry)!),
				at: timeOf(entry),
				onPath: true,
				compacted: compactedAt(depth, state.cuts),
				steps: [],
				lastId: entry.id,
				toolCalls: 0,
			};
			state.turns.push(turn);
			state.turnOf.set(entry.id, turn);
		} else if (active) {
			state.turnOf.set(entry.id, active);
			active.lastId = entry.id;
			if (isStep(entry)) {
				active.steps.push(entry);
				active.toolCalls += countToolCalls([entry]);
			}
		}
		if (isMarkSource(entry)) {
			state.sources.push(entry);
			marksChanged = true;
		}
		if (entry.type === "label") {
			applyLabel(state, entry);
			marksChanged = true;
		}
	}
	state.count = entries.length;
	state.lastId = entries.at(-1)?.id;
	state.leafId = leafId;
	state.view = viewOf(state, marksChanged ? collectMarks(state) : state.view.marks);
	return true;
}

/** one session's view, extended in place for plain appends and rebuilt whole otherwise */
export class SessionIndex {
	private state: IndexState | undefined;

	update(entries: readonly SessionEntry[], leafId: string | null, foldInjected: boolean): SessionView {
		const state = this.state;
		if (state && state.fold === foldInjected && state.leafId === leafId && state.count === entries.length) return state.view;
		if (!state || state.fold !== foldInjected || !extend(state, entries, leafId)) this.state = buildIndex(entries, leafId, foldInjected);
		return this.state!.view;
	}
}

function goalObjective(data: unknown): string | undefined {
	const record = data as { kind?: unknown; goal?: { objective?: unknown } } | undefined;
	return record?.kind === "set" && typeof record.goal?.objective === "string" ? record.goal.objective : undefined;
}

function nearestTurn(entry: SessionEntry, byId: Map<string, SessionEntry>, turnOf: Map<string, Turn>): Turn | undefined {
	for (let step: SessionEntry | undefined = entry; step; step = step.parentId ? byId.get(step.parentId) : undefined) {
		const turn = turnOf.get(step.id);
		if (turn) return turn;
	}
	return undefined;
}

/** the turn's final reply, judged by how its last reply ended */
export function answerOf(turn: Turn): Answer {
	const last = turn.steps.findLast((step) => messageOf(step)?.role === "assistant");
	const message = last ? messageOf(last)! : undefined;
	if (!message) return { state: "none", text: "" };
	const text = messageText(message).trim();
	switch (message.stopReason) {
		case "stop":
			return { state: "done", text };
		case "length":
			return { state: "cut", text };
		case "error":
			return { state: "failed", text, error: message.errorMessage };
		default:
			return { state: "interrupted", text };
	}
}

const lowerPrompts = new WeakMap<Turn, string>();

/** every word of `query` appears in the prompt or, unless `promptOnly`, the answer */
export function matches(turn: Turn, words: readonly string[], promptOnly = false): boolean {
	if (words.length === 0) return true;
	let prompt = lowerPrompts.get(turn);
	if (prompt === undefined) {
		prompt = turn.prompt.toLowerCase();
		lowerPrompts.set(turn, prompt);
	}
	const lastReply = turn.steps.findLast((step) => messageOf(step)?.role === "assistant");
	const answer = promptOnly || !lastReply ? "" : lower(messageOf(lastReply)!);
	return words.every((word) => prompt.includes(word) || answer.includes(word));
}

export function searchWords(query: string): string[] {
	return query.toLowerCase().split(/\s+/).filter(Boolean);
}
