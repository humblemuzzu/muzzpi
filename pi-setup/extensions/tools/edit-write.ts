/**
 * edit / write — pi's own tools, wrapped.
 *
 * Matching, line endings, BOM handling and the write itself are pi's
 * (createEditToolDefinition / createWriteToolDefinition, injected file
 * operations). This file adds only what pi does not do: undo_edit records,
 * permissions.json, the file lock shared with bash / format_file / undo_edit,
 * Claude's field names, and errors that say what to do next.
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { createEditToolDefinition, createWriteToolDefinition, type ToolDefinition } from "@mariozechner/pi-coding-agent";
import { renderChangeCall, renderChangeResult, type FileChangeSummary } from "./lib/change-render";
import { discardChange, saveChange, simpleDiff } from "./lib/file-tracker";
import { resolveToAbsolute } from "./lib/fs";
import { withFileLock } from "./lib/mutex";
import { evaluatePermission, loadPermissions } from "./lib/permissions";

interface Edit {
	oldText: string;
	newText: string;
}

interface Ctx {
	cwd: string;
	sessionManager: { getSessionId(): string };
}

/** Claude Code's spellings, which Claude reaches for first. */
const CLAUDE_NAMES: Record<string, string> = {
	file_path: "path",
	filePath: "path",
	old_string: "oldText",
	old_str: "oldText",
	new_string: "newText",
	new_str: "newText",
};

function renameKeys(value: unknown): unknown {
	if (!value || typeof value !== "object" || Array.isArray(value)) return value;
	const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
	for (const [alias, name] of Object.entries(CLAUDE_NAMES)) {
		if (!(alias in out)) continue;
		if (!(name in out)) out[name] = out[alias];
		delete out[alias];
	}
	return out;
}

function withClaudeNames(args: unknown): unknown {
	const out = renameKeys(args);
	if (!out || typeof out !== "object" || Array.isArray(out)) return out;
	const record = out as Record<string, unknown>;
	let edits = record.edits;
	if (typeof edits === "string") {
		try {
			edits = JSON.parse(edits);
		} catch {
			return record;
		}
	}
	if (Array.isArray(edits)) record.edits = edits.map(renameKeys);
	else if (edits && typeof edits === "object") record.edits = renameKeys(edits);
	return record;
}

function realTarget(file: string): string {
	try {
		return fs.realpathSync(file);
	} catch {
		try {
			return path.join(fs.realpathSync(path.dirname(file)), path.basename(file));
		} catch {
			return file;
		}
	}
}

/** Runs on the path pi actually writes, and on where a symlink points. */
function assertAllowed(tool: string, file: string, cwd: string): void {
	const paths = [...new Set([file, realTarget(file)])];
	const verdict = evaluatePermission(tool, { paths, sessionCwd: cwd }, loadPermissions());
	if (verdict.action === "reject") throw new Error(verdict.message ?? `${tool} rejected by permission rules`);
}

/** Records for undo_edit, then writes: a write without a record could never be undone. */
async function writeRecorded(
	file: string,
	content: string,
	before: string | undefined,
	toolCallId: string,
	ctx: Ctx,
): Promise<string> {
	const sessionId = ctx.sessionManager.getSessionId();
	const diff = simpleDiff(file, before ?? "", content);
	let changeId: string;
	try {
		changeId = saveChange(sessionId, toolCallId, {
			uri: `file://${file}`,
			before: before ?? "",
			after: content,
			diff,
			isNewFile: before === undefined,
			beforeExists: before !== undefined,
			afterExists: true,
			timestamp: Date.now(),
		});
	} catch (error) {
		throw new Error(`nothing was written: the change could not be recorded for undo_edit (${(error as Error).message})`);
	}
	try {
		await fsp.writeFile(file, content, "utf-8");
	} catch (error) {
		discardChange(sessionId, toolCallId, changeId);
		throw error;
	}
	return diff;
}

/** Undo stores text, so a file that does not survive a UTF-8 round trip is refused rather than mangled. */
function decodeText(buffer: Buffer, file: string): string {
	const text = buffer.toString("utf-8");
	if (!Buffer.from(text, "utf-8").equals(buffer)) {
		throw new Error(`${file} is not a UTF-8 text file; edit and write only change text files.`);
	}
	return text;
}

