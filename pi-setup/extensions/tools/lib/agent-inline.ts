import { Box, Container, Text, truncateToWidth, type Component } from "@mariozechner/pi-tui";
import { formatTokens, freshTokens, identityColor, shortModel } from "./agent-style";
import type { Styler } from "./agent-layout";
import { normalizeForDisplay } from "./box-format";
import {
	clip,
	formatDuration,
	getDisplayItems,
	isBackgroundStub,
	Line,
	renderAgentTree,
	renderToolLine,
	type BackgroundStub,
	type DisplayItem,
	type SingleResult,
} from "./sub-agent-render";

type ToolCallItem = DisplayItem & { type: "toolCall" };

/** The agent tools draw their own rows: no tinted box around a calm log line. */
export const AGENT_SHELL = "self" as const;

const ACTIVITY_ROWS = 3;

interface RowState {
	launched?: boolean;
}

/** The call header, which a background launch replaces by its own single line. */
class CallLine implements Component {
	private text = "";
	private state?: RowState;
	private cache?: { width: number; hidden: boolean; lines: string[] };

	update(text: string, state: RowState | undefined): void {
		if (text !== this.text) this.cache = undefined;
		this.text = text;
		this.state = state;
	}

	render(width: number): string[] {
		const hidden = this.state?.launched === true;
		if (this.cache?.width === width && this.cache.hidden === hidden) return this.cache.lines;
		const lines = hidden ? [] : [truncateToWidth(this.text.split("\n")[0] ?? "", width)];
		this.cache = { width, hidden, lines };
		return lines;
	}

	invalidate(): void {
		this.cache = undefined;
	}
}

export function renderAgentCall(title: string, detail: string, theme: Styler, context: any, note = ""): Component {
	const line = context?.lastComponent instanceof CallLine ? context.lastComponent : new CallLine();
	const pad = " ".repeat(context?.outputPad ?? 1);
	const header = `${pad}${theme.fg("toolTitle", theme.bold(`${title} `))}${theme.fg("dim", normalizeForDisplay(clip(detail, 80)))}`;
	line.update(note ? `${header}${theme.fg("muted", ` ${note}`)}` : header, context?.state);
	return line;
}

export const fileCount = (files: unknown): string => (Array.isArray(files) && files.length > 0 ? `(${files.length} file${files.length > 1 ? "s" : ""})` : "");

function launchLine(details: BackgroundStub, theme: Styler, pad: number): Component {
	const color = identityColor(details.agent);
	const model = shortModel(details.model);
	return new Line(
		`${" ".repeat(pad)}${theme.fg(color, "◐")} ${theme.fg(color, theme.bold(details.agent))}  ${normalizeForDisplay(details.task)}` +
			(model ? theme.fg("dim", ` · ${model}`) : ""),
	);
}

function addProgress(container: Container, details: SingleResult, theme: Styler, pad: number, durationMs: number | undefined): void {
	const indent = `${" ".repeat(pad)}  `;
	const dim = (text: string) => theme.fg("dim", text);
	const running = details.exitCode === -1;
	const failed = !running && (details.exitCode !== 0 || details.stopReason === "error" || details.stopReason === "aborted");
	const calls = getDisplayItems(details.messages).filter((item): item is ToolCallItem => item.type === "toolCall");
	if (running) {
		for (const item of calls.slice(-ACTIVITY_ROWS)) container.addChild(new Line(`${indent}${renderToolLine(item, theme.fg.bind(theme))}`));
	}
	const tokens = freshTokens(details.usage);
	const facts = [
		`${theme.bold(String(calls.length))}${dim(calls.length === 1 ? " tool use" : " tool uses")}`,
		tokens > 0 ? dim(`${formatTokens(tokens)} tokens`) : "",
		!running && durationMs !== undefined ? dim(formatDuration(durationMs)) : "",
	].filter(Boolean);
	const joined = facts.join(dim(" · "));
	const line = running
		? `${dim("In progress… · ")}${joined}${dim(" · (ctrl+o to expand)")}`
		: `${theme.fg(failed ? "error" : "dim", failed ? "Failed" : "Done")} ${dim("(")}${joined}${dim(")")}`;
	container.addChild(new Line(indent + line));
	if (failed && details.errorMessage) container.addChild(new Line(indent + theme.fg("error", normalizeForDisplay(details.errorMessage.split("\n")[0] ?? ""))));
}

/** renderResult for the six agent tools: one line for a background launch, Claude Code's block for a blocking call. */
export function renderAgentRunResult(label: string, summary?: (details: SingleResult) => string | undefined) {
	return (result: any, { expanded }: { expanded: boolean }, theme: Styler, context: any): Component => {
		const pad: number = context?.outputPad ?? 1;
		const details = result.details as SingleResult | undefined;
		if (context?.state) (context.state as RowState).launched = isBackgroundStub(details);
		if (isBackgroundStub(details)) return launchLine(details, theme, pad);
		if (!details) {
			const text = result.content?.[0];
			return new Text(text?.type === "text" ? normalizeForDisplay(text.text) : "(no output)", pad, 0);
		}
		const extra = summary?.(details);
		if (expanded) {
			const box = new Box(pad, 0);
			if (extra) box.addChild(new Text(theme.fg("accent", extra), 0, 0));
			renderAgentTree(details, box, true, theme, { label, header: "statusOnly" });
			return box;
		}
		const container = new Container();
		if (extra) container.addChild(new Line(`${" ".repeat(pad)}  ${theme.fg("accent", extra)}`));
		addProgress(container, details, theme, pad, context?.durationMs);
		return container;
	};
}
