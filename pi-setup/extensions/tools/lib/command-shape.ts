/**
 * The shape of a bash command line, read for bash's guards: its top-level
 * statements, the pipeline stages of each, and which of them run a test,
 * build or install. Text inside quotes, `$( )`, `( )`, `{ }` and heredoc bodies
 * stays inside its stage. It fails open: what it cannot read is left alone.
 */

import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { splitWords } from "./read-only-bash";
import { heredocTags } from "./remote-command";

export interface Statement {
	/** the operator before it: `;`, `&&`, `||`, `&`, or "" for the first */
	joinedBy: string;
	stages: string[];
}

function withoutHeredocBodies(cmd: string): string {
	const lines = cmd.split("\n");
	const kept: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		kept.push(lines[i]!);
		for (const tag of heredocTags(lines[i]!) ?? []) {
			while (i + 1 < lines.length && lines[i + 1]!.trim() !== tag) i++;
			if (i + 1 < lines.length) i++;
		}
	}
	return kept.join("\n");
}

const CLOSER: Record<string, string> = { "(": ")", "{": "}" };

export function statementsOf(cmd: string): Statement[] {
	const text = withoutHeredocBodies(cmd);
	const statements: Statement[] = [];
	let stages: string[] = [];
	let current = "";
	let joinedBy = "";
	let quote: "'" | '"' | null = null;
	let backtick = false;
	const open: string[] = [];

	const endStage = () => {
		stages.push(current.trim());
		current = "";
	};
	/* an empty statement (`cmd &` then a newline) keeps the operator before it */
	const endStatement = (operator: string) => {
		endStage();
		const kept = stages.filter(Boolean);
		stages = [];
		if (kept.length > 0) {
			statements.push({ joinedBy, stages: kept });
			joinedBy = operator;
		} else if (operator !== ";") joinedBy = operator;
	};

	for (let i = 0; i < text.length; i++) {
		const ch = text[i]!;
		const next = text[i + 1];
		const prev = text[i - 1] ?? "";
		if (quote === "'") {
			current += ch;
			if (ch === "'") quote = null;
			continue;
		}
		if (ch === "\\") {
			current += ch + (next ?? "");
			i++;
			continue;
		}
		if (quote === '"') {
			current += ch;
			if (ch === '"') quote = null;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			current += ch;
			continue;
		}
		if (ch === "`") backtick = !backtick;
		if (backtick || ch === "`") {
			current += ch;
			continue;
		}
		if (ch === "#" && (i === 0 || /[\s;&|()]/.test(prev))) {
			while (i + 1 < text.length && text[i + 1] !== "\n") i++;
			continue;
		}
		if (ch === "(" || (ch === "{" && (prev === "$" || next === undefined || /\s/.test(next)))) open.push(ch);
		else if (open.length > 0 && ch === CLOSER[open.at(-1)!]) open.pop();
		if (open.length > 0 || (ch === ")" || ch === "}")) {
			current += ch;
			continue;
		}
		if (ch === "\n" || ch === ";") endStatement(";");
		else if (ch === "&" && next === "&") {
			endStatement("&&");
			i++;
		} else if (ch === "&" && next !== ">" && prev !== ">" && prev !== "<") endStatement("&");
		else if (ch === "|" && next === "|") {
			endStatement("||");
			i++;
		} else if (ch === "|" && prev !== ">") {
			if (next === "&") i++;
			endStage();
		} else current += ch;
	}
	endStatement("");
	return statements;
}

/** the group's inside, when the stage is `( … )` or `{ …; }` */
function groupInside(stage: string): string | undefined {
	const opener = stage[0];
	if (opener !== "(" && opener !== "{") return undefined;
	const close = stage.lastIndexOf(CLOSER[opener]!);
	return close > 0 ? stage.slice(1, close) : undefined;
}

const WRAPPERS = new Set(["time", "nice", "nohup", "command", "exec", "caffeinate", "unbuffer", "xvfb-run", "env", "timeout", "gtimeout", "stdbuf"]);
const FLAG_VALUE = new Set(["-n", "-k", "-s", "--signal", "--kill-after", "-u", "--unset", "-C", "--chdir"]);
const KEYWORDS = new Set(["!", "do", "then", "else", "elif", "if", "while", "until"]);

