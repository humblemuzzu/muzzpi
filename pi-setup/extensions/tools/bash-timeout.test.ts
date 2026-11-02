/**
 * bash time-bound tests — the declared timeout and the idle kill.
 *
 * these invoke the REAL tool against REAL processes. the whole point of this
 * change is behaviour under a hung child, and a mocked child cannot hang in the
 * way that matters (output already flushed, process refusing to exit), so
 * nothing here is stubbed except the pi context.
 *
 * WHY IT EXISTS
 * a delegate ran a `vitest` command overnight that finished its work in 3
 * seconds, printed its complete summary, and then failed to exit for 2h22m.
 * 8,555 seconds, of which 8,552 produced nothing. no bound of any kind existed:
 * the `timeout` parameter was optional and was used 0 times in 45 calls.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateToolArguments } from "./node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/index.js";
import { clampTimeout, createBashTool, idleKillSec, maxTimeoutSec } from "./bash";

const mockCtx = {
	cwd: "/tmp",
	sessionManager: { getSessionId: () => "test-session-id" },
} as any;

/** run the real tool. `idle` overrides the idle window for this call only. */
async function run(
	params: Record<string, unknown>,
	idle?: number,
): Promise<{ text: string; isError: boolean; ms: number }> {
	const prev = process.env.PI_BASH_IDLE_KILL_SEC;
	if (idle !== undefined) process.env.PI_BASH_IDLE_KILL_SEC = String(idle);
	const tool = createBashTool();
	const started = Date.now();
	try {
		const result: any = await tool.execute!("t", params as any, undefined, undefined, mockCtx);
		return {
			text: result.content?.[0]?.text ?? "",
			isError: result.isError === true,
			ms: Date.now() - started,
		};
	} finally {
		if (prev === undefined) delete process.env.PI_BASH_IDLE_KILL_SEC;
		else process.env.PI_BASH_IDLE_KILL_SEC = prev;
	}
}

// ---------------------------------------------------------------- schema (L1)

describe("schema: timeout is required and bounded", () => {
	const params = createBashTool().parameters as any;

	test("timeout is in the required array", () => {
		expect(params.required).toContain("timeout");
	});

	test("cmd and command stay OPTIONAL — the alias pair must not become mandatory", () => {
		expect(params.required).not.toContain("cmd");
		expect(params.required).not.toContain("command");
	});

	test("timeout is the ONLY required property", () => {
		// a second required property would be a silent contract change for every
		// caller; pin the exact set.
		expect(params.required).toEqual(["timeout"]);
	});

	test("bounds are in the schema, so 0 and 99999 are model-visible errors", () => {
		expect(params.properties.timeout.minimum).toBe(1);
		expect(params.properties.timeout.maximum).toBe(600);
		expect(params.properties.timeout.type).toBe("number");
	});

	test("no TypeBox default — pi fills none, so one would be decorative and misleading", () => {
		expect(params.properties.timeout.default).toBeUndefined();
	});

	test("the description carries the ladder the model plans against", () => {
		const d = params.properties.timeout.description as string;
		expect(d).toMatch(/Required/i);
		expect(d).toContain("1-600");
		expect(d).toMatch(/read\/grep/);
		expect(d).toMatch(/e2e\/deploy/);
	});

	test("the description warns that silence kills regardless of the value", () => {
		const d = params.properties.timeout.description as string;
		expect(d).toMatch(/NOTHING for \d+s is killed regardless/);
	});

	test("but does NOT claim an idle kill when the idle kill is disabled", () => {
		// "prints NOTHING for 0s is killed" is both false and unparseable; a tool
		// description that lies about its own guards is worse than a silent one.
		process.env.PI_BASH_IDLE_KILL_SEC = "0";
		try {
			const d = (createBashTool().parameters as any).properties.timeout.description as string;
			expect(d).not.toMatch(/NOTHING for/);
			expect(d).toMatch(/Required/);
			expect(d).toMatch(/split it or run it outside the agent/);
		} finally {
			delete process.env.PI_BASH_IDLE_KILL_SEC;
		}
	});
});

