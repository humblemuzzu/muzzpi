/**
 * Compaction that re-sends the last request with a summary instruction appended,
 * so Anthropic reads the conversation from the prompt cache instead of pi
 * re-reading it at full price under a different prompt.
 */
import { isPlainObject, scrubAnthropicPayload } from "./anthropic-sub";
import { injectedKind } from "./injected-prompts";
import { type CapturedRequest, refreshDelayMs } from "./prompt-cache";

export const CACHE_COMPACTION_MAX_AGE_ENV = "PI_CACHE_COMPACTION_MAX_AGE_SEC";

/** pi's request clamp keeps this much of the window free (pi-ai simple-options.js CONTEXT_SAFETY_TOKENS) */
const CONTEXT_SAFETY_TOKENS = 4096;

export interface FileOps {
	read: Set<string>;
	written: Set<string>;
	edited: Set<string>;
}

// From pi's compaction.js SUMMARIZATION_PROMPT, UPDATE_SUMMARIZATION_INSTRUCTIONS and
// SUMMARIZATION_SYSTEM_PROMPT, and upstream cff1cf5's SOURCE_CONTEXT_UPDATE_SUMMARIZATION_PROMPT (MIT).
const NO_CONTINUATION =
	"This message is a checkpoint request, not part of the conversation: leave it out of the summary. Earlier instructions about how to reply do not apply to it. The reply to the last message above already exists and is kept after the summary, so do not list it as pending. Do NOT continue the conversation. Do NOT respond to any questions in the conversation. Do NOT call any tools. ONLY output the structured summary.";

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above contain an existing structured summary of earlier conversation history followed by NEW conversation messages.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

// Factory Droid's adaptive_compaction_prompt.
const CONTINUATION_RULES = `Always preserve relevant user context: the primary request and intent, the latest request, consequential requirements, clarifications, preferences, approvals and their limits, corrections, and unanswered questions. Distinguish user decisions from assistant proposals or assumptions.

Do not turn proposals into commitments, reports into verified results, partial checks into verified correctness, or historical evidence into current proof.

Project files, recorded evidence, and other relevant artifacts may already be durable sources of truth. Prefer referencing these sources while preserving important context that exists only in the conversation.

Under Critical Context, name every skill that was loaded in this conversation, so it can be loaded again.`;

const GOAL_BOOKKEEPING = `Messages that begin with <pi_goal_continuation are the harness prompting the agent to keep working on its goal. Record the goal's objective and status once; do not summarize those prompts.`;

/** closes every summary: the conversation it replaces is gone, the files are not */
export const STALE_FILES_NOTE =
	"\n\nYou wrote this summary earlier in this session. Files referenced in the summary may have changed since; read them again before editing them.";

const REQUESTS_HEADING = "## Requests in the user's words";
const FIRST_REQUEST = "First request: ";
const LATEST_REQUEST = "Latest request: ";
const FIRST_REQUEST_CHARS = 2_000;
const LATEST_REQUEST_CHARS = 4_000;

