import type { Message } from "@mariozechner/pi-ai";
import type { UsageStats } from "./pi-spawn";
import { SUB_AGENT_TOOLS_ENV } from "./sub-agent-prompt";

/** a message can start a turn here: the interactive TUI or an RPC parent, never a sub-agent or print mode */
export function wakeable(mode: string | undefined): boolean {
	return !process.env[SUB_AGENT_TOOLS_ENV]?.trim() && (mode === "tui" || mode === "rpc");
}

export type RunStatus = "queued" | "running" | "done" | "failed" | "stopped" | "interrupted";

/** the custom message that delivers finished background runs; its `details.runs` are RunReports. */
export const AGENT_RESULT_TYPE = "agent-result";

/** `pi.events` channel carrying a RunSnapshot[] of this session's agent runs whenever one changes. */
export const AGENT_RUNS_CHANNEL = "muzzpi:agent-runs";

/** the `setStatus` key a sub-agent shows its running bash jobs under while it is held for them; its parent shows it as the run's activity. */
export const JOB_STATUS_KEY = "bash-jobs";

/** the `setStatus` key a sub-agent's long foreground bash command beats under, so its parent's stall watchdog knows it is alive. */
export const RUN_STATUS_KEY = "bash-running";

/** `pi.events` channel the agents UI sends a ControlRequest on; the answer comes back as `RunSnapshot.control`. */
export const AGENT_CONTROL_CHANNEL = "muzzpi:agent-runs:control";

export type ControlRequest =
	| { action: "steer" | "continue"; id: string; text: string }
	| { action: "stop"; id: string }
	| { action: "stopAll" };

/** what became of the last control request on a run; a refusal is `ok: false` and says why. */
export interface ControlOutcome {
	action: ControlRequest["action"];
	ok: boolean;
	text: string;
	at: number;
}

export function parseControlRequest(value: unknown): ControlRequest | undefined {
	const request = value as { action?: unknown; id?: unknown; text?: unknown } | null;
	if (request?.action === "stopAll") return { action: "stopAll" };
	if (typeof request?.id !== "string" || !request.id) return undefined;
	if (request.action === "stop") return { action: "stop", id: request.id };
	if ((request.action === "steer" || request.action === "continue") && typeof request.text === "string" && request.text.trim()) {
		return { action: request.action, id: request.id, text: request.text.trim() };
	}
	return undefined;
}

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
	stopping: boolean;
	control?: ControlOutcome;
	/** a bash job's latest output lines; agents have `messages` instead */
	output?: string;
}
