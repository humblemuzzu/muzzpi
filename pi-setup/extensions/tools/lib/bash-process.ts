/**
 * One shell command, from spawn to its end: its output (sanitised, kept as head
 * + tail for the model and whole in a file), its deadline, and its idle kill.
 * Whoever waits on it reads `ended`; the bash tool waits in the foreground, and
 * a background job (bash-jobs.ts) waits on the same process after that.
 */

import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { OutputBuffer, headTailChars } from "./output-buffer";
import { FullOutput, type FinishedOutput } from "./full-output";
import { SLEEP_JUMP_MS, watchdogTickMs, watchdogVerdict } from "./watchdog";
import { sampleGroupCpuSeconds } from "./proc-cpu";

export const HEAD_LINES = 50;
export const TAIL_LINES = 50;
/** the line window alone lets one minified line through whole. */
const MAX_OUTPUT_CHARS = 20_000;
const SIGKILL_DELAY_MS = 3000;
/** how long after the shell exits a still-open output pipe is taken to mean a background process holds it. */
const BACKGROUND_GRACE_MS = 1500;

/*
 * idle kill: no output AND no CPU for N seconds, from t=0 — pipes block-buffer,
 * so arming after first output never fires on the hang it exists for. CPU can
 * only keep a command alive; sample failure (undefined) degrades to stdout-only.
 * residuals, both still bounded by the deadline: 0-CPU remote work (ssh) looks
 * idle; a 100% busy-loop hang is caught by the wall clock, not idle.
 */
/** fraction of one core over the sample window; scale-invariant so tests and production agree. */
const CPU_ALIVE_CORE_FRACTION = 0.05;
/** coarse tick; real interval is min(this, idle/3) so a short window is still observed. */
const IDLE_TICK_MS = 10_000;

/** off (`PI_BASH_CPU_LIVENESS=0`) falls back to stdout-only idle. */
function cpuLivenessEnabled(): boolean {
	return process.env.PI_BASH_CPU_LIVENESS !== "0";
}

/**
 * pi's getShellConfig() lives in utils/shell.js, not re-exported
 * from the main package. reimplemented here — on macOS (our target)
 * this is always /bin/bash.
 */
function getShell(): { shell: string; args: string[] } {
	if (existsSync("/bin/bash")) return { shell: "/bin/bash", args: ["-c"] };
	return { shell: "sh", args: ["-c"] };
}

/** process groups started here that may still run; each is sent SIGTERM when pi exits. */
const liveGroups = new Set<number>();
let exitHookInstalled = false;

function trackGroup(pid: number): void {
	liveGroups.add(pid);
	if (exitHookInstalled) return;
	exitHookInstalled = true;
	process.once("exit", () => {
		for (const pgid of liveGroups) {
			try {
				process.kill(-pgid, "SIGTERM");
			} catch {}
		}
	});
}

/**
 * SIGTERM the process group first, escalate to SIGKILL after delay.
 * pi's built-in goes straight to SIGKILL via killProcessTree().
 * graceful fallback so processes can clean up.
 */
function killGracefully(pid: number): void {
	try {
		process.kill(-pid, "SIGTERM");
	} catch {
		return;
	}
	setTimeout(() => {
		try {
			process.kill(-pid, 0);
			process.kill(-pid, "SIGKILL");
		} catch {
			// already dead
		}
	}, SIGKILL_DELAY_MS);
}

// --- output sanitization ---

/**
 * strip terminal control sequences before they reach the TUI. CSI uses ECMA-48
 * parameter bytes 0x30-0x3f so DEC private modes (`?1049h`) are caught —
 * `[0-9;]*` misses the `?` and those execute as real terminal commands.
 */
