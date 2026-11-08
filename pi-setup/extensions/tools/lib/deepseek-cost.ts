/**
 * DeepSeek bills peak hours at twice the rates models.json holds (its off-peak
 * card), and pi prices every reply at one fixed rate. A DeepSeek reply's cost
 * is recomputed here from its tokens at the hour its request was made.
 * Recomputing instead of doubling the stored cost means a reply seen twice is
 * priced the same.
 */

import { calculateCost, type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { priceMultiplierAt } from "../../deepseek-peak/peak";

/** the reply with its cost at DeepSeek's rate for its hour, or undefined when it needs no change */
export function peakPriced(message: AssistantMessage, model: Model<Api> | undefined): AssistantMessage | undefined {
	if (message.provider !== "deepseek" || !model || !message.usage || message.usage.cost?.totalFromProvider) return undefined;
	const multiplier = priceMultiplierAt(new Date(message.timestamp));
	if (multiplier === 1) return undefined;
	const usage = { ...message.usage, cost: { ...message.usage.cost } };
	const base = calculateCost(model, usage);
	const cost = {
		...base,
		input: base.input * multiplier,
		output: base.output * multiplier,
		cacheRead: base.cacheRead * multiplier,
		cacheWrite: base.cacheWrite * multiplier,
		total: base.total * multiplier,
	};
	return { ...message, usage: { ...usage, cost } };
}
