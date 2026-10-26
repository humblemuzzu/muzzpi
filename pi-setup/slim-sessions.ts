#!/usr/bin/env bun
// bun pi-setup/slim-sessions.ts [--dry] --images|--subagents [path...]
//
// --images: every base64 image block becomes the text "[image removed]". It cannot be undone.
// --subagents: a sub-agent conversation kept inside a parent session is cut to what
// its rows and /stats read, only while the child's own session file still has it all.
// A file changed in the last 30 minutes is skipped (a pi may be writing it); a line is
// rewritten only when it re-encodes byte for byte, and a slimmed conversation must read
// exactly as before.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getDisplayItems, getFinalOutput, slimMessages } from "./extensions/tools/lib/sub-agent-render";

const USAGE = "usage: bun pi-setup/slim-sessions.ts [--dry] --images|--subagents [path...]";
const args = process.argv.slice(2);
const unknown = args.filter((a) => a.startsWith("-") && !["--dry", "--images", "--subagents"].includes(a));
const wantImages = args.includes("--images");
const wantSubagents = args.includes("--subagents");
if (unknown.length > 0 || (!wantImages && !wantSubagents)) {
	console.error(unknown.length > 0 ? `unknown flag: ${unknown.join(" ")}\n${USAGE}` : USAGE);
	process.exit(2);
}
const dry = args.includes("--dry");
const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
const SUB_DIR = path.join(agentDir, "sessions-sub");
const targets = args.filter((a) => !a.startsWith("-"));
if (targets.length === 0) targets.push(path.join(agentDir, "sessions"), SUB_DIR);
const LOG = path.join(agentDir, "cache", "slim-sessions.jsonl");
const SKIP_RECENT_MS = 30 * 60 * 1000;
const IMAGE = Buffer.from('"type":"image"');
const MESSAGES = Buffer.from('"messages":[');

/** a child session file is `<timestamp>_<continueId>.jsonl` */
const childIds = new Set(
	(fs.existsSync(SUB_DIR) ? fs.readdirSync(SUB_DIR) : [])
		.filter((name) => name.endsWith(".jsonl") && name.includes("_"))
		.map((name) => name.slice(name.indexOf("_") + 1, -".jsonl".length)),
);

function listFiles(target: string, out: string[]): void {
	const st = fs.statSync(target);
	if (st.isFile()) {
		if (target.endsWith(".jsonl")) out.push(target);
		return;
	}
	for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
		const full = path.join(target, entry.name);
		if (entry.isDirectory()) listFiles(full, out);
		else if (entry.name.endsWith(".jsonl")) out.push(full);
	}
}

function stripImages(value: any): number {
	let n = 0;
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			const item = value[i];
			if (item && typeof item === "object" && !Array.isArray(item) && item.type === "image" && typeof item.data === "string") {
				value[i] = { type: "text", text: "[image removed]" };
				n++;
			} else n += stripImages(item);
		}
	} else if (value && typeof value === "object") {
		for (const key of Object.keys(value)) n += stripImages(value[key]);
	}
	return n;
}

function hasImages(value: any): boolean {
	if (Array.isArray(value)) return value.some(hasImages);
	if (value && typeof value === "object") return (value.type === "image" && typeof value.data === "string") || Object.values(value).some(hasImages);
	return false;
}

/** what /stats reads from a child conversation, nested agents included. */
function statsView(messages: any[], depth = 1): unknown[] {
	if (depth > 4) return [];
	const out: unknown[] = [];
	for (const m of messages) {
		if (m?.role !== "toolResult" || typeof m.toolName !== "string") continue;
		out.push([m.toolName, !!m.isError, m.durationMs ?? null]);
		const d = m.details;
		if (d && typeof d === "object" && d.usage && ("agent" in d || "exitCode" in d)) {
			out.push([d.model ?? null, JSON.stringify(d.usage), d.exitCode ?? null, d.stopReason ?? null]);
			if (Array.isArray(d.messages)) out.push(...statsView(d.messages, depth + 1));
		}
	}
	return out;
}

const readsAlike = (a: any[], b: any[]) =>
	JSON.stringify(getDisplayItems(a)) === JSON.stringify(getDisplayItems(b)) &&
	getFinalOutput(a) === getFinalOutput(b) &&
	JSON.stringify(statsView(a)) === JSON.stringify(statsView(b));

/** slims one run-shaped object in place; undefined when it is not one, false when slimming would change what is read. */
function slimRun(run: any): boolean | undefined {
	if (!run || typeof run !== "object" || !Array.isArray(run.messages) || typeof run.continueId !== "string") return undefined;
	if (!childIds.has(run.continueId)) return undefined;
	const slim = slimMessages(run.messages);
	if (JSON.stringify(slim).length >= JSON.stringify(run.messages).length) return undefined;
	if (!readsAlike(run.messages, slim)) return false;
	run.messages = slim;
	return true;
}