export function sanitizeForDisplay(text: string): string {
	return text
		// CSI sequences (full ECMA-48): \x1b[ + parameter bytes (0x30-0x3f)
		// + intermediate bytes (0x20-0x2f) + final byte (0x40-0x7e).
		// covers SGR colors, cursor movement, DEC private mode (?25h, ?1049h,
		// ?2004h), screen clearing, xterm modifiers (>4;2m), etc.
		.replace(/\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g, "")
		// OSC sequences: \x1b] ... BEL or \x1b] ... ST
		.replace(/\x1b\][^\x07]*\x07/g, "")
		.replace(/\x1b\][^\x1b]*\x1b\\/g, "")
		// DCS sequences: \x1bP ... ST (\x1b\\ or \x07)
		.replace(/\x1bP[^\x07]*\x07/g, "")
		.replace(/\x1bP[^\x1b]*\x1b\\/g, "")
		// APC/PM/SOS sequences: \x1b_ / \x1b^ / \x1bX ... ST
		.replace(/\x1b[_^X][^\x1b]*\x1b\\/g, "")
		.replace(/\x1b[_^X][^\x07]*\x07/g, "")
		// charset selection, cursor save/restore, keypad modes
		.replace(/\x1b[()][0-9A-B]/g, "")
		.replace(/\x1b[78=>]/g, "")
		// normalize line endings (SSH sends \r\n; raw \r overwrites line start)
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		// strip remaining control chars (except \n newline and \t tab)
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

function hasCompleteEscapeSequence(text: string): boolean {
	return /^(?:\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1bP[^\x07]*(?:\x07|\x1b\\)|\x1b[_^X][^\x07]*(?:\x07|\x1b\\)|\x1b[()][0-9A-B]|\x1b[78=>])/.test(text);
}

function splitIncompleteEscape(text: string): { display: string; carry: string } {
	const lastEsc = text.lastIndexOf("\x1b");
	if (lastEsc === -1) return { display: text, carry: "" };

	const suffix = text.slice(lastEsc);
	if (hasCompleteEscapeSequence(suffix) || suffix.length > 1024) {
		return { display: text, carry: "" };
	}

	return { display: text.slice(0, lastEsc), carry: suffix };
}

// --- the process ---

export interface ProcessSpec {
	command: string;
	cwd: string;
	/** the deadline, from spawn; it holds whoever waits */
	timeoutSec: number;
	/** 0 turns the idle kill off */
	idleSec: number;
	/** added to pi's own environment (the psst secrets) */
	env?: Record<string, string>;
}

/** how it ended; a kill by the deadline, the idle watchdog or a caller wins over the exit it caused */
export type EndReason = "exited" | "timeout" | "idle" | "aborted" | "stopped" | "error";

export interface ProcessEnd {
	reason: EndReason;
	code: number | null;
	signal: NodeJS.Signals | null;
	/** the shell exited while a background process it started still held the output pipe */
	orphaned: boolean;
	/** what the model reads: the first and last lines, capped */
	text: string;
	/** `text` leaves part of the output out */
	cut: boolean;
	full: FinishedOutput;
	wallSeconds: number;
	/** the spawn failed */
	error?: string;
}

/**
 * Python block-buffers stdout into a pipe (8 KB), so a script's prints would
 * all arrive when it exits. Measured: `python3 slow.py` showed nothing for its
 * whole run, and each line on time with this set. pi's own environment wins.
 */
const UNBUFFERED = { PYTHONUNBUFFERED: "1" };

export class BashProcess {
	readonly startedAt = Date.now();
	readonly ended: Promise<ProcessEnd>;
	private readonly output = new OutputBuffer(HEAD_LINES, TAIL_LINES);
	private readonly full = new FullOutput();
	private readonly listeners = new Set<(text: string) => void>();
	private kill: ((why: "aborted" | "stopped") => void) | undefined;
	private done = false;

	constructor(readonly spec: ProcessSpec) {
		this.ended = new Promise((resolve) => {
			try {
				this.run(resolve);
			} catch (err) {
				resolve({ reason: "error", code: null, signal: null, orphaned: false, text: "", cut: false, full: this.full.finish(), wallSeconds: 0, error: err instanceof Error ? err.message : String(err) });
			}
		});
		void this.ended.then(() => {
			this.done = true;
			this.listeners.clear();
		});
	}

	get running(): boolean {
		return !this.done;
	}

	/** the output so far, as head + tail lines. */
	preview(): string {
		return this.output.preview().text;
	}

	lastLines(count: number): string[] {
		return this.output.lastLines(count);
	}

	/** the file holding every byte so far, created on first ask; later output is appended there. */
	logPath(): string | undefined {
		return this.full.spill();
	}

