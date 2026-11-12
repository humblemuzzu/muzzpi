/**
 * commit — stages exactly the files the agent names and commits only those
 * (`git commit --only`), so another session's staged or unstaged work never
 * rides along. git runs the secret scan itself, as the hook lib/git.ts adds
 * to every git command's environment; this tool passes on what it said.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { renderBoxedText } from "./lib/box-format";
import { withProcessLock } from "./lib/file-lock";
import { gitEnv } from "./lib/git";
import { stringList } from "./lib/params";
import { getText } from "./lib/tui";
import { resolveToAbsolute } from "./read";

const TYPES = ["feat", "fix", "docs", "style", "refactor", "perf", "test", "chore", "build", "ci", "revert"];
const SUBJECT = new RegExp(`^(?:${TYPES.join("|")})(?:\\([^()\\s][^()]*\\))?!?: \\S`);
const EXAMPLE = "fix(auth): refresh the token before it expires";

/** git refuses while another git process holds the index; that wait is seconds at most */
const INDEX_BUSY = /index\.lock': File exists/;
const BUSY_RETRIES = 20;
const BUSY_WAIT_MS = 250;
const LISTED = 8;

interface GitRun {
	code: number;
	stdout: string;
	stderr: string;
}

function runGit(cwd: string, args: string[], input?: string): Promise<GitRun> {
	return new Promise((resolve) => {
		const proc = spawn("git", args, { cwd, env: { ...process.env, ...gitEnv() }, stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		proc.stdout.on("data", (chunk) => (stdout += chunk));
		proc.stderr.on("data", (chunk) => (stderr += chunk));
		proc.stdin.on("error", () => {});
		proc.stdin.end(input ?? "");
		proc.on("error", (error) => resolve({ code: 1, stdout, stderr: error.message }));
		proc.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
	});
}

async function runGitWhenFree(cwd: string, args: string[], input?: string): Promise<GitRun> {
	for (let attempt = 0; ; attempt++) {
		const result = await runGit(cwd, args, input);
		if (result.code === 0 || !INDEX_BUSY.test(result.stderr) || attempt >= BUSY_RETRIES) return result;
		await new Promise((resolve) => setTimeout(resolve, BUSY_WAIT_MS));
	}
}

const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true, details: {} });
const said = (run: GitRun) => `${run.stdout}${run.stderr}`.trim();

function names(list: string[]): string {
	const shown = list.slice(0, LISTED).join(", ");
	return list.length > LISTED ? `${shown}, and ${list.length - LISTED} more` : shown;
}

/** what the checkout still holds after the commit, so a file left out is noticed */
async function leftOver(root: string): Promise<string[]> {
	const status = await runGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
	if (status.code !== 0) return [];
	const staged: string[] = [];
	const changed: string[] = [];
	const untracked: string[] = [];
	const entries = status.stdout.split("\0");
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i]!;
		if (entry.length < 4) continue;
		const [index, tree, file] = [entry[0], entry[1], entry.slice(3)];
		if (index === "R" || index === "C") i++;
		if (index === "?") untracked.push(file);
		else {
			if (index !== " ") staged.push(file);
			if (tree !== " ") changed.push(file);
		}
	}
	const rows: string[] = [];
	if (staged.length > 0) rows.push(`  staged, not committed: ${names(staged)}`);
	if (changed.length > 0) rows.push(`  changed, not staged: ${names(changed)}`);
	if (untracked.length > 0) rows.push(`  untracked: ${names(untracked)}`);
	return rows.length > 0 ? ["", "Not in this commit (another session's work, or yours left out):", ...rows] : [];
}

