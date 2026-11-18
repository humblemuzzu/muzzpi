import { describe, expect, test } from "bun:test";
import { errorText, retryRequest } from "./retry";

function httpError(status: number, headers: Record<string, string> = {}): Error {
	const error = new Error(`Antigravity request failed (${status})`) as Error & { status: number; headers: Headers };
	error.status = status;
	error.headers = new Headers(headers);
	return error;
}

describe("provider retries", () => {
	test("a 429 is retried and the next attempt wins", async () => {
		let attempts = 0;
		const value = await retryRequest(
			async () => {
				attempts += 1;
				if (attempts === 1) throw httpError(429, { "retry-after-ms": "1" });
				return "ok";
			},
			{ maxRetries: 2, baseDelayMs: 1 },
		);
		expect(value).toBe("ok");
		expect(attempts).toBe(2);
	});

	test("a 400 is not retried", async () => {
		let attempts = 0;
		await expect(
			retryRequest(
				async () => {
					attempts += 1;
					throw httpError(400);
				},
				{ maxRetries: 3, baseDelayMs: 1 },
			),
		).rejects.toThrow("400");
		expect(attempts).toBe(1);
	});

	test("retries stop at maxRetries", async () => {
		let attempts = 0;
		await expect(
			retryRequest(
				async () => {
					attempts += 1;
					throw httpError(503);
				},
				{ maxRetries: 2, baseDelayMs: 1 },
			),
		).rejects.toThrow("503");
		expect(attempts).toBe(3);
	});

	test("a network failure is retried, an abort is not", async () => {
		let attempts = 0;
		await expect(
			retryRequest(
				async () => {
					attempts += 1;
					throw new TypeError("fetch failed");
				},
				{ maxRetries: 1, baseDelayMs: 1 },
			),
		).rejects.toThrow("fetch failed");
		expect(attempts).toBe(2);

		const controller = new AbortController();
		controller.abort();
		await expect(
			retryRequest(async () => {
				throw httpError(429);
			}, { maxRetries: 3, signal: controller.signal }),
		).rejects.toThrow("aborted");
	});

	test("a retry-after past the cap fails at once instead of waiting", async () => {
		await expect(
			retryRequest(
				async () => {
					throw httpError(429, { "retry-after": "120" });
				},
				{ maxRetries: 3, maxRetryDelayMs: 60_000, baseDelayMs: 1 },
			),
		).rejects.toThrow("120s");
	});
});

describe("error text", () => {
	test("keeps a cause that fetch hid", () => {
		const error = new TypeError("fetch failed");
		error.cause = new Error("getaddrinfo ENOTFOUND daily-cloudcode-pa.googleapis.com");
		expect(errorText(error)).toBe("fetch failed: getaddrinfo ENOTFOUND daily-cloudcode-pa.googleapis.com");
	});

	test("does not repeat a cause that is already in the message", () => {
		const error = new Error("fetch failed: ECONNRESET");
		error.cause = new Error("ECONNRESET");
		expect(errorText(error)).toBe("fetch failed: ECONNRESET");
	});

	test("non-errors become their string", () => {
		expect(errorText("boom")).toBe("boom");
	});
});