function userText(message: unknown): string | undefined {
	if (!isPlainObject(message) || message.role !== "user") return undefined;
	const content = message.content;
	if (typeof content === "string") return content.trim() || undefined;
	if (!Array.isArray(content)) return undefined;
	const text = content.flatMap((part) => (isPlainObject(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [])).join("\n").trim();
	return text || undefined;
}

function clipText(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * The user's own words, which a paraphrasing summary can lose: the first request (kept from the
 * previous summary across compactions) and the newest one among the messages being replaced.
 */
export function requestsSection(replaced: readonly unknown[], previousSummary?: string): string {
	const asked = replaced.flatMap((message) => {
		const text = userText(message);
		return text && !injectedKind(text) ? [text] : [];
	});
	const earlier = previousSummary?.split("\n").find((line) => line.startsWith(FIRST_REQUEST))?.slice(FIRST_REQUEST.length);
	const first = earlier ?? (asked[0] && clipText(asked[0], FIRST_REQUEST_CHARS));
	if (!first) return "";
	const latest = asked.at(-1);
	const lines = [`${FIRST_REQUEST}${first}`];
	if (latest && clipText(latest, FIRST_REQUEST_CHARS) !== first) lines.push(`${LATEST_REQUEST}${clipText(latest, LATEST_REQUEST_CHARS)}`);
	return `\n\n${REQUESTS_HEADING}\n${lines.join("\n")}`;
}

/** The model's summary, without its copies of what this module appends, then the requests, the stale-files note and the file lists. */
export function finalSummary(modelText: string, requests: string, readFiles: string[], modifiedFiles: string[]): string {
	const own = modelText
		.replaceAll(STALE_FILES_NOTE.trim(), "")
		.replace(new RegExp(`\\n*${REQUESTS_HEADING}\\n[\\s\\S]*?(?=\\n## |$)`), "")
		.trimEnd();
	return own + requests + STALE_FILES_NOTE + formatFileOperations(readFiles, modifiedFiles);
}

export function summaryInstruction(hasPreviousSummary: boolean, customInstructions?: string): string {
	const prompt = `${NO_CONTINUATION}\n\n${hasPreviousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT}\n\n${CONTINUATION_RULES}\n\n${GOAL_BOOKKEEPING}`;
	return customInstructions ? `${prompt}\n\nAdditional focus: ${customInstructions}` : prompt;
}

/**
 * The captured request, scrubbed exactly as anthropic-sub scrubs it, with the
 * instruction appended after its last block and `max_tokens` replaced. Nothing
 * before the last cache breakpoint changes, so the whole prefix is a cache read.
 * After pi's trailing effort message the instruction is a system message, where
 * Anthropic places harness notices; a user turn would let the conversation's own
 * reply instructions win.
 */
export function buildSummaryPayload(
	captured: Record<string, unknown>,
	instruction: string,
	maxTokens: number,
): Record<string, unknown> {
	const payload = structuredClone(scrubAnthropicPayload(captured) ?? captured);
	const messages = Array.isArray(payload.messages) ? payload.messages : [];
	const block = { type: "text", text: instruction };
	const last = messages.at(-1);
	if (isPlainObject(last) && last.role === "system") messages.push({ role: "system", content: [block] });
	else if (isPlainObject(last) && last.role === "user" && Array.isArray(last.content)) last.content.push(block);
	else messages.push({ role: "user", content: [block] });
	payload.messages = messages;
	payload.max_tokens = maxTokens;
	return payload;
}

/** How old a capture may be and still be read from cache: no older than the keep-alive lets it get. */
export function captureMaxAgeMs(ttlMs: number, env: Record<string, string | undefined>): number {
	const override = Number(env[CACHE_COMPACTION_MAX_AGE_ENV]);
	if (env[CACHE_COMPACTION_MAX_AGE_ENV] && Number.isFinite(override) && override >= 0) return override * 1000;
	return refreshDelayMs(ttlMs);
}

/** pi's summary budget, cut to what the window leaves after the prompt; 0 when nothing fits */
export function summaryMaxTokens(
	reserveTokens: number,
	modelMaxTokens: number,
	contextWindow: number,
	promptTokens: number,
): number {
	const budget = Math.min(Math.floor(0.8 * reserveTokens), modelMaxTokens > 0 ? modelMaxTokens : Number.POSITIVE_INFINITY);
	const room = contextWindow > 0 ? contextWindow - promptTokens - CONTEXT_SAFETY_TOKENS : Number.POSITIVE_INFINITY;
	return Math.max(0, Math.min(budget, room));
}

/** How many of `needed` the captured request did not carry, compared by content. */
export function missingFromCapture(captured: readonly unknown[], needed: readonly unknown[]): number {
	const sent = new Set(captured.map((message) => JSON.stringify(message)));
	return needed.filter((message) => !sent.has(JSON.stringify(message))).length;
}

export interface CompactionCheck {
	capture: CapturedRequest | undefined;
	/** the capture's cache lifetime, as the keep-alive knows it */
	ttlMs: number;
	now: number;
	sessionId: string;
	modelId: string;
	reason: string;
	needed: readonly unknown[];
	maxTokens: number;
	aborted: boolean;
	env: Record<string, string | undefined>;
}

/** Why the cached path must not run, or undefined when it may. */
export function cacheCompactionBlocker(check: CompactionCheck): string | undefined {
	const { capture } = check;
	if (!capture) return "no request captured";
	if (check.reason === "overflow") return "overflow recovery";
	if (capture.sessionId !== check.sessionId) return "captured in another session";
	if (capture.modelId !== check.modelId) return "captured for another model";
	if (check.now - capture.at > captureMaxAgeMs(check.ttlMs, check.env)) return "cache entry likely expired";
	if (check.maxTokens <= 0) return "no room for a summary";
	const missing = missingFromCapture(capture.messages, check.needed);
	if (missing > 0) return `${missing} messages to summarize were not in the last request`;
	if (check.aborted) return "aborted";
	return undefined;
}

// computeFileLists and formatFileOperations from pi's compaction/utils.js (MIT); pi does not export them.
export function computeFileLists(fileOps: FileOps): { readFiles: string[]; modifiedFiles: string[] } {
	const modified = new Set([...fileOps.edited, ...fileOps.written]);
	const readFiles = [...fileOps.read].filter((file) => !modified.has(file)).sort();
	return { readFiles, modifiedFiles: [...modified].sort() };
}

export function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
	const sections: string[] = [];
	if (readFiles.length > 0) sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
	if (modifiedFiles.length > 0) sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
	return sections.length > 0 ? `\n\n${sections.join("\n\n")}` : "";
}

/**
 * pi skips the file lists of a compaction an extension wrote (`fromHook`), so a
 * second cached compaction would forget the first one's files. Add them back.
 */
export function withPreviousExtensionFiles(fileOps: FileOps, branchEntries: readonly unknown[]): FileOps {
	const previous = [...branchEntries].reverse().find((entry) => isPlainObject(entry) && entry.type === "compaction");
	if (!isPlainObject(previous) || previous.fromHook !== true || !isPlainObject(previous.details)) return fileOps;
	const { readFiles, modifiedFiles } = previous.details;
	const merged: FileOps = { read: new Set(fileOps.read), written: new Set(fileOps.written), edited: new Set(fileOps.edited) };
	if (Array.isArray(readFiles)) for (const file of readFiles) if (typeof file === "string") merged.read.add(file);
	if (Array.isArray(modifiedFiles)) for (const file of modifiedFiles) if (typeof file === "string") merged.edited.add(file);
	return merged;
}
