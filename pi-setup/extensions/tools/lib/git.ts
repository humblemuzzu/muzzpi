/**
 * Git as pi runs it, from bash and from the commit tool: the commands refused
 * before they run, and the environment every command gets. That environment
 * registers the secret scan (git-hook.ts) as a config hook, so it runs inside
 * git on exactly what is committed or pushed, and takes away the editor and
 * password prompts an agent can never answer.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { simpleCommands } from "./command-shape";
import { withoutDataHeredocs } from "./permissions";
import { splitRemote } from "./remote-command";
import { blockMessage, scanStaged, scanUnpushed, SECRET_SCAN_OFF_ENV, git } from "./secret-scan";
import { SUB_AGENT_TOOLS_ENV } from "./sub-agent-prompt";

interface GitCall {
	binary: string;
	/** the repository `-C` points at */
	dir?: string;
	sub: string;
	args: string[];
}

const GLOBAL_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--super-prefix"]);

function gitCalls(cmd: string): GitCall[] {
	const calls: GitCall[] = [];
	for (const words of simpleCommands(cmd)) {
		if (path.basename(words[0] ?? "") !== "git") continue;
		let dir: string | undefined;
		let i = 1;
		while (i < words.length && words[i]!.startsWith("-")) {
			if (words[i] === "-C") dir = words[i + 1];
			i += GLOBAL_WITH_VALUE.has(words[i]!) ? 2 : 1;
		}
		if (words[i]) calls.push({ binary: words[0]!, dir, sub: words[i]!, args: words.slice(i + 1) });
	}
	return calls;
}

/** whether the agent in this process has the commit tool: the main session always does */
export function hasCommitTool(): boolean {
	const tools = process.env[SUB_AGENT_TOOLS_ENV]?.trim();
	return !tools || tools.split(",").map((tool) => tool.trim()).includes("commit");
}

// --- refused before running ---

/** `.`, `..`, `*`, `:/`: a pathspec that covers the whole folder or more */
function coversEverything(spec: string): boolean {
	const bare = spec.replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
	return ["", ".", "*", "**", "**/*", ":", ":/", ":/*", ":(top)", ":(top)*"].includes(bare) || /^\.\.(?:\/\.\.)*$/.test(bare);
}

function stageByName(): string {
	return (
		"Name the files you changed: `git add -- src/a.ts src/b.ts`" +
		(hasCommitTool() ? ", or let the `commit` tool stage them with `files`" : "") +
		". To stage only part of a file: `git hunks list <path>`, which prints the next command."
	);
}

function addRefusal(args: string[]): string | undefined {
	let everything = false;
	let dryRun = false;
	let fromFile = false;
	let afterDashes = false;
	const specs: string[] = [];
	for (const arg of args) {
		if (arg === "") continue;
		if (afterDashes || !arg.startsWith("-") || arg === "-") specs.push(arg);
		else if (arg === "--") afterDashes = true;
		else if (arg === "--all" || arg === "--update" || arg === "--no-ignore-removal") everything = true;
		else if (arg === "--dry-run") dryRun = true;
		else if (arg.startsWith("--pathspec-from-file")) fromFile = true;
		else if (/^-[a-zA-Z]+$/.test(arg)) {
			if (/[Au]/.test(arg)) everything = true;
			if (arg.includes("n")) dryRun = true;
		}
	}
	if (dryRun) return undefined;
	const whole = specs.find(coversEverything);
	if (whole !== undefined) {
		return `Refused before running: \`git add ${whole}\` stages every change below this folder, other sessions' unfinished work included. ${stageByName()}`;
	}
	if (everything && specs.length === 0 && !fromFile) {
		return `Refused before running: \`git add ${args.join(" ")}\` with no paths stages every change in the repository, other sessions' unfinished work included. ${stageByName()}`;
	}
	return undefined;
}

const COMMIT_SHORT_VALUES = "mFcCt";
const COMMIT_LONG_VALUES = new Set([
	"--message", "--file", "--template", "--author", "--date", "--trailer", "--fixup", "--squash",
	"--reuse-message", "--reedit-message", "--cleanup", "--pathspec-from-file",
]);

function commitsEverything(args: string[]): boolean {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === "--") return false;
		if (arg === "--all") return true;
		if (arg.startsWith("--")) {
			if (COMMIT_LONG_VALUES.has(arg)) i++;
			continue;
		}
		if (!/^-[a-zA-Z]/.test(arg)) continue;
		for (let j = 1; j < arg.length; j++) {
			const flag = arg[j]!;
			if (flag === "a") return true;
			if (COMMIT_SHORT_VALUES.includes(flag)) {
				if (j === arg.length - 1) i++;
				break;
			}
			if (flag === "S" || flag === "u") break;
		}
	}
	return false;
}

