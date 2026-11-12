import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Container, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { renderRunCards } from "./lib/agent-card";
import type { AgentResultDetails } from "./lib/agent-notice";
import type { AgentRuns } from "./lib/agent-runs";
import type { BashJobs } from "./lib/bash-jobs";
import { normalizeForDisplay } from "./lib/box-format";
import { stringList } from "./lib/params";
import { SUB_AGENT_TOOLS_ENV } from "./lib/sub-agent-prompt";

const ACTIONS = ["list", "stop"] as const;

/** a sub-agent starts no agents of its own, so there the tool covers its bash jobs only */
export function createAgentsTool(runs: AgentRuns, jobs: BashJobs): ToolDefinition {
	const child = !!process.env[SUB_AGENT_TOOLS_ENV]?.trim();
	const what = child
		? "The background bash jobs of this session, by job id (bash-…)."
		: "The sub-agents and background bash jobs of this session, by continueId or job id (bash-…).";
	return {
		name: "agents",
		label: "Agents",
		description:
			`${what} list: one line each. stop: stops the given ids, or ["all"]. ` +
			"There is no wait: every result arrives by itself. If nothing else is left to do, end your turn; the result starts your next one.",
		parameters: Type.Object({
			action: Type.Unsafe<(typeof ACTIONS)[number]>({ type: "string", enum: [...ACTIONS], description: "list or stop." }),
			ids: Type.Optional(Type.Array(Type.String(), { description: `stop only: ${child ? "job ids" : "continueIds or job ids"}, or ["all"].` })),
		}),

		async execute(_toolCallId, params: any) {
			const ids = stringList(params.ids);
			const all = ids.includes("all");
			const jobIds = ids.filter((id) => jobs.has(id));
			const runIds = ids.filter((id) => !jobs.has(id));
			const join = (...parts: string[]) => parts.filter(Boolean).join("\n\n");
			if (params.action === "stop") {
				if (ids.length === 0) return { content: [{ type: "text", text: 'Name the ids to stop, or ["all"].' }], details: { runs: [], jobs: [] } };
				const [agentsDone, jobsDone] = await Promise.all([
					all || runIds.length > 0 ? runs.stop(all ? ["all"] : runIds) : undefined,
					all || jobIds.length > 0 ? jobs.stop(all ? ["all"] : jobIds) : undefined,
				]);
				const text = join(agentsDone?.text ?? "", ...(jobsDone?.parts ?? [])) || "Nothing was running.";
				return { content: [{ type: "text", text }], details: { runs: agentsDone?.details.runs ?? [], jobs: jobsDone?.reports ?? [] } };
			}
			const listed = [runs.list(), ...jobs.list()].filter(Boolean);
			return { content: [{ type: "text", text: listed.join("\n") || "Nothing has run in the background in this session." }], details: undefined };
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
