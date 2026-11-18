import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	JsonObject,
	Model,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	ToolCall,
	TranscriptContext,
	Usage,
} from "@earendil-works/pi-ai";
import { calculateCost, createAssistantMessageEventStream, getCurrentTools } from "@earendil-works/pi-ai";
import { API_ID, type ResolvedModel, resolveModel } from "./catalog";
import { convertTranscript, toToolDeclarations } from "./convert";
import { projectFor } from "./quota";
import { errorText, retryRequest } from "./retry";
import { readSse } from "./sse";
import { buildEnvelope, completeCall, conversation, recordRequest, type Envelope, STREAM_URL, USER_AGENT } from "./wire";

interface WirePart {
	text?: string;
	thought?: boolean;
	thoughtSignature?: string;
	functionCall?: { id?: string; name?: string; args?: unknown };
}

interface WireCandidate {
	content?: { parts?: WirePart[] };
	finishReason?: string;
}

interface WireUsage {
	promptTokenCount?: number;
	candidatesTokenCount?: number;
	thoughtsTokenCount?: number;
	cachedContentTokenCount?: number;
	totalTokenCount?: number;
}

interface WireResponse {
	candidates?: WireCandidate[];
	usageMetadata?: WireUsage;
	modelVersion?: string;
	responseId?: string;
}

interface WireFrame {
	response?: WireResponse;
	error?: { message?: string; status?: string; code?: number } | string;
}

const ERROR_FINISH_REASONS = new Set([
	"SAFETY",
	"RECITATION",
	"BLOCKLIST",
	"PROHIBITED_CONTENT",
	"SPII",
	"IMAGE_SAFETY",
	"IMAGE_PROHIBITED_CONTENT",
	"IMAGE_RECITATION",
	"IMAGE_OTHER",
	"MALFORMED_FUNCTION_CALL",
	"UNEXPECTED_TOOL_CALL",
	"TOO_MANY_TOOL_CALLS",
	"LANGUAGE",
	"NO_IMAGE",
	"FINISH_REASON_UNSPECIFIED",
	"OTHER",
]);

function stopReasonFor(finish: string): AssistantMessage["stopReason"] {
	if (finish === "MAX_TOKENS") return "length";
	if (ERROR_FINISH_REASONS.has(finish)) return "error";
	return "stop";
}

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function applyUsage(usage: Usage, source: WireUsage): void {
	const cached = source.cachedContentTokenCount ?? 0;
	usage.input = Math.max(0, (source.promptTokenCount ?? 0) - cached);
	usage.output = (source.candidatesTokenCount ?? 0) + (source.thoughtsTokenCount ?? 0);
	usage.cacheRead = cached;
	usage.cacheWrite = 0;
	usage.reasoning = source.thoughtsTokenCount ?? 0;
	usage.totalTokens = source.totalTokenCount ?? usage.input + usage.output + usage.cacheRead;
}

function normalizeArguments(raw: unknown): { args: JsonObject; error?: string } {
	if (raw === undefined || raw === null) return { args: {} };
	if (typeof raw === "string") {
		try {
			const parsed: unknown = JSON.parse(raw);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { args: parsed as JsonObject };
			return { args: {}, error: `Tool arguments were not a JSON object: ${raw.slice(0, 200)}` };
		} catch {
			return { args: {}, error: `Tool arguments were not valid JSON: ${raw.slice(0, 200)}` };
		}
	}
	if (typeof raw === "object" && !Array.isArray(raw)) return { args: raw as JsonObject };
	return { args: {}, error: "Tool arguments were not an object" };
}

function headerRecord(headers: Headers): Record<string, string> {
	const record: Record<string, string> = {};
	headers.forEach((value, key) => {
		record[key] = value;
	});
	return record;
}

function httpError(status: number, headers: Headers, body: string): Error {
	const hint = status === 401 || status === 403 ? " The Antigravity login may have expired; run /login agy." : "";
	const error = new Error(`Antigravity request failed (${status}): ${body.slice(0, 600)}${hint}`) as Error & {
		status: number;
		headers: Headers;
	};
	error.status = status;
	error.headers = headers;
	return error;
}

