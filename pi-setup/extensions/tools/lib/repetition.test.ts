import { describe, expect, test } from "bun:test";
import { RepetitionWatch, repetitionAtEnd } from "./repetition";

describe("repetitionAtEnd", () => {
	test("a short phrase looping is caught", () => {
		expect(repetitionAtEnd(`Let me check the file. ${"I will read the config now. ".repeat(8)}`)).toBeDefined();
	});

	test("a long paragraph repeated three times across 1024+ characters is caught", () => {
		const paragraph = "The handler validates the request, loads the user, checks the quota and writes the audit row. ".repeat(4);
		expect(paragraph.length).toBeGreaterThan(342);
		expect(repetitionAtEnd(`intro ${paragraph}${paragraph}${paragraph}`)).toBeDefined();
	});

	test("ordinary prose, code and lists pass", () => {
		const prose = Array.from({ length: 40 }, (_, i) => `Step ${i}: read file_${i}.ts and note what it exports.`).join("\n");
		expect(repetitionAtEnd(prose)).toBeUndefined();
		const code = Array.from({ length: 30 }, (_, i) => `\tconst value${i} = compute(${i}, input[${i}]);`).join("\n");
		expect(repetitionAtEnd(code)).toBeUndefined();
	});

	test("drawn rules and table separators repeat on purpose and pass", () => {
		expect(repetitionAtEnd(`╭${"─".repeat(400)}╮`)).toBeUndefined();
		expect(repetitionAtEnd(`| a | b |\n${"|---".repeat(120)}|`)).toBeUndefined();
		expect(repetitionAtEnd("=".repeat(500))).toBeUndefined();
	});

	test("three repeats of a short unit is not enough on its own", () => {
		expect(repetitionAtEnd("ok ok ok")).toBeUndefined();
	});
});

describe("RepetitionWatch", () => {
	test("fires once enough looping text has streamed in, and reset starts over", () => {
		const watch = new RepetitionWatch();
		let fired = false;
		for (let i = 0; i < 40 && !fired; i++) fired = watch.feed("same words again and again. ");
		expect(fired).toBe(true);
		watch.reset();
		expect(watch.feed("fresh start")).toBe(false);
	});

	test("thinking and reply text never join into one repeat", () => {
		const watch = new RepetitionWatch();
		let fired = false;
		for (let i = 0; i < 40 && !fired; i++) {
			fired = watch.feed("same words again and again. ", i % 2 === 0 ? "thinking_delta" : "text_delta");
		}
		expect(fired).toBe(false);
	});
});
