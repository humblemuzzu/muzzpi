/** bash tool — shadows pi's built-in via same-name registration. */

import { existsSync } from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { COLLAPSED_EXCERPTS, formatBoxesWindowed, normalizeForDisplay, type BoxSection } from "./lib/box-format";
import { getText, getContainer } from "./lib/tui";
import { Type } from "@sinclair/typebox";
import { withFileLock } from "./lib/mutex";
import { evaluatePermission, loadPermissions, withoutDataHeredocs } from "./lib/permissions";
import { evaluateReadOnlyCommand, isReadOnlyBash, readOnlyRefusal } from "./lib/read-only-bash";
import { resolveToAbsolute } from "./read";
import { OutputBuffer, headTailChars } from "./lib/output-buffer";
import { FullOutput, MAX_FILE_BYTES } from "./lib/full-output";
import { loadSecrets } from "./lib/psst";
import { SLEEP_JUMP_MS, watchdogTickMs, watchdogVerdict } from "./lib/watchdog";
import { sampleGroupCpuSeconds } from "./lib/proc-cpu";

const HEAD_LINES = 50;
const TAIL_LINES = 50;
/** the line window alone lets one minified line through whole. */
const MAX_OUTPUT_CHARS = 20_000;
const SIGKILL_DELAY_MS = 3000;
/** how long after the shell exits a still-open output pipe is taken to mean a background process holds it. */
const BACKGROUND_GRACE_MS = 1500;
const STREAM_UPDATE_INTERVAL_MS = 150;

/** pi's built-in bash output contract, so codemode scripts get data, not a throw, on a non-zero exit. */
const bashOutputSchema = Type.Object({
	output: Type.String({ description: "Combined stdout and stderr, possibly truncated" }),
	truncated: Type.Boolean(),
	full_output_path: Type.Optional(Type.String({ description: "Full output, when truncated" })),
	exit_code: Type.Number(),
	wall_time_seconds: Type.Number(),
});

// --- time bounds ---

/*
 * timeout is required (1..MAX) so nothing runs unbounded. idle kill is the
 * other bound: no output AND no CPU for N seconds, from t=0 — pipes block-buffer,
 * so arming after first output never fires on the hang it exists for. CPU can
 * only keep a command alive; sample failure (undefined) degrades to stdout-only.
 * residuals, both still bounded by timeout: 0-CPU remote work (ssh) looks idle;
 * a 100% busy-loop hang is caught by the wall clock, not idle.
 */
const MIN_TIMEOUT_SEC = 1;
const DEFAULT_MAX_TIMEOUT_SEC = 600;
const DEFAULT_IDLE_KILL_SEC = 300;

/** fraction of one core over the sample window; scale-invariant so tests and production agree. */
const CPU_ALIVE_CORE_FRACTION = 0.05;

/** coarse tick; real interval is min(this, idle/3) so a short window is still observed. */
const IDLE_TICK_MS = 10_000;

function envInt(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw.trim() === "") return fallback;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed < 0) return fallback;
	return Math.floor(parsed);
}

/** off (`PI_BASH_CPU_LIVENESS=0`) falls back to stdout-only idle. */
function cpuLivenessEnabled(): boolean {
	return process.env.PI_BASH_CPU_LIVENESS !== "0";
}

/** ceiling, read at construction — it goes into the schema the model sees. */
export function maxTimeoutSec(): number {
	const value = envInt("PI_BASH_MAX_TIMEOUT_SEC", DEFAULT_MAX_TIMEOUT_SEC);
	return Math.max(MIN_TIMEOUT_SEC, value);
}

/** idle window, per call so `0` can disable without rebuilding the tool. */
export function idleKillSec(): number {
	return envInt("PI_BASH_IDLE_KILL_SEC", DEFAULT_IDLE_KILL_SEC);
}

// --- shell config ---

/**
 * pi's getShellConfig() lives in utils/shell.js, not re-exported
 * from the main package. reimplemented here — on macOS (our target)
 * this is always /bin/bash.
 */
function getShell(): { shell: string; args: string[] } {
	if (existsSync("/bin/bash")) return { shell: "/bin/bash", args: ["-c"] };
	return { shell: "sh", args: ["-c"] };
}

// --- command preprocessing ---

/**
 * models sometimes emit `cd dir && cmd` despite the system prompt
 * discouraging it. split into cwd + command so the cd takes effect
 * in the spawn call rather than being lost between invocations.
 */
