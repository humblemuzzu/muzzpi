import type { Message } from "@mariozechner/pi-ai";
import type { SessionEntry } from "@mariozechner/pi-coding-agent";
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Markdown, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import { TranscriptRenderer } from "../agents-ui/transcript";
import { justify, type Styler } from "../tools/lib/agent-layout";
import { normalizeForDisplay } from "../tools/lib/box-format";
import { oneLine } from "../tools/lib/choice-dialog";
import { injectedKind } from "../tools/lib/injected-prompts";
import { toolArgSummary } from "../tools/lib/sub-agent-render";
import { answerOf, freshText, messageText, type Mark, type Turn } from "./session-view";

export function count(n: number, noun: string): string {
	return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

export function markdownLines(text: string, width: number): string[] {
	return new Markdown(normalizeForDisplay(text), 0, 0, getMarkdownTheme()).render(width);
}

export function plainLines(text: string, width: number): string[] {
	return normalizeForDisplay(text.replace(/\t/g, "    ").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")).split("\n").flatMap((line) => wrapTextWithAnsi(line, width));
}

function toolCallIn(message: Message | undefined): string {
	if (message?.role !== "assistant" || !Array.isArray(message.content)) return "";
	const call = message.content.findLast((block) => block.type === "toolCall");
	if (call?.type !== "toolCall") return "";
	return oneLine(`${call.name} ${toolArgSummary(call.name, (call.arguments ?? {}) as Record<string, unknown>).split("\n")[0] ?? ""}`);
}

/** what the agent is doing right now, from its newest tool call */
function lastToolCall(turn: Turn, live: Message | undefined): string {
	const streaming = toolCallIn(live);
	if (streaming) return streaming;
	for (let index = turn.steps.length - 1; index >= 0; index--) {
		const step = turn.steps[index]!;
		const found = step.type === "message" ? toolCallIn(step.message as Message) : "";
		if (found) return found;
	}
	return "";
}

export interface Working {
	/** the reply being streamed, before pi saves it */
	message: Message | undefined;
	spinner: string;
}

export function answerLines(turn: Turn, working: Working | undefined, width: number, theme: Styler): string[] {
	if (working) {
		const text = working.message ? freshText(working.message).trim() : "";
		if (text) return markdownLines(text, width);
		const doing = lastToolCall(turn, working.message);
		return [`${theme.fg("accent", working.spinner)} ${theme.fg("muted", "working")}${doing ? theme.fg("dim", ` · ${doing}`) : ""}`];
	}
	const answer = answerOf(turn);
	const body = answer.text ? markdownLines(answer.text, width) : [];
	switch (answer.state) {
		case "done":
			return body.length > 0 ? body : [theme.fg("muted", "The reply had no text. Process shows what it did.")];
		case "cut":
			return [...body, "", theme.fg("warning", "Cut off: the reply reached its output limit.")];
		case "failed":
			return [...body, ...(body.length > 0 ? [""] : []), ...plainLines(answer.error ?? "The request failed.", width).map((line) => theme.fg("error", line))];
		case "interrupted":
			return body.length > 0
				? [theme.fg("warning", "Stopped before a final answer. The last thing it said:"), "", ...body]
				: [theme.fg("warning", "Stopped before a final answer. Process shows what it did.")];
		case "none":
			return [theme.fg("muted", "No reply to this prompt.")];
	}
}

const BASH_PREVIEW_LINES = 6;

/** entries the transcript renderer cannot draw: compactions, agent results, folded prompts and your own `!` commands */
function markerLines(entry: SessionEntry, width: number, theme: Styler): string[] | undefined {
	if (entry.type === "compaction") return [theme.fg("dim", `── summarised here: ${Math.round(entry.tokensBefore / 1000)}k tokens became a summary ──`)];
	if (entry.type === "custom_message") return [`${theme.fg("dim", "⇢ ")}${theme.fg("muted", entry.customType === "agent-result" ? "background agents reported back" : oneLine(entry.customType))}`];
	if (entry.type !== "message") return undefined;
	const { message } = entry;
	if (message.role === "user") return [theme.fg("accent", injectedKind(messageText(message)) === "goal" ? "↻ goal: keep going" : "✦ /ysk flagged something")];
	if (message.role !== "bashExecution") return undefined;
	const output = plainLines(message.output.trimEnd(), Math.max(1, width - 4));
	const shown = output.slice(0, BASH_PREVIEW_LINES).map((line) => theme.fg(message.exitCode ? "error" : "dim", `    ${line}`));
	if (output.length > shown.length) shown.push(theme.fg("muted", `    … ${output.length - shown.length} more lines`));
	return [`${theme.fg("accent", "$")} ${oneLine(message.command)}`, ...shown];
}

/** the turn's work as the main chat draws it, with goal, /ysk, agent results and compactions marked where they happened */
export function processLines(turn: Turn, working: Working | undefined, width: number, full: boolean, transcript: TranscriptRenderer, theme: Styler): string[] {
	const out: string[] = [];
	const add = (lines: string[]) => {
		if (lines.length === 0) return;
		if (out.length > 0) out.push("");
		out.push(...lines);
	};
	let run: Message[] = [];
	const flush = () => {
		add(transcript.lines(run, width, { full }));
		run = [];
	};
	for (const step of turn.steps) {
		const marker = markerLines(step, width, theme);
		if (marker) {
			flush();
			add(marker);
		} else if (step.type === "message") run.push(step.message as Message);
	}
	flush();
	if (working?.message) add(new TranscriptRenderer(theme).lines([working.message], width, { full }));
	if (out.length === 0) out.push(theme.fg("muted", working ? `${working.spinner} starting…` : "Nothing ran for this prompt."));
	return out;
}

export function when(at: number, now: number): string {
	const date = new Date(at);
	if (date.toDateString() === new Date(now).toDateString()) return date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
	return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** more than any row can show, so a pasted log is never flattened whole for one line */
const ROW_TEXT_LIMIT = 500;

const STATE_ICON = { done: ["✓", "success"], cut: ["…", "warning"], failed: ["✕", "error"], interrupted: ["◼", "warning"], none: [" ", "dim"] } as const;

export interface RowStyle {
	selected: boolean;
	/** the spinner glyph when this is the turn the agent is working on */
	working?: string;
	now: number;
}

/** one list row: number, time, branch and summary markers, the prompt or answer, and how it ended */
export function turnRow(turn: Turn, text: string, width: number, style: RowStyle, theme: Styler): string {
	const tone = turn.onPath ? "text" : "dim";
	const marker = !turn.onPath ? theme.fg("dim", "⑂") : turn.compacted ? theme.fg("dim", "◌") : turn.label ? theme.fg("accent", "★") : " ";
	const cursor = style.selected ? theme.fg("accent", "› ") : "  ";
	const number = theme.fg("dim", String(turn.number).padStart(4));
	const left = `${cursor}${number}  ${theme.fg("dim", when(turn.at, style.now).padEnd(6))} ${marker} ${theme.fg(style.selected ? "accent" : tone, oneLine(text.slice(0, ROW_TEXT_LIMIT)) || "(empty)")}`;
	const [icon, color] = style.working ? [style.working, "accent"] : STATE_ICON[answerOf(turn).state];
	const right = `${theme.fg(color, icon)}${turn.toolCalls > 0 ? theme.fg("dim", ` ${count(turn.toolCalls, "tool")}`) : ""}`;
	return justify(left, right, width, 24).line;
}

const MARK_ICON = { label: "★", goal: "◎", summary: "≡", branch: "⑂" } as const;

export function markRow(mark: Mark, width: number, style: RowStyle, theme: Styler): string {
	const cursor = style.selected ? theme.fg("accent", "› ") : "  ";
	const left = `${cursor}${theme.fg("accent", MARK_ICON[mark.kind])} ${theme.fg(style.selected ? "accent" : "text", oneLine(mark.title))}`;
	return justify(left, theme.fg("dim", when(mark.at, style.now)), width, 24).line;
}
