/**
 * one JSON POST to a search provider, and the failure taxonomy every provider
 * maps its errors onto. The kind decides what the fallback chain does next.
 */

export type FailureKind =
	| "missing_key"
	| "auth"
	| "credits"
	| "rate_limit"
	| "bad_request"
	| "timeout"
	| "unavailable"
	| "network"
	| "invalid_response"
	| "aborted";

export class ProviderError extends Error {
	constructor(
		readonly kind: FailureKind,
		message: string,
		readonly status?: number,
		readonly retryAfterSec?: number,
	) {
		super(message);
		this.name = "ProviderError";
	}
}

export interface HttpResponse {
	status: number;
	headers: Headers;
	text: string;
}

export interface PostOptions {
	headers: Record<string, string>;
	body: unknown;
	timeoutMs: number;
	signal?: AbortSignal;
}

/** the deadline and the caller's abort as one signal, plus a way to tell them apart afterwards. */
export function deadline(timeoutMs: number, signal?: AbortSignal): AbortSignal {
	const timer = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timer]) : timer;
}

export function abortError(signal: AbortSignal | undefined, timeoutMs: number, what: string): ProviderError {
	return signal?.aborted
		? new ProviderError("aborted", `${what} aborted`)
		: new ProviderError("timeout", `${what} gave no answer within ${Math.round(timeoutMs / 1000)}s`);
}

export function networkError(err: unknown, what: string): ProviderError {
	const cause = (err as { cause?: { code?: string; message?: string } })?.cause;
	const detail = cause?.code ?? cause?.message ?? (err as Error)?.message ?? String(err);
	return new ProviderError("network", `${what} unreachable: ${detail}`);
}

export async function postJson(url: string, opts: PostOptions): Promise<HttpResponse> {
	const what = new URL(url).host;
	const signal = deadline(opts.timeoutMs, opts.signal);
	try {
		const res = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json", ...opts.headers },
			body: JSON.stringify(opts.body),
			signal,
		});
		return { status: res.status, headers: res.headers, text: await res.text() };
	} catch (err) {
		if (signal.aborted) throw abortError(opts.signal, opts.timeoutMs, what);
		throw networkError(err, what);
	}
}

export function kindForStatus(status: number): FailureKind {
	if (status === 401 || status === 403) return "auth";
	if (status === 402) return "credits";
	if (status === 429) return "rate_limit";
	if (status === 408 || status === 504) return "timeout";
	if (status >= 500) return "unavailable";
	return "bad_request";
}

export function retryAfterSec(headers: Headers): number | undefined {
	const raw = headers.get("retry-after");
	if (!raw) return undefined;
	const secs = Number(raw);
	if (Number.isFinite(secs)) return Math.max(0, secs);
	const at = Date.parse(raw);
	return Number.isNaN(at) ? undefined : Math.max(0, Math.round((at - Date.now()) / 1000));
}

export function parseJson<T>(res: HttpResponse, what: string): T {
	try {
		return JSON.parse(res.text) as T;
	} catch {
		throw new ProviderError("invalid_response", `${what} returned non-JSON (HTTP ${res.status}): ${clip(res.text, 200)}`, res.status);
	}
}

export function clip(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** cut at a word boundary when one is near, so a clipped query never ends mid-word. */
export function clipWords(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	if (flat.length <= max) return flat;
	const cut = flat.slice(0, max);
	const space = cut.lastIndexOf(" ");
	return (space > max * 0.6 ? cut.slice(0, space) : cut).trim();
}
