/**
 * read_session: one model reads a whole past session and answers a goal about
 * it. The reader is a direct model call with no tools, so it can read nothing
 * but the transcript it is handed, and the transcript is scrubbed of secrets
 * first. A session too long for the reader's context is read in parallel
 * parts, whose notes one more call merges.
 */

import { isContextOverflow, type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { emptyAgentModels, mainRoute, modelParams, resolveRoute, type AgentModels, type ThinkingLevel } from "./lib/agent-models";
import { scrubAnthropicPayload } from "./lib/anthropic-sub";
import { zeroUsage, type UsageStats } from "./lib/pi-spawn";
import { makeScrubber } from "./lib/psst";
import { RepetitionWatch } from "./lib/repetition";
import { toolError } from "./lib/run-sub-agent";
import { buildTranscript, findSessionFile, fitLimit, renderTranscript, splitTranscript, type Part, type Transcript } from "./lib/session-transcript";
import { clip, renderSubAgentResult, subAgentResult, type SingleResult } from "./lib/sub-agent-render";

/** measured 3.1–3.5 on real transcripts with DeepSeek's tokenizer; under the low end keeps a read inside the window */
const CHARS_PER_TOKEN = 3.0;
const ANSWER_TOKENS = 64_000;
const PROMPT_TOKENS = 12_000;
const MAX_CUT = 12_000;
const MAX_CUT_FOCUS = 60_000;
const PARALLEL_PARTS = 8;
const LOOP_RETRIES = 2;
const UPDATE_MS = 250;

const FALLBACK_PROMPT =
	"You read one coding-agent session transcript and answer a goal about it from the transcript only, citing entry ids and quoting numbers, paths and commands exactly.";

const PART_TASK = (i: number, n: number, part: Part) =>
	`This is part ${i} of ${n} of the session, from ${part.first} to ${part.last}. Each part is read separately and the notes are merged afterwards, ` +
	"so do not write the final answer yet. Write notes for the merge: everything in this part that bears on the goal, with entry ids; the user's prompts " +
	"in this part, quoted; exact numbers, paths, commands and results; what was decided, done and left open; and how this part ends. " +
	'Write "nothing relevant in this part" if that is so.';

const MERGE_TASK = (n: number) =>
	`The session was too long for one read, so it was read in ${n} parts, in order. Below are the session header and the notes on each part. ` +
	"Write the final answer to the goal from them, following your rules; a later part overrides an earlier one.";

export interface ReadSessionConfig {
	systemPrompt?: string;
	models?: AgentModels;
}

interface Reader {
	registry: any;
	model: Model<Api>;
	reasoning?: Exclude<ThinkingLevel, "off">;
	system: string;
	signal?: AbortSignal;
	usage: UsageStats;
}

/** the characters one read may hold, from the reader's context window */
export function readBudget(model: { contextWindow?: number; maxTokens?: number }): number {
	const answer = Math.min(model.maxTokens || ANSWER_TOKENS, ANSWER_TOKENS);
	const room = (model.contextWindow || 128_000) - answer - PROMPT_TOKENS;
	return Math.max(40_000, Math.floor(room * 0.9 * CHARS_PER_TOKEN));
}

function addUsage(total: UsageStats, message: AssistantMessage): void {
	const usage: any = message.usage ?? {};
	total.input += usage.input || 0;
	total.output += usage.output || 0;
	total.cacheRead += usage.cacheRead || 0;
	total.cacheWrite += usage.cacheWrite || 0;
	total.cost += usage.cost?.total || 0;
	total.contextTokens = Math.max(total.contextTokens, usage.totalTokens || 0);
	total.turns++;
}

function textOf(message: AssistantMessage): string {
	return message.content.filter((part): part is { type: "text"; text: string } => part.type === "text").map((part) => part.text).join("");
}

/** one model call; a reply caught repeating itself is asked again, twice at most */
async function ask(reader: Reader, text: string, onText?: (text: string) => void): Promise<AssistantMessage> {
	const plan = reader.model.provider === "anthropic" && reader.registry.isUsingOAuth?.(reader.model);
	for (let attempt = 0; ; attempt++) {
		const controller = new AbortController();
		const abort = () => controller.abort();
		if (reader.signal?.aborted) controller.abort();
		reader.signal?.addEventListener("abort", abort, { once: true });
		const watch = new RepetitionWatch();
		let looped = false;
		let streamed = "";
		try {
			const stream = reader.registry.streamSimple(
				reader.model,
				{ systemPrompt: reader.system, messages: [{ role: "user", content: [{ type: "text", text }], timestamp: Date.now() }] },
				{
					reasoning: reader.reasoning,
					signal: controller.signal,
					maxTokens: Math.min(reader.model.maxTokens || ANSWER_TOKENS, ANSWER_TOKENS),
					...(plan ? { onPayload: (payload: unknown) => scrubAnthropicPayload(payload) } : {}),
				},
			);
			for await (const event of stream) {
				if (event.type !== "text_delta" && event.type !== "thinking_delta") continue;
				if (event.type === "text_delta") {
					streamed += event.delta;
					onText?.(streamed);
				}
				if (!looped && watch.feed(event.delta, event.type)) {
					looped = true;
					controller.abort();
				}
			}
			const message: AssistantMessage = await stream.result();
			addUsage(reader.usage, message);
			if (!looped || reader.signal?.aborted) return message;
			if (attempt >= LOOP_RETRIES) return { ...message, stopReason: "error", errorMessage: `the reader's reply kept repeating itself (${attempt + 1} tries)` };
		} finally {
			reader.signal?.removeEventListener("abort", abort);
		}
	}
}

function failure(message: AssistantMessage): string | undefined {
	if (message.stopReason === "aborted") return "Stopped before the reader finished.";
	if (message.stopReason === "error") return message.errorMessage || "the reader's model call failed";
	if (!textOf(message).trim()) return "the reader returned no text";
	return undefined;
}

async function inParallel<T, R>(items: T[], limit: number, run: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const i = next++;
			out[i] = await run(items[i]!, i);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return out;
}

function partCall(i: number, n: number, part: Part): any {
	return { type: "toolCall", id: `part-${i}`, name: "part", arguments: { part: `${i + 1}/${n}`, covers: `${part.first} → ${part.last}` } };
}

function partResult(i: number, error?: string): any {
	return { role: "toolResult", toolCallId: `part-${i}`, toolName: "part", content: [], isError: Boolean(error) };
}

function coverage(transcript: Transcript, chars: number, parts: number, limit: number, usage: UsageStats): string {
	const where = parts === 1 ? "in one read" : `in ${parts} parts read in parallel, then merged`;
	const tokens = Math.round((usage.input + usage.cacheRead) / 1000).toLocaleString("en-US");
	return (
		`read: session ${transcript.sessionId}${transcript.sessionName ? ` "${transcript.sessionName}"` : ""}, ${chars.toLocaleString("en-US")} chars ` +
		`(${tokens}k input tokens) ${where}; prompts, replies and sub-agent answers whole; ` +
		`tool output, file bodies and thinking over ${limit.toLocaleString("en-US")} chars shortened; secrets redacted before reading`
	);
}

export function createReadSessionTool(config: ReadSessionConfig = {}): ToolDefinition {
	const models = config.models ?? emptyAgentModels();
	return {
		name: "read_session",
		label: "Read Session",
		description:
			"Read a past pi session and answer a goal about it.\n\n" +
			"A reader model gets the whole session at once: every prompt the user typed, every reply and every sub-agent answer in full, " +
			"one line per tool call with file edits shown, and the tool output, all cut to one shared length only when the session is too long to fit. " +
			"Secrets are redacted before it reads, and the reader has no tools. A session too long for one read is read in parallel parts and merged. " +
			"Answers cite entry ids; pass one as `around_entry` to see the exact output near it.\n\n" +
			"Use `search_sessions` to find a session id. A sub-agent's continueId is also a session id.\n\n" +
			"WHEN TO USE:\n" +
			"- Recovering what was asked, decided, built or found in a previous session\n" +
			"- Checking where a running or finished sub-agent stands, by its continueId\n" +
			"- Reading the rest of a sub-agent answer that was cut\n\n" +
			"WHEN NOT TO USE:\n" +
			"- The current session (it is already in your context)\n" +
			"- Finding sessions (use search_sessions first)",

		parameters: Type.Object({
			session_id: Type.String({
				description: "The session id from search_sessions, or a sub-agent's continueId.",
			}),
			goal: Type.String({
				description:
					"What you want to know. A broad goal (\"summarize everything\") gets a full structured summary; a specific one gets a direct answer.",
			}),
			leaf_id: Type.Optional(
				Type.String({
					description: "A branch leaf id from search_sessions: read that branch as the main one. Default: the branch holding the latest entry.",
				}),
			),
			last_turns: Type.Optional(
				Type.Integer({
					minimum: 1,
					description: "Read only the last N prompts the user typed and everything after them: for where a long or running session stands now.",
				}),
			),
			around_entry: Type.Optional(
				Type.String({
					description: `An entry id from an earlier answer: read about 60 entries around it on its branch, with tool output up to ${MAX_CUT_FOCUS.toLocaleString("en-US")} chars each.`,
				}),
			),
			...modelParams(models, "read_session"),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (params.around_entry && (params.last_turns || params.leaf_id)) {
				return toolError("around_entry reads its own branch: pass it without last_turns or leaf_id.");
			}
			const route = resolveRoute(models, "read_session", params, ctx.modelRegistry, false, mainRoute(ctx.model));
			if ("error" in route) return toolError(route.error);
			const [provider, ...rest] = (route.model ?? "").split("/");
			const model: Model<Api> | undefined = route.model ? ctx.modelRegistry.find(provider!, rest.join("/")) : ctx.model;
			if (!model) return toolError(route.model ? `model ${route.model} is not in pi's catalog` : "no model is selected to read with");

			const file = await findSessionFile(params.session_id, signal);
			if (!file) return toolError(`session not found: ${params.session_id}. Use the id search_sessions prints, or a sub-agent's continueId.`);

			const scrub = await makeScrubber();
			let transcript: Transcript;
			try {
				transcript = await buildTranscript(file, scrub, { leafId: params.leaf_id, lastTurns: params.last_turns, aroundEntry: params.around_entry }, signal);
			} catch (error: any) {
				if (signal?.aborted) throw error;
				return toolError(String(error?.message ?? error));
			}
			if (!transcript.sections.some((section) => section.blocks.length > 0)) {
				return toolError(`session ${params.session_id} has no messages to read.`);
			}

			const level = route.thinking ?? ctx.thinkingLevel;
			const reader: Reader = {
				registry: ctx.modelRegistry,
				model,
				reasoning: model.reasoning && level && level !== "off" ? (level as Exclude<ThinkingLevel, "off">) : undefined,
				system: config.systemPrompt || FALLBACK_PROMPT,
				signal,
				usage: zeroUsage(),
			};
			const goal = scrub(params.goal);
			const details: SingleResult = {
				agent: "read_session",
				task: params.goal,
				exitCode: -1,
				messages: [],
				usage: reader.usage,
				model: `${model.provider}/${model.id}`,
				thinkingLevel: reader.reasoning ?? "off",
			};
			const shown = (calls: any[], results: any[], text: string) => [{ role: "assistant", content: [...calls, ...(text ? [{ type: "text", text }] : [])] } as any, ...results];
			let lastUpdate = 0;
			const progress = (calls: any[], results: any[], text: string, force = false) => {
				const now = Date.now();
				if (!force && now - lastUpdate < UPDATE_MS) return;
				lastUpdate = now;
				onUpdate?.({ content: [{ type: "text", text: text || "(reading session...)" }], details: { ...details, messages: shown(calls, results, text), usage: { ...reader.usage } } } as any);
			};

			const maxCut = params.around_entry ? MAX_CUT_FOCUS : MAX_CUT;
			let budget = readBudget(model);
			let answer: AssistantMessage | undefined;
			let calls: any[] = [];
			let results: any[] = [];
			let read = { chars: 0, parts: 1, limit: maxCut };
			for (let shrink = 0; shrink < 3 && !answer; shrink++) {
				const limit = fitLimit(transcript, budget, maxCut);
				const whole = renderTranscript(transcript, limit);
				if (whole.length <= budget) {
					read = { chars: whole.length, parts: 1, limit };
					calls = [];
					results = [];
					const reply = await ask(reader, `${whole}\n\n==== GOAL ====\n${goal}`, (text) => progress(calls, results, text));
					if (reply.stopReason === "error" && isContextOverflow(reply, model.contextWindow)) {
						budget = Math.floor(budget * 0.7);
						continue;
					}
					answer = reply;
					break;
				}
				const roomy = fitLimit(transcript, Math.ceil(whole.length / budget) * budget * 0.9, maxCut);
				const parts = splitTranscript(transcript, roomy, budget);
				read = { chars: parts.reduce((n, part) => n + part.text.length, 0), parts: parts.length, limit: roomy };
				calls = parts.map((part, i) => partCall(i, parts.length, part));
				results = [];
				progress(calls, results, "", true);
				let overflow = false;
				const notes = await inParallel(parts, PARALLEL_PARTS, async (part, i) => {
					const reply = await ask(reader, `${part.text}\n\n==== GOAL ====\n${goal}\n\n==== TASK FOR THIS PART ====\n${PART_TASK(i + 1, parts.length, part)}`);
					if (reply.stopReason === "error" && isContextOverflow(reply, model.contextWindow)) overflow = true;
					results.push(partResult(i, failure(reply)));
					progress(calls, results, "", true);
					return reply;
				});
				if (overflow) {
					budget = Math.floor(budget * 0.7);
					continue;
				}
				const broken = notes.map(failure).find(Boolean);
				if (broken) {
					answer = notes.find((note) => failure(note))!;
					break;
				}
				const merged = notes.map((note, i) => `==== NOTES ON PART ${i + 1} OF ${parts.length} (${parts[i]!.first} → ${parts[i]!.last}) ====\n${textOf(note)}`).join("\n\n");
				answer = await ask(reader, `${transcript.header}\n\n${merged}\n\n${transcript.footer}\n\n==== GOAL ====\n${goal}\n\n==== TASK ====\n${MERGE_TASK(parts.length)}`, (text) => progress(calls, results, text));
			}

			details.exitCode = 0;
			if (!answer) {
				details.exitCode = 1;
				details.stopReason = "error";
				details.errorMessage = "the session did not fit the reader's context even when cut further";
				return subAgentResult(details.errorMessage, details, true);
			}
			const text = textOf(answer);
			details.messages = shown(calls, results, text);
			details.stopReason = answer.stopReason;
			const problem = failure(answer);
			if (problem) {
				details.exitCode = 1;
				details.errorMessage = problem;
				return subAgentResult(problem, details, true);
			}
			const cutOff = answer.stopReason === "length" ? "\n\n[the answer reached the reader's output limit, so its end may be missing]" : "";
			return subAgentResult(`${text}${cutOff}\n\n---\n${coverage(transcript, read.chars, read.parts, read.limit, reader.usage)}`, details);
		},

		renderCall(args: any, theme: any, context: any) {
			const text = context?.lastComponent ?? new Text("", 0, 0);
			let label = theme.fg("toolTitle", theme.bold("read_session ")) + theme.fg("dim", args.goal ? clip(args.goal, 60) : "...");
			if (args.session_id) label += theme.fg("muted", ` (${clip(String(args.session_id), 12)})`);
			if (args.last_turns) label += theme.fg("muted", ` last ${args.last_turns}`);
			if (args.around_entry) label += theme.fg("muted", ` around ${args.around_entry}`);
			text.setText(label);
			return text;
		},

		renderResult: renderSubAgentResult("read_session"),
	};
}
