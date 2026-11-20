import { describe, expect, test } from "bun:test";
import type { Usage } from "@earendil-works/pi-ai";
import { KeepAlive, type KeepAliveDeps, PING_AFTER_MS, pingBudget, RETRY_AFTER_MS } from "./keep-alive";
import type { Envelope } from "./wire";

const SECOND = 1_000;

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
	test("reads are allowed up to the price of the rebuild they prevent", () => {
		expect(pingBudget(920_000)).toBe(18);
		expect(pingBudget(700_000)).toBe(17);
		expect(pingBudget(36_000)).toBe(8);
		expect(pingBudget(10_000)).toBe(3);
		expect(pingBudget(4_095)).toBe(0);
		expect(pingBudget(0)).toBe(0);
	});
});

describe("Gemini keep-alive", () => {
	test("reads the last request's prompt every 30 seconds after its reply, until the budget is spent", async () => {
		const h = harness();
		h.keepAlive.request(envelope("turn"));
		h.keepAlive.answered(10_000);
		await h.advanceTo(10 * 60 * SECOND);
		expect(h.pings.map((p) => p.at)).toEqual([PING_AFTER_MS, 2 * PING_AFTER_MS, 3 * PING_AFTER_MS]);
		expect(h.pings.every((p) => p.payload.request.generationConfig.maxOutputTokens === 1)).toBe(true);
		expect(h.pings.every((p) => p.payload.request.labels.prompt_cache_keep_alive === "true")).toBe(true);
		expect(h.pings[0]!.payload.request.contents).toEqual(envelope("turn").request.contents);
		expect(h.warmed).toEqual([PING_AFTER_MS, 2 * PING_AFTER_MS, 3 * PING_AFTER_MS]);
	});

	test("never reads while a request is in flight, and a new request takes over from its reply", async () => {
		const h = harness();
		h.keepAlive.request(envelope("first"));
		h.keepAlive.answered(700_000);
		await h.advanceTo(PING_AFTER_MS - SECOND);
		h.keepAlive.request(envelope("second"));
		await h.advanceTo(5 * 60 * SECOND);
		expect(h.pings).toEqual([]);
		h.keepAlive.answered(705_000);
		await h.advanceTo(5 * 60 * SECOND + PING_AFTER_MS);
		expect(h.pings.map((p) => p.payload.request.contents[0])).toEqual([{ role: "user", parts: [{ text: "second" }] }]);
	});

	test("a request aborts a read in flight and the read counts for nothing", async () => {
		const h = harness();
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
		h.keepAlive.request(envelope("turn"));
		h.keepAlive.answered(700_000);
		h.jump(5 * 60 * SECOND);
		await h.advanceTo(5 * 60 * SECOND);
		expect(h.pings).toEqual([]);
		expect(h.keepAlive.scheduled).toBe(false);
	});

	test("a read that found the cache gone stops this entry; two in a row stop pings for the session", async () => {
		const h = harness([read(0, 700_000), read(0, 700_000)]);
		h.keepAlive.request(envelope("one"));
		h.keepAlive.answered(700_000);
		await h.advanceTo(2 * 60 * SECOND);
		expect(h.pings).toHaveLength(1);
		expect(h.warmed).toHaveLength(1);

		h.keepAlive.request(envelope("two"));
		h.keepAlive.answered(705_000);
		await h.advanceTo(4 * 60 * SECOND);
		expect(h.pings).toHaveLength(2);

		h.keepAlive.request(envelope("three"));
		h.keepAlive.answered(710_000);
		await h.advanceTo(6 * 60 * SECOND);
		expect(h.pings).toHaveLength(2);

		h.keepAlive.reset();
		h.keepAlive.request(envelope("new session"));
		h.keepAlive.answered(10_000);
		await h.advanceTo(6 * 60 * SECOND + PING_AFTER_MS);
		expect(h.pings).toHaveLength(3);
	});

	test("a hit between misses clears the count", async () => {
		const h = harness([read(0, 700_000), read(698_000), read(0, 700_000)]);
		h.keepAlive.request(envelope("one"));
		h.keepAlive.answered(700_000);
		await h.advanceTo(60 * SECOND);
		h.keepAlive.request(envelope("two"));
		h.keepAlive.answered(705_000);
		await h.advanceTo(60 * SECOND + 2 * PING_AFTER_MS);
		expect(h.pings).toHaveLength(3);
		h.keepAlive.request(envelope("three"));
		h.keepAlive.answered(710_000);
		await h.advanceTo(5 * 60 * SECOND);
		expect(h.pings.length).toBeGreaterThan(3);
	});

	test("a failed read is tried once more 3 seconds later, and the keep-alive carries on", async () => {
		const h = harness([undefined]);
		h.keepAlive.request(envelope("turn"));
		h.keepAlive.answered(10_000);
		await h.advanceTo(5 * 60 * SECOND);
		const retry = PING_AFTER_MS + RETRY_AFTER_MS;
		expect(h.pings.map((p) => p.at)).toEqual([PING_AFTER_MS, retry, retry + PING_AFTER_MS, retry + 2 * PING_AFTER_MS]);
		expect(h.warmed).toEqual([retry, retry + PING_AFTER_MS, retry + 2 * PING_AFTER_MS]);
	});

	test("two failed reads in a row drop the entry until the next reply", async () => {
		const h = harness([undefined, undefined]);
		h.keepAlive.request(envelope("turn"));
		h.keepAlive.answered(700_000);
		await h.advanceTo(5 * 60 * SECOND);
		expect(h.pings).toHaveLength(2);
		expect(h.warmed).toEqual([]);
		h.keepAlive.request(envelope("next"));
		h.keepAlive.answered(705_000);
		await h.advanceTo(5 * 60 * SECOND + PING_AFTER_MS);
		expect(h.pings).toHaveLength(3);
	});

	test("a read that failed too late to retry before the entry goes stale is not retried", async () => {
		const h = harness();
		h.replies.push(h.failsAfter(9 * SECOND));
		h.keepAlive.request(envelope("turn"));
		h.keepAlive.answered(700_000);
		await h.advanceTo(5 * 60 * SECOND);
		expect(h.pings).toHaveLength(1);
		expect(h.keepAlive.scheduled).toBe(false);
	});

	test("forget drops the entry and its timer", async () => {
		const h = harness();
		h.keepAlive.request(envelope("turn"));
		h.keepAlive.answered(700_000);
		h.keepAlive.forget();
		expect(h.timers()).toEqual([]);
		await h.advanceTo(10 * 60 * SECOND);
		expect(h.pings).toEqual([]);
	});

	test("a prompt too short to cache is never read", async () => {
		const h = harness();
		h.keepAlive.request(envelope("tiny"));
		h.keepAlive.answered(3_000);
		await h.advanceTo(10 * 60 * SECOND);
		expect(h.pings).toEqual([]);
	});
});
