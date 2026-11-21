import { randomUUID } from "node:crypto";
import type { Family, Tier } from "./catalog";

export const STREAM_URL = "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse";
export const LOAD_CODE_ASSIST_URL = "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
export const QUOTA_URL = "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary";
export const FALLBACK_PROJECT = "aicode-consumers";

export const USER_AGENT = "antigravity/cli/1.5.14 (aidev_client; os_type=darwin; arch=arm64; cl=1026970498; auth_method=consumer)";

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;

/**
 * Signed 64-bit FNV-1a decimal string matching agy 1.5.14's `sessionId` (which hashes `cascade_id`;
 * older agy 1.5.11–1.5.13 hashed `""` to `"-3750763034362895579"`). Hashing pi's session id gives
 * each conversation its own stable cache-affinity key across turns and resumes.
 */
export function agySessionId(key: string): string {
	let hash = FNV_OFFSET;
	for (const byte of new TextEncoder().encode(key)) {
		hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * FNV_PRIME);
	}
	return BigInt.asIntN(64, hash).toString();
}

export interface TextPart {
	text: string;
	thought?: true;
	thoughtSignature?: string;
}

export interface InlineDataPart {
	inlineData: { mimeType: string; data: string };
}

export interface FunctionCallPart {
	functionCall: { id: string; name: string; args: Record<string, unknown> };
	thoughtSignature?: string;
}

export interface FunctionResponsePart {
	functionResponse: {
		id: string;
		name: string;
		response: { output?: string; error?: string };
		parts?: InlineDataPart[];
	};
}

export type Part = TextPart | InlineDataPart | FunctionCallPart | FunctionResponsePart;

export interface Content {
	role: "user" | "model";
	parts: Part[];
}

export interface ToolDeclaration {
	name: string;
	description: string;
	parameters?: Record<string, unknown>;
}

export interface ToolGroup {
	functionDeclarations: ToolDeclaration[];
}

export type WireThinkingConfig =
	| { includeThoughts: true; thinkingLevel: string | number }
	| { includeThoughts: true; thinkingBudget: number };

export interface GenerationConfig {
	maxOutputTokens: number;
	thinkingConfig: WireThinkingConfig;
	stopSequences?: string[];
}

export interface EnvelopeRequest {
	contents: Content[];
	systemInstruction?: { role: "user"; parts: { text: string }[] };
	tools?: ToolGroup[];
	labels: Record<string, string>;
	generationConfig: GenerationConfig;
	sessionId: string;
}

export interface Envelope {
	project: string;
	requestId: string;
	request: EnvelopeRequest;
	model: string;
	userAgent: "antigravity";
	requestType: "agent";
}

export interface WireState {
	cascadeId: string;
	trajectoryId: string;
	calls: number;
	lastExecutionId?: string;
}

export function newWireState(): WireState {
	return { cascadeId: randomUUID(), trajectoryId: randomUUID(), calls: 0 };
}

export const conversation: WireState = newWireState();

export function resetConversation(): void {
	conversation.cascadeId = randomUUID();
	conversation.trajectoryId = randomUUID();
	conversation.calls = 0;
	conversation.lastExecutionId = undefined;
}

export function recordRequest(state: WireState): void {
	state.calls += 1;
}

export function completeCall(state: WireState): void {
	state.lastExecutionId = randomUUID();
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Reuse a UUID session id as `cascade_id` so `sessionId === agySessionId(cascade_id)` like agy 1.5.14. */
export function cascadeIdFor(state: WireState, sessionId: string | undefined): string {
	return sessionId && UUID_RE.test(sessionId) ? sessionId : state.cascadeId;
}

export interface EnvelopeInput {
	state: WireState;
	project: string;
	family: Family;
	tier: Tier;
	contents: Content[];
	systemInstruction?: { role: "user"; parts: { text: string }[] };
	tools: ToolGroup[];
	maxOutputTokens: number;
	stopSequences: readonly string[];
	sessionId: string;
	cascadeId?: string;
	now?: number;
}

export function buildEnvelope(input: EnvelopeInput): Envelope {
	const step = input.contents.length;
	const cascadeId = input.cascadeId ?? input.state.cascadeId;
	const last = input.contents[input.contents.length - 1];
	// agy names the previous execution only on the first call of a new user turn — never on a
	// mid-turn tool result (which uses role "user" on Claude and role "model" on Gemini/GPT-OSS).
	const isNewUserTurn = last?.role === "user" && !last.parts.some((part) => "functionResponse" in part);
	const previousExecution = input.state.calls > 0 && isNewUserTurn ? input.state.lastExecutionId : undefined;
	const isClaude = input.family.backend === "claude";
	const isGemini = input.family.backend === "gemini";
	const labels: Record<string, string> = {
		cascade_id: cascadeId,
		...(previousExecution ? { last_execution_id: previousExecution } : {}),
		last_step_index: String(step - 1),
		model_enum: input.tier.modelEnum,
		request_id: `${input.state.trajectoryId}-${input.state.calls}`,
		root_cascade_id: cascadeId,
		trajectory_id: input.state.trajectoryId,
		used_claude: isClaude ? "true" : "false",
		used_claude_conservative: isClaude ? "true" : "false",
		used_non_gemini_model: isGemini ? "false" : "true",
	};
	const thinkingConfig: WireThinkingConfig =
		input.tier.thinking.kind === "level"
			? { includeThoughts: true, thinkingLevel: input.tier.thinking.value }
			: { includeThoughts: true, thinkingBudget: input.tier.thinking.value };
	const generationConfig: GenerationConfig = {
		maxOutputTokens: input.maxOutputTokens,
		thinkingConfig,
		...(input.stopSequences.length > 0 ? { stopSequences: [...input.stopSequences] } : {}),
	};
	const request: EnvelopeRequest = {
		contents: input.contents,
		...(input.systemInstruction ? { systemInstruction: input.systemInstruction } : {}),
		...(input.tools.length > 0 ? { tools: input.tools } : {}),
		labels,
		generationConfig,
		sessionId: input.sessionId,
	};
	return {
		project: input.project,
		requestId: `agent/${cascadeId}/${input.now ?? Date.now()}/${input.state.trajectoryId}/${step}`,
		request,
		model: `${input.family.id}-${input.tier.name}`,
		userAgent: "antigravity",
		requestType: "agent",
	};
}

/**
 * agy's own keep-alive read (`modelapiccpa.keepAlives`, server-gated off): the last request again,
 * stamped now, labelled `prompt_cache_keep_alive`, one output token. Contents stay byte for byte,
 * so the read covers the whole cached prefix.
 */
export function keepAliveEnvelope(envelope: Envelope, now: number): Envelope {
	const [kind, cascade, , trajectory, step] = envelope.requestId.split("/");
	return {
		...envelope,
		requestId: `${kind}/${cascade}/${now}/${trajectory}/${step}`,
		request: {
			...envelope.request,
			labels: { ...envelope.request.labels, prompt_cache_keep_alive: "true" },
			generationConfig: { ...envelope.request.generationConfig, maxOutputTokens: 1 },
		},
	};
}
