import { describe, expect, test } from "bun:test";
import { estimate, PriceBook, priceUsage, ratesCurrent } from "./pricing";
import { PRICES } from "./test-helpers";

const usage = (u: Partial<{ input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite1h: number }>) => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, ...u });

describe("lookup takes exact matches only", () => {
	test("the provider's own row, then its dated snapshot folded away", () => {
		expect(PRICES.lookup("anthropic/claude-opus-5")?.rates.input).toBe(5);
		expect(PRICES.lookup("anthropic/claude-opus-5-20261001")?.rates.input).toBe(5);
	});

	test("a subscription plan's $0 row falls through to the model's real tariff", () => {
		expect(PRICES.lookup("openai-codex/gpt-6")?.rates.input).toBe(2);
		expect(PRICES.lookup("zai-coding-plan/glm-6")?.rates.input).toBe(1);
	});

	test("an unlisted provider borrows a first-party row, then a reseller row, then OpenRouter's", () => {
		expect(PRICES.lookup("codex-desktop/gpt-6")?.rates.input).toBe(2);
		expect(PRICES.lookup("openai/gpt-6-codex")?.rates.input).toBe(1);
		expect(PRICES.lookup("opencode/kimi-k3")?.rates.input).toBe(0.6);
	});

	test("free models are free, near misses are unpriced", () => {
		expect(PRICES.lookup("opencode/big-pickle")?.rates.output).toBe(0);
		expect(PRICES.lookup("opencode/glm-5-free")?.rates.output).toBe(0);
		expect(PRICES.lookup("anthropic/claude-opus-5-1")).toBeUndefined();
		expect(PRICES.lookup("openai/gpt-6x")).toBeUndefined();
	});
});

describe("priceUsage is pi's own formula", () => {
	test("each bucket at its rate", () => {
		const c = priceUsage(PRICES.lookup("anthropic/claude-opus-5")!.rates, usage({ input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 1e6 }));
		expect(c).toEqual({ input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, total: 36.75 });
	});

	test("1h cache writes bill at twice the input rate", () => {
		const c = priceUsage(PRICES.lookup("anthropic/claude-opus-5")!.rates, usage({ cacheWrite: 2e6, cacheWrite1h: 1e6 }));
		expect(c.cacheWrite).toBe(6.25 + 10);
	});

	test("the prompt size picks the tier for the whole request", () => {
		const rates = PRICES.lookup("openai/gpt-6")!.rates;
		expect(priceUsage(rates, usage({ input: 200_000, cacheRead: 72_000, output: 1e6 })).output).toBe(10);
		expect(priceUsage(rates, usage({ input: 200_000, cacheRead: 72_001, output: 1e6 })).output).toBe(15);
	});
});

test("estimates record the rates they used, and notice when the catalog changes", () => {
	const rates: Record<string, string> = {};
	expect(estimate(PRICES, rates, "anthropic/claude-opus-5", usage({ output: 1e6 }))).toMatchObject({ estimated: true, unpriced: false });
	expect(estimate(PRICES, rates, "nobody/mystery", usage({ output: 10 }))).toMatchObject({ estimated: false, unpriced: true, cost: { total: 0 } });
	expect(ratesCurrent(PRICES, rates)).toBe(true);
	const repriced = new PriceBook([{ provider: "anthropic", id: "claude-opus-5", cost: { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 } }]);
	expect(ratesCurrent(repriced, rates)).toBe(false);
});
