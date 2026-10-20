import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Styler } from "../tools/lib/agent-layout";

const execFileAsync = promisify(execFile);

export interface DiffSummary {
	files: number;
	insertions: number;
	deletions: number;
}

/** `git diff --shortstat`: ` 3 files changed, 10 insertions(+), 2 deletions(-)`. */
export function parseDiffStat(stdout: string): DiffSummary | undefined {
	const summary = stdout.trim().split("\n").at(-1)?.trim() ?? "";
	const files = summary.match(/(\d+)\s+files?\s+changed/);
	if (!files) return undefined;
	const insertions = summary.match(/(\d+)\s+insertions?\(\+\)/);
	const deletions = summary.match(/(\d+)\s+deletions?\(-\)/);
	return { files: Number(files[1]), insertions: Number(insertions?.[1] ?? 0), deletions: Number(deletions?.[1] ?? 0) };
}

/** Staged and unstaged changes to tracked files, against HEAD; new untracked files are not counted. */
export async function readDiffSummary(cwd: string): Promise<DiffSummary | undefined> {
	try {
		const { stdout } = await execFileAsync("git", ["diff", "HEAD", "--shortstat"], { cwd, timeout: 3000 });
		return parseDiffStat(stdout);
	} catch {
		return undefined;
	}
}

/** `29 files +1059 -1128`, all grey: a diff is a fact, not an alarm. */
export function formatChanges(diff: DiffSummary | undefined, paint: Styler): string {
	if (!diff) return "";
	const parts = [`${diff.files} ${diff.files === 1 ? "file" : "files"}`];
	if (diff.insertions > 0) parts.push(`+${diff.insertions}`);
	if (diff.deletions > 0) parts.push(`-${diff.deletions}`);
	return paint.fg("dim", parts.join(" "));
}
