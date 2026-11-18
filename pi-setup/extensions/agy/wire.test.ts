import { describe, expect, test } from "bun:test";
import { FAMILIES, MODELS, resolveModel } from "./catalog";
import { buildEnvelope, completeCall, newWireState, recordRequest, SESSION_ID, STREAM_URL, USER_AGENT } from "./wire";

const AGY_USER_AGENT =
	"antigravity/cli/1.5.11 (aidev_client; os_type=darwin; arch=arm64; cl=1024248524; auth_method=consumer)";

function envelopeOf(modelId: string) {
	const resolved = resolveModel(modelId);
	if (!resolved) throw new Error(`missing model ${modelId}`);
	const state = newWireState();
	return buildEnvelope({
		state,
		project: "aicode-consumers",
		family: resolved.family,
		tier: resolved.tier,
		contents: [{ role: "user", parts: [{ text: "hi" }] }],
		systemInstruction: { role: "user", parts: [{ text: "sys" }] },
		tools: [{ functionDeclarations: [{ name: "read", description: "read", parameters: { type: "OBJECT" } }] }],
		maxOutputTokens: resolved.family.maxOutputTokens,
		now: 1794993179992,
	});
}

describe("wire matches agy byte for byte", () => {
	test("endpoint, user agent, session id", () => {
		expect(STREAM_URL).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse");
		expect(USER_AGENT).toBe(AGY_USER_AGENT);
		expect(SESSION_ID).toBe("-3750763034362895579");
	});

	test("envelope key order is the order agy sends", () => {
		expect(Object.keys(envelopeOf("gemini-4-hydrogen-low"))).toEqual([
			"project",
			"requestId",
			"request",
			"model",
			"userAgent",
			"requestType",
		]);
	});

	test("request key order, labels and generation config match agy's shape", () => {
		const envelope = envelopeOf("gemini-4-hydrogen-low");
		expect(Object.keys(envelope.request)).toEqual([
			"contents",
			"systemInstruction",
			"tools",
			"labels",
			"generationConfig",
			"sessionId",
		]);
		expect(Object.keys(envelope.request.labels)).toEqual([
			"cascade_id",
			"last_step_index",
			"model_enum",
			"request_id",
			"root_cascade_id",
			"trajectory_id",
			"used_claude",
			"used_claude_conservative",
			"used_non_gemini_model",
		]);
		expect(envelope.request.generationConfig).toEqual({
			maxOutputTokens: 262144,
			thinkingConfig: { includeThoughts: true, thinkingLevel: "LOW" },
		});
		expect(envelope.request.sessionId).toBe(SESSION_ID);
		expect(JSON.parse(JSON.stringify(envelope)).request.sessionId).toBe("-3750763034362895579");
		expect(envelope.model).toBe("gemini-4-hydrogen-low");
		expect(envelope.userAgent).toBe("antigravity");
		expect(envelope.requestType).toBe("agent");
		expect(envelope.requestId).toMatch(/^agent\/[0-9a-f-]{36}\/\d+\/[0-9a-f-]{36}\/1$/);
		const [kind, cascade, , trajectory, step] = envelope.requestId.split("/");
		expect(kind).toBe("agent");
		expect(cascade).toBe(envelope.request.labels.cascade_id);
		expect(trajectory).toBe(envelope.request.labels.trajectory_id);
		expect(step).toBe("1");
	});

	test("a call after an earlier turn names the previous execution, a mid-turn call does not", () => {
		const state = newWireState();
		const first = envelopeOf("gemini-4-carbon-high");
		expect("last_execution_id" in first.request.labels).toBe(false);

		state.calls = 1;
		state.lastExecutionId = "11111111-2222-3333-4444-555555555555";
		const midTurn = buildEnvelope({
			state,
			project: "p",
			family: FAMILIES[0]!,
			tier: FAMILIES[0]!.tiers[0]!,
			contents: [
				{ role: "user", parts: [{ text: "hi" }] },
				{ role: "model", parts: [{ functionCall: { id: "1", name: "read", args: {} } }] },
			],
			tools: [],
			maxOutputTokens: 10,
		});
		expect("last_execution_id" in midTurn.request.labels).toBe(false);

		const newTurn = buildEnvelope({
			state,
			project: "p",
			family: FAMILIES[0]!,
			tier: FAMILIES[0]!.tiers[0]!,
			contents: [
				{ role: "user", parts: [{ text: "hi" }] },
				{ role: "model", parts: [{ text: "done" }] },
				{ role: "user", parts: [{ text: "again" }] },
			],
			tools: [],
			maxOutputTokens: 10,
		});
		expect(newTurn.request.labels.last_execution_id).toBe("11111111-2222-3333-4444-555555555555");
		expect(Object.keys(newTurn.request.labels).slice(0, 2)).toEqual(["cascade_id", "last_execution_id"]);
		expect(newTurn.requestId.endsWith("/3")).toBe(true);
		expect(newTurn.request.labels.last_step_index).toBe("2");
		expect(newTurn.request.labels.request_id.endsWith("-1")).toBe(true);
	});

	test("a request takes the next id before it is sent, an execution lands only when it finishes", () => {
		const state = newWireState();
		const first = buildEnvelope({
			state,
			project: "p",
			family: FAMILIES[0]!,
			tier: FAMILIES[0]!.tiers[0]!,
			contents: [{ role: "user", parts: [{ text: "hi" }] }],
			tools: [],
			maxOutputTokens: 10,
		});
		expect(first.request.labels.request_id.endsWith("-0")).toBe(true);
		recordRequest(state);
		expect(state.calls).toBe(1);
		expect(state.lastExecutionId).toBeUndefined();

		const second = buildEnvelope({
			state,
			project: "p",
			family: FAMILIES[0]!,
			tier: FAMILIES[0]!.tiers[0]!,
			contents: [{ role: "user", parts: [{ text: "hi" }] }],
			tools: [],
			maxOutputTokens: 10,
		});
		expect(second.request.labels.request_id.endsWith("-1")).toBe(true);
		expect("last_execution_id" in second.request.labels).toBe(false);

		completeCall(state);
		expect(state.lastExecutionId).toMatch(/^[0-9a-f-]{36}$/);
		expect(state.calls).toBe(1);
	});

	test("every model carries agy's id, enum and output ceiling", () => {
		const expected: Record<string, [string, number, string | number]> = {
			"gemini-4-carbon-medium": ["MODEL_PLACEHOLDER_M437", 262144, "MEDIUM"],
			"gemini-4-carbon-high": ["MODEL_PLACEHOLDER_M427", 262144, "HIGH"],
			"gemini-4-argon-medium": ["MODEL_PLACEHOLDER_M418", 65536, "MEDIUM"],
			"gemini-4-argon-high": ["MODEL_PLACEHOLDER_M417", 65536, "HIGH"],
			"gemini-4-hydrogen-low": ["MODEL_PLACEHOLDER_M527", 262144, "LOW"],
			"gemini-4-hydrogen-medium": ["MODEL_PLACEHOLDER_M526", 262144, "MEDIUM"],
			"gemini-4-hydrogen-high": ["MODEL_PLACEHOLDER_M525", 262144, "HIGH"],
			"gemini-4-hydrogen-xhigh": ["MODEL_PLACEHOLDER_M528", 262144, 100],
		};
		expect(MODELS.map((model) => model.id).sort()).toEqual(Object.keys(expected).sort());
		for (const [id, [modelEnum, maxOutputTokens, thinkingLevel]] of Object.entries(expected)) {
			const envelope = envelopeOf(id);
			expect(envelope.request.labels.model_enum).toBe(modelEnum);
			expect(envelope.request.generationConfig.maxOutputTokens).toBe(maxOutputTokens);
			expect(envelope.request.generationConfig.thinkingConfig.thinkingLevel).toBe(thinkingLevel);
			expect(envelope.request.labels.used_claude).toBe("false");
			expect(envelope.request.labels.used_non_gemini_model).toBe("false");
		}
	});

	test("no model advertises a level it cannot send", () => {
		for (const model of MODELS) {
			const levels = Object.entries(model.thinkingLevelMap ?? {}).filter(([, value]) => value !== null);
			expect(levels).toHaveLength(1);
			const tier = model.id.slice(model.id.lastIndexOf("-") + 1);
			expect(levels[0]![0]).toBe(tier);
			expect(model.contextWindow).toBe(1_048_576);
			expect(model.maxTokens).toBeLessThanOrEqual(262144);
			expect(model.input).toEqual(["text", "image"]);
		}
	});
});
