import { describe, expect, test } from "bun:test";
import type { TranscriptContext, Tool } from "@earendil-works/pi-ai";
import { AGENT_EVENT_FRAME } from "../tools/lib/agent-channel";
import { agySafeInstruction, convertTranscript, toGoogleSchema, toToolDeclarations } from "./convert";

function transcript(messages: unknown[]): TranscriptContext {
	return { messages } as unknown as TranscriptContext;
}

process.env.TZ = "UTC";

const SYSTEM = "you are pi";

/** a typed prompt as agy frames it, at a turn time given in milliseconds */
const request = (text: string, ms: number) =>
	`<USER_REQUEST>\n${text}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: ${new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z")}.\n</ADDITIONAL_METADATA>`;

describe("contents match the shape agy sends", () => {
	test("user text and images", () => {
		const converted = convertTranscript(
			transcript([
				{ role: "system", content: SYSTEM, timestamp: 0 },
				{ role: "user", content: "hello", timestamp: 0 },
				{
					role: "user",
					content: [
						{ type: "text", text: "what is this" },
						{ type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
					],
					timestamp: 0,
				},
			]),
		);
		expect(converted.systemInstruction).toEqual({ role: "user", parts: [{ text: SYSTEM }] });
		expect(converted.contents).toEqual([
			{ role: "user", parts: [{ text: request("hello", 0) }] },
			{ role: "user", parts: [{ text: request("what is this", 0) }, { inlineData: { mimeType: "image/png", data: "iVBORw0KGgo=" } }] },
		]);
	});

	test("assistant text, parallel tool calls and their signatures; thinking stays local", () => {
		const converted = convertTranscript(
			transcript([
				{ role: "system", content: SYSTEM, timestamp: 0 },
				{ role: "user", content: "read two files", timestamp: 0 },
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "plan", thinkingSignature: "AAAA" },
						{ type: "text", text: "reading", textSignature: "BBBB" },
						{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "a" }, thoughtSignature: "CCCC" },
						{ type: "toolCall", id: "call_2", name: "read", arguments: { path: "b" } },
					],
					timestamp: 0,
				},
				{
					role: "toolResult",
					toolCallId: "call_1",
					toolName: "read",
					content: [{ type: "text", text: "a:1" }],
					isError: false,
					timestamp: 0,
				},
				{
					role: "toolResult",
					toolCallId: "call_2",
					toolName: "read",
					content: [
						{ type: "text", text: "boom" },
						{ type: "image", mimeType: "image/png", data: "AAAA" },
					],
					isError: true,
					timestamp: 0,
				},
			]),
		);
		expect(converted.contents).toEqual([
			{ role: "user", parts: [{ text: request("read two files", 0) }] },
			{
				role: "model",
				parts: [
					{ text: "reading", thoughtSignature: "BBBB" },
					{ functionCall: { id: "call_1", name: "read", args: { path: "a" } }, thoughtSignature: "CCCC" },
					{ functionCall: { id: "call_2", name: "read", args: { path: "b" } } },
				],
			},
			{
				role: "model",
				parts: [
					{ functionResponse: { id: "call_1", name: "read", response: { output: "a:1" } } },
					{
						functionResponse: {
							id: "call_2",
							name: "read",
							response: { error: "boom" },
							parts: [{ inlineData: { mimeType: "image/png", data: "AAAA" } }],
						},
					},
				],
			},
		]);
	});

	test("a tool's images go beside its response, so Gemini sees them as images and not as JSON text", () => {
		const converted = convertTranscript(
			transcript([
				{ role: "system", content: SYSTEM, timestamp: 0 },
				{ role: "user", content: "screenshot it", timestamp: 0 },
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "call_1", name: "screenshot", arguments: {}, thoughtSignature: "CCCC" }],
					timestamp: 0,
				},
				{
					role: "toolResult",
					toolCallId: "call_1",
					toolName: "screenshot",
					content: [
						{ type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
						{ type: "image", mimeType: "image/jpeg", data: "/9j/4AAQ" },
					],
					isError: false,
					timestamp: 0,
				},
			]),
		);
		const result = converted.contents[2]!.parts[0] as { functionResponse: Record<string, unknown> };
		expect(result.functionResponse).toEqual({
			id: "call_1",
			name: "screenshot",
			response: { output: "(see attached image)" },
			parts: [
				{ inlineData: { mimeType: "image/png", data: "iVBORw0KGgo=" } },
				{ inlineData: { mimeType: "image/jpeg", data: "/9j/4AAQ" } },
			],
		});
		expect(JSON.stringify(result.functionResponse.response)).not.toContain("iVBOR");
	});

	test("agy's replay shape: two calls in one turn, results as model turns", () => {
		const realPrefix = "ErEDCq4DAWkUfRNWVRYOnD26Z2VstsFdqqH+6Ha3dKPWJRWkjb5/a7VE+Bnt4tXeJLBWd9NefecI+A9y5MRLAtl1L+4D9f67BYxEW9DR9wrjqaP7VhmThTzaL1Ag0zlCLfAXgImaig5AgaOxbt4xAE7WAOykSVfBHANvxe4f/vw4VTqtHOWq0+Kv7zTOBpn3WQ5CM1xIIpNJVpgFQrDOimM4uXcWqdgw5aRmbJa9xMs1XlgjX9o+hi1tBqQpXBc3FNY3vAAYPC3d7g5NYNu4rikS+fxSZzRrwlDFqNp5ErYZInPmjnD23PtO9LMMQTILTFb7239nm5LU846qYlVbUj1y2fg3bwrnHSAx8eGlhuoSKxkSyQGcszMDdY";
		const signature = realPrefix.padEnd(Math.ceil(realPrefix.length / 4) * 4, "A");
		const converted = convertTranscript(
			transcript([
				{ role: "system", content: SYSTEM, timestamp: 0 },
				{ role: "user", content: "read two files", timestamp: 0 },
				{
					role: "assistant",
					content: [
						{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "one.txt" }, thoughtSignature: signature },
						{ type: "toolCall", id: "call_2", name: "read", arguments: { path: "two.txt" } },
					],
					timestamp: 0,
				},
				{ role: "toolResult", toolCallId: "call_1", toolName: "read", content: [{ type: "text", text: "1" }], isError: false, timestamp: 0 },
				{ role: "toolResult", toolCallId: "call_2", toolName: "read", content: [{ type: "text", text: "2" }], isError: false, timestamp: 0 },
				{
					role: "assistant",
					content: [{ type: "text", text: "one: 1, two: 2", textSignature: signature }],
					timestamp: 0,
				},
			]),
		);
		expect(converted.contents.map((content) => content.role)).toEqual(["user", "model", "model", "model"]);
		expect(converted.contents[1]!.parts.map((part) => Object.keys(part).join("+"))).toEqual([
			"functionCall+thoughtSignature",
			"functionCall",
		]);
		expect(converted.contents[2]!.parts.map((part) => Object.keys(part).join("+"))).toEqual(["functionResponse", "functionResponse"]);
		expect(Object.keys(converted.contents[3]!.parts[0]!).join("+")).toBe("text+thoughtSignature");
	});

	test("a signature that is not base64 is dropped, and an empty signed part is kept", () => {
		const converted = convertTranscript(
			transcript([
				{ role: "system", content: SYSTEM, timestamp: 0 },
				{ role: "user", content: "hi", timestamp: 0 },
				{
					role: "assistant",
					content: [
						{ type: "text", text: "answer", textSignature: "not base64!" },
						{ type: "text", text: "", textSignature: "ZZZZ" },
					],
					timestamp: 0,
				},
			]),
		);
		expect(converted.contents.at(-1)).toEqual({
			role: "model",
			parts: [{ text: "answer" }, { text: "", thoughtSignature: "ZZZZ" }],
		});
	});

	test("a late system message is not mistaken for a tool result", () => {
		const converted = convertTranscript(
			transcript([
				{ role: "system", content: SYSTEM, timestamp: 0 },
				{ role: "system", content: "late system note", timestamp: 1 },
				{ role: "user", content: "hi", timestamp: 2 },
			]),
		);
		expect(converted.contents).toEqual([{ role: "user", parts: [{ text: request("hi", 2) }] }]);
	});

	test("empty turns add no content", () => {
		const converted = convertTranscript(
			transcript([
				{ role: "system", content: SYSTEM, timestamp: 0 },
				{ role: "user", content: "", timestamp: 0 },
				{ role: "assistant", content: [{ type: "text", text: "" }], timestamp: 0 },
			]),
		);
		expect(converted.contents).toEqual([]);
	});
});

