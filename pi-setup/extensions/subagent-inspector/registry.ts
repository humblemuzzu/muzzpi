/**
 * the inspector's list of sub-agent runs, from the tools extension's run
 * broadcast. extensions do not share module state, so the broadcast on
 * `pi.events` is the only way the runs reach this extension.
 */

import type { RunSnapshot } from "../tools/lib/agent-channel";
import type { AgentEntry } from "./types";

export const MAX_ENTRIES = 50;

function toEntry(run: RunSnapshot): AgentEntry {
	const startedAt = run.startedAt ?? run.queuedAt;
	return {
		toolCallId: `${run.id}@${startedAt}`,
		toolName: run.agent,
		label: run.label,
		status: run.status === "queued" || run.status === "running" ? "running" : run.status === "done" ? "done" : "error",
		startedAt,
		endedAt: run.endedAt,
		messages: run.messages,
		model: run.model,
		thinkingLevel: run.thinkingLevel,
		stopReason: run.stopReason,
		errorMessage: run.errorMessage,
		usage: run.usage,
	};
}

export class AgentRegistry {
	private entries: AgentEntry[] = [];

	onChange?: () => void;

	sync(runs: readonly RunSnapshot[]): void {
		this.entries = runs.slice(-MAX_ENTRIES).map(toEntry);
		this.onChange?.();
	}

	/** runs in start order, oldest first. */
	list(): AgentEntry[] {
		return this.entries;
	}
}
