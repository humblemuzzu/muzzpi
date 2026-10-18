/**
 * Client for searchd (pi-setup/searchd), the index daemon behind find and
 * grep. Nothing runs at load; a call is one Unix-socket request. Any problem
 * (no daemon, no reply, a refusal) returns `fallback`, and the tool runs rg
 * exactly as it would without searchd.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

export function searchdSocket(): string {
	return path.join(process.env.SEARCHD_DIR ?? path.join(os.homedir(), ".pi", "agent", "searchd"), "searchd.sock");
}

function searchdBin(): string {
	return process.env.SEARCHD_BIN ?? path.join(os.homedir(), ".pi", "agent", "bin", "searchd");
}

/** The daemon acknowledges every request at once; no ack means it is not there. */
const ACK_MS = 100;
/** The daemon bounds its waits (index locks 1 s, live feed 3 s + 3 s) and hands a search over after 8 s, so this long without a byte means it is stuck. */
const SILENCE_MS = 10_000;
const RESPAWN_MS = 60_000;

export interface SearchdEnd {
	exit: number;
	total?: number;
	head?: number;
	skippedAreas?: number;
	skippedFiles?: number;
	unreadable?: boolean;
}

export type SearchdAnswer = { lines: string[]; end: SearchdEnd } | { fallback: string };

let lastSpawn = 0;

function startDaemon(): void {
	const now = Date.now();
	const bin = searchdBin();
	if (now - lastSpawn < RESPAWN_MS || !fs.existsSync(bin)) return;
	lastSpawn = now;
	try {
		const child = spawn(bin, ["serve"], { detached: true, stdio: "ignore" });
		child.on("error", () => {});
		child.unref();
	} catch {}
}

/** Why searchd must not answer in this process, if it must not. */
function refusal(): string | undefined {
	if (process.env.PI_SEARCHD === "0") return "PI_SEARCHD=0";
	// rg reads its config file; the daemon cannot know what it changes.
	if (process.env.RIPGREP_CONFIG_PATH) return "RIPGREP_CONFIG_PATH is set";
	return undefined;
}

export function askSearchd(request: Record<string, unknown>, signal?: AbortSignal): Promise<SearchdAnswer> {
	const refused = refusal();
	if (refused) return Promise.resolve({ fallback: refused });
	if (signal?.aborted) return Promise.resolve({ fallback: "aborted" });
	return new Promise((resolve) => {
		const lines: string[] = [];
		let pending = Buffer.alloc(0);
		let acked = false;
		let done = false;
		const sock = net.createConnection(searchdSocket());
		const finish = (answer: SearchdAnswer) => {
			if (done) return;
			done = true;
			clearTimeout(ackTimer);
			clearTimeout(silence);
			signal?.removeEventListener("abort", onAbort);
			sock.destroy();
			resolve(answer);
		};
		const ackTimer = setTimeout(() => finish({ fallback: "searchd did not answer" }), ACK_MS);
		let silence = setTimeout(() => finish({ fallback: "searchd went silent" }), SILENCE_MS);
		const onAbort = () => finish({ fallback: "aborted" });
		signal?.addEventListener("abort", onAbort, { once: true });

		sock.on("connect", () => sock.write(`${JSON.stringify(request)}\n`));
		sock.on("error", (err: NodeJS.ErrnoException) => {
			if (err.code === "ENOENT" || err.code === "ECONNREFUSED") startDaemon();
			finish({ fallback: `searchd: ${err.code ?? err.message}` });
		});
		// Lines are cut on the newline byte and decoded whole, so a chunk that
		// ends inside a multi-byte character never reaches a string decoder.
		sock.on("data", (chunk: Buffer) => {
			clearTimeout(silence);
			silence = setTimeout(() => finish({ fallback: "searchd went silent" }), SILENCE_MS);
			pending = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
			let start = 0;
			let nl: number;
			while ((nl = pending.indexOf(10, start)) >= 0) {
				const line = pending.toString("utf8", start, nl);
				start = nl + 1;
				if (line.startsWith('{"type":"searchd_')) {
					let msg: any;
					try {
						msg = JSON.parse(line);
					} catch {
						return finish({ fallback: "searchd sent garbage" });
					}
					if (msg.type === "searchd_ack") {
						acked = true;
						clearTimeout(ackTimer);
					} else if (msg.type === "searchd_end" && acked) {
						return finish({ lines, end: msg });
					} else {
						return finish({ fallback: msg.reason ?? "searchd refused" });
					}
				} else if (acked) {
					lines.push(line);
				}
			}
			pending = pending.subarray(start);
		});
		sock.on("close", () => finish({ fallback: "searchd closed the connection" }));
	});
}

/** Notes for the model about what a broad (home- or disk-wide) answer left out. */
export function searchdNotices(end: SearchdEnd): string[] {
	const out: string[] = [];
	if (end.skippedAreas) out.push(`${end.skippedAreas} folder${end.skippedAreas > 1 ? "s were" : " was"} not searched: system and app folders, ~/Library, toolchains, package caches and dependency or build folders (node_modules, site-packages, .venv and the like); search inside one directly to include it`);
	if (end.skippedFiles) out.push(`${end.skippedFiles} files over 1 MB, in ~/Library (app data), outside your home folder or not yet in the index were not searched; search their folder directly to include them`);
	if (end.unreadable) out.push("some files or folders could not be read and were skipped");
	return out;
}