// ------------------------------------------------------------ description (L0)

describe("description: stop the model blinding the harness", () => {
	const tool = createBashTool();

	test("tells the model not to pipe to tail/head/grep", () => {
		expect(tool.description).toMatch(/Do NOT pipe to `tail`\/`head`\/`grep`/);
	});

	test("says WHY — piping buffers and hides progress", () => {
		expect(tool.description).toMatch(/buffers everything until the command ends/);
		expect(tool.description).toMatch(/look hung/);
	});

	test("still states the tool's own truncation, so the advice is actionable", () => {
		expect(tool.description).toMatch(/Output shows first 50 and last 50 lines/);
	});
});

// ------------------------------------------------------- runtime net (lenient providers)

describe("runtime net: malformed timeout is refused before any work", () => {
	const bad: Array<[string, unknown]> = [
		["missing", undefined],
		["zero", 0],
		["negative", -5],
		["over the ceiling", 601],
		["absurd", 99999],
		["string", "120"],
		["non-numeric string", "abc"],
		["null", null],
		["NaN", Number.NaN],
		["Infinity", Number.POSITIVE_INFINITY],
		["boolean", true],
		["object", {}],
	];

	for (const [label, value] of bad) {
		test(`refuses ${label}`, async () => {
			const params: Record<string, unknown> = { cmd: "echo SHOULD_NOT_RUN" };
			if (value !== undefined) params.timeout = value;
			const { text, isError } = await run(params);
			expect(isError).toBe(true);
			expect(text).toMatch(/timeout required/);
			expect(text).not.toContain("SHOULD_NOT_RUN");
		});
	}

	test("the refusal is short and names the ladder", () => {
		// long refusals get skimmed; this one has to teach the value in one line.
		return run({ cmd: "echo x" }).then(({ text }) => {
			expect(text.length).toBeLessThan(120);
			expect(text).toContain("read 10");
			expect(text).toContain("1-600");
		});
	});

	test("a valid timeout runs normally", async () => {
		const { text, isError } = await run({ cmd: "echo OK", timeout: 30 });
		expect(isError).toBe(false);
		expect(text).toContain("OK");
	});

	test("the `command` alias works with a timeout", async () => {
		const { text, isError } = await run({ command: "echo VIA_ALIAS", timeout: 30 });
		expect(isError).toBe(false);
		expect(text).toContain("VIA_ALIAS");
	});

	test("boundary values 1 and 600 are accepted", async () => {
		expect((await run({ cmd: "echo LOW", timeout: 1 })).isError).toBe(false);
		expect((await run({ cmd: "echo HIGH", timeout: 600 })).isError).toBe(false);
	});
});

describe("over the ceiling: run at the ceiling, and told so", () => {
	/** what pi does with a model's call: prepareArguments, then its own schema validation, then execute. */
	async function piRuns(args: Record<string, unknown>) {
		const tool = createBashTool() as any;
		const params = validateToolArguments(tool, { type: "toolCall", id: "c", name: "bash", arguments: tool.prepareArguments(args) } as any);
		const result: any = await tool.execute("c", params, undefined, undefined, mockCtx);
		return { params, text: result.content?.[0]?.text ?? "", isError: result.isError === true, result };
	}

	test("900 and \"1200\" pass pi's validation as 600 and the result names the clamp", async () => {
		for (const timeout of [900, "1200"]) {
			const { params, text, isError, result } = await piRuns({ cmd: "echo RAN", timeout });
			expect(params.timeout).toBe(600);
			expect(isError).toBe(false);
			expect(text).toContain("RAN");
			expect(text).toContain(`(your timeout ${Number(timeout)}s is over the 600s cap, so it ran with 600s)`);
			expect(result.structuredContent.exit_code).toBe(0);
		}
	});

	test("a timeout within the cap is passed through untouched, with no note", async () => {
		const args = { cmd: "echo RAN", timeout: 600 };
		expect(clampTimeout(args, 600)).toBe(args);
		const { text } = await piRuns(args);
		expect(text).not.toContain("cap");
	});

	test("a missing, too-small or non-numeric timeout is still refused by the schema", () => {
		const tool = createBashTool() as any;
		for (const timeout of [undefined, 0, -5, "abc", null]) {
			const args: Record<string, unknown> = { cmd: "echo x" };
			if (timeout !== undefined) args.timeout = timeout;
			expect(() => validateToolArguments(tool, { type: "toolCall", id: "c", name: "bash", arguments: tool.prepareArguments(args) } as any)).toThrow(/timeout/);
		}
	});

	test("the schema and description the model sees are unchanged", () => {
		const params = createBashTool().parameters as any;
		expect(params.properties.timeout.maximum).toBe(600);
		expect(params.properties.timeout_clamped_from).toBeUndefined();
	});
});

