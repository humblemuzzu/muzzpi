/**
 * The commands here are real: each refused one was run by an agent in a pi
 * session and hid its output or its exit code (92 long test and build runs
 * reported exit 0 while their output showed failures, all behind such a pipe).
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blindingRefusal, isRunner, maskedExitNote, sleepRefusal, statementsOf } from "./command-shape";

describe("statementsOf: the top level of a command line", () => {
	test("splits statements on ; && || & and newlines, and stages on |", () => {
		expect(statementsOf("cd x && npm test 2>&1 | tail -5; echo done")).toEqual([
			{ joinedBy: "", stages: ["cd x"] },
			{ joinedBy: "&&", stages: ["npm test 2>&1", "tail -5"] },
			{ joinedBy: ";", stages: ["echo done"] },
		]);
		expect(statementsOf("a || b\nc & d").map((s) => s.joinedBy)).toEqual(["", "||", ";", "&"]);
	});

	test("quotes, $( ), groups and heredoc bodies stay inside their stage", () => {
		expect(statementsOf(`echo "a | b; c" | wc -l`)[0]!.stages).toEqual([`echo "a | b; c"`, "wc -l"]);
		expect(statementsOf("x=$(pytest | tail -1); echo $x")[0]!.stages).toEqual(["x=$(pytest | tail -1)"]);
		expect(statementsOf("(cd a && make) 2>&1 | tail")[0]!.stages).toEqual(["(cd a && make) 2>&1", "tail"]);
		expect(statementsOf("cat > notes.md <<'EOF'\npytest | tail -3\nEOF\necho ok").map((s) => s.stages)).toEqual([["cat > notes.md <<'EOF'"], ["echo ok"]]);
	});

	test("an empty statement keeps the operator before it", () => {
		expect(statementsOf("sleep 60 &\nwait").map((s) => s.joinedBy)).toEqual(["", "&"]);
		expect(statementsOf("make &&\n  make test").map((s) => s.joinedBy)).toEqual(["", "&&"]);
	});

	test("redirections that contain & or | are not separators", () => {
		expect(statementsOf("make &> log")[0]!.stages).toEqual(["make &> log"]);
		expect(statementsOf("make 2>&1 >| log")[0]!.stages).toEqual(["make 2>&1 >| log"]);
		expect(statementsOf("make |& tee log")[0]!.stages).toEqual(["make", "tee log"]);
	});
});

describe("isRunner: tests, builds, type checks, linters and installs", () => {
	const runs = (cmd: string) => isRunner(cmd.split(" "));
	test.each([
		"pytest -q", "uv run pytest -q", "uv run --no-sync pytest", "python3 -m pytest tests", "npx vitest run", "bunx tsc --noEmit",
		"bun test", "npm test", "npm run build", "pnpm typecheck", "pnpm -s lint", "pnpm --filter @a/b test", "pnpm exec turbo run test",
		"yarn", "yarn test", "cargo test --workspace", "cargo +nightly build", "go test ./...", "xcodebuild -scheme X test", "swift build",
		"flutter analyze", "make", "./gradlew build", "docker build .", "docker compose up -d", "npx -y pnpm@11.28.9 test", "node --test",
		"bunx -p typescript@5.9 tsc -p x", "uv sync", "pip install -r requirements.txt", "brew install jq", "dotenv -e .env -- jest",
	])("%s", (cmd) => expect(runs(cmd)).toBe(true));

	test.each([
		"git log", "rg foo", "ls -la", "python3 script.py", "node build.js", "bun scripts/x.ts", "cargo fmt --all", "pnpm list",
		"npm view react", "docker ps", "uv run python scratch.py", "npx prettier --check .", "go version",
		"bun run scripts/report.ts", "npm run", "xcodebuild -showsdks", "cargo install --list", "make -n",
		"pytest --collect-only -q", "uv run pytest --co", "cargo test -- --list", "npm install --help",
	])("not %s", (cmd) => expect(runs(cmd)).toBe(false));
});

describe("blindingRefusal: a runner's output must reach the tool", () => {
	test.each([
		["uv run pytest -q 2>&1 | tail -20", "tail"],
		[`cd "/Users/m/crawlapi-v2" && uv run pytest -q 2>&1 | tail -2; grep x log`, "tail"],
		["cargo test --workspace --no-fail-fast 2>&1 | grep -E '^test result|FAILED'", "grep"],
		["npx -y pnpm@11.28.9 test 2>&1 | tail -12; echo \"TEST_EXIT=${PIPESTATUS[0]}\"", "tail"],
		["env -u PI_SUBAGENT_TOOLS bun test 2>&1 | tail -6", "tail"],
		["for i in 1 2 3; do pnpm exec turbo run test --force 2>&1 | grep FAIL; done", "grep"],
		["(cd rs && cargo build --release -q 2>&1 | tail -3) && echo built", "tail"],
		["zsh -lic 'cd /x && bun test 2>&1 | grep fail'", "grep"],
		["flutter analyze 2>&1 | head -100", "head"],
		["npx tsc --noEmit 2>&1 | wc -l", "wc"],
	])("%s", (cmd, consumer) => {
		const why = blindingRefusal(cmd)!;
		expect(why).toContain(`is piped into \`${consumer}\``);
		expect(why).toContain("keeps the full output in a file");
	});

	test("head is called out for stopping the command early", () => {
		expect(blindingRefusal("npm test | head -40")).toContain("stops the command once it has its lines");
	});

	test("redirecting a runner's output to a file is refused, wherever it sits", () => {
		expect(blindingRefusal("uv run pytest -q > .scratch/r3-pytest.log 2>&1; tail -3 .scratch/r3-pytest.log")).toContain("sends its output to `.scratch/r3-pytest.log`");
		expect(blindingRefusal("cd apple && (xcodebuild -project E.xcodeproj test > /tmp/x.log 2>&1 &)")).toContain("sends its output to `/tmp/x.log`");
		expect(blindingRefusal("(cd api && npm test) &> /tmp/t.log")).toContain("`/tmp/t.log`");
	});

	test("a streaming consumer is fine only with pipefail, since it still replaces the exit code", () => {
		expect(blindingRefusal("xcodebuild -scheme X build | xcpretty")).toContain("without `set -o pipefail`");
		expect(blindingRefusal("bun test 2>&1 | tee /tmp/t.log")).toContain("without `set -o pipefail`");
		expect(blindingRefusal("set -o pipefail; xcodebuild -scheme X build | xcpretty")).toBeUndefined();
		expect(blindingRefusal("set -euo pipefail\nbun test 2>&1 | grep --line-buffered FAIL")).toBeUndefined();
	});

	test.each([
		"git log --oneline | head -5",
		"rg -n foo src | head",
		"python3 script.py | tail -5",
		"cargo fmt --all 2>&1 | head",
		"pnpm list | grep react",
		"npm install > /dev/null 2>&1 && npm test",
		"pytest 2> errors.log",
		`echo "pytest | tail" > note.txt`,
		"cat > notes.md <<'EOF'\nuv run pytest -q | tail -3\nEOF",
		`ssh host "cd app && npm test | tail"`,
		"x=$(cargo test 2>&1 | tail -1)",
		"bun test",
		"uv run pytest -q",
		"bun run scripts/report.ts | jq .",
		"xcodebuild -showsdks | grep iphone",
		"cargo install --list | grep ripgrep",
		"make -n | head",
		"pytest --collect-only -q | tail -3",
		"npm test > >(tee out.log)",
	])("allows %s", (cmd) => expect(blindingRefusal(cmd)).toBeUndefined());

	test("a package script is still a run", () => {
		expect(blindingRefusal("npm run build 2>&1 | tail")).toContain("`npm run build` is piped into `tail`");
		expect(blindingRefusal("bun run -s test | grep fail")).toContain("is piped into `grep`");
	});

	test("the refusal says how to get one part of the output", () => {
		expect(blindingRefusal("pytest | grep FAILED")).toContain("read or grep afterwards");
	});
});

describe("package scripts: what the script runs decides", () => {
	const root = mkdtempSync(join(tmpdir(), "shape-pkg-"));
	const scripts = { version: "echo 1.2.3", test: "vitest run", check: "npm run lint && tsc --noEmit", lint: "eslint .", report: "node scripts/report.js" };
	writeFileSync(join(root, "package.json"), JSON.stringify({ scripts }));
	const cwd = join(root, "packages", "web");
	mkdirSync(cwd, { recursive: true });

	test.each(["npm run version | jq -r .", "npm run report | head", "npm run missing | tail", "yarn version | tail -1"])("allows %s", (cmd) => {
		expect(blindingRefusal(cmd, cwd)).toBeUndefined();
	});

	test.each([
		["npm test | tail", "tail"],
		["pnpm check 2>&1 | tail", "tail"],
		["yarn lint | grep error", "grep"],
		["pnpm vitest run | tail", "tail"],
		["bun run vitest | tail", "tail"],
		["pnpm --filter web report | tail", "tail"],
		["yarn workspace web test | tail", "tail"],
		["yarn workspaces foreach -A run test | tail", "tail"],
		["pnpm recursive test | tail", "tail"],
		["echo hi && cd app && npm run version | tail", "tail"],
		["(cd app && npm run version) | tail", "tail"],
	])("refuses %s", (cmd, consumer) => {
		expect(blindingRefusal(cmd, cwd)).toContain(`is piped into \`${consumer}\``);
	});

	test("with no package.json to ask, a script still counts as a run", () => {
		expect(blindingRefusal("npm run version | tail", mkdtempSync(join(tmpdir(), "shape-none-")))).toContain("is piped into `tail`");
	});
});

describe("sleepRefusal: a bare long sleep only blocks", () => {
	test.each([
		"sleep 60",
		"sleep 30 && curl -s localhost:3000",
		"sleep 1m; tail log",
		"sleep 15 15",
		"(./long.sh > /tmp/l.log 2>&1 &); sleep 150; tail /tmp/l.log",
		"nohup ./deploy.sh > d.log 2>&1 & sleep 45",
		"./restart.sh; sleep 300; curl -sf localhost:3000",
	])("refuses %s", (cmd) => {
		const why = sleepRefusal(cmd)!;
		expect(why).toContain("only waits");
		expect(why).toContain("until curl -sf");
	});

	test.each([
		"sleep 5 && curl -s localhost:3000",
		"sleep 29",
		"until curl -sf localhost:3000; do sleep 60; done",
		"for i in $(seq 1 10); do ./check.sh && break; sleep 40; done",
		"while true; do\n  ./check.sh\n  sleep 30\ndone",
		"if [ -f x ]; then sleep 45; fi",
		"echo sleep 60",
		"sleep $DELAY",
		"sleep 30 & BGPID=$!; ps -o pgid= -p $BGPID",
		"sleep 60 &\necho started",
	])("allows %s", (cmd) => expect(sleepRefusal(cmd)).toBeUndefined());
});

describe("maskedExitNote: an exit 0 decided by the last part only", () => {
	test("a failure before a pipe's last stage is named", () => {
		const note = maskedExitNote("./run-tests.sh 2>&1 | tail -3", "(fail) parses dates\n 3 pass\n 1 fail\n")!;
		expect(note).toContain("`tail -3`");
		expect(note).toContain("(fail)");
	});

	test("so is one before a trailing statement", () => {
		expect(maskedExitNote("./check.sh; echo done", "FAILED tests/test_api.py::test_login\ndone\n")).toContain("`echo done`");
		expect(maskedExitNote("go vet ./... || true", "--- FAIL: TestX (0.00s)\n")).toContain("`true`");
	});

	test("an && chain's exit 0 covers every part of it, unless a pipe inside it decided", () => {
		expect(maskedExitNote("npm test && echo done", "1 failed\n")).toBeUndefined();
		expect(maskedExitNote("cargo build && cargo test", "error: expected failure, logged\nok\n")).toBeUndefined();
		expect(maskedExitNote("./t.sh | tail -3 && echo done", "1 failed\n")).toContain("`tail -3`");
		expect(maskedExitNote("./t.sh; make && make install", "FAILED x\n")).toContain("`make && make install`");
	});

	test("no note without a strong failure shape, with pipefail, or for a single command", () => {
		expect(maskedExitNote("./t.sh | tail -3", "12 passed, 0 failed\n")).toBeUndefined();
		expect(maskedExitNote("set -o pipefail; ./t.sh | tail", "1 failed\n")).toBeUndefined();
		expect(maskedExitNote("./t.sh", "1 failed\n")).toBeUndefined();
		expect(maskedExitNote("./t.sh | tail", "an error occurred in the docs build, retried, fine\n")).toBeUndefined();
	});
});