async function send(
	apiKey: string,
	payload: Envelope,
	signal: AbortSignal | undefined,
	doFetch: typeof fetch,
): Promise<Response> {
	const response = await doFetch(STREAM_URL, {
		method: "POST",
		headers: {
			authorization: `Bearer ${apiKey}`,
			"content-type": "application/json",
			"user-agent": USER_AGENT,
		},
		body: JSON.stringify(payload),
		signal,
	});
	if (response.ok) return response;
	throw httpError(response.status, response.headers, await response.text());
}

function frameErrorText(error: WireFrame["error"]): string {
	if (typeof error === "string") return error;
	if (error && typeof error === "object" && typeof error.message === "string") return error.message;
	return JSON.stringify(error);
}

async function consume(
	body: ReadableStream<Uint8Array>,
	output: AssistantMessage,
	model: Model<Api>,
	resolved: ResolvedModel,
	events: AssistantMessageEventStream,
	options: StreamOptions,
): Promise<void> {
	let openIndex = -1;
	let syntheticIds = 0;

	const currentBlock = (): TextContent | ThinkingContent => output.content[openIndex] as TextContent | ThinkingContent;

	const closeCurrent = (): void => {
		if (openIndex < 0) return;
		const block = currentBlock();
		if (block.type === "text") events.push({ type: "text_end", contentIndex: openIndex, content: block.text, partial: output });
		else events.push({ type: "thinking_end", contentIndex: openIndex, content: block.thinking, partial: output });
		openIndex = -1;
	};

	const openText = (thinking: boolean): void => {
		closeCurrent();
		const contentIndex = output.content.length;
		if (thinking) {
			output.content.push({ type: "thinking", thinking: "" });
			events.push({ type: "thinking_start", contentIndex, partial: output });
		} else {
			output.content.push({ type: "text", text: "" });
			events.push({ type: "text_start", contentIndex, partial: output });
		}
		openIndex = contentIndex;
	};

	for await (const raw of readSse(body)) {
		const frame = raw as WireFrame;
		await options.onProviderStreamEvent?.(frame, model);
		if (frame.error !== undefined) throw new Error(`Antigravity stream error: ${frameErrorText(frame.error)}`);
		const response = frame.response;
		if (!response) continue;
		if (!output.responseId && response.responseId) output.responseId = response.responseId;
		if (response.modelVersion) output.responseModel = response.modelVersion;

		for (const candidate of response.candidates ?? []) {
			for (const part of candidate.content?.parts ?? []) {
				if (part.text !== undefined) {
					const thinking = part.thought === true;
					const open = openIndex >= 0 ? currentBlock() : undefined;
					if (!open || (thinking && open.type !== "thinking") || (!thinking && open.type !== "text")) openText(thinking);
					const block = currentBlock();
					if (block.type === "thinking") {
						block.thinking += part.text;
						block.thinkingSignature = part.thoughtSignature || block.thinkingSignature;
						events.push({ type: "thinking_delta", contentIndex: openIndex, delta: part.text, partial: output });
					} else {
						block.text += part.text;
						block.textSignature = part.thoughtSignature || block.textSignature;
						events.push({ type: "text_delta", contentIndex: openIndex, delta: part.text, partial: output });
					}
				}
				if (part.functionCall) {
					closeCurrent();
					const name = part.functionCall.name ?? "";
					let id = part.functionCall.id ?? "";
					if (!id || output.content.some((entry) => entry.type === "toolCall" && entry.id === id)) {
						id = `${name || "tool"}_${Date.now()}_${++syntheticIds}`;
					}
					const { args, error } = normalizeArguments(part.functionCall.args);
					const toolCall: ToolCall = {
						type: "toolCall",
						id,
						name,
						arguments: args,
						...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
						...(error ? { argumentsError: error } : {}),
					};
					output.content.push(toolCall);
					const contentIndex = output.content.length - 1;
					events.push({ type: "toolcall_start", contentIndex, partial: output });
					events.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(toolCall.arguments), partial: output });
					events.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
				}
			}
			if (candidate.finishReason) {
				output.stopReason = stopReasonFor(candidate.finishReason);
				if (output.stopReason === "error") output.errorMessage = `Antigravity stopped with ${candidate.finishReason}`;
			}
		}
		if (response.usageMetadata) applyUsage(output.usage, response.usageMetadata);
	}

	closeCurrent();
	output.providerThinkingLevel = resolved.tier.name;
}


