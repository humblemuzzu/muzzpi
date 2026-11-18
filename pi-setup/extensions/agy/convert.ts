import type { Tool, TranscriptContext } from "@earendil-works/pi-ai";
import { collapseSystemMessages, getInitialSystemMessage, getSystemMessageText, withoutInitialSystemMessage } from "@earendil-works/pi-ai";
import { sanitizeSurrogates } from "./text";
import type { Content, InlineDataPart, Part, ToolGroup } from "./wire";

export interface ConvertedTranscript {
	contents: Content[];
	systemInstruction?: { role: "user"; parts: { text: string }[] };
}

const BASE64_SIGNATURE = /^[A-Za-z0-9+/]+={0,2}$/;

function usableSignature(signature: string | undefined): string | undefined {
	if (!signature || signature.length % 4 !== 0 || !BASE64_SIGNATURE.test(signature)) return undefined;
	return signature;
}

function imagePart(mimeType: string, data: string): InlineDataPart {
	return { inlineData: { mimeType, data } };
}

/** The doc index line of pi's <docs> section makes this API answer 429 RESOURCE_EXHAUSTED for the
 * whole turn (proven: the same prompt passes with the section shortened). Only that section is
 * rewritten; every other byte of the prompt is sent unchanged. */
const DOCS_SECTION = /<docs>[\s\S]*?<\/docs>/;
const SHORT_DOCS = "<docs>Pi's own documentation lives in the pi package directory; read it only when the user asks about pi itself.</docs>";

export function agySafeInstruction(text: string): string {
	return text.replace(DOCS_SECTION, SHORT_DOCS);
}

/** Thinking blocks are stored for the UI but never sent back: agy replays only text and tool
 * parts, and the reasoning signature rides on the text part that closed the turn. */
export function convertTranscript(context: TranscriptContext): ConvertedTranscript {
	const collapsed = collapseSystemMessages(context);
	const system = getInitialSystemMessage(collapsed.messages);
	const contents: Content[] = [];

	for (const message of withoutInitialSystemMessage(collapsed.messages)) {
		if (message.role === "user") {
			const parts: Part[] = [];
			if (typeof message.content === "string") {
				const text = sanitizeSurrogates(message.content);
				if (text) parts.push({ text });
			} else {
				for (const item of message.content) {
					if (item.type === "text") {
						const text = sanitizeSurrogates(item.text);
						if (text) parts.push({ text });
					} else {
						parts.push(imagePart(item.mimeType, item.data));
					}
				}
			}
			if (parts.length > 0) contents.push({ role: "user", parts });
			continue;
		}

		if (message.role === "assistant") {
			const parts: Part[] = [];
			for (const block of message.content) {
				if (block.type === "thinking") continue;
				if (block.type === "text") {
					const signature = usableSignature(block.textSignature);
					if (!block.text && !signature) continue;
					parts.push({ text: sanitizeSurrogates(block.text), ...(signature ? { thoughtSignature: signature } : {}) });
					continue;
				}
				const signature = usableSignature(block.thoughtSignature);
				parts.push({
					functionCall: { id: block.id, name: block.name, args: block.arguments ?? {} },
					...(signature ? { thoughtSignature: signature } : {}),
				});
			}
			if (parts.length > 0) contents.push({ role: "model", parts });
			continue;
		}

		if (message.role !== "toolResult") continue;

		// Cloud Code Assist takes tool results as a model turn, and agy merges consecutive
		// results into one turn. A user turn here is rejected or ignored by the model.
		const text = message.content
			.filter((item) => item.type === "text")
			.map((item) => item.text)
			.join("\n");
		const images = message.content.filter((item) => item.type === "image");
		const response: { output?: string; error?: string; parts?: InlineDataPart[] } = message.isError
			? { error: text || "(no output)" }
			: { output: text || (images.length > 0 ? "(see attached image)" : "") };
		if (images.length > 0) response.parts = images.map((image) => imagePart(image.mimeType, image.data));
		const part: Part = { functionResponse: { id: message.toolCallId, name: message.toolName, response } };
		const last = contents[contents.length - 1];
		if (last?.role === "model" && last.parts.some((entry) => "functionResponse" in entry)) {
			last.parts.push(part);
		} else {
			contents.push({ role: "model", parts: [part] });
		}
	}

	const systemText = system ? agySafeInstruction(sanitizeSurrogates(getSystemMessageText(system))) : "";
	return {
		contents,
		...(systemText ? { systemInstruction: { role: "user" as const, parts: [{ text: systemText }] } } : {}),
	};
}