// ------------------------------------------------------------- wall clock (L1)

describe("wall clock: the declared budget is enforced", () => {
	test("kills at the declared timeout", async () => {
		const { text, isError, ms } = await run({ cmd: "sleep 10", timeout: 1 }, 0);
		expect(isError).toBe(true);
		expect(text).toMatch(/timed out after 1 seconds/);
		expect(ms).toBeLessThan(6000);
	}, 20000);

	test("preserves output printed before the timeout", async () => {
		const { text } = await run({ cmd: "echo BEFORE_TIMEOUT; sleep 10", timeout: 1 }, 0);
		expect(text).toContain("BEFORE_TIMEOUT");
	}, 20000);

	test("tells the model it may raise it, and names the ceiling", async () => {
		const { text } = await run({ cmd: "sleep 10", timeout: 1 }, 0);
		expect(text).toMatch(/Raise it, up to 600s/);
	}, 20000);
});

// -------------------------------------------------------------- idle kill (L2)

describe("idle kill: silence is the failure signal", () => {
	test("kills a silent command well before its declared budget", async () => {
		// the incident in one line: budget of 600s, dead after producing nothing.
		const { text, isError, ms } = await run({ cmd: "sleep 30", timeout: 600 }, 1);
		expect(isError).toBe(true);
		expect(text).toMatch(/no output and no CPU activity for 1s/);
		expect(ms).toBeLessThan(8000);
	}, 20000);

	test("REGRESSION: output printed before the hang is fully preserved", async () => {
		// this is the property that makes killing cheap. in the real incident
		// 100% of the useful output existed at t+3s and the next 8,552 seconds
		// produced nothing — a kill that discarded it would be worse than the bug.
		// (claude-code issue #34266 is exactly that bug.)
		const { text, isError } = await run(
			{ cmd: "echo TESTS_PASSED; echo SUMMARY_LINE; sleep 30", timeout: 600 },
			1,
		);
		expect(isError).toBe(true);
		expect(text).toContain("TESTS_PASSED");
		expect(text).toContain("SUMMARY_LINE");
		expect(text).toMatch(/no output and no CPU activity for 1s/);
	}, 20000);

	test("says the output above is complete, because it usually is", async () => {
		const { text } = await run({ cmd: "echo DONE; sleep 30", timeout: 600 }, 1);
		expect(text).toMatch(/Output above is everything it printed/);
		expect(text).toMatch(/finishes its work and fails to exit/);
	}, 20000);

	test("does NOT kill a command that keeps printing", async () => {
		// the whole design rests on this: a streaming job must be untouchable.
		const { text, isError } = await run(
			{ cmd: "for i in 1 2 3 4 5 6 7 8; do echo tick$i; sleep 0.4; done", timeout: 600 },
			1,
		);
		expect(isError).toBe(false);
		expect(text).toContain("tick1");
		expect(text).toContain("tick8");
		expect(text).not.toMatch(/no output and no CPU/);
	}, 30000);

	test("stderr counts as liveness — a command logging only to stderr survives", async () => {
		const { isError, text } = await run(
			{ cmd: "for i in 1 2 3 4 5 6; do echo err$i >&2; sleep 0.4; done", timeout: 600 },
			1,
		);
		expect(isError).toBe(false);
		expect(text).toContain("err6");
	}, 30000);

	test("a slow-but-steady command outlives many idle windows", async () => {
		// 4s of work with a 1s window: proves the timer measures gaps, not duration.
		const { isError } = await run(
			{ cmd: "for i in $(seq 1 10); do echo $i; sleep 0.4; done", timeout: 600 },
			1,
		);
		expect(isError).toBe(false);
	}, 30000);

	test("PI_BASH_IDLE_KILL_SEC=0 disables it entirely", async () => {
		const { isError, text } = await run({ cmd: "sleep 2; echo SURVIVED", timeout: 30 }, 0);
		expect(isError).toBe(false);
		expect(text).toContain("SURVIVED");
	}, 20000);

	test("idle and wall-clock produce DIFFERENT diagnoses", async () => {
		const idle = await run({ cmd: "sleep 30", timeout: 600 }, 1);
		const wall = await run({ cmd: "sleep 30", timeout: 1 }, 0);
		expect(idle.text).toMatch(/no output and no CPU/);
		expect(idle.text).not.toMatch(/timed out after/);
		expect(wall.text).toMatch(/timed out after/);
		expect(wall.text).not.toMatch(/no output and no CPU/);
	}, 30000);

	test("idle beats the wall clock when both could apply", async () => {
		// idle 1s, wall 3s, silent command: the idle diagnosis is the useful one.
		const { text } = await run({ cmd: "sleep 30", timeout: 3 }, 1);
		expect(text).toMatch(/no output and no CPU/);
	}, 20000);

	test("a process that IGNORES SIGTERM is still killed, via the SIGKILL escalation", async () => {
		// killGracefully sends SIGTERM then SIGKILL 3s later. a command that traps
		// TERM is the case where the escalation is load-bearing — and the case where
		// the interval would otherwise re-fire the kill on every tick.
		const { isError, text, ms } = await run(
			{ cmd: "trap '' TERM; sleep 30", timeout: 600 },
			1,
		);
		expect(isError).toBe(true);
		expect(text).toMatch(/no output and no CPU activity for 1s/);
		// 1s idle + 3s SIGKILL escalation, nowhere near the 30s the command wanted
		expect(ms).toBeLessThan(12000);
	}, 30000);
});

