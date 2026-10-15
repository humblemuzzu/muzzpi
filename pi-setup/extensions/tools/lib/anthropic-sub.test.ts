import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import anthropicSub from "../../anthropic-sub";
import { piDocs } from "../../system-prompt";
import {
	ANTHROPIC_TRIGGER_PHRASES,
	CANARY_COMMAND,
	describeAnthropicRejection,
	isAnthropicRejection,
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

function loadExtension() {
	const handlers = new Map<string, Handler>();
	anthropicSub({ on: (name: string, handler: Handler) => handlers.set(name, handler) } as any);
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
	afterEach(() => {
		if (original === undefined) delete process.env.PI_ANTHROPIC_PAYLOAD_LOG;
		else process.env.PI_ANTHROPIC_PAYLOAD_LOG = original;
	});

	test("registers exactly the three hooks", () => {
		expect([...loadExtension().handlers.keys()].sort()).toEqual(["before_provider_request", "message_end", "session_start"]);
	});

	test("scrubs only anthropic OAuth requests", () => {
		const { call, ctx } = loadExtension();
		const payload = { system: [{ type: "text", text: RAW_DOCS }] };
		expect((call("before_provider_request", { payload }, ctx("anthropic")) as any).system[0].text).toBe(scrubPromptText(RAW_DOCS));
		expect(call("before_provider_request", { payload }, ctx("anthropic", false))).toBeUndefined();
		expect(call("before_provider_request", { payload }, ctx("deepseek"))).toBeUndefined();
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
