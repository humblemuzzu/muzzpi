import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type CacheTtl,
	describeAnthropicRejection,
	extendCacheTtl,
	isPlanRequest,
	isUsingOverage,
	PAYLOAD_LOG_ENV,
	planMeter,
	resolveCacheTtl,
	scrubAnthropicPayload,
	writePayloadLog,
} from "./tools/lib/anthropic-sub";
import { SUB_AGENT_TOOLS_ENV } from "./tools/lib/sub-agent-prompt";

const METER_LOG_ENV = "PI_ANTHROPIC_METER_LOG";

function writeMeterLog(path: string, record: Record<string, unknown>): void {
	try {
		appendFileSync(path, `${JSON.stringify(record)}\n`, { encoding: "utf-8", mode: 0o600 });
	} catch {}
}

interface UsageTokens {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cacheWrite1h?: number;
}

export default function anthropicSub(pi: ExtensionAPI) {
	let warned = false;
	let succeeded = false;
	const configuredTtl = resolveCacheTtl(process.env);
	let usingOverage = false;
	const cacheTtl = (): CacheTtl => (usingOverage ? "5m" : configuredTtl);
	let pendingMeter: Record<string, string> | undefined;

	pi.on("session_start", () => {
		warned = false;
		succeeded = false;
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!isPlanRequest(ctx)) return undefined;
		const scrubbed = scrubAnthropicPayload(event.payload);
		const extended = cacheTtl() === "1h" ? extendCacheTtl(scrubbed ?? event.payload) : undefined;
		const out = extended ?? scrubbed;
		const logPath = process.env[PAYLOAD_LOG_ENV];
		if (logPath) writePayloadLog(logPath, out ?? event.payload);
		return out;
	});

	pi.on("after_provider_response", (event, ctx) => {
		if (ctx.model?.provider !== "anthropic") return;
		const overage = isUsingOverage(event.headers);
		if (overage !== undefined) usingOverage = overage;
		if (process.env[METER_LOG_ENV]) pendingMeter = planMeter(event.headers);
	});

	pi.on("message_end", (event, ctx) => {
		const message = event.message as { role?: string; stopReason?: string; errorMessage?: string; usage?: UsageTokens };
		if (message.role !== "assistant" || ctx.model?.provider !== "anthropic") return undefined;
		const meterLog = process.env[METER_LOG_ENV];
		if (meterLog && pendingMeter) {
			const usage = message.usage;
			writeMeterLog(meterLog, {
				at: new Date().toISOString(),
				model: ctx.model.id,
				subagent: Boolean(process.env[SUB_AGENT_TOOLS_ENV]?.trim()),
				meter: pendingMeter,
				usage: usage && {
					input: usage.input,
					output: usage.output,
					cacheRead: usage.cacheRead,
					cacheWrite: usage.cacheWrite,
					cacheWrite1h: usage.cacheWrite1h ?? 0,
				},
			});
			pendingMeter = undefined;
		}
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
