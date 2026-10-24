import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import anthropicSub from "../../anthropic-sub";
import { piDocs } from "../../system-prompt";
import {
	ANTHROPIC_TRIGGER_PHRASES,
	CANARY_COMMAND,
	describeAnthropicRejection,
	EXTENDED_CACHE_TTL_BETA,
	extendCacheTtl,
	isAnthropicRejection,
	isUsingOverage,
	planMeter,
	resolveCacheTtl,
	scrubAnthropicPayload,
	scrubPromptText,
} from "./anthropic-sub";

const TRIGGERS = ANTHROPIC_TRIGGER_PHRASES.map(([phrase]) => phrase);
const RAW_DOCS = "read only when the user asks about pi itself; pi packages (docs/packages.md); read pi .md files";
const REFUSAL =
	'400 {"type":"error","error":{"type":"invalid_request_error","message":"You\'re out of extra usage. Add more at claude.ai/settings/usage and keep going."}}';

describe("piDocs", () => {
	test("never renders a trigger phrase", () => {
		const docs = piDocs("/pkg");
		for (const phrase of TRIGGERS) expect(docs).not.toContain(phrase);
	});

	test("renders exactly what the scrub would produce", () => {
		const docs = piDocs("/pkg");
		expect(scrubPromptText(docs)).toBe(docs);
		expect(docs).toContain("the cli itself");
		expect(docs).toContain("cli packages (docs/packages.md)");
		expect(docs).toContain("Always read cli .md files completely");
	});
});

describe("scrubPromptText", () => {
	test("replaces every trigger phrase", () => {
		expect(scrubPromptText(RAW_DOCS)).toBe(
			"read only when the user asks about the cli itself; cli packages (docs/packages.md); read cli .md files",
		);
	});

	test("is idempotent", () => {
		const once = scrubPromptText(RAW_DOCS);
		expect(scrubPromptText(once)).toBe(once);
	});

	test("leaves other mentions of pi alone", () => {
		const text = "You are a coding agent running in pi. Pi documentation: see pi Notes.";
		expect(scrubPromptText(text)).toBe(text);
	});
});

