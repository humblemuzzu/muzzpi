/**
 * edit / write — pi's own tools, wrapped.
 *
 * Matching, line endings, BOM handling and the write itself are pi's
 * (createEditToolDefinition / createWriteToolDefinition, injected file
 * operations). This file adds only what pi does not do: undo_edit records,
 * permissions.json, the file lock shared with bash / format_file / undo_edit
 * (and, across processes, with other sub-agents),
 * Claude's field names, and errors that say what to do next.
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { createEditToolDefinition, createWriteToolDefinition, type ToolDefinition } from "@mariozechner/pi-coding-agent";
import { renderChangeCall, renderChangeResult, type FileChangeSummary } from "./lib/change-render";
import { discardChange, saveChange, simpleDiff } from "./lib/file-tracker";
import { withProcessLock } from "./lib/file-lock";
import { resolveToAbsolute } from "./lib/fs";
import { withFileLock } from "./lib/mutex";
import { evaluatePermission, loadPermissions } from "./lib/permissions";
import { makeScrubber } from "./lib/psst";
import { changedSinceSeen, markSeen } from "./lib/seen-files";

interface Edit {
	oldText: string;
	newText: string;
}

interface Ctx {
	cwd: string;
	sessionManager: { getSessionId(): string };
}

/**
 * Not pi's `strict: "prefer"`: Anthropic's strict decoding cannot produce `\u`
 * escapes, so Claude's non-ASCII text arrives as `\b2014`, `\ndash` or a literal
 * `\u2014` (pi #10074). Claude Code sends its Edit tool non-strict too.
 */
const NO_STRICT_SAMPLING = false as const;

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

/** In-process order first, then the lock other pi processes (sub-agents) honour, held for the read-modify-write only. */
function withWriteLock<T>(file: string, signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
	return withFileLock(file, () => withProcessLock(realTarget(file), fn, { signal }));
}

/** Runs on the path pi actually writes, and on where a symlink points. */
function assertAllowed(tool: string, file: string, cwd: string): void {
	const paths = [...new Set([file, realTarget(file)])];
	const verdict = evaluatePermission(tool, { paths, sessionCwd: cwd }, loadPermissions());
	if (verdict.action === "reject") throw new Error(verdict.message ?? `${tool} rejected by permission rules`);
}

/** The marker psst puts where a secret was; the agent sees it in place of the real value. */
const REDACTED = "[REDACTED";
const countRedacted = (text: string) => text.split(REDACTED).length - 1;

