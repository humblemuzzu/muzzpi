/** bash tool — shadows pi's built-in via same-name registration. */

import { existsSync } from "node:fs";
import * as path from "node:path";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { COLLAPSED_EXCERPTS, formatBoxesWindowed, normalizeForDisplay, type BoxSection } from "./lib/box-format";
import { getText, getContainer } from "./lib/tui";
import { Type } from "@sinclair/typebox";
import { withFileLock } from "./lib/mutex";
import { evaluateCommand, loadPermissions } from "./lib/permissions";
import { requestApproval } from "./lib/approval";
import { evaluateReadOnlyCommand, isReadOnlyBash, readOnlyRefusal } from "./lib/read-only-bash";
import { resolveToAbsolute } from "./read";
import { loadSecrets, makeScrubber } from "./lib/psst";
import { gitAction, leakRefusal, scanCommand } from "./lib/commit-guard";
import { heredocTags } from "./lib/remote-command";
import { BashProcess, HEAD_LINES, TAIL_LINES, sanitizeForDisplay } from "./lib/bash-process";
import { endResult } from "./lib/bash-result";
import { blindingRefusal, sleepRefusal, SLEEP_LIMIT_SEC } from "./lib/command-shape";
import { BashJobs, HEARTBEAT_MS, movedText, yieldSec, type JobResultDetails } from "./lib/bash-jobs";
import { RUN_STATUS_KEY, wakeable } from "./lib/agent-channel";
import { SUB_AGENT_TOOLS_ENV } from "./lib/sub-agent-prompt";
import { STATUS_STYLE } from "./lib/agent-style";
import { formatDuration } from "./lib/sub-agent-render";

export { exitNote } from "./lib/bash-result";

const STREAM_UPDATE_INTERVAL_MS = 150;
const MAX_WAKE_ON_CHARS = 300;

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
 * timeout is required (1..MAX) so nothing runs unbounded; it is the command's
 * deadline from its start, in the foreground and as a background job alike.
 * The idle kill (bash-process.ts) is the other bound.
 */
const MIN_TIMEOUT_SEC = 1;
const DEFAULT_MAX_TIMEOUT_SEC = 3600;
const DEFAULT_IDLE_KILL_SEC = 300;

function envInt(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw.trim() === "") return fallback;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed < 0) return fallback;
	return Math.floor(parsed);
}

/** ceiling, read at construction — it goes into the schema the model sees. */
export function maxTimeoutSec(): number {
	const value = envInt("PI_BASH_MAX_TIMEOUT_SEC", DEFAULT_MAX_TIMEOUT_SEC);
	return Math.max(MIN_TIMEOUT_SEC, value);
}

const TIMEOUT_CLAMPED_FROM = "timeout_clamped_from";

/**
 * a timeout over the ceiling runs at the ceiling, and the result says so; runs
 * before schema validation, which would refuse it. A missing, non-numeric or
 * too-small timeout is left for the schema to refuse.
 */
export function clampTimeout(args: unknown, max: number): unknown {
	if (!args || typeof args !== "object") return args;
	const raw = (args as Record<string, unknown>).timeout;
	const value = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
	if (typeof value !== "number" || !Number.isFinite(value) || value <= max) return args;
	return { ...args, timeout: max, [TIMEOUT_CLAMPED_FROM]: value };
}

function withClampNote(result: any, from: unknown, max: number): any {
	const note = `(your timeout ${from}s is over the ${max}s cap, so it ran with ${max}s)`;
	const [first, ...rest] = result?.content ?? [];
	if (first?.type !== "text") return result;
	return { ...result, content: [{ ...first, text: `${first.text}\n\n${note}` }, ...rest] };
}

