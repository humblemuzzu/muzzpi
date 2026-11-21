import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FAMILIES, MODELS } from "./catalog";

const settings = JSON.parse(readFileSync(join(import.meta.dir, "../../settings.json"), "utf8")) as {
	enabledModels: string[];
	compaction: { modelOverrides: Record<string, { reserveTokens?: number }> };
};

/** Gemini's 1,048,576 tokens hold input+output together (compact above 920k); Claude compacts above 970k; GPT-OSS leaves 16k reserve. */
const EXPECTED_THRESHOLD: Record<string, number> = {
	gemini: 920_000,
	claude: 970_000,
	openai: 114_688,
};

describe("agy compaction", () => {
	test("every agy model has a compaction override matching its backend threshold", () => {
		for (const model of MODELS) {
			const family = FAMILIES.find((entry) => entry.id === model.id)!;
			const override = settings.compaction.modelOverrides[`${model.provider}/${model.id}`];
			expect(override?.reserveTokens, model.id).toBeDefined();
			expect(model.contextWindow - override!.reserveTokens!, model.id).toBe(EXPECTED_THRESHOLD[family.backend]);
		}
	});

	test("no override or enabledModel names an agy model the catalog does not serve", () => {
		const served = new Set(MODELS.map((model) => `${model.provider}/${model.id}`));
		const agyKeys = Object.keys(settings.compaction.modelOverrides).filter((key) => key.startsWith("agy/"));
		expect(agyKeys.filter((key) => !served.has(key))).toEqual([]);
		expect(settings.enabledModels.filter((id) => id.startsWith("agy/") && !served.has(id))).toEqual([]);
		for (const id of served) expect(settings.enabledModels).toContain(id);
	});
});
