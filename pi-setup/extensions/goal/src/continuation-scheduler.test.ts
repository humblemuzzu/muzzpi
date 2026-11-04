import { describe, expect, test } from "bun:test";

import { createContinuationScheduler } from "./continuation-scheduler.ts";
import { createGoalRecoveryMachine } from "./recovery-machine.ts";
import { replaceGoal, setEntry } from "./state.ts";
import { CUSTOM_ENTRY_TYPE } from "./types.ts";

function scheduler() {
	const goal = replaceGoal("ship the release with every test green").goal!;
	const sent: { content: string; details: Record<string, unknown> }[] = [];
	const continuation = createContinuationScheduler({
		pi: { sendMessage: (message: any) => sent.push(message) } as any,
		getGoal: () => goal,
		getRecoveryState: createGoalRecoveryMachine,
		staleQueuedWorkGuard: { isBlockingContinuation: () => false } as any,
		getCurrentTurnIndex: () => 0,
		getAgentRunSequence: () => 0,
	});
	const ctx = { isIdle: () => true, hasPendingMessages: () => false } as any;
	const next = () => {
		continuation.maybeContinue(ctx, true);
		continuation.clearContinuationState();
		return sent.at(-1)!;
	};
	return { goal, continuation, next };
}

const entry = (type: string, extra: Record<string, unknown> = {}) => ({ type, ...extra });

describe("the continuation after a compaction", () => {
	test("carries the whole objective once, then the short form again", () => {
		const { continuation, next } = scheduler();
		expect(next().content).not.toContain("<untrusted_objective>");
		continuation.requireFullGoal();
		const full = next();
		expect(full.content).toContain("ship the release with every test green");
		expect(full.details).toMatchObject({ kind: "continuation", full: true });
		expect(next().content).not.toContain("<untrusted_objective>");
	});

	test("never tells the model to check get_goal, since a turn that only does that pauses the goal", () => {
		const { next } = scheduler();
		expect(next().content).not.toContain("get_goal");
	});

	test("is restored after a restart from the session: owed after a compaction, settled by a full continuation or a /goal start", () => {
		const { goal, continuation, next } = scheduler();
		const goalEntry = { type: "custom", customType: CUSTOM_ENTRY_TYPE, data: setEntry(goal, "command") };
		const message = (details: Record<string, unknown>) => entry("custom_message", { customType: CUSTOM_ENTRY_TYPE, details: { goalId: goal.goalId, ...details } });

		continuation.restoreFullGoalNeed([goalEntry, entry("compaction"), message({ kind: "continuation" })]);
		expect(next().content).toContain("<untrusted_objective>");

		continuation.restoreFullGoalNeed([goalEntry, entry("compaction"), message({ kind: "continuation", full: true })]);
		expect(next().content).not.toContain("<untrusted_objective>");

		continuation.restoreFullGoalNeed([goalEntry, entry("compaction"), message({ kind: "command_resume" })]);
		expect(next().content).not.toContain("<untrusted_objective>");

		continuation.restoreFullGoalNeed([goalEntry, message({ kind: "continuation" })]);
		expect(next().content).not.toContain("<untrusted_objective>");
	});
});