function splitCdCommand(cmd: string): { cwd: string; command: string } | null {
	const match = cmd.match(/^\s*cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*(?:&&|;)\s*(.+)$/s);
	if (!match) return null;
	const dir = match[1] ?? match[2] ?? match[3];
	return { cwd: dir, command: match[4] };
}

function stripBackground(cmd: string): string {
	return cmd.replace(/\s*&\s*$/, "");
}

function isGitCommand(cmd: string): boolean {
	return /\bgit\s+/.test(cmd);
}

/**
 * inject session ID trailer into git commit commands so commits
 * are traceable back to the pi session that authored them.
 * skips if trailers are already present (model added them manually).
 */
function injectGitTrailers(cmd: string, sessionId: string): string {
	if (!/\bgit\s+commit\b/.test(cmd)) return cmd;
	if (/--trailer/.test(cmd)) return cmd;
	return cmd.replace(
		/\bgit\s+commit\b/,
		`git commit --trailer "Session-Id: ${sessionId}"`,
	);
}

// --- process management ---

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

/** groups a finished call left running in the background; each dies at its deadline or when pi exits. */
const backgroundGroups = new Set<number>();
let exitHookInstalled = false;

function trackBackgroundGroup(pid: number): void {
	backgroundGroups.add(pid);
	if (exitHookInstalled) return;
	exitHookInstalled = true;
	process.once("exit", () => {
		for (const pgid of backgroundGroups) {
			try {
				process.kill(-pgid, "SIGTERM");
			} catch {}
		}
	});
}

/** command lines shown in the call header before eliding; ctrl+o shows the rest */
const COLLAPSED_CMD_LINES = 3;

/** grace past the max declared timeout before an orphaned elapsed-ticker self-clears */
const TICKER_SLACK_MS = 60_000;

// --- output sanitization ---

/**
 * strip terminal control sequences before they reach the TUI. CSI uses ECMA-48
 * parameter bytes 0x30-0x3f so DEC private modes (`?1049h`) are caught —
 * `[0-9;]*` misses the `?` and those execute as real terminal commands.
 */
