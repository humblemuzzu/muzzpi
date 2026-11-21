import { describe, expect, test } from "bun:test";
import { getSupportedThinkingLevels, type ThinkingLevel } from "@earendil-works/pi-ai";
import { FAMILIES, familyIdOfWireModel, MODELS, resolveModel } from "./catalog";
import { STOP_SEQUENCES } from "./framing";
import {
	agySessionId,
	buildEnvelope,
	cascadeIdFor,
	completeCall,
	keepAliveEnvelope,
	newWireState,
	recordRequest,
	STREAM_URL,
	USER_AGENT,
} from "./wire";

const AGY_SESSION_ID = "-3750763034362895579";
const SESSION = agySessionId("01a1f2a2-d95d-7718-826d-2f920777cbaf");

const AGY_USER_AGENT =
	"antigravity/cli/1.5.14 (aidev_client; os_type=darwin; arch=arm64; cl=1026970498; auth_method=consumer)";

function envelopeOf(modelId: string, reasoning?: ThinkingLevel) {
	const resolved = resolveModel(modelId, reasoning);
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
		stopSequences: resolved.family.backend === "gemini" ? STOP_SEQUENCES : [],
		sessionId: SESSION,
		now: 1794993179992,
	});
}

describe("wire matches agy byte for byte", () => {
	test("endpoint and user agent", () => {
		expect(STREAM_URL).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse");
		expect(USER_AGENT).toBe(AGY_USER_AGENT);
	});

	test("the session id hashes like agy 1.5.14: matches captured cascade_id and gives each pi session its own", () => {
		expect(agySessionId("")).toBe(AGY_SESSION_ID);
		expect(agySessionId("a6355a19-2732-4022-9fbf-4c12fdd9290a")).toBe("-5796187971439324348");
		expect(agySessionId("a")).toBe(BigInt.asIntN(64, 0xaf63dc4c8601ec8cn).toString());
		expect(SESSION).toMatch(/^-?\d+$/);
		expect(SESSION).not.toBe(AGY_SESSION_ID);
		expect(agySessionId("01a1f2a2-d95d-7718-826d-2f920777cbaf")).toBe(SESSION);
		expect(agySessionId("01a1f25a-0cac-72f8-9d0f-e97b92edf135")).not.toBe(SESSION);

		const state = newWireState();
		expect(cascadeIdFor(state, "a6355a19-2732-4022-9fbf-4c12fdd9290a")).toBe("a6355a19-2732-4022-9fbf-4c12fdd9290a");
		expect(cascadeIdFor(state, "chad-1234")).toBe(state.cascadeId);
		expect(cascadeIdFor(state, undefined)).toBe(state.cascadeId);
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
			stopSequences: [...STOP_SEQUENCES],
		});
		expect(Object.keys(envelope.request.generationConfig)).toEqual(["maxOutputTokens", "thinkingConfig", "stopSequences"]);
		expect(JSON.parse(JSON.stringify(envelope)).request.sessionId).toBe(SESSION);
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
			stopSequences: [],
			sessionId: SESSION,
		});
		expect("last_execution_id" in midTurn.request.labels).toBe(false);

		const claudeMidTurn = buildEnvelope({
			state,
			project: "p",
			family: FAMILIES.find((f) => f.id === "claude-sonnet-5-5")!,
			tier: FAMILIES.find((f) => f.id === "claude-sonnet-5-5")!.tiers[0]!,
			contents: [
				{ role: "user", parts: [{ text: "hi" }] },
				{ role: "model", parts: [{ functionCall: { id: "1", name: "read", args: {} } }] },
				{ role: "user", parts: [{ functionResponse: { id: "1", name: "read", response: { output: "ok" } } }] },
			],
			tools: [],
			maxOutputTokens: 10,
			stopSequences: [],
			sessionId: SESSION,
		});
		expect("last_execution_id" in claudeMidTurn.request.labels).toBe(false);

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
			stopSequences: [],
			sessionId: SESSION,
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
			stopSequences: [],
			sessionId: SESSION,
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
			stopSequences: [],
			sessionId: SESSION,
		});
		expect(second.request.labels.request_id.endsWith("-1")).toBe(true);
		expect("last_execution_id" in second.request.labels).toBe(false);

		completeCall(state);
		expect(state.lastExecutionId).toMatch(/^[0-9a-f-]{36}$/);
		expect(state.calls).toBe(1);
	});

	test("every family + thinking level maps to agy's wire slug, enum, labels, and thinking config", () => {
		expect(MODELS.map((model) => model.id)).toEqual([
			"gemini-4-neon",
			"gemini-4-carbon",
			"gemini-4-argon",
			"gemini-4-hydrogen",
			"gemini-3.8-flash",
			"claude-opus-5-5",
			"claude-sonnet-5-5",
			"gpt-oss-120b",
		]);
		const cases: Array<[string, ThinkingLevel, string, string, number, Record<string, unknown>, string, string]> = [
			["gemini-4-neon", "low", "gemini-4-neon-low", "MODEL_PLACEHOLDER_M534", 262144, { includeThoughts: true, thinkingLevel: "LOW" }, "false", "false"],
			["gemini-4-neon", "medium", "gemini-4-neon-medium", "MODEL_PLACEHOLDER_M533", 262144, { includeThoughts: true, thinkingLevel: "MEDIUM" }, "false", "false"],
			["gemini-4-neon", "high", "gemini-4-neon-high", "MODEL_PLACEHOLDER_M532", 262144, { includeThoughts: true, thinkingLevel: "HIGH" }, "false", "false"],
			["gemini-4-neon", "xhigh", "gemini-4-neon-xhigh", "MODEL_PLACEHOLDER_M535", 262144, { includeThoughts: true, thinkingLevel: 100 }, "false", "false"],
			["gemini-4-carbon", "low", "gemini-4-carbon-low", "MODEL_PLACEHOLDER_M438", 262144, { includeThoughts: true, thinkingLevel: "LOW" }, "false", "false"],
			["gemini-4-carbon", "medium", "gemini-4-carbon-medium", "MODEL_PLACEHOLDER_M437", 262144, { includeThoughts: true, thinkingLevel: "MEDIUM" }, "false", "false"],
			["gemini-4-carbon", "high", "gemini-4-carbon-high", "MODEL_PLACEHOLDER_M427", 262144, { includeThoughts: true, thinkingLevel: "HIGH" }, "false", "false"],
			["gemini-4-argon", "low", "gemini-4-argon-low", "MODEL_PLACEHOLDER_M419", 65536, { includeThoughts: true, thinkingLevel: "LOW" }, "false", "false"],
			["gemini-4-argon", "medium", "gemini-4-argon-medium", "MODEL_PLACEHOLDER_M418", 65536, { includeThoughts: true, thinkingLevel: "MEDIUM" }, "false", "false"],
			["gemini-4-argon", "high", "gemini-4-argon-high", "MODEL_PLACEHOLDER_M417", 65536, { includeThoughts: true, thinkingLevel: "HIGH" }, "false", "false"],
			["gemini-4-hydrogen", "low", "gemini-4-hydrogen-low", "MODEL_PLACEHOLDER_M527", 262144, { includeThoughts: true, thinkingLevel: "LOW" }, "false", "false"],
			["gemini-4-hydrogen", "medium", "gemini-4-hydrogen-medium", "MODEL_PLACEHOLDER_M526", 262144, { includeThoughts: true, thinkingLevel: "MEDIUM" }, "false", "false"],
			["gemini-4-hydrogen", "high", "gemini-4-hydrogen-high", "MODEL_PLACEHOLDER_M525", 262144, { includeThoughts: true, thinkingLevel: "HIGH" }, "false", "false"],
			["gemini-4-hydrogen", "xhigh", "gemini-4-hydrogen-xhigh", "MODEL_PLACEHOLDER_M528", 262144, { includeThoughts: true, thinkingLevel: 100 }, "false", "false"],
			["gemini-3.8-flash", "low", "gemini-3.8-flash-low", "MODEL_PLACEHOLDER_M320", 65536, { includeThoughts: true, thinkingLevel: "LOW" }, "false", "false"],
			["gemini-3.8-flash", "medium", "gemini-3.8-flash-medium", "MODEL_PLACEHOLDER_M319", 65536, { includeThoughts: true, thinkingLevel: "MEDIUM" }, "false", "false"],
			["gemini-3.8-flash", "high", "gemini-3.8-flash-high", "MODEL_PLACEHOLDER_M318", 65536, { includeThoughts: true, thinkingLevel: "HIGH" }, "false", "false"],
			["claude-opus-5-5", "low", "claude-opus-5-5-low", "MODEL_PLACEHOLDER_M400", 128000, { includeThoughts: true, thinkingLevel: "LOW" }, "true", "true"],
			["claude-opus-5-5", "medium", "claude-opus-5-5-medium", "MODEL_PLACEHOLDER_M401", 128000, { includeThoughts: true, thinkingLevel: "MEDIUM" }, "true", "true"],
			["claude-opus-5-5", "high", "claude-opus-5-5-high", "MODEL_PLACEHOLDER_M402", 128000, { includeThoughts: true, thinkingLevel: "HIGH" }, "true", "true"],
			["claude-sonnet-5-5", "low", "claude-sonnet-5-5-low", "MODEL_PLACEHOLDER_M403", 128000, { includeThoughts: true, thinkingLevel: "LOW" }, "true", "true"],
			["claude-sonnet-5-5", "medium", "claude-sonnet-5-5-medium", "MODEL_PLACEHOLDER_M404", 128000, { includeThoughts: true, thinkingLevel: "MEDIUM" }, "true", "true"],
			["claude-sonnet-5-5", "high", "claude-sonnet-5-5-high", "MODEL_PLACEHOLDER_M405", 128000, { includeThoughts: true, thinkingLevel: "HIGH" }, "true", "true"],
			["gpt-oss-120b", "medium", "gpt-oss-120b-medium", "MODEL_OPENAI_GPT_OSS_120B_MEDIUM", 32768, { includeThoughts: true, thinkingBudget: 8192 }, "false", "true"],
		];
		for (const [familyId, reasoning, wireModel, modelEnum, maxOutputTokens, thinkingConfig, usedClaude, usedNonGemini] of cases) {
			const envelope = envelopeOf(familyId, reasoning);
			expect(envelope.model).toBe(wireModel);
			expect(familyIdOfWireModel(wireModel)).toBe(familyId);
			expect(envelope.request.labels.model_enum).toBe(modelEnum);
			expect(envelope.request.generationConfig.maxOutputTokens).toBe(maxOutputTokens);
			expect(envelope.request.generationConfig.thinkingConfig).toEqual(thinkingConfig);
			expect(envelope.request.labels.used_claude).toBe(usedClaude);
			expect(envelope.request.labels.used_claude_conservative).toBe(usedClaude);
			expect(envelope.request.labels.used_non_gemini_model).toBe(usedNonGemini);
			if (usedNonGemini === "true") expect(envelope.request.generationConfig.stopSequences).toBeUndefined();
			else expect(envelope.request.generationConfig.stopSequences).toEqual([...STOP_SEQUENCES]);
		}
		// Clamping unsupported thinking levels: xhigh on carbon clamps to high; high on gpt-oss clamps to medium.
		expect(resolveModel("gemini-4-carbon", "xhigh")?.wireModel).toBe("gemini-4-carbon-high");
		expect(resolveModel("gpt-oss-120b", "high")?.wireModel).toBe("gpt-oss-120b-medium");
		expect(resolveModel("gemini-4-neon", "minimal")?.wireModel).toBe("gemini-4-neon-low");
	});

	test("a keep-alive read is the request again, stamped now, labelled, one output token", () => {
		const envelope = envelopeOf("gemini-4-neon", "high");
		const before = JSON.stringify(envelope);
		const ping = keepAliveEnvelope(envelope, 1795000000000);
		expect(JSON.stringify(envelope)).toBe(before);
		expect(ping.request.contents).toBe(envelope.request.contents);
		expect(ping.request.systemInstruction).toBe(envelope.request.systemInstruction);
		expect(ping.request.tools).toBe(envelope.request.tools);
		expect(ping.request.sessionId).toBe(envelope.request.sessionId);
		expect(ping.request.generationConfig).toEqual({ ...envelope.request.generationConfig, maxOutputTokens: 1 });
		expect(ping.request.labels).toEqual({ ...envelope.request.labels, prompt_cache_keep_alive: "true" });
		const [kind, cascade, , trajectory, step] = envelope.requestId.split("/");
		expect(ping.requestId).toBe(`${kind}/${cascade}/1795000000000/${trajectory}/${step}`);
		expect(Object.keys(ping)).toEqual(Object.keys(envelope));
	});

	test("each model advertises exactly its supported thinking levels and 5m promptCache for the HUD", () => {
		const expectedLevels: Record<string, string[]> = {
			"gemini-4-neon": ["low", "medium", "high", "xhigh"],
			"gemini-4-carbon": ["low", "medium", "high"],
			"gemini-4-argon": ["low", "medium", "high"],
			"gemini-4-hydrogen": ["low", "medium", "high", "xhigh"],
			"gemini-3.8-flash": ["low", "medium", "high"],
			"claude-opus-5-5": ["low", "medium", "high"],
			"claude-sonnet-5-5": ["low", "medium", "high"],
			"gpt-oss-120b": ["medium"],
		};
		for (const model of MODELS) {
			expect(getSupportedThinkingLevels(model)).toEqual(expectedLevels[model.id]!);
			expect(model.promptCache).toEqual({ short: 300, long: 300 });
			expect(model.input).toEqual(model.id === "gpt-oss-120b" ? ["text"] : ["text", "image"]);
		}
	});
});
