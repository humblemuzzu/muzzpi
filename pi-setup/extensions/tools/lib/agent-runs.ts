/**
 * one instance per extension load. `/reload` interrupts the runs, then the
 * reloaded extension continues them and reports what was unreported
 * (`shutdown(true)` / `takeReloadHandoff`); it shares plain data only, since the
 * reload brings a fresh copy of this module.
 */

import { resolve as resolvePath } from "node:path";
import { Type } from "@sinclair/typebox";
import { SUB_AGENT_SESSION_DIR, newSessionId, startChild, unresumableReason, zeroUsage, type ChildRun, type PiSpawnConfig, type PiSpawnResult } from "./pi-spawn";
import { mainRoute, resolveRoute, type AgentModels, type MainModel, type SubAgent } from "./agent-models";
import type { ControlOutcome, ControlRequest, RunSnapshot, RunStatus } from "./agent-channel";
import {
	backgroundStub,
	failureText,
	listLine,
	notificationText,
	runReportText,
	type AgentResultDetails,
	type Overlap,
	type RunReport,
} from "./agent-notice";
import { finishedResult, progressUpdate, sessionIdOf, toolError } from "./run-sub-agent";
import { repairInterrupted, subAgentSessionFile } from "./session-repair";
import { SUB_AGENT_TOOLS_ENV } from "./sub-agent-prompt";
import { clip, getFinalOutput, slimMessages, toolArgSummary, type SingleResult } from "./sub-agent-render";
import { resolveParam } from "./params";

export const AGENT_RUN_ENTRY = "agent-run";
export const MAX_RUNNING = 16;
export const MAX_WAIT_SEC = 600;
const LISTED_FINISHED = 20;
const BATCH_MS = 1_500;
const BROADCAST_MS = 250;
const SHUTDOWN_GRACE_MS = 1_500;
const KILL_WAIT_MS = 1_000;
const HANDOFF_MAX_AGE_MS = 60_000;
const RELOAD_CONTINUE = "The main session reloaded and interrupted you. Continue your task where you left off.";
const RELOADED = "Interrupted by a reload of the main session; it is being continued automatically on the same continueId, and its result arrives as a later notification.";
const STEER_FALLBACK_MS = 15_000;
const STOP_WAIT_MS = 15_000;
const STEER_PREFIX = "Message from the main agent while you work:";
const USER_STEER_PREFIX = "Message from the user while you work:";

/** the session-side effects; each call is wrapped, since a stale session throws. */
export interface RunHost {
	/** `wake`: start a turn when idle, steer when busy; otherwise only add it to the session. */
	notify(content: string, details: AgentResultDetails, wake: boolean): void;
	broadcast(runs: RunSnapshot[]): void;
	record(entry: RunEntry): void;
}

export type RunEntry = Omit<RunReport, "messages" | "files" | "overlaps"> & { startedAt: number };

export interface LaunchSpec {
	agent: SubAgent;
	label: string;
	/** progress text while the child has produced no answer yet. */
	working: string;
	returnImages?: boolean;
	models: AgentModels;
	params: Record<string, unknown>;
	spawn: Omit<PiSpawnConfig, "cwd" | "signal" | "onUpdate" | "onEvent" | "sessionId" | "session" | "model" | "thinkingLevel">;
}

export interface LaunchContext {
	cwd: string;
	mode?: string;
	modelRegistry?: any;
	model?: MainModel;
	sessionManager?: { getSessionId?(): string };
}

interface Run {
	agent: string;
	label: string;
	continueId: string;
	resuming: boolean;
	background: boolean;
	/** called from a codemode script, which cannot be woken: it always blocks. */
	nested: boolean;
	status: RunStatus;
	queuedAt: number;
	startedAt?: number;
	endedAt?: number;
	activity?: string;
	toolCount: number;
	files: string[];
	toolArgs: Map<string, Record<string, unknown>>;
	result: PiSpawnResult;
	failure?: string;
	child?: ChildRun;
	spawn: PiSpawnConfig;
	delivered: boolean;
	interrupting: boolean;
	stopping: boolean;
	stoppedByUser: boolean;
	control?: ControlOutcome;
	ended: Promise<void>;
	markEnded: () => void;
	detach?: () => void;
	onProgress?: () => void;
}

