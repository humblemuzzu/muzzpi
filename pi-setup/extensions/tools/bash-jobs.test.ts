/**
 * Background bash jobs, end to end through the real tool and real processes;
 * only the pi side is a stand-in, which records what would reach the model.
 * The yield is cut from 60s to 1s so a "long" command takes seconds.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childHeartbeat, createBashTool } from "./bash";
import { SUB_AGENT_TOOLS_ENV } from "./lib/sub-agent-prompt";
import { createAgentsTool } from "./agents";
import { AgentRuns } from "./lib/agent-runs";
import { BashJobs, type JobResultDetails } from "./lib/bash-jobs";
import type { RunSnapshot } from "./lib/agent-channel";

let dir: string;
/* run from inside a sub-agent, the inherited tool list would make every session unwakeable */
const inheritedTools = process.env[SUB_AGENT_TOOLS_ENV];
beforeAll(() => {
	delete process.env[SUB_AGENT_TOOLS_ENV];
	process.env.PI_BASH_YIELD_SEC = "1";
	dir = mkdtempSync(join(tmpdir(), "bash-jobs-"));
});
afterAll(() => {
	if (inheritedTools !== undefined) process.env[SUB_AGENT_TOOLS_ENV] = inheritedTools;
	delete process.env.PI_BASH_YIELD_SEC;
	rmSync(dir, { recursive: true, force: true });
});

interface Sent {
	content: string;
	details: JobResultDetails;
	wake: boolean;
}

function setup() {
	const sent: Sent[] = [];
	const shown: RunSnapshot[][] = [];
	const jobs = new BashJobs({
		notify: (content, details, wake) => {
			sent.push({ content, details, wake });
		},
		broadcast: (snapshot) => shown.push(snapshot),
	});
	const tool = createBashTool(jobs) as any;
	const agents = createAgentsTool(new AgentRuns(), jobs) as any;
	const ctx = (mode: string) => ({ cwd: dir, mode, sessionManager: { getSessionId: () => "jobs-test" } });
	const bash = async (params: Record<string, unknown>, mode = "tui", toolCallId = "call-1", signal?: AbortSignal) => {
		const started = Date.now();
		const result = await tool.execute(toolCallId, { timeout: 60, ...params }, signal, undefined, ctx(mode));
		return { result, text: result.content[0].text as string, ms: Date.now() - started };
	};
	const until = async (check: () => boolean, ms = 15_000) => {
		const end = Date.now() + ms;
		while (!check()) {
			if (Date.now() > end) throw new Error("timed out waiting");
			await Bun.sleep(50);
		}
	};
	return { jobs, tool, agents, sent, shown, bash, until };
}

const jobIdOf = (text: string) => text.match(/job (bash-[0-9a-f]+)/)![1]!;
const TICKS = "for i in 1 2 3 4; do echo tick$i; sleep 0.6; done";
/** runs until stopped: silent, no CPU. A bare long `sleep` is refused as a blind wait. */
const HANG = "tail -f /dev/null";

