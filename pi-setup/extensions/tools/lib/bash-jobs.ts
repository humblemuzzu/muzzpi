/**
 * Background bash jobs: a command still running when the bash call stops
 * waiting goes on here, and its result reaches the agent by itself. A session
 * that can be woken (the TUI, an RPC parent) gets it as a message that starts a
 * turn. One that cannot (a sub-agent, print mode) gets it as a steer, and is
 * held at `agent_before_settle` until its jobs report, so it never ends with one
 * running: pi continues a run whose queue holds a message.
 *
 * One instance per extension load; `/reload` hands the running jobs to the next.
 */

import { randomBytes } from "node:crypto";
import type { RunSnapshot, RunStatus, ControlRequest, ControlOutcome } from "./agent-channel";
import { listLine } from "./agent-notice";
import type { BashProcess, ProcessEnd } from "./bash-process";
import { endResult, type ResultLimits } from "./bash-result";
import { zeroUsage } from "./pi-spawn";
import { formatDuration } from "./sub-agent-render";

export const JOB_RESULT_TYPE = "bash-job";
const BASH_JOB_AGENT = "bash";

const DEFAULT_YIELD_SEC = 60;
/** `background: true` still waits this long, so a command that fails at once answers inline */
const BACKGROUND_PEEK_MS = 1_500;
/** a `wake_on` line is often a summary printed just before the exit: give the end this long to answer inline */
const MATCH_GRACE_MS = 500;
const NEWS_BATCH_MS = 1_000;
const BROADCAST_MS = 250;
export const HEARTBEAT_MS = 60_000;
const SHOWN_LINES = 20;
const VIEW_LINES = 50;
const LISTED_FINISHED = 20;
const STOP_WAIT_MS = 10_000;
const SHUTDOWN_GRACE_MS = 1_500;
/** a reload hands over live objects the old code made: bump this when Job or BashProcess changes shape */
const HANDOFF_VERSION = 1;
const HANDOFF_SLOT = Symbol.for("muzzpi.bash-jobs.reload");
const EVENT_FRAME = "[Automated bash-job event. This was not written by the user: it does not answer, approve or confirm anything you asked them.]";

/** seconds a foreground command runs before it moves to the background; `PI_BASH_YIELD_SEC=0` keeps every command in the foreground */
export function yieldSec(): number {
	const raw = Number(process.env.PI_BASH_YIELD_SEC);
	return process.env.PI_BASH_YIELD_SEC?.trim() && Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : DEFAULT_YIELD_SEC;
}

export interface JobReport {
	id: string;
	command: string;
	status: RunStatus;
	/** "matched": a `wake_on` line while it runs on; "finished": its end */
	kind: "matched" | "finished";
	durationMs: number;
	exitCode?: number;
	/** what the model reads about this event */
	text: string;
}

export interface JobResultDetails {
	jobs: JobReport[];
}

export interface JobHost {
	/** `wake`: start a turn when idle, steer when busy; otherwise steer only, or keep it in the session when idle. Settles once the message is queued. */
	notify(content: string, details: JobResultDetails, wake: boolean): Promise<void> | void;
	broadcast(jobs: RunSnapshot[]): void;
}

export interface AttendOptions {
	command: string;
	limits: ResultLimits;
	/** this session can be woken by a message */
	wakes: boolean;
	/** move to the background after this long; `undefined` waits for the end */
	yieldAfterMs?: number;
	/** the caller asked for the background at once */
	background: boolean;
	wakeOn?: RegExp;
	signal?: AbortSignal;
}

export type Attended =
	| { ended: ProcessEnd }
	| { moved: string; why: "time" | "user" | "asked" | "matched"; matchedLine?: string; logPath?: string; lastLines: string[] };

