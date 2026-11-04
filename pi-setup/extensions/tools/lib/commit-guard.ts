/**
 * Blocks a local `git commit` / `git push` whose added lines look like secrets,
 * judged by the same scrubber that hides secrets in tool output (shapes plus
 * the user's vault values). Factory Droid's "Droid Shield" idea; the refusal
 * text is theirs. A git failure lets the command run: git will report it.
 */

import { spawn } from "node:child_process";
import * as path from "node:path";
import { splitRemote } from "./remote-command";

export const SECRET_SCAN_OFF_ENV = "PI_SECRET_SCAN_OFF";

export interface Leak {
	file: string;
	line: number;
}

type Action = "commit" | "push";

const GLOBAL_OPTION = String.raw`(?:-C\s+(?:"[^"]*"|'[^']*'|\S+)|-c\s+\S+|--[a-z][a-z-]*(?:=\S+)?)`;
const GIT_ACTION = new RegExp(String.raw`\bgit((?:\s+${GLOBAL_OPTION})*)\s+(commit|push)\b`);
const DIR_OPTION = /-C\s+(?:"([^"]*)"|'([^']*)'|(\S+))/;

/** a commit or push this machine would run, and the `-C` repo it names; ssh parts run elsewhere and are skipped */
export function gitAction(command: string): { action: Action; dir?: string } | undefined {
	const match = GIT_ACTION.exec(splitRemote(command).local);
	if (!match) return undefined;
	const dir = DIR_OPTION.exec(match[1] ?? "");
	return { action: match[2] as Action, dir: dir ? (dir[1] ?? dir[2] ?? dir[3]) : undefined };
}

const GIT_TIMEOUT_MS = 15_000;
const MAX_DIFF_BYTES = 64 * 1024 * 1024;

/** async, so a large diff never blocks the thread that draws pi */
function git(cwd: string, args: string[]): Promise<string | undefined> {
	return new Promise((resolve) => {
		const proc = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
		const chunks: Buffer[] = [];
		let size = 0;
		const timer = setTimeout(() => proc.kill("SIGKILL"), GIT_TIMEOUT_MS);
		proc.stdout.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_DIFF_BYTES) proc.kill("SIGKILL");
			else chunks.push(chunk);
		});
		proc.on("error", () => {
			clearTimeout(timer);
			resolve(undefined);
		});
		proc.on("close", (code) => {
			clearTimeout(timer);
			resolve(code === 0 ? Buffer.concat(chunks).toString("utf-8") : undefined);
		});
	});
}

/** the unified diff of what the command would add, at zero context */
async function publishedDiff(command: string, action: Action, cwd: string): Promise<string | undefined> {
	const noExt = ["--unified=0", "--no-color", "--no-ext-diff"];
	if (action === "commit") {
		const all = /\s-[a-zA-Z]*a[a-zA-Z]*\b|\s--all\b/.test(command);
		const staged = await git(cwd, ["diff", "--cached", ...noExt]);
		const tracked = all ? await git(cwd, ["diff", ...noExt]) : "";
		return staged === undefined ? undefined : staged + (tracked ?? "");
	}
	const upstream = (await git(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]))?.trim();
	const range = upstream ? [`${upstream}..HEAD`] : ["HEAD", "--not", "--remotes"];
	return git(cwd, ["log", "-p", ...noExt, "--max-count=200", "--format=", ...range]);
}

/** added lines the scrubber would hide, with the file and new-side line number of each */
export function findLeaks(diff: string, scrub: (text: string) => string): Leak[] {
	const leaks: Leak[] = [];
	let file = "";
	let line = 0;
	for (const raw of diff.split("\n")) {
		if (raw.startsWith("+++ ")) {
			file = raw.replace(/^\+\+\+ (?:b\/)?/, "");
			continue;
		}
		const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
		if (hunk) {
			line = Number(hunk[1]);
			continue;
		}
		if (raw.startsWith("+") && file && file !== "/dev/null") {
			const added = raw.slice(1);
			if (!added.includes("[REDACTED") && scrub(added) !== added) leaks.push({ file, line });
			line++;
		}
	}
	const seen = new Set<string>();
	return leaks.filter((l) => !seen.has(`${l.file}:${l.line}`) && seen.add(`${l.file}:${l.line}`));
}

export async function scanCommand(
	command: string,
	cwd: string,
	scrub: (text: string) => string,
): Promise<{ action: Action; leaks: Leak[] } | undefined> {
	if (process.env[SECRET_SCAN_OFF_ENV] === "1") return undefined;
	const target = gitAction(command);
	if (!target) return undefined;
	const repo = target.dir ? path.resolve(cwd, target.dir) : cwd;
	const diff = await publishedDiff(command, target.action, repo);
	if (diff === undefined) return undefined;
	const leaks = findLeaks(diff, scrub);
	return leaks.length > 0 ? { action: target.action, leaks } : undefined;
}

export function leakRefusal(action: Action, leaks: Leak[]): string {
	const shown = leaks.slice(0, 20).map((l) => `  ${l.file}:${l.line}`);
	const more = leaks.length > 20 ? [`  ...and ${leaks.length - 20} more`] : [];
	return [
		`blocked: the secret scan found possible secrets in what this ${action} would publish:`,
		...shown,
		...more,
		"",
		"STOP: Do NOT retry this command against the same changes or attempt to work around this check.",
		"Tell the user that the secret scan detected potential secrets and show them the affected files listed above.",
		"If the user explicitly asks you to fix the flagged files, edit them as instructed (for example, replace test or example secrets with placeholder values), then retry the command so the scan checks the updated changes.",
		"The user can also: 1. Replace secrets with placeholder values themselves (e.g. YOUR_API_KEY_HERE, changeme) 2. Run the commit/push themselves outside the agent if these are false positives 3. Start pi with PI_SECRET_SCAN_OFF=1 (not recommended)",
	].join("\n");
}