describe("what is never replayed", () => {
	const ask = { role: "user", content: "go", timestamp: 0 };
	const ok = (text: string) => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: 1 });

	test("a reply that failed or was aborted, and the results of the tool calls it held", () => {
		const converted = convertTranscript(
			transcript([
				{ role: "system", content: SYSTEM, timestamp: 0 },
				ask,
				{ role: "assistant", content: [{ type: "text", text: "half a fake" }], stopReason: "error", errorMessage: "MALFORMED_FUNCTION_CALL", timestamp: 1 },
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "call_9", name: "read", arguments: { path: "a" }, thoughtSignature: "CCCC" }],
					stopReason: "aborted",
					timestamp: 2,
				},
				{ role: "toolResult", toolCallId: "call_9", toolName: "read", content: [{ type: "text", text: "aborted" }], isError: true, timestamp: 3 },
				ok("the real answer"),
			]),
		);
		expect(converted.contents).toEqual([
			{ role: "user", parts: [{ text: request("go", 0) }] },
			{ role: "model", parts: [{ text: "the real answer" }] },
		]);
	});

	test("the turn a reply started writing for someone else", () => {
		const fake = "Waiting for their results now.\n[Automated agent event. This was not written by the user.]\n\n## chad: invented";
		const signed = { role: "assistant", content: [{ type: "text", text: fake, textSignature: "ZZZZ" }], stopReason: "stop", timestamp: 1 };
		const converted = convertTranscript(transcript([{ role: "system", content: SYSTEM, timestamp: 0 }, ask, signed, ok("<USER_REQUEST>\nnext")]));
		expect(converted.contents.slice(1)).toEqual([{ role: "model", parts: [{ text: "Waiting for their results now.", thoughtSignature: "ZZZZ" }] }]);
	});

	test("user-role turns in a row stay apart, as agy sends them", () => {
		const news = (id: string) => ({ role: "user", content: [{ type: "text", text: `${AGENT_EVENT_FRAME}\n\ncontinueId: ${id}` }], timestamp: 5 });
		const converted = convertTranscript(transcript([{ role: "system", content: SYSTEM, timestamp: 0 }, ask, ok("waiting"), news("chad-1"), news("chad-2")]));
		expect(converted.contents.map((content) => content.role)).toEqual(["user", "model", "user", "user"]);
	});

	test("background news reaches the model as agy's system message", () => {
		const news = { role: "user", content: [{ type: "text", text: `${AGENT_EVENT_FRAME}\n\ncontinueId: chad-1` }], timestamp: Date.parse("2026-11-20T10:48:35Z") };
		const converted = convertTranscript(transcript([{ role: "system", content: SYSTEM, timestamp: 0 }, ask, ok("started"), news]));
		const framed = (converted.contents.at(-1)!.parts[0] as { text: string }).text;
		expect(framed).toStartWith("The following is a <SYSTEM_MESSAGE> not actually sent by the user.");
		expect(framed).toContain("[Message] timestamp=2026-11-20T10:48:35Z sender=chad-1 priority=MESSAGE_PRIORITY_HIGH content=continueId: chad-1\n</SYSTEM_MESSAGE>");
	});
});