const LIVE: ReadonlySet<RunStatus> = new Set(["queued", "running"]);

export function continueIdOf(params: Record<string, unknown>): string | undefined {
	return resolveParam(params, ["continueId", "continue_id", "sessionId"]);
}

const sleep = (ms: number) => new Promise<void>((resolve) => {
	const timer = setTimeout(resolve, ms);
	timer.unref?.();
});

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function statusOf(run: Run, result: PiSpawnResult): RunStatus {
	if (run.interrupting) return "interrupted";
	if (result.stopReason === "aborted") return "stopped";
	if (result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "stalled") return "failed";
	return "done";
}

const RELOAD_SLOT = Symbol.for("muzzpi.agent-runs.reload");

export interface ReloadHandoff {
	version: 1;
	at: number;
	reports: RunReport[];
	/** the interrupted runs: reported without waking, then continued. */
	interrupted: RunReport[];
	resume: Array<{ agent: string; label: string; continueId: string; spawn: PiSpawnConfig }>;
}

export class AgentRuns {
	private readonly runs: Run[] = [];
	private pending: Run[] = [];
	private batchTimer?: ReturnType<typeof setTimeout>;
	private broadcastTimer?: ReturnType<typeof setTimeout>;
	private closed = false;
	private carried: RunReport[] = [];

	/** false inside a sub-agent and without a host: nothing can wake the caller, so every run blocks. */
	private readonly wakes: boolean;
	/** what an agent tool's description says about running in the background; fixed for the process. */
	readonly backgroundNote: string;

	constructor(private host?: RunHost, private readonly sessionDir: string = SUB_AGENT_SESSION_DIR) {
		this.wakes = !!host && !process.env[SUB_AGENT_TOOLS_ENV]?.trim();
		this.backgroundNote = this.wakes
			? "Unless this session cannot be woken (print mode), it runs in the background: the call returns a continueId at once, and the answer arrives later as a notification that wakes you.\n\n"
			: "";
	}

	static takeReloadHandoff(): ReloadHandoff | undefined {
		const slot = globalThis as { [RELOAD_SLOT]?: ReloadHandoff };
		const handoff = slot[RELOAD_SLOT];
		delete slot[RELOAD_SLOT];
		if (handoff?.version !== 1 || Date.now() - handoff.at > HANDOFF_MAX_AGE_MS) return undefined;
		return handoff;
	}

	/** reports what the reloaded-away instance left unreported, and continues its interrupted runs. */
	adoptReload(handoff: ReloadHandoff): void {
		if (this.closed) return;
		if (handoff.interrupted.length > 0) {
			const quiet = handoff.interrupted;
			this.call((host) => host.notify(notificationText(quiet), { runs: quiet }, false));
		}
		this.carried.push(...handoff.reports);
		for (const entry of handoff.resume) {
			const run = this.newRun(entry.agent, entry.label, entry.continueId, true, true, { ...entry.spawn, task: RELOAD_CONTINUE });
			this.runs.push(run);
		}
		if (this.carried.length > 0) this.batchTimer ??= setTimeout(() => this.flush(), BATCH_MS);
		this.changed();
		this.pump();
	}

	params(agent: string) {
		const continueId = Type.Optional(
			Type.String({
				description:
					`A continueId an earlier ${agent} returned. While that ${agent} runs, the prompt reaches it as a new instruction; ` +
					"once it has finished, it continues with its full history.",
			}),
		);
		if (!this.wakes) return { continueId };
		const background = Type.Optional(
			Type.Boolean({
				description:
					"Default true. false blocks until the answer; use it only when nothing else can happen first. Calls from codemode scripts always block.",
			}),
		);
		return { continueId, background };
	}

	private canBackground(ctx: LaunchContext): boolean {
		return this.wakes && (ctx.mode === "tui" || ctx.mode === "rpc");
	}

