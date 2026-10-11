/**
 * file change tracker — persists before/after content to disk for undo_edit.
 *
 * each edit writes a JSON file to
 * ~/.pi/file-changes/{sessionId}/{toolCallId}.json containing
 * the full before/after content and a unified diff.
 *
 * branch awareness comes from the conversation tree, not from
 * this module. tool call IDs live in assistant messages — when
 * the user navigates branches, only tool calls on the active
 * branch are visible. the undo_edit tool filters by active
 * tool call IDs before consulting the disk.
 */

import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { moveToTrash } from "./trash";

const FILE_CHANGES_DIR = path.join(os.homedir(), ".pi", "file-changes");

export interface FileChange {
	/** unique id for this change record */
	id: string;
	/** file:// URI of the changed file */
	uri: string;
	/** full content before the edit */
	before: string;
	/** full content after the edit */
	after: string;
	/** unified diff */
	diff: string;
	/** true if this was a newly created file */
	isNewFile: boolean;
	/** true if undo_edit has reverted this change */
	reverted: boolean;
	/** epoch ms when the edit occurred */
	timestamp: number;

	/*
	 * existence/mode tracking. OPTIONAL: older records do not have them, and
	 * revertChange falls back to `isNewFile` when they are absent.
	 *
	 * without beforeExists, reverting a file CREATION wrote an empty file
	 * instead of removing it, and reverting a MOVE would leave the
	 * destination orphaned.
	 */
	/** did the file exist before the change? */
	beforeExists?: boolean;
	/** did the file exist after the change? (false = the change deleted it) */
	afterExists?: boolean;
	/** file mode before the change, restored on revert */
	beforeMode?: number;
	/** file mode after the change */
	afterMode?: number;

	/**
	 * the OTHER path of a move, when this record is one half of one.
	 *
	 * a move is one logical operation stored as TWO records — a deletion at the
	 * source and a creation at the destination — so undoing one alone is
	 * destructive either way (the file vanishes from both places, or exists in
	 * two). The writer knows they belong together; recording it here means the
	 * reader never has to GUESS from matching bytes, which is unanswerable when
	 * a batch moves one file and deletes another with identical content.
	 *
	 * Optional for backward compatibility, exactly like `beforeExists`: records
	 * written before this field existed fall back to the byte heuristic.
	 */
	movePartnerUri?: string;

	/** write order within one tool call; breaks timestamp ties between a script's edits */
	seq?: number;
}

function sessionDir(sessionId: string): string {
	return path.join(FILE_CHANGES_DIR, sessionId);
}

/**
 * the transcript tool call that owns a change. a call a codemode script makes
 * gets the id `<parent id>/<n>`: it never appears in the transcript, so undo
 * could not find it, and its `/` would make the record path a missing dir.
 * its changes belong to the script's own call.
 */
function ownerId(toolCallId: string): string {
	return toolCallId.split("/")[0]!;
}

function changePath(sessionId: string, toolCallId: string, changeId: string): string {
	return path.join(sessionDir(sessionId), `${ownerId(toolCallId)}.${changeId}`);
}

/** ensure the session's file-changes directory exists. */
function ensureDir(sessionId: string): void {
	const dir = sessionDir(sessionId);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
}

let seq = 0;

/**
 * record a file change to disk. call after performing the edit.
 * the toolCallId comes from the execute() function's first argument.
 * returns the change ID (UUID) for the written record.
 *
 * one tool call can produce multiple changes (several files, or one file
 * edited repeatedly by a codemode script). each gets a unique UUID, stored as
 * {owner id}.{uuid}.
 */
export function saveChange(
	sessionId: string,
	toolCallId: string,
	change: Omit<FileChange, "id" | "reverted">,
): string {
	ensureDir(sessionId);
	const id = crypto.randomUUID();
	const record: FileChange = {
		...change,
		id,
		reverted: false,
		seq: seq++,
	};
	fs.writeFileSync(changePath(sessionId, toolCallId, id), JSON.stringify(record, null, 2), "utf-8");
	return id;
}