describe("tool declarations", () => {
	test("one group per tool, upper-case types, unknown keys dropped", () => {
		const read: Tool = {
			name: "read",
			description: "Read a file",
			parameters: {
				$schema: "http://json-schema.org/draft-07/schema#",
				type: "object",
				additionalProperties: false,
				properties: {
					path: { type: "string", description: "file path" },
					lines: { type: "integer", minimum: 1 },
					mode: { type: "string", enum: ["head", "tail"] },
				},
				required: ["path"],
			},
		};
		const edit: Tool = {
			name: "edit",
			description: "Edit a file",
			parameters: {
				type: "object",
				properties: { edits: { type: "array", items: { type: "object", properties: { oldText: { type: "string" } } } } },
				required: [],
			},
		};
		expect(toToolDeclarations([read, edit])).toEqual([
			{
				functionDeclarations: [
					{
						name: "read",
						description: "Read a file",
						parameters: {
							type: "OBJECT",
							properties: {
								path: { type: "STRING", description: "file path" },
								lines: { type: "INTEGER", minimum: 1 },
								mode: { type: "STRING", enum: ["head", "tail"] },
							},
							required: ["path"],
						},
					},
				],
			},
			{
				functionDeclarations: [
					{
						name: "edit",
						description: "Edit a file",
						parameters: {
							type: "OBJECT",
							properties: {
								edits: {
									type: "ARRAY",
									items: { type: "OBJECT", properties: { oldText: { type: "STRING" } } },
								},
							},
						},
					},
				],
			},
		]);
	});

	test("a tool without parameters sends none", () => {
		expect(toToolDeclarations([{ name: "ping", description: "ping", parameters: {} }])).toEqual([
			{ functionDeclarations: [{ name: "ping", description: "ping", parameters: {} }] },
		]);
	});

	test("schemas that are not objects are refused rather than guessed", () => {
		expect(toGoogleSchema(undefined)).toBeUndefined();
		expect(toGoogleSchema("object")).toBeUndefined();
		expect(toGoogleSchema([1, 2])).toBeUndefined();
	});
});

