import { describe, expect, test } from "bun:test";
import { calculateCost, type Usage } from "@earendil-works/pi-ai";
import { MODELS } from "./catalog";

/**
 * List prices per 1M tokens, from Google's and Anthropic's own pricing pages (see FAMILIES in catalog.ts for
 * the source list and the promotion dates). These pin what pi's calculateCost turns into `usage.cost`, which
 * is what the status line, /stats and the HUD show for a session.
 */
const PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
	"gemini-4-neon": { input: 3, output: 15, cacheRead: 0.15, cacheWrite: 0 },
	"gemini-4-carbon": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 0 },
	"gemini-4-argon": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 0 },
	"gemini-4-hydrogen": { input: 1.5, output: 7.5, cacheRead: 0.075, cacheWrite: 0 },
	"gemini-3.8-flash": { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 0 },
	"claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
	"claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
	"gpt-oss-120b": { input: 0.09, output: 0.36, cacheRead: 0.09, cacheWrite: 0 },
};

function priced(modelId: string, tokens: Partial<Omit<Usage, "cost">>): Usage {
	const model = MODELS.find((entry) => entry.id === modelId);
	if (!model) throw new Error(`no model ${modelId}`);
	const usage: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		...tokens,
	};
	calculateCost(model, usage);
	return usage;
}

describe("agy list prices", () => {
	test("every model carries its published per-million price and none is left at zero", () => {
		expect(MODELS.map((model) => model.id).sort()).toEqual(Object.keys(PRICES).sort());
		for (const model of MODELS) {
			const expected = PRICES[model.id]!;
			expect({ ...model.cost }, model.id).toMatchObject(expected);
			expect(model.cost.input, model.id).toBeGreaterThan(0);
			expect(model.cost.output, model.id).toBeGreaterThan(0);
		}
	});

	test("a million input and a million output tokens cost the published sum", () => {
		const expectations: Record<string, number> = {
			"gemini-4-neon": 18,
			"gemini-4-carbon": 24,
			"gemini-4-argon": 24,
			"gemini-4-hydrogen": 9,
			"gemini-3.8-flash": 9,
			"claude-opus-5-5": 24,
			"claude-sonnet-5-5": 12,
			"gpt-oss-120b": 0.45,
		};
		for (const [modelId, total] of Object.entries(expectations)) {
			const usage = priced(modelId, { input: 1_000_000, output: 1_000_000, totalTokens: 2_000_000 });
			expect(usage.cost.total, modelId).toBeCloseTo(total, 10);
			expect(usage.cost.totalFromProvider).toBe(false);
		}
	});

	test("a cache read costs the published rate: 5% of input on Gemini 4 and Claude, 10% on 3.8 Flash, input rate on GPT-OSS", () => {
		for (const modelId of ["gemini-4-neon", "gemini-4-carbon", "gemini-4-argon", "gemini-4-hydrogen"]) {
			const price = PRICES[modelId]!;
			expect(priced(modelId, { cacheRead: 1_000_000 }).cost.total, modelId).toBeCloseTo(price.input * 0.05, 10);
		}
		// Gemini 3.8 Flash's cache read is 10% of input, not 5% ($0.075 on $0.75, $0.15 on $1.50).
		expect(priced("gemini-3.8-flash", { cacheRead: 1_000_000 }).cost.total).toBeCloseTo(0.15, 10);
		expect(priced("claude-opus-5-5", { cacheRead: 1_000_000 }).cost.total).toBeCloseTo(0.2, 10);
		expect(priced("claude-sonnet-5-5", { cacheRead: 1_000_000 }).cost.total).toBeCloseTo(0.1, 10);
		// Vertex gives GPT-OSS no cache discount, so a read is billed as a normal input token.
		expect(priced("gpt-oss-120b", { cacheRead: 1_000_000 }).cost.total).toBeCloseTo(0.09, 10);
	});

	test("a Claude cache write bills at its 5-minute rate, a Gemini one at nothing", () => {
		expect(priced("claude-opus-5-5", { cacheWrite: 1_000_000 }).cost.total).toBeCloseTo(5, 10);
		expect(priced("claude-sonnet-5-5", { cacheWrite: 1_000_000 }).cost.total).toBeCloseTo(2.5, 10);
		expect(priced("gemini-4-neon", { cacheWrite: 1_000_000 }).cost.total).toBe(0);
	});

	test("a 200k prompt read from cache after a tool call costs the cached rate, not a rebuild", () => {
		// 200k prompt, 199k cached, 1k new, 500 output on Neon.
		const usage = priced("gemini-4-neon", { input: 1_000, cacheRead: 199_000, output: 500 });
		expect(usage.cost.input).toBeCloseTo(0.003, 10);
		expect(usage.cost.cacheRead).toBeCloseTo(0.02985, 10);
		expect(usage.cost.output).toBeCloseTo(0.0075, 10);
		expect(usage.cost.total).toBeCloseTo(0.04035, 10);
		// The same prompt uncached would be ~$0.60, so the discount is doing real work.
		const uncached = priced("gemini-4-neon", { input: 200_000, output: 500 });
		expect(uncached.cost.total).toBeGreaterThan(usage.cost.total * 10);
	});
});
