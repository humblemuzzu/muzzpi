/**
 * Lifecycle tests for the deepseek-peak extension.
 *
 * These exist because of a real crash: the 5s poll survived a session
 * replacement, and the first tick afterwards called `pi.events.emit` on a
 * runtime pi had already marked stale. That throw came out of a setInterval
 * callback, which is an uncaughtException, which pi answers with process.exit —
 * so a background label killed the whole session about a minute after /new.
 *
 * `index.ts` imports pi only through `import type`, which erases at runtime, so
 * the factory runs against a stub with no pi install involved.
 */

import { describe, expect, setSystemTime, test } from "bun:test";
import deepseekPeakExtension from "./index";

type Handler = (event: unknown, ctx: unknown) => unknown;

/** A stub pi + a stub runtime that can be made stale the way the real one is. */
interface Emitted {
	key: string;
	text: string;
	when?: string;
}

function makeHarness(options: { hasUI?: boolean; model?: { provider: string; id: string } } = {}) {
	const emitted: Emitted[] = [];
	const handlers = new Map<string, Handler[]>();
	const listeners = new Map<string, Array<(data: unknown) => void>>();
	let stale = false;

	const pi = {
		events: {
			emit: (_channel: string, data: Emitted) => {
				// mirrors loader.js: every runtime call asserts the ctx is still active
				if (stale) throw new Error("This extension ctx is stale after session replacement or reload.");
				emitted.push({ key: data.key, text: data.text, when: data.when });
			},
			on: (channel: string, listener: (data: unknown) => void) => {
				listeners.set(channel, [...(listeners.get(channel) ?? []), listener]);
				return () => {};
			},
		},
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand: () => {},
	};

	const ctx = {
		hasUI: options.hasUI ?? true,
		ui: { theme: { fg: (_color: string, text: string) => text } },
		model: options.model ?? { provider: "anthropic", id: "claude-opus-5" },
	};

	const broadcast = (channel: string, data: unknown) => {
		for (const listener of listeners.get(channel) ?? []) listener(data);
	};

	const fire = async (event: string) => {
		for (const handler of handlers.get(event) ?? []) await handler({ type: event }, ctx);
	};

	return {
		emitted,
		pi,
		fire,
		broadcast,
		hasHandler: (event: string) => handlers.has(event),
		makeStale: () => {
			stale = true;
		},
	};
}

/**
 * Capture setInterval/clearInterval for the whole test, not just the factory
 * call — the interval is created inside the session_start handler, which pi
 * fires later, so restoring the globals too early captures nothing.
 */
function captureTimers() {
	const realSet = globalThis.setInterval;
	const realClear = globalThis.clearInterval;
	const state = {
		tick: null as null | (() => void),
		handle: null as unknown,
		cleared: [] as unknown[],
		restore: () => {
			globalThis.setInterval = realSet;
			globalThis.clearInterval = realClear;
			setSystemTime();
		},
	};

	globalThis.setInterval = ((fn: () => void) => {
		state.tick = fn;
		state.handle = { unref: () => {} };
		return state.handle;
	}) as unknown as typeof setInterval;
	globalThis.clearInterval = ((handle: unknown) => {
		state.cleared.push(handle);
	}) as unknown as typeof clearInterval;

	return state;
}

/** Advance the clock past a minute boundary — the label only emits when its text changes. */
const advanceOneMinute = () => setSystemTime(new Date(Date.now() + 61_000));

