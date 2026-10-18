// Every sampled real query, answered by the running searchd and by rg, must
// give the same matches (no limit, every line compared).
//   python3 pi-setup/port-harness/searchd-real-queries.py
//   bun pi-setup/port-harness/searchd-real-parity.ts <dir> [greps] [finds] [queries.json]
// Two rules match the tools' contract: a glob only narrows the
// .gitignore-respecting list, and a file rg reports as binary shows no lines
// (rg's own lines there depend on its read buffer, see query.rs). Both sides
// are streamed and each line kept as a hash: some real queries match
// gigabytes of minified code.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

process.on("uncaughtException", (e) => {
	console.error(`harness error: ${e.message}`);
	process.exit(2);
});

const dir = process.argv[2];
const nGrep = Number(process.argv[3] ?? 300);
const nFind = Number(process.argv[4] ?? 150);
const Q = JSON.parse(readFileSync(process.argv[5] ?? "/tmp/searchd-real-queries.json", "utf8"));
const SOCK = path.join(process.env.SEARCHD_DIR ?? path.join(os.homedir(), ".pi/agent/searchd"), "searchd.sock");
const BASE = ["--hidden", "--color=never", "--glob", "!.git", "--glob", "!.jj"];
const strip = (p: string) => (p.startsWith("./") ? p.slice(2) : p);
const plain = new Set(
	spawnSync("rg", ["--files", ...BASE, "."], { cwd: dir, maxBuffer: 2 ** 31, encoding: "utf8" }).stdout.split("\n").filter(Boolean).map(strip),
);
const diff = (a: Set<string>, b: Set<string>) => [...a].filter((x) => !b.has(x));

/** Collects one side's answer: `path:line:hash(text)` per match, and files reported binary. */
class Answer {
	keys = new Set<string>();
	binary = new Set<string>();
	paths: string[] = [];
	fallback?: string;
	take(line: string) {
		if (line.startsWith('{"type":"match"')) {
			const d = JSON.parse(line).data;
			const text = d.lines.text ?? JSON.stringify(d.lines);
			this.keys.add(`${strip(d.path.text ?? JSON.stringify(d.path))}:${d.line_number}:${Bun.hash(text).toString(36)}`);
		} else if (line.startsWith('{"type":"end"')) {
			const d = JSON.parse(line).data;
			if (d.binary_offset !== null) this.binary.add(strip(d.path.text ?? ""));
		} else if (line.startsWith('{"type":"searchd_fallback"')) {
			this.fallback = JSON.parse(line).reason;
		} else if (line.startsWith('"')) {
			this.paths.push(JSON.parse(line));
		}
	}
	matches(allowed?: Set<string>): Set<string> {
		return new Set([...this.keys].filter((k) => {
			const p = k.slice(0, k.lastIndexOf(":", k.lastIndexOf(":") - 1));
			return !this.binary.has(p) && (!allowed || allowed.has(p));
		}));
	}
}

/** Feeds `a` whole lines cut on the newline byte. Not readline: Bun's splits
 * at U+2028, which JSON may carry unescaped. */
function byLines(a: Answer): (chunk: Buffer) => void {
	let pending = Buffer.alloc(0);
	return (chunk) => {
		pending = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
		let start = 0;
		let nl: number;
		while ((nl = pending.indexOf(10, start)) >= 0) {
			a.take(pending.toString("utf8", start, nl));
			start = nl + 1;
		}
		pending = pending.subarray(start);
	};
}

function fromRg(args: string[]): Promise<Answer> {
	return new Promise((resolve) => {
		const a = new Answer();
		const child = spawn("rg", args, { cwd: dir, stdio: ["ignore", "pipe", "ignore"] });
		child.stdout.on("data", byLines(a));
		child.on("close", () => resolve(a));
	});
}

function fromSearchd(req: object): Promise<Answer> {
	return new Promise((resolve, reject) => {
		const a = new Answer();
		const c = net.createConnection(SOCK);
		c.on("connect", () => c.write(`${JSON.stringify(req)}\n`));
		c.on("data", byLines(a));
		c.on("end", () => resolve(a));
		c.on("error", reject);
	});
}

const tally = { grep: [0, 0, 0], find: [0, 0, 0] };
let compared = 0;
const failures: string[] = [];
for (const [i, q] of Q.grep.slice(0, nGrep).entries()) {
	if (i % 10 === 0) process.stderr.write(`  grep ${i}/${nGrep}\n`);
	const sd = await fromSearchd({ op: "grep", dir, pattern: q.pattern, literal: q.literal, ignoreCase: q.ignoreCase, glob: q.glob ?? undefined, context: 0 });
	if (sd.fallback) {
		tally.grep[2]++;
		continue;
	}
	const args = ["--json", ...BASE, "--context", "0", ...(q.ignoreCase ? ["--ignore-case"] : []), ...(q.literal ? ["--fixed-strings"] : [])];
	if (q.glob) args.push("--glob", q.glob);
	const want = (await fromRg([...args, "--", q.pattern, "."])).matches(q.glob ? plain : undefined);
	const got = sd.matches();
	compared += want.size;
	if (want.size === got.size && diff(want, got).length === 0) tally.grep[0]++;
	else {
		tally.grep[1]++;
		failures.push(`grep ${JSON.stringify(q)}: missing ${diff(want, got).slice(0, 2)} extra ${diff(got, want).slice(0, 2)}`);
	}
}
for (const g of Q.find.slice(0, nFind)) {
	const sd = await fromSearchd({ op: "find", dir, glob: g });
	if (sd.fallback) {
		tally.find[2]++;
		continue;
	}
	const r = spawnSync("rg", ["--files", ...BASE, "--glob", g, "."], { cwd: dir, maxBuffer: 2 ** 31, encoding: "utf8" });
	const want = new Set(r.stdout.split("\n").filter(Boolean).map(strip).filter((p) => plain.has(p)));
	const got = new Set(sd.paths);
	if (want.size === got.size && diff(want, got).length === 0) tally.find[0]++;
	else {
		tally.find[1]++;
		failures.push(`find ${g}: missing ${diff(want, got).slice(0, 2)} extra ${diff(got, want).slice(0, 2)}`);
	}
}
console.log(`${dir} (${plain.size} files)`);
console.log(`  grep: ${tally.grep[0]} same as rg, ${tally.grep[1]} differ, ${tally.grep[2]} handed to rg; ${compared} matching lines compared`);
console.log(`  find: ${tally.find[0]} same as rg, ${tally.find[1]} differ, ${tally.find[2]} handed to rg`);
for (const f of failures.slice(0, 10)) console.log(`  DIFF ${f.slice(0, 300)}`);
process.exit(failures.length > 0 ? 1 : 0);
