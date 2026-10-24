import { describe, expect, test } from "bun:test";
import promptCache from "../../prompt-cache";
import * as piUtils from "../node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/utils.js";
import { ANTHROPIC_TRIGGER_PHRASES, extendCacheTtl, scrubAnthropicPayload } from "./anthropic-sub";
import {
	buildSummaryPayload,
	CACHE_COMPACTION_MAX_AGE_ENV,
	cacheCompactionBlocker,
	captureMaxAgeMs,
	type CompactionCheck,
	computeFileLists,
	type FileOps,
	formatFileOperations,
	missingFromCapture,
	summaryInstruction,
	summaryMaxTokens,
	withPreviousExtensionFiles,
} from "./cache-compaction";
import type { CapturedRequest } from "./prompt-cache";
import { SUB_AGENT_TOOLS_ENV } from "./sub-agent-prompt";

const HOUR = { type: "ephemeral", ttl: "1h" };

function wirePayload(): Record<string, unknown> {
	return {
		model: "claude-haiku-5-5",
		max_tokens: 128000,
		stream: true,
		betas: ["claude-code-20250219", "oauth-2025-04-20", "extended-cache-ttl-2025-04-11"],
		system: [
			{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude.", cache_control: HOUR },
			{ type: "text", text: "read only when the user asks about pi itself", cache_control: HOUR },
		],
		tools: [{ name: "bash", input_schema: { type: "object" }, cache_control: HOUR }],
		thinking: { type: "adaptive", display: "summarized", block_binding: { prefix_mismatch_behavior: "drop_block" } },
		output_config: { effort: "high" },
		messages: [
			{ role: "user", content: [{ type: "text", text: "hi" }] },
			{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "a.txt", cache_control: HOUR }] },
			{ role: "system", content: [], output_config: { effort: "high" } },
		],
	};
}

function withoutSummaryChanges(payload: Record<string, unknown>, appendedMessage: boolean): Record<string, unknown> {
	const copy = structuredClone(payload);
	const messages = copy.messages as any[];
	if (appendedMessage) messages.pop();
	else messages.at(-1).content.pop();
	delete copy.max_tokens;
	return copy;
}

describe("buildSummaryPayload", () => {
	test("changes nothing but the appended instruction and max_tokens", () => {
		const captured = wirePayload();
		const sent = scrubAnthropicPayload(captured)!;
		const built = buildSummaryPayload(captured, "summarize", 4000);
		expect((built.messages as any[]).at(-1)).toEqual({ role: "system", content: [{ type: "text", text: "summarize" }] });
		expect(built.max_tokens).toBe(4000);
		const { max_tokens: _, ...rest } = sent;
		expect(JSON.stringify(withoutSummaryChanges(built, true))).toBe(JSON.stringify(rest));
	});

	test("appends to a last user message as one block without cache_control", () => {
		const captured = wirePayload();
		(captured.messages as any[]).pop();
		const built = buildSummaryPayload(captured, "summarize", 4000);
		const last = (built.messages as any[]).at(-1);
		expect(last.content.at(-1)).toEqual({ type: "text", text: "summarize" });
		expect(last.content.at(-2).cache_control).toEqual(HOUR);
		const { max_tokens: _, ...rest } = scrubAnthropicPayload(captured)!;
		expect(JSON.stringify(withoutSummaryChanges(built, false))).toBe(JSON.stringify(rest));
	});

	test("scrubs a raw capture and leaves an already processed one byte-identical", () => {
		const raw = wirePayload();
		const processed = extendCacheTtl(scrubAnthropicPayload(raw)) ?? scrubAnthropicPayload(raw)!;
		expect(scrubAnthropicPayload(processed)).toBeUndefined();
		expect(JSON.stringify(buildSummaryPayload(raw, "s", 1))).toBe(JSON.stringify(buildSummaryPayload(processed, "s", 1)));
		expect(JSON.stringify(buildSummaryPayload(raw, "s", 1))).not.toContain("pi itself");
	});

	test("never mutates the capture", () => {
		const captured = wirePayload();
		const before = JSON.stringify(captured);
		buildSummaryPayload(captured, "summarize", 4000);
		expect(JSON.stringify(captured)).toBe(before);
	});
});

