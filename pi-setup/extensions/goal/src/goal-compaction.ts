import type { SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";

import { CUSTOM_ENTRY_TYPE } from "./types.ts";

type GoalCompactionInput = Pick<SessionBeforeCompactEvent["preparation"], "messagesToSummarize" | "turnPrefixMessages">;

function isGoalContinuation(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  const candidate = message as { role?: unknown; customType?: unknown; details?: unknown };
  if (candidate.role !== "custom" || candidate.customType !== CUSTOM_ENTRY_TYPE || !candidate.details || typeof candidate.details !== "object") {
    return false;
  }
  const details = candidate.details as { kind?: unknown; goalId?: unknown };
  return details.kind === "continuation" && typeof details.goalId === "string";
}

/**
 * Only pi's own summarizer reads these lists; the kept messages and the file
 * lists are left alone. From pi-codex-goal 0.7.7 (MIT).
 */
export function filterGoalCompactionInput(preparation: GoalCompactionInput): void {
  preparation.messagesToSummarize = preparation.messagesToSummarize.filter((message) => !isGoalContinuation(message));
  preparation.turnPrefixMessages = preparation.turnPrefixMessages.filter((message) => !isGoalContinuation(message));
}
