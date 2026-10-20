import { appendFileSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SUB_AGENT_TOOLS_ENV } from "./sub-agent-prompt";

export const ANTHROPIC_TRIGGER_PHRASES: ReadonlyArray<readonly [phrase: string, replacement: string]> = [
	["pi itself", "the cli itself"],
	["pi .md files", "cli .md files"],
	["pi packages", "cli packages"],
];

const REJECTION_MARKERS = ["out of extra usage", "only authorized for use with claude code"];

export const CANARY_COMMAND = "bun pi-setup/port-harness/anthropic-oauth-canary.ts";

/** a request on the Claude plan: Anthropic signed in with OAuth, not an API key */
export function isPlanRequest(ctx: Pick<ExtensionContext, "model" | "modelRegistry">): boolean {
	const model = ctx.model;
	return model?.provider === "anthropic" && ctx.modelRegistry.isUsingOAuth(model);
}

export const PAYLOAD_LOG_ENV = "PI_ANTHROPIC_PAYLOAD_LOG";

/** appends one record in the format `cache-diag.py` reads; never throws */
export function writePayloadLog(path: string, payload: unknown): void {
	try {
		appendFileSync(path, `${new Date().toISOString()}\n${JSON.stringify({ stage: "after", payload })}\n---\n`, {
			encoding: "utf-8",
			mode: 0o600,
		});
	} catch {}
}

export function scrubPromptText(text: string): string {
	let out = text;
	for (const [phrase, replacement] of ANTHROPIC_TRIGGER_PHRASES) out = out.replaceAll(phrase, replacement);
	return out;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
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

export type CacheTtl = "5m" | "1h";

export const PROMPT_CACHE_TTL_ENV = "PI_PROMPT_CACHE_TTL";
export const SUBAGENT_PROMPT_CACHE_TTL_ENV = "PI_SUBAGENT_PROMPT_CACHE_TTL";
export const FORCE_PROMPT_CACHING_5M_ENV = "PI_FORCE_PROMPT_CACHING_5M";
export const EXTENDED_CACHE_TTL_BETA = "extended-cache-ttl-2025-04-11";

/** Claude Code's defaults: the main session 1h, sub-agents 5m; each env var takes only "5m" or "1h". */
export function resolveCacheTtl(env: Record<string, string | undefined>): CacheTtl {
	if (env[FORCE_PROMPT_CACHING_5M_ENV] === "1") return "5m";
	const child = Boolean(env[SUB_AGENT_TOOLS_ENV]?.trim());
	const chosen = env[child ? SUBAGENT_PROMPT_CACHE_TTL_ENV : PROMPT_CACHE_TTL_ENV];
	if (chosen === "5m" || chosen === "1h") return chosen;
	return child ? "5m" : "1h";
}

const PLAN_METER_PREFIX = "anthropic-ratelimit-unified-";

/** the plan meter as a response reports it, keys without the common prefix; undefined when absent */
export function planMeter(headers: Record<string, string>): Record<string, string> | undefined {
	const meter: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) {
		if (name.startsWith(PLAN_METER_PREFIX)) meter[name.slice(PLAN_METER_PREFIX.length)] = value;
	}
	return Object.keys(meter).length > 0 ? meter : undefined;
}

/** Claude Code's test: the plan limit is spent and the request was served from extra usage. */
export function isUsingOverage(headers: Record<string, string>): boolean | undefined {
	const status = headers["anthropic-ratelimit-unified-status"];
	if (status === undefined) return undefined;
	const overage = headers["anthropic-ratelimit-unified-overage-status"];
	return status === "rejected" && (overage === "allowed" || overage === "allowed_warning");
}

function withLongTtl(block: unknown): unknown {
	if (!isPlainObject(block) || !isPlainObject(block.cache_control)) return block;
	const cacheControl = block.cache_control;
	if (cacheControl.type !== "ephemeral" || cacheControl.ttl === "1h") return block;
	return { ...block, cache_control: { ...cacheControl, ttl: "1h" } };
}

/** returns the same reference when no block changed */
function blocksWithLongTtl(blocks: unknown): unknown {
	if (!Array.isArray(blocks)) return blocks;
	let changed = false;
	const next = blocks.map((block) => {
		const out = withLongTtl(block);
		if (out !== block) changed = true;
		return out;
	});
	return changed ? next : blocks;
}

/**
 * Every cache breakpoint pi placed (system blocks, last tool, a message's last
 * block) gets the 1h TTL, so no 5m entry precedes a 1h one. Undefined when the
 * payload has no breakpoint to change.
 */
export function extendCacheTtl(payload: unknown): Record<string, unknown> | undefined {
	if (!isPlainObject(payload)) return undefined;
	let changed = false;
	const out: Record<string, unknown> = { ...payload };

	for (const key of ["system", "tools"] as const) {
		const blocks = blocksWithLongTtl(payload[key]);
		if (blocks !== payload[key]) {
			out[key] = blocks;
			changed = true;
		}
	}

	if (Array.isArray(payload.messages)) {
		let messagesChanged = false;
		const messages = payload.messages.map((msg) => {
			if (!isPlainObject(msg)) return msg;
			const content = blocksWithLongTtl(msg.content);
			if (content === msg.content) return msg;
			messagesChanged = true;
			return { ...msg, content };
		});
		if (messagesChanged) {
			out.messages = messages;
			changed = true;
		}
	}

	if (!changed) return undefined;
	const betas = Array.isArray(payload.betas) ? payload.betas : [];
	if (!betas.includes(EXTENDED_CACHE_TTL_BETA)) out.betas = [...betas, EXTENDED_CACHE_TTL_BETA];
	return out;
}

export function isAnthropicRejection(errorMessage: string | undefined): boolean {
	const text = (errorMessage ?? "").toLowerCase();
	return REJECTION_MARKERS.some((marker) => text.includes(marker));
}

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