describe("summaryInstruction", () => {
	test("uses pi's checkpoint format, the update rules after a summary, and the extra focus", () => {
		expect(summaryInstruction(false)).toContain("Create a structured context checkpoint summary");
		expect(summaryInstruction(false)).toContain("## Critical Context");
		expect(summaryInstruction(true)).toContain("PRESERVE all existing information from the previous summary");
		expect(summaryInstruction(false, "the API")).toEndWith("\n\nAdditional focus: the API");
		expect(summaryInstruction(false)).toContain("Do NOT call any tools.");
	});

	test("carries no Claude-plan trigger phrase", () => {
		for (const [phrase] of ANTHROPIC_TRIGGER_PHRASES) {
			expect(summaryInstruction(true, "x")).not.toContain(phrase);
		}
	});
});

describe("summaryMaxTokens", () => {
	test("is pi's 80% of reserveTokens, capped by the model and the room left", () => {
		expect(summaryMaxTokens(150_000, 128_000, 1_000_000, 850_000)).toBe(120_000);
		expect(summaryMaxTokens(16_384, 128_000, 1_000_000, 10_000)).toBe(13_107);
		expect(summaryMaxTokens(150_000, 64_000, 1_000_000, 10_000)).toBe(64_000);
		expect(summaryMaxTokens(150_000, 128_000, 1_000_000, 950_000)).toBe(45_904);
		expect(summaryMaxTokens(150_000, 128_000, 1_000_000, 999_000)).toBe(0);
	});
});

describe("cacheCompactionBlocker", () => {
	const message = { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 };
	const capture: CapturedRequest = {
		payload: wirePayload(),
		messages: [message],
		sessionId: "s1",
		modelId: "claude-haiku-5-5",
		at: 1_000_000,
	};
	const check = (overrides: Partial<CompactionCheck>): CompactionCheck => ({
		capture,
		ttlMs: 3_600_000,
		now: capture.at + 60_000,
		sessionId: "s1",
		modelId: "claude-haiku-5-5",
		reason: "threshold",
		needed: [structuredClone(message)],
		maxTokens: 4000,
		aborted: false,
		env: {},
		...overrides,
	});

	test("lets a fresh, complete capture through for threshold and manual compaction", () => {
		expect(cacheCompactionBlocker(check({}))).toBeUndefined();
		expect(cacheCompactionBlocker(check({ reason: "manual" }))).toBeUndefined();
	});

	test("each guard trips on its own", () => {
		expect(cacheCompactionBlocker(check({ capture: undefined }))).toBe("no request captured");
		expect(cacheCompactionBlocker(check({ reason: "overflow" }))).toBe("overflow recovery");
		expect(cacheCompactionBlocker(check({ sessionId: "s2" }))).toBe("captured in another session");
		expect(cacheCompactionBlocker(check({ modelId: "claude-opus-5-5" }))).toBe("captured for another model");
		expect(cacheCompactionBlocker(check({ now: capture.at + 55 * 60_000 }))).toBe("cache entry likely expired");
		expect(cacheCompactionBlocker(check({ maxTokens: 0 }))).toBe("no room for a summary");
		expect(cacheCompactionBlocker(check({ needed: [{ ...message, timestamp: 2 }] }))).toBe(
			"1 messages to summarize were not in the last request",
		);
		expect(cacheCompactionBlocker(check({ aborted: true }))).toBe("aborted");
	});

	test("the age limit follows the capture's lifetime, and the env var overrides it", () => {
		expect(captureMaxAgeMs(3_600_000, {})).toBe(54 * 60_000);
		expect(captureMaxAgeMs(300_000, {})).toBe(270_000);
		expect(captureMaxAgeMs(3_600_000, { [CACHE_COMPACTION_MAX_AGE_ENV]: "5" })).toBe(5000);
		expect(cacheCompactionBlocker(check({ ttlMs: 300_000, now: capture.at + 280_000 }))).toBe("cache entry likely expired");
		expect(cacheCompactionBlocker(check({ env: { [CACHE_COMPACTION_MAX_AGE_ENV]: "30" } }))).toBe(
			"cache entry likely expired",
		);
	});

	test("compares messages by content, not identity", () => {
		expect(missingFromCapture([message], [structuredClone(message)])).toBe(0);
		expect(missingFromCapture([message], [{ ...message, content: [{ type: "text", text: "edited" }] }])).toBe(1);
	});
});