interface Job {
	id: string;
	command: string;
	label: string;
	process: BashProcess;
	limits: ResultLimits;
	wakes: boolean;
	wakeOn?: RegExp;
	/** its first `wakeOn` line has not been seen yet */
	armed: boolean;
	status: RunStatus;
	endedAt?: number;
	end?: Pick<ProcessEnd, "reason" | "code" | "signal">;
	/** what the model reads about its end */
	result?: string;
	delivered: boolean;
	stopping: boolean;
	interrupting: boolean;
	control?: ControlOutcome;
	unsubscribe: () => void;
}

interface Handoff {
	version: number;
	jobs: Job[];
	pending: JobReport[];
}

const LIVE: ReadonlySet<RunStatus> = new Set(["queued", "running"]);
const isLive = (job: Job) => LIVE.has(job.status);

/** calls `onLine` with each complete line of a stream of text chunks */
function lineReader(onLine: (line: string) => void): (text: string) => void {
	let partial = "";
	return (text) => {
		const lines = (partial + text).split("\n");
		partial = lines.pop() ?? "";
		for (const line of lines) onLine(line);
	};
}

const sleep = (ms: number) =>
	new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref?.();
	});

function statusOf(job: Job, end: ProcessEnd): RunStatus {
	if (job.interrupting) return "interrupted";
	if (end.reason === "stopped" || end.reason === "aborted") return "stopped";
	return end.reason === "exited" && end.code === 0 ? "done" : "failed";
}

