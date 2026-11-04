/**
 * format_file tool — runs a code formatter on a file.
 *
 * tries prettier, then biome, and captures a before/after diff which is
 * tracked for undo_edit.
 *
 * resolution, first hit wins:
 *   1. `node_modules/.bin` from the file's directory up to its git root,
 *      never at or above $HOME (a home-dir install is nobody's project pin)
 *   2. on PATH (a global install)
 *   3. via `bunx`/`npx` (no install at all, resolves the package on demand)
 *
 * prettier skips files matched by .gitignore/.prettierignore with exit 0, so
 * "unchanged" would read as "already formatted". `--file-info` is asked first.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { saveChange, simpleDiff } from "./lib/file-tracker";
import { withFileLock } from "./lib/mutex";
import { changedSinceSeen, hasSeen, markSeen } from "./lib/seen-files";
import { resolveWithVariants } from "./read";
import { osc8Link, renderBoxedText } from "./lib/box-format";
import { getText } from "./lib/tui";

type Formatter = {
	name: string;
	args: (file: string) => string[];
	/** argv that reports whether the formatter will touch the file. */
	fileInfoArgs?: (file: string) => string[];
};

/** a formatter resolved to something actually runnable. */
type ResolvedFormatter = {
	/** display name, e.g. "prettier (project)" */
	label: string;
	/** executable to spawn */
	command: string;
	/** runner prefix like `--yes prettier` for npx; empty when command is the formatter */
	prefix: string[];
	formatter: Formatter;
};

const FORMATTERS: Formatter[] = [
	{
		name: "prettier",
		args: (file) => ["--write", "--log-level", "silent", file],
		fileInfoArgs: (file) => ["--file-info", file],
	},
	{
		name: "biome",
		args: (file) => ["format", "--write", file],
	},
];

/** `node_modules/.bin/<name>` from startDir up to the git root, stopping below $HOME. */
function findLocalBin(name: string, startDir: string): string | null {
	const home = path.resolve(os.homedir());
	let dir = startDir;
	while (true) {
		if (dir === home || home.startsWith(dir + path.sep) || dir === path.parse(dir).root) return null;
		const candidate = path.join(dir, "node_modules", ".bin", name);
		try {
			fs.accessSync(candidate, fs.constants.X_OK);
			return candidate;
		} catch {
			/* keep walking up */
		}
		if (fs.existsSync(path.join(dir, ".git"))) return null;
		dir = path.dirname(dir);
	}
}

function onPath(name: string): boolean {
	return spawnSync("which", [name], { encoding: "utf-8", timeout: 3000 }).status === 0;
}

/**
 * resolve a runnable formatter for `filePath`, preferring the project's own.
 *
 * `bunx`/`npx` are last: they can hit the network on a cold cache, so they are
 * a convenience fallback rather than the normal path.
 */
function findFormatter(filePath: string): ResolvedFormatter | null {
	const startDir = path.dirname(path.resolve(filePath));

	for (const fmt of FORMATTERS) {
		const local = findLocalBin(fmt.name, startDir);
		if (local) {
			return { label: `${fmt.name} (project)`, command: local, prefix: [], formatter: fmt };
		}
	}
	for (const fmt of FORMATTERS) {
		if (onPath(fmt.name)) {
			return { label: `${fmt.name} (global)`, command: fmt.name, prefix: [], formatter: fmt };
		}
	}
	for (const runner of ["bunx", "npx"]) {
		if (!onPath(runner)) continue;
		const fmt = FORMATTERS[0]; // prettier: the one npx can resolve by bare name
		return {
			label: `${fmt.name} (via ${runner})`,
			command: runner,
			prefix: runner === "npx" ? ["--yes", fmt.name] : [fmt.name],
			formatter: fmt,
		};
	}
	return null;
}

