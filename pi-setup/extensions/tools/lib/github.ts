/**
 * shared helpers for github tools.
 *
 * calls the GitHub REST API in-process with fetch, authenticated with the
 * token gh already holds (GH_TOKEN / GITHUB_TOKEN, else `gh auth token`).
 * all tools parse repository URLs in the format
 * "https://github.com/owner/repo" or shorthand "owner/repo".
 */

import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

export interface RepoRef {
	owner: string;
	repo: string;
}

/**
 * parse a repository URL or shorthand into owner/repo.
 * accepts:
 *   - https://github.com/owner/repo
 *   - github.com/owner/repo
 *   - owner/repo
 */
export function parseRepoUrl(input: string): RepoRef {
	const cleaned = input
		.replace(/^https?:\/\//, "")
		.replace(/^github\.com\//, "")
		.replace(/\.git$/, "")
		.replace(/\/$/, "");

	const parts = cleaned.split("/");
	if (parts.length < 2) {
		throw new Error(`invalid repository: "${input}" — expected "owner/repo" or full URL`);
	}
	return { owner: parts[0], repo: parts[1] };
}

/** build the "owner/repo" string for API paths. */
export function repoSlug(ref: RepoRef): string {
	return `${ref.owner}/${ref.repo}`;
}

const canonicalSlugs = new Map<string, string>();

/**
 * the repository's current "owner/repo". `repos/*` endpoints follow a rename,
 * but search's `repo:` qualifier does not: an old name finds nothing (code
 * search) or fails with HTTP 422 (commit search).
 */
export async function canonicalRepoSlug(ref: RepoRef, signal?: AbortSignal): Promise<string> {
	const slug = repoSlug(ref);
	const cached = canonicalSlugs.get(slug.toLowerCase());
	if (cached) return cached;
	let data: { full_name?: string };
	try {
		data = await githubApi<{ full_name?: string }>(`repos/${slug}`, { signal });
	} catch (e) {
		if (e instanceof GithubApiError && e.status === 404) {
			throw new Error(`repository ${slug} not found, or not visible to your gh login`);
		}
		throw e;
	}
	const canonical = data.full_name || slug;
	canonicalSlugs.set(slug.toLowerCase(), canonical);
	return canonical;
}

/** one line telling the model the name it used is outdated, or "" when it is current. */
export function renameNote(ref: RepoRef, canonical: string): string {
	const asked = repoSlug(ref);
	return asked.toLowerCase() === canonical.toLowerCase() ? "" : `(${asked} was renamed to ${canonical}; searched ${canonical})\n\n`;
}

// --- transport ---

const API_ROOT = "https://api.github.com/";
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_RATE_LIMIT_WAIT_MS = 60_000;
/** GitHub's documented wait for a secondary rate limit that names no retry time. */
const SECONDARY_LIMIT_WAIT_MS = 60_000;

export class GithubApiError extends Error {
	constructor(
		endpoint: string,
		readonly status: number,
		detail: string,
	) {
		super(`GitHub API ${endpoint} failed: HTTP ${status}${detail ? ` ${detail}` : ""}`);
	}
}

interface Token {
	value: string;
	fromGh: boolean;
}

let tokenPromise: Promise<Token> | undefined;

function readGhToken(): Promise<Token> {
	return new Promise((resolve, reject) => {
		execFile("gh", ["auth", "token"], { timeout: 10_000 }, (err, stdout, stderr) => {
			const value = stdout?.trim();
			if (err || !value) {
				const cause = stderr?.trim() || err?.message || "empty token";
				reject(new Error(`GitHub auth: \`gh auth token\` failed (${cause}). Run \`gh auth login\`, or set GH_TOKEN.`));
				return;
			}
			resolve({ value, fromGh: true });
		});
	});
}

/** gh's own precedence for github.com: GH_TOKEN, GITHUB_TOKEN, then its stored login. */
function getToken(): Promise<Token> {
	if (!tokenPromise) {
		const env = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
		tokenPromise = env ? Promise.resolve({ value: env, fromGh: false }) : readGhToken();
		tokenPromise.catch(() => {
			tokenPromise = undefined;
		});
	}
	return tokenPromise;
}

/** ms to wait before a rate-limited request may be retried, or undefined if it is not a rate limit. */
export function rateLimitWaitMs(status: number, headers: Headers, message: string, now = Date.now()): number | undefined {
	if (status !== 403 && status !== 429) return undefined;
	const retryAfter = headers.get("retry-after");
	if (retryAfter !== null && /^\d+$/.test(retryAfter)) return Number(retryAfter) * 1000;
	if (headers.get("x-ratelimit-remaining") === "0") {
		const reset = Number(headers.get("x-ratelimit-reset"));
		if (Number.isFinite(reset)) return Math.max(0, reset * 1000 - now);
	}
	return status === 429 || /rate limit/i.test(message) ? SECONDARY_LIMIT_WAIT_MS : undefined;
}

/** GitHub's JSON error message plus its `errors` details, or the status text for a non-JSON body. */
async function errorDetail(res: Response): Promise<string> {
	try {
		const body: any = await res.json();
		const extra = Array.isArray(body?.errors)
			? body.errors.map((e: any) => (typeof e === "string" ? e : e?.message)).filter(Boolean)
			: [];
		return [body?.message, ...extra].filter(Boolean).join(" — ");
	} catch {
		return res.statusText;
	}
}

/**
 * GET a GitHub REST endpoint and return parsed JSON.
 * one retry after a 401 from a gh token (gh may have refreshed it) and one
 * after a rate limit that resets within MAX_RATE_LIMIT_WAIT_MS.
 */
export async function githubApi<T = any>(
	endpoint: string,
	opts?: {
		params?: Record<string, string | number>;
		accept?: string;
		signal?: AbortSignal;
	},
): Promise<T> {
	const url = new URL(endpoint, API_ROOT);
	for (const [k, v] of Object.entries(opts?.params ?? {})) url.searchParams.set(k, String(v));

	const signal = opts?.signal;
	for (let attempt = 0; ; attempt++) {
		const token = await getToken();
		const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
		const failed = (e: any) => {
			if (signal?.aborted) return new Error(`GitHub API ${endpoint}: aborted`);
			if (timeout.aborted) return new Error(`GitHub API ${endpoint}: timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
			return new Error(`GitHub API ${endpoint}: ${e?.cause?.message ?? e?.message ?? e}`);
		};

		let res: Response;
		try {
			res = await fetch(url, {
				headers: {
					Accept: opts?.accept ?? "application/vnd.github+json",
					Authorization: `Bearer ${token.value}`,
					"User-Agent": "pi-github-tools",
					"X-GitHub-Api-Version": "2022-11-28",
				},
				signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
			});
		} catch (e) {
			throw failed(e);
		}

		if (res.ok) {
			let body: string;
			try {
				body = await res.text();
			} catch (e) {
				throw failed(e);
			}
			try {
				return JSON.parse(body) as T;
			} catch {
				throw new Error(`GitHub API ${endpoint}: invalid JSON response`);
			}
		}

		const detail = await errorDetail(res);

		if (attempt === 0 && res.status === 401 && token.fromGh) {
			tokenPromise = undefined;
			continue;
		}

		const wait = rateLimitWaitMs(res.status, res.headers, detail);
		if (wait === undefined) throw new GithubApiError(endpoint, res.status, detail);
		if (attempt > 0 || wait > MAX_RATE_LIMIT_WAIT_MS) {
			const resetAt = new Date(Date.now() + wait).toLocaleTimeString("en-US");
			throw new GithubApiError(endpoint, res.status, `rate limited until ${resetAt}: ${detail}`);
		}
		try {
			await sleep(wait, undefined, { signal });
		} catch (e) {
			throw failed(e);
		}
	}
}

/** decode base64 content from github contents API. */
export function decodeBase64Content(encoded: string): string {
	return Buffer.from(encoded.replace(/\n/g, ""), "base64").toString("utf-8");
}

/** add line numbers to file content. */
export function addLineNumbers(content: string, startLine = 1): string {
	return content
		.split("\n")
		.map((line, i) => `${startLine + i}: ${line}`)
		.join("\n");
}

/** truncate string to max length with indicator. */
export function truncate(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	return `${text.slice(0, maxLen)}\n... (truncated, ${text.length} total characters)`;
}