function commitRefusal(args: string[]): string | undefined {
	if (!commitsEverything(args)) return undefined;
	return (
		"Refused before running: `git commit -a` commits every changed file, other sessions' unfinished work included. " +
		(hasCommitTool() ? "Use the `commit` tool with `files`, or " : "Use ") +
		"`git commit -m \"...\" -- <your files>` to commit only yours."
	);
}

const PUSH_LONG_VALUES = new Set(["--repo", "--receive-pack", "--exec", "--push-option"]);

function pushRefusal(args: string[]): string | undefined {
	let force = false;
	let deletes = false;
	let positional = 0;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (/^--force(?:-with-lease(?:=.*)?|-if-includes)?$/.test(arg) || arg === "--mirror") force = true;
		else if (arg === "--delete" || arg === "--prune") deletes = true;
		else if (arg.startsWith("--")) {
			if (PUSH_LONG_VALUES.has(arg)) i++;
		} else if (/^-[a-zA-Z]+$/.test(arg)) {
			if (arg.includes("f")) force = true;
			if (arg.includes("d")) deletes = true;
			if (arg.endsWith("o")) i++;
		} else if (positional++ > 0) {
			if (arg.startsWith("+")) force = true;
			if (/^:./.test(arg)) deletes = true;
		}
	}
	if (force) {
		return (
			"Refused before running: a force push overwrites history on the remote. Never force push. If the push was " +
			"rejected because the remote moved: `git pull --rebase`, then push again."
		);
	}
	if (deletes) return "Refused before running: this push deletes a branch on the remote. That is the user's call: ask them first.";
	return undefined;
}

/**
 * Why a command must not run: it stages or commits every change in the
 * checkout, sweeping in other sessions' work, or it rewrites or deletes
 * on a remote. Pushes are checked on servers over ssh too. A repository the
 * same command creates with `git init` holds no one else's work.
 */
export function gitRefusal(cmd: string): string | undefined {
	const split = splitRemote(withoutDataHeredocs(cmd));
	let created = false;
	for (const call of gitCalls(split.local)) {
		if (call.sub === "init") created = true;
		const refused =
			call.sub === "add" && !created ? addRefusal(call.args)
			: call.sub === "commit" && !created ? commitRefusal(call.args)
			: call.sub === "push" ? pushRefusal(call.args)
			: undefined;
		if (refused) return refused;
	}
	for (const part of split.remote) {
		for (const call of gitCalls(withoutDataHeredocs(part.command))) {
			const refused = call.sub === "push" ? pushRefusal(call.args) : undefined;
			if (refused) return refused;
		}
	}
	return undefined;
}

/** a message from the command line or a file; without one git opens the editor, which pi sets to `true` */
const hasMessage = (args: string[]) =>
	args.some((arg) => arg === "--no-edit" || /^--(?:message|file|reuse-message|fixup)(?:=|$)/.test(arg) || /^-[a-zA-Z]*[mFC]/.test(arg));

/**
 * Adds a `Session-Id` trailer to a commit, so it can be traced to the pi
 * session that made it. Only to a commit with a message of its own: on one
 * without, the trailer would be the whole message.
 */
export function withSessionTrailer(cmd: string, sessionId: string): string {
	const commits = gitCalls(splitRemote(withoutDataHeredocs(cmd)).local).filter((call) => call.sub === "commit");
	if (commits.length === 0 || /--trailer/.test(cmd) || !commits.every((call) => hasMessage(call.args))) return cmd;
	return cmd.replace(/\bgit\s+commit\b/, `git commit --trailer "Session-Id: ${sessionId}"`);
}

// --- the environment ---