describe("a long command moves to the background instead of holding the agent", () => {
	test("past the yield the call returns with the output so far, and the result arrives once, by itself", async () => {
		const { bash, sent, until } = setup();
		const { text, result, ms } = await bash({ cmd: TICKS });
		expect(ms).toBeLessThan(2_000);
		expect(text).toContain("Still running after 1s, so it moved to the background as job bash-");
		expect(text).toContain("tick1");
		expect(text).toContain("do not sleep, poll, or read the log");
		expect(result.isError).toBeUndefined();
		const id = jobIdOf(text);
		expect(result.details.job).toBe(id);
		const log = text.match(/full output is written to (\S+)\./)![1]!;

		await until(() => sent.length > 0);
		expect(sent).toHaveLength(1);
		expect(sent[0]!.wake).toBe(true);
		expect(sent[0]!.content).toStartWith("[Automated bash-job event.");
		expect(sent[0]!.content).toContain(`Background job ${id} finished after`);
		expect(sent[0]!.content).toContain("tick4");
		expect(sent[0]!.details.jobs[0]).toMatchObject({ id, status: "done", kind: "finished", exitCode: 0 });
		expect(readFileSync(log, "utf8")).toBe("tick1\ntick2\ntick3\ntick4\n");
		await Bun.sleep(1_200);
		expect(sent).toHaveLength(1);
	}, 20_000);

	test("a command that ends before the yield answers inline as before", async () => {
		const { bash, sent } = setup();
		const { text, result } = await bash({ cmd: "echo quick" });
		expect(text).toBe("$ echo quick\n\nquick");
		expect(result.structuredContent.exit_code).toBe(0);
		expect(result.details.job).toBeUndefined();
		await Bun.sleep(1_200);
		expect(sent).toHaveLength(0);
	}, 10_000);

	test("a failure is reported with its exit code", async () => {
		const { bash, sent, until } = setup();
		const { text } = await bash({ cmd: "sleep 1.5; echo broke >&2; exit 3" });
		const id = jobIdOf(text);
		await until(() => sent.length > 0);
		expect(sent[0]!.content).toContain(`Background job ${id} failed after`);
		expect(sent[0]!.content).toContain("broke");
		expect(sent[0]!.content).toContain("exit code 3");
		expect(sent[0]!.details.jobs[0]).toMatchObject({ status: "failed", exitCode: 3 });
	}, 20_000);

	test("the deadline counts from the start, not from the move", async () => {
		const { bash, sent, until } = setup();
		const { text, ms } = await bash({ cmd: `echo started; ${HANG}`, timeout: 3 });
		expect(ms).toBeLessThan(2_000);
		const id = jobIdOf(text);
		await until(() => sent.length > 0, 10_000);
		expect(sent[0]!.content).toContain(`Background job ${id} failed after 3s`);
		expect(sent[0]!.content).toContain("command timed out after 3 seconds");
	}, 20_000);

	test("every job reports, and only the last 20 finished ones are kept", async () => {
		const { bash, agents, sent, until } = setup();
		const texts = await Promise.all(Array.from({ length: 22 }, (_, i) => bash({ cmd: `sleep 1.2; echo job-${i}` }, "tui", `c${i}`)));
		const ids = texts.map(({ text }) => jobIdOf(text));
		await until(() => sent.flatMap((s) => s.details.jobs).length === 22);
		const listed = (await agents.execute("l", { action: "list" })).content[0].text as string;
		expect(listed.split("\n")).toHaveLength(20);
		expect(ids.filter((id) => listed.includes(id))).toHaveLength(20);
	}, 20_000);

	test("the dock sees the job, with its latest line, then its end", async () => {
		const { bash, shown, until } = setup();
		const { text } = await bash({ cmd: TICKS });
		const id = jobIdOf(text);
		await until(() => shown.some((list) => list.some((run) => run.id === id && run.status === "running" && run.output?.includes("tick2"))));
		const running = shown.flat().find((run) => run.id === id && run.status === "running")!;
		expect(running).toMatchObject({ agent: "bash", background: true, label: TICKS });
		await until(() => shown.some((list) => list.some((run) => run.id === id && run.status === "done")));
		const done = shown.flat().findLast((run) => run.id === id)!;
		expect(done.activity).toBe("exit 0 · tick4");
	}, 20_000);
});

