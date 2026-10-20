/**
 * rendering utilities for sub-agent tool results: DisplayItem, message
 * parsing and the TUI tree. every spawning tool (finder, oracle, code_review,
 * delegate, chad, librarian) uses these for a consistent renderResult.
 */

import * as os from "node:os";
import type { Message } from "@mariozechner/pi-ai";
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Text, truncateToWidth } from "@mariozechner/pi-tui";
import { normalizeForDisplay } from "./box-format";
import type { PiSpawnResult, SpawnSessionMeta, UsageStats } from "./pi-spawn";
import type { ToolCostDetails } from "./tool-cost";

// --- types ---

export type DisplayItem =
	| { type: "text"; text: string }
	| { type: "toolCall"; id: string; name: string; args: Record<string, any>; isError?: boolean };

export interface SingleResult {
	agent: string;
	task: string;
	exitCode: number;
	messages: Message[];
	usage: UsageStats;
	model?: string;
	thinkingLevel?: string;
	stopReason?: string;
	errorMessage?: string;
	/** set only for persisted sub-agents (delegate, chad): what a caller passes back to resume the child. */
	continueId?: string;
}

/**
 * copy spawn session metadata onto a result, ignoring absent fields.
 *
 * streaming updates arrive repeatedly and may not carry session data every
 * time, so this must never overwrite a known id with undefined.
 */
function applySessionMeta(
	target: SingleResult,
	meta: SpawnSessionMeta | undefined,
): void {
	if (!meta) return;
	if (meta.continueId) target.continueId = meta.continueId;
}

/** copy a spawn result, partial or final, onto the tool's result. exitCode stays the caller's. */
export function applySpawnResult(target: SingleResult, spawned: PiSpawnResult): void {
	target.messages = spawned.messages;
	target.usage = spawned.usage;
	target.model = spawned.model;
	target.thinkingLevel = spawned.thinkingLevel;
	target.stopReason = spawned.stopReason;
	target.errorMessage = spawned.errorMessage;
	applySessionMeta(target, spawned.session);
}

export function modelLabel(r: { model?: string; thinkingLevel?: string }): string | undefined {
	if (!r.model) return undefined;
	return r.thinkingLevel ? `${r.model} · ${r.thinkingLevel}` : r.model;
}

/** what the parent model needs after the answer: which model ran, and how to resume. */
function resultFooter(details: SingleResult): string {
	const lines: string[] = [];
	const model = modelLabel(details);
	if (model) lines.push(`model: ${model}`);
	if (details.continueId) lines.push(`continueId: ${details.continueId}`);
	return lines.length > 0 ? `\n\n---\n${lines.join("\n")}` : "";
}

// --- message parsing ---

export function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

export interface ImageBlock {
	type: "image";
	data: string;
	mimeType: string;
}

/**
 * The images a sub-agent looked at, most recent last.
 *
 * Without this, a sub-agent that screenshots something reports its PROSE about
 * the picture and the pixels die with the child — you are trusting its word for
 * what was on screen. Since every image reaching a sub-agent has already been
 * through `fitImageFile`, these are known to be inside the vision budget.
 *
 * Capped, and capped hard: images are the most expensive thing that can enter a
 * context. `limit` is the number of MOST RECENT images kept, because a
 * sub-agent's last look is almost always the one that justified its conclusion.
 * A sub-agent that took no screenshots costs exactly nothing here.
 */
export function collectSubAgentImages(messages: Message[], limit = 2): ImageBlock[] {
	if (limit <= 0) return [];
	const found: ImageBlock[] = [];
	// Walk backwards and stop early: a long delegate run can hold dozens of
	// images and there is no reason to materialise them all to discard them.
	for (let i = messages.length - 1; i >= 0 && found.length < limit; i--) {
		const msg = messages[i] as any;
		if (msg?.role !== "toolResult") continue;
		const content = Array.isArray(msg.content) ? msg.content : [];
		for (let j = content.length - 1; j >= 0 && found.length < limit; j--) {
			const part = content[j];
			if (part?.type === "image" && typeof part.data === "string" && part.data.length > 0) {
				found.push({ type: "image", data: part.data, mimeType: part.mimeType ?? "image/png" });
			}
		}
	}
	return found.reverse();
}

