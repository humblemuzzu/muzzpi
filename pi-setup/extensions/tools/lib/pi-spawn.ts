/** shared spawn-parse-collect loop for dedicated sub-agent tools. */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@mariozechner/pi-ai";
import { interpolatePromptVars, type InterpolateContext } from "./interpolate";
import { SUB_AGENT_TOOLS_ENV } from "./sub-agent-prompt";
import { HOLDER_ENV } from "./file-lock";
import { READ_ONLY_BASH_ENV } from "./read-only-bash";
import { SLEEP_JUMP_MS, watchdogTickMs, watchdogVerdict } from "./watchdog";
import { loadAgentModels, modelViolation, type AgentModels } from "./agent-models";
import { repairInterrupted, savedSessionModel, subAgentSessionFile } from "./session-repair";
import { CACHE_PING_ENTRY } from "./prompt-cache";

// --- stall watchdog ---

/*
 * backstop on a headless child: watches RAW stdout/stderr bytes (parsed events
 * ignore the streaming that proves liveness). 900s sits above pi's HTTP idle
 * 300s + retry, so it cannot race a legal bash command. the child is not spawned
 * detached — Ctrl+C must reach it.
 */
const DEFAULT_STALL_SEC = 900;
const STALL_TICK_MS = 30_000;

const DEFAULT_FORCE_RELEASE_MS = 10_000;

/** PI_SPAWN_RELEASE_MS shortens the grace after a kill or a settle (tests use it). */
export function forceReleaseMs(): number {
	const parsed = Number(process.env.PI_SPAWN_RELEASE_MS);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_FORCE_RELEASE_MS;
}

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

function addSpend(stats: UsageStats, usage: any): void {
	stats.input += usage.input || 0;
	stats.output += usage.output || 0;
	stats.cacheRead += usage.cacheRead || 0;
	stats.cacheWrite += usage.cacheWrite || 0;
	stats.cost += usage.cost?.total || 0;
}

/** A keep-alive read is not progress: a child hung mid-turn keeps reading its cache and must still stall out. */
function isKeepAliveLine(line: string): boolean {
	return line.startsWith('{"type":"entry_appended"') && line.includes(`"customType":"${CACHE_PING_ENTRY}"`);
}

/**
 * where a sub-agent's conversation was stored, when it was persisted.
 *
 * `continueId` is the handle a caller passes back to resume the same child:
 * it is the pi session id, which `--session-id` resolves (creating the
 * session on first use, reopening it afterwards).
 */
export interface SpawnSessionMeta {
	continueId: string;
	sessionDir: string;
}

/**
 * where the child's conversation is stored. omitted means `--no-session`
 * (read_web_page, read_session); the six agent tools persist, so each can be
 * continued by continueId.
 */
