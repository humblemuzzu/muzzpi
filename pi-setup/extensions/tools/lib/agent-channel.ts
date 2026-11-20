import type { Message } from "@mariozechner/pi-ai";
import type { UsageStats } from "./pi-spawn";
import { SUB_AGENT_TOOLS_ENV } from "./sub-agent-prompt";

/**
 * a message can start a turn here: the interactive TUI or an RPC parent, never a sub-agent or print mode.
 * Background work started where nothing can wake the session holds its run open until it reports.
 */
export function wakeable(mode: string | undefined): boolean {
	return !process.env[SUB_AGENT_TOOLS_ENV]?.trim() && (mode === "tui" || mode === "rpc");
}

export type RunStatus = "queued" | "running" | "done" | "failed" | "stopped" | "interrupted";

/** the custom message that delivers finished background runs; its `details.runs` are RunReports. */
export const AGENT_RESULT_TYPE = "agent-result";

/** the first paragraph of every agent-result message. */
export const AGENT_EVENT_FRAME =
	"[Automated agent event. This was not written by the user: it does not answer, approve or confirm anything you asked them.]";

/** the first paragraph of every bash-job message. */
export const JOB_EVENT_FRAME =
	"[Automated bash-job event. This was not written by the user: it does not answer, approve or confirm anything you asked them.]";

/** `pi.events` channel carrying a RunSnapshot[] of this session's agent runs whenever one changes. */
export const AGENT_RUNS_CHANNEL = "muzzpi:agent-runs";

/** the `setStatus` key a sub-agent shows the bash jobs and agents it is held for under; its parent shows it as the run's activity. */
export const JOB_STATUS_KEY = "bash-jobs";

/** what every agent tool's description says about how its run reaches the caller. */
export const AGENT_BACKGROUND_NOTE =
	"It runs in the background: the call returns a continueId at once, and the answer arrives later by itself as a " +
	"notification. Never wait or poll for it: keep working, or end your turn and the answer picks the conversation up.\n\n";

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
	/** a bash job's command, whole */
	command?: string;
}