/** the words of the program a simple command runs, past `VAR=x`, `!`, `do` and wrappers like `timeout 600` */
export function commandWords(stage: string): string[] {
	const words = splitWords(stage);
	let i = 0;
	while (i < words.length) {
		const word = words[i]!;
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || KEYWORDS.has(word)) {
			i++;
			continue;
		}
		if (!WRAPPERS.has(word)) break;
		i++;
		while (i < words.length && words[i]!.startsWith("-")) i += FLAG_VALUE.has(words[i]!) ? 2 : 1;
		if ((word === "timeout" || word === "gtimeout") && i < words.length) i++;
	}
	return words.slice(i);
}

/** the program's name: `./gradlew` is gradlew, `pnpm@11.2` is pnpm */
const base = (word: string | undefined) => path.basename(word ?? "").replace(/(.)@.*$/, "$1");

const RUNNER_PROGRAMS = new Set([
	"pytest", "py.test", "jest", "vitest", "mocha", "ava", "playwright", "cypress", "karma", "rspec", "phpunit",
	"tox", "nox", "ctest", "bats", "make", "gmake", "ninja", "gradle", "gradlew", "mvn", "mvnw", "xcodebuild",
	"tsc", "vue-tsc", "mypy", "pyright", "basedpyright", "eslint", "webpack", "bazel", "bazelisk", "sbt",
]);

const RUNNER_SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
	cargo: new Set(["build", "b", "test", "t", "check", "c", "clippy", "nextest", "bench", "doc", "install"]),
	go: new Set(["build", "test", "vet", "install"]),
	swift: new Set(["build", "test"]),
	flutter: new Set(["test", "build", "analyze", "run"]),
	dart: new Set(["test", "analyze", "compile"]),
	dotnet: new Set(["build", "test", "publish"]),
	docker: new Set(["build", "buildx"]),
	podman: new Set(["build"]),
	deno: new Set(["test", "task", "compile"]),
	bun: new Set(["test", "install", "i", "add", "build"]),
	npm: new Set(["ci", "install", "i", "add", "rebuild"]),
	uv: new Set(["sync", "build"]),
	poetry: new Set(["install", "build"]),
	pip: new Set(["install"]),
	pip3: new Set(["install"]),
	brew: new Set(["install", "upgrade"]),
	gem: new Set(["install"]),
	bundle: new Set(["install"]),
	next: new Set(["build"]),
	vite: new Set(["build"]),
	astro: new Set(["build", "check"]),
	nuxt: new Set(["build"]),
	turbo: new Set(["run", "build", "test", "lint"]),
	nx: new Set(["run", "run-many", "build", "test", "affected"]),
	biome: new Set(["check", "lint", "ci"]),
};

/** `uv run X`, `npx X`: the program that really runs is X */
const RUNS_NEXT: Record<string, ReadonlySet<string> | true> = {
	npx: true,
	bunx: true,
	pnpx: true,
	uvx: true,
	uv: new Set(["run"]),
	poetry: new Set(["run"]),
	pipenv: new Set(["run"]),
	pdm: new Set(["run"]),
	hatch: new Set(["run"]),
	rye: new Set(["run"]),
	pnpm: new Set(["exec", "dlx"]),
	yarn: new Set(["dlx", "exec"]),
	npm: new Set(["exec"]),
	bundle: new Set(["exec"]),
};

/** pnpm and yarn run a package script by bare name; these subcommands are not scripts */
const PACKAGE_MANAGER_INFO = new Set([
	"list", "ls", "why", "info", "view", "outdated", "config", "root", "bin", "whoami", "store", "help", "audit",
	"licenses", "remove", "rm", "link", "unlink", "env", "cache", "init", "create", "version",
]);

const PYTHON_RUNNER_MODULES = new Set(["pytest", "unittest", "mypy", "tox", "build", "pyright"]);

/** flags that make a runner list or describe instead of build or test */
const LISTS_ONLY = new Set([
	"--help", "-h", "--version", "-version", "--collect-only", "--co", "--list", "-list", "--listTests",
	"-showsdks", "-showBuildSettings", "-showdestinations", "--dry-run",
]);
const MAKE_LISTS_ONLY = new Set(["-n", "--just-print", "--recon", "-q", "--question", "-p", "--print-data-base"]);