function oneLine(text: string, max = 160): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export class BashJobs {
	private jobs: Job[] = [];
	private host?: JobHost;
	/** shutting down: no new batch, no wake */
	private closing = false;
	private closed = false;
	private pending: JobReport[] = [];
	private batchTimer?: ReturnType<typeof setTimeout>;
	private broadcastTimer?: ReturnType<typeof setTimeout>;
	private readonly foreground = new Set<() => void>();
	/** jobs an `agents stop` waits on: their end goes to that call, not out as news */
	private readonly awaited = new Map<Job, number>();
	/** ends the current hold: news went out */
	private holder?: () => void;
	/** steers still being queued; a hold waits for them, or the run would settle before its news lands */
	private sending = 0;

	constructor(host?: JobHost) {
		this.host = host;
	}

	static takeHandoff(): Handoff | undefined {
		const slot = globalThis as { [HANDOFF_SLOT]?: Handoff };
		const handoff = slot[HANDOFF_SLOT];
		delete slot[HANDOFF_SLOT];
		return handoff?.version === HANDOFF_VERSION ? handoff : undefined;
	}

	/** takes over the jobs a reloaded-away instance left running or unreported. */
	adopt(handoff: Handoff): void {
		for (const job of handoff.jobs) {
			this.jobs.push(job);
			if (job.process.running) this.watch(job);
			else if (!job.result) void job.process.ended.then((end) => this.finish(job, end));
			else if (!job.delivered) this.report(job, "finished");
		}
		this.pending.push(...handoff.pending);
		if (this.pending.length > 0) this.batchTimer ??= setTimeout(() => this.flush(), NEWS_BATCH_MS);
		this.changed();
	}

	/** a command can go on in the background: something hears about it when it ends */
	get movable(): boolean {
		return !!this.host && !this.closing;
	}

	has(id: string): boolean {
		return this.jobs.some((job) => job.id === id);
	}

	/**
	 * waits for `process` in the foreground until it ends, or hands it to the
	 * background: after `yieldAfterMs`, at once when asked, on Ctrl+B, or on the
	 * first `wakeOn` line. Abort ends it only while the call still waits.
	 */
	async attend(process: BashProcess, options: AttendOptions): Promise<Attended> {
		let release!: (why: "time" | "user" | "asked" | "matched", line?: string) => void;
		const moved = new Promise<{ why: "time" | "user" | "asked" | "matched"; line?: string }>((resolve) => {
			release = (why, line) => resolve({ why, line });
		});
		const delay = !this.movable ? undefined : options.background ? BACKGROUND_PEEK_MS : options.yieldAfterMs;
		const timer = delay === undefined ? undefined : setTimeout(() => release(options.background ? "asked" : "time"), delay);
		const toUser = () => release("user");
		if (delay !== undefined) this.foreground.add(toUser);
		const stopReading = options.wakeOn && delay !== undefined
			? process.onOutput(lineReader((line) => {
				if (options.wakeOn!.test(line)) release("matched", line);
			}))
			: undefined;
		const onAbort = () => process.abort();
		if (options.signal?.aborted) onAbort();
		else options.signal?.addEventListener("abort", onAbort, { once: true });
		try {
			const first = await Promise.race([process.ended.then((end) => ({ end })), moved]);
			if ("end" in first) return { ended: first.end };
			const end = await Promise.race([process.ended, first.why === "matched" ? sleep(MATCH_GRACE_MS) : Promise.resolve(undefined)]);
			if (end) return { ended: end };
			const job = this.start(process, options, first.why === "matched");
			return { moved: job.id, why: first.why, matchedLine: first.line, logPath: process.logPath(), lastLines: process.lastLines(SHOWN_LINES) };
		} finally {
			if (timer) clearTimeout(timer);
			this.foreground.delete(toUser);
			stopReading?.();
			options.signal?.removeEventListener("abort", onAbort);
		}
	}

	/** Ctrl+B: every bash call waiting in the foreground moves to the background. */
	detachForeground(): boolean {
		const waiting = [...this.foreground];
		for (const release of waiting) release();
		return waiting.length > 0;
	}

	private start(process: BashProcess, options: AttendOptions, matched: boolean): Job {
		const job: Job = {
			id: `bash-${randomBytes(2).toString("hex")}`,
			command: options.command,
			label: oneLine(options.command, 80),
			process,
			limits: options.limits,
			wakes: options.wakes,
			wakeOn: options.wakeOn,
			armed: !!options.wakeOn && !matched,
			status: "running",
			delivered: false,
			stopping: false,
			interrupting: false,
			unsubscribe: () => {},
		};
		while (this.has(job.id)) job.id = `bash-${randomBytes(2).toString("hex")}`;
		this.jobs.push(job);
		this.watch(job);
		this.changed();
		return job;
	}

	private watch(job: Job): void {
		const reader = lineReader((line) => {
			if (job.armed && job.wakeOn?.test(line)) {
				job.armed = false;
				this.report(job, "matched", line);
			}
		});
		job.unsubscribe = job.process.onOutput((text) => {
			reader(text);
			this.changed();
		});
		void job.process.ended.then((end) => this.finish(job, end));
	}

	private finish(job: Job, end: ProcessEnd): void {
		if (this.closed || job.result) return;
		job.end = { reason: end.reason, code: end.code, signal: end.signal };
		job.status = statusOf(job, end);
		job.endedAt = Date.now();
		const result = endResult(job.command, end, job.limits);
		job.result = result.content[0].text as string;
		job.unsubscribe();
		if (!job.delivered) this.report(job, "finished");
		this.prune();
		this.changed();
	}

	/** a finished job holds its output: keep the last few reported ones, for the list and the dock. */
	private prune(): void {
		const reported = this.jobs.filter((job) => !isLive(job) && job.delivered);
		const drop = new Set(reported.slice(0, Math.max(0, reported.length - LISTED_FINISHED)));
		if (drop.size > 0) this.jobs = this.jobs.filter((job) => !drop.has(job));
	}

	private reportOf(job: Job, kind: JobReport["kind"], line?: string): JobReport {
		const durationMs = (job.endedAt ?? Date.now()) - job.process.startedAt;
		const took = formatDuration(durationMs);
		const base = { id: job.id, command: job.command, status: job.status, kind, durationMs };
		if (kind === "matched") {
			const last = job.process.lastLines(SHOWN_LINES).join("\n");
			return {
				...base,
				text:
					`Background job ${job.id} printed a line matching \`${job.wakeOn?.source}\` after ${took}, and is still running:\n\n` +
					`    ${line}\n\n$ ${job.command}\n\nIts last lines:\n${last}\n\n` +
					`Its final result still arrives by itself. If this makes the rest of the run useless, stop it with agents stop ["${job.id}"].`,
			};
		}
		const text = job.result!;
		const verb = job.status === "done" ? "finished" : job.status === "interrupted" ? "was interrupted" : job.status === "stopped" ? "was stopped" : "failed";
		return {
			...base,
			exitCode: job.end?.code ?? undefined,
			text: `Background job ${job.id} ${verb} after ${took}.\n\n${text.startsWith("$ ") ? text : `$ ${job.command}\n\n${text}`}`,
		};
	}

	/** a job's news: a session that can be woken gets one batched message; one that cannot gets a steer, which also ends its hold. */
	private report(job: Job, kind: JobReport["kind"], line?: string): void {
		if (kind === "finished" && this.awaited.has(job)) return;
		if (kind === "finished") job.delivered = true;
		const report = this.reportOf(job, kind, line);
		if (job.wakes) {
			this.pending.push(report);
			if (!this.closing) this.batchTimer ??= setTimeout(() => this.flush(), NEWS_BATCH_MS);
			return;
		}
		this.sending++;
		const queued = this.call((host) => host.notify(newsText([report]), { jobs: [report] }, false));
		void Promise.resolve(queued).finally(() => {
			this.sending--;
			this.holder?.();
		});
	}

	private flush(): void {
		this.batchTimer = undefined;
		const batch = this.pending.splice(0);
		if (batch.length > 0 && !this.closed) this.call((host) => host.notify(newsText(batch), { jobs: batch }, true));
	}

	/**
	 * for a session nothing can wake, at the end of its run: waits while a job it
	 * started runs, until one has news (sent as a steer, which continues the run).
	 * true when news went out. `status` says what it waits for, which also keeps
	 * an RPC parent's stall watchdog fed.
	 */
	async hold(signal: AbortSignal | undefined, status: (text: string | undefined) => void): Promise<boolean> {
		const waiting = () => this.jobs.filter((job) => !job.wakes && isLive(job));
		if ((waiting().length === 0 && this.sending === 0) || this.closed || signal?.aborted) return false;
		return new Promise((resolve) => {
			const beat = () => {
				const jobs = waiting();
				const now = Date.now();
				const what = jobs.map((job) => `${job.id} (${formatDuration(now - job.process.startedAt)}): ${oneLine(job.process.lastLines(1)[0] ?? "", 80)}`);
				if (what.length > 0) status(`waiting for ${what.join("; ")}`);
			};
			beat();
			const timer = setInterval(beat, HEARTBEAT_MS);
			const done = (sent: boolean) => {
				clearInterval(timer);
				status(undefined);
				signal?.removeEventListener("abort", onAbort);
				this.holder = undefined;
				resolve(sent);
			};
			const onAbort = () => done(false);
			signal?.addEventListener("abort", onAbort, { once: true });
			this.holder = () => done(true);
		});
	}

	list(): string[] {
		const now = Date.now();
		const live = this.jobs.filter(isLive);
		const finished = this.jobs.filter((job) => !isLive(job)).slice(-LISTED_FINISHED);
		return [...live, ...finished].map((job) =>
			listLine({ agent: BASH_JOB_AGENT, label: job.label, continueId: job.id, status: job.status, startedAt: job.process.startedAt, queuedAt: job.process.startedAt, endedAt: job.endedAt, activity: this.activityOf(job) }, now),
		);
	}

	private endOf(targets: Job[]): Promise<unknown> {
		return Promise.all(targets.map((job) => job.process.ended.then(() => sleep(0))));
	}

	/** while `until` runs, a target's end is this caller's to collect; one that ends after is reported as news. */
	private async awaiting(targets: Job[], until: Promise<unknown>): Promise<void> {
		for (const job of targets) this.awaited.set(job, (this.awaited.get(job) ?? 0) + 1);
		try {
			await until;
		} finally {
			for (const job of targets) {
				const left = (this.awaited.get(job) ?? 1) - 1;
				if (left > 0) this.awaited.set(job, left);
				else this.awaited.delete(job);
			}
		}
	}

	/** stops the given running jobs, or every one for ["all"], and returns their results. */
	async stop(ids: string[]): Promise<{ parts: string[]; reports: JobReport[] }> {
		const all = ids.includes("all");
		const targets = this.jobs.filter((job) => isLive(job) && (all || ids.includes(job.id)));
		for (const job of targets) this.requestStop(job, "stopped with agents stop");
		await this.awaiting(targets, Promise.race([this.endOf(targets), sleep(STOP_WAIT_MS)]));
		return this.collect(targets);
	}

	private collect(targets: Job[]): { parts: string[]; reports: JobReport[] } {
		const parts: string[] = [];
		const reports: JobReport[] = [];
		for (const job of targets) {
			if (isLive(job)) {
				parts.push(`${job.id}: still ${job.stopping ? "stopping" : "running"} (${formatDuration(Date.now() - job.process.startedAt)}); its result arrives by itself`);
				continue;
			}
			const stillQueued = this.takeUndelivered(job);
			if (job.delivered && !stillQueued) {
				parts.push(`${job.id}: ${job.status}, its result was already delivered`);
				continue;
			}
			job.delivered = true;
			const report = this.reportOf(job, "finished");
			reports.push(report);
			parts.push(report.text);
		}
		return { parts, reports };
	}

	/** a result still waiting in the batch has not reached the agent yet: take it back. */
	private takeUndelivered(job: Job): boolean {
		const at = this.pending.findIndex((report) => report.id === job.id && report.kind === "finished");
		if (at >= 0) this.pending.splice(at, 1);
		return at >= 0;
	}

	private requestStop(job: Job, why: string): void {
		if (job.stopping || !isLive(job)) return;
		job.stopping = true;
		job.limits = { ...job.limits, stoppedBy: why };
		job.process.stop();
		this.changed();
	}

	/** a request from the agents UI; the answer goes back on the broadcast. */
	control(request: ControlRequest): void {
		if (request.action === "stopAll") {
			for (const job of this.jobs) this.requestStop(job, "stopped by the user from the agents panel");
			return;
		}
		const job = this.jobs.find((candidate) => candidate.id === request.id);
		if (!job) return;
		if (request.action === "stop") {
			if (isLive(job)) this.requestStop(job, "stopped by the user from the agents panel");
			else this.answer(job, "stop", `${job.id} has already ${job.status === "done" ? "finished" : job.status}.`);
			return;
		}
		this.answer(job, request.action, "A bash job takes no messages. Stop it and ask the main agent to run something else.");
	}

	private answer(job: Job, action: ControlOutcome["action"], text: string): void {
		job.control = { action, ok: false, text, at: Date.now() };
		this.changed();
	}

	private activityOf(job: Job): string {
		const last = oneLine(job.process.lastLines(1)[0] ?? "", 120);
		if (isLive(job)) return last || "no output yet";
		const end = job.end;
		const how = !end ? job.status : end.reason === "exited" ? `exit ${end.code ?? end.signal}` : end.reason;
		return last ? `${how} · ${last}` : how;
	}

	snapshots(): RunSnapshot[] {
		const live = this.jobs.filter(isLive);
		const finished = this.jobs.filter((job) => !isLive(job)).slice(-LISTED_FINISHED);
		return [...live, ...finished].map((job) => {
			const activity = this.activityOf(job);
			return {
				id: job.id,
				agent: BASH_JOB_AGENT,
				label: job.label,
				status: job.status,
				background: true,
				queuedAt: job.process.startedAt,
				startedAt: job.process.startedAt,
				endedAt: job.endedAt,
				activity,
				usage: zeroUsage(),
				toolCount: 0,
				files: [],
				messages: [],
				errorMessage: job.status === "failed" ? activity : undefined,
				stopping: job.stopping && isLive(job),
				control: job.control,
				output: job.process.lastLines(VIEW_LINES).join("\n"),
			};
		});
	}

	private changed(): void {
		if (this.closing || this.broadcastTimer) return;
		this.broadcastTimer = setTimeout(() => {
			this.broadcastTimer = undefined;
			this.call((host) => host.broadcast(this.snapshots()));
		}, BROADCAST_MS);
	}

	/**
	 * the session is closing. A reload hands running jobs to the next load;
	 * anything else stops them and adds their results to the session unwoken.
	 */
	async shutdown(reload: boolean): Promise<void> {
		if (this.closing) return;
		this.closing = true;
		for (const timer of [this.batchTimer, this.broadcastTimer]) if (timer) clearTimeout(timer);
		this.batchTimer = undefined;
		this.broadcastTimer = undefined;
		if (reload) {
			this.closed = true;
			this.holder?.();
			for (const job of this.jobs) job.unsubscribe();
			const kept = this.jobs.filter((job) => isLive(job) || !job.delivered);
			(globalThis as { [HANDOFF_SLOT]?: Handoff })[HANDOFF_SLOT] = { version: HANDOFF_VERSION, jobs: kept, pending: this.pending.splice(0) };
			this.host = undefined;
			return;
		}
		const live = this.jobs.filter(isLive);
		for (const job of live) {
			job.interrupting = true;
			this.requestStop(job, "stopped because the session closed");
		}
		await Promise.race([this.endOf(live), sleep(SHUTDOWN_GRACE_MS)]);
		this.closed = true;
		this.holder?.();
		const unreported = this.pending.splice(0);
		for (const job of this.jobs) {
			if (job.delivered || !job.result) continue;
			job.delivered = true;
			unreported.push(this.reportOf(job, "finished"));
		}
		if (unreported.length > 0) this.call((host) => host.notify(newsText(unreported), { jobs: unreported }, false));
		this.host = undefined;
	}

	private call<T>(effect: (host: JobHost) => T): T | undefined {
		if (!this.host) return undefined;
		try {
			return effect(this.host);
		} catch {
			return undefined;
		}
	}
}

