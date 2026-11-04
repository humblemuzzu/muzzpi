/**
 * review_code eval: the real reviewer child (piSpawn, its tools, its follow-up),
 * old prompt files against new, on the fixtures in ./cases.ts. Runs spend real tokens.
 *
 *   bun pi-setup/port-harness/review-eval/run.ts \
 *     --variant base=/tmp/review-eval-base --legacy base \
 *     --variant new=pi-setup/agents [--runs 2] [--case id,id] [--level deep] [--concurrency 6]
 *   bun pi-setup/port-harness/review-eval/run.ts --rescore <results.json>
 *
 * `--legacy <name>` builds that variant's task the way review_code did before
 * the round and level changes: no level line, and no follow-up on a continued review.
 */

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { codeReviewAllowlist, parseReviewMarkdown, reviewSpawnParts, type ReviewFinding } from "../../extensions/tools/code-review";
import { newSessionId, piSpawn } from "../../extensions/tools/lib/pi-spawn";
import { getFinalOutput } from "../../extensions/tools/lib/sub-agent-render";
import { CASES, type Issue, type ReviewCase } from "./cases";

const MODEL = "anthropic/claude-sonnet-5-5";
const THINKING = "high";
const JUDGE_MODEL = "anthropic/claude-sonnet-5-5";
const ANTHROPIC_SUB = path.join(os.homedir(), ".pi", "agent", "extensions", "anthropic-sub.js");

interface Variant {
	name: string;
	dir: string;
	legacy: boolean;
}

interface Args {
	variants: Variant[];
	runs: number;
	only?: Set<string>;
	level?: string;
	concurrency: number;
	out: string;
	rescore?: string;
}

interface Round {
	report: string;
	ms: number;
	cost: number;
	tools: number;
	error?: string;
}

interface Result {
	caseId: string;
	variant: string;
	run: number;
	level?: string;
	rounds: Round[];
}

function parseArgs(argv: string[]): Args {
	const args: Args = { variants: [], runs: 2, concurrency: 6, out: path.join(os.tmpdir(), "review-eval") };
	const legacy = new Set<string>();
	for (let i = 0; i < argv.length; i++) {
		const [flag, value] = [argv[i], argv[i + 1]];
		if (value === undefined) continue;
		if (flag === "--variant") {
			const [name, dir] = value.split("=");
			args.variants.push({ name: name!, dir: path.resolve(dir!), legacy: false });
		} else if (flag === "--legacy") legacy.add(value);
		else if (flag === "--runs") args.runs = Number(value);
		else if (flag === "--case") args.only = new Set(value.split(","));
		else if (flag === "--level") args.level = value;
		else if (flag === "--concurrency") args.concurrency = Number(value);
		else if (flag === "--out") args.out = path.resolve(value);
		else if (flag === "--rescore") args.rescore = path.resolve(value);
		else continue;
		i++;
	}
	for (const v of args.variants) v.legacy = legacy.has(v.name);
	if (args.variants.length === 0 && !args.rescore) throw new Error("give --variant name=dir at least once, or --rescore results.json");
	return args;
}

function git(dir: string, ...gitArgs: string[]): void {
	const r = spawnSync("git", ["-c", "user.name=eval", "-c", "user.email=eval@example.com", ...gitArgs], { cwd: dir, encoding: "utf-8" });
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
	}
}

function makeWorkspace(c: ReviewCase, root: string): string {
	const dir = fs.mkdtempSync(path.join(root, `${c.id}-`));
	writeFiles(dir, c.fixture.files);
	git(dir, "init", "-q", "-b", "main");
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", "base");
	writeFiles(dir, c.fixture.change);
	return fs.realpathSync(dir);
}

function readPrompt(dir: string, file: string): string {
	const content = fs.readFileSync(path.join(dir, file), "utf-8");
	if (content.startsWith("---")) {
		const end = content.indexOf("\n---", 3);
		if (end !== -1) return content.slice(end + 4).trim();
	}
	return content.trim();
}