describe("scrubAnthropicPayload", () => {
	const tools = [{ name: "screenshot", input_schema: { type: "object" }, cache_control: { type: "ephemeral" } }];

	test("returns undefined for a clean payload", () => {
		const payload = { system: [{ type: "text", text: "clean" }], tools, messages: [{ role: "user", content: "hi" }] };
		expect(scrubAnthropicPayload(payload)).toBeUndefined();
	});

	test("returns undefined for non-objects", () => {
		expect(scrubAnthropicPayload(undefined)).toBeUndefined();
		expect(scrubAnthropicPayload("text")).toBeUndefined();
		expect(scrubAnthropicPayload([])).toBeUndefined();
	});

	test("rewrites system text blocks and keeps cache_control and other blocks", () => {
		const identity = { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." };
		const image = { type: "image", source: { type: "base64", data: "pi itself" } };
		const payload = {
			system: [identity, { type: "text", text: RAW_DOCS, cache_control: { type: "ephemeral", ttl: "1h" } }, image],
			tools,
		};
		const out = scrubAnthropicPayload(payload) as any;
		expect(out.system[0]).toBe(identity);
		expect(out.system[1]).toEqual({ type: "text", text: scrubPromptText(RAW_DOCS), cache_control: { type: "ephemeral", ttl: "1h" } });
		expect(out.system[2]).toBe(image);
		expect(out.tools).toBe(tools);
	});

	test("rewrites a string system prompt", () => {
		expect((scrubAnthropicPayload({ system: RAW_DOCS }) as any).system).toBe(scrubPromptText(RAW_DOCS));
	});

	test("rewrites role:system messages only, keeping their other fields", () => {
		const user = { role: "user", content: [{ type: "text", text: "tell me about pi itself" }] };
		const system = { role: "system", content: [{ type: "text", text: RAW_DOCS }], output_config: { effort: "high" } };
		const out = scrubAnthropicPayload({ system: [{ type: "text", text: "clean" }], messages: [user, system] }) as any;
		expect(out.messages[0]).toBe(user);
		expect(out.messages[1].content[0].text).toBe(scrubPromptText(RAW_DOCS));
		expect(out.messages[1].output_config).toEqual({ effort: "high" });
	});

	test("does not mutate the input and is stable across calls", () => {
		const payload = { system: [{ type: "text", text: RAW_DOCS }], tools };
		const snapshot = JSON.stringify(payload);
		const first = scrubAnthropicPayload(payload);
		const second = scrubAnthropicPayload(payload);
		expect(JSON.stringify(payload)).toBe(snapshot);
		expect(JSON.stringify(first)).toBe(JSON.stringify(second));
		expect(scrubAnthropicPayload(first)).toBeUndefined();
	});
});

describe("resolveCacheTtl", () => {
	test("defaults to 1h for the main session and 5m for a sub-agent", () => {
		expect(resolveCacheTtl({})).toBe("1h");
		expect(resolveCacheTtl({ PI_SUBAGENT_TOOLS: "read,grep" })).toBe("5m");
		expect(resolveCacheTtl({ PI_SUBAGENT_TOOLS: "  " })).toBe("1h");
	});

	test("each bucket reads only its own variable", () => {
		expect(resolveCacheTtl({ PI_PROMPT_CACHE_TTL: "5m" })).toBe("5m");
		expect(resolveCacheTtl({ PI_SUBAGENT_PROMPT_CACHE_TTL: "5m" })).toBe("1h");
		expect(resolveCacheTtl({ PI_SUBAGENT_TOOLS: "read", PI_SUBAGENT_PROMPT_CACHE_TTL: "1h" })).toBe("1h");
		expect(resolveCacheTtl({ PI_SUBAGENT_TOOLS: "read", PI_PROMPT_CACHE_TTL: "1h" })).toBe("5m");
	});

	test("ignores any value but 5m and 1h", () => {
		expect(resolveCacheTtl({ PI_PROMPT_CACHE_TTL: "60m" })).toBe("1h");
		expect(resolveCacheTtl({ PI_PROMPT_CACHE_TTL: "5M" })).toBe("1h");
		expect(resolveCacheTtl({ PI_SUBAGENT_TOOLS: "read", PI_SUBAGENT_PROMPT_CACHE_TTL: "long" })).toBe("5m");
	});

	test("PI_FORCE_PROMPT_CACHING_5M=1 beats both variables", () => {
		expect(resolveCacheTtl({ PI_FORCE_PROMPT_CACHING_5M: "1", PI_PROMPT_CACHE_TTL: "1h" })).toBe("5m");
		expect(resolveCacheTtl({ PI_FORCE_PROMPT_CACHING_5M: "1", PI_SUBAGENT_TOOLS: "read", PI_SUBAGENT_PROMPT_CACHE_TTL: "1h" })).toBe("5m");
		expect(resolveCacheTtl({ PI_FORCE_PROMPT_CACHING_5M: "0" })).toBe("1h");
	});
});

/** the headers of a real plan response, trimmed to what the meter code reads around */
const PLAN_RESPONSE_HEADERS = {
	"anthropic-organization-id": "org",
	"anthropic-ratelimit-unified-5h-utilization": "0.05",
	"anthropic-ratelimit-unified-7d-utilization": "0.24",
	"anthropic-ratelimit-unified-status": "allowed",
	"anthropic-ratelimit-unified-overage-status": "rejected",
	"request-id": "req_1",
};

describe("planMeter", () => {
	test("keeps only the unified rate-limit headers, without their prefix", () => {
		expect(planMeter(PLAN_RESPONSE_HEADERS)).toEqual({
			"5h-utilization": "0.05",
			"7d-utilization": "0.24",
			status: "allowed",
			"overage-status": "rejected",
		});
	});

	test("undefined for a response without them", () => {
		expect(planMeter({ "request-id": "req_1" })).toBeUndefined();
	});
});

describe("isUsingOverage", () => {
	const withinPlan = {
		"anthropic-ratelimit-unified-status": "allowed",
		"anthropic-ratelimit-unified-overage-status": "rejected",
		"anthropic-ratelimit-unified-overage-disabled-reason": "org_level_disabled",
	};

	test("a response within the plan is not overage", () => {
		expect(isUsingOverage(withinPlan)).toBe(false);
	});

	test("a spent plan served from extra usage is overage", () => {
		for (const overage of ["allowed", "allowed_warning"]) {
			expect(isUsingOverage({ "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-overage-status": overage })).toBe(true);
		}
		expect(isUsingOverage({ "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-overage-status": "rejected" })).toBe(false);
		expect(isUsingOverage({ "anthropic-ratelimit-unified-status": "allowed", "anthropic-ratelimit-unified-overage-status": "allowed" })).toBe(false);
	});

	test("no answer without the unified status header", () => {
		expect(isUsingOverage({})).toBeUndefined();
		expect(isUsingOverage({ "anthropic-ratelimit-unified-overage-status": "allowed" })).toBeUndefined();
	});
});

/** the breakpoints of a real OAuth request: both system blocks, the last real tool, and a message that is not the last */
function wirePayload() {
	return {
		model: "claude-opus-5-5",
		betas: ["claude-code-20250219", "oauth-2025-04-20"],
		system: [
			{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude.", cache_control: { type: "ephemeral" } },
			{ type: "text", text: "system prompt", cache_control: { type: "ephemeral" } },
		],
		tools: [
			{ name: "read", input_schema: { type: "object" } },
			{ name: "bash", input_schema: { type: "object" }, cache_control: { type: "ephemeral" } },
			{ name: "__pi_deferred_placeholder__", input_schema: { type: "object" }, defer_loading: true },
		],
		messages: [
			{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] },
			{ role: "system", content: [{ type: "text", text: "effort" }] },
		],
	};
}

function cacheControls(payload: unknown): unknown[] {
	const found: unknown[] = [];
	const walk = (value: unknown): void => {
		if (Array.isArray(value)) value.forEach(walk);
		else if (value && typeof value === "object") {
			for (const [key, child] of Object.entries(value)) {
				if (key === "cache_control") found.push(child);
				else walk(child);
			}
		}
	};
	walk(payload);
	return found;
}

describe("extendCacheTtl", () => {
	test("gives every breakpoint the 1h TTL and adds the beta once", () => {
		const out = extendCacheTtl(wirePayload()) as any;
		expect(cacheControls(out)).toEqual(Array(4).fill({ type: "ephemeral", ttl: "1h" }));
		expect(out.betas).toEqual(["claude-code-20250219", "oauth-2025-04-20", EXTENDED_CACHE_TTL_BETA]);
	});

	test("touches nothing but the breakpoints and betas", () => {
		const input = wirePayload();
		const out = extendCacheTtl(input) as any;
		expect(out.tools[0]).toBe(input.tools[0]);
		expect(out.tools[2]).toBe(input.tools[2]);
		expect(out.messages[1]).toBe(input.messages[1]);
		expect(out.model).toBe(input.model);
		const strip = (p: unknown) => JSON.stringify(p, (key, value) => (key === "cache_control" || key === "betas" ? undefined : value));
		expect(strip(out)).toBe(strip(input));
	});

	test("does not mutate the input and is idempotent", () => {
		const input = wirePayload();
		const snapshot = JSON.stringify(input);
		const out = extendCacheTtl(input);
		expect(JSON.stringify(input)).toBe(snapshot);
		expect(extendCacheTtl(out)).toBeUndefined();
	});

	test("leaves a request without breakpoints alone", () => {
		const summary = { system: "Summarize", messages: [{ role: "user", content: [{ type: "text", text: "x" }] }], betas: ["oauth-2025-04-20"] };
		expect(extendCacheTtl(summary)).toBeUndefined();
		expect(extendCacheTtl(undefined)).toBeUndefined();
		expect(extendCacheTtl([])).toBeUndefined();
	});

	test("adds a betas list when there was none", () => {
		const out = extendCacheTtl({ system: [{ type: "text", text: "s", cache_control: { type: "ephemeral" } }] }) as any;
		expect(out.betas).toEqual([EXTENDED_CACHE_TTL_BETA]);
	});

	test("does not duplicate a beta that is already there", () => {
		const input = { ...wirePayload(), betas: [EXTENDED_CACHE_TTL_BETA] };
		expect((extendCacheTtl(input) as any).betas).toEqual([EXTENDED_CACHE_TTL_BETA]);
	});
});

describe("describeAnthropicRejection", () => {
	test("ignores unrelated errors", () => {
		expect(isAnthropicRejection("429 rate_limit_error: Error")).toBe(false);
		expect(describeAnthropicRejection("overloaded", true)).toBeUndefined();
		expect(describeAnthropicRejection(undefined, false)).toBeUndefined();
	});

	test("recognises both refusal texts", () => {
		expect(isAnthropicRejection(REFUSAL)).toBe(true);
		expect(isAnthropicRejection("This credential is only authorized for use with Claude Code")).toBe(true);
	});

	test("points at the plan limit after earlier success", () => {
		expect(describeAnthropicRejection(REFUSAL, true)).toContain("plan limit");
	});

	test("points at the canary when nothing has worked yet", () => {
		expect(describeAnthropicRejection(REFUSAL, false)).toContain(CANARY_COMMAND);
	});

	test("names both causes when unknown", () => {
		const hint = describeAnthropicRejection(REFUSAL, undefined)!;
		expect(hint).toContain("plan limit");
		expect(hint).toContain(CANARY_COMMAND);
	});

	test("hints are single-line", () => {
		for (const state of [true, false, undefined]) expect(describeAnthropicRejection(REFUSAL, state)).not.toMatch(/[\n\r]/);
	});
});

type Handler = (event: any, ctx: any) => unknown;

const TTL_ENV = ["PI_SUBAGENT_TOOLS", "PI_PROMPT_CACHE_TTL", "PI_SUBAGENT_PROMPT_CACHE_TTL", "PI_FORCE_PROMPT_CACHING_5M"];

function loadExtension(env: Record<string, string> = {}) {
	const handlers = new Map<string, Handler>();
	const saved = TTL_ENV.map((name) => [name, process.env[name]] as const);
	for (const name of TTL_ENV) delete process.env[name];
	Object.assign(process.env, env);
	try {
		anthropicSub({ on: (name: string, handler: Handler) => handlers.set(name, handler) } as any);
	} finally {
		for (const [name, value] of saved) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
	const notes: string[] = [];
	const ctx = (provider: string, oauth = true, hasUI = true) => ({
		model: { provider, id: "claude-opus-5-5" },
		modelRegistry: { isUsingOAuth: () => oauth },
		hasUI,
		ui: { notify: (message: string) => notes.push(message) },
	});
	const call = (name: string, event: any, context: any) => handlers.get(name)!(event, context);
	return { handlers, notes, ctx, call };
}

describe("anthropic-sub extension", () => {
	const original = process.env.PI_ANTHROPIC_PAYLOAD_LOG;
	const originalMeter = process.env.PI_ANTHROPIC_METER_LOG;
	const originalChild = process.env.PI_SUBAGENT_TOOLS;
	beforeEach(() => {
		delete process.env.PI_SUBAGENT_TOOLS;
	});
	afterEach(() => {
		if (original === undefined) delete process.env.PI_ANTHROPIC_PAYLOAD_LOG;
		else process.env.PI_ANTHROPIC_PAYLOAD_LOG = original;
		if (originalMeter === undefined) delete process.env.PI_ANTHROPIC_METER_LOG;
		else process.env.PI_ANTHROPIC_METER_LOG = originalMeter;
		if (originalChild === undefined) delete process.env.PI_SUBAGENT_TOOLS;
		else process.env.PI_SUBAGENT_TOOLS = originalChild;
	});

	const reply = (usage: Record<string, number>) => ({ message: { role: "assistant", stopReason: "stop", usage } });
	const tokens = { input: 4, output: 3, cacheRead: 5641, cacheWrite: 109, cacheWrite1h: 109 };

	test("the meter log pairs each response's plan meter with that request's tokens, private to the user", () => {
		const dir = mkdtempSync(join(tmpdir(), "anthropic-sub-"));
		const log = join(dir, "meter.jsonl");
		process.env.PI_ANTHROPIC_METER_LOG = log;
		const { call, ctx } = loadExtension();
		call("after_provider_response", { status: 200, headers: PLAN_RESPONSE_HEADERS }, ctx("anthropic"));
		call("message_end", reply({ ...tokens, totalTokens: 5757 }), ctx("anthropic"));
		call("message_end", reply(tokens), ctx("anthropic"));
		const lines = readFileSync(log, "utf-8").trim().split("\n");
		expect(lines).toHaveLength(1);
		const record = JSON.parse(lines[0]!);
		expect(Number.isNaN(Date.parse(record.at))).toBe(false);
		expect(record).toMatchObject({ model: "claude-opus-5-5", subagent: false, usage: tokens, meter: planMeter(PLAN_RESPONSE_HEADERS) });
		expect(statSync(log).mode & 0o777).toBe(0o600);
	});

	test("the meter log stays off without its variable and ignores other providers", () => {
		const dir = mkdtempSync(join(tmpdir(), "anthropic-sub-"));
		const log = join(dir, "meter.jsonl");
		const off = loadExtension();
		off.call("after_provider_response", { status: 200, headers: PLAN_RESPONSE_HEADERS }, off.ctx("anthropic"));
		process.env.PI_ANTHROPIC_METER_LOG = log;
		off.call("message_end", reply(tokens), off.ctx("anthropic"));
		const other = loadExtension();
		other.call("after_provider_response", { status: 200, headers: PLAN_RESPONSE_HEADERS }, other.ctx("deepseek"));
		other.call("message_end", reply(tokens), other.ctx("deepseek"));
		expect(() => statSync(log)).toThrow();
	});

	test("registers exactly its hooks", () => {
		expect([...loadExtension().handlers.keys()].sort()).toEqual([
			"after_provider_response",
			"before_provider_request",
			"message_end",
			"session_start",
		]);
	});

	test("scrubs only anthropic OAuth requests", () => {
		const { call, ctx } = loadExtension();
		const payload = { system: [{ type: "text", text: RAW_DOCS }] };
		expect((call("before_provider_request", { payload }, ctx("anthropic")) as any).system[0].text).toBe(scrubPromptText(RAW_DOCS));
		expect(call("before_provider_request", { payload }, ctx("anthropic", false))).toBeUndefined();
		expect(call("before_provider_request", { payload }, ctx("deepseek"))).toBeUndefined();
	});

	test("the main session's plan requests get the 1h TTL, scrubbed as well", () => {
		const { call, ctx } = loadExtension();
		const payload = { ...wirePayload(), system: [{ type: "text", text: RAW_DOCS, cache_control: { type: "ephemeral" } }] };
		const out = call("before_provider_request", { payload }, ctx("anthropic")) as any;
		expect(out.system[0]).toEqual({ type: "text", text: scrubPromptText(RAW_DOCS), cache_control: { type: "ephemeral", ttl: "1h" } });
		expect(cacheControls(out).every((c: any) => c.ttl === "1h")).toBe(true);
		expect(out.betas).toContain(EXTENDED_CACHE_TTL_BETA);
		expect(call("before_provider_request", { payload }, ctx("anthropic", false))).toBeUndefined();
		expect(call("before_provider_request", { payload }, ctx("deepseek"))).toBeUndefined();
	});

	test("a sub-agent, or a forced 5m, keeps pi's 5m breakpoints", () => {
		for (const env of [{ PI_SUBAGENT_TOOLS: "read" }, { PI_PROMPT_CACHE_TTL: "5m" }, { PI_FORCE_PROMPT_CACHING_5M: "1" }]) {
			const { call, ctx } = loadExtension(env);
			expect(call("before_provider_request", { payload: wirePayload() }, ctx("anthropic"))).toBeUndefined();
		}
	});

	test("drops to 5m while served from extra usage, keeps that through a response without the header, and returns to 1h within the plan", () => {
		const { call, ctx } = loadExtension();
		const overage = { "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-overage-status": "allowed" };
		call("after_provider_response", { status: 200, headers: overage }, ctx("anthropic"));
		expect(call("before_provider_request", { payload: wirePayload() }, ctx("anthropic"))).toBeUndefined();
		call("after_provider_response", { status: 200, headers: {} }, ctx("anthropic"));
		expect(call("before_provider_request", { payload: wirePayload() }, ctx("anthropic"))).toBeUndefined();
		call("after_provider_response", { status: 200, headers: { "anthropic-ratelimit-unified-status": "allowed" } }, ctx("anthropic"));
		expect(call("before_provider_request", { payload: wirePayload() }, ctx("anthropic"))).toBeDefined();
	});

	test("ignores rate-limit headers from other providers", () => {
		const { call, ctx } = loadExtension();
		call("after_provider_response", { status: 200, headers: { "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-overage-status": "allowed" } }, ctx("openrouter"));
		expect(call("before_provider_request", { payload: wirePayload() }, ctx("anthropic"))).toBeDefined();
	});

	test("leaves a clean anthropic request untouched", () => {
		const { call, ctx } = loadExtension();
		expect(call("before_provider_request", { payload: { system: [{ type: "text", text: "clean" }] } }, ctx("anthropic"))).toBeUndefined();
	});

	test("writes the payload log in cache-diag.py's format, private to the user", () => {
		const dir = mkdtempSync(join(tmpdir(), "anthropic-sub-"));
		const log = join(dir, "payload.log");
		process.env.PI_ANTHROPIC_PAYLOAD_LOG = log;
		const { call, ctx } = loadExtension();
		call("before_provider_request", { payload: { system: [{ type: "text", text: RAW_DOCS }] } }, ctx("anthropic"));
		const [stamp, json, sep] = readFileSync(log, "utf-8").split("\n");
		expect(Number.isNaN(Date.parse(stamp!))).toBe(false);
		expect(JSON.parse(json!)).toEqual({ stage: "after", payload: { system: [{ type: "text", text: scrubPromptText(RAW_DOCS) }] } });
		expect(sep).toBe("---");
		expect(statSync(log).mode & 0o777).toBe(0o600);
	});

	test("never replaces a message and warns once per session", () => {
		const { call, ctx, notes } = loadExtension();
		const error = { message: { role: "assistant", stopReason: "error", errorMessage: REFUSAL } };
		expect(call("message_end", error, ctx("anthropic"))).toBeUndefined();
		expect(call("message_end", error, ctx("anthropic"))).toBeUndefined();
		expect(notes).toHaveLength(1);
		expect(notes[0]).toContain(CANARY_COMMAND);
		call("session_start", {}, ctx("anthropic"));
		call("message_end", { message: { role: "assistant", stopReason: "stop" } }, ctx("anthropic"));
		call("message_end", error, ctx("anthropic"));
		expect(notes).toHaveLength(2);
		expect(notes[1]).toContain("plan limit");
	});

	test("stays quiet without a UI, for other providers and for other errors", () => {
		const { call, ctx, notes } = loadExtension();
		call("message_end", { message: { role: "assistant", stopReason: "error", errorMessage: REFUSAL } }, ctx("anthropic", true, false));
		call("message_end", { message: { role: "assistant", stopReason: "error", errorMessage: REFUSAL } }, ctx("deepseek"));
		call("message_end", { message: { role: "assistant", stopReason: "error", errorMessage: "overloaded" } }, ctx("anthropic"));
		expect(notes).toHaveLength(0);
	});
});