/** the user-role message that delivers job news to the agent. */
export function newsText(reports: JobReport[]): string {
	return [EVENT_FRAME, ...reports.map((report) => report.text)].join("\n\n");
}

/** what the bash call returns when its command goes on as a background job. */
export function movedText(command: string, moved: Extract<Attended, { moved: string }>, wakeOnSource: string | undefined, yieldAfterSec: number): string {
	const why = {
		time: `Still running after ${yieldAfterSec}s, so it moved to the background as job ${moved.moved}.`,
		user: `The user moved it to the background with Ctrl+B, as job ${moved.moved}. Do not run it again.`,
		asked: `Started in the background as job ${moved.moved}.`,
		matched: `A line matched \`${wakeOnSource}\`, so it moved to the background as job ${moved.moved}:\n\n    ${moved.matchedLine}`,
	}[moved.why];
	const output = moved.lastLines.length > 0 ? `Output so far (last lines):\n${moved.lastLines.join("\n")}` : "(no output yet)";
	const log = moved.logPath ? ` Its full output is written to ${moved.logPath}.` : "";
	const early = wakeOnSource && moved.why !== "matched" ? ` The first line matching \`${wakeOnSource}\` reaches you early.` : "";
	return (
		`$ ${command}\n\n${output}\n\n${why}${log} It keeps running; its exit code and output reach you by themselves when it ends.${early} ` +
		"Until then do not sleep, poll, or read the log to check on it. Keep working on anything that does not depend on it, " +
		`or end your turn: its result will start your next one. To stop it: agents stop ["${moved.moved}"].`
	);
}