describe("session lifecycle", () => {
	test("registers a session_shutdown handler", () => {
		const h = makeHarness();
		deepseekPeakExtension(h.pi as never);
		expect(h.hasHandler("session_shutdown")).toBe(true);
	});

	test("session_shutdown clears the poll before the ctx goes stale", async () => {
		const h = makeHarness();
		const state = captureTimers();
		try {
			deepseekPeakExtension(h.pi as never);
			await h.fire("session_start");
			expect(state.tick).not.toBeNull();
			expect(state.handle).not.toBeNull();
			expect(h.emitted.length).toBeGreaterThan(0);

			await h.fire("session_shutdown");
			expect(state.cleared).toContain(state.handle);

			// pi invalidates immediately after session_shutdown returns
			h.makeStale();
			h.emitted.length = 0;
			advanceOneMinute();
			// even if the runtime kept the handle alive, the tick must be inert
			expect(() => state.tick?.()).not.toThrow();
			expect(h.emitted).toHaveLength(0);
		} finally {
			state.restore();
		}
	});

	test("a stale ctx never throws out of the timer, and stops the poll", async () => {
		const h = makeHarness();
		const state = captureTimers();
		try {
			deepseekPeakExtension(h.pi as never);
			await h.fire("session_start");
			// the crash path: invalidated WITHOUT the shutdown teardown running
			h.makeStale();
			advanceOneMinute();
			expect(() => state.tick?.()).not.toThrow();
			expect(state.cleared).toContain(state.handle);
		} finally {
			state.restore();
		}
	});

	test("a throw at session_start does not escape, and starts no poll", async () => {
		const h = makeHarness();
		h.makeStale();
		const state = captureTimers();
		try {
			deepseekPeakExtension(h.pi as never);
			// session_start is awaited by pi; a rejection here would surface as an
			// unhandled rejection rather than a label that quietly gives up.
			await h.fire("session_start");
			expect(state.tick).toBeNull();
		} finally {
			state.restore();
		}
	});

	test("a headless session starts no poll", async () => {
		const h = makeHarness({ hasUI: false });
		const state = captureTimers();
		try {
			deepseekPeakExtension(h.pi as never);
			await h.fire("session_start");
			expect(state.tick).toBeNull();
			expect(h.emitted).toHaveLength(0);
		} finally {
			state.restore();
		}
	});
});

describe("when the label shows", () => {
	const last = (h: ReturnType<typeof makeHarness>, key: string) => h.emitted.filter((e) => e.key === key).at(-1);
	const run = (status: string, model: string) => ({ id: "chad-1", status, model });

	test("on another provider it waits in the detail view, and the clock asks to hide during a run", async () => {
		const h = makeHarness();
		const state = captureTimers();
		try {
			deepseekPeakExtension(h.pi as never);
			await h.fire("session_start");
			expect(last(h, "deepseek-peak")?.when).toBe("detail");
			expect(last(h, "clock")?.when).toBe("idle");
		} finally {
			state.restore();
		}
	});

	test("on a deepseek model it is always there", async () => {
		const h = makeHarness({ model: { provider: "deepseek", id: "deepseek-flash" } });
		const state = captureTimers();
		try {
			deepseekPeakExtension(h.pi as never);
			await h.fire("session_start");
			expect(last(h, "deepseek-peak")).toBeDefined();
			expect(last(h, "deepseek-peak")?.when).toBeUndefined();
		} finally {
			state.restore();
		}
	});

	test("a live deepseek sub-agent brings it up, and its end sends it back", async () => {
		const h = makeHarness();
		const state = captureTimers();
		try {
			deepseekPeakExtension(h.pi as never);
			await h.fire("session_start");
			h.broadcast("muzzpi:agent-runs", [run("running", "anthropic/claude-sonnet-5-5")]);
			expect(last(h, "deepseek-peak")?.when).toBe("detail");
			h.broadcast("muzzpi:agent-runs", [run("running", "deepseek/deepseek-flash")]);
			expect(last(h, "deepseek-peak")?.when).toBeUndefined();
			h.broadcast("muzzpi:agent-runs", [run("done", "deepseek/deepseek-flash")]);
			expect(last(h, "deepseek-peak")?.when).toBe("detail");
		} finally {
			state.restore();
		}
	});

	test("a run update after shutdown paints nothing", async () => {
		const h = makeHarness();
		const state = captureTimers();
		try {
			deepseekPeakExtension(h.pi as never);
			await h.fire("session_start");
			await h.fire("session_shutdown");
			h.makeStale();
			const before = h.emitted.length;
			expect(() => h.broadcast("muzzpi:agent-runs", [run("running", "deepseek/deepseek-flash")])).not.toThrow();
			expect(h.emitted).toHaveLength(before);
		} finally {
			state.restore();
		}
	});
});
