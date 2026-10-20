import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isPlainObject, isPlanRequest, PAYLOAD_LOG_ENV, writePayloadLog } from "./tools/lib/anthropic-sub";
import {
	buildSummaryPayload,
	type CapturedRequest,
	cacheCompactionBlocker,
	computeFileLists,
	formatFileOperations,
	summaryInstruction,
	summaryMaxTokens,
	withPreviousExtensionFiles,
} from "./tools/lib/cache-compaction";
import { SUB_AGENT_TOOLS_ENV } from "./tools/lib/sub-agent-prompt";

function report(ctx: ExtensionContext, message: string): void {
	if (ctx.hasUI) ctx.ui.notify(message, "info");
}

export default function cacheCompaction(pi: ExtensionAPI) {
	if (process.env[SUB_AGENT_TOOLS_ENV]?.trim()) return;

	let contextMessages: readonly unknown[] | undefined;
	let capture: CapturedRequest | undefined;
	const forget = () => {
		contextMessages = undefined;
		capture = undefined;
	};
	pi.on("session_start", forget);
	pi.on("session_tree", forget);
	pi.on("session_compact", forget);

	pi.on("context", (event) => {
		contextMessages = event.messages;
		return undefined;
	});

	pi.on("before_provider_request", (event, ctx) => {
		const payload = event.payload;
		if (!isPlanRequest(ctx) || !isPlainObject(payload) || payload.model !== ctx.model?.id) return undefined;
		if (contextMessages) {
			capture = {
				payload,
				messages: contextMessages,
				sessionId: ctx.sessionManager.getSessionId(),
				modelId: ctx.model!.id,
				at: Date.now(),
			};
			contextMessages = undefined;
		} else if (capture && payload.max_tokens === 1) {
			// A cache-warmer replay of the captured request: no context event, and its read refreshes the entry.
			capture.at = Date.now();
		}
		return undefined;
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const model = ctx.model;
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
