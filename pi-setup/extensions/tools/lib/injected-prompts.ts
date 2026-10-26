/**
 * Prompts our extensions send through `pi.sendUserMessage`. pi stores them
 * exactly like a typed prompt, so their opening text is the only way to tell
 * them apart; the senders build them from these constants.
 */

export const GOAL_CONTINUATION_PREFIX = '<pi_goal_continuation goal_id="';
export const YSK_PROMPT_PREFIX = "A side agent flagged this while you were working:";

export type InjectedKind = "goal" | "ysk";

export function injectedKind(text: string): InjectedKind | undefined {
	if (text.startsWith(GOAL_CONTINUATION_PREFIX)) return "goal";
	if (text.startsWith(YSK_PROMPT_PREFIX)) return "ysk";
	return undefined;
}
