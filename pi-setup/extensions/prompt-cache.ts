import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AGENT_RUNS_CHANNEL, type RunSnapshot } from "./tools/lib/agent-channel";
import { isPlainObject, isPlanRequest, PAYLOAD_LOG_ENV, writePayloadLog } from "./tools/lib/anthropic-sub";
import {
	buildSummaryPayload,
	cacheCompactionBlocker,
	computeFileLists,
	formatFileOperations,
	summaryInstruction,
	summaryMaxTokens,
	withPreviousExtensionFiles,
} from "./tools/lib/cache-compaction";
import { CACHE_PING_CHANNEL, CACHE_PING_ENTRY, type CachePing, KeepAlive, pingBudget } from "./tools/lib/prompt-cache";
import { SUB_AGENT_TOOLS_ENV } from "./tools/lib/sub-agent-prompt";

function report(ctx: ExtensionContext, message: string): void {
	if (ctx.hasUI) ctx.ui.notify(message, "info");
}

function liveRuns(runs: unknown): number {
	return Array.isArray(runs) ? (runs as RunSnapshot[]).filter((run) => run.status === "queued" || run.status === "running").length : 0;
}

export default function promptCache(pi: ExtensionAPI) {
	let contextMessages: readonly unknown[] | undefined;
	let current: ExtensionContext | undefined;

	const keepAlive = new KeepAlive({
		now: Date.now,
		schedule: (fire, ms) => {
			const timer = setTimeout(fire, ms);
			timer.unref?.();
			return () => clearTimeout(timer);
		},
		budget: (promptTokens, ttlMs) => (current?.model ? pingBudget(current.model, promptTokens, ttlMs) : 0),
		ping: async (capture, payload, signal) => {
			const ctx = current;
			const model = ctx?.model;
			if (!ctx || !model || model.id !== capture.modelId || ctx.sessionManager.getSessionId() !== capture.sessionId) return undefined;
			const reply = await ctx.modelRegistry
				.streamSimple(model, { messages: [] }, { signal, maxRetries: 0, sessionId: capture.sessionId, onPayload: () => payload })
				.result();
			return reply.stopReason === "error" || reply.stopReason === "aborted" ? undefined : reply.usage;
		},
		warmed: (capture, usage, ttlMs) => {
			const ping: CachePing = { provider: current?.model?.provider ?? "anthropic", model: capture.modelId, ttlMs, usage };
			pi.appendEntry(CACHE_PING_ENTRY, ping);
			pi.events.emit(CACHE_PING_CHANNEL, ping);
		},
	});

	const forget = () => {
		contextMessages = undefined;
		keepAlive.forget();
	};
	pi.on("session_start", (_event, ctx) => {
		current = ctx;
		forget();
	});
	pi.on("session_tree", forget);
	pi.on("session_compact", forget);
	pi.on("model_select", forget);
	pi.on("session_shutdown", () => {
		forget();
		current = undefined;
	});

	pi.on("agent_start", () => keepAlive.turn(true));
	pi.on("agent_settled", () => keepAlive.turn(false));
	pi.events.on(AGENT_RUNS_CHANNEL, (runs) => keepAlive.backgroundRuns(liveRuns(runs)));

	pi.on("context", (event) => {
		contextMessages = event.messages;
		return undefined;
	});

	pi.on("before_provider_request", (event, ctx) => {
		const payload = event.payload;
		if (!contextMessages || !isPlanRequest(ctx) || !isPlainObject(payload) || payload.model !== ctx.model?.id) return undefined;
		current = ctx;
		keepAlive.request({
			payload,
			messages: contextMessages,
			sessionId: ctx.sessionManager.getSessionId(),
			modelId: ctx.model!.id,
			at: Date.now(),
		});
		contextMessages = undefined;
		return undefined;
	});

	pi.on("message_end", (event, ctx) => {
		const message = event.message as { role?: string; usage?: { input: number; cacheRead: number; cacheWrite: number; cacheWrite1h?: number } };
		if (message.role === "assistant" && message.usage && ctx.model?.provider === "anthropic") keepAlive.answered(message.usage);
		return undefined;
	});

	if (process.env[SUB_AGENT_TOOLS_ENV]?.trim()) return;

	pi.on("session_before_compact", async (event, ctx) => {
		const model = ctx.model;
		const capture = keepAlive.capture;
		if (!model || !isPlanRequest(ctx)) return undefined;
		const { preparation } = event;
		const maxTokens = summaryMaxTokens(
			preparation.settings.reserveTokens,
			model.maxTokens,
			model.contextWindow,
			preparation.tokensBefore,
		);
		const blocker = cacheCompactionBlocker({
			capture,
			ttlMs: keepAlive.lifetimeMs ?? 0,
			now: Date.now(),
			sessionId: ctx.sessionManager.getSessionId(),
			modelId: model.id,
			reason: event.reason,
			needed: [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages],
			maxTokens,
			aborted: event.signal.aborted,
			env: process.env,
		});
		if (blocker || !capture) {
			report(ctx, `Compacting without the prompt cache: ${blocker}.`);
			return undefined;
		}

		const instruction = summaryInstruction(preparation.previousSummary !== undefined, event.customInstructions);
		const payload = buildSummaryPayload(capture.payload, instruction, maxTokens);
		const logPath = process.env[PAYLOAD_LOG_ENV];
		if (logPath) writePayloadLog(logPath, payload);
		try {
			const response = await ctx.modelRegistry
				.streamSimple(
					model,
					{ messages: [{ role: "user", content: [{ type: "text", text: instruction }], timestamp: Date.now() }] },
					{ signal: event.signal, onPayload: () => payload },
				)
				.result();
			const text = response.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
			if (response.stopReason !== "stop" || response.content.some((block) => block.type === "toolCall")) {
				report(ctx, `Compacting without the prompt cache: the summary request ended with ${response.stopReason}.`);
				return undefined;
			}
			if (!text.includes("## Goal")) {
				report(ctx, "Compacting without the prompt cache: the reply was not a checkpoint summary.");
				return undefined;
			}
			const { readFiles, modifiedFiles } = computeFileLists(withPreviousExtensionFiles(preparation.fileOps, event.branchEntries));
			report(ctx, `Compacted from the prompt cache: ${response.usage.cacheRead} tokens read, ${response.usage.cacheWrite} written.`);
			return {
				compaction: {
					summary: text + formatFileOperations(readFiles, modifiedFiles),
					firstKeptEntryId: preparation.firstKeptEntryId,
					tokensBefore: preparation.tokensBefore,
					usage: response.usage,
					details: { readFiles, modifiedFiles },
				},
			};
		} catch (error) {
			report(ctx, `Compacting without the prompt cache: ${error instanceof Error ? error.message : String(error)}.`);
			return undefined;
		}
	});
}
