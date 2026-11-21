import { describe, expect, test } from "bun:test";
import type { Usage } from "@earendil-works/pi-ai";
import { KeepAlive, type KeepAliveDeps, LIFETIME_MS, PING_AFTER_MS, pingBudget, RETRY_AFTER_MS, STALE_AFTER_MS } from "./keep-alive";
import type { Envelope } from "./wire";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;

function envelope(marker: string): Envelope {
	return {
		project: "aicode-consumers",
		requestId: "agent/c/1/t/3",
		request: {
			contents: [{ role: "user", parts: [{ text: marker }] }],
			labels: { request_id: "t-2" },
			generationConfig: { maxOutputTokens: 262144, thinkingConfig: { includeThoughts: true, thinkingLevel: "HIGH" }, stopSequences: [] },
			sessionId: "-1",
		},
		model: "gemini-4-neon-high",
		userAgent: "antigravity",
		requestType: "agent",
	};
}

const read = (cacheRead: number, input = 2_050): Usage => ({
	input,
	output: 1,
	cacheRead,
	cacheWrite: 0,
	totalTokens: input + cacheRead + 1,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

/** A reply, or what a read does while it runs (the clock may move) before it answers. */
type Reply = Usage | undefined | (() => Usage | undefined);

function harness(replies: Reply[] = []) {
	let now = 0;
	let timers: Array<{ at: number; fire: () => void }> = [];
	const pings: Array<{ at: number; payload: Envelope; signal: AbortSignal }> = [];
	const warmed: number[] = [];
	let hold: Promise<void> | undefined;
	const deps: KeepAliveDeps = {
		now: () => now,
		schedule: (fire, ms) => {
			const timer = { at: now + ms, fire };
			timers.push(timer);
			return () => {
				timers = timers.filter((t) => t !== timer);
			};
		},
		ping: async (payload, signal) => {
			pings.push({ at: now, payload, signal });
			if (hold) await hold;
			if (replies.length === 0) return read(698_000);
			const reply = replies.shift();
			return typeof reply === "function" ? reply() : reply;
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
	const jump = (to: number) => {
		now = to;
	};
	const holdPings = () => {
		const gate = Promise.withResolvers<void>();
		hold = gate.promise;
		return () => {
			hold = undefined;
			gate.resolve();
		};
	};
	const failsAfter = (ms: number): Reply => () => {
		now += ms;
		return undefined;
	};
	return { keepAlive, pings, warmed, replies, advanceTo, jump, holdPings, failsAfter, timers: () => timers };
}

describe("ping budget", () => {
	test("reads are allowed up to two-thirds of the price of the rebuild they prevent", () => {
		expect(pingBudget(920_000)).toBe(12);
		expect(pingBudget(700_000)).toBe(11);
		expect(pingBudget(36_000)).toBe(5);
		expect(pingBudget(10_000)).toBe(2);
		expect(pingBudget(4_095)).toBe(0);
		expect(pingBudget(0)).toBe(0);
	});
});

describe("Gemini keep-alive", () => {
	test("timing constants match the measured 5m lifetime with 4m ping and 4m35s stale cutoff", () => {
		expect(LIFETIME_MS).toBe(5 * MINUTE);
		expect(PING_AFTER_MS).toBe(4 * MINUTE);
		expect(STALE_AFTER_MS).toBe(275 * SECOND);
		expect(RETRY_AFTER_MS).toBe(3 * SECOND);
	});

	test("reads the last request's prompt every 4 minutes while busy, until the budget is spent", async () => {
		const h = harness();
		h.keepAlive.turn(true);
		h.keepAlive.request(envelope("turn"));
		h.keepAlive.answered(10_000);
		await h.advanceTo(30 * MINUTE);
		expect(h.pings.map((p) => p.at)).toEqual([PING_AFTER_MS, 2 * PING_AFTER_MS]);
		expect(h.pings.every((p) => p.payload.request.generationConfig.maxOutputTokens === 1)).toBe(true);
		expect(h.pings.every((p) => p.payload.request.labels.prompt_cache_keep_alive === "true")).toBe(true);
		expect(h.pings[0]!.payload.request.contents).toEqual(envelope("turn").request.contents);
		expect(h.warmed).toEqual([PING_AFTER_MS, 2 * PING_AFTER_MS]);
	});

	test("never pings while idle or after a session settles with no background runs", async () => {
		const h = harness();
		h.keepAlive.turn(true);
		h.keepAlive.request(envelope("turn"));
		h.keepAlive.answered(700_000);
		expect(h.keepAlive.scheduled).toBe(true);
		h.keepAlive.turn(false);
		expect(h.keepAlive.scheduled).toBe(false);
		await h.advanceTo(30 * MINUTE);
		expect(h.pings).toEqual([]);
	});

	test("keeps pinging after a turn settles while background agents or bash jobs are running, then stops when they finish", async () => {
		const h = harness();
		h.keepAlive.turn(true);
		h.keepAlive.request(envelope("spawned"));
		h.keepAlive.answered(700_000);
		h.keepAlive.backgroundRuns(1);
		h.keepAlive.turn(false);
		expect(h.keepAlive.scheduled).toBe(true);

		await h.advanceTo(2 * PING_AFTER_MS + SECOND);
		expect(h.pings.map((p) => p.at)).toEqual([PING_AFTER_MS, 2 * PING_AFTER_MS]);

		h.keepAlive.backgroundRuns(0);
		expect(h.keepAlive.scheduled).toBe(false);
		await h.advanceTo(30 * MINUTE);
		expect(h.pings).toHaveLength(2);
	});

	test("a background run started while idle resumes warming if fresh, and drops if already stale", async () => {
		const h = harness();
		h.keepAlive.turn(true);
		h.keepAlive.request(envelope("fresh"));
		h.keepAlive.answered(700_000);
		h.keepAlive.turn(false);
		await h.advanceTo(2 * MINUTE);
		h.keepAlive.backgroundRuns(1);
		await h.advanceTo(PING_AFTER_MS + SECOND);
		expect(h.pings.map((p) => p.at)).toEqual([PING_AFTER_MS]);

		h.keepAlive.backgroundRuns(0);
		await h.advanceTo(PING_AFTER_MS + STALE_AFTER_MS + SECOND);
		h.keepAlive.backgroundRuns(1);
		expect(h.keepAlive.scheduled).toBe(false);
		await h.advanceTo(30 * MINUTE);
		expect(h.pings).toHaveLength(1);
	});

	test("counts the 4-minute clock from request send (prefill start), not reply completion", async () => {
		const h = harness();
		h.keepAlive.turn(true);
		h.keepAlive.request(envelope("thinking"));
		// Model thinks and streams for 45 seconds before message_end.
		await h.advanceTo(45 * SECOND);
		h.keepAlive.answered(700_000);
		await h.advanceTo(PING_AFTER_MS + SECOND);
		expect(h.pings.map((p) => p.at)).toEqual([PING_AFTER_MS]);
	});

	test("a decode past 4m but before stale waits 1s so fast local tools send their real request first", async () => {
		const h = harness();
		h.keepAlive.turn(true);
		h.keepAlive.request(envelope("long-decode"));
		await h.advanceTo(250 * SECOND);
		h.keepAlive.answered(700_000);
		// A fast tool finishes 50ms later and sends the next request — no redundant ping.
		await h.advanceTo(250 * SECOND + 50);
		h.keepAlive.request(envelope("next-turn"));
		expect(h.pings).toEqual([]);

		// If instead a slow tool/background wait runs, the ping fires 1s later (still before 275s stale).
		const h2 = harness();
		h2.keepAlive.turn(true);
		h2.keepAlive.request(envelope("long-decode"));
		await h2.advanceTo(250 * SECOND);
		h2.keepAlive.answered(700_000);
		await h2.advanceTo(252 * SECOND);
		expect(h2.pings.map((p) => p.at)).toEqual([251 * SECOND]);
	});

	test("a decode already past the stale cutoff drops the entry instead of pinging a gone cache", async () => {
		const h = harness();
		h.keepAlive.turn(true);
		h.keepAlive.request(envelope("very-long"));
		await h.advanceTo(STALE_AFTER_MS + SECOND);
		h.keepAlive.answered(700_000);
		expect(h.keepAlive.scheduled).toBe(false);
		await h.advanceTo(10 * MINUTE);
		expect(h.pings).toEqual([]);
	});

	test("starting a new turn does not race it with a read of an older entry", async () => {
		const h = harness();
		h.keepAlive.turn(true);
		h.keepAlive.request(envelope("old"));
		h.keepAlive.answered(700_000);
		h.keepAlive.turn(false);
		await h.advanceTo(250 * SECOND);
		h.keepAlive.turn(true);
		expect(h.keepAlive.scheduled).toBe(false);
		expect(h.pings).toEqual([]);
	});

	test("never reads while a request is in flight, and a new request takes over from its send time", async () => {
		const h = harness();
		h.keepAlive.turn(true);
		h.keepAlive.request(envelope("first"));
		h.keepAlive.answered(700_000);
		await h.advanceTo(PING_AFTER_MS - SECOND);
		h.keepAlive.request(envelope("second"));
		await h.advanceTo(5 * MINUTE);
		expect(h.pings).toEqual([]);
		h.keepAlive.answered(705_000);
		await h.advanceTo(PING_AFTER_MS - SECOND + PING_AFTER_MS + SECOND);
		expect(h.pings.map((p) => p.payload.request.contents[0])).toEqual([{ role: "user", parts: [{ text: "second" }] }]);
	});

	test("a request aborts a read in flight and the read counts for nothing", async () => {
		const h = harness();
		h.keepAlive.turn(true);
		h.keepAlive.request(envelope("first"));
		h.keepAlive.answered(700_000);
		const release = h.holdPings();
		await h.advanceTo(PING_AFTER_MS);
		expect(h.pings).toHaveLength(1);
		h.keepAlive.request(envelope("second"));
		expect(h.pings[0]!.signal.aborted).toBe(true);
		release();
		await h.advanceTo(PING_AFTER_MS + SECOND);
		expect(h.warmed).toEqual([]);
		expect(h.keepAlive.scheduled).toBe(false);
	});

	test("a reply that reported no prompt keeps the entry it had, on its old clock", async () => {
		const h = harness();
		h.keepAlive.turn(true);
		h.keepAlive.request(envelope("kept"));
		h.keepAlive.answered(700_000);
		await h.advanceTo(10 * SECOND);
		h.keepAlive.request(envelope("aborted"));
		await h.advanceTo(20 * SECOND);
		h.keepAlive.answered(0);
		await h.advanceTo(PING_AFTER_MS + SECOND);
		expect(h.pings.map((p) => [p.at, p.payload.request.contents[0]])).toEqual([
			[PING_AFTER_MS, { role: "user", parts: [{ text: "kept" }] }],
		]);
	});

	test("a timer that wakes too late leaves the entry alone: reading a gone entry is a full rebuild", async () => {
		const h = harness();
		h.keepAlive.turn(true);
		h.keepAlive.request(envelope("turn"));
		h.keepAlive.answered(700_000);
		h.jump(10 * MINUTE);
		await h.advanceTo(10 * MINUTE);
		expect(h.pings).toEqual([]);
		expect(h.keepAlive.scheduled).toBe(false);
	});

	test("a read that found the cache gone stops this entry; two in a row stop pings for the session", async () => {
		const h = harness([read(0, 700_000), read(0, 700_000)]);
		h.keepAlive.turn(true);
		h.keepAlive.request(envelope("one"));
		h.keepAlive.answered(700_000);
		await h.advanceTo(10 * MINUTE);
		expect(h.pings).toHaveLength(1);
		expect(h.warmed).toHaveLength(1);

		h.keepAlive.request(envelope("two"));
		h.keepAlive.answered(705_000);
		await h.advanceTo(20 * MINUTE);
		expect(h.pings).toHaveLength(2);

		h.keepAlive.request(envelope("three"));
		h.keepAlive.answered(710_000);
		await h.advanceTo(30 * MINUTE);
		expect(h.pings).toHaveLength(2);

		h.keepAlive.reset();
		h.keepAlive.turn(true);
		h.keepAlive.request(envelope("new session"));
		h.keepAlive.answered(10_000);
		await h.advanceTo(30 * MINUTE + PING_AFTER_MS);
		expect(h.pings).toHaveLength(3);
	});

	test("a hit between misses clears the count", async () => {
		const h = harness([read(0, 700_000), read(698_000), read(0, 700_000)]);
		h.keepAlive.turn(true);
		h.keepAlive.request(envelope("one"));
		h.keepAlive.answered(700_000);
		await h.advanceTo(5 * MINUTE);
		h.keepAlive.request(envelope("two"));
		h.keepAlive.answered(705_000);
		await h.advanceTo(5 * MINUTE + 2 * PING_AFTER_MS);
		expect(h.pings).toHaveLength(3);
		h.keepAlive.request(envelope("three"));
		h.keepAlive.answered(710_000);
		await h.advanceTo(30 * MINUTE);
		expect(h.pings.length).toBeGreaterThan(3);
	});

	test("a failed read is tried once more 3 seconds later, and the keep-alive carries on", async () => {
		const h = harness([undefined]);
		h.keepAlive.turn(true);
		h.keepAlive.request(envelope("turn"));
		h.keepAlive.answered(10_000);
		await h.advanceTo(20 * MINUTE);
		const retry = PING_AFTER_MS + RETRY_AFTER_MS;
		expect(h.pings.map((p) => p.at)).toEqual([PING_AFTER_MS, retry, retry + PING_AFTER_MS]);
		expect(h.warmed).toEqual([retry, retry + PING_AFTER_MS]);
	});

	test("two failed reads in a row drop the entry until the next reply", async () => {
		const h = harness([undefined, undefined]);
		h.keepAlive.turn(true);
		h.keepAlive.request(envelope("turn"));
		h.keepAlive.answered(700_000);
		await h.advanceTo(10 * MINUTE);
		expect(h.pings).toHaveLength(2);
		expect(h.warmed).toEqual([]);
		h.keepAlive.request(envelope("next"));
		h.keepAlive.answered(705_000);
		await h.advanceTo(10 * MINUTE + PING_AFTER_MS);
		expect(h.pings).toHaveLength(3);
	});

	test("a read that failed too late to retry before the entry goes stale is not retried", async () => {
		const h = harness();
		h.replies.push(h.failsAfter(STALE_AFTER_MS - PING_AFTER_MS));
		h.keepAlive.turn(true);
		h.keepAlive.request(envelope("turn"));
		h.keepAlive.answered(700_000);
		await h.advanceTo(10 * MINUTE);
		expect(h.pings).toHaveLength(1);
		expect(h.keepAlive.scheduled).toBe(false);
	});

	test("forget drops the entry and its timer without losing active turn state", async () => {
		const h = harness();
		h.keepAlive.turn(true);
		h.keepAlive.request(envelope("turn"));
		h.keepAlive.answered(700_000);
		h.keepAlive.forget();
		expect(h.timers()).toEqual([]);
		await h.advanceTo(10 * MINUTE);
		expect(h.pings).toEqual([]);
		// After compaction mid-turn, the next request still warms without another turn(true).
		h.keepAlive.request(envelope("post-compact"));
		h.keepAlive.answered(700_000);
		await h.advanceTo(10 * MINUTE + PING_AFTER_MS);
		expect(h.pings).toHaveLength(1);
	});

	test("a prompt too short to cache is never read", async () => {
		const h = harness();
		h.keepAlive.turn(true);
		h.keepAlive.request(envelope("tiny"));
		h.keepAlive.answered(3_000);
		await h.advanceTo(30 * MINUTE);
		expect(h.pings).toEqual([]);
	});
});
