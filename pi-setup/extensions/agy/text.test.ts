import { describe, expect, test } from "bun:test";
import { sanitizeSurrogates } from "./text";

describe("sanitizeSurrogates", () => {
	test("drops a lone high or low surrogate", () => {
		expect(sanitizeSurrogates("a\uD800b")).toBe("ab");
		expect(sanitizeSurrogates("a\uDC00b")).toBe("ab");
		expect(sanitizeSurrogates("\uD83D")).toBe("");
	});

	test("keeps a valid pair", () => {
		expect(sanitizeSurrogates("wave \uD83D\uDC4B")).toBe("wave \uD83D\uDC4B");
		expect(sanitizeSurrogates("नमस्ते")).toBe("नमस्ते");
	});

	test("keeps a low surrogate that belongs to the pair before it", () => {
		expect(sanitizeSurrogates("\uD83D\uDC4B\uDC00")).toBe("\uD83D\uDC4B");
	});
});
