/**
 * Prompts our extensions send through `pi.sendUserMessage`. pi stores them
 * exactly like a typed prompt, so their opening text is the only way to tell
 * them apart; the senders build them from these constants.
 */

export const GOAL_CONTINUATION_PREFIX = '<pi_goal_continuation goal_id="';
export const YSK_PROMPT_PREFIX = "A side agent flagged this while you were working:";
/** openings of the goal's own notices: custom messages, not prompts */
export const GOAL_BUDGET_PREFIX = "The active thread goal has reached its token budget.";
export const GOAL_STALE_PREFIX = "A queued hidden goal continuation was stale and has been cancelled before running.";

export type InjectedKind = "goal" | "ysk";

export function injectedKind(text: string): InjectedKind | undefined {
	if (text.startsWith(GOAL_CONTINUATION_PREFIX)) return "goal";
	if (text.startsWith(YSK_PROMPT_PREFIX)) return "ysk";
	return undefined;
}