	async launch(spec: LaunchSpec, toolCallId: string, ctx: LaunchContext, signal?: AbortSignal, onUpdate?: (update: any) => void): Promise<any> {
		if (this.closed) return toolError("This session is closing; no new agent can start in it.");
		const continueId = continueIdOf(spec.params);
		if (continueId) {
			const live = this.latest(continueId);
			if (live && LIVE.has(live.status)) {
				if (live.agent !== spec.agent) {
					return toolError(`continueId "${continueId}" belongs to a running ${live.agent}, not a ${spec.agent}. Pass it to ${live.agent}.`);
				}
				const steered = await this.steer(live, spec.spawn.task);
				if (steered !== "finished") return steered;
			}
			const refusal = unresumableReason(continueId, ctx.cwd, spec.agent, this.sessionDir);
			if (refusal) return toolError(refusal);
		}
		const route = resolveRoute(spec.models, spec.agent, spec.params, ctx.modelRegistry, !!continueId, mainRoute(ctx.model));
		if ("error" in route) return toolError(route.error);

		const nested = toolCallId.includes("/");
		const background = spec.params.background !== false && !nested && this.canBackground(ctx);
		const id = continueId ?? newSessionId(spec.agent);
		const run = this.add(spec, id, !!continueId, background, {
			...spec.spawn,
			cwd: ctx.cwd,
			sessionId: sessionIdOf(ctx),
			model: route.model,
			thinkingLevel: route.thinking,
			agentModels: spec.models,
			session: { id, dir: this.sessionDir },
		});
		run.nested = nested;
		this.pump();
		if (background) return this.stub(run);
		return this.attend(run, spec, signal, onUpdate);
	}

	detachForeground(): boolean {
		if (this.closed) return false;
		const attached = this.runs.filter((run) => !run.background && !run.nested && LIVE.has(run.status) && run.detach);
		for (const run of attached) {
			run.background = true;
			run.detach!();
		}
		if (attached.length > 0) this.changed();
		return attached.length > 0;
	}

	async stop(ids: string[]): Promise<{ text: string; details: AgentResultDetails }> {
		const none = (text: string) => ({ text, details: { runs: [] } });
		if (ids.length === 0) return none('Name the continueIds to stop, or ["all"].');
		const all = ids.includes("all");
		const targets = this.runs.filter((run) => LIVE.has(run.status) && (all || ids.includes(run.continueId)));
		if (targets.length === 0) return none(all ? "No agent is running." : `None of ${ids.join(", ")} is running.`);
		for (const run of targets) {
			run.delivered = true;
			this.pending = this.pending.filter((p) => p !== run);
			this.requestStop(run);
		}
		await Promise.race([Promise.all(targets.map((run) => run.ended)), sleep(STOP_WAIT_MS)]);
		const reports: RunReport[] = [];
		const parts = targets.map((run) => {
			if (LIVE.has(run.status)) return `${run.continueId}: still stopping`;
			const report = this.report(run);
			reports.push(report);
			return runReportText(report);
		});
		return { text: parts.join("\n\n"), details: { runs: reports } };
	}

	/** a request from the agents UI. The answer goes back on the broadcast, on the run it concerns. */
	async control(request: ControlRequest): Promise<void> {
		if (this.closed) return;
		if (request.action === "stopAll") {
			for (const run of this.runs) if (run.background && LIVE.has(run.status)) this.requestStop(run, true);
			return;
		}
		const run = this.latest(request.id);
		if (!run) return;
		if (request.action === "stop") {
			if (LIVE.has(run.status)) this.requestStop(run, true);
			else this.answer(run, "stop", false, `${run.continueId} has already ${run.status === "done" ? "finished" : run.status}.`);
			return;
		}
		if (request.action === "steer") {
			const steered = LIVE.has(run.status) ? await this.steer(run, request.text, USER_STEER_PREFIX) : "finished";
			if (steered === "finished") this.answer(run, "steer", false, `${run.continueId} has finished; continue it instead.`);
			else this.answer(run, "steer", steered.isError !== true, steered.isError ? steered.content[0].text : "Sent; it reads this before its next step.");
			return;
		}
		this.continueRun(run, request.text);
	}

