import { appendFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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
const HOUR_SECONDS = 3600;

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
	let lifetimeWarnedFor: string | undefined;

	// pi's warmer reads the TTL from the session's model object, which /reload keeps.
	const warnShortWarmingLifetime = (ctx: ExtensionContext): void => {
		const model = ctx.model;
		if (!model || !ctx.hasUI || !isPlanRequest(ctx) || cacheTtl() !== "1h") return;
		const seconds = model.promptCache?.short;
		if (seconds === undefined || seconds >= HOUR_SECONDS || lifetimeWarnedFor === model.id) return;
		lifetimeWarnedFor = model.id;
		ctx.ui.notify(
			`pi's cache keep-alive thinks ${model.id} caches for ${seconds}s, but its requests cache for 1h, so it pings far too often. Restart pi (/reload keeps the old model data), or add the model to models.json with promptCache.short 3600.`,
			"warning",
		);
	};

	pi.on("session_start", (_event, ctx) => {
		warned = false;
		succeeded = false;
		warnShortWarmingLifetime(ctx);
	});

	pi.on("model_select", (_event, ctx) => {
		warnShortWarmingLifetime(ctx);
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

	// models.json declares a 1h lifetime for the Claude models, which pi's warmer
	// trusts; a request that actually wrote 5m would be warmed after it expired.
	pi.on("cache_warming_decision", (_event, ctx) => {
		if (ctx.model?.provider !== "anthropic") return undefined;
		return isPlanRequest(ctx) && cacheTtl() === "1h" ? undefined : { action: "stop" };
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
