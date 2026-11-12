/**
 * What the model reads when a bash command has ended, whether it waited for it
 * (the tool result) or it ran on as a background job (the job's notice).
 */

import { MAX_FILE_BYTES } from "./full-output";
import type { ProcessEnd } from "./bash-process";
import { maskedExitNote } from "./command-shape";

export interface ResultLimits {
	timeoutSec: number;
	/** the idle window the command ran with; 0 when it was off */
	idleSec: number;
	/** the highest timeout a caller may declare */
	maxTimeoutSec: number;
	/** who stopped it, said when it ends as "stopped" */
	stoppedBy?: string;
}

const SEARCH_PROGRAMS = new Set(["grep", "egrep", "fgrep", "rg", "ag"]);

/** the program the command line runs last, past `VAR=x` prefixes; exit 1 from a search there means "no match" */
function lastProgram(command: string): string {
	const stage = command.split(/\|\||&&|;|\|/).at(-1) ?? "";
	const words = stage.trim().split(/\s+/).filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
	const first = (words[0] ?? "").replace(/^.*\//, "");
	return first === "git" && words[1] === "grep" ? "grep" : first;
}

export function exitNote(command: string, code: number, hasOutput: boolean): string {
	if (code === 127) return "exit code 127: command not found. The program may not be installed or not on PATH.";
	if (code === 126) return "exit code 126: found but not executable. Check its permissions.";
	if (code === 1 && !hasOutput && SEARCH_PROGRAMS.has(lastProgram(command))) {
		return "exit code 1: no matches. A search that finds nothing exits 1; this is not a failure.";
	}
	return `exit code ${code}`;
}

const error = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true }) as any;

/** the tool result for an ended command: text for the model, `structuredContent` for codemode scripts */
export function endResult(command: string, end: ProcessEnd, limits: ResultLimits): any {
	if (end.reason === "error") return error(`command error: ${end.error}`);
	const outputText = end.text;

	if (end.reason === "aborted") return error(outputText ? `${outputText}\n\ncommand aborted` : "command aborted");
	if (end.reason === "stopped") return error(`${outputText || "(no output)"}\n\n${limits.stoppedBy ?? "command stopped"}`);

	if (end.reason === "idle") {
		return error(
			`${outputText || "(no output)"}\n\n` +
				`killed: no output and no CPU activity for ${limits.idleSec}s — the process was doing ` +
				"nothing on this machine. Output above is everything it printed. A process that " +
				"finishes its work and fails to exit looks exactly like this — check the output " +
				"first; it may be complete. If this command was LEGITIMATELY quiet (a deploy or " +
				"build whose work runs on a remote server, so this machine sees no output and no " +
				"CPU), re-run it with may_run_silent: true — a longer timeout will NOT help, the " +
				"idle check ignores it.",
		);
	}

	if (end.reason === "timeout") {
		const notice =
			`command timed out after ${limits.timeoutSec} seconds (your declared timeout). ` +
			`Raise it, up to ${limits.maxTimeoutSec}s, if the command legitimately needs longer.`;
		return error(outputText ? `${outputText}\n\n${notice}` : notice);
	}

	const { full } = end;
	let result = `$ ${command}\n\n${outputText || "(no output)"}`;
	if (full.error && end.cut) result += `\n\n(full output not kept: ${full.error})`;
	if (full.capped) result += `\n\n(the full-output file stops at ${MAX_FILE_BYTES / 1024 / 1024} MiB; the command printed more)`;
	if (end.orphaned) {
		result +=
			"\n\n(the shell exited, but a background process it started still holds the output pipe, so " +
			`nothing it prints from now on is captured. It will be killed when the ${limits.timeoutSec}s timeout expires or pi exits. ` +
			"To keep a process running, start it with `background: true` instead of `&`.)";
	}

	if (end.code === null) {
		return { ...error(`${result}\n\nterminated by ${end.signal ?? "a signal"}`), details: { command } };
	}

	const structuredContent = {
		...(full.error
			? { output: outputText, truncated: end.cut }
			: {
				output: full.output,
				truncated: full.truncated,
				...(full.truncated && full.path ? { full_output_path: full.path } : {}),
			}),
		exit_code: end.code,
		wall_time_seconds: end.wallSeconds,
	};

	if (end.code !== 0) {
		result += `\n\n${exitNote(command, end.code, outputText.trim().length > 0)}`;
		return { content: [{ type: "text" as const, text: result }], isError: true, details: { command }, structuredContent };
	}
	const masked = maskedExitNote(command, full.error ? outputText : full.output);
	if (masked) result += `\n\n(${masked})`;
	return { content: [{ type: "text" as const, text: result }], details: { command }, structuredContent };
}