describe("file lists", () => {
	const fileOps = (): FileOps => ({
		read: new Set(["/b.ts", "/a.ts", "/c.ts"]),
		written: new Set(["/c.ts"]),
		edited: new Set(["/z.ts", "/d.ts"]),
	});

	test("match pi's computeFileLists and formatFileOperations", () => {
		expect(computeFileLists(fileOps())).toEqual(piUtils.computeFileLists(fileOps()));
		const { readFiles, modifiedFiles } = computeFileLists(fileOps());
		expect(formatFileOperations(readFiles, modifiedFiles)).toBe(piUtils.formatFileOperations(readFiles, modifiedFiles));
		expect(formatFileOperations([], [])).toBe(piUtils.formatFileOperations([], []));
		expect(formatFileOperations(["/a"], [])).toBe(piUtils.formatFileOperations(["/a"], []));
	});

	test("keep the files of a previous extension compaction, which pi skips", () => {
		const branch = [
			{ type: "compaction", fromHook: false, details: { readFiles: ["/old.ts"], modifiedFiles: [] } },
			{ type: "message" },
			{ type: "compaction", fromHook: true, details: { readFiles: ["/r.ts"], modifiedFiles: ["/m.ts"] } },
		];
		const merged = withPreviousExtensionFiles(fileOps(), branch);
		expect(computeFileLists(merged)).toEqual({
			readFiles: ["/a.ts", "/b.ts", "/r.ts"],
			modifiedFiles: ["/c.ts", "/d.ts", "/m.ts", "/z.ts"],
		});
		expect(withPreviousExtensionFiles(fileOps(), branch.slice(0, 2))).toEqual(fileOps());
	});
});

type Handler = (event: any, ctx: any) => any;

function loadExtension(reply: Record<string, unknown>, subAgentTools?: string) {
	const handlers = new Map<string, Handler>();
	const saved = process.env[SUB_AGENT_TOOLS_ENV];
	if (subAgentTools === undefined) delete process.env[SUB_AGENT_TOOLS_ENV];
	else process.env[SUB_AGENT_TOOLS_ENV] = subAgentTools;
	try {
		promptCache({
			on: (name: string, handler: Handler) => handlers.set(name, handler),
			events: { on: () => () => undefined, emit: () => undefined },
			appendEntry: () => undefined,
		} as any);
	} finally {
		if (saved === undefined) delete process.env[SUB_AGENT_TOOLS_ENV];
		else process.env[SUB_AGENT_TOOLS_ENV] = saved;
	}
	const sent: unknown[] = [];
	const model = { provider: "anthropic", id: "claude-haiku-5-5", maxTokens: 128_000, contextWindow: 1_000_000 };
	const ctx = {
		hasUI: false,
		model,
		sessionManager: { getSessionId: () => "s1" },
		modelRegistry: {
			isUsingOAuth: () => true,
			streamSimple: (_model: unknown, _context: unknown, options: any) => ({
				result: async () => {
					sent.push(await options.onPayload());
					return reply;
				},
			}),
		},
	};
	const call = (name: string, event: any) => handlers.get(name)!({ type: name, ...event }, ctx);
	return { handlers, sent, call, ctx };
}