/** Records for undo_edit, then writes: a write without a record could never be undone. */
async function writeRecorded(
	file: string,
	content: string,
	before: string | undefined,
	toolCallId: string,
	ctx: Ctx,
): Promise<string> {
	if (before !== undefined && countRedacted(content) > countRedacted(before) && (await makeScrubber())(before) !== before) {
		throw new Error(
			`nothing was written: the new content contains ${REDACTED}], the marker that stands in for a secret in what you are shown. ` +
				`Writing it would replace the real value in ${file} with the marker. Change the file with an edit that leaves the secret's line alone, or ask the user to make that change.`,
		);
	}
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
	markSeen(sessionId, file);
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

const LITERAL_ESCAPE = /\\u[0-9a-fA-F]{4}/;
const decodeEscapes = (text: string) =>
	text.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
const PROSE_EXTENSIONS = new Set([".md", ".mdx", ".markdown", ".txt", ".rst", ".adoc"]);
/** fences, code spans and indented code blocks, where a literal `\u2014` is documentation rather than a mistake. */
const outsideCode = (text: string) => text.replace(/```[\s\S]*?```|`[^`\n]*`|^(?: {4}|\t).*$/gm, "");
const proseEscapes = (text: string) => outsideCode(text).match(/\\u[0-9a-fA-F]{4}/g) ?? [];

/**
 * The escape a change would add to a prose file as visible text, judged on the
 * whole file after the change so its existing code blocks count. undefined when
 * the file is not prose or already uses escapes in its text.
 */
function escapeAsText(file: string, after: string, before: string): string | undefined {
	if (!PROSE_EXTENSIONS.has(path.extname(file).toLowerCase())) return undefined;
	const existing = proseEscapes(before);
	if (existing.length > 0) return undefined;
	return proseEscapes(after)[0];
}

function escapeRefusal(where: string, sample: string, file: string): Error {
	return new Error(
		`nothing was changed: ${where} contains ${sample} as six characters of text, which would show up literally in ` +
			`${path.basename(file)}. Send the character itself (${decodeEscapes(sample)}).`,
	);
}

/**
 * Models sometimes send `\u2014` as six characters instead of the dash. When
 * only the decoded oldText is in the file, the escapes were meant as characters,
 * so both sides are decoded. In a prose file that has no escapes, a newText that
 * adds one is refused rather than written as visible garbage.
 */
function resolveEscapes(edits: Edit[], content: string, file: string): { edits: Edit[]; notes: string[] } {
	const notes: string[] = [];
	const resolved = edits.map((edit, index) => {
		if (typeof edit?.oldText !== "string" || typeof edit?.newText !== "string") return edit;
		const oldText = toLF(edit.oldText);
		if (LITERAL_ESCAPE.test(oldText) && !content.includes(oldText) && content.includes(decodeEscapes(oldText))) {
			notes.push(`edits[${index}] sent \\uXXXX escapes as text; they were read as the characters they stand for.`);
			return { oldText: decodeEscapes(edit.oldText), newText: decodeEscapes(edit.newText) };
		}
		if (!LITERAL_ESCAPE.test(oldText) && content.includes(oldText)) {
			const sample = escapeAsText(file, content.replace(oldText, () => toLF(edit.newText)), content);
			if (sample) throw escapeRefusal(`edits[${index}].newText`, sample, file);
		}
		return edit;
	});
	return { edits: resolved, notes };
}

function assertNoTextEscapes(file: string, content: string, before: string | undefined): void {
	const sample = escapeAsText(file, content, before ?? "");
	if (sample) throw escapeRefusal("content", sample, file);
}

const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const controlsIn = (text: string) => new Set(text.match(CONTROL_CHARS) ?? []);

function newControl(text: string, ...had: string[]): string | undefined {
	const allowed = new Set(had.flatMap((h) => [...controlsIn(h)]));
	return [...controlsIn(text)].find((ch) => !allowed.has(ch));
}

/** Named by code point, never echoed: the garbled text itself is what the model should not copy again. */
function controlRefusal(where: string, ch: string): Error {
	const code = `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;
	return new Error(
		`nothing was changed: ${where} contains ${code}, an invisible control character the file does not have. ` +
			"It is almost always an escape that arrived garbled. Send the character itself, not an escape.",
	);
}

function assertNoNewControls(edits: Edit[], content: string): void {
	edits.forEach((edit, index) => {
		if (typeof edit?.oldText !== "string" || typeof edit?.newText !== "string") return;
		const ch = newControl(edit.newText, edit.oldText, content);
		if (ch) throw controlRefusal(`edits[${index}].newText`, ch);
	});
}

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

/**
 * Share of character pairs two strings have in common (Dice). Unlike a shared
 * prefix and suffix, it stays high when a line has several small differences
 * in the middle, such as a mistyped `…` and `—` on the same line.
 */
function pairSimilarity(a: string, b: string): number {
	if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
	const pairs = new Map<string, number>();
	for (let i = 0; i < a.length - 1; i++) {
		const pair = a.slice(i, i + 2);
		pairs.set(pair, (pairs.get(pair) ?? 0) + 1);
	}
	let shared = 0;
	for (let i = 0; i < b.length - 1; i++) {
		const pair = b.slice(i, i + 2);
		const left = pairs.get(pair) ?? 0;
		if (left > 0) {
			shared++;
			pairs.set(pair, left - 1);
		}
	}
	return (2 * shared) / (a.length + b.length - 2);
}