describe("asking for the background, and the early wake", () => {
	test("background: true moves it after a short peek; run_in_background is the same", async () => {
		const { bash } = setup();
		for (const flag of ["background", "run_in_background"]) {
			const { text, ms } = await bash({ cmd: "sleep 3", [flag]: true });
			expect(ms).toBeLessThan(2_500);
			expect(text).toContain("Started in the background as job bash-");
		}
	}, 20_000);

	test("background: true on a command that ends at once still answers inline", async () => {
		const { bash } = setup();
		const { text } = await bash({ cmd: "echo done-already", background: true });
		expect(text).toBe("$ echo done-already\n\ndone-already");
	}, 10_000);

	test("a wake_on line in the foreground hands the command back at once, still running", async () => {
		const { bash, sent, until } = setup();
		const { text, ms } = await bash({ cmd: "echo ok-1; sleep 0.3; echo 'FAILED tests/test_a.py::test_x'; sleep 2; echo end", wake_on: "FAILED|panicked", timeout: 30 });
		expect(ms).toBeLessThan(1_000);
		expect(text).toContain("A line matched `FAILED|panicked`, so it moved to the background as job bash-");
		expect(text).toContain("    FAILED tests/test_a.py::test_x");
		await until(() => sent.length > 0);
		expect(sent).toHaveLength(1);
		expect(sent[0]!.details.jobs[0]!.kind).toBe("finished");
		expect(sent[0]!.content).toContain("end");
	}, 20_000);

	test("a wake_on line printed just before the exit answers inline, with the whole result", async () => {
		const { bash, sent } = setup();
		const { text, result } = await bash({ cmd: "sleep 0.3; echo 'FAILED tests/x.py::test_y'; sleep 0.1; exit 1", wake_on: "FAILED" });
		expect(text).toContain("FAILED tests/x.py::test_y");
		expect(text).toContain("exit code 1");
		expect(result.details.job).toBeUndefined();
		await Bun.sleep(1_200);
		expect(sent).toHaveLength(0);
	}, 10_000);

	test("once it is a job, the first wake_on line is news of its own, then the end", async () => {
		const { bash, sent, until } = setup();
		const { text } = await bash({ cmd: "sleep 1.5; echo 'error[E0308]: mismatched types'; echo 'error[E0599]: no method'; sleep 1; exit 101", wake_on: "/^ERROR\\[/i" });
		const id = jobIdOf(text);
		expect(text).toContain("The first line matching `^ERROR\\[` reaches you early.");
		await until(() => sent.length >= 2);
		expect(sent.map((s) => s.details.jobs[0]!.kind)).toEqual(["matched", "finished"]);
		expect(sent[0]!.content).toContain(`Background job ${id} printed a line matching \`^ERROR\\[\``);
		expect(sent[0]!.content).toContain("error[E0308]: mismatched types");
		expect(sent[0]!.content).toContain(`agents stop ["${id}"]`);
		expect(sent[1]!.content).toContain("exit code 101");
	}, 20_000);

	test("an invalid wake_on is refused before anything runs", async () => {
		const { bash } = setup();
		const marker = join(dir, "wake-on-ran");
		const { text, result } = await bash({ cmd: `touch "${marker}"`, wake_on: "(unclosed" });
		expect(result.isError).toBe(true);
		expect(text).toContain("wake_on is not a valid regular expression");
		expect(existsSync(marker)).toBe(false);
	});
});

describe("what never moves", () => {
	test("a codemode script's call waits for the end: nothing could wake the script", async () => {
		const { bash, sent } = setup();
		const { text, ms } = await bash({ cmd: "sleep 1.6; echo script-done" }, "tui", "codemode-1/bash-2");
		expect(ms).toBeGreaterThan(1_500);
		expect(text).toBe("$ sleep 1.6; echo script-done\n\nscript-done");
		expect(sent).toHaveLength(0);
	}, 10_000);

	test("a git command waits for the end: it holds the repo's lock", async () => {
		const { bash } = setup();
		const { text } = await bash({ cmd: "sleep 1.6; git --version" });
		expect(text).toMatch(/^\$ sleep 1\.6; git --version\n\ngit version/);
	}, 10_000);

	test("without a host every call waits, as the tool did before", async () => {
		const tool = createBashTool() as any;
		const result = await tool.execute("c", { cmd: "sleep 1.6; echo plain", timeout: 10, background: true }, undefined, undefined, { cwd: dir, mode: "tui", sessionManager: { getSessionId: () => "x" } });
		expect(result.content[0].text).toBe("$ sleep 1.6; echo plain\n\nplain");
		expect((tool.parameters as any).properties.background).toBeUndefined();
	}, 10_000);
});

describe("stop, wait and Esc", () => {
	test("agents offers list and stop, and no wait: the result comes by itself", () => {
		const { agents } = setup();
		expect(agents.parameters.properties.action.enum).toEqual(["list", "stop"]);
		expect(agents.description).toContain("There is no wait");
		expect(agents.parameters.properties.timeout).toBeUndefined();
	});

	test("agents stop ends it, says who stopped it, and no message follows", async () => {
		const { bash, agents, sent } = setup();
		const id = jobIdOf((await bash({ cmd: `echo going; ${HANG}` })).text);
		const stopped = await agents.execute("s", { action: "stop", ids: [id] });
		expect(stopped.content[0].text).toContain(`Background job ${id} was stopped after`);
		expect(stopped.content[0].text).toContain("stopped with agents stop");
		expect(stopped.details.jobs[0].status).toBe("stopped");
		await Bun.sleep(1_500);
		expect(sent).toHaveLength(0);
		const listed = await agents.execute("l", { action: "list" });
		expect(listed.content[0].text).toContain(`${id} · bash · stopped`);
	}, 20_000);

	test("Esc ends a call that still waits; once it is a job, Esc no longer reaches it", async () => {
		const { bash, sent, until } = setup();
		const early = new AbortController();
		setTimeout(() => early.abort(), 300);
		expect((await bash({ cmd: "sleep 5" }, "tui", "c1", early.signal)).text).toBe("command aborted");

		const late = new AbortController();
		const { text } = await bash({ cmd: "sleep 1.6; echo survived" }, "tui", "c2", late.signal);
		late.abort();
		await until(() => sent.length > 0);
		expect(sent[0]!.content).toContain("survived");
		expect(text).toContain("job bash-");
	}, 20_000);

	test("Ctrl+B moves a waiting call to the background, and says the user did it", async () => {
		const { bash, jobs } = setup();
		process.env.PI_BASH_YIELD_SEC = "30";
		try {
			const pending = bash({ cmd: "sleep 3" });
			await Bun.sleep(400);
			expect(jobs.detachForeground()).toBe(true);
			const { text, ms } = await pending;
			expect(ms).toBeLessThan(1_500);
			expect(text).toContain("The user moved it to the background with Ctrl+B");
			expect(jobs.detachForeground()).toBe(false);
		} finally {
			process.env.PI_BASH_YIELD_SEC = "1";
		}
	}, 10_000);
});

