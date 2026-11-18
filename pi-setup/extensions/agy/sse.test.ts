import { describe, expect, test } from "bun:test";
import { readSse } from "./sse";

function bodyOf(chunks: readonly string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
			controller.close();
		},
	});
}

async function collect(chunks: readonly string[]): Promise<unknown[]> {
	const frames: unknown[] = [];
	for await (const frame of readSse(bodyOf(chunks))) frames.push(frame);
	return frames;
}

describe("server-sent events", () => {
	test("a frame split across chunks is reassembled", async () => {
		const frames = await collect(['data: {"a":', ' 1}\n\n', 'data: {"b": 2}\n\n']);
		expect(frames).toEqual([{ a: 1 }, { b: 2 }]);
	});

	test("CRLF line endings and the space after the colon", async () => {
		expect(await collect(['data: {"a": 1}\r\n\r\ndata:{"b": 2}\r\n\r\n'])).toEqual([{ a: 1 }, { b: 2 }]);
	});

	test("multiple data lines join with a newline, comments and other fields are ignored", async () => {
		const frames = await collect([': keep-alive\nevent: message\nretry: 100\ndata: {"a":\ndata: 1}\n\n']);
		expect(frames).toEqual([{ a: 1 }]);
	});

	test("the last frame needs no trailing blank line", async () => {
		expect(await collect(['data: {"a": 1}\n\ndata: {"b": 2}'])).toEqual([{ a: 1 }, { b: 2 }]);
	});

	test("a malformed frame surfaces instead of being skipped", async () => {
		await expect(collect(['data: {oops}\n\n'])).rejects.toThrow();
	});

	test("an empty body yields nothing", async () => {
		expect(await collect([])).toEqual([]);
	});
});
