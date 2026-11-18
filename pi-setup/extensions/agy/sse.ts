export interface SseFrame {
	response?: unknown;
	error?: unknown;
}

/** Reads `data:` frames from a `text/event-stream` body, including a frame split across chunks. */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let data: string[] = [];

	const takeLine = (line: string): unknown => {
		if (line === "") {
			if (data.length === 0) return undefined;
			const payload = data.join("\n");
			data = [];
			return JSON.parse(payload) as unknown;
		}
		if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
		return undefined;
	};

	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let newline = buffer.indexOf("\n");
			while (newline !== -1) {
				const line = buffer.slice(0, newline).replace(/\r$/, "");
				buffer = buffer.slice(newline + 1);
				const frame = takeLine(line);
				if (frame !== undefined) yield frame;
				newline = buffer.indexOf("\n");
			}
		}
		buffer += decoder.decode();
		for (const line of buffer.split("\n")) {
			const frame = takeLine(line.replace(/\r$/, ""));
			if (frame !== undefined) yield frame;
		}
		const tail = takeLine("");
		if (tail !== undefined) yield tail;
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