	private continueRun(previous: Run, text: string): void {
		const refusal = LIVE.has(previous.status)
			? `${previous.continueId} is still running; steer it instead.`
			: !previous.spawn.cwd
				? `${previous.continueId} ran in an earlier session; ask the main agent to continue it by continueId.`
				: unresumableReason(previous.continueId, previous.spawn.cwd, previous.agent, this.sessionDir);
		if (refusal) return this.answer(previous, "continue", false, refusal);
		const run = this.newRun(previous.agent, previous.label, previous.continueId, true, true, { ...previous.spawn, task: text, followUp: undefined });
		run.control = { action: "continue", ok: true, text: "Continuing with your message.", at: Date.now() };
		this.runs.push(run);
		this.changed();
		this.pump();
	}

	private answer(run: Run, action: ControlOutcome["action"], ok: boolean, text: string): void {
		run.control = { action, ok, text, at: Date.now() };
		this.changed();
	}

	private requestStop(run: Run, byUser = false): void {
		if (run.stopping || !LIVE.has(run.status)) return;
		run.stopping = true;
		run.stoppedByUser = byUser;
		if (run.child) run.child.stop();
		else this.end(run, { ...run.result, exitCode: 1, stopReason: "aborted" });
		this.changed();
	}

	async wait(ids: string[], timeoutSec: number, signal?: AbortSignal): Promise<{ text: string; details: AgentResultDetails }> {
		const targets = ids.length > 0
			? ids.map((id) => this.latest(id)).filter((run): run is Run => !!run?.background)
			: this.runs.filter((run) => run.background && (LIVE.has(run.status) || !run.delivered));
		const unknown = ids.filter((id) => !this.latest(id));
		const foreground = ids.filter((id) => this.latest(id) && !this.latest(id)!.background);
		let onAbort = () => {};
		const aborted = new Promise<void>((resolve) => {
			onAbort = () => resolve();
			signal?.addEventListener("abort", onAbort, { once: true });
		});
		await Promise.race([Promise.all(targets.map((run) => run.ended)), sleep(Math.min(timeoutSec, MAX_WAIT_SEC) * 1000), aborted]);
		signal?.removeEventListener("abort", onAbort);

		const reports: RunReport[] = [];
		const parts: string[] = [];
		for (const run of targets) {
			if (LIVE.has(run.status)) parts.push(`${run.continueId}: still ${run.status}`);
			else if (run.delivered) parts.push(`${run.continueId}: ${run.status}, its result was already delivered`);
			else {
				run.delivered = true;
				this.pending = this.pending.filter((p) => p !== run);
				const report = this.report(run);
				reports.push(report);
				parts.push(runReportText(report));
			}
		}
		for (const id of foreground) parts.push(`${id}: runs in the foreground; its result returns to the call that started it`);
		for (const id of unknown) parts.push(`${id}: no agent with that continueId ran in this session`);
		return { text: parts.join("\n\n") || "No agent is running or waiting to report.", details: { runs: reports } };
	}

	list(): string {
		const now = Date.now();
		const live = this.runs.filter((run) => LIVE.has(run.status));
		const finished = this.runs.filter((run) => !LIVE.has(run.status));
		const shown = finished.slice(-LISTED_FINISHED);
		const lines = [...live, ...shown].map((run) => listLine(run, now));
		if (finished.length > shown.length) lines.push(`(${finished.length - shown.length} earlier finished runs not shown)`);
		return lines.join("\n") || "No agents have run in this session.";
	}

	restore(entries: readonly any[]): void {
		for (const entry of entries) {
			if (entry?.type !== "custom" || entry.customType !== AGENT_RUN_ENTRY || !entry.data?.continueId) continue;
			const data = entry.data as RunEntry;
			const run = this.newRun(data.agent, data.label, data.continueId, false, true, { cwd: "", task: "" });
			run.status = data.status;
			run.queuedAt = data.startedAt;
			run.startedAt = data.startedAt;
			run.endedAt = data.startedAt + data.durationMs;
			run.toolCount = data.toolCount ?? 0;
			run.failure = data.errorMessage;
			run.result = { ...run.result, model: data.model, thinkingLevel: data.thinkingLevel, usage: data.usage ?? run.result.usage, stopReason: data.stopReason };
			run.delivered = true;
			run.markEnded();
			this.runs.push(run);
			this.changed();
		}
	}

