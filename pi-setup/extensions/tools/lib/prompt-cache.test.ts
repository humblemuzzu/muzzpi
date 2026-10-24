import { describe, expect, test } from "bun:test";
import {
	type CapturedRequest,
	FIVE_MINUTES_MS,
	HOUR_MS,
	isReplayable,
	KeepAlive,
	type KeepAliveDeps,
	payloadTtlMs,
	pingBudget,
	pingPayload,
	writtenTtlMs,
} from "./prompt-cache";

const MINUTE = 60_000;
const opus = { provider: "anthropic", id: "claude-opus-5-5", cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 } } as any;

function payload(ttl: "1h" | "5m", extra: Record<string, unknown> = {}): Record<string, unknown> {
	const cache_control = ttl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
	return {
		model: "claude-opus-5-5",
		max_tokens: 128_000,
		system: [{ type: "text", text: "system", cache_control }],
		thinking: { type: "adaptive" },
		messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control }] }],
		...extra,
	};
}

const usage = (cacheRead: number, cacheWrite = 0, cacheWrite1h = cacheWrite) => ({
	input: 2,
	output: 1,
	cacheRead,
	cacheWrite,
	cacheWrite1h,
	totalTokens: cacheRead + cacheWrite + 3,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

describe("prompt cache rules", () => {
	test("the lifetime is what the payload's breakpoints ask for", () => {
		expect(payloadTtlMs(payload("1h"))).toBe(HOUR_MS);
		expect(payloadTtlMs(payload("5m"))).toBe(FIVE_MINUTES_MS);
	});

	test("the receipt is 1h only when all of a write was kept for 1h", () => {
		expect(writtenTtlMs(usage(0, 5000, 5000))).toBe(HOUR_MS);
		expect(writtenTtlMs(usage(0, 5000, 0))).toBe(FIVE_MINUTES_MS);
		expect(writtenTtlMs(usage(0, 5000, 4000))).toBe(FIVE_MINUTES_MS);
		expect(writtenTtlMs({ cacheWrite: 5000 })).toBe(FIVE_MINUTES_MS);
		expect(writtenTtlMs(usage(9000, 0))).toBeUndefined();
	});

	test("a replay changes only max_tokens and leaves the capture alone", () => {
		const captured = payload("1h");
		const before = JSON.stringify(captured);
		const ping = pingPayload(captured);
		expect(ping.max_tokens).toBe(1);
		expect(JSON.stringify({ ...ping, max_tokens: 128_000 })).toBe(before);
		expect(JSON.stringify(captured)).toBe(before);
	});

	test("budget thinking is never replayed; adaptive or none is", () => {
		expect(isReplayable(payload("1h"))).toBe(true);
		expect(isReplayable(payload("1h", { thinking: undefined }))).toBe(true);
		expect(isReplayable(payload("1h", { thinking: { type: "enabled", budget_tokens: 4000 } }))).toBe(false);
	});

	test("reads are allowed up to the price of the rebuild they prevent", () => {
		expect(pingBudget(opus, 650_000, HOUR_MS)).toBe(38);
		expect(pingBudget(opus, 650_000, FIVE_MINUTES_MS)).toBe(23);
		expect(pingBudget(opus, 0, HOUR_MS)).toBe(0);
		expect(pingBudget({ ...opus, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }, 650_000, HOUR_MS)).toBe(0);
	});
});

function harness(options: { budget?: number; failures?: number } = {}) {
	let failures = options.failures ?? 0;
	let now = 0;
	let timers: Array<{ at: number; fire: () => void }> = [];
	const pings: Array<{ at: number; payload: Record<string, unknown> }> = [];
	const warmed: number[] = [];
	const deps: KeepAliveDeps = {
		now: () => now,
		schedule: (fire, ms) => {
			const timer = { at: now + ms, fire };
			timers.push(timer);
			return () => {
				timers = timers.filter((t) => t !== timer);
			};
		},
		budget: () => options.budget ?? 38,
		ping: async (_capture, sent) => {
			pings.push({ at: now, payload: sent });
			if (failures > 0) {
				failures--;
				return undefined;
			}
			return usage(650_000);
		},
		warmed: () => warmed.push(now),
	};
	const keepAlive = new KeepAlive(deps);
	const settle = () => new Promise((resolve) => setImmediate(resolve));
	const advanceTo = async (target: number) => {
		for (;;) {
			const due = timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
			if (!due) break;
			timers = timers.filter((t) => t !== due);
			now = Math.max(now, due.at);
			due.fire();
			await settle();
		}
		now = target;
	};
	const capture = (ttl: "1h" | "5m", at = now, extra: Record<string, unknown> = {}): CapturedRequest => ({
		payload: payload(ttl, extra),
		messages: [],
		sessionId: "s1",
		modelId: "claude-opus-5-5",
		at,
	});
	const jump = (to: number) => {
		now = to;
	};
	return { keepAlive, pings, warmed, advanceTo, capture, jump, timers: () => timers };
}

describe("KeepAlive", () => {
	test("keeps the main session's 1h entry warm while a background agent runs: one read per lifetime, 54 minutes in", async () => {
		const h = harness();
		h.keepAlive.request(h.capture("1h"));
		h.keepAlive.answered(usage(640_000, 10_000));
		h.keepAlive.backgroundRuns(1);
		await h.advanceTo(2 * HOUR_MS);
		expect(h.pings.map((p) => p.at)).toEqual([54 * MINUTE, 108 * MINUTE]);
		expect(h.pings.every((p) => p.payload.max_tokens === 1)).toBe(true);
		expect(h.warmed).toEqual([54 * MINUTE, 108 * MINUTE]);
	});

	test("never reads for an idle session nobody is waiting on", async () => {
		const h = harness();
		h.keepAlive.request(h.capture("1h"));
		h.keepAlive.answered(usage(640_000, 10_000));
		await h.advanceTo(2 * HOUR_MS);
		expect(h.pings).toEqual([]);
	});

	test("a sub-agent's 5m entry is read every 4.5 minutes while a long tool call runs, and not after the turn", async () => {
		const h = harness();
		h.keepAlive.turn(true);
		h.keepAlive.request(h.capture("5m"));
		h.keepAlive.answered(usage(300_000, 2_000));
		await h.advanceTo(10 * MINUTE);
		expect(h.pings.map((p) => p.at)).toEqual([270_000, 540_000]);
		h.keepAlive.turn(false);
		await h.advanceTo(30 * MINUTE);
		expect(h.pings).toHaveLength(2);
	});

	test("a new request restarts the lifetime", async () => {
		const h = harness();
		h.keepAlive.backgroundRuns(1);
		h.keepAlive.request(h.capture("1h"));
		h.keepAlive.answered(usage(640_000, 10_000));
		await h.advanceTo(40 * MINUTE);
		h.keepAlive.request(h.capture("1h"));
		await h.advanceTo(90 * MINUTE);
		expect(h.pings).toEqual([]);
		await h.advanceTo(95 * MINUTE);
		expect(h.pings.map((p) => p.at)).toEqual([94 * MINUTE]);
	});

	test("a timer that fires too late leaves the entry alone: a read of a missing entry would rewrite it", async () => {
		const h = harness();
		h.keepAlive.backgroundRuns(1);
		h.keepAlive.request(h.capture("1h"));
		h.keepAlive.answered(usage(640_000, 10_000));
		h.jump(58 * MINUTE);
		await h.advanceTo(58 * MINUTE);
		expect(h.pings).toEqual([]);
	});

	test("stops once the reads have cost what one rebuild would", async () => {
		const h = harness({ budget: 2 });
		h.keepAlive.backgroundRuns(1);
		h.keepAlive.request(h.capture("1h"));
		h.keepAlive.answered(usage(640_000, 10_000));
		await h.advanceTo(5 * HOUR_MS);
		expect(h.pings).toHaveLength(2);
	});

	test("a failed read is retried once inside the safe window, then the keep-alive carries on", async () => {
		const h = harness({ failures: 1 });
		h.keepAlive.backgroundRuns(1);
		h.keepAlive.request(h.capture("1h"));
		h.keepAlive.answered(usage(640_000, 10_000));
		await h.advanceTo(2 * HOUR_MS);
		expect(h.pings.map((p) => p.at)).toEqual([54 * MINUTE, 55.5 * MINUTE, 109.5 * MINUTE]);
		expect(h.warmed).toEqual([55.5 * MINUTE, 109.5 * MINUTE]);
	});

	test("two failed reads in a row stop the keep-alive until the next request, and run broadcasts do not revive it", async () => {
		const h = harness({ failures: 2 });
		h.keepAlive.backgroundRuns(1);
		h.keepAlive.request(h.capture("1h"));
		h.keepAlive.answered(usage(640_000, 10_000));
		await h.advanceTo(3 * HOUR_MS);
		h.keepAlive.backgroundRuns(2);
		expect(h.timers()).toEqual([]);
		expect(h.pings).toHaveLength(2);
		expect(h.warmed).toEqual([]);
	});

	test("a request that never reached the cache leaves the previous request as the entry, age and payload", async () => {
		const h = harness();
		h.keepAlive.backgroundRuns(1);
		h.keepAlive.request(h.capture("1h", 0, { marker: "first" }));
		h.keepAlive.answered(usage(640_000, 10_000));
		await h.advanceTo(10 * MINUTE);
		h.keepAlive.request(h.capture("1h", 10 * MINUTE, { marker: "second" }));
		h.keepAlive.answered(usage(0, 0));
		await h.advanceTo(55 * MINUTE);
		expect(h.pings.map((p) => [p.at, p.payload.marker])).toEqual([[54 * MINUTE, "first"]]);
	});

	test("a first request that never reached the cache leaves nothing to keep warm", async () => {
		const h = harness();
		h.keepAlive.backgroundRuns(1);
		h.keepAlive.request(h.capture("1h"));
		h.keepAlive.answered(usage(0, 0));
		expect(h.keepAlive.capture).toBeUndefined();
		await h.advanceTo(2 * HOUR_MS);
		expect(h.pings).toEqual([]);
	});

	test("an agent continued from the agents UI makes an idle session wait again", async () => {
		const h = harness();
		h.keepAlive.request(h.capture("1h"));
		h.keepAlive.answered(usage(640_000, 10_000));
		await h.advanceTo(55 * MINUTE);
		expect(h.pings).toEqual([]);
		h.keepAlive.backgroundRuns(1);
		await h.advanceTo(56 * MINUTE);
		expect(h.pings.map((p) => p.at)).toEqual([55 * MINUTE]);
	});

	test("a 1h label that Anthropic kept for only 5 minutes is read at 4.5 minutes", async () => {
		const h = harness();
		h.keepAlive.backgroundRuns(1);
		h.keepAlive.request(h.capture("1h"));
		h.keepAlive.answered(usage(640_000, 10_000, 0));
		expect(h.keepAlive.lifetimeMs).toBe(FIVE_MINUTES_MS);
		await h.advanceTo(5 * MINUTE);
		expect(h.pings.map((p) => p.at)).toEqual([270_000]);
	});

	test("a reply that only read keeps the last receipt, and a receipt never lengthens the label", async () => {
		const h = harness();
		h.keepAlive.request(h.capture("1h"));
		h.keepAlive.answered(usage(640_000, 10_000, 0));
		h.keepAlive.request(h.capture("1h"));
		h.keepAlive.answered(usage(650_000, 0));
		expect(h.keepAlive.lifetimeMs).toBe(FIVE_MINUTES_MS);
		h.keepAlive.request(h.capture("1h"));
		h.keepAlive.answered(usage(650_000, 400, 400));
		expect(h.keepAlive.lifetimeMs).toBe(HOUR_MS);
		h.keepAlive.request(h.capture("5m"));
		h.keepAlive.answered(usage(650_000, 400, 400));
		expect(h.keepAlive.lifetimeMs).toBe(FIVE_MINUTES_MS);
	});

	test("forget drops the entry and its timer", async () => {
		const h = harness();
		h.keepAlive.backgroundRuns(1);
		h.keepAlive.request(h.capture("1h"));
		h.keepAlive.forget();
		expect(h.timers()).toEqual([]);
		await h.advanceTo(2 * HOUR_MS);
		expect(h.pings).toEqual([]);
	});
});