	/** sanitised output as it arrives; returns the way to stop listening. */
	onOutput(listener: (text: string) => void): () => void {
		if (this.done) return () => {};
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** the caller gave up (Esc): it ends as "aborted". */
	abort(): void {
		this.kill?.("aborted");
	}

	/** someone stopped it on purpose: it ends as "stopped". */
	stop(): void {
		this.kill?.("stopped");
	}

	private emit(text: string): void {
		for (const listener of this.listeners) {
			try {
				listener(text);
			} catch {
				// a throw in a stream handler is uncaught and would end pi
			}
		}
	}

	private run(resolve: (end: ProcessEnd) => void): void {
		const { command, cwd, timeoutSec, idleSec } = this.spec;
		const { shell, args } = getShell();
		const env = { ...UNBUFFERED, ...process.env, ...this.spec.env };
		const startedAt = performance.now();
		const child = spawn(shell, [...args, command], {
			cwd,
			detached: true,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		if (child.pid) trackGroup(child.pid);

		const { output, full } = this;
		let settled = false;
		let timedOut = false;
		let idledOut = false;
		let killedBy: "aborted" | "stopped" | undefined;
		let controlCarry = "";
		// per-stream decoders: Buffer.toString("utf-8") on a chunk that splits a
		// multibyte character mid-sequence produces permanent U+FFFD corruption.
		// StringDecoder carries the partial sequence to the next chunk.
		const stdoutDecoder = new StringDecoder("utf8");
		const stderrDecoder = new StringDecoder("utf8");

		this.kill = (why) => {
			if (settled || killedBy) return;
			killedBy = why;
			if (child.pid) killGracefully(child.pid);
		};

		let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
		if (timeoutSec > 0) {
			timeoutHandle = setTimeout(() => {
				timedOut = true;
				if (child.pid) killGracefully(child.pid);
			}, timeoutSec * 1000);
		}

		/*
		 * lastOutputAt is stamped on RAW chunk arrival, not displayable text, so a
		 * progress bar of only control sequences still counts as alive. CPU OR
		 * output keep it alive; the kill fires only when both are quiet.
		 */
		const idleMs = idleSec * 1000;
		let lastOutputAt = Date.now();
		let lastIdleTickAt = Date.now();
		// CPU liveness state. `child.pid` is the process-GROUP id because the child
		// is spawned `detached` (the same fact `killGracefully(-pid)` relies on).
		const cpuOn = cpuLivenessEnabled() && idleMs > 0;
		let lastCpuSecs: number | undefined;
		let lastCpuSampleAt = Date.now();
		let sampling: Promise<void> | undefined;
		/* CPU can only bump lastOutputAt; undefined (ps failed) is no signal. */
		const readCpu = async (pid: number) => {
			const cpuNow = await sampleGroupCpuSeconds(pid);
			const now = Date.now();
			// a failed `ps` keeps the old baseline, so the next reading measures across the gap
			if (cpuNow === undefined) return;
			if (lastCpuSecs !== undefined) {
				// scaled by elapsed time; abs() because a child exiting drops the group's total, which is activity too
				const threshold = Math.max((now - lastCpuSampleAt) / 1000, 0) * CPU_ALIVE_CORE_FRACTION;
				if (Math.abs(cpuNow - lastCpuSecs) > threshold) lastOutputAt = now;
			}
			lastCpuSecs = cpuNow;
			lastCpuSampleAt = now;
		};
		/** a tick that finds a reading in flight waits for that one rather than starting another */
		const sampleCpu = (): Promise<void> => {
			if (!cpuOn || !child.pid) return Promise.resolve();
			sampling ??= readCpu(child.pid).finally(() => {
				sampling = undefined;
			});
			return sampling;
		};
		void sampleCpu();
		let idleHandle: ReturnType<typeof setInterval> | undefined;
		if (idleMs > 0) {
			// a throw in a timer callback is an uncaughtException and pi exits(1);
			// on a throw, stop the watchdog rather than kill: the deadline still bounds the run.
			const idleTick = async () => {
				// one kill only. after the first tick fires, `lastOutputAt` can never
				// advance again (the process is dying and producing nothing), so every
				// later tick would re-issue SIGTERM and queue another 3s SIGKILL timer
				// against a process that is already on its way out.
				if (idledOut) return;
				await sampleCpu();
				if (idledOut || settled) return;
				const now = Date.now();
				const verdict = watchdogVerdict(now, lastIdleTickAt, lastOutputAt, idleMs, SLEEP_JUMP_MS);
				lastIdleTickAt = now;
				// machine slept: forgive the gap rather than kill a process that was
				// frozen along with everything else.
				if (verdict === "slept") { lastOutputAt = now; return; }
				if (verdict === "wait") return;
				idledOut = true;
				if (child.pid) killGracefully(child.pid);
			};
			idleHandle = setInterval(() => {
				idleTick().catch(() => {
					if (idleHandle) clearInterval(idleHandle);
					idleHandle = undefined;
				});
			}, watchdogTickMs(idleMs, IDLE_TICK_MS));
			idleHandle.unref?.();
		}

		const handleData = (decoder: StringDecoder) => (data: Buffer) => {
			// liveness is stamped on RAW arrival, before sanitization: bytes that
			// sanitize to nothing (a redrawing progress bar) still prove the process
			// is running. counting only displayable text would kill it.
			lastOutputAt = Date.now();
			// sanitize at source so escape sequences never reach the buffers or the
			// TUI; an escape split across chunks is carried to the next one.
			const raw = controlCarry + decoder.write(data);
			const { display, carry } = splitIncompleteEscape(raw);
			controlCarry = carry;
			const sanitized = sanitizeForDisplay(display);
			if (sanitized) {
				output.add(sanitized);
				full.add(sanitized);
				this.emit(sanitized);
			}
		};

		child.stdout?.on("data", handleData(stdoutDecoder));
		child.stderr?.on("data", handleData(stderrDecoder));

		let backgroundHandle: ReturnType<typeof setTimeout> | undefined;
		const stopTimers = () => {
			if (backgroundHandle) clearTimeout(backgroundHandle);
			if (idleHandle) clearInterval(idleHandle);
		};

		child.on("error", (err) => {
			if (settled) return;
			settled = true;
			stopTimers();
			if (timeoutHandle) clearTimeout(timeoutHandle);
			resolve({
				reason: "error",
				code: null,
				signal: null,
				orphaned: false,
				text: "",
				cut: false,
				full: full.finish(),
				wallSeconds: 0,
				error: err.message,
			});
		});

		/*
		 * `close` waits for every holder of the output pipes, so a backgrounded
		 * grandchild would hold the call open until the deadline kill. `orphaned`
		 * finishes on the shell's own exit instead and leaves the deadline armed:
		 * the background process still dies at the declared deadline.
		 */
		const finish = (code: number | null, killSignal: NodeJS.Signals | null, orphaned: boolean) => {
			if (settled) return;
			settled = true;
			stopTimers();
			if (timeoutHandle) {
				if (orphaned) timeoutHandle.unref?.();
				else clearTimeout(timeoutHandle);
			}
			if (orphaned) {
				for (const stream of [child.stdout, child.stderr]) {
					stream?.removeAllListeners("data");
					stream?.on("data", () => {});
					(stream as any)?.unref?.();
				}
			}

			const finalCarry = sanitizeForDisplay(controlCarry + stdoutDecoder.end() + stderrDecoder.end());
			if (finalCarry) {
				output.add(finalCarry);
				full.add(finalCarry);
			}
			controlCarry = "";
			const formatted = output.format(() => full.spill());
			let text = formatted.text;
			let cut = formatted.truncatedLines > 0;
			if (text.length > MAX_OUTPUT_CHARS) {
				const file = full.spill();
				text = headTailChars(text, MAX_OUTPUT_CHARS, file ? `full output: ${file}` : undefined).text;
				cut = true;
			}
			/* a caller's kill first, then idle: if both fire, "doing nothing" is the more useful diagnosis. */
			const reason: EndReason = killedBy ?? (idledOut ? "idle" : timedOut ? "timeout" : "exited");
			resolve({
				reason,
				code,
				signal: killSignal,
				orphaned,
				text,
				cut,
				full: full.finish(),
				wallSeconds: Math.round((performance.now() - startedAt) / 100) / 10,
			});
		};

		child.on("exit", (code, killSignal) => {
			if (settled) return;
			backgroundHandle = setTimeout(() => finish(code, killSignal, true), BACKGROUND_GRACE_MS);
		});
		child.on("close", (code, killSignal) => {
			if (child.pid) liveGroups.delete(child.pid);
			if (settled) {
				if (timeoutHandle) clearTimeout(timeoutHandle);
				return;
			}
			finish(code, killSignal, false);
		});
	}
}
