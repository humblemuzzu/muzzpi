import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createProvider } from "@earendil-works/pi-ai";
import { AGENT_RUNS_CHANNEL, type RunSnapshot } from "../tools/lib/agent-channel";
import { CACHE_PING_CHANNEL, CACHE_PING_ENTRY, type CachePing } from "../tools/lib/prompt-cache";
import { agyAuth } from "./auth";
import { BASE_URL, familyIdOfWireModel, MODELS, PROVIDER_ID } from "./catalog";
import { KeepAlive, LIFETIME_MS } from "./keep-alive";
import { fetchQuota, formatQuota, resetProject } from "./quota";
import { sendKeepAlive, stream, streamSimple } from "./stream";
import { type Envelope, resetConversation } from "./wire";

function liveRuns(runs: unknown): number {
	return Array.isArray(runs) ? (runs as RunSnapshot[]).filter((run) => run.status === "queued" || run.status === "running").length : 0;
}

export default function (pi: ExtensionAPI) {
	pi.registerProvider(
		createProvider({
			id: PROVIDER_ID,
			name: "Antigravity",
			baseUrl: BASE_URL,
			auth: agyAuth,
			models: [...MODELS],
			api: { stream, streamSimple },
		}),
	);

	let current: ExtensionContext | undefined;
	let conversationRequest = false;
	const keepAlive = new KeepAlive({
		now: Date.now,
		schedule: (fire, ms) => {
			const timer = setTimeout(fire, ms);
			timer.unref?.();
			return () => clearTimeout(timer);
		},
		ping: async (payload, signal) => {
			const ctx = current;
			if (!ctx || ctx.model?.provider !== PROVIDER_ID || familyIdOfWireModel(payload.model) !== ctx.model.id) return undefined;
			const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_ID);
			if (!apiKey || signal.aborted) return undefined;
			return sendKeepAlive(apiKey, payload, signal);
		},
		warmed: (payload, usage) => {
			const ping: CachePing = { provider: PROVIDER_ID, model: familyIdOfWireModel(payload.model) ?? payload.model, ttlMs: LIFETIME_MS, usage };
			pi.appendEntry(CACHE_PING_ENTRY, ping);
			pi.events.emit(CACHE_PING_CHANNEL, ping);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		resetConversation();
		resetProject();
		conversationRequest = false;
		current = ctx;
		keepAlive.reset();
	});
	pi.on("session_shutdown", () => {
		conversationRequest = false;
		keepAlive.reset();
		current = undefined;
	});
	pi.on("session_compact", () => keepAlive.forget());
	pi.on("session_tree", () => keepAlive.forget());
	pi.on("model_select", () => {
		conversationRequest = false;
		keepAlive.forget();
	});
	pi.on("thinking_level_select", () => keepAlive.forget());
	pi.on("agent_start", () => keepAlive.turn(true));
	pi.on("agent_settled", () => keepAlive.turn(false));
	pi.events.on(AGENT_RUNS_CHANNEL, (runs) => keepAlive.backgroundRuns(liveRuns(runs)));

	// Only the agent loop's requests are the conversation: compaction and side calls skip the `context` event.
	pi.on("context", () => {
		conversationRequest = true;
		return undefined;
	});
	pi.on("before_provider_request", (event, ctx) => {
		if (!conversationRequest) return undefined;
		if (ctx.model?.provider !== PROVIDER_ID) {
			conversationRequest = false;
			return undefined;
		}
		const payload = event.payload as Partial<Envelope> | undefined;
		if (familyIdOfWireModel(payload?.model) !== ctx.model.id) return undefined;
		conversationRequest = false;
		current = ctx;
		keepAlive.request(payload as Envelope);
		return undefined;
	});
	pi.on("message_end", (event) => {
		const message = event.message;
		if (message.role !== "assistant" || message.provider !== PROVIDER_ID) return undefined;
		keepAlive.answered(message.usage.input + message.usage.cacheRead);
		return undefined;
	});

	pi.registerCommand("agy-quota", {
		description: "Antigravity plan quota: weekly and 5-hour buckets",
		handler: async (_args, ctx) => {
			const access = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_ID);
			if (!access) {
				ctx.ui.notify("No Antigravity login, or it could not be refreshed. Run /login agy.", "warning");
				return;
			}
			try {
				ctx.ui.notify(formatQuota(await fetchQuota(access)), "info");
			} catch (error) {
				ctx.ui.notify(`Antigravity quota unavailable: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