	/**
	 * stops every live run. the unreported results go into the session without
	 * waking it, so a resumed session and /stats both see them; for a reload they
	 * go to the reloaded extension instead, with the interrupted runs to continue.
	 */
	async shutdown(reload = false): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.clearTimers();
		const live = this.runs.filter((run) => LIVE.has(run.status));
		for (const run of live) {
			if (!run.child) {
				run.interrupting = true;
				this.end(run, run.result);
			} else if (run.child.stop()) run.interrupting = true;
		}
		const allEnded = () => Promise.all(live.map((run) => run.ended));
		await Promise.race([allEnded(), sleep(SHUTDOWN_GRACE_MS)]);
		for (const run of live) if (LIVE.has(run.status)) run.child?.kill();
		await Promise.race([allEnded(), sleep(KILL_WAIT_MS)]);
		const unreported = this.runs.filter((run) => run.background && !run.delivered && !LIVE.has(run.status));
		this.pending = [];
		if (reload) this.handOff(unreported);
		else this.deliver(unreported, false);
		this.host = undefined;
	}

	private handOff(unreported: Run[]): void {
		const resume = unreported.filter((run) => run.status === "interrupted");
		const reports = unreported.filter((run) => run.status !== "interrupted").map((run) => this.report(run));
		for (const run of unreported) run.delivered = true;
		const handoff: ReloadHandoff = {
			version: 1,
			at: Date.now(),
			reports: [...this.carried, ...reports],
			interrupted: resume.map((run) => ({ ...this.report(run), errorMessage: RELOADED })),
			resume: resume.map((run) => ({ agent: run.agent, label: run.label, continueId: run.continueId, spawn: run.spawn })),
		};
		(globalThis as { [RELOAD_SLOT]?: ReloadHandoff })[RELOAD_SLOT] = handoff;
	}

	private clearTimers(): void {
		if (this.batchTimer) clearTimeout(this.batchTimer);
		if (this.broadcastTimer) clearTimeout(this.broadcastTimer);
		this.batchTimer = undefined;
		this.broadcastTimer = undefined;
	}

	private add(spec: LaunchSpec, id: string, resuming: boolean, background: boolean, spawn: PiSpawnConfig): Run {
		const run = this.newRun(spec.agent, spec.label, id, resuming, background, spawn);
		this.runs.push(run);
		this.changed();
		return run;
	}

	private newRun(agent: string, label: string, continueId: string, resuming: boolean, background: boolean, spawn: PiSpawnConfig): Run {
		let markEnded!: () => void;
		const ended = new Promise<void>((resolve) => { markEnded = resolve; });
		return {
			agent,
			label: clip(label.trim().split("\n")[0] ?? "", 80),
			continueId,
			resuming,
			background,
			nested: false,
			status: "queued",
			queuedAt: Date.now(),
			toolCount: 0,
			files: [],
			toolArgs: new Map(),
			result: { exitCode: -1, messages: [], stderr: "", usage: zeroUsage(), model: spawn.model, thinkingLevel: spawn.thinkingLevel },
			spawn,
			delivered: false,
			interrupting: false,
			stopping: false,
			stoppedByUser: false,
			ended,
			markEnded,
		};
	}

	private latest(continueId: string): Run | undefined {
		return this.runs.findLast((run) => run.continueId === continueId);
	}

	private running(): number {
		return this.runs.filter((run) => run.status === "running").length;
	}

	private pump(): void {
		for (const run of this.runs) {
			if (this.closed || this.running() >= MAX_RUNNING) return;
			if (run.status === "queued" && !this.busySession(run)) this.start(run);
		}
	}

	/** a conversation is never open in two children at once. */
	private busySession(run: Run): boolean {
		return this.runs.some((other) => other !== run && other.continueId === run.continueId && other.status === "running");
	}

	private start(run: Run): void {
		run.status = "running";
		run.startedAt = Date.now();
		try {
			if (run.resuming) {
				const file = subAgentSessionFile(this.sessionDir, run.continueId);
				if (file) repairInterrupted(file);
			}
			run.child = startChild({
				...run.spawn,
				onUpdate: (partial) => {
					run.result = partial;
					run.onProgress?.();
					this.changed();
				},
				onEvent: (event) => this.onChildEvent(run, event),
			});
			run.result = run.child.result;
			run.child.done.then((result) => this.end(run, result), (error) => this.end(run, { ...run.result, exitCode: 1, errorMessage: errorText(error) }));
		} catch (error) {
			this.end(run, { ...run.result, exitCode: 1, errorMessage: errorText(error) });
		}
		this.changed();
	}

	private onChildEvent(run: Run, event: any): void {
		if (event.type === "tool_execution_start") {
			run.toolCount++;
			const args = event.args && typeof event.args === "object" ? event.args : {};
			run.toolArgs.set(event.toolCallId, args);
			run.activity = clip(`${event.toolName} ${toolArgSummary(event.toolName, args)}`.split("\n")[0], 100);
		} else {
			const args = run.toolArgs.get(event.toolCallId);
			run.toolArgs.delete(event.toolCallId);
			const file = args?.path ?? args?.file_path;
			if (!event.isError && (event.toolName === "edit" || event.toolName === "write") && typeof file === "string" && !run.files.includes(file)) {
				run.files.push(file);
			}
		}
		this.changed();
	}

	private end(run: Run, result: PiSpawnResult): void {
		if (!LIVE.has(run.status)) return;
		run.result = result;
		run.status = statusOf(run, result);
		run.endedAt = Date.now();
		run.activity = undefined;
		if (run.status === "interrupted") {
			run.failure = "Interrupted: the main session closed before it finished. Its conversation is saved; continue it by continueId.";
		} else if (run.status === "stopped" && run.stoppedByUser) {
			run.failure = "The user stopped this agent from the agents panel before it finished.";
		} else if (run.status !== "done") {
			run.failure = failureText(result, getFinalOutput(result.messages) || "(no output)");
		}
		const { messages: _messages, files: _files, overlaps: _overlaps, ...entry } = this.report(run);
		this.call((host) => host.record({ ...entry, startedAt: run.startedAt ?? run.queuedAt }));
		run.markEnded();
		if (run.background && !run.delivered && !this.closed) {
			this.pending.push(run);
			this.batchTimer ??= setTimeout(() => this.flush(), BATCH_MS);
		}
		this.changed();
		this.pump();
	}

	private flush(): void {
		this.batchTimer = undefined;
		const batch = this.pending;
		this.pending = [];
		if (!this.closed) this.deliver(batch, true);
	}

	private deliver(runs: Run[], wake: boolean): void {
		const batch = runs.filter((run) => !run.delivered);
		for (const run of batch) run.delivered = true;
		const reports = [...this.carried.splice(0), ...batch.map((run) => this.report(run))];
		if (reports.length === 0) return;
		this.call((host) => host.notify(notificationText(reports), { runs: reports }, wake));
	}

	private report(run: Run): RunReport {
		const r = run.result;
		return {
			agent: run.agent,
			label: run.label,
			continueId: run.continueId,
			status: run.status,
			durationMs: (run.endedAt ?? Date.now()) - (run.startedAt ?? run.queuedAt),
			toolCount: run.toolCount,
			files: run.files,
			overlaps: this.overlapsOf(run),
			model: r.model,
			thinkingLevel: r.thinkingLevel,
			usage: r.usage,
			stopReason: r.stopReason,
			errorMessage: run.failure,
			messages: slimMessages(r.messages),
		};
	}

	/** other runs that were alive while this one was and changed a file it changed. */
	private overlapsOf(run: Run): Overlap[] {
		if (run.files.length === 0 || run.startedAt === undefined) return [];
		const now = Date.now();
		const mine = new Set(run.files.map((file) => resolvePath(run.spawn.cwd, file)));
		const overlaps: Overlap[] = [];
		for (const other of this.runs) {
			if (other === run || other.continueId === run.continueId || other.startedAt === undefined) continue;
			if (other.startedAt >= (run.endedAt ?? now) || (other.endedAt ?? now) <= run.startedAt) continue;
			const shared = other.files.filter((file) => mine.has(resolvePath(other.spawn.cwd, file)));
			if (shared.length > 0) overlaps.push({ continueId: other.continueId, files: shared });
		}
		return overlaps;
	}

	private stub(run: Run, movedByUser = false): any {
		const behind = run.status === "queued" ? this.running() : 0;
		return {
			content: [{ type: "text", text: backgroundStub(run.agent, run.continueId, behind, movedByUser) }],
			details: { agent: run.agent, task: run.label, continueId: run.continueId, background: true, model: run.spawn.model },
		};
	}

	private async attend(run: Run, spec: LaunchSpec, signal?: AbortSignal, onUpdate?: (update: any) => void): Promise<any> {
		const details: SingleResult = { agent: run.agent, task: run.label, exitCode: -1, messages: [], usage: zeroUsage(), continueId: run.continueId };
		run.onProgress = () => onUpdate?.(progressUpdate(details, run.result, spec.working));
		const onAbort = () => {
			if (run.background) return;
			if (run.child) run.child.stop();
			else this.end(run, { ...run.result, exitCode: 1, stopReason: "aborted" });
		};
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
		const detached = new Promise<void>((resolve) => { run.detach = resolve; });
		try {
			await Promise.race([run.ended, detached]);
		} finally {
			signal?.removeEventListener("abort", onAbort);
			run.onProgress = undefined;
			run.detach = undefined;
		}
		if (run.background) return this.stub(run, true);
		run.delivered = true;
		const result = { ...run.result, session: { continueId: run.continueId, sessionDir: this.sessionDir } };
		if (run.status === "interrupted") Object.assign(result, { stopReason: "error", errorMessage: run.failure });
		return finishedResult(details, result, spec.returnImages);
	}

	/** "finished" when the run ended before it took the message, so the caller continues it instead. */
	private async steer(run: Run, text: string, prefix = STEER_PREFIX): Promise<any> {
		const message = `${prefix}\n\n${text}`;
		if (!run.child) {
			run.spawn.task = `${run.spawn.task}\n\n${message}`;
			return { content: [{ type: "text", text: `Added to the queued ${run.agent} (continueId: ${run.continueId}); it reads this when it starts.` }] };
		}
		const error = await run.child.steer(message);
		if (!error) {
			const where = run.background ? "Its result still arrives as an agent-result notification." : "Its result is still returned by the call that started it.";
			return { content: [{ type: "text", text: `Sent to the running ${run.agent} (continueId: ${run.continueId}); it reads this before its next step. ${where}` }] };
		}
		await Promise.race([run.ended, sleep(STEER_FALLBACK_MS)]);
		if (!LIVE.has(run.status)) return "finished";
		return toolError(`Could not reach the running ${run.agent}: ${error}. Once it finishes, continue it with this continueId.`);
	}

	private changed(): void {
		if (this.closed || this.broadcastTimer) return;
		this.broadcastTimer = setTimeout(() => {
			this.broadcastTimer = undefined;
			this.call((host) => host.broadcast(this.runs.map((run) => this.snapshot(run))));
		}, BROADCAST_MS);
	}

	private snapshot(run: Run): RunSnapshot {
		const r = run.result;
		return {
			id: run.continueId,
			agent: run.agent,
			label: run.label,
			status: run.status,
			background: run.background,
			queuedAt: run.queuedAt,
			startedAt: run.startedAt,
			endedAt: run.endedAt,
			activity: run.activity,
			model: r.model,
			thinkingLevel: r.thinkingLevel,
			usage: r.usage,
			toolCount: run.toolCount,
			files: run.files,
			messages: r.messages,
			stopReason: r.stopReason,
			errorMessage: run.failure ?? r.errorMessage,
			stopping: run.stopping && LIVE.has(run.status),
			control: run.control,
		};
	}

	private call(effect: (host: RunHost) => void): void {
		if (!this.host) return;
		try {
			effect(this.host);
		} catch {}
	}
}
