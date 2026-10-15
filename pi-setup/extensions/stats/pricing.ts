import { type Cost, ZERO_COST } from "./record";

/** Dollars per million tokens, as pi's model catalog lists them. */
export interface Rates {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	tiers?: Array<{ inputTokensAbove: number; input: number; output: number; cacheRead: number; cacheWrite: number }>;
}

export interface CatalogModel {
	provider: string;
	id: string;
	cost?: Rates;
}

export interface Price {
	rates: Rates;
	/** Changes whenever the rates do, so cached estimates can tell they are stale. */
	sig: string;
}

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cacheWrite1h: number;
}

/** Where a model's tariff is published first; a reseller or a plan row is a fallback, never a preference. */
const FIRST_PARTY = ["anthropic", "openai", "google", "xai", "deepseek", "moonshotai", "zai", "minimax", "mistral", "xiaomi"];
const FREE: Rates = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function isZero(r: Rates): boolean {
	return r.input === 0 && r.output === 0 && r.cacheRead === 0 && r.cacheWrite === 0 && !r.tiers?.length;
}

function valid(r: unknown): r is Rates {
	const x = r as Rates;
	return !!x && [x.input, x.output, x.cacheRead, x.cacheWrite].every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0);
}

function signature(r: Rates): string {
	const text = JSON.stringify([r.input, r.output, r.cacheRead, r.cacheWrite, (r.tiers ?? []).map((t) => [t.inputTokensAbove, t.input, t.output, t.cacheRead, t.cacheWrite])]);
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
	return (h >>> 0).toString(36);
}

/**
 * Exact matches only: a model is priced from its own provider's row, then
 * the dated-snapshot-free id, then the same id at a first-party provider, a
 * priced reseller row, or OpenRouter's `vendor/id`. Anything else is
 * unpriced, never guessed: a near match is how cost tools invent money.
 */
export class PriceBook {
	private readonly byProvider = new Map<string, Rates>();
	private readonly byId = new Map<string, Array<[string, Rates]>>();
	/** OpenRouter's `vendor/model` rows by their model part. */
	private readonly routed = new Map<string, Rates>();
	private readonly memo = new Map<string, Price | undefined>();

	constructor(models: Iterable<CatalogModel>) {
		for (const m of models) {
			if (!valid(m.cost)) continue;
			const rates: Rates = { input: m.cost.input, output: m.cost.output, cacheRead: m.cost.cacheRead, cacheWrite: m.cost.cacheWrite, tiers: m.cost.tiers?.filter(valid) as Rates["tiers"] };
			this.byProvider.set(`${m.provider}/${m.id}`, rates);
			const list = this.byId.get(m.id) ?? [];
			list.push([m.provider, rates]);
			this.byId.set(m.id, list);
			const slash = m.id.indexOf("/");
			if (m.provider === "openrouter" && slash !== -1 && !isZero(rates) && !this.routed.has(m.id.slice(slash + 1))) this.routed.set(m.id.slice(slash + 1), rates);
		}
	}

	get size(): number {
		return this.byProvider.size;
	}

	/** `provider/model` → its rates, or undefined when the catalog has no exact entry. */
	lookup(modelKey: string): Price | undefined {
		if (this.memo.has(modelKey)) return this.memo.get(modelKey);
		const rates = this.resolve(modelKey);
		const price = rates && { rates, sig: signature(rates) };
		this.memo.set(modelKey, price);
		return price;
	}

	private resolve(modelKey: string): Rates | undefined {
		const slash = modelKey.indexOf("/");
		const provider = modelKey.slice(0, slash);
		const id = modelKey.slice(slash + 1);
		const candidates = [...new Set([id, id.replace(/-\d{8}$/, "")])];
		let ownZero = false;
		for (const c of candidates) {
			const own = this.byProvider.get(`${provider}/${c}`);
			if (own && !isZero(own)) return own;
			ownZero ||= !!own;
		}
		if (/-free$/.test(id)) return FREE;
		for (const c of candidates) {
			const rows = (this.byId.get(c) ?? []).filter(([, r]) => !isZero(r));
			const firstParty = FIRST_PARTY.map((p) => rows.find(([prov]) => prov === p)).find((x) => x !== undefined);
			const hit = firstParty?.[1] ?? rows[0]?.[1] ?? this.routed.get(c);
			if (hit) return hit;
		}
		return ownZero ? FREE : undefined;
	}
}

/** pi's own formula (pi-ai `calculateCost`): the request's prompt size picks the tier, and 1h cache writes bill at twice the input rate. */
export function priceUsage(rates: Rates, u: Usage): Cost {
	const prompt = u.input + u.cacheRead + u.cacheWrite;
	let r: Omit<Rates, "tiers"> = rates;
	let matched = -1;
	for (const tier of rates.tiers ?? []) {
		if (prompt > tier.inputTokensAbove && tier.inputTokensAbove > matched) {
			r = tier;
			matched = tier.inputTokensAbove;
		}
	}
	const longWrite = Math.min(u.cacheWrite1h, u.cacheWrite);
	const shortWrite = u.cacheWrite - longWrite;
	const input = (r.input / 1e6) * u.input;
	const output = (r.output / 1e6) * u.output;
	const cacheRead = (r.cacheRead / 1e6) * u.cacheRead;
	const cacheWrite = (r.cacheWrite * shortWrite + r.input * 2 * longWrite) / 1e6;
	return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

/** The cost of a response the harness did not price: catalog estimate, or zero and unpriced. */
export function estimate(book: PriceBook, rates: Record<string, string>, model: string, u: Usage): { cost: Cost; estimated: boolean; unpriced: boolean } {
	const price = book.lookup(model);
	rates[model] = price?.sig ?? "none";
	const tokens = u.input + u.output + u.cacheRead + u.cacheWrite;
	if (!price) return { cost: ZERO_COST, estimated: false, unpriced: tokens > 0 };
	return { cost: priceUsage(price.rates, u), estimated: true, unpriced: false };
}

/** True when every model a record priced still resolves to the same rates. */
export function ratesCurrent(book: PriceBook, rates: Record<string, string>): boolean {
	for (const [model, sig] of Object.entries(rates)) {
		if ((book.lookup(model)?.sig ?? "none") !== sig) return false;
	}
	return true;
}
