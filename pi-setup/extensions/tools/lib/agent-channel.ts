import type { Message } from "@mariozechner/pi-ai";
import type { UsageStats } from "./pi-spawn";

export type RunStatus = "queued" | "running" | "done" | "failed" | "stopped" | "interrupted";

/** the custom message that delivers finished background runs; its `details.runs` are RunReports. */
export const AGENT_RESULT_TYPE = "agent-result";

/** `pi.events` channel carrying a RunSnapshot[] of this session's agent runs whenever one changes. */
export const AGENT_RUNS_CHANNEL = "muzzpi:agent-runs";

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
}
