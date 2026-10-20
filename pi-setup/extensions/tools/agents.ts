import { getMarkdownTheme, type ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { toolCallCount, type AgentResultDetails, type RunReport } from "./lib/agent-notice";
import { MAX_WAIT_SEC, type AgentRuns } from "./lib/agent-runs";
import { normalizeForDisplay } from "./lib/box-format";
import { stringList } from "./lib/params";
import { formatDuration, formatUsageStats, getFinalOutput, Line } from "./lib/sub-agent-render";

const ACTIONS = ["list", "wait", "stop"] as const;

export function createAgentsTool(runs: AgentRuns): ToolDefinition {
	return {
		name: "agents",
		label: "Agents",
		description:
			"The sub-agents of this session, by continueId. list: one line each. stop: stops the given ids, or [\"all\"]. " +
			"wait: blocks until the given ids (default: every running or unreported one) finish or `timeout` passes, and returns their results; " +
			"use it only when nothing else can be done, since results arrive by themselves.",
		parameters: Type.Object({
			action: Type.Unsafe<(typeof ACTIONS)[number]>({ type: "string", enum: [...ACTIONS], description: "list, wait or stop." }),
			ids: Type.Optional(Type.Array(Type.String(), { description: "continueIds; stop also takes [\"all\"]." })),
			timeout: Type.Optional(Type.Number({ description: `wait only: seconds, at most ${MAX_WAIT_SEC} (the default).` })),
		}),

		async execute(_toolCallId, params: any, signal) {
			const ids = stringList(params.ids);
			if (params.action === "stop" || params.action === "wait") {
				const timeout = typeof params.timeout === "number" && params.timeout > 0 ? params.timeout : MAX_WAIT_SEC;
				const { text, details } = params.action === "stop" ? await runs.stop(ids) : await runs.wait(ids, timeout, signal);
				return { content: [{ type: "text", text }], details };
			}
			return { content: [{ type: "text", text: runs.list() }], details: undefined };
		},
	};
}

const ICONS: Record<RunReport["status"], [color: string, icon: string]> = {
	queued: ["muted", "…"],
	running: ["warning", "⋯"],
	done: ["success", "✓"],
	failed: ["error", "✕"],
	stopped: ["warning", "■"],
	interrupted: ["warning", "↯"],
};

/** a header line per run; the answers when expanded. */
export function renderAgentResult(
	message: { content: unknown; details?: unknown },
	{ expanded, outputPad }: { expanded: boolean; outputPad: number },
	theme: any,
) {
	const container = new Container();
	const pad = " ".repeat(outputPad);
	const runs = (message.details as AgentResultDetails | undefined)?.runs;
	if (!Array.isArray(runs)) {
		const text = typeof message.content === "string" ? message.content : "";
		container.addChild(new Text(normalizeForDisplay(text), outputPad, 0));
		return container;
	}
	const markdown = getMarkdownTheme();
	for (const run of runs) {
		const [color, icon] = ICONS[run.status] ?? ICONS.done;
		const facts = [run.status, formatDuration(run.durationMs), toolCallCount(run.toolCount), formatUsageStats(run.usage)].filter(Boolean).join(" · ");
		container.addChild(new Line(`${pad}${theme.fg(color, icon)} ${theme.fg("toolTitle", theme.bold(run.agent))} ${normalizeForDisplay(run.label)} ${theme.fg("dim", `· ${facts}`)}`));
		if (!expanded) continue;
		const answer = run.status === "done" ? getFinalOutput(run.messages) : run.errorMessage ?? "";
		if (answer.trim()) container.addChild(new Markdown(normalizeForDisplay(answer.trim()), outputPad + 2, 0, markdown));
	}
	if (!expanded) container.addChild(new Line(`${pad}${theme.fg("muted", "(Ctrl+O to expand)")}`));
	return container;
}
