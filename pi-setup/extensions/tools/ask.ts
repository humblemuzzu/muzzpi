/**
 * ask — the agent puts its open questions to the user in the picker and waits.
 * Parent session only: no sub-agent allowlist includes it, since a child has
 * nobody to ask.
 */

import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { normalizeForDisplay } from "./lib/box-format";
import {
	type ChoiceAnswers,
	type ChoiceQuestion,
	canShowChoiceDialog,
	describeAnswer,
	oneLine,
	openChoiceDialog,
} from "./lib/choice-dialog";
import { getText } from "./lib/tui";

const MAX_QUESTIONS = 6;
const MAX_OPTIONS = 9;
const TYPE_LABEL = "Type your own answer";

interface AskQuestion {
	question: string;
	header?: string;
	options?: { label: string; description?: string }[];
	multiple?: boolean;
}

interface AskDetails {
	questions: AskQuestion[];
	answers?: ChoiceAnswers;
	outcome: "answered" | "dismissed" | "unavailable";
}

const DISMISSED = "The user dismissed the questions without answering. Stop and wait for their next message.";
const UNAVAILABLE =
	"Nobody can answer questions here (a sub-agent or a non-interactive run). Continue without the answers: " +
	"make reasonable assumptions, state them, and list the open questions in your final message.";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(value: unknown): unknown {
	if (typeof value !== "string") return value;
	const text = value.trim();
	if (!text.startsWith("[") && !text.startsWith("{")) return value;
	try {
		return JSON.parse(text);
	} catch {
		return value;
	}
}

function prepareQuestion(raw: unknown): unknown {
	const value = parseJson(raw);
	if (typeof value === "string") return { question: value };
	if (!isRecord(value)) return value;
	const question = { ...value };
	const options = parseJson(question.options);
	if (Array.isArray(options)) {
		question.options = options.map((option) => (typeof option === "string" ? { label: option } : option));
	}
	if (typeof question.multiple === "string") question.multiple = question.multiple === "true";
	return question;
}

/**
 * Accepts the shapes models actually send: `questions` as a JSON string (what
 * broke pi-ask), a single question object or string, options as plain strings,
 * or one question spread over the top-level arguments.
 */
export function prepareAskArguments(input: unknown): unknown {
	if (!isRecord(input)) return input;
	const args: Record<string, unknown> = { ...input };
	if (args.questions === undefined && args.question !== undefined) {
		const { question, header, options, multiple, ...rest } = args;
		const flat = Object.fromEntries(Object.entries({ question, header, options, multiple }).filter(([, v]) => v !== undefined));
		return prepareAskArguments({ ...rest, questions: [flat] });
	}
	let questions = parseJson(args.questions);
	if (!Array.isArray(questions) && questions !== undefined) questions = [questions];
	if (Array.isArray(questions)) args.questions = questions.map(prepareQuestion);
	return args;
}

export function formatAnswers(questions: AskQuestion[], answers: ChoiceAnswers): string {
	const lines = questions.map((q, i) => {
		const answer = answers[i];
		if (!answer) return `- ${q.question} → (no answer)`;
		const picked = answer.picked.join(", ");
		const typed = answer.typed ? `in their own words: "${answer.typed}"` : "";
		return `- ${q.question} → ${[picked, typed].filter(Boolean).join("; ")}`;
	});
	return `The user answered:\n${lines.join("\n")}`;
}

async function askWithBasicDialogs(ui: any, questions: ChoiceQuestion[], signal?: AbortSignal): Promise<ChoiceAnswers | undefined> {
	const answers: ChoiceAnswers = [];
	for (const q of questions) {
		const title = q.header ? `${q.header}: ${q.question}` : q.question;
		const labels = q.options.map((option) => option.label);
		const pick = labels.length > 0 ? await ui.select(title, [...labels, TYPE_LABEL], { signal }) : TYPE_LABEL;
		if (pick === undefined) return undefined;
		if (pick !== TYPE_LABEL) {
			answers.push({ picked: [pick] });
			continue;
		}
		const typed = await ui.input(title, TYPE_LABEL, { signal });
		if (typed === undefined) return undefined;
		answers.push(typed.trim() ? { picked: [], typed: typed.trim() } : undefined);
	}
	return answers;
}

function result(text: string, details: AskDetails, terminate = false) {
	return { content: [{ type: "text" as const, text }], details, ...(terminate ? { terminate: true } : {}) };
}

