import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MODELS } from "./catalog";

const settings = JSON.parse(readFileSync(join(import.meta.dir, "../../settings.json"), "utf8")) as {
	enabledModels: string[];
	compaction: { modelOverrides: Record<string, { reserveTokens?: number }> };
};

/** Gemini 4's 1,048,576 tokens hold input and output together: this leaves one heavy turn plus its reply. */
const COMPACT_ABOVE = 920_000;

describe("agy compaction", () => {
	test("every agy model compacts once its context passes 920k (pi: tokens > window - reserveTokens)", () => {
		for (const model of MODELS) {
			const override = settings.compaction.modelOverrides[`${model.provider}/${model.id}`];
			expect(override?.reserveTokens, model.id).toBeDefined();
			expect(model.contextWindow - override!.reserveTokens!, model.id).toBe(COMPACT_ABOVE);
		}
	});

	test("no override names an agy model the catalog does not serve", () => {
		const served = new Set(MODELS.map((model) => `${model.provider}/${model.id}`));
		const agyKeys = Object.keys(settings.compaction.modelOverrides).filter((key) => key.startsWith("agy/"));
		expect(agyKeys.filter((key) => !served.has(key))).toEqual([]);
		expect(settings.enabledModels.filter((id) => id.startsWith("agy/") && !served.has(id))).toEqual([]);
	});
});
