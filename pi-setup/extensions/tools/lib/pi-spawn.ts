/** shared spawn-parse-collect loop for dedicated sub-agent tools. */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@mariozechner/pi-ai";
import { interpolatePromptVars, type InterpolateContext } from "./interpolate";
import { SUB_AGENT_TOOLS_ENV } from "./sub-agent-prompt";
import { READ_ONLY_BASH_ENV } from "./read-only-bash";
import { SLEEP_JUMP_MS, watchdogTickMs, watchdogVerdict } from "./watchdog";
import { loadAgentModels, modelViolation } from "./agent-models";

// --- stall watchdog ---

/*
 * backstop on a headless child: watches RAW stdout/stderr bytes (parsed events
 * ignore the streaming that proves liveness). 900s sits above pi's HTTP idle
 * 300s + retry, so it cannot race a legal bash command. the child is not spawned
 * detached — Ctrl+C must reach it. kill != released: a grandchild can hold
 * stdout open after SIGKILL, so FORCE_RELEASE_MS returns anyway.
 */
const DEFAULT_STALL_SEC = 900;
const STALL_TICK_MS = 30_000;

const FORCE_RELEASE_MS = 10_000;

function stallSec(): number {
	const raw = process.env.PI_SPAWN_STALL_SEC;
	if (raw === undefined || raw.trim() === "") return DEFAULT_STALL_SEC;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_STALL_SEC;
	return Math.floor(parsed);
}

// --- tool name aliases ---

/** requested name -> registered name. unknown names are dropped silently by pi. */
const TOOL_ALIASES: Record<string, string> = {
	glob: "find",
	edit_file: "edit",
	create_file: "write",
};

export function resolveAliases(names: string[]): string[] {
	return [...new Set(names.map((name) => TOOL_ALIASES[name] ?? name))];
}

// --- types ---

/** sub-agent conversations. not pi's sessions/ — /resume lists everything there. */
export const SUB_AGENT_SESSION_DIR: string = path.join(os.homedir(), ".pi", "agent", "sessions-sub");

/** pi's own session directory, the one `/resume` lists. */
export const PI_SESSIONS_DIR: string = path.join(os.homedir(), ".pi", "agent", "sessions");

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

/**
 * where a sub-agent's conversation was stored, when it was persisted.
 *
 * `continueId` is the handle a caller passes back to resume the same child:
 * it is the pi session id, which `--session-id` resolves (creating the
 * session on first use, reopening it afterwards).
 */
export interface SpawnSessionMeta {
	continueId?: string;
	sessionId?: string;
	sessionFile?: string;
	sessionDir?: string;
}

/**
 * how the child's conversation should be stored.
 *
 * omitted entirely (the default) means `--no-session`: sub-agents are
 * throwaway and must not litter the session list. only `delegate` and `chad`
 * opt in, because both are resumable by continueId.
 */
export interface SpawnSessionConfig {
	/** resume this session id; created if it does not exist yet. */
	id?: string;
	/** persist the conversation. false / omitted keeps the child ephemeral. */
	persist?: boolean;
	/**
	 * where to store the conversation. defaults to pi's own session directory.
	 *
	 * sub-agents set this to SUB_AGENT_SESSION_DIR so their sessions stay OUT
	 * of the `/resume` picker — a handful of delegate calls otherwise buries
	 * your real sessions under machine-generated ones.
	 */
	dir?: string;
	/** parent session file, recorded for provenance only. */
	parentSession?: string;
	/**
	 * branch leaf to continue. pi's CLI has no flag for targeting a specific
	 * leaf, so this is REJECTED rather than silently ignored — quietly
	 * continuing from the wrong branch point would corrupt the child's history.
	 */
	leafId?: string;
}

export interface PiSpawnResult {
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	/** "provider/model" the child actually answered with, once it has answered. */
	model?: string;
	/** effective thinking level, after pi adjusted it to the model. */
	thinkingLevel?: string;
	stopReason?: string;
	errorMessage?: string;
	session?: SpawnSessionMeta;
}

