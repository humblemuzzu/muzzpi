#!/usr/bin/env node
// Runs pi-codex-goal's own test suite against our vendored copy (extensions/goal),
// so a merge from upstream is checked by upstream's tests, before and after.
//
//   node pi-setup/port-harness/goal-upstream-tests.mjs <pi-codex-goal clone> <ref> [goal dir]
//
// Our copy keeps the <pi_goal_continuation> envelope and its own provider-context
// handling, so some upstream tests fail on purpose; compare the failure list of the
// old and the new code (git archive the old goal dir into a folder and pass it as
// [goal dir]), never the bare count.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [clone, ref, goalArg] = process.argv.slice(2);
if (!clone || !ref) {
	console.error("usage: goal-upstream-tests.mjs <pi-codex-goal clone> <ref> [goal dir]");
	process.exit(2);
}
const here = dirname(fileURLToPath(import.meta.url));
const goalDir = resolve(goalArg ?? join(here, "..", "extensions", "goal"));
const piIndex = join(here, "..", "extensions", "tools", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js");
const out = mkdtempSync(join(tmpdir(), "goal-upstream-"));

const git = (...args) => spawnSync("git", ["-C", clone, ...args], { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 }).stdout;
const files = git("ls-tree", "-r", "--name-only", ref, "test/").split("\n").filter((f) => f.endsWith(".ts"));
if (files.length === 0) {
	console.error(`no test/*.ts at ${ref} in ${clone}`);
	process.exit(2);
}

// pi 1.5.0 sends turn_end and agent_before_settle with `entries` and `context`; upstream's synthetic events do not.
const BOUNDARY_FILL =
	'    if (event === "turn_end" || event === "agent_before_settle") {\n' +
	'      payload = { entries: [], continue: false, context: { contextEntries: [], contextMessages: [], llmMessages: [], pendingMessages: [], canContinue: false }, ...payload };\n' +
	"    }\n";
const CARRIER_SHIM = `
function toQueuedGoalContextCarrier(message: any): any {
  if (typeof message?.timestamp !== "number") return null;
  const carrier: any = { role: message.role, timestamp: message.timestamp };
  for (const key of ["customType", "content", "display", "details"]) if (message[key] !== undefined) carrier[key] = message[key];
  return carrier;
}
`;
const ourMessages = readFileSync(join(goalDir, "src", "queued-goal-messages.ts"), "utf-8");

for (const file of files) {
	let text = git("show", `${ref}:${file}`)
		.replace(/"(\.\.\/)+src\/index\.ts"/g, JSON.stringify(join(goalDir, "index.ts")))
		.replace(/"(\.\.\/)+src\//g, `"${goalDir}/src/`);
	if (file.endsWith("support/runtime-harness.ts")) {
		text = text.replace(/( {2}async function emit\(event: string, payload: object\)[^\n]*\n)/, `$1${BOUNDARY_FILL}`);
		if (text.includes("toQueuedGoalContextCarrier,") && !ourMessages.includes("export function toQueuedGoalContextCarrier")) {
			text = text.replace("  toQueuedGoalContextCarrier,\n", "").replace("  type QueuedGoalContextCarrier,\n", "");
			text = text.replace("type EventHandler", `type QueuedGoalContextCarrier = any;\n${CARRIER_SHIM}\ntype EventHandler`);
		}
	}
	mkdirSync(dirname(join(out, file)), { recursive: true });
	writeFileSync(join(out, file), text);
}
writeFileSync(join(out, "package.json"), '{"type":"module"}\n');
writeFileSync(
	join(out, "hooks.mjs"),
	`import { registerHooks } from "node:module";
const fromPi = ${JSON.stringify(pathToFileURL(piIndex).href)};
registerHooks({
	resolve(specifier, context, next) {
		const name = specifier.replace(/^@mariozechner\\//, "@earendil-works/");
		if (!/^[./]|^node:|^file:/.test(name)) {
			try { return next(name, context); } catch { return next(name, { ...context, parentURL: fromPi }); }
		}
		try { return next(name, context); } catch (error) {
			for (const suffix of [".ts", "/index.ts", ".js"]) { try { return next(name + suffix, context); } catch {} }
			throw error;
		}
	},
});
`,
);

const tests = files.filter((f) => f.endsWith(".test.ts"));
const run = spawnSync(
	process.execPath,
	["--experimental-transform-types", "--no-warnings", "--import", join(out, "hooks.mjs"), "--test", "--test-reporter=spec", ...tests],
	{ cwd: out, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 },
);
const lines = (run.stdout + run.stderr).split("\n");
const failed = [...new Set(lines.filter((l) => /^\s*✖ /.test(l) && !/✖ test\/|failing tests/.test(l)).map((l) => l.trim().replace(/ \([\d.]+ms\)$/, "")))].sort();
const summary = lines.filter((l) => /^ℹ (tests|pass|fail) /.test(l)).join("  ");
console.log(`${summary}\nsuite: ${ref} against ${goalDir}\n${failed.join("\n")}`);
