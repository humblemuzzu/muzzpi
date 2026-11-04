import { describe, expect, test } from "bun:test";

import { filterGoalCompactionInput } from "./goal-compaction.ts";
import { CUSTOM_ENTRY_TYPE } from "./types.ts";

const user = { role: "user", content: "fix the build", timestamp: 1 };
const continuation = { role: "custom", customType: CUSTOM_ENTRY_TYPE, content: "<pi_goal_continuation>", details: { kind: "continuation", goalId: "g1" }, timestamp: 2 };
const start = { role: "custom", customType: CUSTOM_ENTRY_TYPE, content: "objective", details: { kind: "command_start", goalId: "g1" }, timestamp: 3 };
const other = { role: "custom", customType: "agent-result", content: "finder found it", details: { kind: "continuation", goalId: "g1" }, timestamp: 4 };

describe("goal messages before pi's own compaction", () => {
	test("drops the repeated continuation prompts and keeps the objective, the work and other extensions' messages", () => {
		const preparation = { messagesToSummarize: [user, continuation, start, other], turnPrefixMessages: [continuation, user] } as any;
		filterGoalCompactionInput(preparation);
		expect(preparation.messagesToSummarize).toEqual([user, start, other]);
		expect(preparation.turnPrefixMessages).toEqual([user]);
	});
});