describe("a session nothing can wake (a sub-agent, print mode) is held until its jobs report", () => {
	test("news goes out as a steer, and the hold ends once it is queued", async () => {
		const { bash, jobs, sent } = setup();
		const { text } = await bash({ cmd: "sleep 1.8; echo held-result" }, "print");
		const id = jobIdOf(text);
		const statuses: Array<string | undefined> = [];
		const held = await jobs.hold(undefined, (status) => statuses.push(status));
		expect(held).toBe(true);
		expect(sent).toHaveLength(1);
		expect(sent[0]!.wake).toBe(false);
		expect(sent[0]!.content).toContain("held-result");
		expect(statuses[0]).toMatch(new RegExp(`^waiting for ${id} \\(\\d+s\\)`));
		expect(statuses.at(-1)).toBeUndefined();
		expect(await jobs.hold(undefined, () => {})).toBe(false);
	}, 20_000);

	test("an agents stop there gets the result itself; no steer races it", async () => {
		const { bash, agents, sent } = setup();
		const id = jobIdOf((await bash({ cmd: `echo before-stop; ${HANG}` }, "print")).text);
		const stopped = await agents.execute("s", { action: "stop", ids: [id] });
		expect(stopped.content[0].text).toContain("before-stop");
		expect(stopped.content[0].text).not.toContain("already delivered");
		await Bun.sleep(300);
		expect(sent).toHaveLength(0);
	}, 20_000);

	test("a hold that starts while a finished job's news is still being queued waits for it", async () => {
		const sent: string[] = [];
		const jobs = new BashJobs({
			notify: (content) => new Promise<void>((resolve) => setTimeout(() => { sent.push(content); resolve(); }, 300)),
			broadcast: () => {},
		});
		const tool = createBashTool(jobs) as any;
		await tool.execute("c", { cmd: "sleep 1.7; echo slow-to-queue", timeout: 10, background: true }, undefined, undefined, { cwd: dir, mode: "print", sessionManager: { getSessionId: () => "x" } });
		const end = Date.now() + 5_000;
		while (!jobs.list()[0]?.includes("· done") && Date.now() < end) await Bun.sleep(10);
		expect(sent).toHaveLength(0);
		expect(await jobs.hold(undefined, () => {})).toBe(true);
		expect(sent).toHaveLength(1);
		expect(sent[0]).toContain("slow-to-queue");
	}, 15_000);

	test("a woken session's jobs never hold its run", async () => {
		const { bash, jobs } = setup();
		await bash({ cmd: "sleep 2" }, "tui");
		expect(await jobs.hold(undefined, () => {})).toBe(false);
	}, 10_000);

	test("a hold ends on abort", async () => {
		const { bash, jobs } = setup();
		await bash({ cmd: "sleep 5" }, "print");
		const abort = new AbortController();
		setTimeout(() => abort.abort(), 200);
		expect(await jobs.hold(abort.signal, () => {})).toBe(false);
		await jobs.stop(["all"]);
	}, 10_000);
});