/** How close a file line is to a line of oldText, which may be a fragment of it. */
function lineScore(wanted: string, line: string): number {
	const at = line.indexOf(wanted.slice(0, Math.min(4, wanted.length)));
	const start = Math.max(0, at);
	return Math.max(
		similarity(wanted, line),
		similarity(wanted, line.slice(0, wanted.length)),
		at > 0 ? similarity(wanted, line.slice(at, at + wanted.length)) : 0,
		pairSimilarity(wanted, line.slice(start, start + wanted.length + 8)),
	);
}

/** `"…" (U+2026)`: a mistyped `…` or `—` looks the same as the real one in plain text, so the code point is shown. */
function describeChar(ch: string | undefined): string {
	if (ch === undefined) return "the end of the line";
	return `${JSON.stringify(ch)} (U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")})`;
}

/** up to 30 characters either side of `at`, so a 700-character line does not flood the error. */
function around(chars: string[], at: number): string {
	const from = Math.max(0, at - 30);
	const to = Math.min(chars.length, at + 30);
	return `${from > 0 ? "\u2026" : ""}${chars.slice(from, to).join("")}${to < chars.length ? "\u2026" : ""}`;
}

/**
 * Lines the whole of oldText up against the file where its first line fits
 * best, and names the first line and character that differ, so the retry needs
 * no re-read and no guessing. The first line may be a fragment of a file line.
 */
function nearestLinesHint(content: string, needle: string): string {
	if (content.length < 4_000_000 && collapseWhitespace(content).includes(collapseWhitespace(needle))) {
		return "\n\nThe text IS in the file, but its whitespace or line breaks differ. Copy it from a fresh read, or match fewer lines.";
	}
	const lines = content.split("\n");
	const wanted = needle.split("\n");
	const firstAt = wanted.findIndex((line) => line.trim().length > 0);
	if (firstAt < 0) return "";
	const first = wanted[firstAt]!.trim();
	const candidates = lines
		.map((line, index) => ({ start: index - firstAt, score: lineScore(first, line.trim()) }))
		.filter((candidate) => candidate.score >= 0.5)
		.sort((a, b) => b.score - a.score)
		.slice(0, 8);
	if (candidates.length === 0) return "";
	const agreeing = (start: number) => wanted.filter((line, k) => (lines[start + k] ?? "").trim() === line.trim()).length;
	const best = candidates
		.map((candidate) => ({ ...candidate, agree: agreeing(candidate.start) }))
		.sort((a, b) => b.agree - a.agree || b.score - a.score)[0]!;
	const k = wanted.findIndex((line, i) => i >= firstAt && (lines[best.start + i] ?? "").trim() !== line.trim());
	if (k < 0) return "";

	const lineIndex = best.start + k;
	const fileLine = lines[lineIndex] ?? "";
	const sentText = wanted[k]!.trimStart();
	const fragmentAt = k === firstAt ? fileLine.indexOf(sentText.slice(0, Math.min(4, sentText.length))) : -1;
	const offset = fragmentAt > 0 ? fragmentAt : fileLine.length - fileLine.trimStart().length;
	const sent = Array.from(sentText);
	const has = Array.from(fileLine.slice(offset));
	let at = 0;
	while (at < sent.length && at < has.length && sent[at] === has[at]) at++;
	const column = offset + has.slice(0, at).join("").length + 1;

	const from = Math.max(0, lineIndex - 2);
	const to = Math.min(lines.length, lineIndex + 3);
	const gutter = String(to).length;
	const window = lines
		.slice(from, to)
		.map((line, i) => {
			const shown = line.length > 160 ? around(Array.from(line), from + i === lineIndex ? column - 1 : 0) : line;
			return `${from + i === lineIndex ? ">" : " "} ${String(from + i + 1).padStart(gutter)} | ${shown}`;
		})
		.join("\n");
	const escape =
		sent[at] === "\\" && sent[at + 1] === "u" ? "\n  That is a \\u escape sent as six characters of text: send the character itself." : "";
	return (
		`\n\nClosest match:\n${window}\n\n` +
		`  first difference: line ${lineIndex + 1}, column ${column}. You sent ${describeChar(sent[at])}, the file has ${describeChar(has[at])}.\n` +
		`  you sent: ${JSON.stringify(around(sent, at))}\n  file has: ${JSON.stringify(around(has, at))}${escape}`
	);
}

