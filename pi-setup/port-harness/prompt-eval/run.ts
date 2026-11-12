/**
 * Prompt eval: fresh agents on realistic requests, old prompt text against new,
 * judged by what they did (tool calls, files on disk), not by their summaries.
 * Method: amp's proving-changes/reference/agent-instructions.md.
 *
 *   bun pi-setup/port-harness/prompt-eval/run.ts --variant base=/tmp/prompts-base \
 *     --variant new=pi-setup/agents [--runs 3] [--case id,id] [--concurrency 6]
 *
 * Each variant is a folder of agent prompt files read through PI_AGENT_PROMPTS_DIR,
 * so both sides run the same code. Runs spend real tokens.
 */

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CHILD_EXTENSIONS } from "../../extensions/tools/lib/pi-spawn";
import { interpolatePromptVars } from "../../extensions/tools/lib/interpolate";
import { CASES, type Case, type RunResult } from "./cases";

interface Args {
	rejudge?: string;
	variants: Array<{ name: string; dir: string }>;
	runs: number;
	only?: Set<string>;
	concurrency: number;
	out: string;
}

function parseArgs(argv: string[]): Args {
	const args: Args = { variants: [], runs: 3, concurrency: 6, out: path.join(os.tmpdir(), "prompt-eval") };
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		const value = argv[i + 1];
		if (flag === "--rejudge" && value) {
			args.rejudge = path.resolve(value);
			i++;
		} else if (flag === "--variant" && value) {
			const [name, dir] = value.split("=");
			args.variants.push({ name: name!, dir: path.resolve(dir!) });
			i++;
		} else if (flag === "--runs" && value) {
			args.runs = Number(value);
			i++;
		} else if (flag === "--case" && value) {
			args.only = new Set(value.split(","));
			i++;
		} else if (flag === "--concurrency" && value) {
			args.concurrency = Number(value);
			i++;
		} else if (flag === "--out" && value) {
			args.out = path.resolve(value);
			i++;
		}
	}
	if (args.variants.length === 0 && !args.rejudge) throw new Error("give at least one --variant name=dir, or --rejudge results.json");
	return args;
}

function git(dir: string, ...gitArgs: string[]): void {
	const r = spawnSync("git", gitArgs, { cwd: dir, encoding: "utf-8" });
	if (r.status !== 0) throw new Error(`git ${gitArgs.join(" ")}: ${r.stderr}`);
}

function writeFiles(dir: string, files: Record<string, string | null>): void {
	for (const [rel, content] of Object.entries(files)) {
		const file = path.join(dir, rel);
		if (content === null) {
			fs.rmSync(file, { force: true });
			continue;
		}
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, content);
		if (rel.endsWith(".sh")) fs.chmodSync(file, 0o755);
	}
}

/** a git repo holding the fixture as one commit, then the case's uncommitted state on top */
function makeWorkspace(c: Case, root: string): string {
	const dir = fs.mkdtempSync(path.join(root, `${c.id}-`));
	writeFiles(dir, c.fixture.files);
	git(dir, "init", "-q", "-b", "main");
	git(dir, "-c", "user.name=eval", "-c", "user.email=eval@example.com", "add", "-A");
	git(dir, "-c", "user.name=eval", "-c", "user.email=eval@example.com", "commit", "-q", "-m", "fixture");
	if (c.fixture.afterCommit) writeFiles(dir, c.fixture.afterCommit);
	if (c.fixture.staged) git(dir, "add", "--", ...c.fixture.staged);
	return fs.realpathSync(dir);
}

function readPrompt(dir: string, file: string): string {
	try {
		const content = fs.readFileSync(path.join(dir, file), "utf-8");
		if (content.startsWith("---")) {
			const end = content.indexOf("\n---", 3);
			if (end !== -1) return content.slice(end + 4).trim();
		}
		return content.trim();
	} catch {
		return "";
	}
}

