import type { Message } from "@mariozechner/pi-ai";
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Markdown, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import type { Styler } from "../tools/lib/agent-layout";
import { normalizeForDisplay } from "../tools/lib/box-format";
import { toolArgSummary } from "../tools/lib/sub-agent-render";

const RESULT_PREVIEW_LINES = 6;
const ANSI = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001B]*(?:\u0007|\u001B\\))/g;

const clean = (value: unknown): string => (typeof value === "string" ? value.replace(ANSI, "") : "");

type Block = Record<string, unknown>;

const blocksOf = (message: Message): Block[] => {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return [{ type: "text", text: content }];
	return Array.isArray(content) ? content.filter((block): block is Block => !!block && typeof block === "object") : [];
};

interface TranscriptOptions {
	/** show tool results whole instead of their first lines. */
	full: boolean;
}

interface MessageOptions extends TranscriptOptions {
	label: string;
}

/** state of each tool call, from the results that came back after it. */
function outcomes(messages: readonly Message[]): Map<string, boolean> {
	const map = new Map<string, boolean>();
	for (const message of messages) {
		if (message.role !== "toolResult") continue;
		const id = (message as { toolCallId?: unknown }).toolCallId;
		if (typeof id === "string") map.set(id, (message as { isError?: unknown }).isError === true);
	}
	return map;
}

/**
 * A run's conversation as screen lines, built the way the main chat is: prose
 * as Markdown, thinking dim, one line per tool call with its arguments, results
 * cut to a few lines. Each message is rendered once per width and kept, so a
 * transcript that grows by one message costs one message, not all of them.
 */
export class TranscriptRenderer {
	private cache = new WeakMap<object, { key: string; lines: string[] }>();

	constructor(private readonly theme: Styler) {}

	lines(messages: readonly Message[], width: number, options: TranscriptOptions): string[] {
		const results = outcomes(messages);
		const firstUser = messages.findIndex((message) => message.role === "user");
		const out: string[] = [];
		for (const [index, message] of messages.entries()) {
			const lines = this.messageLines(message, width, { ...options, label: index === firstUser ? "task" : "message" }, results);
			if (lines.length === 0) continue;
			if (out.length > 0) out.push("");
			out.push(...lines);
		}
		return out;
	}

	private messageLines(message: Message, width: number, options: MessageOptions, results: Map<string, boolean>): string[] {
		const calls = blocksOf(message).filter((block) => block.type === "toolCall");
		const signature = calls.map((call) => (results.has(String(call.id)) ? (results.get(String(call.id)) ? "e" : "o") : "p")).join("");
		const key = `${width}|${options.full}|${options.label}|${signature}`;
		const cached = this.cache.get(message);
		if (cached?.key === key) return cached.lines;
		const lines = this.build(message, width, options, results);
		this.cache.set(message, { key, lines });
		return lines;
	}

	private build(message: Message, width: number, options: MessageOptions, results: Map<string, boolean>): string[] {
		const { theme } = this;
		const lines: string[] = [];
		const gap = () => {
			if (lines.length > 0) lines.push("");
		};
		if (message.role === "user") {
			const text = blocksOf(message).map((block) => clean(block.text)).join("\n").trim();
			if (text) lines.push(theme.fg("muted", options.label), ...this.prose(text, width));
			return lines;
		}
		if (message.role === "toolResult") {
			const text = blocksOf(message).filter((block) => block.type === "text").map((block) => clean(block.text)).join("\n");
			if (!text.trim()) return lines;
			const all = normalizeForDisplay(text.trimEnd()).split("\n");
			const shown = options.full ? all : all.slice(0, RESULT_PREVIEW_LINES);
			const color = (message as { isError?: unknown }).isError === true ? "error" : "dim";
			for (const line of shown) lines.push(...wrapTextWithAnsi(theme.fg(color, `    ${line}`), width));
			if (all.length > shown.length) lines.push(theme.fg("muted", `    … ${all.length - shown.length} more lines (f to show all)`));
			return lines;
		}
		for (const block of blocksOf(message)) {
			if (block.type === "thinking") {
				const text = clean(block.thinking).replace(/^thinking:\s*/i, "").trim();
				if (!text) continue;
				gap();
				lines.push(theme.fg("dim", "thinking"), ...wrapTextWithAnsi(theme.fg("dim", normalizeForDisplay(text)), width));
			} else if (block.type === "text") {
				const text = clean(block.text).trim();
				if (!text) continue;
				gap();
				lines.push(...this.prose(text, width));
			} else if (block.type === "toolCall") {
				const failed = results.get(String(block.id));
				const icon = failed === undefined ? theme.fg("muted", "⋯") : failed ? theme.fg("error", "✕") : theme.fg("success", "✓");
				const name = typeof block.name === "string" ? block.name : "tool";
				const args = block.arguments && typeof block.arguments === "object" ? (block.arguments as Record<string, unknown>) : {};
				const summary = normalizeForDisplay(toolArgSummary(name, args).split("\n")[0] ?? "");
				lines.push(`${icon} ${theme.fg("accent", theme.bold(name.charAt(0).toUpperCase() + name.slice(1)))} ${theme.fg("dim", summary)}`);
			}
		}
		return lines;
	}

	private prose(text: string, width: number): string[] {
		return new Markdown(normalizeForDisplay(text), 0, 0, getMarkdownTheme()).render(width);
	}
}