/** a blocking result's details, or the runs of a notification or an agents call. */
function slimEntry(entry: any): { slimmed: number; refused: number } {
	const details = entry?.type === "message" && entry.message?.role === "toolResult" ? entry.message.details : entry?.type === "custom_message" ? entry.details : undefined;
	let slimmed = 0, refused = 0;
	for (const run of [details, ...(Array.isArray(details?.runs) ? details.runs : [])]) {
		const outcome = slimRun(run);
		if (outcome === true) slimmed++;
		else if (outcome === false) refused++;
	}
	return { slimmed, refused };
}

function lines(buf: Buffer): Buffer[] {
	const out: Buffer[] = [];
	let start = 0;
	for (let nl = buf.indexOf(0x0a, start); nl !== -1; nl = buf.indexOf(0x0a, start)) {
		out.push(buf.subarray(start, nl));
		start = nl + 1;
	}
	out.push(buf.subarray(start));
	return out;
}

const files: string[] = [];
for (const target of targets) listFiles(target, files);
const totals = { files: files.length, changed: 0, skippedRecent: 0, failed: 0, images: 0, subagents: 0, refused: 0, before: 0, after: 0 };
if (!dry) fs.mkdirSync(path.dirname(LOG), { recursive: true });

/** the file's lines with every change applied, or undefined when nothing changes. */
function rewrite(buf: Buffer): { next: Buffer; images: number; subagents: number } | undefined {
	const mayImage = wantImages && buf.indexOf(IMAGE) !== -1;
	const maySub = wantSubagents && buf.indexOf(MESSAGES) !== -1;
	if (!mayImage && !maySub) return undefined;
	const out: Buffer[] = [];
	let images = 0, subagents = 0;
	for (const raw of lines(buf)) {
		const lineImages = mayImage && raw.indexOf(IMAGE) !== -1;
		const lineSub = maySub && raw.indexOf(MESSAGES) !== -1;
		const text = lineImages || lineSub ? raw.toString("utf8") : "";
		let entry: any;
		try {
			entry = text ? JSON.parse(text) : undefined;
		} catch {}
		// a line that would not re-encode to itself is left as it is: only the slimmed parts may change
		if (!entry || JSON.stringify(entry) !== text) {
			out.push(raw);
			continue;
		}
		const n = lineImages ? stripImages(entry) : 0;
		const sub = lineSub ? slimEntry(entry) : { slimmed: 0, refused: 0 };
		totals.refused += sub.refused;
		if ((n === 0 && sub.slimmed === 0) || (lineImages && hasImages(entry))) {
			out.push(raw);
			continue;
		}
		images += n;
		subagents += sub.slimmed;
		out.push(Buffer.from(JSON.stringify(entry), "utf8"));
	}
	if (images === 0 && subagents === 0) return undefined;
	return { next: Buffer.concat(out.flatMap((b, i) => (i < out.length - 1 ? [b, Buffer.from("\n")] : [b]))), images, subagents };
}

function slimFile(file: string): void {
	const st0 = fs.lstatSync(file);
	if (!st0.isFile()) return;
	if (Date.now() - st0.mtimeMs < SKIP_RECENT_MS) {
		totals.skippedRecent++;
		return;
	}
	const buf = fs.readFileSync(file);
	const done = rewrite(buf);
	if (!done) return;
	const count = () => {
		totals.changed++;
		totals.images += done.images;
		totals.subagents += done.subagents;
		totals.before += buf.length;
		totals.after += done.next.length;
	};
	if (dry) return count();

	const tmp = `${file}.slim-${process.pid}.tmp`;
	try {
		fs.writeFileSync(tmp, done.next, { mode: st0.mode & 0o777 });
		const fd = fs.openSync(tmp, "r");
		fs.fsyncSync(fd);
		fs.closeSync(fd);
		const st1 = fs.lstatSync(file);
		if (st1.size !== st0.size || st1.mtimeMs !== st0.mtimeMs) {
			totals.failed++;
			console.log(`left alone (it changed while being rewritten): ${file}`);
			return;
		}
		fs.utimesSync(tmp, st0.atime, st0.mtime);
		fs.renameSync(tmp, file);
	} finally {
		fs.rmSync(tmp, { force: true });
	}
	count();
	fs.appendFileSync(LOG, `${JSON.stringify({ at: new Date().toISOString(), file, before: buf.length, after: done.next.length, images: done.images, subagents: done.subagents })}\n`);
}

for (const file of files) {
	try {
		slimFile(file);
	} catch (error) {
		totals.failed++;
		console.log(`left alone (${(error as Error).message}): ${file}`);
	}
}

const gb = (n: number) => (n / 1e9).toFixed(2);
console.log(
	`${dry ? "dry run: " : ""}${totals.changed} of ${totals.files} files rewritten (${totals.skippedRecent} skipped as recently changed, ${totals.failed} left alone) · ` +
		`${totals.images} images removed · ${totals.subagents} sub-agent conversations slimmed (${totals.refused} kept: slimming would change what is read) · ` +
		`${gb(totals.before)} GB -> ${gb(totals.after)} GB`,
);
