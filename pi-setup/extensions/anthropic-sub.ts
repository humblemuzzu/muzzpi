/**
 * anthropic-sub — keeps Claude-plan (OAuth) requests off extra usage and
 * explains a refusal. Touches system text only, never tools or history.
 */

import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describeAnthropicRejection, scrubAnthropicPayload } from "./tools/lib/anthropic-sub";

const PAYLOAD_LOG_ENV = "PI_ANTHROPIC_PAYLOAD_LOG";

function writePayloadLog(path: string, payload: unknown): void {
	try {
		appendFileSync(path, `${new Date().toISOString()}\n${JSON.stringify({ stage: "after", payload })}\n---\n`, {
			encoding: "utf-8",
			mode: 0o600,
		});
	} catch {}
}

export default function anthropicSub(pi: ExtensionAPI) {
	let warned = false;
	let succeeded = false;

	pi.on("session_start", () => {
		warned = false;
		succeeded = false;
	});

	pi.on("before_provider_request", (event, ctx) => {
		const model = ctx.model;
		if (model?.provider !== "anthropic" || !ctx.modelRegistry.isUsingOAuth(model)) return undefined;
		const scrubbed = scrubAnthropicPayload(event.payload);
		const logPath = process.env[PAYLOAD_LOG_ENV];
		if (logPath) writePayloadLog(logPath, scrubbed ?? event.payload);
		return scrubbed;
	});

	pi.on("message_end", (event, ctx) => {
		const message = event.message as { role?: string; stopReason?: string; errorMessage?: string };
		if (message.role !== "assistant" || ctx.model?.provider !== "anthropic") return undefined;
		if (message.stopReason !== "error") {
			succeeded = true;
			return undefined;
		}
		const hint = describeAnthropicRejection(message.errorMessage, succeeded);
		if (hint && !warned && ctx.hasUI) {
			warned = true;
			ctx.ui.notify(hint, "warning");
		}
		return undefined;
	});
}
