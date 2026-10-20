import type { RunSnapshot } from "../tools/lib/agent-channel";
import type { Clock } from "./store";

export { theme } from "../tools/lib/test-theme";

export const strip = (text: string) => text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").replace(/\u001b_[^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "");

export const T0 = 1_700_000_000_000;

export function fakeClock(start = T0): Clock & { advance(ms: number): void } {
	const clock = {
		at: start,
		frame: 0,
		now: () => clock.at,
		advance: (ms: number) => {
			clock.at += ms;
			clock.frame++;
		},
	};
	return clock;
}

export function scheduler() {
	const pending: Array<{ at: number; fn: () => void; live: boolean }> = [];
	let now = 0;
	return {
		later(fn: () => void, ms: number) {
			const entry = { at: now + ms, fn, live: true };
			pending.push(entry);
			return () => {
				entry.live = false;
			};
		},
		advance(ms: number) {
			now += ms;
			for (const entry of pending.filter((e) => e.live && e.at <= now)) {
				entry.live = false;
				entry.fn();
			}
		},
		pending: () => pending.filter((e) => e.live).length,
	};
}

let counter = 0;

export function run(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
	counter++;
	return {
		id: `chad-${counter}`,
		agent: "chad",
		label: `task number ${counter}`,
		status: "running",
		background: true,
		queuedAt: T0,
		startedAt: T0,
		model: "deepseek/deepseek-flash",
		usage: { input: 20_000, output: 25_200, cacheRead: 0, cacheWrite: 0, cost: 0.1, contextTokens: 0, turns: 3 },
		toolCount: 4,
		files: [],
		messages: [],
		stopping: false,
		...overrides,
	};
}

export function finished(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
	return run({
		status: "done",
		endedAt: T0 + 70_000,
		messages: [{ role: "assistant", content: [{ type: "text", text: "Found the bug in auth.ts" }] }] as never,
		...overrides,
	});
}