/** forget a record whose write never happened. the record is ours; the user's file was not touched. */
export function discardChange(sessionId: string, toolCallId: string, changeId: string): void {
	fs.rmSync(changePath(sessionId, toolCallId, changeId), { force: true });
}

/**
 * load all change records for a tool call. one tool call can produce
 * multiple changes (different files), each with its own UUID.
 */
export function loadChanges(sessionId: string, toolCallId: string): FileChange[] {
	const dir = sessionDir(sessionId);
	if (!fs.existsSync(dir)) return [];

	const prefix = `${ownerId(toolCallId)}.`;
	try {
		return fs.readdirSync(dir)
			.filter((f) => f.startsWith(prefix))
			.map((f) => {
				try {
					return JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")) as FileChange;
				} catch {
					return null;
				}
			})
			.filter((c): c is FileChange => c !== null);
	} catch {
		return [];
	}
}

/**
 * mark a specific change as reverted and restore the file.
 * returns the change record, or null if not found / already reverted.
 */
/** which recorded copy the file is expected to be holding right now. */
export type RecordedSide = "before" | "after";

/**
 * does the file still hold exactly the copy we expect it to?
 *
 * NEITHER DIRECTION MAY OVERWRITE WHAT IT DID NOT PUT THERE.
 *
 * Undo and redo both work by writing a remembered copy back, and that is safe
 * only while the file still holds the copy that step started from — `after`
 * for undo (what the tool wrote), `before` for redo (what the undo restored).
 * Anything else that touched it since — a shell command, a formatter, another
 * editor — left content that was never recorded anywhere: it exists in the
 * file and nowhere else. Overwriting it is the one loss this tool cannot walk
 * back, since every other write here is itself reversible from these records.
 *
 * Both directions need this, and asking in only one is not a half fix but a
 * false sense of one: whichever side is left unchecked is a complete path to
 * the same silent loss.
 */
