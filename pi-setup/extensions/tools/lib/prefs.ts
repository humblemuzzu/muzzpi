/** A command's remembered settings: one small JSON object per name in <agent dir>/cache. */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

export function prefsFile(name: string, agentDir: string = getAgentDir()): string {
	return join(agentDir, "cache", `${name}.json`);
}

/** An empty object when the file is missing or unreadable: every setting then has its default. */
export function readPrefs(file: string): Record<string, unknown> {
	try {
		const value: unknown = JSON.parse(readFileSync(file, "utf8"));
		return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

/** Written through a temporary file, so a crash mid-write leaves the old settings, never half of new ones. */
export function writePrefs(file: string, prefs: Record<string, unknown>): void {
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(prefs));
	renameSync(tmp, file);
}
