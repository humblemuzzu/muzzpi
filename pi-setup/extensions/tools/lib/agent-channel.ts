import type { Message } from "@mariozechner/pi-ai";
import type { UsageStats } from "./pi-spawn";

export type RunStatus = "queued" | "running" | "done" | "failed" | "stopped" | "interrupted";

/** the custom message that delivers finished background runs; its `details.runs` are RunReports. */
export const AGENT_RESULT_TYPE = "agent-result";

/** `pi.events` channel carrying a RunSnapshot[] of this session's agent runs whenever one changes. */
export const AGENT_RUNS_CHANNEL = "muzzpi:agent-runs";

export interface RunSnapshot {
	id: string;
	agent: string;
	label: string;
	status: RunStatus;
	background: boolean;
	queuedAt: number;
	startedAt?: number;
	endedAt?: number;
	activity?: string;
	model?: string;
	thinkingLevel?: string;
	usage: UsageStats;
	toolCount: number;
	files: string[];
	messages: Message[];
	stopReason?: string;
	errorMessage?: string;
}
