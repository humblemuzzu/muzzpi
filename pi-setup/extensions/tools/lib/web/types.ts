export const PROVIDER_IDS = ["context", "deepseek", "parallel"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export const SEARCH_MODES = ["fast", "one-shot", "agentic"] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];

export const FRESHNESS = ["day", "week", "month", "year"] as const;
export type Freshness = (typeof FRESHNESS)[number];

export interface SearchRequest {
	objective: string;
	queries: string[];
	maxResults: number;
	mode: SearchMode;
	includeDomains: string[];
	excludeDomains: string[];
	freshness?: Freshness;
	languages: string[];
	country?: string;
}

export interface Hit {
	url: string;
	title: string;
	date?: string;
	passages: string[];
}

export interface ProviderResult {
	hits: Hit[];
	costUsd: number;
	credits?: { used: number; remaining: number };
	/** what this provider could not honour (a dropped filter, a failed sub-query); shown to the model. */
	notes: string[];
}

export interface ProviderCall {
	request: SearchRequest;
	key: string;
	endpoint: string;
	timeoutMs: number;
	signal?: AbortSignal;
}

export interface SearchProvider {
	id: ProviderId;
	label: string;
	keyEnv: string;
	/** requests this process may have in flight at once; the chain skips the provider rather than queue. */
	maxConcurrent?: number;
	search(call: ProviderCall): Promise<ProviderResult>;
}

export function freshnessStart(freshness: Freshness, now = new Date()): string {
	const days = { day: 1, week: 7, month: 31, year: 366 }[freshness];
	return new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
}

const TRACKING_PARAM = /^(utm_\w+|fbclid|gclid|mc_eid|mc_cid)$/i;

/** a result URL without tracking parameters or a bare numeric fragment, so the link the model cites is the page's own. */
export function cleanUrl(url: string): string {
	try {
		const u = new URL(url);
		for (const key of [...u.searchParams.keys()]) {
			const value = u.searchParams.get(key) ?? "";
			if (TRACKING_PARAM.test(key) || (key === "source" && value.startsWith("post_page"))) u.searchParams.delete(key);
		}
		if (/^#\d+$/.test(u.hash)) u.hash = "";
		return u.toString();
	} catch {
		return url;
	}
}

export function dedupeHits(hits: Hit[], max: number): Hit[] {
	const seen = new Set<string>();
	const out: Hit[] = [];
	for (const hit of hits) {
		const key = urlKey(hit.url);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(hit);
		if (out.length >= max) break;
	}
	return out;
}

function urlKey(url: string): string {
	try {
		const u = new URL(url);
		u.hash = "";
		return `${u.host.replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}${u.search}`.toLowerCase();
	} catch {
		return url.trim().toLowerCase();
	}
}
