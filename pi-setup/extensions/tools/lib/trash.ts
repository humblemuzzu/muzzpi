import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/** Never deletes: macOS `trash`, or a rename into PI_TRASH_DIR (tests). */
export function moveToTrash(file: string): void {
	try {
		fs.lstatSync(file);
	} catch {
		return;
	}
	const dir = process.env.PI_TRASH_DIR;
	if (dir) {
		fs.mkdirSync(dir, { recursive: true });
		fs.renameSync(file, path.join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${path.basename(file)}`));
		return;
	}
	try {
		execFileSync("trash", [file], { stdio: "ignore", timeout: 10_000 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new Error(`cannot move ${file} to the Trash: the trash command is not installed (macOS 15+ ships /usr/bin/trash; otherwise brew install trash)`);
		}
		throw error;
	}
}