function matchLines(content: string, needle: string): string {
	const shown: string[] = [];
	for (let at = content.indexOf(needle); at >= 0 && shown.length < 5; at = content.indexOf(needle, at + needle.length)) {
		const line = content.slice(0, at).split("\n").length;
		shown.push(`  line ${line}: ${content.split("\n")[line - 1]!.trim()}`);
	}
	return shown.length > 0 ? `\n${shown.join("\n")}` : "";
}

const clock = (ms: number) => new Date(ms).toLocaleTimeString("en-US", { hour12: false });

function explain(error: unknown, edits: Edit[], before: string | undefined, file: string, session: string): Error {
	const original = error instanceof Error ? error : new Error(String(error));
	if (before === undefined) return original;
	const content = toLF(before);
	const notFound = /^Could not find (?:the exact text|edits\[(\d+)\])/.exec(original.message);
	if (notFound) {
		const edit = edits[Number(notFound[1] ?? 0)];
		const hidden = typeof edit?.oldText === "string" && edit.oldText.includes(REDACTED) && !content.includes(REDACTED);
		const hint = !edit
			? ""
			: hidden
				? `\n\noldText contains ${REDACTED}]: that part of the file was hidden from you because it looks like a secret, so it can never match. Edit lines next to it instead, or ask the user to change it.`
				: nearestLinesHint(content, toLF(edit.oldText));
		const changed = changedSinceSeen(session, file);
		const stale = changed
			? `\n\nThe file changed after you last read it (read at ${clock(changed.seenAt)}, changed at ${clock(changed.modifiedAt)}). Read it again before retrying.`
			: "";
		return new Error(original.message + hint + stale);
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
		constrainedSampling: NO_STRICT_SAMPLING,
		prepareArguments: (args: unknown) => base.prepareArguments(withClaudeNames(args)),
		renderCall: renderChangeCall("Edit"),
		renderResult: renderChangeResult,

		async execute(toolCallId: string, input: any, signal: AbortSignal | undefined, onUpdate: any, ctx: Ctx) {
			rejectIdentical(input.edits, input.path);
			const cwd = ctx.cwd || process.cwd();
			const target = resolveToAbsolute(input.path, cwd);

			return withWriteLock(target, signal, async () => {
				const current = await readIfExists(target).catch(() => undefined);
				const requested: Edit[] = Array.isArray(input.edits) ? input.edits : [];
				const escapes = current === undefined ? { edits: requested, notes: [] } : resolveEscapes(requested, toLF(current), target);
				const edits = escapes.edits;
				if (current !== undefined) assertNoNewControls(edits, toLF(current));
				if (escapes.notes.length > 0) input = { ...input, edits };
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
					const content = escapes.notes.length > 0
						? [...result.content, { type: "text" as const, text: escapes.notes.join("\n") }]
						: result.content;
					return { content, details: { changes: change ? [change] : [] } };
				} catch (error) {
					throw explain(error, edits, before, target, ctx.sessionManager.getSessionId());
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
		constrainedSampling: NO_STRICT_SAMPLING,
		prepareArguments: renameKeys,
		renderCall: renderChangeCall("Write", "content"),
		renderResult: renderChangeResult,

		async execute(toolCallId: string, input: any, signal: AbortSignal | undefined, onUpdate: any, ctx: Ctx) {
			const cwd = ctx.cwd || process.cwd();

			return withWriteLock(resolveToAbsolute(input.path, cwd), signal, async () => {
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
							markSeen(ctx.sessionManager.getSessionId(), p);
							return;
						}
						assertNoTextEscapes(p, content, before);
						const control = newControl(content, before ?? "");
						if (control) throw controlRefusal("content", control);
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
