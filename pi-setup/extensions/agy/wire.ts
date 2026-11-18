import { randomUUID } from "node:crypto";
import type { Family, Tier } from "./catalog";

export const STREAM_URL = "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse";
export const LOAD_CODE_ASSIST_URL = "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
export const QUOTA_URL = "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary";
export const FALLBACK_PROJECT = "aicode-consumers";

export const USER_AGENT = "antigravity/cli/1.5.11 (aidev_client; os_type=darwin; arch=arm64; cl=1024248524; auth_method=consumer)";

/** agy sends this constant, as a JSON string, on every request; it is the int64 of FNV-1a's 64-bit offset basis. */
export const SESSION_ID = "-3750763034362895579";

export interface TextPart {
	text: string;
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
		response: { output?: string; error?: string; parts?: InlineDataPart[] };
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

export interface GenerationConfig {
	maxOutputTokens: number;
	thinkingConfig: { includeThoughts: true; thinkingLevel: string | number };
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

export interface EnvelopeInput {
	state: WireState;
	project: string;
	family: Family;
	tier: Tier;
	contents: Content[];
	systemInstruction?: { role: "user"; parts: { text: string }[] };
	tools: ToolGroup[];
	maxOutputTokens: number;
	now?: number;
}

export function buildEnvelope(input: EnvelopeInput): Envelope {
	const step = input.contents.length;
	const lastRole = input.contents[input.contents.length - 1]?.role;
	// agy names the previous execution only on the first call of a new turn, which is the
	// call whose transcript ends in a user turn after an earlier call.
	const previousExecution = input.state.calls > 0 && lastRole === "user" ? input.state.lastExecutionId : undefined;
	const labels: Record<string, string> = {
		cascade_id: input.state.cascadeId,
		...(previousExecution ? { last_execution_id: previousExecution } : {}),
		last_step_index: String(step - 1),
		model_enum: input.tier.modelEnum,
		request_id: `${input.state.trajectoryId}-${input.state.calls}`,
		root_cascade_id: input.state.cascadeId,
		trajectory_id: input.state.trajectoryId,
		used_claude: "false",
		used_claude_conservative: "false",
		used_non_gemini_model: "false",
	};
	const request: EnvelopeRequest = {
		contents: input.contents,
		...(input.systemInstruction ? { systemInstruction: input.systemInstruction } : {}),
		...(input.tools.length > 0 ? { tools: input.tools } : {}),
		labels,
		generationConfig: {
			maxOutputTokens: input.maxOutputTokens,
			thinkingConfig: { includeThoughts: true, thinkingLevel: input.tier.thinkingLevel },
		},
		sessionId: SESSION_ID,
	};
	return {
		project: input.project,
		requestId: `agent/${input.state.cascadeId}/${input.now ?? Date.now()}/${input.state.trajectoryId}/${step}`,
		request,
		model: `${input.family.id}-${input.tier.name}`,
		userAgent: "antigravity",
		requestType: "agent",
	};
}