/** why the formatter would leave `file` untouched, or null when it will format it. */
function refusalReason(resolved: ResolvedFormatter, file: string, cwd: string): string | null {
	const { fileInfoArgs } = resolved.formatter;
	if (!fileInfoArgs) return null;
	const run = spawnSync(resolved.command, [...resolved.prefix, ...fileInfoArgs(file)], {
		encoding: "utf-8",
		timeout: 30_000,
		cwd,
	});
	if (run.status !== 0) {
		return `${resolved.label} --file-info failed: ${run.stderr?.trim() || run.stdout?.trim() || `exit code ${run.status}`}`;
	}
	let info: { ignored?: boolean; inferredParser?: string | null };
	try {
		info = JSON.parse(run.stdout);
	} catch {
		return `${resolved.label} --file-info returned unreadable output: ${run.stdout.trim().slice(0, 200)}`;
	}
	const name = path.basename(file);
	if (info.ignored) {
		return `${resolved.label} ignores ${name} (it matches .gitignore or .prettierignore); nothing was formatted.`;
	}
	if (!info.inferredParser) {
		return `${resolved.label} has no parser for ${path.extname(file) || name} files; nothing was formatted.`;
	}
	return null;
}

export function createFormatFileTool(): ToolDefinition {
	return {
		name: "format_file",
		label: "Format File",
		description: "Run a code formatter (prettier or biome) on a file.",

		parameters: Type.Object({
			path: Type.String({
				description: "Path of the file to format, absolute or relative to the working directory.",
			}),
		}),

		renderCall(args: any, theme: any, context: any) {
			const Text = getText();
			const text = context?.lastComponent ?? new Text("", 0, 0);
			const filePath = args.path || "...";
			const home = os.homedir();
			const shortened = filePath.startsWith(home) ? `~${filePath.slice(home.length)}` : filePath;
			const linked = filePath.startsWith("/") ? osc8Link(`file://${filePath}`, shortened) : shortened;
			text.setText(theme.fg("toolTitle", theme.bold("Format ")) + theme.fg("dim", linked));
			return text;
		},

		renderResult: renderBoxedText,

		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			const resolved = resolveWithVariants(params.path, ctx.cwd);

			if (!fs.existsSync(resolved)) {
				return {
					content: [{ type: "text" as const, text: `file not found: ${resolved}` }],
					isError: true,
				} as any;
			}

			const formatter = findFormatter(resolved);
			if (!formatter) {
				return {
					content: [
						{
							type: "text" as const,
							text:
								"no formatter available. checked, in order: node_modules/.bin from this file's " +
								"directory up to its git root (never $HOME or above), then PATH, then bunx/npx.\n\n" +
								"fix with one of:\n" +
								"  npm i -D prettier      (project-local, preferred — pins the version)\n" +
								"  npm i -g prettier      (global, available everywhere)\n" +
								"  npm i -D @biomejs/biome",
						},
					],
					isError: true,
				} as any;
			}

			return withFileLock(resolved, async () => {
				const refusal = refusalReason(formatter, resolved, ctx.cwd);
				if (refusal) {
					return { content: [{ type: "text" as const, text: refusal }], isError: true } as any;
				}

				const before = fs.readFileSync(resolved, "utf-8");
				const sessionId = ctx.sessionManager.getSessionId();
				const seenBefore = hasSeen(sessionId, resolved) && changedSinceSeen(sessionId, resolved) === undefined;

				const result = spawnSync(formatter.command, [...formatter.prefix, ...formatter.formatter.args(resolved)], {
					encoding: "utf-8",
					timeout: 30_000,
					cwd: ctx.cwd,
				});

				if (result.status !== 0) {
					const err = result.stderr?.trim() || result.stdout?.trim() || `exit code ${result.status}`;
					return {
						content: [{ type: "text" as const, text: `${formatter.label} failed: ${err}` }],
						isError: true,
					} as any;
				}

				const after = fs.readFileSync(resolved, "utf-8");

				if (before === after) {
					return {
						content: [
							{
								type: "text" as const,
								text: `${path.basename(resolved)} is already formatted.`,
							},
						],
						details: { header: resolved },
					} as any;
				}

				const diff = simpleDiff(resolved, before, after);
				saveChange(sessionId, toolCallId, {
					uri: `file://${resolved}`,
					before,
					after,
					diff,
					isNewFile: false,
					timestamp: Date.now(),
				});
				if (seenBefore) markSeen(sessionId, resolved);

				return {
					content: [
						{
							type: "text" as const,
							text: `formatted ${path.basename(resolved)} with ${formatter.label}.\n\n${diff}`,
						},
					],
					details: { header: resolved },
				} as any;
			});
		},
	};
}
