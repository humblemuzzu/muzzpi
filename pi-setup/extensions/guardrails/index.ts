/** edit/write comment gate. behaviour rules are loaded by system-prompt.ts. */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { DEFAULT_THRESHOLDS, judge, type Thresholds } from "./comment-gate";

const GATED_TOOLS = new Set(["edit", "write"]);

function envNum(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function thresholds(): Thresholds {
	return {
		maxRun: envNum("PI_GUARDRAILS_MAX_COMMENT_RUN", DEFAULT_THRESHOLDS.maxRun),
		maxRatio: envNum("PI_GUARDRAILS_MAX_COMMENT_RATIO", DEFAULT_THRESHOLDS.maxRatio),
		minComments: envNum("PI_GUARDRAILS_MIN_COMMENTS", DEFAULT_THRESHOLDS.minComments),
	};
}

export default function guardrailsExtension(pi: ExtensionAPI): void {
	if (process.env.PI_GUARDRAILS_OFF === "1") return;

	pi.on("tool_call", async (event) => {
		if (!GATED_TOOLS.has(event.toolName)) return;

		/*
		 * Any failure here means the gate could not decide, and a gate that
		 * cannot decide must let the edit through. Blocking real work on a
		 * parser bug is how a guardrail gets switched off for good.
		 */
		try {
			const verdict = judge(event.input as Record<string, unknown>, thresholds());
			if (verdict.blocked) return { block: true, reason: verdict.reason };
		} catch {
			return;
		}
	});
}