// ------------------------------------------------------ CPU liveness (the fix)

describe("CPU liveness: work counts, even with no output", () => {
	test("a busy-but-SILENT command is NOT killed (it's burning CPU)", async () => {
		// stdout-only would kill this at 1s — it prints nothing. CPU sees the work.
		// `yes` pegs a core; we cap it with head so the command ends on its own.
		const { isError, text } = await run(
			{ cmd: "yes | head -100000000 >/dev/null", timeout: 600 },
			1,
		);
		expect(isError).toBe(false);
		expect(text).not.toMatch(/no output and no CPU/);
	}, 30000);

	test("THE KEY CASE: a producer behind `| tail` survives (your deploy shape)", async () => {
		// `tail` buffers everything until the producer exits, so our stdout sees
		// ZERO bytes for the whole run — exactly the shape that got deploys killed.
		// the producer is burning CPU, so CPU liveness keeps it alive.
		const { isError } = await run(
			{ cmd: "yes | head -100000000 | tail -3 >/dev/null", timeout: 600 },
			1,
		);
		expect(isError).toBe(false);
	}, 30000);

	test("a genuinely dead process (no output, no CPU) is STILL killed", async () => {
		// CPU liveness must not save a real hang. `sleep` burns no CPU.
		const { isError, text, ms } = await run({ cmd: "sleep 30", timeout: 600 }, 2);
		expect(isError).toBe(true);
		expect(text).toMatch(/no output and no CPU activity/);
		expect(ms).toBeLessThan(10000);
	}, 30000);

	test("with CPU liveness DISABLED, the busy-silent command IS killed", async () => {
		// proves the CPU check is what saves it — not luck. this is the old
		// stdout-only behaviour, on by an env flag.
		process.env.PI_BASH_CPU_LIVENESS = "0";
		try {
			const { isError, text } = await run(
				{ cmd: "yes | head -100000000 >/dev/null", timeout: 600 },
				2,
			);
			expect(isError).toBe(true);
			expect(text).toMatch(/no output and no CPU/);
		} finally {
			delete process.env.PI_BASH_CPU_LIVENESS;
		}
	}, 30000);
});