export function getDisplayItems(messages: Message[]): DisplayItem[] {
	const errorMap = new Map<string, boolean>();
	for (const msg of messages) {
		if (msg.role === "toolResult") {
			errorMap.set((msg as any).toolCallId, (msg as any).isError);
		}
	}

	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") {
					items.push({
						type: "toolCall",
						id: (part as any).id,
						name: (part as any).name,
						args: (part as any).arguments,
						isError: errorMap.get((part as any).id),
					});
				}
			}
		}
	}
	return items;
}

// --- tool result construction ---

/**
 * build the standard tool result for a piSpawn-based sub-agent.
 * all sub-agent tools should use this instead of constructing
 * return values manually — cost tagging is automatic.
 */
export function subAgentResult(
	text: string,
	details: SingleResult,
	isError = false,
	images: ImageBlock[] = [],
): {
	content: Array<{ type: "text"; text: string } | ImageBlock>;
	details: SingleResult & ToolCostDetails;
	isError?: boolean;
} {
	return {
		// Images first, then the text: the model should have seen the picture
		// before it reads the claim the sub-agent made about it.
		content: [...images, { type: "text" as const, text: text + resultFooter(details) }],
		details: { ...details, cost: details.usage.cost },
		...(isError && { isError: true }),
	};
}

export function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}...` : text;
}

/** the first line of a prompt, clipped: the label when the caller gave none. */
export function firstLine(prompt: string, fallback: string): string {
	const line = prompt.trim().split("\n")[0]?.trim() ?? "";
	return line ? clip(line, 60) : fallback;
}

/** renderResult for a sub-agent tool: the agent tree, or the plain text when there are no details. */
export function renderSubAgentResult(label: string) {
	return (result: any, { expanded }: { expanded: boolean }, theme: any, context: any) => {
		const container = context?.lastComponent ?? new Container();
		container.clear();
		const details = result.details as SingleResult | undefined;
		if (!details) {
			const text = result.content?.[0];
			container.addChild(new Text(text?.type === "text" ? normalizeForDisplay(text.text) : "(no output)", 0, 0));
			return container;
		}
		renderAgentTree(details, container, expanded, theme, { label, header: "statusOnly" });
		return container;
	};
}

// --- formatting ---

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

export function formatUsageStats(
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; contextTokens?: number; turns?: number },
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

function shortenPath(p: string): string {
	const home = os.homedir();
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function toolLabel(name: string): string {
	return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * one-line summary of a tool call's arguments.
 *
 * exported so the sub-agent inspector renders tool calls identically to the
 * collapsed tree — two implementations would drift.
 */
export function toolArgSummary(toolName: string, args: Record<string, unknown>): string {
	switch (toolName) {
		case "bash": {
			const command = (args.cmd || args.command || "...") as string;
			return command.split("\n")[0];
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			let text = shortenPath(rawPath);
			const readRange = args.read_range as [number, number] | undefined;
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			if (readRange) {
				text += `:${readRange[0]}-${readRange[1]}`;
			} else if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += `:${startLine}${endLine ? `-${endLine}` : ""}`;
			}
			return text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = shortenPath(rawPath);
			if (lines > 1) text += ` (${lines} lines)`;
			return text;
		}
		case "edit":
			return shortenPath((args.file_path || args.path || "...") as string);
		case "ls":
			return shortenPath((args.path || ".") as string);
		case "find": {
			const pattern = (args.filePattern || args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return `${pattern} in ${shortenPath(rawPath)}`;
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return `/${pattern}/ in ${shortenPath(rawPath)}`;
		}
		default:
			return JSON.stringify(args);
	}
}

function renderToolLine(
	item: DisplayItem & { type: "toolCall" },
	fg: (color: any, text: string) => string,
): string {
	const icon =
		item.isError === true ? fg("error", "✕") :
		item.isError === false ? fg("success", "✓") :
		fg("muted", "⋯");
	return `${icon} ${fg("accent", toolLabel(item.name))} ${fg("dim", normalizeForDisplay(toolArgSummary(item.name, item.args)))}`;
}

class Line {
	private width = -1;
	private lines: string[] = [];
	private readonly text: string;

	constructor(text: string) {
		const cut = text.indexOf("\n");
		this.text = cut === -1 ? text : text.slice(0, cut);
	}

	render(width: number): string[] {
		if (width !== this.width) {
			this.width = width;
			this.lines = [truncateToWidth(this.text, width)];
		}
		return this.lines;
	}

	invalidate(): void {
		this.width = -1;
	}
}

// --- tree rendering ---

const COLLAPSED_ITEM_COUNT = 10;

export function renderAgentTree(
	r: SingleResult,
	container: Container,
	showExpanded: boolean,
	theme: any,
	labelOrOpts?: string | { label?: string; header?: "full" | "statusOnly" },
): void {
	const fg = theme.fg.bind(theme);
	const opts = typeof labelOrOpts === "string" ? { label: labelOrOpts, header: "full" as const } : { label: labelOrOpts?.label, header: labelOrOpts?.header ?? "full" as const };
	const MID = fg("muted", "├── ");
	const END = fg("muted", "╰── ");
	const CONT = fg("muted", "│   ");
	const mdTheme = getMarkdownTheme();

	const isError = r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";
	const icon = r.exitCode === -1
		? fg("warning", "⋯")
		: isError ? fg("error", "✕") : fg("success", "✓");

	if (opts.header === "statusOnly") {
		let header = icon;
		if (isError && r.stopReason) header += ` ${fg("error", `[${r.stopReason}]`)}`;
		container.addChild(new Text(header, 0, 0));
	} else {
		let header = `${icon} ${fg("toolTitle", theme.bold(opts.label ?? r.agent))}`;
		if (isError && r.stopReason) header += ` ${fg("error", `[${r.stopReason}]`)}`;
		container.addChild(new Text(header, 0, 0));
	}

	if (isError && r.errorMessage) {
		container.addChild(new Text(MID + fg("error", `Error: ${normalizeForDisplay(r.errorMessage)}`), 0, 0));
	}

	const displayItems = getDisplayItems(r.messages);
	const toolCalls = displayItems.filter(
		(d): d is DisplayItem & { type: "toolCall" } => d.type === "toolCall",
	);
	const finalOutput = getFinalOutput(r.messages);

	type TreeChild =
		| { kind: "text"; content: string }
		| { kind: "tool"; item: DisplayItem & { type: "toolCall" } }
		| { kind: "summary"; output: string };
	const children: TreeChild[] = [];

	if (showExpanded) children.push({ kind: "text", content: normalizeForDisplay(r.task) });

	const visibleTools = showExpanded ? toolCalls : toolCalls.slice(-COLLAPSED_ITEM_COUNT);
	const skippedTools = showExpanded ? 0 : toolCalls.length - visibleTools.length;
	if (skippedTools > 0) children.push({ kind: "text", content: `... ${skippedTools} earlier calls` });
	for (const tc of visibleTools) children.push({ kind: "tool", item: tc });
	if (finalOutput) children.push({ kind: "summary", output: finalOutput.trim() });

	if (children.length === 0) {
		container.addChild(new Text(END + fg("muted", "(no output)"), 0, 0));
	} else {
		for (let i = 0; i < children.length; i++) {
			const child = children[i];
			const isLast = i === children.length - 1;
			const connector = isLast ? END : MID;

			if (child.kind === "text") {
				container.addChild(new Text(connector + fg("dim", normalizeForDisplay(child.content)), 0, 0));
			} else if (child.kind === "tool") {
				container.addChild(new Line(connector + renderToolLine(child.item, fg)));
			} else if (child.kind === "summary") {
				container.addChild(new Text(connector + fg("muted", "Summary:"), 0, 0));
				const indent = isLast ? "    " : CONT;
				container.addChild(new Text(indent, 0, 0));
				// normalizeForDisplay: subagent summaries are arbitrary model text —
				// same width-desync class as tool output (see box-format.ts)
				container.addChild(new Markdown(normalizeForDisplay(child.output), 0, 0, mdTheme));
			}
		}
	}

	if (!showExpanded && toolCalls.length > COLLAPSED_ITEM_COUNT) {
		container.addChild(new Text(fg("muted", "(Ctrl+O to expand)"), 0, 0));
	}

	const usageStr = formatUsageStats(r.usage, modelLabel(r));
	if (usageStr) container.addChild(new Text(fg("dim", usageStr), 0, 0));
}
