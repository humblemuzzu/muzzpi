import { AGENT_EVENT_FRAME, JOB_EVENT_FRAME } from "../tools/lib/agent-channel";
import { GOAL_BUDGET_PREFIX, GOAL_STALE_PREFIX, injectedKind } from "../tools/lib/injected-prompts";
import type { Part } from "./wire";

/**
 * agy frames every turn it sends, and Gemini 4 is trained on those frames: what the person typed is a
 * <USER_REQUEST>, news from background work a <SYSTEM_MESSAGE>, a nudge to act on without answering an
 * <EPHEMERAL_MESSAGE>. pi's turns get the same frames, worded byte for byte as agy 1.5.13 sends them.
 * A frame depends only on its turn's text and time, so each request repeats the previous prefix exactly.
 */
const SYSTEM_MESSAGE_OPENING =
	"The following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the system as important information to pay attention to.";
const EPHEMERAL_MESSAGE_OPENING =
	"The following is an <EPHEMERAL_MESSAGE> not actually sent by the user. It is provided by the system as a set of reminders and general important information to pay attention to. Do NOT respond to this message, just act accordingly.";

/** pi's own openings (core/messages.js): compaction and branch summaries and `!` commands go as pi wrote them. */
export const PI_OPENINGS = [
	"The conversation history before this point was compacted into the following summary:",
	"The following is a summary of a branch that this conversation came back from:",
	"Ran `",
] as const;

type Frame =
	| { kind: "request" }
	| { kind: "system"; sender: string; content: string }
	| { kind: "ephemeral" }
	| { kind: "verbatim" };

function senders(text: string, pattern: RegExp, fallback: string): string {
	const ids = [...new Set(Array.from(text.matchAll(pattern), (match) => match[1]!))];
	return ids.length > 0 ? ids.join(",") : fallback;
}

function afterFrame(text: string, frame: string): string {
	return text.slice(frame.length).replace(/^\n+/, "");
}

function frameOf(text: string): Frame {
	if (text.startsWith(AGENT_EVENT_FRAME)) {
		return { kind: "system", sender: senders(text, /^continueId: (\S+)/gm, "background-agents"), content: afterFrame(text, AGENT_EVENT_FRAME) };
	}
	if (text.startsWith(JOB_EVENT_FRAME)) {
		return { kind: "system", sender: senders(text, /^Background job (\S+)/gm, "background-jobs"), content: afterFrame(text, JOB_EVENT_FRAME) };
	}
	const injected = injectedKind(text);
	if (injected === "ysk") return { kind: "system", sender: "side-agent", content: text };
	if (injected === "goal" || text.startsWith(GOAL_BUDGET_PREFIX) || text.startsWith(GOAL_STALE_PREFIX)) return { kind: "ephemeral" };
	if (PI_OPENINGS.some((opening) => text.startsWith(opening))) return { kind: "verbatim" };
	return { kind: "request" };
}

/** agy's form: the second-precision UTC time, as `2026-11-20T10:48:35Z`. */
function agyTimestamp(ms: number): string | undefined {
	return Number.isFinite(ms) ? new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z") : undefined;
}

const two = (value: number) => String(value).padStart(2, "0");

/** agy's form (Go's RFC 3339): local time to the second with its offset, `Z` when that is zero. */
function agyLocalTime(ms: number): string | undefined {
	if (!Number.isFinite(ms)) return undefined;
	const at = new Date(ms);
	const east = -at.getTimezoneOffset();
	const zone = east === 0 ? "Z" : `${east > 0 ? "+" : "-"}${two(Math.floor(Math.abs(east) / 60))}:${two(Math.abs(east) % 60)}`;
	return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}T${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())}${zone}`;
}

function requestMetadata(timestamp: number): string {
	const at = agyLocalTime(timestamp);
	return at ? `\n<ADDITIONAL_METADATA>\nThe current local time is: ${at}.\n</ADDITIONAL_METADATA>` : "";
}

function systemMessage(sender: string, content: string, timestamp: number): string {
	const at = agyTimestamp(timestamp);
	const head = `[Message] ${at ? `timestamp=${at} ` : ""}sender=${sender} priority=MESSAGE_PRIORITY_HIGH content=`;
	return `${SYSTEM_MESSAGE_OPENING}\n\n<SYSTEM_MESSAGE>\n${head}${content}\n</SYSTEM_MESSAGE>`;
}

function replaceText(parts: readonly Part[], at: number, text: string): Part[] {
	return parts.map((part, index) => (index === at ? { text } : part));
}

/** A user-role turn's parts in agy's frame; a turn without text is sent as it is. */
export function frameUserTurn(parts: readonly Part[], timestamp: number): Part[] {
	const texts = parts.flatMap((part, index) => ("text" in part ? [{ index, text: part.text }] : []));
	const first = texts[0];
	const last = texts.at(-1);
	if (!first || !last) return [...parts];
	const frame = frameOf(first.text);
	switch (frame.kind) {
		case "verbatim":
			return [...parts];
		case "system":
			return replaceText(parts, first.index, systemMessage(frame.sender, frame.content, timestamp));
		case "ephemeral":
			return replaceText(parts, first.index, `${EPHEMERAL_MESSAGE_OPENING}\n${first.text}`);
		case "request":
			return parts.map((part, index) => {
				if (!("text" in part) || (index !== first.index && index !== last.index)) return part;
				const opened = index === first.index ? `<USER_REQUEST>\n${part.text}` : part.text;
				return { text: index === last.index ? `${opened}\n</USER_REQUEST>${requestMetadata(timestamp)}` : opened };
			});
	}
}

/**
 * Openings of turns only pi writes. A model reply that starts a line with one is writing the next turn
 * itself: on long contexts Gemini 4 has invented whole agent reports this way.
 */
export const FOREIGN_TURN_OPENINGS = [
	"The following is a <SYSTEM_MESSAGE>",
	"The following is an <EPHEMERAL_MESSAGE>",
	"<USER_REQUEST>",
	"<SYSTEM_MESSAGE>",
	"[Automated agent event",
	"[Automated bash-job event",
] as const;

/** The API allows five. A leading newline lets a reply quote an opening inside a sentence or backticks. */
export const STOP_SEQUENCES: readonly string[] = [
	"\nThe following is a <SYSTEM_MESSAGE>",
	"\nThe following is an <EPHEMERAL_MESSAGE>",
	"\n<USER_REQUEST>",
	"\n[Automated agent event",
	"\n[Automated bash-job event",
];

const LONGEST_OPENING = Math.max(...FOREIGN_TURN_OPENINGS.map((opening) => opening.length));

/** Where a foreign turn starts in model text, searching lines that begin at or after `from`; -1 when none does. */
export function foreignTurnAt(text: string, from = 0): number {
	let found = -1;
	for (const opening of FOREIGN_TURN_OPENINGS) {
		let index = text.indexOf(opening, from);
		while (index > 0 && text[index - 1] !== "\n") index = text.indexOf(opening, index + 1);
		if (index >= 0 && (found < 0 || index < found)) found = index;
	}
	return found;
}

/** Where a search over text that grew from `previousLength` characters must start to see every new match. */
export function searchFrom(previousLength: number): number {
	return Math.max(0, previousLength - LONGEST_OPENING);
}

/** Model text up to the turn it started writing for someone else. */
export function withoutForeignTurn(text: string): string {
	const at = foreignTurnAt(text);
	return at < 0 ? text : text.slice(0, at).trimEnd();
}
