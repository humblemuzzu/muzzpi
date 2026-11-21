import type { Model, ThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";

export const PROVIDER_ID = "agy";
export const API_ID = "agy-cloudcode";
export const BASE_URL = "https://daily-cloudcode-pa.googleapis.com";

export type Backend = "gemini" | "claude" | "openai";
export type TierName = "low" | "medium" | "high" | "xhigh";
export type WireThinking =
	| { readonly kind: "level"; readonly value: "LOW" | "MEDIUM" | "HIGH" | 100 }
	| { readonly kind: "budget"; readonly value: number };

export interface Tier {
	readonly name: TierName;
	readonly title: string;
	readonly modelEnum: string;
	readonly thinking: WireThinking;
}

export interface Family {
	readonly id: string;
	readonly name: string;
	readonly backend: Backend;
	readonly contextWindow: number;
	readonly maxOutputTokens: number;
	readonly input: readonly ("text" | "image")[];
	readonly defaultTier: TierName;
	readonly tiers: readonly Tier[];
}

const level = (value: "LOW" | "MEDIUM" | "HIGH" | 100): WireThinking => ({ kind: "level", value });
const budget = (value: number): WireThinking => ({ kind: "budget", value });

export const FAMILIES: readonly Family[] = [
	{
		id: "gemini-4-neon",
		name: "Gemini 4 Neon",
		backend: "gemini",
		contextWindow: 1_048_576,
		maxOutputTokens: 262_144,
		input: ["text", "image"],
		defaultTier: "high",
		tiers: [
			{ name: "low", title: "Low", modelEnum: "MODEL_PLACEHOLDER_M534", thinking: level("LOW") },
			{ name: "medium", title: "Medium", modelEnum: "MODEL_PLACEHOLDER_M533", thinking: level("MEDIUM") },
			{ name: "high", title: "High", modelEnum: "MODEL_PLACEHOLDER_M532", thinking: level("HIGH") },
			{ name: "xhigh", title: "XHigh", modelEnum: "MODEL_PLACEHOLDER_M535", thinking: level(100) },
		],
	},
	{
		id: "gemini-4-carbon",
		name: "Gemini 4 Carbon",
		backend: "gemini",
		contextWindow: 1_048_576,
		maxOutputTokens: 262_144,
		input: ["text", "image"],
		defaultTier: "high",
		tiers: [
			{ name: "low", title: "Low", modelEnum: "MODEL_PLACEHOLDER_M438", thinking: level("LOW") },
			{ name: "medium", title: "Medium", modelEnum: "MODEL_PLACEHOLDER_M437", thinking: level("MEDIUM") },
			{ name: "high", title: "High", modelEnum: "MODEL_PLACEHOLDER_M427", thinking: level("HIGH") },
		],
	},
	{
		id: "gemini-4-argon",
		name: "Gemini 4 Argon",
		backend: "gemini",
		contextWindow: 1_048_576,
		maxOutputTokens: 65_536,
		input: ["text", "image"],
		defaultTier: "high",
		tiers: [
			{ name: "low", title: "Low", modelEnum: "MODEL_PLACEHOLDER_M419", thinking: level("LOW") },
			{ name: "medium", title: "Medium", modelEnum: "MODEL_PLACEHOLDER_M418", thinking: level("MEDIUM") },
			{ name: "high", title: "High", modelEnum: "MODEL_PLACEHOLDER_M417", thinking: level("HIGH") },
		],
	},
	{
		id: "gemini-4-hydrogen",
		name: "Gemini 4 Hydrogen",
		backend: "gemini",
		contextWindow: 1_048_576,
		maxOutputTokens: 262_144,
		input: ["text", "image"],
		defaultTier: "high",
		tiers: [
			{ name: "low", title: "Low", modelEnum: "MODEL_PLACEHOLDER_M527", thinking: level("LOW") },
			{ name: "medium", title: "Medium", modelEnum: "MODEL_PLACEHOLDER_M526", thinking: level("MEDIUM") },
			{ name: "high", title: "High", modelEnum: "MODEL_PLACEHOLDER_M525", thinking: level("HIGH") },
			{ name: "xhigh", title: "XHigh", modelEnum: "MODEL_PLACEHOLDER_M528", thinking: level(100) },
		],
	},
	{
		id: "gemini-3.8-flash",
		name: "Gemini 3.8 Flash",
		backend: "gemini",
		contextWindow: 1_048_576,
		maxOutputTokens: 65_536,
		input: ["text", "image"],
		defaultTier: "high",
		tiers: [
			{ name: "low", title: "Low", modelEnum: "MODEL_PLACEHOLDER_M320", thinking: level("LOW") },
			{ name: "medium", title: "Medium", modelEnum: "MODEL_PLACEHOLDER_M319", thinking: level("MEDIUM") },
			{ name: "high", title: "High", modelEnum: "MODEL_PLACEHOLDER_M318", thinking: level("HIGH") },
		],
	},
	{
		id: "claude-opus-5-5",
		name: "Claude Opus 5.5",
		backend: "claude",
		contextWindow: 1_000_000,
		maxOutputTokens: 128_000,
		input: ["text", "image"],
		defaultTier: "high",
		tiers: [
			{ name: "low", title: "Low", modelEnum: "MODEL_PLACEHOLDER_M400", thinking: level("LOW") },
			{ name: "medium", title: "Medium", modelEnum: "MODEL_PLACEHOLDER_M401", thinking: level("MEDIUM") },
			{ name: "high", title: "High", modelEnum: "MODEL_PLACEHOLDER_M402", thinking: level("HIGH") },
		],
	},
	{
		id: "claude-sonnet-5-5",
		name: "Claude Sonnet 5.5",
		backend: "claude",
		contextWindow: 1_000_000,
		maxOutputTokens: 128_000,
		input: ["text", "image"],
		defaultTier: "high",
		tiers: [
			{ name: "low", title: "Low", modelEnum: "MODEL_PLACEHOLDER_M403", thinking: level("LOW") },
			{ name: "medium", title: "Medium", modelEnum: "MODEL_PLACEHOLDER_M404", thinking: level("MEDIUM") },
			{ name: "high", title: "High", modelEnum: "MODEL_PLACEHOLDER_M405", thinking: level("HIGH") },
		],
	},
	{
		id: "gpt-oss-120b",
		name: "GPT-OSS 120B",
		backend: "openai",
		contextWindow: 131_072,
		maxOutputTokens: 32_768,
		input: ["text"],
		defaultTier: "medium",
		tiers: [{ name: "medium", title: "Medium", modelEnum: "MODEL_OPENAI_GPT_OSS_120B_MEDIUM", thinking: budget(8192) }],
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

/** pi's extended thinking-level order, used to clamp any unsupported level the same way pi-ai does. */
const LEVEL_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

function pickTier(family: Family, reasoning: ThinkingLevel | undefined): Tier {
	const requested = reasoning ?? family.defaultTier;
	const exact = family.tiers.find((tier) => tier.name === requested);
	if (exact) return exact;
	const index = LEVEL_ORDER.indexOf(requested as (typeof LEVEL_ORDER)[number]);
	if (index >= 0) {
		for (let i = index; i < LEVEL_ORDER.length; i++) {
			const hit = family.tiers.find((tier) => tier.name === LEVEL_ORDER[i]);
			if (hit) return hit;
		}
		for (let i = index - 1; i >= 0; i--) {
			const hit = family.tiers.find((tier) => tier.name === LEVEL_ORDER[i]);
			if (hit) return hit;
		}
	}
	return family.tiers.find((tier) => tier.name === family.defaultTier) ?? family.tiers[0]!;
}

/**
 * Resolves either a catalog family id (e.g. `gemini-4-neon` + pi's `reasoning` level) or a wire model id
 * (e.g. `gemini-4-neon-high` from an older session) to the exact family, tier and wire slug.
 */
export function resolveModel(id: string, reasoning?: ThinkingLevel): ResolvedModel | undefined {
	const family = FAMILIES.find((entry) => entry.id === id);
	if (family) {
		const tier = pickTier(family, reasoning);
		return { family, tier, wireModel: wireModelId(family, tier) };
	}
	for (const entry of FAMILIES) {
		for (const tier of entry.tiers) {
			if (wireModelId(entry, tier) === id) return { family: entry, tier, wireModel: id };
		}
	}
	return undefined;
}

/** Catalog family id for a wire model slug (`gemini-4-neon-high` → `gemini-4-neon`), or undefined if unknown. */
export function familyIdOfWireModel(wireModel: string | undefined): string | undefined {
	if (!wireModel) return undefined;
	return resolveModel(wireModel)?.family.id;
}

function thinkingLevelMapFor(tiers: readonly Tier[]): ThinkingLevelMap {
	const map: ThinkingLevelMap = { off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: null };
	for (const tier of tiers) {
		map[tier.name] = tier.thinking.kind === "level" ? (tier.thinking.value === 100 ? "XHIGH" : tier.thinking.value) : "MEDIUM";
	}
	return map;
}

/** Best-effort 5-minute cache lifetime for the editor HUD countdown (matches our 4m keep-alive / 5m measured TTL). */
const PROMPT_CACHE_SECONDS = 300;

function buildModels(): readonly Model<typeof API_ID>[] {
	return FAMILIES.map((family) => ({
		id: family.id,
		name: family.name,
		api: API_ID,
		provider: PROVIDER_ID,
		baseUrl: BASE_URL,
		reasoning: true,
		input: [...family.input],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		promptCache: { short: PROMPT_CACHE_SECONDS, long: PROMPT_CACHE_SECONDS },
		contextWindow: family.contextWindow,
		maxTokens: family.maxOutputTokens,
		thinkingLevelMap: thinkingLevelMapFor(family.tiers),
	}));
}

export const MODELS: readonly Model<typeof API_ID>[] = buildModels();