/** idle window, per call so `0` can disable without rebuilding the tool. */
export function idleKillSec(): number {
	return envInt("PI_BASH_IDLE_KILL_SEC", DEFAULT_IDLE_KILL_SEC);
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

/** `wake_on` as a RegExp; `/x/i` is read as a regex literal. A refusal when it does not compile. */
function wakeOnOf(params: Record<string, unknown>): { regex?: RegExp; error?: string } {
	const raw = params.wake_on ?? params.wakeOn;
	if (raw === undefined || raw === null || raw === "") return {};
	if (typeof raw !== "string" || raw.length > MAX_WAKE_ON_CHARS) return { error: `wake_on must be a regular expression of at most ${MAX_WAKE_ON_CHARS} characters.` };
	const literal = raw.match(/^\/(.+)\/([imsu]*)$/s);
	try {
		return { regex: literal ? new RegExp(literal[1]!, literal[2]!.replace(/[gy]/g, "")) : new RegExp(raw) };
	} catch (err: any) {
		return { error: `wake_on is not a valid regular expression: ${err.message}` };
	}
}

/** the output so far, to the TUI while the call waits; at most one update per interval. */
function streamPreview(proc: BashProcess, onUpdate: ((update: any) => void) | undefined): () => void {
	if (!onUpdate) return () => {};
	let lastAt = 0;
	let pending: ReturnType<typeof setTimeout> | undefined;
	const send = () => {
		pending = undefined;
		lastAt = Date.now();
		try {
			onUpdate({ content: [{ type: "text", text: proc.preview() }] });
		} catch {}
	};
	const stop = proc.onOutput(() => {
		if (pending) return;
		const wait = STREAM_UPDATE_INTERVAL_MS - (Date.now() - lastAt);
		if (wait <= 0) send();
		else pending = setTimeout(send, wait);
	});
	return () => {
		stop();
		if (pending) clearTimeout(pending);
	};
}

/**
 * a sub-agent's parent kills it after 900s with nothing on its stdout; a command
 * that must wait in the foreground (git, a codemode script) says once a minute
 * that it runs. The command's own timeout and idle kill still bound it.
 */
export function childHeartbeat(ui: { setStatus(key: string, text: string | undefined): void } | undefined, command: string, everyMs = HEARTBEAT_MS): () => void {
	if (!ui || !process.env[SUB_AGENT_TOOLS_ENV]?.trim()) return () => {};
	const started = Date.now();
	const label = normalizeForDisplay(command.split("\n")[0] ?? "").slice(0, 60);
	let beat = false;
	const set = (text: string | undefined) => {
		try {
			ui.setStatus(RUN_STATUS_KEY, text);
		} catch {}
	};
	const timer = setInterval(() => {
		beat = true;
		set(`running \`${label}\` (${formatDuration(Date.now() - started)})`);
	}, everyMs);
	timer.unref?.();
	return () => {
		clearInterval(timer);
		if (beat) set(undefined);
	};
}

const refusal = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true }) as any;

/** command lines shown in the call header before eliding; ctrl+o shows the rest */
const COLLAPSED_CMD_LINES = 3;

interface CommandRow {
	text: string;
	folded?: boolean;
}

/** each heredoc body and its terminator become one row, so the commands around it fit the collapsed header */
function foldHeredocs(lines: string[]): CommandRow[] {
	const rows: CommandRow[] = [];
	for (let i = 0; i < lines.length; i++) {
		rows.push({ text: lines[i]! });
		for (const tag of heredocTags(lines[i]!) ?? []) {
			let end = i + 1;
			while (end < lines.length && lines[end]!.trim() !== tag) end++;
			const body = end - i - 1;
			if (body > 0) rows.push({ text: `… ${body} line${body === 1 ? "" : "s"} to ${tag}`, folded: true });
			i = Math.min(end, lines.length - 1);
		}
	}
	return rows;
}

/** grace past the max declared timeout before an orphaned elapsed-ticker self-clears */
const TICKER_SLACK_MS = 60_000;

/** output lines in a box, cached per width; collapsed it shows the start and end. */
function outputBox(text: string, expanded: boolean, notices: string[] | undefined, theme: any) {
	const lines = text.split("\n");
	let cachedWidth: number | undefined;
	let cachedLines: string[] | undefined;
	return {
		render(width: number): string[] {
			if (cachedLines !== undefined && cachedWidth === width) return cachedLines;
			const sections: BoxSection[] = [{
				blocks: [{ lines: lines.map((l) => ({ text: theme.fg("toolOutput", l), highlight: true })) }],
			}];
			cachedLines = formatBoxesWindowed(sections, expanded ? {} : { excerpts: COLLAPSED_EXCERPTS }, notices, width).split("\n");
			cachedWidth = width;
			return cachedLines;
		},
		invalidate() {
			cachedLines = undefined;
			cachedWidth = undefined;
		},
	};
}

/** the message a background job's news arrives in: a line per job, then its output. */
export function renderJobResult(message: { content: unknown; details?: unknown }, { expanded, outputPad }: { expanded: boolean; outputPad: number }, theme: any) {
	const Text = getText();
	const Container = getContainer();
	const container = new Container();
	const jobs = (message.details as JobResultDetails | undefined)?.jobs;
	if (!Array.isArray(jobs)) {
		container.addChild(new Text(normalizeForDisplay(typeof message.content === "string" ? message.content : ""), outputPad, 0));
		return container;
	}
	for (const job of jobs) {
		const style = STATUS_STYLE[job.status];
		const what = job.kind === "matched" ? "matched its wake_on line, still running" : style.verb;
		const head = `${theme.fg(style.color, style.icon)} ${theme.bold(job.id)} ${theme.fg("muted", `${what} · ${formatDuration(job.durationMs)}`)}`;
		container.addChild(new Text(`${head}\n${theme.fg("toolTitle", `$ ${normalizeForDisplay(job.command.split("\n")[0] ?? "")}`)}`, outputPad, 0));
		const body = sanitizeForDisplay(job.text.replace(/^[^\n]*\n\n(?:\$ [^\n]*\n\n)?/, ""));
		container.addChild(outputBox(body, expanded, undefined, theme));
	}
	return container;
}