async function logPayload(payload: Envelope): Promise<void> {
	try {
		const { appendFile } = await import("node:fs/promises");
		await appendFile(process.env.PI_AGY_PAYLOAD_LOG as string, `${JSON.stringify(payload)}\n`);
	} catch {
		// a debug log never fails a request
	}
}

async function run(
	model: Model<Api>,
	context: TranscriptContext,
	options: StreamOptions,
	events: AssistantMessageEventStream,
): Promise<void> {
	const output: AssistantMessage = {
		role: "assistant",
		content: [],
		api: API_ID,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(),
		stopReason: "pending",
		timestamp: Date.now(),
	};
	try {
		const resolved = resolveModel(model.id);
		if (!resolved) throw new Error(`Antigravity does not serve ${model.id}`);
		const apiKey = options.apiKey;
		if (!apiKey) throw new Error(`No Antigravity credential for ${model.id}. Run /login agy.`);

		const transcript = convertTranscript(context);
		if (transcript.contents.length === 0) throw new Error("Antigravity request has no messages");
		const project = await projectFor(apiKey, options.signal);
		const envelope = buildEnvelope({
			state: conversation,
			project,
			family: resolved.family,
			tier: resolved.tier,
			contents: transcript.contents,
			systemInstruction: transcript.systemInstruction,
			tools: toToolDeclarations(getCurrentTools(context.messages)),
			maxOutputTokens: Math.min(options.maxTokens ?? resolved.family.maxOutputTokens, resolved.family.maxOutputTokens),
		});

		recordRequest(conversation);
		const replacement = await options.onPayload?.(envelope, model);
		const payload = (replacement === undefined ? envelope : replacement) as Envelope;
		if (process.env.PI_AGY_PAYLOAD_LOG) await logPayload(payload);

		const doFetch = options.fetch ?? fetch;
		const response = await retryRequest(() => send(apiKey, payload, options.signal, doFetch), {
			maxRetries: options.maxRetries,
			maxRetryDelayMs: options.maxRetryDelayMs,
			signal: options.signal,
		});
		await options.onResponse?.({ status: response.status, headers: headerRecord(response.headers) }, model);
		if (!response.body) throw new Error("Antigravity returned an empty response body");

		events.push({ type: "start", partial: output });
		await consume(response.body, output, model, resolved, events, options);

		if (options.signal?.aborted) throw new Error("Request was aborted");
		if (output.stopReason === "pending") throw new Error("Antigravity stream ended without a finish reason");
		if (output.stopReason === "error") throw new Error(output.errorMessage ?? "Antigravity stopped with an error");
		if (output.stopReason === "stop" && output.content.some((entry) => entry.type === "toolCall")) output.stopReason = "toolUse";

		calculateCost(model, output.usage);
		completeCall(conversation);
		events.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
		events.end();
	} catch (error) {
		output.stopReason = options.signal?.aborted ? "aborted" : "error";
		output.errorMessage = errorText(error);
		events.push({ type: "error", reason: output.stopReason, error: output });
		events.end();
	}
}

export const stream: StreamFunction<Api, StreamOptions> = (model, context, options) => {
	const events = createAssistantMessageEventStream();
	void run(model, context, options ?? {}, events);
	return events;
};

export const streamSimple: StreamFunction<Api, SimpleStreamOptions> = (model, context, options) => {
	const apiKey = options?.apiKey;
	if (!apiKey) throw new Error(`No Antigravity credential for ${model.provider}. Run /login agy.`);
	return stream(model, context, {
		maxTokens: options?.maxTokens ?? model.maxTokens,
		signal: options?.signal,
		apiKey,
		fetch: options?.fetch,
		onPayload: options?.onPayload,
		onResponse: options?.onResponse,
		onProviderStreamEvent: options?.onProviderStreamEvent,
		maxRetries: options?.maxRetries,
		maxRetryDelayMs: options?.maxRetryDelayMs,
	});
};