function sanitizeForDisplay(text: string): string {
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

// --- tool factory ---

export function createBashTool(): ToolDefinition {
	/* a read-only session must say so in the description, not only refuse at call time. */
	const readOnly = isReadOnlyBash();
	/* ceiling is fixed for the life of the tool: it goes into the schema. */
	const maxTimeout = maxTimeoutSec();
	/* captured once so the description and the kill cannot disagree. */
	const idleSec = idleKillSec();
	/* named in the description so the agent does not have to learn the idle kill from a kill. */
	const idleNote = idleSec > 0
		? `\n- A command that produces NO output AND uses NO CPU for ${idleSec}s is stopped — ` +
			"a hung process looks exactly like this. Real work is either printing or burning CPU, " +
			"so normal commands are safe. But if a command is MEANT to be quiet for a while " +
			"(a deploy pushing to a remote server over ssh, a slow silent build — the work is on " +
			"the OTHER machine, so this machine sees no output and no CPU), pass `may_run_silent: true` " +
			"and ONLY your `timeout` will bound it."
		: "";
	const readOnlyNote = readOnly
		? "\n\nREAD-ONLY SESSION. Only read-only commands run here. No redirection to a file " +
			"(`>`, `>>`; `>/dev/null` and `2>&1` are fine), no rm/mv/cp/mkdir/touch/chmod, no " +
			"`sed -i`, no `find -exec`, no interpreters (`node -e`, `python3 -c`), no installs, " +
			"and only git's read subcommands (log, show, diff, status, blame, ls-files, rev-parse, " +
			"grep, ...). Anything else is refused. Report the command you wanted instead of " +
			"looking for another way to run it."
		: "";

	return {
		name: "bash",
		label: "Bash",
		description:
			"Executes the given shell command using bash.\n\n" +
			"- Do NOT chain commands with `;` or `&&` or use `&` for background processes; make separate tool calls instead\n" +
			"- Do NOT use interactive commands (REPLs, editors, password prompts)\n" +
			`- Output shows first ${HEAD_LINES} and last ${TAIL_LINES} lines; for larger output the truncation marker names a file holding all of it\n` +
			"- Do NOT pipe to `tail`/`head`/`grep` just to shorten output — this tool already truncates. " +
			"Piping buffers everything until the command ends, which hides progress and makes a working command look hung\n" +
			"- Environment variables and `cd` do not persist between commands; use the `cwd` parameter instead\n" +
			"- Commands run in the workspace root by default; only use `cwd` when you need a different directory\n" +
			"- ALWAYS quote file paths: `cat \"path with spaces/file.txt\"`\n" +
			"- Use the Grep tool instead of grep, the Read tool instead of cat\n" +
			"- Only run `git commit` and `git push` if explicitly instructed by the user." +
			idleNote +
			readOnlyNote,

		parameters: Type.Object({
			cmd: Type.Optional(Type.String({
				description: "The shell command to execute.",
			})),
			command: Type.Optional(Type.String({
				description: "The shell command to execute (alias for cmd).",
			})),
			cwd: Type.Optional(
				Type.String({
					description:
						"Working directory for the command, absolute or relative to the workspace root. Defaults to workspace root.",
				}),
			),
			/* optional; never required, so it cannot break the timeout-required contract. */
			may_run_silent: Type.Optional(
				Type.Boolean({
					description:
						"Set true for a command you EXPECT to be silent for a long time — a deploy " +
						"pushing to a remote server over ssh, or a quiet build where the work happens " +
						"elsewhere. Then ONLY your `timeout` bounds it and it will NOT be stopped for " +
						`producing no output. Leave unset for normal commands (stopped if silent AND ` +
						`using no CPU for ${idleSec}s, which means the process has hung).`,
				}),
			),
			/*
			 * required, schema-bounded. TypeBox `default` is unused: pi fills no
			 * defaults (Value.Convert coerces types only), so a default here would
			 * be decorative.
			 */
			timeout: Type.Number({
				minimum: MIN_TIMEOUT_SEC,
				maximum: maxTimeout,
				description:
					`Required. Max seconds this command may run (${MIN_TIMEOUT_SEC}-${maxTimeout}). ` +
					"read/grep/git status 10 · typecheck/lint/unit tests 120 · build/install 300 · e2e/deploy 600. " +
					// only claim the idle kill when it is actually armed: with it
					// disabled this read "prints NOTHING for 0s is killed", which is
					// both false and unparseable.
					(idleSec > 0
						? `A command that prints NOTHING for ${idleSec}s is killed regardless of this value, ` +
							"UNLESS you pass may_run_silent:true (for a command you expect to be quiet, " +
							"like a remote deploy). "
						: "") +
					`If it needs more than ${maxTimeout}s, split it or run it outside the agent.`,
			}),
		}, {
			// at least one of cmd/command must be present
		}),
		outputSchema: bashOutputSchema,

		renderCall(args: any, theme: any, context: any) {
			// clock starts here, not on first output: a command can be silent for its
			// whole run. markExecutionStarted() forces a render at exactly this point.
			const startState = context?.state;
			if (startState && context?.executionStarted && startState.startedAt === undefined) {
				startState.startedAt = Date.now();
				startState.endedAt = undefined;
			}

			const Text = getText();
			// reuse component to prevent render churn — same object every call
			const text = context?.lastComponent ?? new Text("", 0, 0);
			const cmd = args.cmd || args.command || "...";
			const timeout = args.timeout;
			const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";

			// normalizeForDisplay leaves \r, which would return the cursor to column 0
			// — split on it. several rows are safe: Text.render() wraps, TUI counts.
			const lines = normalizeForDisplay(cmd).split(/\r\n?|\n/);
			while (lines.length > 1 && lines[lines.length - 1].trim() === "") lines.pop();
			const shown = context?.expanded ? lines : lines.slice(0, COLLAPSED_CMD_LINES);
			const hidden = lines.length - shown.length;

			const rows = shown.map((line, i) =>
				i === 0
					? theme.fg("toolTitle", theme.bold(`$ ${line}`)) + timeoutSuffix
					: theme.fg("toolTitle", `  ${line}`),
			);
			if (hidden > 0) rows.push(theme.fg("muted", `  … +${hidden} more (ctrl+o)`));

			text.setText(rows.join("\n"));
			return text;
		},

		renderResult(result: any, options: { expanded: boolean; isPartial: boolean }, theme: any, context: any) {
			const Text = getText();

			const Container = getContainer();

			// stamped before the early returns below: a command with no output is
			// still worth a duration, and an interval armed after them never clears.
			const state = context?.state ?? {};
			if (state.startedAt !== undefined && options.isPartial && !state.interval) {
				const stopTicker = () => {
					if (state.interval) {
						clearInterval(state.interval);
						state.interval = undefined;
					}
				};
				// a throw in a timer callback is an uncaughtException and pi exits(1)
				// — see AGENTS.md "deepseek-peak". stop rather than retry, silently.
				// deadline covers the row being dropped mid-command by /new or /resume.
				state.deadline = Date.now() + maxTimeout * 1000 + TICKER_SLACK_MS;
				state.interval = setInterval(() => {
					try {
						if (Date.now() > state.deadline) {
							stopTicker();
							return;
						}
						context?.invalidate?.();
					} catch {
						stopTicker();
					}
				}, 1000);
				state.interval.unref?.();
			}
			if (!options.isPartial || context?.isError) {
				state.endedAt ??= Date.now();
				if (state.interval) {
					clearInterval(state.interval);
					state.interval = undefined;
				}
			}
			const timing =
				state.startedAt === undefined
					? undefined
					: `${options.isPartial ? "elapsed" : "took"} ` +
						`${(((state.endedAt ?? Date.now()) - state.startedAt) / 1000).toFixed(1)}s`;
			const noOutput = timing ? `(no output) ${timing}` : "(no output)";

			// REUSE: same container every call for final expanded/collapsed rerenders
			const container = context?.lastComponent ?? new Container();
			container.clear();

			const content = result.content?.[0];
			if (!content || content.type !== "text") {
				container.addChild(new Text(theme.fg("dim", noOutput), 0, 0));
				return container;
			}

			// strip `$ command\n\n` prefix — renderCall already shows it
			let text: string = content.text;
			if (text.startsWith("$ ")) {
				const sep = text.indexOf("\n\n");
				if (sep !== -1) {
					text = text.slice(sep + 2);
				}
			}

			// safety net: sanitize again in case any sequences survived handleData
			text = sanitizeForDisplay(text);

			if (!text || text === "(no output)") {
				container.addChild(new Text(theme.fg("dim", noOutput), 0, 0));
				return container;
			}

			// --- FINAL: box format with proper expanded state ---
			const { expanded } = options;
			const outputLines = text.split("\n");

			const buildSections = (): BoxSection[] => [{
				blocks: [{ lines: outputLines.map((l) => ({ text: theme.fg("toolOutput", l), highlight: true })) }],
			}];

			const notices = timing ? [timing] : undefined;

			// capture expanded in closure
			let cachedWidth: number | undefined;
			let cachedLines: string[] | undefined;

			container.addChild({
				render(width: number): string[] {
					if (cachedLines !== undefined && cachedWidth === width) {
						return cachedLines;
					}
					const sections = buildSections();
					const visual = formatBoxesWindowed(
						sections,
						expanded ? {} : { excerpts: COLLAPSED_EXCERPTS },
						notices,
						width,
					);
					cachedLines = visual.split("\n");
					cachedWidth = width;
					return cachedLines;
				},
				invalidate() {
					cachedLines = undefined;
					cachedWidth = undefined;
				},
			});

			return container;
		},

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			/* schema already enforces this; this is the net for providers that skip it. */
			const timeoutSec = params.timeout;
			if (
				typeof timeoutSec !== "number" ||
				!Number.isFinite(timeoutSec) ||
				timeoutSec < MIN_TIMEOUT_SEC ||
				timeoutSec > maxTimeout
			) {
				return {
					content: [{
						type: "text" as const,
						text:
							`timeout required: seconds, ${MIN_TIMEOUT_SEC}-${maxTimeout}. ` +
							"read 10 · test 120 · build 300 · e2e 600.",
					}],
					isError: true,
				} as any;
			}

			// accept both `cmd` (our schema) and `command` (pi default / Claude convention)
			let command = stripBackground(params.cmd ?? params.command);
			let effectiveCwd = params.cwd
				? resolveToAbsolute(params.cwd, ctx.cwd)
				: ctx.cwd;

			const cdSplit = splitCdCommand(command);
			if (cdSplit) {
				effectiveCwd = resolveToAbsolute(cdSplit.cwd, effectiveCwd);
				command = cdSplit.command;
			}

			if (!existsSync(effectiveCwd)) {
				return {
					content: [{ type: "text" as const, text: `working directory does not exist: ${effectiveCwd}` }],
					isError: true,
				} as any;
			}

			/*
			 * read-only gate first, so its message is the one a research sub-agent
			 * reads. it is checked AFTER the `cd x && cmd` split above, so the guard
			 * sees the command that will actually run rather than the wrapper.
			 */
			if (readOnly) {
				const readOnlyVerdict = evaluateReadOnlyCommand(command);
				if (!readOnlyVerdict.allowed) {
					return {
						content: [
							{ type: "text" as const, text: readOnlyRefusal(readOnlyVerdict.reason, command) },
						],
						isError: true,
					} as any;
				}
			}

			const verdict = evaluatePermission("Bash", { cmd: withoutDataHeredocs(command) }, loadPermissions());
			if (verdict.action === "reject") {
				const msg = verdict.message
					? `command rejected: ${verdict.message}`
					: `command rejected by permission rule. command: ${command}`;
				return {
					content: [{ type: "text" as const, text: msg }],
					isError: true,
				} as any;
			}

			const sessionId = ctx.sessionManager.getSessionId();
			command = injectGitTrailers(command, sessionId);

			// inject psst vault secrets into subprocess environment
			const secrets = await loadSecrets();
			const secretEnv: Record<string, string> = {};
			for (const secret of secrets) {
				secretEnv[secret.name] = secret.value;
			}

			// may_run_silent opts a command out of the idle kill: the agent is
			// declaring it EXPECTS no output for a while (a remote deploy, a quiet
			// build). only the wall-clock timeout then bounds it. accept a couple of
			// spellings a model might reach for.
			const mayRunSilent =
				params.may_run_silent === true ||
				params.mayRunSilent === true ||
				params.expect_silent === true;
			const effectiveIdleSec = mayRunSilent ? 0 : idleSec;
			const run = () => runCommand(command, effectiveCwd, timeoutSec, effectiveIdleSec, signal, onUpdate, secretEnv);

			if (isGitCommand(command)) {
				const gitLockKey = path.join(effectiveCwd, ".git", "__pi_git_lock__");
				return withFileLock(gitLockKey, run);
			}

			return run();
		},
	};
}