// ---------------------------------------------- may_run_silent (the remote hole)

describe("may_run_silent: the escape hatch for legitimately-silent work", () => {
	test("a silent, zero-CPU command survives the idle window when the flag is set", async () => {
		// this is the remote-deploy case: no output, no LOCAL cpu (work is on the
		// server). `sleep` is the perfect stand-in — silent and 0 CPU. with the
		// flag, only the wall-clock timeout bounds it, so it runs to completion.
		const { isError, text } = await run(
			{ cmd: "sleep 4; echo deployed", timeout: 30, may_run_silent: true },
			1,
		);
		expect(isError).toBe(false);
		expect(text).toContain("deployed");
		expect(text).not.toMatch(/no output and no CPU/);
	}, 20000);

	test("WITHOUT the flag, the same silent zero-CPU command IS killed", async () => {
		// proves the flag is what saves it — the remote deploy really would die.
		const { isError, text } = await run({ cmd: "sleep 30; echo deployed", timeout: 30 }, 1);
		expect(isError).toBe(true);
		expect(text).toMatch(/no output and no CPU/);
		expect(text).not.toContain("deployed");
	}, 20000);

	test("the flag does NOT let a command run forever — the wall clock still bounds it", async () => {
		// may_run_silent turns OFF the idle kill, not the declared timeout. a
		// genuinely hung remote command still dies at its declared budget.
		const { isError, text, ms } = await run(
			{ cmd: "sleep 30", timeout: 2, may_run_silent: true },
			1,
		);
		expect(isError).toBe(true);
		expect(text).toMatch(/timed out after 2 seconds/);
		expect(ms).toBeLessThan(8000);
	}, 20000);

	test("accepts the aliases mayRunSilent and expect_silent", async () => {
		for (const key of ["mayRunSilent", "expect_silent"]) {
			const { isError } = await run(
				{ cmd: "sleep 4; echo ok", timeout: 30, [key]: true } as any,
				1,
			);
			expect(isError).toBe(false);
		}
	}, 30000);
});

describe("may_run_silent: schema and guidance", () => {
	const tool = createBashTool();
	const params = tool.parameters as any;

	test("is an optional boolean — timeout stays the ONLY required property", () => {
		expect(params.required).toEqual(["timeout"]);
		expect(params.properties.may_run_silent.type).toBe("boolean");
	});

	test("the description teaches the remote-deploy case up front", () => {
		expect(tool.description).toMatch(/may_run_silent/);
		expect(tool.description).toMatch(/remote server|other machine/i);
	});

	test("the kill message points to may_run_silent, NOT a longer timeout", async () => {
		const { text } = await run({ cmd: "sleep 30", timeout: 600 }, 1);
		expect(text).toMatch(/may_run_silent: true/);
		expect(text).toMatch(/longer timeout will NOT help/);
	}, 20000);
});

// ------------------------------------------------------------- process hygiene