function spawnParts(variant: Variant, scope: string, resuming: boolean, level: string | undefined) {
	const report = readPrompt(variant.dir, "prompt.amp.code-review-report.md");
	if (variant.legacy) return { task: `Review the following diff:\n${scope}`, followUp: resuming ? undefined : report };
	return reviewSpawnParts({ diffDescription: scope, level }, report, resuming);
}

async function review(variant: Variant, cwd: string, scope: string, session: { id: string; dir: string }, resuming: boolean, level?: string): Promise<Round> {
	const started = Date.now();
	const tools = codeReviewAllowlist();
	const result = await piSpawn({
		cwd,
		...spawnParts(variant, scope, resuming, level),
		model: MODEL,
		thinkingLevel: THINKING,
		builtinTools: tools,
		extensionTools: tools,
		systemPromptBody: readPrompt(variant.dir, "prompt.amp.code-review-system.md"),
		session,
	});
	const toolCalls = result.messages.flatMap((m: any) => (m.role === "assistant" ? m.content.filter((b: any) => b.type === "toolCall") : []));
	return {
		report: getFinalOutput(result.messages),
		ms: Date.now() - started,
		cost: result.usage.cost,
		tools: toolCalls.length,
		error: result.exitCode === 0 && result.stopReason !== "error" ? undefined : (result.errorMessage ?? result.stderr.slice(-500)),
	};
}