const quote = (word: string) => `'${word.replace(/'/g, `'\\''`)}'`;

let hookFile: string | null | undefined;

/** the secret-scan hook git runs: the bundled .mjs beside the tools, or the source under bun */
function hookCommand(): string | undefined {
	if (hookFile === undefined) {
		const here = path.dirname(fileURLToPath(import.meta.url));
		const candidates = [
			...(process.versions.bun ? [path.join(here, "..", "git-hook.ts"), path.join(here, "git-hook.ts")] : []),
			path.join(here, "git-hook.mjs"),
			path.join(getAgentDir(), "extensions", "tools", "git-hook.mjs"),
		];
		hookFile = candidates.find((file) => existsSync(file)) ?? null;
	}
	return hookFile ? `${quote(process.execPath)} ${quote(hookFile)}` : undefined;
}

let toolsDir: string | null | undefined;

/** the folder holding `git-hunks`, which makes `git hunks` a git command */
function gitToolsDir(): string | undefined {
	if (toolsDir === undefined) {
		const here = path.dirname(fileURLToPath(import.meta.url));
		const candidates = [path.join(getAgentDir(), "git"), path.join(here, "..", "..", "..", "git")];
		toolsDir = candidates.find((dir) => existsSync(path.join(dir, "git-hunks"))) ?? null;
	}
	return toolsDir ?? undefined;
}

/** [config name, git event, the argument git-hook.ts reads] */
const HOOKS: [string, string, string][] = [
	["pi-secret-scan", "prepare-commit-msg", "commit"],
	["pi-secret-scan-push", "pre-push", "push"],
];

/**
 * Added to the environment of everything bash and the commit tool run. The
 * hooks go in as command-scope config (`GIT_CONFIG_COUNT`), after any the user
 * set; git 2.54+ runs them beside the repository's own hooks.
 * `prepare-commit-msg` is the one commit hook `--no-verify` does not skip.
 */
export function gitEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
	const env: Record<string, string> = { GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true", GIT_TERMINAL_PROMPT: "0" };
	const tools = gitToolsDir();
	if (tools) env.PATH = base.PATH ? `${tools}${path.delimiter}${base.PATH}` : tools;
	const hook = hookCommand();
	const first = Number(base.GIT_CONFIG_COUNT) || 0;
	/* a pi started from bash inherits the hooks; adding them again would run the scan twice */
	const inherited = Array.from({ length: first }, (_, i) => base[`GIT_CONFIG_KEY_${i}`]).includes(`hook.${HOOKS[0]![0]}.command`);
	if (hook && !inherited && base[SECRET_SCAN_OFF_ENV] !== "1") {
		HOOKS.forEach(([name, event, mode], i) => {
			const at = first + i * 2;
			env[`GIT_CONFIG_KEY_${at}`] = `hook.${name}.event`;
			env[`GIT_CONFIG_VALUE_${at}`] = event;
			env[`GIT_CONFIG_KEY_${at + 1}`] = `hook.${name}.command`;
			env[`GIT_CONFIG_VALUE_${at + 1}`] = `${hook} ${mode}`;
		});
		env.GIT_CONFIG_COUNT = String(first + HOOKS.length * 2);
	}
	return env;
}

const configHooks = new Map<string, Promise<boolean>>();

/** git runs `hook.<name>.command` config from 2.54 on */
function runsConfigHooks(binary: string): Promise<boolean> {
	let known = configHooks.get(binary);
	if (!known) {
		known = new Promise((resolve) => {
			execFile(binary, ["--version"], { timeout: 5_000 }, (error, stdout) => {
				const version = /(\d+)\.(\d+)/.exec(stdout ?? "");
				resolve(!error && !!version && (Number(version[1]) > 2 || (Number(version[1]) === 2 && Number(version[2]) >= 54)));
			});
		});
		configHooks.set(binary, known);
	}
	return known;
}

async function unpushed(repo: string) {
	const upstream = await git(repo, ["rev-parse", "--verify", "--quiet", "@{upstream}"]);
	return scanUnpushed(repo, "HEAD", upstream ? "@{upstream}" : undefined);
}

/**
 * The secret scan for the commits and pushes the hook cannot see: under a git
 * older than 2.54, and a `push --no-verify`, which skips `pre-push`. It reads
 * the repository before the command runs, so a `git add` earlier in the same
 * command is not seen yet. Any failure of its own lets the command run.
 */
export async function secretCheckBeforeRun(cmd: string, cwd: string): Promise<string | undefined> {
	if (process.env[SECRET_SCAN_OFF_ENV] === "1") return undefined;
	for (const call of gitCalls(splitRemote(withoutDataHeredocs(cmd)).local)) {
		if (call.sub !== "commit" && call.sub !== "push") continue;
		const hooked = hookCommand() !== undefined && (await runsConfigHooks(call.binary));
		if (hooked && !(call.sub === "push" && call.args.includes("--no-verify"))) continue;
		const repo = call.dir ? path.resolve(cwd, call.dir) : cwd;
		try {
			const result = call.sub === "commit" ? await scanStaged(repo) : await unpushed(repo);
			if (result.blocked.length > 0) return blockMessage(result.blocked, "command");
		} catch {}
	}
	return undefined;
}
