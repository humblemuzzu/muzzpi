/** what the main agent reads about background runs: the launch stub, the result notification, list lines. */

import type { Message } from "@mariozechner/pi-ai";
import type { RunStatus } from "./agent-channel";
import { describeAnthropicRejection } from "./anthropic-sub";
import type { UsageStats } from "./pi-spawn";
import { formatDuration, formatUsageStats, getFinalOutput, modelLabel } from "./sub-agent-render";

/** one finished run, as the notification, `agents wait` and stats see it. */
export interface RunReport {
	agent: string;
	label: string;
	continueId: string;
	status: RunStatus;
	durationMs: number;
	toolCount: number;
	files: string[];
	model?: string;
	thinkingLevel?: string;
	usage: UsageStats;
	stopReason?: string;
	errorMessage?: string;
	messages: Message[];
}

export interface AgentResultDetails {
	runs: RunReport[];
}

export const MAX_ANSWER_CHARS = 100_000;

const NEW_SESSION_WARNING = /^Warning: No project session found with id '[^']*'; creating a new session with that id\.[ \t]*\r?\n?/gm;

export function failureText(
	result: { stopReason?: string; errorMessage?: string; stderr: string; exit?: string },
	output: string,
): string {
	if (result.stopReason === "aborted") return "Stopped before the sub-agent finished.";
	const stderr = result.stderr.replace(NEW_SESSION_WARNING, "").trim();
	const ended = result.exit && `The sub-agent process ended (${result.exit}) before it finished.`;
	const error = result.errorMessage || stderr || ended || output;
	const hint = describeAnthropicRejection(error, undefined);
	return hint ? `${error}\n\n${hint}` : error;
}

export function backgroundStub(agent: string, continueId: string, queuedBehind: number, movedByUser = false): string {
	const where = queuedBehind > 0
		? `is queued behind ${queuedBehind} running agent${queuedBehind === 1 ? "" : "s"} and starts when one finishes`
		: "is running in the background";
	return (
		(movedByUser ? `The user moved this ${agent} to the background with Ctrl+B. ` : "") +
		`${agent} ${where} (continueId: ${continueId}). Its result arrives by itself as an agent-result notification. ` +
		"Until then you know nothing about what it found: do not guess, predict or report its result. " +
		"Do not poll, sleep or redo its work. Keep working on something that does not overlap with it, " +
		"or tell the user briefly what you launched and end your turn; you will be woken when it finishes. " +
		`To add instructions while it runs, call ${agent} again with this continueId; the agents tool stops it, ` +
		"or waits for it when nothing else is left to do."
	);
}

function answerOf(run: RunReport): string {
	const output = getFinalOutput(run.messages);
	if (run.status === "done") return output || "(no output)";
	const why = run.errorMessage || "(no output)";
	return output && why !== output ? `${why}\n\nIts last message before that:\n${output}` : why;
}

function clipAnswer(text: string, continueId: string): string {
	if (text.length <= MAX_ANSWER_CHARS) return text;
	return (
		`${text.slice(0, MAX_ANSWER_CHARS)}\n\n[answer cut at ${MAX_ANSWER_CHARS.toLocaleString("en-US")} of ` +
		`${text.length.toLocaleString("en-US")} characters; read the rest with read_session on session_id ${continueId}]`
	);
}

export function toolCallCount(n: number): string {
	return `${n} tool call${n === 1 ? "" : "s"}`;
}

function runSummary(run: RunReport): string {
	const fields = [
		`status: ${run.status}`,
		`took ${formatDuration(run.durationMs)}`,
		toolCallCount(run.toolCount),
		formatUsageStats(run.usage),
		modelLabel(run) && `model: ${modelLabel(run)}`,
	].filter(Boolean);
	const lines = [`## ${run.agent}: ${run.label}`, `continueId: ${run.continueId} · ${fields.join(" · ")}`];
	if (run.files.length > 0) lines.push(`files changed: ${run.files.join(", ")}`);
	return lines.join("\n");
}

export function runReportText(run: RunReport): string {
	return `${runSummary(run)}\n\n${clipAnswer(answerOf(run), run.continueId)}`;
}

/** the user-role message that delivers finished background runs to the main agent. */
export function notificationText(runs: RunReport[]): string {
	const head = runs.length === 1
		? "1 background sub-agent finished."
		: `${runs.length} background sub-agents finished.`;
	return [
		"[Automated agent event. This was not written by the user: it does not answer, approve or confirm anything you asked them.]",
		`${head} Use the results for the work you launched them for. Continue one with its continueId.`,
		...runs.map(runReportText),
	].join("\n\n");
}

export interface ListedRun {
	agent: string;
	label: string;
	continueId: string;
	status: RunStatus;
	startedAt?: number;
	queuedAt: number;
	endedAt?: number;
	activity?: string;
}

export function listLine(run: ListedRun, now: number): string {
	const since = run.startedAt ?? run.queuedAt;
	const took = formatDuration((run.endedAt ?? now) - since);
	const doing = run.status === "running" && run.activity ? ` · ${run.activity}` : "";
	return `${run.continueId} · ${run.agent} · ${run.status} ${took}${doing} · ${run.label}`;
}