async function runCase(c: ReviewCase, variant: Variant, n: number, root: string, sessions: string, level?: string): Promise<Result> {
	const cwd = makeWorkspace(c, root);
	const session = { id: newSessionId("review_code"), dir: sessions };
	const rounds = [await review(variant, cwd, c.scope, session, false, level)];
	if (c.round2) {
		writeFiles(cwd, c.round2.change);
		// before the change, a re-review was a fresh review: 3 of 687 past calls continued one
		const again = variant.legacy ? { id: newSessionId("review_code"), dir: sessions } : session;
		rounds.push(await review(variant, cwd, c.round2.scope, again, !variant.legacy, level));
	}
	console.log(`done  ${c.id}  ${variant.name}#${n}  ${rounds.map((r) => `${Math.round(r.ms / 1000)}s $${r.cost.toFixed(2)}${r.error ? " ERROR" : ""}`).join(" → ")}`);
	return { caseId: c.id, variant: variant.name, run: n, level, rounds };
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

// --- scoring ---

type Bucket = "blocking" | "minor" | "pre" | "info";

/** what the report asks of the author: blocking = must fix before landing, minor = optional, pre = not this change's */
function bucket(f: ReviewFinding): Bucket {
	if (f.severity === "pre-existing") return "pre";
	if (f.commentType === "compliment" || f.commentType === "non_actionable") return "info";
	return ["critical", "high", "medium"].includes(f.severity) ? "blocking" : "minor";
}

function judgeOnce(prompt: string): Promise<string> {
	const args = [
		"-p", "--no-session", "--no-mcp", "--no-skills", "--no-tools", "--no-extensions", "-e", ANTHROPIC_SUB,
		"--model", JUDGE_MODEL, "--thinking", "low",
		"--system-prompt", "You match code review findings to a list of known issues. Reply with one JSON object and nothing else.",
		prompt,
	];
	return new Promise((resolve) => {
		const proc = spawn("pi", args, { cwd: os.tmpdir(), stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		proc.stdout.on("data", (d) => (out += d));
		proc.on("close", () => resolve(out));
	});
}

/** finding number → issue id or "other" */
async function matchFindings(findings: ReviewFinding[], issues: Issue[]): Promise<Record<string, string>> {
	if (findings.length === 0) return {};
	const prompt = [
		"Known issues:",
		...issues.map((i) => `- ${i.id}: ${i.describe}`),
		"",
		"Findings from a code review:",
		...findings.map((f, i) => `#${i + 1} [${f.filename}:${f.startLine}-${f.endLine}] ${f.title} — ${f.text} ${f.why}`),
		"",
		`For each finding, give the id of the known issue it is about, or "other" when it is about none of them. A finding about the same root problem counts even when worded differently. Reply like {"1": "some-id", "2": "other"}.`,
	].join("\n");
	for (let attempt = 0; attempt < 4; attempt++) {
		const out = await judgeOnce(prompt);
		const json = out.match(/\{[\s\S]*\}/)?.[0];
		try {
			if (json) return JSON.parse(json);
		} catch {}
		await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
	}
	throw new Error("judge gave no JSON after 4 tries");
}

interface RoundScore {
	found: string[];
	missed: string[];
	wronglyBlocking: string[];
	notSilent: string[];
	instancesMissing: string[];
	extraBlocking: number;
	extraMinor: number;
	actionable: number;
	repeatedFixed: number;
	others: string[];
}

async function scoreRound(report: string, bugs: Issue[], notBlocking: Issue[], silent: Issue[], fixed: Issue[], instances?: ReviewCase["instances"]): Promise<RoundScore> {
	const findings = parseReviewMarkdown(report);
	const issues = [...bugs, ...notBlocking, ...silent, ...fixed];
	const map = await matchFindings(findings, issues);
	const about = (id: string) => findings.filter((_, i) => map[String(i + 1)] === id);
	const found = bugs.filter((b) => about(b.id).some((f) => bucket(f) === "blocking")).map((b) => b.id);
	const others = findings.filter((_, i) => (map[String(i + 1)] ?? "other") === "other");
	const instanceText = instances ? about(instances.bug).map((f) => `${f.title} ${f.text} ${f.why} ${f.fix} ${f.instances}`).join(" ") : "";
	return {
		found,
		missed: bugs.filter((b) => !found.includes(b.id)).map((b) => b.id),
		wronglyBlocking: notBlocking.filter((x) => about(x.id).some((f) => bucket(f) === "blocking")).map((x) => x.id),
		notSilent: silent.filter((x) => about(x.id).length > 0).map((x) => x.id),
		instancesMissing: instances ? instances.names.filter((n) => !instanceText.includes(n)) : [],
		extraBlocking: others.filter((f) => bucket(f) === "blocking").length,
		extraMinor: others.filter((f) => bucket(f) === "minor").length,
		actionable: findings.filter((f) => bucket(f) === "blocking" || bucket(f) === "minor").length,
		repeatedFixed: fixed.reduce((n, x) => n + about(x.id).filter((f) => bucket(f) !== "info").length, 0),
		others: others.map((f) => `${f.severity} · ${f.title}`),
	};
}

async function score(results: Result[]): Promise<Array<Result & { scores: RoundScore[] }>> {
	return pool(
		results.map((r) => async () => {
			const c = CASES.find((x) => x.id === r.caseId)!;
			const scores = [await scoreRound(r.rounds[0]!.report, c.bugs, c.notBlocking, c.silent ?? [], [], c.instances)];
			if (c.round2 && r.rounds[1]) {
				scores.push(await scoreRound(r.rounds[1].report, c.round2.bugs, [...c.notBlocking, ...c.bugs.filter((b) => !c.round2!.fixed.some((f) => f.id === b.id))], c.silent ?? [], c.round2.fixed));
			}
			return { ...r, scores };
		}),
		4,
	);
}

function summarize(scored: Array<Result & { scores: RoundScore[] }>): void {
	const variants = [...new Set(scored.map((r) => r.variant))];
	const cases = [...new Set(scored.map((r) => r.caseId))];
	const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
	console.log("\nper case (each cell: found/planted bugs, wrongly blocking, extra blocking, extra minor, actionable total; averaged over runs)");
	for (const id of cases) {
		for (const v of variants) {
			const mine = scored.filter((r) => r.caseId === id && r.variant === v);
			const rounds = mine[0]?.scores.length ?? 0;
			for (let k = 0; k < rounds; k++) {
				const s = mine.map((r) => r.scores[k]!);
				const avg = (f: (x: RoundScore) => number) => (sum(s.map(f)) / s.length).toFixed(1);
				const planted = s[0]!.found.length + s[0]!.missed.length;
				console.log(
					`${(k ? `${id} r2` : id).padEnd(26)} ${v.padEnd(6)} bugs ${sum(s.map((x) => x.found.length))}/${planted * s.length}  wrong-blocking ${sum(s.map((x) => x.wronglyBlocking.length))}  extra-blocking ${avg((x) => x.extraBlocking)}  extra-minor ${avg((x) => x.extraMinor)}  actionable ${avg((x) => x.actionable)}${s.some((x) => x.notSilent.length) ? `  NOT-SILENT ${sum(s.map((x) => x.notSilent.length))}` : ""}${s.some((x) => x.instancesMissing.length) ? `  instances-missing ${sum(s.map((x) => x.instancesMissing.length))}` : ""}${k ? `  repeated-fixed ${sum(s.map((x) => x.repeatedFixed))}` : ""}`,
				);
			}
		}
	}
	console.log("\ntotals");
	for (const v of variants) {
		const mine = scored.filter((r) => r.variant === v);
		const all = mine.flatMap((r) => r.scores);
		const rounds = mine.flatMap((r) => r.rounds);
		console.log(
			`${v.padEnd(6)} bugs found ${sum(all.map((s) => s.found.length))}/${sum(all.map((s) => s.found.length + s.missed.length))}` +
				`  wrongly blocking ${sum(all.map((s) => s.wronglyBlocking.length))}  extra blocking ${sum(all.map((s) => s.extraBlocking))}` +
				`  extra minor ${sum(all.map((s) => s.extraMinor))}  actionable ${sum(all.map((s) => s.actionable))}  not silent ${sum(all.map((s) => s.notSilent.length))}` +
				`  instances missing ${sum(all.map((s) => s.instancesMissing.length))}  repeated fixed ${sum(all.map((s) => s.repeatedFixed))}` +
				`  errors ${rounds.filter((r) => r.error).length}  cost $${sum(rounds.map((r) => r.cost)).toFixed(2)}  avg ${Math.round(sum(rounds.map((r) => r.ms)) / rounds.length / 1000)}s`,
		);
	}
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.rescore) {
		const results: Result[] = JSON.parse(fs.readFileSync(args.rescore, "utf-8"));
		const scored = await score(results.filter((r) => !args.only || args.only.has(r.caseId)));
		fs.writeFileSync(args.rescore.replace(/\.json$/, ".scored.json"), JSON.stringify(scored, null, 2));
		summarize(scored);
		return;
	}
	const outDir = path.join(args.out, new Date().toISOString().replace(/[:.]/g, "-"));
	const root = path.join(outDir, "work");
	const sessions = path.join(outDir, "sessions");
	fs.mkdirSync(root, { recursive: true });
	fs.mkdirSync(sessions, { recursive: true });
	const cases = CASES.filter((c) => !args.only || args.only.has(c.id));
	const jobs = cases.flatMap((c) =>
		args.variants.flatMap((v) => Array.from({ length: args.runs }, (_, n) => () => runCase(c, v, n + 1, root, sessions, args.level))),
	);
	console.log(`${jobs.length} runs: ${cases.length} cases x ${args.variants.length} variants x ${args.runs}; out ${outDir}`);
	const results = await pool(jobs, args.concurrency);
	const file = path.join(outDir, "results.json");
	fs.writeFileSync(file, JSON.stringify(results, null, 2));
	const scored = await score(results);
	fs.writeFileSync(file.replace(/\.json$/, ".scored.json"), JSON.stringify(scored, null, 2));
	summarize(scored);
	console.log(`\nresults: ${file}`);
}

await main();