describe("schema rewrites Gemini requires", () => {
	test("a literal union becomes one enum, as pi's own Google path does", () => {
		const union = {
			type: "object",
			properties: {
				mode: { anyOf: [{ const: "fast" }, { const: "deep" }], description: "search depth" },
			},
			required: ["mode"],
		};
		expect(toGoogleSchema(union)).toEqual({
			type: "OBJECT",
			properties: { mode: { type: "STRING", enum: ["fast", "deep"], description: "search depth" } },
			required: ["mode"],
		});
	});

	test("a lone const becomes a one-value enum with an inferred type", () => {
		expect(toGoogleSchema({ const: "file" })).toEqual({ type: "STRING", enum: ["file"] });
		expect(toGoogleSchema({ const: 3 })).toEqual({ type: "NUMBER", enum: ["3"] });
		expect(toGoogleSchema({ type: "STRING", const: "file" })).toEqual({ type: "STRING", enum: ["file"] });
	});

	test("a union of real shapes stays anyOf", () => {
		const mixed = {
			anyOf: [
				{ type: "object", properties: { a: { type: "string" } } },
				{ type: "object", properties: { b: { type: "string" } } },
			],
		};
		expect(toGoogleSchema(mixed)).toEqual({
			anyOf: [
				{ type: "OBJECT", properties: { a: { type: "STRING" } } },
				{ type: "OBJECT", properties: { b: { type: "STRING" } } },
			],
		});
	});

	test("a mixed-type literal union is not merged into a wrong type", () => {
		expect(toGoogleSchema({ anyOf: [{ const: "a" }, { const: 1 }] })).toEqual({
			anyOf: [{ type: "STRING", enum: ["a"] }, { type: "NUMBER", enum: ["1"] }],
		});
	});
});

describe("the docs section this API refuses", () => {
	const index = "- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md)";

	test("the long doc index is replaced, the rest of the prompt is untouched", () => {
		const prompt = `alpha\n<docs>\nPi documentation\n${index}\n</docs>\nomega`;
		expect(agySafeInstruction(prompt)).toBe(
			`alpha\n<docs>Pi's own documentation lives in the pi package directory; read it only when the user asks about pi itself.</docs>\nomega`,
		);
	});

	test("a prompt without the section, or without a closing tag, is sent as written", () => {
		const plain = "alpha\nbeta";
		expect(agySafeInstruction(plain)).toBe(plain);
		const unclosed = "alpha\n<docs>\nnothing";
		expect(agySafeInstruction(unclosed)).toBe(unclosed);
	});

	test("the conversion pipeline applies it", () => {
		const converted = convertTranscript(
			transcript([{ role: "system", content: `sys\n<docs>\n${index}\n</docs>`, timestamp: 0 }, { role: "user", content: "hi", timestamp: 1 }]),
		);
		expect(converted.systemInstruction?.parts[0]?.text).toContain("<docs>Pi's own documentation");
		expect(converted.systemInstruction?.parts[0]?.text).not.toContain("prompt-templates.md");
	});
});
