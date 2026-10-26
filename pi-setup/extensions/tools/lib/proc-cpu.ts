/**
 * process-group CPU sampling for the bash idle watchdog.
 * returns undefined on any failure by design; CPU can only keep a command
 * alive, never kill it. the child is spawned detached so pgid === child.pid.
 */

import { execFile } from "node:child_process";

/**
 * parse a `ps` cputime string (`[DD-]H:MM:SS.ss`, leading fields dropped when
 * zero) to seconds. undefined for anything that does not parse.
 */
export function cpuTimeToSeconds(raw: string): number | undefined {
	const s = raw.trim();
	if (!s) return undefined;
	let days = 0;
	let rest = s;
	const dash = rest.indexOf("-");
	if (dash !== -1) {
		const dStr = rest.slice(0, dash);
		const d = Number(dStr);
		if (dStr.trim() === "" || !Number.isFinite(d)) return undefined;
		days = d;
		rest = rest.slice(dash + 1);
	}
	// Number("") is 0, so an empty field after a stray dash/colon would parse as a real time.
	if (rest.trim() === "") return undefined;
	const parts = rest.split(":");
	if (parts.length === 0 || parts.length > 3) return undefined;
	const nums = parts.map((p) => (p.trim() === "" ? Number.NaN : Number(p)));
	if (nums.some((n) => !Number.isFinite(n) || n < 0)) return undefined;
	while (nums.length < 3) nums.unshift(0);
	const [h, m, sec] = nums;
	return days * 86400 + h * 3600 + m * 60 + sec;
}

/**
 * sum cputime of every process whose PGID matches, from `ps -o pgid=,cputime= -ax`
 * stdout. undefined when no process in the group is found — not the same as 0 CPU.
 */
export function parseGroupCpuSeconds(psStdout: string, pgid: number): number | undefined {
	let total = 0;
	let matched = 0;
	for (const line of psStdout.split("\n")) {
		const m = line.match(/^\s*(\d+)\s+(\S+)/);
		if (!m) continue;
		if (Number(m[1]) !== pgid) continue;
		const secs = cpuTimeToSeconds(m[2]);
		if (secs === undefined) continue;
		total += secs;
		matched++;
	}
	return matched > 0 ? total : undefined;
}

/**
 * sample total CPU seconds of a process group, or undefined if it cannot be
 * measured. 2s timeout so ps cannot wedge the watchdog.
 */
export function sampleGroupCpuSeconds(pgid: number): Promise<number | undefined> {
	if (!Number.isInteger(pgid) || pgid <= 0) return Promise.resolve(undefined);
	return new Promise((resolve) => {
		execFile("ps", ["-o", "pgid=,cputime=", "-ax"], { encoding: "utf-8", timeout: 2000, maxBuffer: 8 * 1024 * 1024 }, (error, out) => {
			resolve(error ? undefined : parseGroupCpuSeconds(out, pgid));
		});
	});
}