describe("process hygiene", () => {
	let dir: string;
	beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "bash-idle-")); });
	afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

	test("the whole process GROUP dies — no orphan outlives the kill", async () => {
		const marker = join(dir, "orphan.txt");
		// a backgrounded grandchild that would write 3s from now, behind a parent
		// that never exits. if only the direct child were killed, the marker lands.
		await run(
			{ cmd: `(sleep 3; echo ORPHANED > "${marker}") & sleep 30`, timeout: 600 },
			1,
		);
		await new Promise((r) => setTimeout(r, 4000));
		expect(existsSync(marker)).toBe(false);
	}, 30000);

	test("a normally-exiting command leaves no interval keeping the runtime alive", async () => {
		// if the idle interval were not cleared, bun would hang here rather than
		// finishing the test file.
		const { isError } = await run({ cmd: "echo quick", timeout: 30 }, 1);
		expect(isError).toBe(false);
	}, 20000);
});

// ------------------------------------------------------------------- env knobs

describe("env overrides", () => {
	test("PI_BASH_MAX_TIMEOUT_SEC raises the ceiling in the schema AND the net", async () => {
		process.env.PI_BASH_MAX_TIMEOUT_SEC = "1800";
		try {
			const params = createBashTool().parameters as any;
			expect(params.properties.timeout.maximum).toBe(1800);
			expect(maxTimeoutSec()).toBe(1800);
			const { isError } = await run({ cmd: "echo HIGH_CEILING", timeout: 1200 });
			expect(isError).toBe(false);
		} finally {
			delete process.env.PI_BASH_MAX_TIMEOUT_SEC;
		}
	}, 20000);

	test("garbage env values fall back to the defaults rather than disabling the guard", () => {
		for (const junk of ["abc", "-1", "", "   ", "NaN"]) {
			process.env.PI_BASH_MAX_TIMEOUT_SEC = junk;
			process.env.PI_BASH_IDLE_KILL_SEC = junk;
			expect(maxTimeoutSec()).toBe(600);
			expect(idleKillSec()).toBe(300);
		}
		delete process.env.PI_BASH_MAX_TIMEOUT_SEC;
		delete process.env.PI_BASH_IDLE_KILL_SEC;
	});

	test("defaults are 600 / 300 with no env set", () => {
		delete process.env.PI_BASH_MAX_TIMEOUT_SEC;
		delete process.env.PI_BASH_IDLE_KILL_SEC;
		expect(maxTimeoutSec()).toBe(600);
		expect(idleKillSec()).toBe(300);
	});

	test("a fractional env value is floored, not rejected", () => {
		process.env.PI_BASH_IDLE_KILL_SEC = "12.9";
		expect(idleKillSec()).toBe(12);
		delete process.env.PI_BASH_IDLE_KILL_SEC;
	});
});

// --------------------------------------------------------------- interactions

describe("interaction with the other guards", () => {
	test("abort still wins over both timers", async () => {
		const controller = new AbortController();
		const tool = createBashTool();
		setTimeout(() => controller.abort(), 300);
		const result: any = await tool.execute!(
			"t",
			{ cmd: "sleep 30", timeout: 600 } as any,
			controller.signal,
			undefined,
			mockCtx,
		);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toMatch(/command aborted/);
		expect(result.content[0].text).not.toMatch(/no output and no CPU/);
	}, 20000);

	test("a missing timeout is refused before the permission engine runs", async () => {
		// `rm -rf /` is rejected by permissions.json. without a timeout the call is
		// not a well-formed command yet, so the cheaper check must answer first.
		const { text } = await run({ cmd: "rm -rf /" });
		expect(text).toMatch(/timeout required/);
	});

	test("a valid timeout still lets the permission engine reject", async () => {
		const { text, isError } = await run({ cmd: "rm -rf /tmp/definitely-not-real-xyz", timeout: 30 });
		expect(isError).toBe(true);
		expect(text).toMatch(/rejected|trash/i);
	});

	test("cd-splitting still works with a timeout present", async () => {
		const { text, isError } = await run({ cmd: `cd /tmp && echo IN_TMP`, timeout: 30 });
		expect(isError).toBe(false);
		expect(text).toContain("IN_TMP");
	});
});