function reuseText(context: any, text: string) {
	const Text = getText();
	const component = context?.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
	if (component.text !== text) component.setText(text);
	return component;
}

export function createAskTool(): ToolDefinition {
	return {
		name: "ask",
		label: "Ask",
		description:
			"Ask the user questions in a picker and wait for the answers. Only for a choice the user alone can make " +
			"(scope, naming, a trade-off, which valid approach) that the code, the conversation or a sensible default " +
			"cannot settle; never to ask permission for what you were asked. All open questions in one call, 2-5 short " +
			"options each, recommended first; no options for an open question. The user can always type their own " +
			"answer. If they dismiss it, stop and wait.\n" +
			'Example: ask({ questions: [{ question: "Which store should the cache use?", header: "Cache", options: [{ label: "Redis", description: "already deployed" }, { label: "SQLite" }] }] })',

		parameters: Type.Object({
			questions: Type.Array(
				Type.Object({
					question: Type.String({ minLength: 1, description: "The full question." }),
					header: Type.Optional(Type.String({ description: "Tab label, 1-3 words." })),
					options: Type.Optional(
						Type.Array(
							Type.Object({
								label: Type.String({ minLength: 1, description: "The choice, 1-5 words." }),
								description: Type.Optional(Type.String({ description: "One line: what it means or why." })),
							}),
							{ maxItems: MAX_OPTIONS, description: "Omit for an open question." },
						),
					),
					multiple: Type.Optional(Type.Boolean({ description: "Let the user pick several." })),
				}),
				{ minItems: 1, maxItems: MAX_QUESTIONS, description: `1-${MAX_QUESTIONS} questions, shown together.` },
			),
		}),

		prepareArguments: prepareAskArguments as any,

		async execute(_toolCallId, params: any, signal, _onUpdate, ctx: any) {
			const questions = params.questions as AskQuestion[];
			if (!ctx?.hasUI || !ctx.ui) return result(UNAVAILABLE, { questions, outcome: "unavailable" });

			const choices: ChoiceQuestion[] = questions.map((q) => ({
				question: q.question,
				header: q.header,
				options: q.options ?? [],
				multiple: q.multiple,
				typeLabel: TYPE_LABEL,
			}));
			const title = questions.length > 1 ? `${questions.length} questions` : oneLine(questions[0]!.header || "Question");

			ctx.ui.setWorkingVisible?.(false);
			let answers: ChoiceAnswers | undefined;
			try {
				answers = canShowChoiceDialog(ctx)
					? await openChoiceDialog(ctx, { title, questions: choices, notify: questions[0]!.question }, signal)
					: await askWithBasicDialogs(ctx.ui, choices, signal);
			} finally {
				ctx.ui.setWorkingVisible?.(true);
			}

			if (!answers) return result(DISMISSED, { questions, outcome: "dismissed" }, true);
			return result(formatAnswers(questions, answers), { questions, answers, outcome: "answered" });
		},

		renderCall(args: any, theme: any, context: any) {
			const questions: AskQuestion[] = Array.isArray(args?.questions) ? args.questions : [];
			const summary =
				questions.length <= 1
					? oneLine(String(questions[0]?.question ?? ""))
					: `${questions.length} questions: ${questions.map((q, i) => oneLine(String(q?.header || `Q${i + 1}`))).join(", ")}`;
			return reuseText(context, theme.fg("toolTitle", theme.bold("Ask ")) + theme.fg("dim", summary));
		},

		renderResult(result: any, _options: any, theme: any, context: any) {
			const details = result.details as AskDetails | undefined;
			if (!details) return reuseText(context, theme.fg("dim", normalizeForDisplay(String(result.content?.[0]?.text ?? ""))));
			if (details.outcome === "dismissed") return reuseText(context, theme.fg("warning", "dismissed"));
			if (details.outcome === "unavailable") return reuseText(context, theme.fg("dim", "no one to ask here"));
			const lines = details.questions.map((q, i) => {
				const answer = details.answers?.[i];
				const shown = answer ? theme.fg("text", oneLine(describeAnswer(answer))) : theme.fg("dim", "(no answer)");
				return `${theme.fg("muted", oneLine(q.question))}\n  ${theme.fg("success", "→")} ${shown}`;
			});
			return reuseText(context, lines.join("\n"));
		},
	} as ToolDefinition;
}
