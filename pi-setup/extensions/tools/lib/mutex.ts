/**
 * per-path async mutex shared by edit, write, bash, format_file and undo_edit.
 *
 * keyed by resolved absolute path — two relative paths pointing to the same
 * file share one lock. pi's edit/write also take pi's own mutation queue
 * inside this lock; the two are separate maps, so they cannot deadlock.
 */

import * as path from "node:path";

const locks = new Map<string, Promise<void>>();

/**
 * execute `fn` while holding an exclusive lock on `filePath`.
 * concurrent calls for the same resolved path queue sequentially.
 */
export async function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
	const key = path.resolve(filePath);

	while (locks.has(key)) {
		await locks.get(key);
	}

	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	locks.set(key, promise);

	try {
		return await fn();
	} finally {
		locks.delete(key);
		resolve();
	}
}