/** Gemini's Schema object: unknown keys are rejected, and types are upper-case. */
const SCHEMA_KEYS = new Set([
	"type",
	"format",
	"title",
	"description",
	"nullable",
	"enum",
	"items",
	"properties",
	"required",
	"propertyOrdering",
	"minItems",
	"maxItems",
	"minProperties",
	"maxProperties",
	"minimum",
	"maximum",
	"minLength",
	"maxLength",
	"pattern",
	"anyOf",
	"default",
	"example",
]);

/** A union of single-value literals is one enum: Gemini rejects `const` and reads `anyOf` worst. */
function mergeLiteralUnion(branches: readonly Record<string, unknown>[]): { type: string; values: string[] } | undefined {
	if (branches.length === 0) return undefined;
	let type: string | undefined;
	const values: string[] = [];
	for (const branch of branches) {
		if (Object.keys(branch).some((key) => key !== "type" && key !== "enum")) return undefined;
		if (typeof branch.type !== "string" || !Array.isArray(branch.enum) || branch.enum.length !== 1) return undefined;
		if (type !== undefined && type !== branch.type) return undefined;
		type = branch.type;
		values.push(String(branch.enum[0]));
	}
	return type ? { type, values } : undefined;
}

export function toGoogleSchema(schema: unknown): Record<string, unknown> | undefined {
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) return undefined;
	const source = schema as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	let union: Record<string, unknown>[] | undefined;
	for (const [key, value] of Object.entries(source)) {
		if (!SCHEMA_KEYS.has(key) || value === undefined) continue;
		if (key === "type" && typeof value === "string") {
			out.type = value.toUpperCase();
			continue;
		}
		if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
			const properties: Record<string, unknown> = {};
			for (const [name, child] of Object.entries(value as Record<string, unknown>)) {
				const converted = toGoogleSchema(child);
				if (converted) properties[name] = converted;
			}
			out.properties = properties;
			continue;
		}
		if (key === "items") {
			const converted = toGoogleSchema(value);
			if (converted) out.items = converted;
			continue;
		}
		if (key === "anyOf" && Array.isArray(value)) {
			union = value.map(toGoogleSchema).filter((entry): entry is Record<string, unknown> => entry !== undefined);
			continue;
		}
		if (key === "enum" && Array.isArray(value)) {
			out.enum = value.map((entry) => String(entry));
			continue;
		}
		if (key === "required" && Array.isArray(value)) {
			if (value.length > 0) out.required = value.map((entry) => String(entry));
			continue;
		}
		if (key === "propertyOrdering" && Array.isArray(value)) {
			out.propertyOrdering = value.map((entry) => String(entry));
			continue;
		}
		out[key] = value;
	}
	const literal = union ? mergeLiteralUnion(union) : undefined;
	if (literal) {
		out.type = literal.type;
		out.enum = literal.values;
	} else if (union && union.length > 0) {
		out.anyOf = union;
	}
	const constant = source.const;
	if (out.enum === undefined && (typeof constant === "string" || typeof constant === "number")) {
		out.enum = [String(constant)];
		out.type ??= typeof constant === "number" ? "NUMBER" : "STRING";
	}
	return out;
}

export function toToolDeclarations(tools: readonly Tool[]): ToolGroup[] {
	return tools.map((tool) => {
		const parameters = toGoogleSchema(tool.parameters);
		return {
			functionDeclarations: [
				{
					name: tool.name,
					description: tool.description,
					...(parameters ? { parameters } : {}),
				},
			],
		};
	});
}
