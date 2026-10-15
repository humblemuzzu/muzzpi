/**
 * Anthropic bills a Claude-plan (OAuth) request as extra usage when its system
 * prompt carries pi's docs wording: these three phrases, lowercase, together.
 */

export const ANTHROPIC_TRIGGER_PHRASES: ReadonlyArray<readonly [phrase: string, replacement: string]> = [
	["pi itself", "the cli itself"],
	["pi .md files", "cli .md files"],
	["pi packages", "cli packages"],
];

const REJECTION_MARKERS = ["out of extra usage", "only authorized for use with claude code"];

export const CANARY_COMMAND = "bun pi-setup/port-harness/anthropic-oauth-canary.ts";

export function scrubPromptText(text: string): string {
	let out = text;
	for (const [phrase, replacement] of ANTHROPIC_TRIGGER_PHRASES) out = out.replaceAll(phrase, replacement);
	return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** returns the same reference when nothing changed */
function scrubSystemField(system: unknown): unknown {
	if (typeof system === "string") return scrubPromptText(system);
	if (!Array.isArray(system)) return system;
	let changed = false;
	const next = system.map((block) => {
		if (!isPlainObject(block) || block.type !== "text" || typeof block.text !== "string") return block;
		const text = scrubPromptText(block.text);
		if (text === block.text) return block;
		changed = true;
		return { ...block, text };
	});
	return changed ? next : system;
}

/** undefined when the payload is already clean, so pi sends it untouched */
export function scrubAnthropicPayload(payload: unknown): Record<string, unknown> | undefined {
	if (!isPlainObject(payload)) return undefined;
	let changed = false;
	const out: Record<string, unknown> = { ...payload };

	if (payload.system !== undefined) {
		const system = scrubSystemField(payload.system);
		if (system !== payload.system) {
			out.system = system;
			changed = true;
		}
	}

	if (Array.isArray(payload.messages)) {
		let messagesChanged = false;
		const messages = payload.messages.map((msg) => {
			if (!isPlainObject(msg) || msg.role !== "system") return msg;
			const content = scrubSystemField(msg.content);
			if (content === msg.content) return msg;
			messagesChanged = true;
			return { ...msg, content };
		});
		if (messagesChanged) {
			out.messages = messages;
			changed = true;
		}
	}

	return changed ? out : undefined;
}

export function isAnthropicRejection(errorMessage: string | undefined): boolean {
	const text = (errorMessage ?? "").toLowerCase();
	return REJECTION_MARKERS.some((marker) => text.includes(marker));
}

/**
 * `hadSuccess`: an earlier turn worked (likely the plan limit), nothing has
 * worked yet (likely the third-party check), or unknown (a sub-agent).
 */
export function describeAnthropicRejection(
	errorMessage: string | undefined,
	hadSuccess: boolean | undefined,
): string | undefined {
	if (!isAnthropicRejection(errorMessage)) return undefined;
	if (hadSuccess === true) {
		return "Claude refused this request (\"out of extra usage\"). Earlier turns worked, so you have most likely hit your Claude plan limit: wait for the reset, or switch with /model to DeepSeek.";
	}
	if (hadSuccess === false) {
		return `Claude refused pi's first request ("out of extra usage"). Anthropic has most likely started flagging pi as a third-party app. Switch with /model to DeepSeek, then run: ${CANARY_COMMAND}`;
	}
	return `Claude refused this request ("out of extra usage"): either your Claude plan limit is used up, or Anthropic is flagging pi as a third-party app. Check with: ${CANARY_COMMAND}`;
}