export interface PiSpawnConfig {
	cwd: string;
	task: string;
	/**
	 * "provider/model", passed to `--model` verbatim; omitted means pi's own
	 * default. a bare id is ambiguous across providers since pi 0.84 (#7327),
	 * which is why lib/agent-models.ts only ever hands this a qualified id.
	 */
	model?: string;
	/**
	 * thinking level for the child (`--thinking`). one of pi's levels: off,
	 * minimal, low, medium, high, xhigh, max.
	 *
	 * passed as its own flag rather than as a `model:high` suffix, so an explicit
	 * level always beats whatever the child would inherit from settings.
	 */
	thinkingLevel?: string;
	/**
	 * run the child's bash tool under the read-only policy (lib/read-only-bash.ts).
	 *
	 * removing a sub-agent's mutation tools is only half a constraint — bash can
	 * write. this closes the other half, in the child's own process, rather than
	 * asking the prompt nicely.
	 */
	readOnlyBash?: boolean;
	/** merged into one native --tools allowlist. unknown names are dropped silently by pi. */
	builtinTools?: string[];
	extensionTools?: string[];
	systemPromptBody?: string;
	signal?: AbortSignal;
	onUpdate?: (result: PiSpawnResult) => void;
	sessionId?: string;
	repo?: string;
	/** conversation persistence / continuation. see SpawnSessionConfig. */
	session?: SpawnSessionConfig;
	/** queued at startup, delivered when idle; process is killed after the second end_turn. */
	followUp?: string;
}

// --- helpers ---

/**
 * pi session ids are used verbatim in the session FILENAME, so anything that
 * is not filename-safe would be mangled or could escape the session directory.
 */
function assertSafeSessionId(id: string): void {
	if (!/^[\w.-]{1,128}$/.test(id)) {
		throw new Error(
			`invalid session id ${JSON.stringify(id)}: use only letters, digits, '.', '-' or '_' (max 128 chars)`,
		);
	}
}

/**
 * translate a SpawnSessionConfig into pi CLI flags.
 *
 * `--session-id` both creates and reopens a session, which is exactly the
 * continuation semantics we need. upstream instead hand-writes a linked
 * session header file and passes `--session <file>`; using the native flag
 * means no session-file format for us to keep in sync with pi.
 */
function resolveSessionArgs(session: SpawnSessionConfig | undefined): {
	args: string[];
	meta?: SpawnSessionMeta;
} {
	if (session?.leafId) {
		throw new Error(
			"session.leafId is not supported: pi's CLI cannot target a specific branch leaf, " +
				"and continuing from the wrong leaf would corrupt the child's history",
		);
	}

	// default stays ephemeral: only an explicit opt-in persists a sub-agent.
	if (!session?.persist && !session?.id) return { args: ["--no-session"] };

	const id = session.id ?? `delegate-${randomUUID()}`;
	assertSafeSessionId(id);

	const args = ["--session-id", id];
	if (session.dir) {
		fs.mkdirSync(session.dir, { recursive: true });
		// must come BEFORE resolution of the id, and must be passed on every
		// resume too, or pi looks for the session in the default directory.
		args.unshift("--session-dir", session.dir);
	}
	return { args, meta: { continueId: id, sessionId: id, sessionDir: session.dir } };
}