async function readIfExists(file: string): Promise<string | undefined> {
	try {
		return decodeText(await fsp.readFile(file), file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

const toLF = (text: string) => text.replace(/\r\n?/g, "\n");

/** Only when every entry is a no-op: pi applies the rest of a call around one identical entry. */
function rejectIdentical(edits: unknown, file: string): void {
	if (!Array.isArray(edits) || edits.length === 0) return;
	const identical = (edit: Edit) =>
		typeof edit?.oldText === "string" && typeof edit?.newText === "string" && toLF(edit.oldText) === toLF(edit.newText);
	if (!edits.every(identical)) return;
	const which = edits.length === 1 ? "oldText and newText are" : "every edits[] entry has oldText and newText";
	throw new Error(
		`${which} identical, so there is nothing to change. If ${file} already contains what you want, the edit is done.`,
	);
}

/** Prefix + suffix overlap. Cheap enough to run over every line of a file. */
function similarity(a: string, b: string): number {
	if (a === b) return 1;
	const longest = Math.max(a.length, b.length);
	if (longest === 0) return 1;
	let prefix = 0;
	while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
	let suffix = 0;
	while (
		suffix < a.length - prefix &&
		suffix < b.length - prefix &&
		a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
	) {
		suffix++;
	}
	return (prefix + suffix) / longest;
}

const collapseWhitespace = (text: string) => text.replace(/\s+/g, " ").trim();

/** The file's closest line to the first line of oldText, so the retry needs no re-read. */
function nearestLinesHint(content: string, needle: string): string {
	if (content.length < 4_000_000 && collapseWhitespace(content).includes(collapseWhitespace(needle))) {
		return "\n\nThe text IS in the file, but its whitespace or line breaks differ. Copy it from a fresh read, or match fewer lines.";
	}
	const wanted = needle.split("\n").find((line) => line.trim().length > 0)?.trim();
	if (!wanted) return "";
	const lines = content.split("\n");
	const head = wanted.slice(0, Math.min(4, wanted.length));
	let best = -1;
	let bestScore = 0;
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]!.trim();
		const at = line.indexOf(head);
		const score = Math.max(
			similarity(wanted, line),
			similarity(wanted, line.slice(0, wanted.length)),
			at > 0 ? similarity(wanted, line.slice(at, at + wanted.length)) : 0,
		);
		if (score > bestScore) {
			bestScore = score;
			best = index;
		}
	}
	if (best < 0 || bestScore < 0.5) return "";
	const from = Math.max(0, best - 2);
	const to = Math.min(lines.length, best + 3);
	const gutter = String(to).length;
	const window = lines
		.slice(from, to)
		.map((line, offset) => `  ${String(from + offset + 1).padStart(gutter)} | ${line}`)
		.join("\n");
	return `\n\nClosest match:\n${window}\n\n  you sent: ${JSON.stringify(wanted)}\n  file has: ${JSON.stringify(lines[best]!.trim())}`;
}

function matchLines(content: string, needle: string): string {
	const shown: string[] = [];
	for (let at = content.indexOf(needle); at >= 0 && shown.length < 5; at = content.indexOf(needle, at + needle.length)) {
		const line = content.slice(0, at).split("\n").length;
		shown.push(`  line ${line}: ${content.split("\n")[line - 1]!.trim()}`);
	}
	return shown.length > 0 ? `\n${shown.join("\n")}` : "";
}

function explain(error: unknown, edits: Edit[], before: string | undefined): Error {
	const original = error instanceof Error ? error : new Error(String(error));
	if (before === undefined) return original;
	const content = toLF(before);
	const notFound = /^Could not find (?:the exact text|edits\[(\d+)\])/.exec(original.message);
	if (notFound) {
		const edit = edits[Number(notFound[1] ?? 0)];
		return new Error(original.message + (edit ? nearestLinesHint(content, toLF(edit.oldText)) : ""));
	}
	const duplicate = /^Found \d+ occurrences of (?:the text|edits\[(\d+)\])/.exec(original.message);
	if (duplicate) {
		const edit = edits[Number(duplicate[1] ?? 0)];
		return new Error(
			original.message +
				(edit ? matchLines(content, toLF(edit.oldText)) : "") +
				"\nThere is no replace_all: to change every occurrence, give each one its own edits[] entry with enough context to be unique.",
		);
	}
	return original;
}

export function createEditTool(): ToolDefinition {
	const base = createEditToolDefinition(process.cwd()) as any;
	return {
		name: "edit",
		label: "Edit",
		description: base.description,
		promptSnippet: base.promptSnippet,
		promptGuidelines: base.promptGuidelines,
		parameters: base.parameters,
		constrainedSampling: base.constrainedSampling,
		prepareArguments: (args: unknown) => base.prepareArguments(withClaudeNames(args)),
		renderCall: renderChangeCall("Edit"),
		renderResult: renderChangeResult,

		async execute(toolCallId: string, input: any, signal: AbortSignal | undefined, onUpdate: any, ctx: Ctx) {
			rejectIdentical(input.edits, input.path);
			const edits: Edit[] = Array.isArray(input.edits) ? input.edits : [];
			const cwd = ctx.cwd || process.cwd();

			return withFileLock(resolveToAbsolute(input.path, cwd), async () => {
				let before: string | undefined;
				let change: FileChangeSummary | undefined;
				const operations = {
					access: (p: string) => {
						assertAllowed("edit", p, cwd);
						return fsp.access(p, fs.constants.R_OK | fs.constants.W_OK);
					},
					readFile: async (p: string) => {
						const buffer = await fsp.readFile(p);
						before = decodeText(buffer, p);
						return buffer;
					},
					writeFile: async (p: string, content: string) => {
						change = { path: p, kind: "modified", diff: await writeRecorded(p, content, before, toolCallId, ctx) };
					},
				};
				try {
					const result = await createEditToolDefinition(cwd, { operations }).execute(
						toolCallId,
						input,
						signal,
						onUpdate,
						ctx as any,
					);
					return { content: result.content, details: { changes: change ? [change] : [] } };
				} catch (error) {
					throw explain(error, edits, before);
				}
			});
		},
	} as any;
}

export function createWriteTool(): ToolDefinition {
	const base = createWriteToolDefinition(process.cwd()) as any;
	return {
		name: "write",
		label: "Write",
		description: base.description,
		promptSnippet: base.promptSnippet,
		promptGuidelines: base.promptGuidelines,
		parameters: base.parameters,
		constrainedSampling: base.constrainedSampling,
		prepareArguments: renameKeys,
		renderCall: renderChangeCall("Write", "content"),
		renderResult: renderChangeResult,

		async execute(toolCallId: string, input: any, signal: AbortSignal | undefined, onUpdate: any, ctx: Ctx) {
			const cwd = ctx.cwd || process.cwd();

			return withFileLock(resolveToAbsolute(input.path, cwd), async () => {
				let change: FileChangeSummary | undefined;
				let unchanged = false;
				const operations = {
					// directories are created in writeFile, after the permission check on the real path.
					mkdir: async () => undefined,
					writeFile: async (p: string, content: string) => {
						assertAllowed("write", p, cwd);
						const before = await readIfExists(p);
						if (before === content) {
							unchanged = true;
							return;
						}
						await fsp.mkdir(path.dirname(p), { recursive: true });
						const diff = await writeRecorded(p, content, before, toolCallId, ctx);
						change = { path: p, kind: before === undefined ? "added" : "modified", diff };
					},
				};
				const result = await createWriteToolDefinition(cwd, { operations }).execute(
					toolCallId,
					input,
					signal,
					onUpdate,
					ctx as any,
				);
				if (unchanged) {
					return {
						content: [{ type: "text" as const, text: `${input.path} already has exactly this content; nothing was written.` }],
						details: { changes: [] },
					};
				}
				return { content: result.content, details: { changes: change ? [change] : [] } };
			});
		},
	} as any;
}
