/**
 * When each session last saw a file's contents (read, or its own edit/write),
 * so an edit that misses can say "the file changed after you read it" instead
 * of leaving the agent to guess. read and edit/write share this module because
 * they load in the same extension; a separate extension would see an empty map.
 */

import * as fs from "node:fs";
import * as path from "node:path";

interface Seen {
	mtimeMs: number;
	at: number;
}

const MAX_ENTRIES = 5000;
const seen = new Map<string, Seen>();
const key = (session: string, file: string) => `${session}\0${path.resolve(file)}`;

export function markSeen(session: string, file: string): void {
	try {
		const entry = { mtimeMs: fs.statSync(file).mtimeMs, at: Date.now() };
		const id = key(session, file);
		seen.delete(id);
		seen.set(id, entry);
		if (seen.size > MAX_ENTRIES) seen.delete(seen.keys().next().value!);
	} catch {
		// a file that cannot be stat'ed has nothing to compare against later.
	}
}

/** when the file was modified and when this session last saw it, if it changed since. */
export function changedSinceSeen(session: string, file: string): { seenAt: number; modifiedAt: number } | undefined {
	const entry = seen.get(key(session, file));
	if (!entry) return undefined;
	try {
		const mtimeMs = fs.statSync(file).mtimeMs;
		return mtimeMs !== entry.mtimeMs ? { seenAt: entry.at, modifiedAt: mtimeMs } : undefined;
	} catch {
		return undefined;
	}
}