// --- execution ---

async function runCommand(
	command: string,
	cwd: string,
	timeout: number,
	idleSec: number,
	signal: AbortSignal | undefined,
	onUpdate: ((update: any) => void) | undefined,
	secretEnv: Record<string, string> = {},
): Promise<any> {
	const { shell, args } = getShell();

	// merge secrets into process env — values available as $NAME in commands
	const env = { ...process.env, ...secretEnv };

	return new Promise((resolve) => {
		const startedAt = performance.now();
		const child = spawn(shell, [...args, command], {
			cwd,
			detached: true,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});

		const output = new OutputBuffer(HEAD_LINES, TAIL_LINES);
		const full = new FullOutput();
		let timedOut = false;
		let idledOut = false;
		let aborted = false;
		let controlCarry = "";
		let lastUpdateAt = 0;
		let pendingUpdate: ReturnType<typeof setTimeout> | undefined;
		// per-stream decoders: Buffer.toString("utf-8") on a chunk that splits a
		// multibyte character mid-sequence produces permanent U+FFFD corruption.
		// StringDecoder carries the partial sequence to the next chunk.
		const stdoutDecoder = new StringDecoder("utf8");
		const stderrDecoder = new StringDecoder("utf8");

		let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
		if (timeout && timeout > 0) {
			timeoutHandle = setTimeout(() => {
				timedOut = true;
				if (child.pid) killGracefully(child.pid);
			}, timeout * 1000);
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
		let lastCpuSecs = cpuOn && child.pid ? sampleGroupCpuSeconds(child.pid) : undefined;
		let lastCpuSampleAt = Date.now();
		let idleHandle: ReturnType<typeof setInterval> | undefined;
		if (idleMs > 0) {
			// wrapped for the same reason as the elapsed ticker. on a throw, stop the
			// watchdog rather than kill: the declared timeout still bounds the run.
			const idleTick = () => {
				// one kill only. after the first tick fires, `lastOutputAt` can never
				// advance again (the process is dying and producing nothing), so every
				// later tick would re-issue SIGTERM and queue another 3s SIGKILL timer
				// against a process that is already on its way out.
				if (idledOut) return;
				const now = Date.now();
				/* CPU can only bump lastOutputAt; undefined (ps failed) is no signal. */
				if (cpuOn && child.pid) {
					const cpuNow = sampleGroupCpuSeconds(child.pid);
					// only advance the sample state on a REAL reading: a failed `ps`
					// (undefined) leaves last{CpuSecs,SampleAt} untouched, so the next
					// success measures the true rate across the gap rather than a
					// short interval against a stale baseline.
					if (cpuNow !== undefined) {
						if (lastCpuSecs !== undefined) {
							const elapsedSec = (now - lastCpuSampleAt) / 1000;
							// threshold scales with elapsed wall time, so it is identical at
							// a 10s production tick and a sub-second test tick. abs(): a
							// child exiting drops the group total, and that drop is activity
							// too. this only ever BUMPS lastOutputAt (keeps the command
							// alive) — it can never cause a kill.
							const threshold = Math.max(elapsedSec, 0) * CPU_ALIVE_CORE_FRACTION;
							if (Math.abs(cpuNow - lastCpuSecs) > threshold) lastOutputAt = now;
						}
						lastCpuSecs = cpuNow;
						lastCpuSampleAt = now;
					}
				}
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
				try {
					idleTick();
				} catch {
					if (idleHandle) clearInterval(idleHandle);
					idleHandle = undefined;
				}
			}, watchdogTickMs(idleMs, IDLE_TICK_MS));
			idleHandle.unref?.();
		}

		const onAbort = () => {
			aborted = true;
			if (child.pid) killGracefully(child.pid);
		};
		if (signal) {
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		}

		const sendUpdate = () => {
			pendingUpdate = undefined;
			lastUpdateAt = Date.now();
			const { text } = output.preview();
			onUpdate?.({ content: [{ type: "text", text }] });
		};

		const scheduleUpdate = () => {
			if (!onUpdate || pendingUpdate) return;
			const elapsed = Date.now() - lastUpdateAt;
			if (elapsed >= STREAM_UPDATE_INTERVAL_MS) {
				sendUpdate();
				return;
			}
			pendingUpdate = setTimeout(sendUpdate, STREAM_UPDATE_INTERVAL_MS - elapsed);
		};

		const handleData = (decoder: StringDecoder) => (data: Buffer) => {
			// liveness is stamped on RAW arrival, before sanitization: bytes that
			// sanitize to nothing (a redrawing progress bar) still prove the process
			// is running. counting only displayable text would kill it.
			lastOutputAt = Date.now();
			// sanitize at source — strip terminal control sequences before they
			// enter the buffer or reach onUpdate. prevents escape sequences from
			// ever flowing through the TUI pipeline (even briefly via onUpdate).
			// keep incomplete escape sequences across chunks so high-volume SSH
			// output cannot leak a split CSI/OSC sequence as printable garbage.
			const raw = controlCarry + decoder.write(data);
			const { display, carry } = splitIncompleteEscape(raw);
			controlCarry = carry;
			const sanitized = sanitizeForDisplay(display);
			if (sanitized) {
				output.add(sanitized);
				full.add(sanitized);
			}
			scheduleUpdate();
		};

		child.stdout?.on("data", handleData(stdoutDecoder));
		child.stderr?.on("data", handleData(stderrDecoder));

		let settled = false;
		let backgroundHandle: ReturnType<typeof setTimeout> | undefined;

		child.on("error", (err) => {
			if (settled) return;
			settled = true;
			if (backgroundHandle) clearTimeout(backgroundHandle);
			if (timeoutHandle) clearTimeout(timeoutHandle);
			if (idleHandle) clearInterval(idleHandle);
			if (pendingUpdate) clearTimeout(pendingUpdate);
			signal?.removeEventListener("abort", onAbort);
			full.finish();
			resolve({
				content: [{ type: "text" as const, text: `command error: ${err.message}` }],
				isError: true,
			} as any);
		});

		/*
		 * `close` waits for every holder of the output pipes, so a backgrounded
		 * grandchild would hold the call open until the timeout kill. `background`
		 * finishes on the shell's own exit instead and leaves the timeout armed:
		 * the background process still dies at the declared deadline.
		 */
		const finish = (code: number | null, killSignal: NodeJS.Signals | null, background: boolean) => {
			if (settled) return;
			settled = true;
			if (backgroundHandle) clearTimeout(backgroundHandle);
			if (timeoutHandle) {
				if (background) timeoutHandle.unref?.();
				else clearTimeout(timeoutHandle);
			}
			if (idleHandle) clearInterval(idleHandle);
			if (pendingUpdate) clearTimeout(pendingUpdate);
			signal?.removeEventListener("abort", onAbort);
			if (background) {
				if (child.pid) trackBackgroundGroup(child.pid);
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
			let outputText = formatted.text;
			let modelViewCut = formatted.truncatedLines > 0;
			if (outputText.length > MAX_OUTPUT_CHARS) {
				const file = full.spill();
				outputText = headTailChars(outputText, MAX_OUTPUT_CHARS, file ? `full output: ${file}` : undefined).text;
				modelViewCut = true;
			}
			const finished = full.finish();

			if (aborted) {
				const text = outputText ? `${outputText}\n\ncommand aborted` : "command aborted";
				resolve({
					content: [{ type: "text" as const, text }],
					isError: true,
				} as any);
				return;
			}

			/* idle first: if both fire, "doing nothing" is the more useful diagnosis. */
			if (idledOut) {
				const text =
					`${outputText || "(no output)"}\n\n` +
					`killed: no output and no CPU activity for ${idleSec}s — the process was doing ` +
					"nothing on this machine. Output above is everything it printed. A process that " +
					"finishes its work and fails to exit looks exactly like this — check the output " +
					"first; it may be complete. If this command was LEGITIMATELY quiet (a deploy or " +
					"build whose work runs on a remote server, so this machine sees no output and no " +
					"CPU), re-run it with may_run_silent: true — a longer timeout will NOT help, the " +
					"idle check ignores it.";
				resolve({
					content: [{ type: "text" as const, text }],
					isError: true,
				} as any);
				return;
			}

			if (timedOut) {
				const notice =
					`command timed out after ${timeout} seconds (your declared timeout). ` +
					`Raise it, up to ${maxTimeoutSec()}s, if the command legitimately needs longer.`;
				const text = outputText ? `${outputText}\n\n${notice}` : notice;
				resolve({
					content: [{ type: "text" as const, text }],
					isError: true,
				} as any);
				return;
			}

			// format result with command header
			let result = `$ ${command}\n\n${outputText || "(no output)"}`;
			if (finished.error && modelViewCut) result += `\n\n(full output not kept: ${finished.error})`;
			if (finished.capped) result += `\n\n(the full-output file stops at ${MAX_FILE_BYTES / 1024 / 1024} MiB; the command printed more)`;
			if (background) {
				result +=
					"\n\n(the shell exited, but a background process it started still holds the output pipe, so " +
					`nothing it prints from now on is captured. It will be killed when the ${timeout}s timeout expires or pi exits. ` +
					"To keep a process running, redirect its output (`cmd > /tmp/cmd.log 2>&1 &`) or run it in tmux.)";
			}

			if (code === null) {
				resolve({
					content: [{ type: "text" as const, text: `${result}\n\nterminated by ${killSignal ?? "a signal"}` }],
					isError: true,
					details: { command },
				} as any);
				return;
			}

			const structuredContent = {
				...(finished.error
					? { output: outputText, truncated: modelViewCut }
					: {
						output: finished.output,
						truncated: finished.truncated,
						...(finished.truncated && finished.path ? { full_output_path: finished.path } : {}),
					}),
				exit_code: code,
				wall_time_seconds: Math.round((performance.now() - startedAt) / 100) / 10,
			};

			if (code !== 0) {
				result += `\n\nexit code ${code}`;
				resolve({
					content: [{ type: "text" as const, text: result }],
					isError: true,
					details: { command },
					structuredContent,
				} as any);
			} else {
				resolve({
					content: [{ type: "text" as const, text: result }],
					details: { command },
					structuredContent,
				} as any);
			}
		};

		child.on("exit", (code, killSignal) => {
			if (settled) return;
			backgroundHandle = setTimeout(() => finish(code, killSignal, true), BACKGROUND_GRACE_MS);
		});
		child.on("close", (code, killSignal) => {
			if (settled) {
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (child.pid) backgroundGroups.delete(child.pid);
				return;
			}
			finish(code, killSignal, false);
		});
	});
}