export function matchesRecordedState(change: FileChange, side: RecordedSide = "after"): boolean {
	const filePath = change.uri.replace(/^file:\/\//, "");
	let current: string | null = null;
	try {
		current = fs.readFileSync(filePath, "utf-8");
	} catch {
		// missing, unreadable, or a directory — none of which is what we left.
		current = null;
	}
	// the existence fields are absent on older records: `afterExists` postdates
	// deletion support, so those all left a file behind; `beforeExists` falls
	// back to `isNewFile`, exactly as `revertChange` does.
	const shouldExist =
		side === "after" ? (change.afterExists ?? true) : (change.beforeExists ?? !change.isNewFile);
	const expected = side === "after" ? change.after : change.before;
	return shouldExist ? current === expected : current === null;
}

export function revertChange(sessionId: string, toolCallId: string, changeId: string): FileChange | null {
	const p = changePath(sessionId, toolCallId, changeId);
	if (!fs.existsSync(p)) return null;

	let change: FileChange;
	try {
		change = JSON.parse(fs.readFileSync(p, "utf-8")) as FileChange;
	} catch {
		return null;
	}
	if (change.reverted) return null;

	// restore the file to its pre-edit state.
	//
	// `beforeExists` is authoritative when present; older records predate it,
	// so fall back to `isNewFile` (a newly created file did not exist before).
	const filePath = change.uri.replace(/^file:\/\//, "");
	const existedBefore = change.beforeExists ?? !change.isNewFile;
	if (existedBefore) {
		// the parent may have been removed since; recreate it before writing.
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, change.before, "utf-8");
		if (change.beforeMode !== undefined) {
			try {
				fs.chmodSync(filePath, change.beforeMode);
			} catch {
				/* mode restore is best-effort; content is what matters */
			}
		}
	} else {
		// the change CREATED this file, so undoing it means removing the file
		// rather than truncating it to empty — to the Trash, never deleted.
		moveToTrash(filePath);
	}

	// mark as reverted on disk
	change.reverted = true;
	fs.writeFileSync(p, JSON.stringify(change, null, 2), "utf-8");

	return change;
}

/**
 * find the most recent non-reverted change for a file path,
 * filtered to only the given tool call IDs (branch awareness).
 *
 * the caller gets activeToolCallIds by scanning the current
 * session branch for tool calls.
 */
/**
 * the OTHER half of a move, if this change is one half of one.
 *
 * WHY THIS EXISTS
 * a move is one logical operation recorded as TWO path histories: a deletion
 * at the source and a creation at the destination. `undo_edit` takes a single
 * path, so undoing only one half is destructive in both directions — undo the
 * destination and the file is gone from both places (data loss); undo the
 * source and it exists twice (duplicate). Reproduced with real content by
 * grok-4.5 stress-testing the tool, 2026-08-12.
 *
 * PAIRING RULE, and why it is this strict: exactly one deletion and exactly
 * one creation within the same tool call, whose bytes are identical. Requiring
 * uniqueness means a batch that moves one file and deletes another unrelated
 * one will not pair them by accident; requiring byte equality means a delete
 * and an unrelated create cannot pair at all. When the batch is ambiguous this
 * returns null and the caller reverts only what was asked for — a partial undo
 * the user can see beats a clever one they cannot predict.
 */
export interface MovePairing {
	/** the other half, when it is known for certain */
	partner: FileChange | null;
	/**
	 * paths that COULD be the other half but could not be told apart. only ever
	 * non-empty for records written before `movePartnerUri` existed.
	 */
	ambiguous: string[];
}

export function findMovePartner(
	sessionId: string,
	toolCallId: string,
	change: FileChange,
): MovePairing {
	const siblings = loadChanges(sessionId, toolCallId).filter(
		(c) => !c.reverted && c.id !== change.id,
	);

	// the recorded answer, when the writer left one. exact, and immune to two
	// files in the batch happening to hold identical bytes.
	if (change.movePartnerUri) {
		return {
			partner: siblings.find((c) => c.uri === change.movePartnerUri) ?? null,
			ambiguous: [],
		};
	}

	/*
	 * LEGACY PATH — records written before `movePartnerUri`. Infer the pair from
	 * shape and bytes, and when that is genuinely undecidable, SAY SO rather
	 * than silently doing half the job: a partial undo the caller is warned
	 * about is recoverable, one they never hear about looks like data loss.
	 */
	const isDeletion = (c: FileChange) => c.beforeExists === true && c.afterExists === false;
	const isCreation = (c: FileChange) => c.beforeExists === false && c.afterExists === true;
	if (!isDeletion(change) && !isCreation(change)) return { partner: null, ambiguous: [] };

	const wanted = isDeletion(change) ? isCreation : isDeletion;
	const matches = siblings.filter(
		(c) => wanted(c) && (isDeletion(change) ? change.before === c.after : c.before === change.after),
	);
	if (matches.length === 1) return { partner: matches[0]!, ambiguous: [] };
	return {
		partner: null,
		ambiguous: matches.map((c) => c.uri.replace(/^file:\/\//, "")),
	};
}

/**
 * put a reverted change back — the redo half of undo.
 *
 * SAFE ONLY WHEN NOTHING HAPPENED SINCE. If any later, still-applied change
 * touched this path, the recorded `after` is no longer the state that followed
 * it, and writing it would clobber newer work with older bytes. That check is
 * the caller's (`isRedoable`), because only the caller knows which tool calls
 * are in the current branch.
 */
export function reapplyChange(
	sessionId: string,
	toolCallId: string,
	changeId: string,
): FileChange | null {
	const p = changePath(sessionId, toolCallId, changeId);
	if (!fs.existsSync(p)) return null;

	let change: FileChange;
	try {
		change = JSON.parse(fs.readFileSync(p, "utf-8")) as FileChange;
	} catch {
		return null;
	}
	if (!change.reverted) return null;

	const filePath = change.uri.replace(/^file:\/\//, "");
	const existsAfter = change.afterExists ?? true;
	if (existsAfter) {
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, change.after, "utf-8");
		if (change.afterMode !== undefined) {
			try {
				fs.chmodSync(filePath, change.afterMode);
			} catch {
				/* mode is best-effort; content is what matters */
			}
		}
	} else {
		moveToTrash(filePath);
	}

	change.reverted = false;
	fs.writeFileSync(p, JSON.stringify(change, null, 2));
	return change;
}

/** oldest write first. */
export function byWriteOrder(changes: FileChange[]): FileChange[] {
	return [...changes].sort((a, b) => a.timestamp - b.timestamp || (a.seq ?? 0) - (b.seq ?? 0));
}

/**
 * the first and last record per file. one call can edit a file more than once
 * (a codemode script): only the last `after` is on disk, and only the first
 * `before` is what the file held when the call started.
 */
export function netPerFile(changes: FileChange[]): Map<string, { first: FileChange; last: FileChange }> {
	const net = new Map<string, { first: FileChange; last: FileChange }>();
	for (const change of byWriteOrder(changes)) {
		const seen = net.get(change.uri);
		net.set(change.uri, { first: seen?.first ?? change, last: change });
	}
	return net;
}

export function findLatestChange(
	sessionId: string,
	filePath: string,
	activeToolCallIds: string[],
): { toolCallId: string; change: FileChange } | null {
	const uri = `file://${path.resolve(filePath)}`;

	// check in reverse order (most recent first)
	for (let i = activeToolCallIds.length - 1; i >= 0; i--) {
		const toolCallId = activeToolCallIds[i];
		const changes = loadChanges(sessionId, toolCallId);
		// within a tool call, find the matching file (most recent by timestamp)
		const match = changes
			.filter((c) => !c.reverted && c.uri === uri)
			.sort((a, b) => b.timestamp - a.timestamp || (b.seq ?? 0) - (a.seq ?? 0))[0];
		if (match) {
			return { toolCallId, change: match };
		}
	}

	return null;
}

/**
 * graceful require for the `diff` package — falls back to a naive
 * line-by-line diff when the package isn't resolvable (same pattern
 * as cheerio in html-to-md.ts).
 */
let createPatchFn: ((fileName: string, oldStr: string, newStr: string, oldHeader?: string, newHeader?: string, options?: { context?: number }) => string) | null = null;

try {
	const esmRequire = createRequire(import.meta.url);
	const diffLib = esmRequire("diff");
	createPatchFn = diffLib.createPatch;
} catch { /* diff not installed — use fallback */ }

/**
 * generate a unified diff between two strings.
 *
 * uses the `diff` npm package (Myers algorithm) when available for
 * proper hunk-based output with context lines. context=3 matches
 * git's default, producing gaps between distant changes that show()
 * can elide in collapsed display.
 *
 * falls back to a naive line-by-line comparison when `diff` isn't
 * installed (produces correct but less optimal output — every line
 * is either +, -, or context with no hunk headers).
 */
export function simpleDiff(filePath: string, before: string, after: string): string {
	if (createPatchFn) {
		const patch = createPatchFn(
			path.basename(filePath),
			before,
			after,
			undefined,
			undefined,
			{ context: 3 },
		);
		// strip the Index: and === lines that createPatch prepends —
		// they add noise for LLM consumption and TUI display
		const lines = patch.split("\n");
		const startIdx = lines.findIndex((l) => l.startsWith("---"));
		return (startIdx > 0 ? lines.slice(startIdx) : lines).join("\n");
	}

	// fallback: naive line-by-line diff (no shortest-edit-distance)
	const beforeLines = before.split("\n");
	const afterLines = after.split("\n");

	const lines: string[] = [
		`--- ${path.basename(filePath)}`,
		`+++ ${path.basename(filePath)}`,
	];

	let i = 0;
	let j = 0;
	while (i < beforeLines.length || j < afterLines.length) {
		if (i < beforeLines.length && j < afterLines.length && beforeLines[i] === afterLines[j]) {
			lines.push(` ${beforeLines[i]}`);
			i++;
			j++;
		} else if (i < beforeLines.length && (j >= afterLines.length || beforeLines[i] !== afterLines[j])) {
			lines.push(`-${beforeLines[i]}`);
			i++;
		} else {
			lines.push(`+${afterLines[j]}`);
			j++;
		}
	}

	return lines.join("\n");
}