const kept = { role: "user", content: [{ type: "text", text: "kept" }], timestamp: 3 };
const old = { role: "user", content: [{ type: "text", text: "old" }], timestamp: 1 };
const usage = { input: 3, output: 50, cacheRead: 9000, cacheWrite: 0 };
const compactEvent = (overrides: Record<string, unknown> = {}) => ({
	preparation: {
		firstKeptEntryId: "e9",
		messagesToSummarize: [structuredClone(old)],
		turnPrefixMessages: [],
		isSplitTurn: false,
		tokensBefore: 9000,
		previousSummary: undefined,
		fileOps: { read: new Set(["/r.ts"]), written: new Set(), edited: new Set(["/e.ts"]) },
		settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
	},
	branchEntries: [],
	customInstructions: undefined,
	reason: "threshold",
	willRetry: false,
	signal: new AbortController().signal,
	...overrides,
});

describe("prompt-cache extension: compaction", () => {
	const ok = { role: "assistant", stopReason: "stop", content: [{ type: "thinking", thinking: "x" }, { type: "text", text: "## Goal\nship" }], usage };

	test("a sub-agent keeps its cache warm but never compacts from it", () => {
		const { handlers } = loadExtension(ok, "read");
		expect(handlers.has("before_provider_request")).toBe(true);
		expect(handlers.has("session_before_compact")).toBe(false);
	});

	test("its request hooks are read-only", async () => {
		const ext = loadExtension(ok);
		expect(await ext.call("context", { messages: [old, kept] })).toBeUndefined();
		expect(await ext.call("before_provider_request", { payload: wirePayload() })).toBeUndefined();
	});

	test("replays the last request and returns pi's compaction shape", async () => {
		const ext = loadExtension(ok);
		await ext.call("context", { messages: [old, kept] });
		await ext.call("before_provider_request", { payload: wirePayload() });
		const result = await ext.call("session_before_compact", compactEvent());
		expect(result).toEqual({
			compaction: {
				summary: "## Goal\nship\n\n<read-files>\n/r.ts\n</read-files>\n\n<modified-files>\n/e.ts\n</modified-files>",
				firstKeptEntryId: "e9",
				tokensBefore: 9000,
				usage,
				details: { readFiles: ["/r.ts"], modifiedFiles: ["/e.ts"] },
			},
		});
		const [payload] = ext.sent as any[];
		expect(payload.max_tokens).toBe(13_107);
		expect(payload.messages.at(-1).content[0].text).toBe(summaryInstruction(false));
	});

	test("falls back to pi's compaction whenever the replay cannot be trusted", async () => {
		const run = async (reply: Record<string, unknown>, event = compactEvent(), capture = true) => {
			const ext = loadExtension(reply);
			if (capture) {
				await ext.call("context", { messages: [old, kept] });
				await ext.call("before_provider_request", { payload: wirePayload() });
			}
			return ext.call("session_before_compact", event);
		};
		expect(await run(ok, compactEvent(), false)).toBeUndefined();
		expect(await run(ok, compactEvent({ reason: "overflow" }))).toBeUndefined();
		expect(await run({ ...ok, stopReason: "length" })).toBeUndefined();
		expect(await run({ ...ok, stopReason: "toolUse", content: [{ type: "toolCall", name: "bash" }] })).toBeUndefined();
		expect(await run({ ...ok, content: [{ type: "text", text: "  " }] })).toBeUndefined();
		expect(await run({ ...ok, content: [{ type: "text", text: "bundled." }] })).toBeUndefined();
	});

	test("a capture made on another model is not replayed", async () => {
		const ext = loadExtension(ok);
		await ext.call("context", { messages: [old, kept] });
		await ext.call("before_provider_request", { payload: wirePayload() });
		ext.ctx.model = { ...ext.ctx.model, id: "claude-opus-5-5" };
		expect(await ext.call("session_before_compact", compactEvent())).toBeUndefined();
		expect(ext.sent).toEqual([]);
	});

	test("a tree move, a new session, a model switch or a finished compaction drops the capture", async () => {
		for (const event of ["session_tree", "session_compact", "session_start", "model_select"]) {
			const ext = loadExtension(ok);
			await ext.call("context", { messages: [old, kept] });
			await ext.call("before_provider_request", { payload: wirePayload() });
			await ext.call(event, {});
			expect(await ext.call("session_before_compact", compactEvent())).toBeUndefined();
		}
	});
});