function readSessionHeader(file: string): { id?: unknown; cwd?: unknown } | undefined {
	let fd: number | undefined;
	try {
		fd = fs.openSync(file, "r");
		const buf = Buffer.alloc(4096);
		const n = fs.readSync(fd, buf, 0, buf.length, 0);
		const firstLine = buf.subarray(0, n).toString("utf-8").split("\n")[0] ?? "";
		const header = JSON.parse(firstLine);
		return header?.type === "session" ? header : undefined;
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

/**
 * why `--session-id <id>` would NOT reopen an existing conversation, or
 * undefined when it would. pi reopens only a session in `dir` whose header has
 * this id AND this cwd; anything else it silently creates as a new, empty one.
 */
export function unresumableReason(
	id: string,
	cwd: string,
	agent: string,
	dir: string = SUB_AGENT_SESSION_DIR,
): string | undefined {
	let files: string[] = [];
	try {
		files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
	} catch {}
	const named = files.filter((f) => f.includes(id));
	const candidates = (named.length > 0 ? named : files)
		.map((f) => readSessionHeader(path.join(dir, f)))
		.filter((h) => h?.id === id);

	if (candidates.length === 0) {
		return (
			`unknown continueId "${id}": no saved ${agent} conversation has that id. ` +
			`Pass the continueId exactly as a previous ${agent} result printed it, or omit it to start a new ${agent}.`
		);
	}
	const here = path.resolve(cwd);
	if (candidates.some((h) => typeof h!.cwd === "string" && path.resolve(h!.cwd) === here)) return undefined;
	const started = candidates.map((h) => h!.cwd).find((c) => typeof c === "string");
	return (
		`continueId "${id}" belongs to a ${agent} started in ${started ?? "another directory"}, and pi resumes it ` +
		`only from there (this session is in ${here}). Omit continueId to start a new ${agent} here.`
	);
}

function writePromptToTempFile(label: string, prompt: string): { dir: string; filePath: string } {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = label.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	fs.writeFileSync(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	return { dir: tmpDir, filePath };
}

export function zeroUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

/**
 * read an agent prompt .md file, strip frontmatter, return body.
 * looks in ~/.pi/agent/agents/{filename}.
 */
export function readAgentPrompt(filename: string): string {
	const promptPath = path.join(os.homedir(), ".pi", "agent", "agents", filename);
	try {
		const content = fs.readFileSync(promptPath, "utf-8");
		if (content.startsWith("---")) {
			const endIdx = content.indexOf("\n---", 3);
			if (endIdx !== -1) return content.slice(endIdx + 4).trim();
		}
		return content;
	} catch { return ""; }
}

// --- spawn ---

const PI_AGENT_DIR = path.join(os.homedir(), ".pi", "agent");

/**
 * The only extensions a headless child uses: every sub-agent run on record
 * called no tool, command or hook from the others. tools and system-prompt
 * are required.
 */
export const CHILD_EXTENSIONS: readonly string[] = [
	path.join(PI_AGENT_DIR, "extensions", "tools"),
	path.join(PI_AGENT_DIR, "extensions", "system-prompt.js"),
	path.join(PI_AGENT_DIR, "extensions", "guardrails"),
	path.join(PI_AGENT_DIR, "extensions", "anthropic-sub.js"),
];

/** set to 1 to give children every extension again */
export const ALL_EXTENSIONS_ENV = "PI_SUBAGENT_ALL_EXTENSIONS";

export function childExtensionArgs(tools: readonly string[] = []): string[] {
	if (process.env[ALL_EXTENSIONS_ENV] === "1") return [];
	if (!CHILD_EXTENSIONS.slice(0, 2).every((p) => fs.existsSync(p))) return [];
	const paths = CHILD_EXTENSIONS.filter((p) => fs.existsSync(p));
	// pi adds built-ins during extension discovery, which --no-extensions skips
	if (tools.includes("codemode")) paths.push("builtin:codemode");
	return ["--no-extensions", ...paths.flatMap((p) => ["-e", p])];
}

export async function piSpawn(config: PiSpawnConfig): Promise<PiSpawnResult> {
	const useRpc = !!config.followUp;
	const routing = resolveSessionArgs(config.session);
	const requestedTools = resolveAliases([
		...(config.builtinTools ?? []),
		...(config.extensionTools ?? []),
	]);
	const args: string[] = useRpc
		? ["--mode", "rpc", ...routing.args, ...childExtensionArgs(requestedTools)]
		: ["--mode", "json", "-p", ...routing.args, ...childExtensionArgs(requestedTools)];

	if (config.model) args.push("--model", config.model);

	// explicit level beats the child's inherited default (pi applies --thinking
	// after every other source; see main.js buildSessionOptions).
	if (config.thinkingLevel) {
		args.push("--thinking", config.thinkingLevel);
	}
	// one native --tools allowlist. never emit --no-tools: it empties the
	// registry so nothing can be re-activated afterwards.
	if (requestedTools.length > 0) {
		args.push("--tools", requestedTools.join(","));
	}

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;
	/*
	 * declared OUT here, not in the try below, because `finally` cannot see a
	 * binding scoped to the try block -- and `finally` is the one place that runs
	 * after both of the promise's resolve paths (`close` and `error`), so it is
	 * where the interval has to be cleared for the timer to be unleakable.
	 */
	let watchdog: ReturnType<typeof setInterval> | undefined;
	/** see FORCE_RELEASE_MS. hoisted for the same reason as `watchdog`. */
	let releaseTimer: ReturnType<typeof setTimeout> | undefined;

	const result: PiSpawnResult = {
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: zeroUsage(),
		model: config.model,
		thinkingLevel: config.thinkingLevel,
		// present only when the child was persisted; callers use
		// session.continueId to resume this exact child later.
		...(routing.meta ? { session: routing.meta } : {}),
	};

	try {
		if (config.systemPromptBody?.trim()) {
			const interpolated = interpolatePromptVars(
				config.systemPromptBody, config.cwd, { sessionId: config.sessionId, repo: config.repo },
			);
			const tmp = writePromptToTempFile("subagent", interpolated);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		// in print mode, task is a CLI arg. in RPC mode, sent via stdin prompt command.
		if (!useRpc) {
			args.push(`Task: ${config.task}`);
		}

		const spawnEnv: Record<string, string | undefined> = {
			...process.env,
			PI_READ_COMPACT: "1",
			// tell the child which tools it ACTUALLY has, from the same array that
			// becomes `--tools` above. system-prompt.ts reads this and gives the
			// child a prompt naming exactly these tools instead of the parent's
			// full ~40-tool prompt, which is mostly false inside a child.
			// see lib/sub-agent-prompt.ts for the measured failure it prevents.
			...(requestedTools.length > 0
				? { [SUB_AGENT_TOOLS_ENV]: requestedTools.join(",") }
				: {}),
			// the child's own bash tool reads this at construction and both
			// advertises and enforces the read-only policy.
			...(config.readOnlyBash ? { [READ_ONLY_BASH_ENV]: "1" } : {}),
		};

		let wasAborted = false;
		/*
		 * hoisted out of the promise executor so the `finally` below can clear the
		 * interval. the promise has exactly two resolve paths -- `proc.on("close")`
		 * and `proc.on("error")` -- and `finally` runs after either, so one
		 * clearInterval covers both and the timer cannot outlive the spawn.
		 */
		let stalled = false;
		let wrongModel: string | undefined;
		const agentModels = loadAgentModels();
		const debugEnabled = !!process.env.PI_SPAWN_DEBUG;
		const debug = (label: string, data?: Record<string, unknown>) => {
			if (!debugEnabled) return;
			const suffix = data ? ` ${JSON.stringify(data)}` : "";
			process.stderr.write(`[pi-spawn] ${label}${suffix}\n`);
		};

		// allow overriding the pi binary (testing / non-PATH installs). bdsqqq's
		// pi-spawn does the same.
		const piBin = process.env.PI_BIN || "pi";

		const exitCode = await new Promise<number>((resolve) => {
			const proc = spawn(piBin, args, {
				cwd: config.cwd, shell: false,
				stdio: [useRpc ? "pipe" : "ignore", "pipe", "pipe"],
				env: spawnEnv,
			});

			// RPC state: track end_turns to know when to kill
			let endTurnCount = 0;

			const stallMs = stallSec() * 1000;
			let lastActivity = Date.now();
			let lastStallTickAt = Date.now();
			/*
			 * set the moment we kill for ANY reason (stall or user abort). the
			 * watchdog then doubles as the release backstop, so no second timer is
			 * needed and `finally`'s single clearInterval still covers everything.
			 */
			let killedAt: number | undefined;
			let released = false;
			/*
			 * dedicated timer, not a phase of the watchdog interval — that period
			 * scales with the stall window, so FORCE_RELEASE_MS would not mean what it says.
			 */
			const scheduleRelease = () => {
				if (releaseTimer !== undefined) return;
				releaseTimer = setTimeout(() => {
					if (released) return;
					released = true;
					debug("force_release", { afterMs: FORCE_RELEASE_MS });
					resolve(1);
				}, FORCE_RELEASE_MS);
			};
			if (stallMs > 0) {
				watchdog = setInterval(() => {
					const now = Date.now();
					// already killed by this or any other path: the release timer owns
					// what happens next, and re-killing would only queue redundant
					// signals at a process on its way out.
					if (killedAt !== undefined) return;
					const verdict = watchdogVerdict(now, lastStallTickAt, lastActivity, stallMs, SLEEP_JUMP_MS);
					lastStallTickAt = now;
					if (verdict === "slept") { lastActivity = now; return; }
					if (verdict === "wait") return;
					stalled = true;
					killedAt = now;
					debug("kill_stalled", { stallMs });
					scheduleRelease();
					proc.kill("SIGTERM");
					setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 5000);
				}, watchdogTickMs(stallMs, STALL_TICK_MS));
			}

			// send initial prompt via RPC stdin, then immediately queue follow_up.
			// follow_up is queued (not delivered) until the agent is idle, so the
			// agent loop's getFollowUpMessages() will find it after exploration.
			// sending it eagerly avoids a race where the loop exits before a
			// late follow_up arrives through the cross-process stdin/stdout round-trip.
			if (useRpc && proc.stdin) {
				const promptCmd = JSON.stringify({ type: "prompt", message: `Task: ${config.task}` });
				debug("send_prompt");
				proc.stdin.write(promptCmd + "\n");

				if (config.followUp) {
					const followUpCmd = JSON.stringify({ type: "follow_up", message: config.followUp });
					debug("send_follow_up");
					proc.stdin.write(followUpCmd + "\n");
				}
			}

			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try { event = JSON.parse(line); } catch { return; }

				// skip RPC protocol responses (acks for prompt/follow_up/abort commands)
				if (event.type === "response") return;

				if ((event.type === "message_start" || event.type === "message_end") && event.message?.role === "assistant" && !wrongModel) {
					const { provider, model } = event.message;
					const actual = provider && model ? `${provider}/${model}` : undefined;
					const refusal = actual ? modelViolation(actual, config.model, agentModels) : undefined;
					if (refusal) {
						wrongModel = refusal;
						debug("kill_wrong_model", { actual, requested: config.model });
						killedAt ??= Date.now();
						scheduleRelease();
						proc.kill("SIGKILL");
					}
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					result.messages.push(msg);

					if (msg.role === "assistant") {
						result.usage.turns++;
						const usage = (msg as any).usage;
						if (usage) {
							result.usage.input += usage.input || 0;
							result.usage.output += usage.output || 0;
							result.usage.cacheRead += usage.cacheRead || 0;
							result.usage.cacheWrite += usage.cacheWrite || 0;
							result.usage.cost += usage.cost?.total || 0;
							result.usage.contextTokens = usage.totalTokens || 0;
						}
						const { provider, model, thinkingLevel } = msg as any;
						if (model) result.model = provider ? `${provider}/${model}` : model;
						if (thinkingLevel) result.thinkingLevel = thinkingLevel;
						if ((msg as any).stopReason) result.stopReason = (msg as any).stopReason;
						if ((msg as any).errorMessage) result.errorMessage = (msg as any).errorMessage;

						const stopReason = (msg as any).stopReason as string | undefined;
						const isTurnEnd = stopReason === "end_turn" || stopReason === "stop";
						const expectedTurns = config.followUp ? 2 : 1;
						debug("turn_end", { stopReason, isTurnEnd, endTurnCount, expectedTurns });

						// RPC kill logic: terminate after expected number of end_turns.
						// follow_up was already queued eagerly at startup, so we just
						// count turns and kill when done.
						if (useRpc && isTurnEnd) {
							endTurnCount++;
							if (endTurnCount >= expectedTurns) {
								debug("kill_after_turn", { endTurnCount });
								// same release grace as every other kill: a child that
								// finished normally must not hang on a stuck pipe.
								killedAt ??= Date.now();
								scheduleRelease();
								proc.kill("SIGTERM");
								setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 5000);
							}
						}

						// RPC: if agent errors, terminate immediately
						if (useRpc && (stopReason === "error" || stopReason === "aborted")) {
							debug("kill_after_error", { stopReason });
							killedAt ??= Date.now();
							scheduleRelease();
							proc.kill("SIGTERM");
							setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 5000);
						}
					}

					if (config.onUpdate) config.onUpdate({ ...result });
				}

				if (event.type === "tool_result_end" && event.message) {
					result.messages.push(event.message as Message);
					if (config.onUpdate) config.onUpdate({ ...result });
				}
			};

			proc.stdout.on("data", (data: Buffer) => {
				if (released) return;
				lastActivity = Date.now();
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data: Buffer) => {
				if (released) return;
				lastActivity = Date.now();
				result.stderr += data.toString();
			});

			proc.on("close", (code) => {
				// `released` means the promise already resolved and the caller holds
				// `result`. parsing a trailing line now would mutate an object that has
				// been handed off — the same class as the stale-ctx timer crash this
				// repo has already been bitten by once.
				if (!released && buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", () => resolve(1));

			if (config.signal) {
				const killProc = () => {
					wasAborted = true;
					// release backstop applies to a user abort too: Esc must free the
					// parent even when a grandchild is holding the child's stdout.
					killedAt ??= Date.now();
					scheduleRelease();
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (config.signal.aborted) killProc();
				else config.signal.addEventListener("abort", killProc, { once: true });
			}
		});

		result.exitCode = exitCode;
		if (wasAborted) {
			result.exitCode = 1;
			result.stopReason = "aborted";
		}
		/*
		 * after `wasAborted`, so Esc is never relabelled as a stall. relaunch,
		 * never resume: a child killed mid-tool-call leaves a tool_use without
		 * tool_result, so resuming is a provider 400.
		 */
		if (stalled) {
			result.exitCode = 1;
			result.stopReason = "stalled";
			result.errorMessage =
				`sub-agent killed: no output for ${Math.round(stallSec() / 60)}m. ` +
				"Launch a fresh one for the remaining work — this child cannot be resumed.";
		}
		// RPC processes are killed intentionally — don't treat SIGTERM exit as error
		if (useRpc && result.exitCode !== 0 && (result.stopReason === "end_turn" || result.stopReason === "stop")) {
			result.exitCode = 0;
		}
		if (wrongModel) {
			result.exitCode = 1;
			result.stopReason = "error";
			result.errorMessage = wrongModel;
		}
		return result;
	} finally {
		if (watchdog) clearInterval(watchdog);
		if (releaseTimer) clearTimeout(releaseTimer);
		if (tmpPromptPath) try { fs.unlinkSync(tmpPromptPath); } catch { /* ignore */ }
		if (tmpPromptDir) try { fs.rmdirSync(tmpPromptDir); } catch { /* ignore */ }
	}
}
