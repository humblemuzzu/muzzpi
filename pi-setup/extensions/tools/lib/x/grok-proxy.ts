/**
 * Grok's X search through the Grok CLI's chat proxy (cli-chat-proxy.grok.com),
 * authenticated with the user's Grok CLI login. xAI documents this path for
 * auth.json tokens ("Using auth.json for API Access" in the Grok CLI docs):
 * POST /v1/responses with the `x_search` server tool. The proxy refuses a
 * request without `x-grok-client-version` (HTTP 426), so that header is
 * resolved here and re-learned from the 426 itself when the floor moves.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { abortError, clip, deadline, kindForStatus, networkError, ProviderError, retryAfterSec } from "../web/http";
import { grokHomeDir, type TokenSource } from "./grok-login";

export type { TokenSource } from "./grok-login";

export const GROK_PROXY_URL = "https://cli-chat-proxy.grok.com/v1";

export interface XSearchToolConfig {
	type: "x_search";
	allowed_x_handles?: string[];
	excluded_x_handles?: string[];
	from_date?: string;
	to_date?: string;
}

export interface ProxyRequest {
	model: string;
	effort: string;
	/**
	 * the whole prompt, sent as one user message. Rules sent as `instructions`
	 * made Grok skip the X tool and answer from memory in 2 of 4 live runs;
	 * the same rules in the user message ran the tool 4 of 4.
	 */
	input: string;
	tool: XSearchToolConfig;
	timeoutMs: number;
	signal?: AbortSignal;
}

export interface ProxyUsage {
	inputTokens?: number;
	outputTokens?: number;
	postsFetched?: number;
	usersFetched?: number;
	costTicks?: number;
}

export interface ProxyResult {
	text: string;
	calls: { name: string; input: string }[];
	/** ids of every post and user the X tool returned, from the server's own citations — the ground truth. */
	sourcePostIds: Set<string>;
	sourceUserIds: Set<string>;
	usage: ProxyUsage;
	tokenSource: string;
	clientVersion: string;
	requestId?: string;
	incomplete?: string;
}

const VERSION_FLOOR = /version\s+(\d+(?:\.\d+){1,3})\s+or later/i;

function compareVersions(a: string, b: string): number {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (d) return d;
	}
	return 0;
}

const isVersion = (v: unknown): v is string => typeof v === "string" && /^\d+(\.\d+){1,3}$/.test(v);

/**
 * The newest of: the floor a 426 taught us (cached on disk so sub-agents start
 * with it), the installed Grok CLI's version (it auto-updates), the configured
 * fallback.
 */
export class ClientVersion {
	constructor(
		private readonly cacheFile: string,
		private readonly fallback: string,
		private readonly grokHome = grokHomeDir(),
	) {}

	current(): string {
		const candidates = [this.fallback, this.readField(path.join(this.grokHome, "version.json"), "version"), this.readField(this.cacheFile, "clientVersion")];
		return candidates.filter(isVersion).reduce((best, v) => (compareVersions(v, best) > 0 ? v : best), this.fallback);
	}

	learn(version: string): void {
		try {
			fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
			const tmp = `${this.cacheFile}.${process.pid}.tmp`;
			fs.writeFileSync(tmp, JSON.stringify({ clientVersion: version, learnedAt: new Date().toISOString() }));
			fs.renameSync(tmp, this.cacheFile);
		} catch {}
	}

	private readField(file: string, field: string): string | undefined {
		try {
			const value = JSON.parse(fs.readFileSync(file, "utf-8"))?.[field];
			return isVersion(value) ? value : undefined;
		} catch {
			return undefined;
		}
	}
}

/** seconds until a JWT expires; undefined when the token is not a JWT or carries no exp. */
export function jwtSecondsLeft(token: string, now = Date.now()): number | undefined {
	const payload = token.split(".")[1];
	if (!payload) return undefined;
	try {
		const exp = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8"))?.exp;
		return typeof exp === "number" ? exp - now / 1000 : undefined;
	} catch {
		return undefined;
	}
}

interface StreamOutcome {
	text: string;
	response?: Record<string, any>;
	/** why the answer stopped early, when the server marked it incomplete. */
	incomplete?: string;
}

async function readEventStream(body: ReadableStream<Uint8Array>): Promise<StreamOutcome> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let text = "";
	let response: Record<string, any> | undefined;
	let incomplete: string | undefined;

	const handle = (block: string) => {
		const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
		if (!data || data === "[DONE]") return;
		let event: any;
		try {
			event = JSON.parse(data);
		} catch {
			return;
		}
		if (event.type === "response.output_text.delta" && typeof event.delta === "string") text += event.delta;
		else if (event.type === "response.completed") response = event.response;
		else if (event.type === "response.incomplete") {
			response = event.response;
			incomplete = String(event.response?.incomplete_details?.reason ?? "no reason given");
		} else if (event.type === "response.failed" || event.type === "error") {
			const message = event.response?.error?.message ?? event.error?.message ?? event.message ?? JSON.stringify(event).slice(0, 300);
			throw new ProviderError("unavailable", `Grok failed mid-answer: ${message}`);
		}
	};

	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n");
			let cut: number;
			while ((cut = buffer.indexOf("\n\n")) !== -1) {
				handle(buffer.slice(0, cut));
				buffer = buffer.slice(cut + 2);
			}
		}
		buffer = (buffer + decoder.decode()).replace(/\r\n?/g, "\n");
		if (buffer.trim()) handle(buffer);
	} finally {
		reader.cancel().catch(() => {});
	}
	return { text, response, incomplete };
}

