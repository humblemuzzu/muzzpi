#!/usr/bin/env bun
// Usage: bun pi-setup/port-harness/perf-baseline.ts [runs=10] [session.jsonl]
// Prints startup (parent + sub-agent child), the request prefix of a session, and disk use.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { childExtensionArgs } from "../extensions/tools/lib/pi-spawn";

const runs = Number(process.argv[2] ?? 10);
const agentDir = path.join(os.homedir(), ".pi", "agent");
const ext = (p: string) => path.join(agentDir, "extensions", p);
const childArgs = childExtensionArgs(["codemode"]);

type Sample = { wall: number; main: number; extensions: Map<string, number> };

function sample(args: string[]): Sample {
	const t0 = performance.now();
	const r = spawnSync("pi", ["--no-session", "--mode", "rpc", ...args], {
		cwd: os.tmpdir(),
		env: { ...process.env, PI_TIMING: "1" },
		input: "",
		encoding: "utf8",
	});
	const wall = performance.now() - t0;
	const out = `${r.stdout}\n${r.stderr}`;
	const main = Number(/--- Startup Timings: main ---[\s\S]*?TOTAL: (\d+)ms/.exec(out)?.[1] ?? NaN);
	const extensions = new Map<string, number>();
	for (const m of out.matchAll(/^\s+(\S+) (?:module import|factory): (\d+)ms$/gm)) {
		const name = m[1].replace(agentDir, "~");
		extensions.set(name, (extensions.get(name) ?? 0) + Number(m[2]));
	}
	return { wall, main, extensions };
}

const median = (xs: number[]) => {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.floor(s.length / 2)] ?? NaN;
};

function bench(label: string, args: string[]) {
	sample(args);
	const samples = Array.from({ length: runs }, () => sample(args));
	const names = new Set(samples.flatMap((s) => [...s.extensions.keys()]));
	const per = [...names].map((n) => [n, median(samples.map((s) => s.extensions.get(n) ?? 0))] as const);
	const extTotal = median(samples.map((s) => [...s.extensions.values()].reduce((a, b) => a + b, 0)));
	console.log(`\n## ${label} (median of ${runs})`);
	console.log(`wall ${median(samples.map((s) => s.wall)).toFixed(0)} ms · pi main ${median(samples.map((s) => s.main))} ms · extensions ${extTotal} ms`);
	for (const [n, v] of per.sort((a, b) => b[1] - a[1])) if (v > 0) console.log(`  ${String(v).padStart(4)} ms  ${n}`);
}

function latestSession(): string | undefined {
	const dir = path.join(agentDir, "sessions");
	let best: { f: string; t: number } | undefined;
	for (const d of fs.readdirSync(dir)) {
		const sub = path.join(dir, d);
		if (!fs.statSync(sub).isDirectory()) continue;
		for (const f of fs.readdirSync(sub)) {
			if (!f.endsWith(".jsonl")) continue;
			const t = fs.statSync(path.join(sub, f)).mtimeMs;
			if (!best || t > best.t) best = { f: path.join(sub, f), t };
		}
	}
	return best?.f;
}

function prefix(file: string) {
	for (const line of fs.readFileSync(file, "utf8").split("\n")) {
		if (!line) continue;
		const m = JSON.parse(line).message;
		if (m?.role !== "system") continue;
		const sections = Object.entries((m.sections ?? {}) as Record<string, string>).map(([k, v]) => [k, v.length] as const);
		const tools = ((m.toolsAdded ?? []) as { name: string }[]).map((t) => [t.name, JSON.stringify(t).length] as const);
		const s = sections.reduce((a, [, n]) => a + n, 0);
		const t = tools.reduce((a, [, n]) => a + n, 0);
		console.log(`\n## request prefix: ${path.basename(file)}`);
		console.log(`total ${s + t} chars (~${Math.round((s + t) / 4)} tokens) · sections ${s} · ${tools.length} tools ${t}`);
		for (const [k, n] of sections.sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(6)}  section ${k}`);
		for (const [k, n] of tools.sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(6)}  tool ${k}`);
		return;
	}
}

function disk() {
	console.log("\n## disk");
	for (const p of [path.join(agentDir, "npm", "node_modules"), ext("tools/node_modules"), ext("computer/node_modules")]) {
		if (!fs.existsSync(p)) continue;
		const r = spawnSync("du", ["-sh", p], { encoding: "utf8" });
		console.log(`  ${r.stdout.trim().replace(agentDir, "~")}`);
	}
}

bench("parent (full setup)", []);
bench("sub-agent child (CHILD_EXTENSIONS + codemode)", childArgs);
const file = process.argv[3] ?? latestSession();
if (file) prefix(file);
disk();
