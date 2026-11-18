import { describe, expect, test } from "bun:test";
import type { TranscriptContext, Tool } from "@earendil-works/pi-ai";
import { agySafeInstruction, convertTranscript, toGoogleSchema, toToolDeclarations } from "./convert";

function transcript(messages: unknown[]): TranscriptContext {
	return { messages } as unknown as TranscriptContext;
}

const SYSTEM = "you are pi";

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
			{ role: "user", parts: [{ text: "hello" }] },
			{
				role: "user",
				parts: [{ text: "what is this" }, { inlineData: { mimeType: "image/png", data: "iVBORw0KGgo=" } }],
			},
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
			{ role: "user", parts: [{ text: "read two files" }] },
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
							response: { error: "boom", parts: [{ inlineData: { mimeType: "image/png", data: "AAAA" } }] },
						},
					},
				],
			},
		]);
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
		expect(converted.contents).toEqual([{ role: "user", parts: [{ text: "hi" }] }]);
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