async function push(root: string): Promise<GitRun & { target: string }> {
	const upstream = await runGit(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
	if (upstream.code === 0) return { ...(await runGitWhenFree(root, ["push"])), target: upstream.stdout.trim() };
	const origin = await runGit(root, ["remote", "get-url", "origin"]);
	if (origin.code !== 0) {
		return { code: 1, stdout: "", stderr: "the branch has no upstream and there is no remote named origin: push with bash, naming the remote", target: "" };
	}
	const branch = (await runGit(root, ["branch", "--show-current"])).stdout.trim();
	return { ...(await runGitWhenFree(root, ["push", "--set-upstream", "origin", "HEAD"])), target: `origin/${branch}` };
}

/** the path with its folders resolved (`/tmp` is `/private/tmp` to git), the file itself left as named: it may be a symlink or deleted */
function resolvedPath(file: string): string {
	const dir = path.dirname(file);
	if (dir === file) return file;
	try {
		return path.join(fs.realpathSync(dir), path.basename(file));
	} catch {
		return path.join(resolvedPath(dir), path.basename(file));
	}
}

/** `files` arrives as a bare string or a JSON-stringified array from some models */
function prepareCommitArguments(args: unknown): unknown {
	if (!args || typeof args !== "object" || !("files" in args)) return args;
	return { ...args, files: stringList((args as { files: unknown }).files) };
}

export function createCommitTool(): ToolDefinition {
	return {
		name: "commit",
		label: "Commit",
		description:
			"Commit to git. It stages exactly the files you name and commits only those, so other sessions' staged or " +
			"unstaged work in the same checkout never ends up in your commit.\n\n" +
			"- Commit only when the user asked you to, or a guidance file says to. Push only when asked: `push: true`.\n" +
			"- `files`: every file this commit holds: new, changed or deleted, and for a rename both paths. Files, not " +
			"folders. Each goes in whole, as it is on disk now.\n" +
			"- Part of a file: stage those hunks first with `git hunks list <path>` in bash (it prints the next command), " +
			"then call commit without `files`: it commits what is staged.\n" +
			`- \`message\`: a \`type(scope): subject\` line, lowercase and imperative, with type one of ${TYPES.join(", ")}. ` +
			"After a blank line, a body for the why when it is not obvious.\n" +
			"- git checks every commit and push for secrets: a value of the user's own secrets or a real API key stops it, " +
			"and the result says how to fix it. Lines that only look like secrets are listed and go through.\n" +
			"- It never force pushes. A push rejected because the remote moved: `git pull --rebase` in bash, then `git push`.\n\n" +
			`Example: commit({ message: "${EXAMPLE}", files: ["src/auth.ts", "src/auth.test.ts"] })`,

		parameters: Type.Object({
			message: Type.String({
				description: "The commit message: a `type(scope): subject` line, then optionally a blank line and a body.",
			}),
			files: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"The files to commit, relative to `cwd` or absolute. Leave it out to commit what is already staged, such as hunks staged with `git hunks add`.",
				}),
			),
			push: Type.Optional(
				Type.Boolean({ description: "Push after committing: to the branch's upstream, or to origin, which then becomes its upstream." }),
			),
			cwd: Type.Optional(
				Type.String({
					description: "A directory inside the repository, absolute or relative to the workspace root. Defaults to the workspace root.",
				}),
			),
		}),

		prepareArguments: prepareCommitArguments as any,

		renderCall(args: any, theme: any, context: any) {
			const Text = getText();
			const text = context?.lastComponent ?? new Text("", 0, 0);
			const subject = typeof args.message === "string" ? args.message.split("\n")[0] : "...";
			const count = stringList(args.files).length;
			const scope = count > 0 ? ` (${count} file${count === 1 ? "" : "s"})` : " (staged)";
			const title = args.push ? "Commit & push " : "Commit ";
			text.setText(theme.fg("toolTitle", theme.bold(title)) + theme.fg("dim", `${subject}${scope}`));
			return text;
		},

		renderResult: renderBoxedText,

		async execute(_toolCallId, params: any, _signal, _onUpdate, ctx) {
			const message = typeof params.message === "string" ? params.message.trim() : "";
			const subject = message.split("\n")[0] ?? "";
			if (!SUBJECT.test(subject)) {
				return fail(
					`The message's first line must be \`type(scope): subject\` with type one of ${TYPES.join(", ")}; ` +
						`got "${subject}". Example: ${EXAMPLE}`,
				);
			}
			const cwd = params.cwd ? resolveToAbsolute(params.cwd, ctx.cwd) : ctx.cwd;
			if (!fs.existsSync(cwd)) return fail(`No such directory: ${cwd}`);
			const top = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
			if (top.code !== 0) return fail(`Not inside a git repository: ${cwd}`);
			const root = top.stdout.trim();
			const realRoot = fs.realpathSync(root);

			const paths: string[] = [];
			/* a file `git mv` or `git rm` already took out of the index: its deletion is staged, so there is nothing to add */
			const stagedDeletions = new Set<string>();
			for (const file of stringList(params.files)) {
				const absolute = resolveToAbsolute(file, cwd);
				const relative = path.relative(realRoot, resolvedPath(absolute));
				if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return fail(`${file} is not a file inside the repository at ${root}.`);
				const stat = fs.lstatSync(absolute, { throwIfNoEntry: false });
				if (stat?.isDirectory()) {
					return fail(`${file} is a folder. Name the files in it that you changed: a whole folder would sweep in other sessions' files.`);
				}
				if (!stat && (await runGit(root, ["--literal-pathspecs", "ls-files", "--error-unmatch", "--", relative])).code !== 0) {
					if ((await runGit(root, ["cat-file", "-e", `HEAD:${relative}`])).code !== 0) {
						return fail(`${file} does not exist, and git does not track it, so there is no deletion to commit either.`);
					}
					stagedDeletions.add(relative);
				}
				paths.push(relative);
			}

			const indexPath = (await runGit(root, ["rev-parse", "--path-format=absolute", "--git-path", "index"])).stdout.trim();
			let committed: ReturnType<typeof fail> | { lines: string[] };
			try {
				committed = await withProcessLock(indexPath || path.join(root, ".git", "index"), async () => {
					const toAdd = paths.filter((relative) => !stagedDeletions.has(relative));
					if (toAdd.length > 0) {
						const add = await runGitWhenFree(root, ["--literal-pathspecs", "add", "--", ...toAdd]);
						if (add.code !== 0) return fail(`git add failed, nothing was committed:\n${said(add)}`);
					} else if (paths.length === 0 && (await runGit(root, ["diff", "--cached", "--quiet"])).code === 0) {
						return fail("Nothing is staged. Name the files to commit in `files`, or stage part of a file with `git hunks add` first.");
					}
					const session = ctx.sessionManager?.getSessionId?.();
					const args = ["--literal-pathspecs", "commit", "--file=-", ...(session ? ["--trailer", `Session-Id: ${session}`] : [])];
					const commit = await runGitWhenFree(root, paths.length > 0 ? [...args, "--only", "--", ...paths] : args, message);
					if (commit.code !== 0) {
						const output = said(commit);
						if (/nothing to commit|no changes added to commit/.test(output)) {
							return fail(`None of these files has a change to commit: ${names(paths)}.`);
						}
						return fail(output || `git commit exited with ${commit.code}`);
					}

					const head = (await runGit(root, ["log", "-1", "--format=%h %s"])).stdout.trim();
					const stat = (await runGit(root, ["show", "--stat=100", "--format=", "HEAD"])).stdout.trimEnd();
					const lines = [`Committed ${head}`, stat, ...(await leftOver(root))];
					if (commit.stderr.trim()) lines.push("", commit.stderr.trim());
					return { lines };
				});
			} catch (error) {
				return fail(`Nothing was committed: ${(error as Error).message}`);
			}
			if (!("lines" in committed)) return committed;
			const { lines } = committed;
			if (!params.push) return { content: [{ type: "text" as const, text: lines.join("\n") }], details: {} };

			const pushed = await push(root);
			lines.push("", pushed.code === 0 ? `Pushed to ${pushed.target}.` : `The commit is made, but the push failed:\n${said(pushed)}`);
			return { content: [{ type: "text" as const, text: lines.join("\n") }], isError: pushed.code !== 0, details: {} };
		},
	};
}
