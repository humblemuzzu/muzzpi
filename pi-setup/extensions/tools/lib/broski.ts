/**
 * What the Broski phone app reads of this extension's background work, in the shapes of Broski's contract
 * (Broski's `docs/architecture/backends/pi/extension-hints.md`):
 *
 * - the running agents and bash jobs, announced whole on `broski:tasks` each time the list changes. Broski keeps a
 *   session open while the list is not empty; without it a session nobody views is closed a minute after its turn
 *   ends, and the agents and jobs die with its `pi`.
 * - a `details.broski` hint on each result message, so the phone shows it as an agent's or a job's report.
 *
 * Broski's own extensions relay both (in the `pi` it hosts and in a terminal `pi` it links); with no Broski, nobody
 * listens. Values past Broski's bounds are cut here, since Broski drops a task or a hint that does not fit.
 */

import type { RunSnapshot, RunStatus } from "./agent-channel";
import { runReportText, type RunReport } from "./agent-notice";
import type { JobReport } from "./bash-jobs";

export const BROSKI_TASKS_CHANNEL = "broski:tasks";

const MAX_ID_CHARS = 256;
const MAX_NAME_CHARS = 1_024;
const BASH_AGENT = "bash";

export interface BroskiTask {
	id: string;
	kind: "agent" | "task";
	title: string;
	command?: string;
	startedAt?: number;
}

type ActivityStatus = "running" | "completed" | "failed" | "stopped";

export interface BroskiActivity {
	kind: "agent" | "task";
	title: string;
	status?: ActivityStatus;
	command?: string;
	durationMs?: number;
	exitCode?: number;
	body?: { format: "markdown" | "log"; text: string };
}

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
const name = (text: string) => cut(oneLine(text), MAX_NAME_CHARS);

/** the runs and jobs still going, in the order they were started. */
export function broskiTasks(runs: readonly RunSnapshot[]): BroskiTask[] {
	return runs
		.filter((run) => run.status === "queued" || run.status === "running")
		.filter((run) => run.id.length <= MAX_ID_CHARS)
		.map((run) =>
			run.agent === BASH_AGENT
				? { id: run.id, kind: "task" as const, title: name(run.label || run.id), ...(run.command && { command: run.command }), startedAt: run.startedAt ?? run.queuedAt }
				: { id: run.id, kind: "agent" as const, title: name(`${run.agent}: ${run.label || run.id}`), startedAt: run.startedAt ?? run.queuedAt },
		);
}

function statusOf(status: RunStatus): ActivityStatus {
	if (status === "done") return "completed";
	if (status === "failed") return "failed";
	if (status === "queued" || status === "running") return "running";
	return "stopped";
}

/** the worst of several: one failure makes the batch failed. */
function worst(statuses: readonly ActivityStatus[]): ActivityStatus {
	for (const status of ["failed", "stopped", "running"] as const) if (statuses.includes(status)) return status;
	return "completed";
}

/** finished agents, as one report row. */
export function agentActivity(reports: readonly RunReport[]): BroskiActivity | undefined {
	if (reports.length === 0) return undefined;
	const [only] = reports;
	const body = { format: "markdown" as const, text: reports.map(runReportText).join("\n\n") };
	if (reports.length === 1 && only) {
		return { kind: "agent", title: name(`${only.agent}: ${only.label}`), status: statusOf(only.status), durationMs: Math.max(0, Math.round(only.durationMs)), body };
	}
	return {
		kind: "agent",
		title: name(`${reports.length} agents reported back: ${reports.map((report) => report.agent).join(", ")}`),
		status: worst(reports.map((report) => statusOf(report.status))),
		body,
	};
}

/** bash job news, as one report row: a job's end, or a `wake_on` line while it runs on. */
export function jobActivity(reports: readonly JobReport[]): BroskiActivity | undefined {
	if (reports.length === 0) return undefined;
	const [only] = reports;
	const body = { format: "log" as const, text: reports.map((report) => report.text).join("\n\n") };
	if (reports.length === 1 && only) {
		const status = only.kind === "matched" ? "running" : statusOf(only.status);
		return {
			kind: "task",
			title: name(only.text.split("\n")[0] ?? only.id),
			status,
			command: only.command,
			durationMs: Math.max(0, Math.round(only.durationMs)),
			...(only.exitCode !== undefined && { exitCode: only.exitCode }),
			body,
		};
	}
	return {
		kind: "task",
		title: name(`${reports.length} background jobs reported back`),
		status: worst(reports.map((report) => (report.kind === "matched" ? "running" : statusOf(report.status)))),
		body,
	};
}