/** `bun run scripts/x.ts` runs a file, not a package script */
const FILE_LIKE = /\/|\.(?:[cm]?[jt]sx?|py|sh|rb)$/;

/** options whose value is the next word, so it is not read as the subcommand */
const VALUE_FLAGS: Record<string, ReadonlySet<string>> = {
	npx: new Set(["-p", "--package", "-c", "--call"]),
	bunx: new Set(["-p", "--package"]),
	pnpm: new Set(["--filter", "-F", "-C", "--dir", "--reporter", "--loglevel"]),
	yarn: new Set(["--cwd"]),
	npm: new Set(["--prefix", "-w", "--workspace", "--loglevel"]),
	uv: new Set(["--with", "--python", "-p", "--directory", "--project", "--package", "--extra", "--group", "--index"]),
	cargo: new Set(["-p", "--package", "--manifest-path", "--target-dir", "--config", "-Z", "--color"]),
	go: new Set(["-C"]),
	docker: new Set(["-f", "--file", "--context", "-H", "--host"]),
};

function firstOperand(args: readonly string[], program = ""): { index: number; word: string | undefined } {
	const takesValue = VALUE_FLAGS[program];
	let i = 0;
	while (i < args.length && (args[i]!.startsWith("-") || args[i]!.startsWith("+"))) i += takesValue?.has(args[i]!) ? 2 : 1;
	return { index: i, word: args[i] };
}

/** a package script's command; null: package.json has no such script; undefined: no package.json to ask */
export type Scripts = (name: string) => string | null | undefined;

/** the scripts of the package.json npm would use from `cwd`: the nearest one up */
export function packageScripts(cwd: string): Scripts {
	let scripts: Record<string, unknown> | null | undefined;
	const load = (): Record<string, unknown> | null => {
		for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
			const file = path.join(dir, "package.json");
			if (existsSync(file)) {
				try {
					const found = JSON.parse(readFileSync(file, "utf8")).scripts;
					return found && typeof found === "object" ? found : {};
				} catch {
					return null;
				}
			}
			if (path.dirname(dir) === dir) return null;
		}
	};
	return (name) => {
		scripts ??= load();
		if (scripts === null) return undefined;
		const script = scripts[name];
		return typeof script === "string" ? script : null;
	};
}

const PACKAGE_MANAGERS = new Set(["npm", "bun", "pnpm", "yarn"]);
const INSTALLS = new Set(["install", "i", "add", "ci", "update", "up", "upgrade", "rebuild", "dedupe", "prune", "fetch", "import"]);
const NPM_SCRIPT_ALIASES: Record<string, string> = { test: "test", t: "test", tst: "test", start: "start" };
/** these run a script in another package, whose package.json is not the one at hand */
const ELSEWHERE = new Set(["--filter", "-F", "-r", "--recursive", "-C", "--dir", "--prefix", "-w", "--workspace", "--workspaces", "-ws", "--cwd"]);
const ELSEWHERE_SUBCOMMANDS = new Set(["workspace", "workspaces", "recursive"]);
const MAX_SCRIPT_DEPTH = 3;

/** a script runs a runner when a command in it does; unknown counts as one, a missing one is `missing()` */
function scriptRuns(name: string, scripts: Scripts | undefined, depth: number, missing: () => boolean): boolean {
	const text = depth < MAX_SCRIPT_DEPTH ? scripts?.(name) : undefined;
	if (text === undefined) return true;
	if (text === null) return missing();
	return statementsOf(text).some((statement) => statement.stages.some((stage) => runnerIn(stage, scripts, depth + 1) !== undefined));
}

