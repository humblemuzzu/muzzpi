import type { Model, ThinkingLevelMap } from "@earendil-works/pi-ai";

export const PROVIDER_ID = "agy";
export const API_ID = "agy-cloudcode";
export const BASE_URL = "https://daily-cloudcode-pa.googleapis.com";

export type TierName = "low" | "medium" | "high" | "xhigh";
export type WireThinkingLevel = "LOW" | "MEDIUM" | "HIGH" | 100;

export interface Tier {
	readonly name: TierName;
	readonly title: string;
	readonly modelEnum: string;
	readonly thinkingLevel: WireThinkingLevel;
}

export interface Family {
	readonly id: string;
	readonly name: string;
	readonly contextWindow: number;
	readonly maxOutputTokens: number;
	readonly tiers: readonly Tier[];
}

export const FAMILIES: readonly Family[] = [
	{
		id: "gemini-4-carbon",
		name: "Gemini 4 Carbon",
		contextWindow: 1_048_576,
		maxOutputTokens: 262_144,
		tiers: [
			{ name: "medium", title: "Medium", modelEnum: "MODEL_PLACEHOLDER_M437", thinkingLevel: "MEDIUM" },
			{ name: "high", title: "High", modelEnum: "MODEL_PLACEHOLDER_M427", thinkingLevel: "HIGH" },
		],
	},
	{
		id: "gemini-4-argon",
		name: "Gemini 4 Argon",
		contextWindow: 1_048_576,
		maxOutputTokens: 65_536,
		tiers: [
			{ name: "medium", title: "Medium", modelEnum: "MODEL_PLACEHOLDER_M418", thinkingLevel: "MEDIUM" },
			{ name: "high", title: "High", modelEnum: "MODEL_PLACEHOLDER_M417", thinkingLevel: "HIGH" },
		],
	},
	{
		id: "gemini-4-hydrogen",
		name: "Gemini 4 Hydrogen",
		contextWindow: 1_048_576,
		maxOutputTokens: 262_144,
		tiers: [
			{ name: "low", title: "Low", modelEnum: "MODEL_PLACEHOLDER_M527", thinkingLevel: "LOW" },
			{ name: "medium", title: "Medium", modelEnum: "MODEL_PLACEHOLDER_M526", thinkingLevel: "MEDIUM" },
			{ name: "high", title: "High", modelEnum: "MODEL_PLACEHOLDER_M525", thinkingLevel: "HIGH" },
			{ name: "xhigh", title: "XHigh", modelEnum: "MODEL_PLACEHOLDER_M528", thinkingLevel: 100 },
		],
	},
];

export interface ResolvedModel {
	readonly family: Family;
	readonly tier: Tier;
	readonly wireModel: string;
}

export function wireModelId(family: Family, tier: Tier): string {
	return `${family.id}-${tier.name}`;
}

export function resolveModel(id: string): ResolvedModel | undefined {
	for (const family of FAMILIES) {
		for (const tier of family.tiers) {
			if (wireModelId(family, tier) === id) return { family, tier, wireModel: id };
		}
	}
	return undefined;
}

function pinnedThinkingLevels(tier: Tier): ThinkingLevelMap {
	const map: ThinkingLevelMap = { off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: null };
	map[tier.name] = tier.thinkingLevel === 100 ? "XHIGH" : tier.thinkingLevel;
	return map;
}

function buildModels(): readonly Model<typeof API_ID>[] {
	const models: Model<typeof API_ID>[] = [];
	for (const family of FAMILIES) {
		for (const tier of family.tiers) {
			models.push({
				id: wireModelId(family, tier),
				name: `${family.name} (${tier.title})`,
				api: API_ID,
				provider: PROVIDER_ID,
				baseUrl: BASE_URL,
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: family.contextWindow,
				maxTokens: family.maxOutputTokens,
				thinkingLevelMap: pinnedThinkingLevels(tier),
			});
		}
	}
	return models;
}

export const MODELS: readonly Model<typeof API_ID>[] = buildModels();
