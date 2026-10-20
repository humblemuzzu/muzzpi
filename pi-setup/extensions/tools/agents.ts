import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Container, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { renderRunCards } from "./lib/agent-card";
import type { AgentResultDetails } from "./lib/agent-notice";
import { MAX_WAIT_SEC, type AgentRuns } from "./lib/agent-runs";
import { normalizeForDisplay } from "./lib/box-format";
import { stringList } from "./lib/params";

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

/** a card per run; the answers when expanded. */
export function renderAgentResult(
	message: { content: unknown; details?: unknown },
	{ expanded, outputPad }: { expanded: boolean; outputPad: number },
	theme: any,
) {
	const runs = (message.details as AgentResultDetails | undefined)?.runs;
	if (!Array.isArray(runs)) {
		const container = new Container();
		const text = typeof message.content === "string" ? message.content : "";
		container.addChild(new Text(normalizeForDisplay(text), outputPad, 0));
		return container;
	}
	return renderRunCards(runs, expanded, theme, outputPad);
}