/** does this simple command run a test suite, a build, a type check, a linter or an install */
export function isRunner(words: readonly string[], scripts?: Scripts, depth = 0): boolean {
	const name = base(words[0]);
	const args = words.slice(1);
	if (args.some((arg) => LISTS_ONLY.has(arg)) || ((name === "make" || name === "gmake") && args.some((arg) => MAKE_LISTS_ONLY.has(arg)))) return false;
	const operand = firstOperand(args, name);
	const sub = operand.word;
	if (name === "dotenv") {
		const dashes = args.indexOf("--");
		return dashes >= 0 && isRunner(args.slice(dashes + 1), scripts, depth);
	}
	const next = RUNS_NEXT[name];
	if (next === true || (next && sub && next.has(sub))) {
		const rest = next === true ? args.slice(operand.index) : args.slice(operand.index + 1);
		return isRunner(rest.slice(firstOperand(rest, name).index), scripts, depth);
	}
	if (RUNNER_PROGRAMS.has(name)) return true;
	if (name === "python" || name === "python3" || /^python3\.\d+$/.test(name)) {
		const m = args.indexOf("-m");
		const module = m >= 0 ? args[m + 1] : undefined;
		return !!module && (PYTHON_RUNNER_MODULES.has(module) || (module === "pip" && args[m + 2] === "install"));
	}
	if (name === "node") return args.includes("--test");
	if (name === "docker" && sub === "compose") return args.includes("build") || args.includes("up");
	if (name === "uv" && sub === "pip") return args[operand.index + 1] === "install";
	if (PACKAGE_MANAGERS.has(name) && sub !== undefined) {
		const known = ELSEWHERE_SUBCOMMANDS.has(sub) || args.some((arg) => ELSEWHERE.has(arg.split("=")[0]!)) ? undefined : scripts;
		if (sub === "run" || sub === "run-script") {
			const rest = args.slice(operand.index + 1);
			const script = firstOperand(rest);
			/* bun and yarn run a binary when no script has the name; npm and pnpm fail */
			const bin = () => (name === "bun" || name === "yarn") && isRunner(rest.slice(script.index), known, depth + 1);
			return !!script.word && !FILE_LIKE.test(script.word) && scriptRuns(script.word, known, depth, bin);
		}
		if (name === "npm" && NPM_SCRIPT_ALIASES[sub]) return scriptRuns(NPM_SCRIPT_ALIASES[sub]!, known, depth, () => false);
		if ((name === "pnpm" || name === "yarn") && !PACKAGE_MANAGER_INFO.has(sub) && !INSTALLS.has(sub)) {
			return !FILE_LIKE.test(sub) && scriptRuns(sub, known, depth, () => isRunner(args.slice(operand.index), known, depth + 1));
		}
	}
	if (name === "pnpm" || name === "yarn") return sub === undefined ? name === "yarn" : INSTALLS.has(sub);
	return !!sub && !!RUNNER_SUBCOMMANDS[name]?.has(sub);
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash"]);

/** the script a stage runs as a whole: a `( … )` or `{ …; }` group, or `bash -c '…'` */
function innerScript(stage: string): string | undefined {
	const inside = groupInside(stage);
	if (inside !== undefined) return inside;
	const words = commandWords(stage);
	if (!SHELLS.has(base(words[0]))) return undefined;
	const flag = words.findIndex((word, i) => i > 0 && /^-[a-z]*c[a-z]*$/.test(word));
	return flag > 0 ? words[flag + 1] : undefined;
}

/** the words of every simple command the line runs, those inside a group or `bash -c` included */
export function simpleCommands(cmd: string): string[][] {
	const found: string[][] = [];
	for (const statement of statementsOf(cmd)) {
		for (const stage of statement.stages) {
			const inside = innerScript(stage);
			if (inside !== undefined) found.push(...simpleCommands(inside));
			else found.push(commandWords(stage));
		}
	}
	return found;
}

/** the runner a stage starts, one inside a group or `bash -c` included */
function runnerIn(stage: string, scripts?: Scripts, depth = 0): string[] | undefined {
	const inside = innerScript(stage);
	if (inside !== undefined) {
		for (const statement of statementsOf(inside)) {
			for (const inner of statement.stages) {
				const found = runnerIn(inner, scripts, depth);
				if (found) return found;
			}
		}
		return undefined;
	}
	const words = commandWords(stage);
	return isRunner(words, scripts, depth) ? words : undefined;
}

/** consumers that pass each line on as it arrives; every other one holds output back */
function streams(words: readonly string[]): boolean {
	const name = base(words[0]);
	if (["tee", "cat", "xcpretty", "xcbeautify", "ts"].includes(name)) return true;
	if (["grep", "egrep", "fgrep", "rg"].includes(name)) return words.includes("--line-buffered");
	if (name === "sed") return words.includes("-u") || words.includes("--unbuffered");
	return false;
}

const PIPEFAIL = /\bset\s+(?:-[A-Za-z]+\s+)*-[A-Za-z]*o\s+pipefail\b/;

/** the file a stage sends its stdout to, if any (`/dev/null` and fd copies are not files) */
function stdoutFile(group: string): string | undefined {
	const stage = groupInside(group) === undefined ? group : group.slice(group.lastIndexOf(CLOSER[group[0]!]!) + 1);
	let quote: "'" | '"' | null = null;
	let depth = 0;
	for (let i = 0; i < stage.length; i++) {
		const ch = stage[i]!;
		if (quote) {
			if (ch === "\\" && quote === '"') i++;
			else if (ch === quote) quote = null;
			continue;
		}
		if (ch === "\\") {
			i++;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (ch === "(") depth++;
		else if (ch === ")") depth = Math.max(0, depth - 1);
		if (ch !== ">" || depth > 0) continue;
		const before = stage.slice(0, i).match(/(\d*|&)$/)![1];
		if (before !== "" && before !== "1" && before !== "&") continue;
		let j = i + 1;
		if (stage[j] === ">" || stage[j] === "|") j++;
		if (stage[j] === "&") {
			if (/^&(\d+|-)(\s|$)/.test(stage.slice(j))) continue;
			j++;
		}
		while (stage[j] === " " || stage[j] === "\t") j++;
		const target = stage.slice(j).match(/^[^\s;|&)]+/)?.[0]?.replace(/^["']|["']$/g, "");
		// `> >(tee log)` is a process substitution: it streams, and the exit code stays the command's
		if (target && target !== "/dev/null" && !/^>?\(/.test(target)) return target;
	}
	return undefined;
}

const label = (words: readonly string[]) => words.slice(0, 3).join(" ");

function pipeVerdict(statement: Statement, pipefail: boolean, scripts?: Scripts): string | undefined {
	const { stages } = statement;
	for (let r = 0; r < stages.length; r++) {
		const inside = innerScript(stages[r]!);
		const within = inside === undefined ? undefined : shapeRefusalOf(statementsOf(inside), pipefail || PIPEFAIL.test(inside), scripts);
		if (within) return within;
		const runner = runnerIn(stages[r]!, scripts);
		if (!runner) continue;
		const file = r === stages.length - 1 ? stdoutFile(stages[r]!) : undefined;
		if (file) {
			return (
				`Refused before running: \`${label(runner)}\` sends its output to \`${file}\`, so neither you nor the user ` +
				"can see its progress or its failures until it ends. Run it without the redirect: this tool already keeps " +
				"the full output in a file and gives you its path."
			);
		}
		const downstream = stages.slice(r + 1).map((stage) => commandWords(stage));
		if (downstream.length === 0) continue;
		const holder = downstream.find((words) => !streams(words));
		if (holder) {
			const consumer = base(holder[0]);
			const stops = consumer === "head" ? ", stops the command once it has its lines," : "";
			return (
				`Refused before running: \`${label(runner)}\` is piped into \`${consumer}\`, which holds its output back until ` +
				`it ends${stops} and replaces its exit code with \`${consumer}\`'s, so a failure can read as success. Run it ` +
				"without the pipe: this tool already shows the first and last 50 lines and keeps the full output in a file, " +
				"which you can read or grep afterwards for the part you need."
			);
		}
		if (!pipefail) {
			const consumer = base(downstream[0]![0]);
			return (
				`Refused before running: \`${label(runner)}\` is piped into \`${consumer}\` without \`set -o pipefail\`, so the ` +
				`result would carry \`${consumer}\`'s exit code and a failure would read as success. Drop the pipe (this tool ` +
				"already keeps the full output in a file), or start the command with `set -o pipefail; `."
			);
		}
		return undefined;
	}
	return undefined;
}

function shapeRefusalOf(statements: Statement[], pipefail: boolean, scripts?: Scripts): string | undefined {
	for (const statement of statements) {
		const found = pipeVerdict(statement, pipefail, scripts);
		if (found) return found;
	}
	return undefined;
}

/** why a test, build or install would run blind: piped into a consumer that holds its output, or redirected to a file */
export function blindingRefusal(cmd: string, cwd?: string): string | undefined {
	/* after a `cd` the nearest package.json is another one: its scripts are unknown, which counts as a run */
	const movesDir = /(^|[;&|(\n]\s*)cd\s/.test(cmd);
	return shapeRefusalOf(statementsOf(cmd), PIPEFAIL.test(cmd), cwd === undefined || movesDir ? undefined : packageScripts(cwd));
}

export const SLEEP_LIMIT_SEC = 30;
const UNIT_SEC: Record<string, number> = { "": 1, s: 1, m: 60, h: 3600, d: 86400 };

function sleepSeconds(statement: Statement | undefined): number {
	const words = statement?.stages.length === 1 ? splitWords(statement.stages[0]!) : [];
	if (base(words[0]) !== "sleep" || words.length < 2) return 0;
	let seconds = 0;
	for (const arg of words.slice(1)) {
		const match = arg.match(/^(\d+(?:\.\d*)?|\.\d+)([smhd]?)$/);
		if (!match) return 0;
		seconds += Number(match[1]) * UNIT_SEC[match[2]!]!;
	}
	return seconds;
}

/**
 * the top-level statement that is a long bare `sleep`. One inside a `do … done`
 * or `then … fi` body is polling for a condition, and one sent off with `&`
 * waits for nothing: both are allowed.
 */
function bareSleep(statements: Statement[]): Statement | undefined {
	let nesting = 0;
	for (const [i, statement] of statements.entries()) {
		const first = splitWords(statement.stages[0] ?? "")[0];
		const sentOff = statements[i + 1]?.joinedBy === "&";
		if (first === "do" || first === "then") nesting++;
		else if ((first === "done" || first === "fi") && nesting > 0) nesting--;
		else if (nesting === 0 && !sentOff && sleepSeconds(statement) >= SLEEP_LIMIT_SEC) return statement;
	}
	return undefined;
}

/** a long `sleep` that only waits, and blocks the agent while it does */
export function sleepRefusal(cmd: string): string | undefined {
	const found = bareSleep(statementsOf(cmd));
	if (!found) return undefined;
	const words = splitWords(found.stages[0]!);
	return (
		`Refused before running: \`${words.join(" ")}\` only waits, and blocks you for the whole time while showing nothing. ` +
		"Run a long command directly instead of with `&` and a sleep: once it has run a minute it moves to the background " +
		"by itself, and its result reaches you when it ends. To wait for something else to happen, run the command that " +
		"waits for it, such as `gh run watch <id> --exit-status` or `until curl -sf localhost:3000; do sleep 2; done`. To " +
		"wait for a background job, keep working or end your turn: its result arrives by itself."
	);
}

const FAILURE_SHAPE =
	/^(?:FAILED\s|FAIL\s|--- FAIL: |ERROR:? |error(?:\[E\d+\])?: |\(fail\) |npm ERR! |\*\* (?:BUILD|TEST) FAILED \*\*|Traceback \(most recent call last\)|FAILURE: )|\b[1-9]\d* (?:failed|failing|errors?)\b|\bpanicked at\b|\btest result: FAILED\b|\bERR_PNPM_[A-Z_]+|\berror TS\d+:/m;

/**
 * a note for a zero exit that probably is not a success. The exit code covers
 * only the final `&&` chain, and within it a pipe gives its last stage's: so a
 * failure before that chain, or before such a pipe, does not show in it.
 */
export function maskedExitNote(cmd: string, output: string): string | undefined {
	if (PIPEFAIL.test(cmd)) return undefined;
	const statements = statementsOf(cmd);
	let start = statements.length - 1;
	while (start > 0 && statements[start]!.joinedBy === "&&") start--;
	const chain = statements.slice(start);
	const piped = chain.find((statement) => statement.stages.length > 1);
	if (!piped && start <= 0) return undefined;
	const failure = output.match(FAILURE_SHAPE)?.[0]?.trim();
	if (!failure) return undefined;
	const part = piped ? piped.stages.at(-1)! : chain.map((statement) => statement.stages.join(" | ")).join(" && ");
	const shown = part.length > 60 ? `${part.slice(0, 57)}...` : part;
	return `exit code 0 is the exit code of \`${shown}\`, not of what ran before it; the output above shows a failure ("${failure}").`;
}