// --- tool factory ---

/** `jobs` with a host moves long commands to the background; without one, every call waits for its command. */
export function createBashTool(jobs: BashJobs = new BashJobs()): ToolDefinition {
	/* a read-only session must say so in the description, not only refuse at call time. */
	const readOnly = isReadOnlyBash();
	/* ceiling is fixed for the life of the tool: it goes into the schema. */
	const maxTimeout = maxTimeoutSec();
	/* captured once so the description and the kill cannot disagree. */
	const idleSec = idleKillSec();
	const yieldAfter = yieldSec();
	const moves = jobs.movable && yieldAfter > 0;
	/* named in the description so the agent does not have to learn the idle kill from a kill. */
	const idleNote = idleSec > 0
		? `\n- A command that produces NO output AND uses NO CPU for ${idleSec}s is stopped — ` +
			"a hung process looks exactly like this. Real work is either printing or burning CPU, " +
			"so normal commands are safe. But if a command is MEANT to be quiet for a while " +
			"(a deploy pushing to a remote server over ssh, a slow silent build — the work is on " +
			"the OTHER machine, so this machine sees no output and no CPU), pass `may_run_silent: true` " +
			"and ONLY your `timeout` will bound it."
		: "";
	const backgroundNote = moves
		? `\n- A command still running after ${yieldAfter}s moves to the background as a job instead of holding you: you ` +
			"get its output so far and a job id, and its exit code and output reach you by themselves when it ends. " +
			"`background: true` moves it at once (servers, watchers). `wake_on` hands it back early on the first output " +
			"line matching a regex, so a failure early in a long run reaches you then. Calls from codemode scripts and git " +
			"commands always wait."
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
			`- Do NOT chain commands with \`;\` or \`&&\`; make separate tool calls instead. Do NOT use \`&\`${moves ? "; use `background: true`" : ""}\n` +
			"- Do NOT use interactive commands (REPLs, editors, password prompts)\n" +
			`- Output shows first ${HEAD_LINES} and last ${TAIL_LINES} lines; for larger output the truncation marker names a file holding all of it\n` +
			"- Do NOT pipe to `tail`/`head`/`grep` just to shorten output: this tool already does that and keeps the rest. For tests, " +
			"builds, type checks and installs it is refused, as is redirecting them to a file, because that hides their progress " +
			"until they end and replaces their exit code\n" +
			`- Do NOT \`sleep\` to wait (${SLEEP_LIMIT_SEC}s or more is refused): run the command that waits for what you need, such as \`gh run watch <id> --exit-status\`\n` +
			"- Environment variables and `cd` do not persist between commands; use the `cwd` parameter instead\n" +
			"- Commands run in the workspace root by default; only use `cwd` when you need a different directory\n" +
			"- ALWAYS quote file paths: `cat \"path with spaces/file.txt\"`\n" +
			"- Use the Grep tool instead of grep, the Read tool instead of cat\n" +
			"- Only run `git commit` and `git push` if explicitly instructed by the user." +
			backgroundNote +
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
			...(moves
				? {
					background: Type.Optional(Type.Boolean({
						description: "Start it as a background job at once: a server, a watcher, or anything you know runs for minutes. Its result reaches you by itself when it ends.",
					})),
					wake_on: Type.Optional(Type.String({
						description:
							"A regular expression. The first output line that matches it reaches you at once while the command keeps running, " +
							"such as `FAILED|Error|panicked` on a test run, so you can act on an early failure.",
					})),
				}
				: {}),
			/*
			 * required, schema-bounded. TypeBox `default` is unused: pi fills no
			 * defaults (Value.Convert coerces types only), so a default here would
			 * be decorative.
			 */
			timeout: Type.Number({
				minimum: MIN_TIMEOUT_SEC,
				maximum: maxTimeout,
				description:
					`Required. Max seconds this command may run (${MIN_TIMEOUT_SEC}-${maxTimeout})${moves ? ", in the foreground and as a background job together" : ""}. ` +
					"read/grep/git status 10 · typecheck/lint/unit tests 300 · build/install 600 · e2e/full suite 1800. " +
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
		prepareArguments: (args: unknown) => clampTimeout(args, maxTimeout) as any,

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
			const all: CommandRow[] = context?.expanded ? lines.map((line) => ({ text: line })) : foldHeredocs(lines);
			const shown = context?.expanded ? all : all.slice(0, COLLAPSED_CMD_LINES);
			const hidden = all.length - shown.length;

			const rows = shown.map((row, i) =>
				i === 0
					? theme.fg("toolTitle", theme.bold(`$ ${row.text}`)) + timeoutSuffix
					: theme.fg(row.folded ? "muted" : "toolTitle", `  ${row.text}`),
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
			const job = result?.details?.job;
			const timing =
				state.startedAt === undefined
					? undefined
					: `${options.isPartial ? "elapsed" : job ? `background job ${job} after` : "took"} ` +
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

			container.addChild(outputBox(text, options.expanded, timing ? [timing] : undefined, theme));
			return container;
		},

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			/* schema already enforces this; this is the net for providers that skip it. */
			const timeoutSec = params.timeout;
			if (
				typeof timeoutSec !== "number" ||
				!Number.isFinite(timeoutSec) ||
				timeoutSec < MIN_TIMEOUT_SEC ||
				timeoutSec > maxTimeout
			) {
				return refusal(
					`timeout required: seconds, ${MIN_TIMEOUT_SEC}-${maxTimeout}. ` +
						"read 10 · test 300 · build 600 · e2e 1800.",
				);
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

			if (!existsSync(effectiveCwd)) return refusal(`working directory does not exist: ${effectiveCwd}`);

			/*
			 * read-only gate first, so its message is the one a research sub-agent
			 * reads. it is checked AFTER the `cd x && cmd` split above, so the guard
			 * sees the command that will actually run rather than the wrapper.
			 */
			if (readOnly) {
				const readOnlyVerdict = evaluateReadOnlyCommand(command);
				if (!readOnlyVerdict.allowed) return refusal(readOnlyRefusal(readOnlyVerdict.reason, command));
			}

			const verdict = evaluateCommand(command, loadPermissions());
			if (verdict.action === "reject") {
				return refusal(verdict.message
					? `command rejected: ${verdict.message}`
					: `command rejected by permission rule. command: ${command}`);
			}

			const shape = sleepRefusal(command) ?? blindingRefusal(command, effectiveCwd);
			if (shape) return refusal(shape);
			const wakeOn = wakeOnOf(params);
			if (wakeOn.error) return refusal(wakeOn.error);

			if (verdict.action === "ask") {
				const asks = verdict.asks ?? [];
				const answer = await requestApproval(
					ctx,
					{
						tool: "bash",
						command,
						reasons: [...new Set(asks.map((ask) => ask.message ?? "a permission rule asks for approval"))],
						hosts: [...new Set(asks.flatMap((ask) => (ask.host ? [ask.host] : [])))],
					},
					signal,
				);
				if (!answer.approved) return { ...refusal(answer.message), terminate: answer.stop };
			}

			if (gitAction(command)) {
				const found = await scanCommand(command, effectiveCwd, await makeScrubber());
				if (found) return refusal(leakRefusal(found.action, found.leaks));
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
			const limits = { timeoutSec, idleSec: effectiveIdleSec, maxTimeoutSec: maxTimeout };
			const clampedFrom = (params as Record<string, unknown>)[TIMEOUT_CLAMPED_FROM];
			/* a codemode script cannot be woken, and a git command holds the repo's lock: both wait for the end. */
			const waits = toolCallId.includes("/") || isGitCommand(command);
			const run = async () => {
				const proc = new BashProcess({ command, cwd: effectiveCwd, timeoutSec, idleSec: effectiveIdleSec, env: secretEnv });
				const stopPreview = streamPreview(proc, onUpdate);
				const stopHeartbeat = childHeartbeat(ctx.hasUI ? ctx.ui : undefined, command);
				let result: any;
				try {
					const attended = await jobs.attend(proc, {
						command,
						limits,
						wakes: wakeable(ctx.mode),
						yieldAfterMs: waits || !moves ? undefined : yieldAfter * 1000,
						background: !waits && jobs.movable && (params.background === true || params.run_in_background === true),
						wakeOn: waits ? undefined : wakeOn.regex,
						signal,
					});
					result = "ended" in attended
						? endResult(command, attended.ended, limits)
						: { content: [{ type: "text" as const, text: movedText(command, attended, wakeOn.regex?.source, yieldAfter) }], details: { command, job: attended.moved } };
				} finally {
					stopPreview();
					stopHeartbeat();
				}
				return clampedFrom === undefined ? result : withClampNote(result, clampedFrom, maxTimeout);
			};

			if (isGitCommand(command)) {
				const gitLockKey = path.join(effectiveCwd, ".git", "__pi_git_lock__");
				return withFileLock(gitLockKey, run);
			}

			return run();
		},
	};
}