function collectSources(response: Record<string, any> | undefined): { posts: Set<string>; users: Set<string> } {
	const posts = new Set<string>();
	const users = new Set<string>();
	for (const item of response?.output ?? []) {
		if (item?.type !== "message") continue;
		for (const part of item.content ?? []) {
			for (const ann of part?.annotations ?? []) {
				const url = String(ann?.url ?? "");
				const post = url.match(/\/status\/(\d+)/);
				const user = url.match(/\/i\/user\/(\d+)/);
				if (post) posts.add(post[1]);
				else if (user) users.add(user[1]);
			}
		}
	}
	return { posts, users };
}

function proxyError(status: number, headers: Headers, text: string): ProviderError {
	let message = text;
	try {
		const parsed = JSON.parse(text);
		message = typeof parsed?.error === "string" ? parsed.error : (parsed?.error?.message ?? parsed?.message ?? text);
	} catch {}
	return new ProviderError(kindForStatus(status), clip(message, 300), status, retryAfterSec(headers));
}

export interface ProxyDeps {
	baseUrl: string;
	tokens: TokenSource[];
	version: ClientVersion;
}

/**
 * One X search. Recovers on its own from the three failures that have a known
 * fix: a rejected token (renew it once, then try the next login), an outdated
 * client version (retry with the floor the 426 names), and a single 5xx.
 */
export async function callGrokProxy(req: ProxyRequest, deps: ProxyDeps): Promise<ProxyResult> {
	const body = {
		model: req.model,
		input: [{ role: "user", content: req.input }],
		tools: [req.tool],
		stream: true,
		store: false,
		reasoning: { effort: req.effort },
	};
	const signal = deadline(req.timeoutMs, req.signal);
	/** a token renewal runs the Grok CLI for up to a minute; an abort or the deadline must not wait for it. */
	const untilAborted = <T>(work: Promise<T>): Promise<T> =>
		new Promise<T>((resolve, reject) => {
			const stop = () => reject(abortError(req.signal, req.timeoutMs, "X search"));
			if (signal.aborted) return stop();
			signal.addEventListener("abort", stop, { once: true });
			work.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
		});
	const tried: string[] = [];
	let version = deps.version.current();
	let retriedVersion = false;
	let retried5xx = false;
	let renewed: string | undefined;
	let renewedSource = -1;

	for (let t = 0; t < deps.tokens.length; ) {
		const source = deps.tokens[t];
		const token = renewedSource === t && renewed ? renewed : await untilAborted(source.get());
		if (!token || (jwtSecondsLeft(token) ?? Number.POSITIVE_INFINITY) < 30) {
			tried.push(`${source.label}: no valid token`);
			t++;
			continue;
		}

		let res: Response;
		try {
			res = await fetch(`${deps.baseUrl}/responses`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "text/event-stream",
					Authorization: `Bearer ${token}`,
					"X-XAI-Token-Auth": "xai-grok-cli",
					"x-grok-model-override": req.model,
					"x-grok-client-version": version,
					"User-Agent": "muzzpi-x-search",
				},
				body: JSON.stringify(body),
				signal,
			});
		} catch (err) {
			if (signal.aborted) throw abortError(req.signal, req.timeoutMs, "X search");
			throw networkError(err, "cli-chat-proxy.grok.com");
		}

		if (res.status === 200 && res.body) {
			let outcome: StreamOutcome;
			try {
				outcome = await readEventStream(res.body);
			} catch (err) {
				if (signal.aborted) throw abortError(req.signal, req.timeoutMs, "X search");
				throw err instanceof ProviderError ? err : networkError(err, "cli-chat-proxy.grok.com");
			}
			if (!outcome.response) throw new ProviderError("invalid_response", "Grok's stream ended without a completed response");
			const usage = outcome.response.usage ?? {};
			const tools = usage.server_side_tool_usage_details ?? {};
			const sources = collectSources(outcome.response);
			return {
				text: outcome.text,
				calls: (outcome.response.output ?? [])
					.filter((o: any) => o?.type === "custom_tool_call")
					.map((o: any) => ({ name: String(o.name), input: String(o.input ?? "") })),
				sourcePostIds: sources.posts,
				sourceUserIds: sources.users,
				usage: {
					inputTokens: usage.input_tokens,
					outputTokens: usage.output_tokens,
					postsFetched: tools.x_posts_fetched,
					usersFetched: tools.x_users_fetched,
					costTicks: usage.cost_in_usd_ticks,
				},
				tokenSource: source.label,
				clientVersion: version,
				requestId: res.headers.get("x-request-id") ?? undefined,
				incomplete: outcome.incomplete,
			};
		}

		const text = await res.text().catch(() => "");
		if (res.status === 426 && !retriedVersion) {
			const floor = text.match(VERSION_FLOOR)?.[1];
			if (floor && compareVersions(floor, version) > 0) {
				retriedVersion = true;
				version = floor;
				deps.version.learn(floor);
				continue;
			}
			throw new ProviderError(
				"bad_request",
				`the proxy refused client version ${version}: ${clip(text, 200)} — update Grok (\`grok update\`) or set clientVersion under "x-search" in ext-config.json`,
				426,
			);
		}
		if (res.status === 401 || res.status === 403) {
			if (renewedSource !== t && source.refresh) {
				renewedSource = t;
				renewed = await untilAborted(source.refresh(token));
				if (renewed) continue;
			}
			tried.push(`${source.label}: HTTP ${res.status} ${clip(text, 120)}`);
			t++;
			continue;
		}
		if (res.status >= 500 && !retried5xx) {
			retried5xx = true;
			await new Promise((r) => setTimeout(r, 1000));
			continue;
		}
		throw proxyError(res.status, res.headers, text);
	}

	throw new ProviderError(
		"auth",
		`no Grok login was accepted (${tried.join("; ")}). Run \`grok login\` in a shell.`,
	);
}