function piArgs(c: Case, variantDir: string, workspace: string): { args: string[]; env: Record<string, string>; prompt: string } {
	const extensions = CHILD_EXTENSIONS.filter((p) => fs.existsSync(p)).flatMap((p) => ["-e", p]);
	const base = ["-p", "--mode", "json", "--no-session", "--no-mcp", "--no-extensions", ...extensions, "-e", "builtin:codemode"];
	const env: Record<string, string> = { PI_AGENT_PROMPTS_DIR: variantDir };
	if (c.kind === "main") {
		return { args: [...base, "--model", c.model ?? "anthropic/claude-opus-5-5", "--thinking", "low"], env, prompt: c.prompt };
	}
	const child = c.child!;
	const body = readPrompt(variantDir, child.agentFile);
	const promptFile = `${workspace}.agent.md`;
	fs.writeFileSync(promptFile, interpolatePromptVars(body, workspace, { sessionId: "eval" }));
	env.PI_SUBAGENT_TOOLS = child.tools.join(",");
	if (child.readOnlyBash) env.PI_BASH_READ_ONLY = "1";
	return {
		args: [...base, "--model", child.model, "--thinking", "low", "--tools", child.tools.join(","), "--append-system-prompt", promptFile],
		env,
		prompt: `Task: ${c.prompt}`,
	};
}

interface PiEvent {
	type: string;
	message?: { role: string; content: Array<Record<string, any>>; usage?: Record<string, any>; toolCallId?: string; toolName?: string };
}

function collect(events: PiEvent[]): Pick<RunResult, "toolCalls" | "toolResults" | "finalText" | "usage"> {
	const toolCalls: RunResult["toolCalls"] = [];
	const toolResults: RunResult["toolResults"] = [];
	let finalText = "";
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	const names = new Map<string, string>();
	for (const event of events) {
		if (event.type !== "message_end" || !event.message) continue;
		const { role, content, usage: u } = event.message;
		if (role === "assistant") {
			const text = content.filter((b) => b.type === "text").map((b) => b.text).join("");
			if (text.trim()) finalText = text;
			for (const block of content) {
				if (block.type !== "toolCall") continue;
				names.set(block.id, block.name);
				toolCalls.push({ name: block.name, args: block.arguments ?? {} });
			}
			if (u) {
				usage.input += u.input ?? 0;
				usage.output += u.output ?? 0;
				usage.cacheRead += u.cacheRead ?? 0;
				usage.cacheWrite += u.cacheWrite ?? 0;
				usage.cost += u.cost?.total ?? 0;
			}
		}
		if (role === "toolResult") {
			const text = content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
			const id = event.message.toolCallId ?? "";
			toolResults.push({ name: names.get(id) ?? event.message.toolName ?? "?", text });
		}
	}
	return { toolCalls, toolResults, finalText, usage };
}

const RUN_TIMEOUT_MS = 15 * 60_000;