export interface SpawnSessionConfig {
	/** created if no session has it yet, reopened otherwise. */
	id: string;
	/**
	 * SUB_AGENT_SESSION_DIR keeps sub-agent sessions OUT of the `/resume`
	 * picker — a handful of delegate calls otherwise buries your real sessions.
	 */
	dir: string;
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
	/** how the process ended when it ended before settling: a signal name or "exit code N". */
	exit?: string;
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
	/** the models a child may run on when none is requested; read from agent-models.json when omitted. */
	agentModels?: AgentModels;
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
	/** piSpawn only: stops the child. */
	signal?: AbortSignal;
	onUpdate?: (result: PiSpawnResult) => void;
	/** the child's `tool_execution_start` / `tool_execution_end` events. */
	onEvent?: (event: any) => void;
	sessionId?: string;
	repo?: string;
	/** conversation persistence / continuation. see SpawnSessionConfig. */
	session?: SpawnSessionConfig;
	/** sent as a second prompt once the task's run settles without an error. */
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

/** `<agent>-<uuid>`: the agent name lets unresumableReason refuse another agent's id. */
export function newSessionId(agent: string): string {
	return `${agent}-${randomUUID()}`;
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
	if (!session) return { args: ["--no-session"] };
	assertSafeSessionId(session.id);
	fs.mkdirSync(session.dir, { recursive: true });
	// --session-dir on every resume too, or pi looks for the id in its default directory
	return { args: ["--session-dir", session.dir, "--session-id", session.id], meta: { continueId: session.id, sessionDir: session.dir } };
}

export interface SessionHeader {
	type: "session";
	id: string;
	timestamp: string;
	cwd: string;
	parentSession?: string;
}

/** A session file's header from its first bytes: the first line, when it is one. */
export function parseSessionHeader(bytes: Buffer): SessionHeader | undefined {
	const end = bytes.indexOf(0x0a);
	try {
		const header = JSON.parse(bytes.subarray(0, end === -1 ? bytes.length : end).toString("utf8"));
		return header?.type === "session" && typeof header.id === "string" ? header : undefined;
	} catch {
		return undefined;
	}
}

function readSessionHeader(file: string): SessionHeader | undefined {
	let fd: number | undefined;
	try {
		fd = fs.openSync(file, "r");
		const buf = Buffer.alloc(4096);
		return parseSessionHeader(buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, 0)));
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

const SESSION_AGENTS: readonly string[] = ["delegate", "chad", "oracle", "finder", "librarian", "code_review"];

/** sessions started before this carry `delegate-` whichever tool made them, so a chad may resume those. */
const AGENT_NAMED_IDS_SINCE = Date.parse("2026-10-21T00:00:00Z");

function idRefusal(id: string, agent: string, started: unknown): string | undefined {
	const owner = SESSION_AGENTS.find((name) => id.startsWith(`${name}-`));
	if (!owner || owner === agent) return undefined;
	const legacy = owner === "delegate" && agent === "chad" && typeof started === "string" && Date.parse(started) < AGENT_NAMED_IDS_SINCE;
	if (legacy) return undefined;
	return (
		`continueId "${id}" belongs to a ${owner}, not a ${agent}. ` +
		`Pass it to ${owner}, or omit continueId to start a new ${agent}.`
	);
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
	const refusal = idRefusal(id, agent, candidates[0]!.timestamp);
	if (refusal) return refusal;
	const real = (dir: string) => {
		try {
			return fs.realpathSync(dir);
		} catch {
			return path.resolve(dir);
		}
	};
	const here = real(cwd);
	if (candidates.some((h) => typeof h!.cwd === "string" && real(h!.cwd) === here)) return undefined;
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
		return content.trim();
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
	path.join(PI_AGENT_DIR, "extensions", "prompt-cache.js"),
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

export interface ChildRun {
	/** updated in place while the child runs. */
	readonly result: PiSpawnResult;
	readonly done: Promise<PiSpawnResult>;
	/** delivers `text` into the running conversation; resolves with why it could not, or undefined once the child took it. */
	steer(text: string): Promise<string | undefined>;
	/** aborts the child's run, then closes it; escalates to signals if it does not settle. false when it was already ending. */
	stop(): boolean;
	kill(): void;
}

const STOP_GRACE_MS = 2_000;
const CLOSE_GRACE_MS = 2_000;
const KILL_GRACE_MS = 5_000;

function stallMessage(persisted: boolean): string {
	const minutes = Math.round(stallSec() / 60);
	return persisted
		? `sub-agent killed: no output for ${minutes}m. Its conversation is saved: continue it by continueId, or launch a fresh one.`
		: `sub-agent killed: no output for ${minutes}m. Launch a fresh one for the remaining work.`;
}

/**
 * starts a child pi in RPC mode: the task goes over stdin, and the child is closed
 * once `agent_settled` says it has no work left (after `followUp`, when given).
 */
export function startChild(config: PiSpawnConfig): ChildRun {
	const routing = resolveSessionArgs(config.session);
	// read before the child starts: once running it may append its own model change
	const savedOn = !config.model && config.session ? savedSessionModel(config.session.dir, config.session.id) : undefined;
	const requestedTools = resolveAliases([...(config.builtinTools ?? []), ...(config.extensionTools ?? [])]);
	const args = ["--mode", "rpc", ...routing.args, ...childExtensionArgs(requestedTools)];
	if (config.model) args.push("--model", config.model);
	// explicit level beats the child's inherited default (pi applies --thinking last)
	if (config.thinkingLevel) args.push("--thinking", config.thinkingLevel);
	// never --no-tools: it empties the registry so nothing can be re-activated
	if (requestedTools.length > 0) args.push("--tools", requestedTools.join(","));

	let tmpPromptDir: string | undefined;
	if (config.systemPromptBody?.trim()) {
		const interpolated = interpolatePromptVars(config.systemPromptBody, config.cwd, { sessionId: config.sessionId, repo: config.repo });
		const tmp = writePromptToTempFile("subagent", interpolated);
		tmpPromptDir = tmp.dir;
		args.push("--append-system-prompt", tmp.filePath);
	}

	const result: PiSpawnResult = {
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: zeroUsage(),
		model: config.model,
		thinkingLevel: config.thinkingLevel,
		...(routing.meta ? { session: routing.meta } : {}),
	};

	const proc = spawn(process.env.PI_BIN || "pi", args, {
		cwd: config.cwd,
		shell: false,
		stdio: ["pipe", "pipe", "pipe"],
		env: {
			...process.env,
			PI_READ_COMPACT: "1",
			...(config.session ? { [HOLDER_ENV]: config.session.id } : {}),
			// the same list as --tools: system-prompt.ts names exactly these to the child
			...(requestedTools.length > 0 ? { [SUB_AGENT_TOOLS_ENV]: requestedTools.join(",") } : {}),
			...(config.readOnlyBash ? { [READ_ONLY_BASH_ENV]: "1" } : {}),
		},
	});
	proc.stdin.on("error", () => {});

	const agentModels = config.agentModels ?? loadAgentModels();
	const prompts = [`Task: ${config.task}`, ...(config.followUp ? [config.followUp] : [])];
	const steers = new Map<string, (error: string | undefined) => void>();
	// a steer sent before the run starts would arrive while pi is not streaming and start a run of its own
	const heldSteers: Array<Record<string, unknown>> = [];
	let started = false;
	const timers = new Set<ReturnType<typeof setTimeout>>();
	let commandCount = 0;
	let active = false;
	let finishing = false;
	let settledCleanly = false;
	let stopRequested = false;
	let stalled = false;
	let wrongModel: string | undefined;
	let exited = false;
	let released = false;
	let releaseScheduled = false;
	let watchdog: ReturnType<typeof setInterval> | undefined;
	let resolveDone!: (code: number) => void;
	const closed = new Promise<number>((resolve) => { resolveDone = resolve; });
	let exit: string | undefined;

	const later = (ms: number, fn: () => void) => {
		const timer = setTimeout(() => {
			timers.delete(timer);
			fn();
		}, ms);
		timers.add(timer);
	};
	const send = (command: Record<string, unknown>) => {
		if (proc.stdin.writable) proc.stdin.write(`${JSON.stringify(command)}\n`);
	};
	const release = (code: number) => {
		if (released) return;
		released = true;
		resolveDone(code);
	};
	// kill is not release: a grandchild can hold stdout open after the child is gone
	const scheduleRelease = () => {
		if (releaseScheduled) return;
		releaseScheduled = true;
		later(forceReleaseMs(), () => release(1));
	};
	const terminate = (signal: NodeJS.Signals) => {
		scheduleRelease();
		if (exited) return;
		proc.kill(signal);
		if (signal === "SIGTERM") later(KILL_GRACE_MS, () => { if (!exited) proc.kill("SIGKILL"); });
	};
	const failed = () => result.stopReason === "error" || result.stopReason === "aborted";
	const finish = () => {
		finishing = true;
		settledCleanly = !stopRequested;
		for (const reply of steers.values()) reply("it had already finished");
		steers.clear();
		proc.stdin.end();
		scheduleRelease();
		later(CLOSE_GRACE_MS, () => terminate("SIGTERM"));
	};
	const advance = () => {
		if (active || finishing || steers.size > 0) return;
		const next = !stopRequested && !failed() ? prompts.shift() : undefined;
		if (next === undefined) return finish();
		active = true;
		send({ type: "prompt", id: `prompt-${++commandCount}`, message: next });
	};

	const processLine = (line: string) => {
		let event: any;
		try { event = JSON.parse(line); } catch { return; }
		switch (event.type) {
			case "response": {
				if (String(event.id).startsWith("prompt-") && !event.success) {
					result.stopReason = "error";
					result.errorMessage = String(event.error ?? "the child refused the task");
					active = false;
					for (const held of heldSteers.splice(0)) {
						steers.get(String(held.id))?.("it refused its task");
						steers.delete(String(held.id));
					}
					return advance();
				}
				const reply = steers.get(event.id);
				if (!reply) return;
				steers.delete(event.id);
				if (event.success && event.data?.disposition === "started") active = true;
				reply(event.success ? undefined : String(event.error ?? "the child refused it"));
				advance();
				return;
			}
			case "extension_ui_request":
				// nobody can answer a dialog inside a sub-agent
				if (["select", "confirm", "input", "editor"].includes(event.method)) send({ type: "extension_ui_response", id: event.id, cancelled: true });
				return;
			case "agent_start":
				active = true;
				started = true;
				for (const command of heldSteers.splice(0)) send(command);
				return;
			case "agent_settled":
				active = false;
				advance();
				return;
			case "tool_execution_start":
			case "tool_execution_end":
				config.onEvent?.(event);
				return;
			case "entry_appended":
				if (event.entry?.type === "custom" && event.entry.customType === CACHE_PING_ENTRY && event.entry.data?.usage) {
					addSpend(result.usage, event.entry.data.usage);
					config.onUpdate?.({ ...result });
				}
				return;
			case "message_start":
			case "message_end":
				break;
			default:
				return;
		}
		const msg = event.message;
		if (msg?.role === "assistant" && !wrongModel && msg.provider && msg.model) {
			const refusal = modelViolation(`${msg.provider}/${msg.model}`, config.model, agentModels, savedOn);
			if (refusal) {
				wrongModel = refusal;
				terminate("SIGKILL");
			}
		}
		if (event.type !== "message_end" || !msg || msg.role === "system") return;
		result.messages.push(msg);
		if (msg.role === "assistant") {
			result.usage.turns++;
			const usage = msg.usage;
			if (usage) {
				addSpend(result.usage, usage);
				result.usage.contextTokens = usage.totalTokens || 0;
			}
			if (msg.model) result.model = msg.provider ? `${msg.provider}/${msg.model}` : msg.model;
			if (msg.thinkingLevel) result.thinkingLevel = msg.thinkingLevel;
			if (msg.stopReason) result.stopReason = msg.stopReason;
			if (msg.errorMessage) result.errorMessage = msg.errorMessage;
		}
		config.onUpdate?.({ ...result });
	};

	const stallMs = stallSec() * 1000;
	let lastActivity = Date.now();
	let lastTickAt = Date.now();
	if (stallMs > 0) {
		watchdog = setInterval(() => {
			const now = Date.now();
			if (releaseScheduled) return;
			const verdict = watchdogVerdict(now, lastTickAt, lastActivity, stallMs, SLEEP_JUMP_MS);
			lastTickAt = now;
			if (verdict === "slept") lastActivity = now;
			if (verdict !== "kill") return;
			stalled = true;
			terminate("SIGTERM");
		}, watchdogTickMs(stallMs, STALL_TICK_MS));
	}

	let buffer = "";
	proc.stdout.on("data", (data: Buffer) => {
		if (released) return;
		buffer += data.toString();
		const lines = buffer.split("\n");
		buffer = lines.pop() || "";
		if (buffer || lines.some((line) => line.trim() && !isKeepAliveLine(line))) lastActivity = Date.now();
		for (const line of lines) if (line.trim()) processLine(line);
	});
	proc.stderr.on("data", (data: Buffer) => {
		if (released) return;
		lastActivity = Date.now();
		result.stderr += data.toString();
	});
	proc.on("exit", (code, signal) => {
		exited = true;
		exit = signal ?? `exit code ${code}`;
	});
	proc.on("close", (code, signal) => {
		if (!released && buffer.trim()) processLine(buffer);
		release(code ?? (signal ? 1 : 0));
	});
	proc.on("error", () => {
		exited = true;
		release(1);
	});

	advance();

	const done = closed.then((code) => {
		if (watchdog) clearInterval(watchdog);
		for (const timer of timers) clearTimeout(timer);
		if (tmpPromptDir) try { fs.rmSync(tmpPromptDir, { recursive: true, force: true }); } catch {}
		for (const reply of steers.values()) reply("it stopped first");
		steers.clear();
		result.exitCode = settledCleanly ? 0 : code;
		if (!settledCleanly) result.exit = exit ?? "killed";
		if (stopRequested) {
			result.exitCode = 1;
			result.stopReason = "aborted";
		}
		if (stalled) {
			result.exitCode = 1;
			result.stopReason = "stalled";
			result.errorMessage = stallMessage(!!routing.meta);
		}
		if (wrongModel) {
			result.exitCode = 1;
			result.stopReason = "error";
			result.errorMessage = wrongModel;
		}
		const meta = routing.meta;
		if (meta && exited && !settledCleanly) {
			try {
				const file = subAgentSessionFile(meta.sessionDir, meta.continueId);
				if (file) repairInterrupted(file);
			} catch {}
		}
		return result;
	});

	return {
		result,
		done,
		steer(text) {
			if (finishing || released) return Promise.resolve("it had already finished");
			const id = `steer-${++commandCount}`;
			return new Promise((resolve) => {
				steers.set(id, resolve);
				const command = { type: "prompt", id, message: text, streamingBehavior: "steer" };
				if (started) send(command);
				else heldSteers.push(command);
			});
		},
		stop() {
			if (stopRequested || finishing || released) return false;
			stopRequested = true;
			send({ type: "abort" });
			later(STOP_GRACE_MS, () => { if (!finishing) terminate("SIGTERM"); });
			return true;
		},
		kill() {
			terminate("SIGKILL");
		},
	};
}

/** a blocking run: `signal` stops the child. */
export async function piSpawn(config: PiSpawnConfig): Promise<PiSpawnResult> {
	const child = startChild(config);
	const onAbort = () => child.stop();
	if (config.signal?.aborted) onAbort();
	else config.signal?.addEventListener("abort", onAbort, { once: true });
	try {
		return await child.done;
	} finally {
		config.signal?.removeEventListener("abort", onAbort);
	}
}
