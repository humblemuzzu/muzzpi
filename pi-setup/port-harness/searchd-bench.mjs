// Times searchd against rg for the requests the find and grep tools make.
//   node pi-setup/port-harness/searchd-bench.mjs [dir ...]
// The daemon is the one on $SEARCHD_DIR (the user's own, if that is unset).
// With SEARCHD_BIN and nothing answering there, this starts one with
// SEARCHD_DIR as its data dir and SEARCHD_ROOT (default /) as its root, waits
// up to SEARCHD_WAIT_SECS for the index to warm, and shuts it down at the end.
import { spawn } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const DATA = process.env.SEARCHD_DIR ?? path.join(os.homedir(), ".pi/agent/searchd");
const SOCK = path.join(DATA, "searchd.sock");
const BIN = process.env.SEARCHD_BIN;
const ROOT = process.env.SEARCHD_ROOT ?? "/";
const WAIT = Number(process.env.SEARCHD_WAIT_SECS ?? 0);
const RG = ["--hidden", "--glob", "!.git", "--glob", "!.jj"];
const dirs = process.argv.slice(2).length > 0 ? process.argv.slice(2).map((d) => path.resolve(d)) : [process.cwd(), os.homedir()];

function searchd(req) {
	return new Promise((resolve, reject) => {
		const t = performance.now();
		const c = net.createConnection(SOCK);
		let buf = "";
		c.on("connect", () => c.write(`${JSON.stringify(req)}\n`));
		c.on("data", (d) => (buf += d));
		c.on("end", () => {
			const last = buf.trimEnd().split("\n").at(-1) ?? "";
			resolve({ ms: performance.now() - t, note: last.includes("searchd_fallback") ? `fell back: ${JSON.parse(last).reason}` : "" });
		});
		c.on("error", reject);
	});
}

function statusText() {
	return new Promise((resolve) => {
		const c = net.createConnection(SOCK);
		let buf = "";
		c.on("connect", () => c.write('{"op":"status"}\n'));
		c.on("data", (d) => (buf += d));
		c.on("end", () => resolve(buf.trimEnd().split("\n").at(-1) ?? ""));
		c.on("error", () => resolve(""));
	});
}

async function status() {
	try {
		return JSON.parse(await statusText());
	} catch {
		return undefined;
	}
}

let daemon;
async function ensureDaemon() {
	if (await status()) return;
	if (!BIN) {
		console.error(`no daemon answers on ${SOCK}; set SEARCHD_DIR and SEARCHD_BIN to bench one of your own`);
		process.exit(1);
	}
	console.log(`starting ${BIN} on ${DATA} over ${ROOT}`);
	daemon = spawn(BIN, ["serve", "--root", ROOT], { env: { ...process.env, SEARCHD_DIR: DATA }, stdio: "ignore", detached: true });
	daemon.unref();
	for (let i = 0; i < 120; i++) {
		if (await status()) return;
		await new Promise((r) => setTimeout(r, 1000));
	}
	console.error(`the daemon on ${DATA} never answered`);
	process.exit(1);
}

async function warm() {
	if (WAIT <= 0) return;
	const until = Date.now() + WAIT * 1000;
	let last = "";
	while (Date.now() < until) {
		const st = await status();
		if (!st) break;
		const now = `${st.indexedFiles} files indexed, ${st.filesPending} pending, ready ${st.contentReady}`;
		if (now !== last) {
			console.log(`warming: ${now}`);
			last = now;
		}
		if (st.contentReady && st.filesPending === 0) return;
		await new Promise((r) => setTimeout(r, 5000));
	}
}

function rg(args, cwd, stopAtMatches) {
	return new Promise((resolve) => {
		const t = performance.now();
		const c = spawn("rg", args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
		let n = 0;
		let rest = "";
		const timer = setTimeout(() => c.kill(), 60_000);
		c.stdout.on("data", (d) => {
			const lines = (rest + d).split("\n");
			rest = lines.pop();
			if (stopAtMatches && (n += lines.filter((l) => l.startsWith('{"type":"match"')).length) >= stopAtMatches) c.kill();
		});
		c.on("close", () => {
			clearTimeout(timer);
			const ms = performance.now() - t;
			resolve({ ms, note: ms >= 60_000 ? "stopped at 60 s" : "" });
		});
	});
}

async function median(fn, runs) {
	if (runs <= 1) return fn();
	await fn();
	const xs = [];
	let note = "";
	for (let i = 0; i < runs; i++) {
		const r = await fn();
		xs.push(r.ms);
		note = r.note;
	}
	xs.sort((a, b) => a - b);
	return { ms: xs[Math.floor(xs.length / 2)], note };
}

const fmt = (r) => `${r.ms >= 1000 ? `${(r.ms / 1000).toFixed(2)} s` : `${r.ms.toFixed(1)} ms`}${r.note ? ` (${r.note})` : ""}`;

await ensureDaemon();
await warm();
const before = await status();

async function known(dir) {
	for (let i = 0; i < 60; i++) {
		const r = await searchd({ op: "find", dir, glob: "*", limit: 1 }).catch(() => ({ note: "no daemon" }));
		if (!r.note) return;
		if (i === 0) console.log(`  waiting for ${dir}: ${r.note.replace("fell back: ", "")}`);
		await new Promise((r) => setTimeout(r, 1000));
	}
}

for (const dir of dirs) {
	const broad = dir === os.homedir() || dir === "/";
	const runs = broad ? 1 : 5;
	await known(dir);
	console.log(`\n${dir}`);
	const cases = [
		["find **/*.ts", { op: "find", dir, glob: "**/*.ts", limit: 500 }, ["--files", ...RG, "--glob", "**/*.ts", "."], 0],
		["find **/AGENTS.md", { op: "find", dir, glob: "**/AGENTS.md", limit: 500 }, ["--files", ...RG, "--glob", "**/AGENTS.md", "."], 0],
		["grep import (200 matches)", { op: "grep", dir, pattern: "import", context: 1, limit: 200 }, ["--json", ...RG, "-C1", "--", "import", "."], 200],
		["grep a rare identifier", { op: "grep", dir, pattern: "zqxjv_rare_ident", context: 1, limit: 200 }, ["--json", ...RG, "-C1", "--", "zqxjv_rare_ident", "."], 200],
	];
	for (const [label, req, args, stop] of cases) {
		const a = await median(() => searchd(req), runs);
		const b = await median(() => rg(args, dir, stop), broad ? 1 : 3);
		console.log(`  ${label.padEnd(28)} searchd ${fmt(a).padEnd(26)} rg ${fmt(b)}`);
	}
}

if (before) console.log(`\ndaemon: ${before.indexedFiles} files indexed before, ${before.segments} segments, contentReady ${before.contentReady}`);
const after = await status();
if (after) console.log(`daemon: ${after.indexedFiles} files indexed after, ${after.queries} queries, indexBlocked ${after.indexBlocked}`);
if (daemon) {
	const c = net.createConnection(SOCK);
	c.on("connect", () => c.write('{"op":"shutdown"}\n'));
	c.on("close", () => process.exit(0));
} else {
	process.exit(0);
}