function runPi(c: Case, variant: { name: string; dir: string }, n: number, root: string, logDir: string): Promise<RunResult> {
	const workspace = makeWorkspace(c, root);
	const { args, env, prompt } = piArgs(c, variant.dir, workspace);
	const log = path.join(logDir, `${c.id}.${variant.name}.${n}.jsonl`);
	const started = Date.now();
	return new Promise((resolve) => {
		const proc = spawn("pi", [...args, prompt], { cwd: workspace, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		proc.stdout.on("data", (d) => (stdout += d));
		proc.stderr.on("data", (d) => (stderr += d));
		const timer = setTimeout(() => proc.kill("SIGKILL"), RUN_TIMEOUT_MS);
		proc.on("close", (code) => {
			clearTimeout(timer);
			fs.writeFileSync(log, stdout);
			const events = stdout.split("\n").filter(Boolean).flatMap((line) => {
				try {
					return [JSON.parse(line) as PiEvent];
				} catch {
					return [];
				}
			});
			resolve({
				caseId: c.id,
				variant: variant.name,
				run: n,
				dir: workspace,
				log,
				exitCode: code ?? -1,
				error: code === 0 ? undefined : stderr.slice(-2000),
				durationMs: Date.now() - started,
				...collect(events),
			});
		});
	});
}

async function pool<T>(jobs: Array<() => Promise<T>>, size: number): Promise<T[]> {
	const results: T[] = new Array(jobs.length);
	let next = 0;
	const worker = async () => {
		while (next < jobs.length) {
			const i = next++;
			results[i] = await jobs[i]!();
		}
	};
	await Promise.all(Array.from({ length: Math.min(size, jobs.length) }, worker));
	return results;
}

type Judged = RunResult & { verdict: { pass: boolean; why: string } };

async function grade(c: Case, result: RunResult): Promise<Judged> {
	const verdict =
		result.exitCode === 0
			? await c.check(result).catch((e: Error) => ({ pass: false, why: `check error: ${e.message}` }))
			: { pass: false, why: `pi exited ${result.exitCode}: ${result.error?.slice(-300)}` };
	const cost = `$${result.usage.cost.toFixed(3)}`;
	console.log(
		`${verdict.pass ? "PASS" : "FAIL"}  ${c.id}  ${result.variant}#${result.run}  ${Math.round(result.durationMs / 1000)}s  ${result.toolCalls.length} calls  ${cost}  ${verdict.why}`,
	);
	return { ...result, verdict };
}

function table(cases: Case[], variants: string[], results: Judged[]): void {
	console.log(`\n${"case".padEnd(26)}${variants.map((v) => v.padEnd(30)).join("")}`);
	for (const c of cases) {
		const cells = variants.map((v) => {
			const mine = results.filter((r) => r.caseId === c.id && r.variant === v);
			const passed = mine.filter((r) => r.verdict.pass).length;
			const calls = mine.reduce((s, r) => s + r.toolCalls.length, 0) / Math.max(1, mine.length);
			const secs = mine.reduce((s, r) => s + r.durationMs, 0) / Math.max(1, mine.length) / 1000;
			return `${passed}/${mine.length} (${calls.toFixed(1)} calls, ${secs.toFixed(0)}s)`.padEnd(30);
		});
		console.log(c.id.padEnd(26) + cells.join(""));
	}
	const cost = results.reduce((s, r) => s + r.usage.cost, 0);
	console.log(`\nmodel cost at list price: $${cost.toFixed(2)}`);
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const cases = CASES.filter((c) => !args.only || args.only.has(c.id));
	if (args.rejudge) {
		const stored: RunResult[] = JSON.parse(fs.readFileSync(args.rejudge, "utf-8"));
		const mine = stored.filter((r) => cases.some((c) => c.id === r.caseId));
		const judged = await pool(mine.map((r) => () => grade(cases.find((c) => c.id === r.caseId)!, r)), 3);
		const out = args.rejudge.replace(/\.json$/, ".rejudged.json");
		fs.writeFileSync(out, JSON.stringify(judged, null, 2));
		table(cases, [...new Set(mine.map((r) => r.variant))], judged);
		console.log(`rejudged: ${out}`);
		return;
	}
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const outDir = path.join(args.out, stamp);
	const root = path.join(outDir, "work");
	const logDir = path.join(outDir, "logs");
	fs.mkdirSync(root, { recursive: true });
	fs.mkdirSync(logDir, { recursive: true });

	const jobs = cases.flatMap((c) =>
		args.variants.flatMap((variant) =>
			Array.from({ length: args.runs }, (_, n) => async () => grade(c, await runPi(c, variant, n + 1, root, logDir))),
		),
	);
	console.log(`${jobs.length} runs: ${cases.length} cases x ${args.variants.length} variants x ${args.runs}; logs in ${logDir}`);
	const results = await pool(jobs, args.concurrency);
	fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
	table(cases, args.variants.map((v) => v.name), results);
	console.log(`results: ${path.join(outDir, "results.json")}`);
}

await main();