describe("a sub-agent's long foreground command beats", () => {
	test("once a beat is due it sets its status, and clears it at the end", async () => {
		const statuses: Array<[string, string | undefined]> = [];
		const ui = { setStatus: (key: string, text: string | undefined) => void statuses.push([key, text]) };
		process.env[SUB_AGENT_TOOLS_ENV] = "read,bash";
		try {
			const stop = childHeartbeat(ui, "git clone big-repo", 50);
			await Bun.sleep(130);
			stop();
		} finally {
			delete process.env[SUB_AGENT_TOOLS_ENV];
		}
		expect(statuses[0]![0]).toBe("bash-running");
		expect(statuses[0]![1]).toMatch(/^running `git clone big-repo` \(0s\)$/);
		expect(statuses.at(-1)).toEqual(["bash-running", undefined]);
	});

	test("a quick command, or one in the main session, sends nothing", async () => {
		const statuses: unknown[] = [];
		const ui = { setStatus: () => void statuses.push(1) };
		childHeartbeat(ui, "git status", 50)();
		process.env[SUB_AGENT_TOOLS_ENV] = "read,bash";
		try {
			childHeartbeat(ui, "git status", 50)();
		} finally {
			delete process.env[SUB_AGENT_TOOLS_ENV];
		}
		await Bun.sleep(80);
		expect(statuses).toHaveLength(0);
	});
});

describe("the session closing", () => {
	test("quit stops running jobs and adds their results without waking", async () => {
		const { bash, jobs, sent } = setup();
		const id = jobIdOf((await bash({ cmd: `echo before-quit; ${HANG}` })).text);
		await jobs.shutdown(false);
		expect(sent).toHaveLength(1);
		expect(sent[0]!.wake).toBe(false);
		expect(sent[0]!.details.jobs[0]).toMatchObject({ id, status: "interrupted" });
		expect(sent[0]!.content).toContain("stopped because the session closed");
		expect(jobs.movable).toBe(false);
	}, 10_000);

	test("a reload hands running jobs to the next load, whose host hears their end", async () => {
		const { bash, jobs, sent } = setup();
		const id = jobIdOf((await bash({ cmd: "sleep 1.5; echo after-reload" })).text);
		await jobs.shutdown(true);
		const heard: Sent[] = [];
		const next = new BashJobs({ notify: (content, details, wake) => void heard.push({ content, details, wake }), broadcast: () => {} });
		next.adopt(BashJobs.takeHandoff()!);
		expect(next.has(id)).toBe(true);
		const end = Date.now() + 10_000;
		while (heard.length === 0 && Date.now() < end) await Bun.sleep(50);
		expect(heard[0]!.content).toContain("after-reload");
		expect(sent).toHaveLength(0);
	}, 20_000);
});

describe("guards on the way in, and the exit code on the way out", () => {
	test("a test run piped into tail is refused before it runs", async () => {
		const { bash } = setup();
		const marker = join(dir, "piped-ran");
		const { result, text } = await bash({ cmd: `npm test --prefix "${marker}" 2>&1 | tail -5` });
		expect(result.isError).toBe(true);
		expect(text).toStartWith("Refused before running: `npm test --prefix` is piped into `tail`");
		expect(existsSync(marker)).toBe(false);
	});

	test("a long bare sleep is refused", async () => {
		const { bash } = setup();
		const { result, text } = await bash({ cmd: "sleep 120" });
		expect(result.isError).toBe(true);
		expect(text).toContain("only waits");
	});

	test("an exit 0 a pipe decided, over a failure in the output, says so", async () => {
		const { bash } = setup();
		const { result, text } = await bash({ cmd: "sh -c 'echo \"1 failed, 3 passed\"; exit 1' | tail -1" });
		expect(result.structuredContent.exit_code).toBe(0);
		expect(text).toContain("exit code 0 is the exit code of `tail -1`");
		expect(text).toContain('"1 failed"');
	});

	test("Python prints as it goes, not when it exits", async () => {
		const updates: string[] = [];
		const tool = createBashTool() as any;
		const run = tool.execute(
			"c",
			{ cmd: "python3 -c \"import time; print('first'); time.sleep(1.2); print('second')\"", timeout: 10 },
			undefined,
			(update: any) => updates.push(update.content[0].text),
			{ cwd: dir, mode: "tui", sessionManager: { getSessionId: () => "x" } },
		);
		await Bun.sleep(800);
		expect(updates.some((text) => text.includes("first"))).toBe(true);
		expect(updates.some((text) => text.includes("second"))).toBe(false);
		expect((await run).content[0].text).toContain("second");
	}, 10_000);
});
