/**
 * Loads X posts by id without a model in between: FxTwitter's status API
 * (full text of long posts, every count, views), then X's own embed endpoint
 * (cdn.syndication.twimg.com: no views or reposts, long posts cut). Grok's X
 * tool decides which posts; this decides what they say.
 */

import { deadline } from "../web/http";
import { snowflakeTime, type XMedia, type XPost } from "./parse";

export type PostSource = "fxtwitter" | "syndication";
export const POST_SOURCES: readonly PostSource[] = ["fxtwitter", "syndication"];

export interface HydrateOptions {
	sources: readonly PostSource[];
	timeoutMs: number;
	signal?: AbortSignal;
	fxtwitterUrl?: string;
	syndicationUrl?: string;
	concurrency?: number;
}

export interface HydrateResult {
	posts: Map<string, XPost>;
	/** which source answered for each loaded id. */
	from: Map<string, PostSource>;
	/** ids no source could load, with the last reason. */
	failed: Map<string, string>;
}

const FXTWITTER_URL = "https://api.fxtwitter.com";
const SYNDICATION_URL = "https://cdn.syndication.twimg.com";
const PER_REQUEST_MS = 8000;

const isoFromSeconds = (s: unknown) => (typeof s === "number" && s > 0 ? new Date(s * 1000).toISOString().replace(/\.\d{3}Z$/, "Z") : undefined);
const isoFromDate = (s: unknown) => {
	const t = typeof s === "string" ? Date.parse(s) : Number.NaN;
	return Number.isNaN(t) ? undefined : new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
};
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

function fxPost(t: any): XPost | undefined {
	const id = str(t?.id);
	if (!id) return undefined;
	const username = str(t.author?.screen_name);
	const media: XMedia[] = (Array.isArray(t.media?.all) ? t.media.all : [])
		.filter((m: any) => str(m?.url))
		.map((m: any) => ({ type: String(m.type ?? "media"), url: m.url, ...(num(m.duration) && { durationMs: Math.round(m.duration * 1000) }) }));
	const quoted = t.quote ? fxPost(t.quote) : undefined;
	return {
		id,
		url: `https://x.com/${username ?? "i"}/status/${id}`,
		username,
		name: str(t.author?.name),
		createdAt: isoFromSeconds(t.created_timestamp) ?? isoFromDate(t.created_at) ?? snowflakeTime(id),
		engagement: {
			likes: num(t.likes),
			reposts: num(t.retweets),
			quotes: num(t.quotes),
			replies: num(t.replies),
			bookmarks: num(t.bookmarks),
			views: num(t.views),
		},
		media,
		text: String(t.text ?? ""),
		...(str(t.replying_to_status) && { replyTo: t.replying_to_status }),
		...(quoted && { quoted }),
		replies: [],
	};
}

/** the token X's embed widget computes for an id (react-tweet's formula); the endpoint refuses some requests without it. */
export function syndicationToken(id: string): string {
	return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
}

function syndicationPost(t: any): XPost | undefined {
	const id = str(t?.id_str);
	if (!id) return undefined;
	const username = str(t.user?.screen_name);
	const range = Array.isArray(t.display_text_range) ? t.display_text_range : undefined;
	const chars = Array.from(String(t.text ?? ""));
	let text = range ? chars.slice(range[0], range[1]).join("") : chars.join("");
	for (const u of t.entities?.urls ?? []) if (str(u?.url) && str(u?.expanded_url)) text = text.split(u.url).join(u.expanded_url);
	for (const m of t.entities?.media ?? []) if (str(m?.url)) text = text.split(m.url).join("");
	text = text.trim();
	const url = `https://x.com/${username ?? "i"}/status/${id}`;
	if (t.note_tweet) text += `\n[long post; X's embed shows only the start: ${url}]`;
	const media: XMedia[] = (Array.isArray(t.mediaDetails) ? t.mediaDetails : []).map((m: any) => {
		const video = (m.video_info?.variants ?? []).filter((v: any) => v?.content_type === "video/mp4").sort((a: any, b: any) => (b.bitrate ?? 0) - (a.bitrate ?? 0))[0];
		const ms = num(m.video_info?.duration_millis);
		return { type: m.type === "animated_gif" ? "gif" : String(m.type ?? "media"), url: video?.url ?? m.media_url_https, ...(ms && { durationMs: ms }) };
	}).filter((m: XMedia) => m.url);
	const quoted = t.quoted_tweet ? syndicationPost(t.quoted_tweet) : undefined;
	return {
		id,
		url,
		username,
		name: str(t.user?.name),
		createdAt: isoFromDate(t.created_at) ?? snowflakeTime(id),
		engagement: { likes: num(t.favorite_count), replies: num(t.conversation_count) },
		media,
		text,
		...(str(t.in_reply_to_status_id_str) && { replyTo: t.in_reply_to_status_id_str }),
		...(quoted && { quoted }),
		replies: [],
	};
}

async function getJson(url: string, signal: AbortSignal): Promise<{ status: number; json?: any }> {
	const res = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "muzzpi-x-search" }, signal });
	const text = await res.text();
	try {
		return { status: res.status, json: JSON.parse(text) };
	} catch {
		return { status: res.status };
	}
}

async function loadOne(id: string, source: PostSource, opts: HydrateOptions, signal: AbortSignal): Promise<XPost | string> {
	const each = deadline(PER_REQUEST_MS, signal);
	try {
		if (source === "fxtwitter") {
			const { status, json } = await getJson(`${opts.fxtwitterUrl ?? FXTWITTER_URL}/status/${id}`, each);
			const post = status === 200 ? fxPost(json?.tweet) : undefined;
			return post?.id === id ? post : `FxTwitter HTTP ${status}${json?.message ? ` ${json.message}` : ""}`;
		}
		const { status, json } = await getJson(`${opts.syndicationUrl ?? SYNDICATION_URL}/tweet-result?id=${id}&token=${syndicationToken(id)}&lang=en`, each);
		const post = status === 200 ? syndicationPost(json) : undefined;
		return post?.id === id ? post : `X embed HTTP ${status}`;
	} catch (err) {
		return each.aborted && !signal.aborted ? `${source} timed out` : `${source}: ${(err as Error)?.message ?? err}`;
	}
}

/** every id through the sources in order; a source that fails one id is still asked for the next. */
export async function hydratePosts(ids: readonly string[], opts: HydrateOptions): Promise<HydrateResult> {
	const out: HydrateResult = { posts: new Map(), from: new Map(), failed: new Map() };
	const unique = [...new Set(ids)];
	if (!unique.length || !opts.sources.length) {
		for (const id of unique) out.failed.set(id, "no post source is enabled");
		return out;
	}
	const signal = deadline(opts.timeoutMs, opts.signal);
	let next = 0;
	const worker = async () => {
		while (next < unique.length && !signal.aborted) {
			const id = unique[next++];
			let reason = "not tried";
			for (const source of opts.sources) {
				if (signal.aborted) break;
				const got = await loadOne(id, source, opts, signal);
				if (typeof got !== "string") {
					out.posts.set(id, got);
					out.from.set(id, source);
					break;
				}
				reason = got;
			}
			if (!out.posts.has(id)) out.failed.set(id, signal.aborted ? "ran out of time" : reason);
		}
	};
	await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 10, unique.length) }, worker));
	for (const id of unique) if (!out.posts.has(id) && !out.failed.has(id)) out.failed.set(id, "ran out of time");
	return out;
}
