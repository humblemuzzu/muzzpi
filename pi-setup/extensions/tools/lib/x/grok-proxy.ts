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
	/** the model that answered: the configured one, or the replacement chosen when the proxy no longer serves it. */
	model: string;
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

const VERSION = /\b\d+(?:\.\d+){1,3}\b/g;
const MAX_WAIT_429_MS = 10_000;

/** the version a 426 asks for: the newest version it names that is newer than the one refused, whatever the wording. */
export function versionFloor(body: string, refused: string): string | undefined {
	const named = (body.match(VERSION) ?? []).filter((v) => compareVersions(v, refused) > 0);
	return named.reduce<string | undefined>((best, v) => (!best || compareVersions(v, best) > 0 ? v : best), undefined);
}

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
 * fallback. The same file remembers the model that replaced a retired one.
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
		this.write({ clientVersion: version, learnedAt: new Date().toISOString() });
	}

	/** the model to send instead of `configured`, once the proxy has said it no longer serves it. */
	modelFor(configured: string): string {
		const replaced = this.read()?.modelReplacement;
		return replaced?.configured === configured && typeof replaced.use === "string" && replaced.use ? replaced.use : configured;
	}

	learnModel(configured: string, use: string): void {
		this.write({ modelReplacement: { configured, use, learnedAt: new Date().toISOString() } });
	}

	private read(file = this.cacheFile): Record<string, any> | undefined {
		try {
			const value = JSON.parse(fs.readFileSync(file, "utf-8"));
			return value && typeof value === "object" ? value : undefined;
		} catch {
			return undefined;
		}
	}

	private write(fields: Record<string, unknown>): void {
		try {
			fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
			const tmp = `${this.cacheFile}.${process.pid}.tmp`;
			fs.writeFileSync(tmp, JSON.stringify({ ...this.read(), ...fields }));
			fs.renameSync(tmp, this.cacheFile);
		} catch {}
	}

	private readField(file: string, field: string): string | undefined {
		const value = this.read(file)?.[field];
		return isVersion(value) ? value : undefined;
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

const HOST = "cli-chat-proxy.grok.com";

function proxyHeaders(token: string, version: string, model?: string): Record<string, string> {
	return {
		Authorization: `Bearer ${token}`,
		"X-XAI-Token-Auth": "xai-grok-cli",
		"x-grok-client-version": version,
		...(model && { "x-grok-model-override": model }),
		"User-Agent": "muzzpi-x-search",
	};
}

/** a model the proxy still serves, to replace one it no longer does: the newest listed one that is not a pricier "fast" variant. */
async function replacementModel(baseUrl: string, token: string, version: string, gone: string, signal: AbortSignal): Promise<string | undefined> {
	try {
		const res = await fetch(`${baseUrl}/models`, { headers: { Accept: "application/json", ...proxyHeaders(token, version) }, signal });
		if (!res.ok) return undefined;
		const listed: any[] = (await res.json())?.data ?? [];
		const usable = listed.filter(
			(m) => typeof m?.id === "string" && m.id !== gone && !m.hidden && m.supports_backend_search !== false && m.supported_in_api !== false,
		);
		return (usable.find((m) => !/fast/i.test(m.id)) ?? usable[0])?.id;
	} catch {
		return undefined;
	}
}

const MODEL_GONE = /does not exist|not found|deprecat|retired|unknown model|no longer/i;

/**
 * One X search. Recovers on its own from every failure that has a known fix,
 * each at most once: a rejected token (renew it, then try the next login), an
 * outdated client version (the floor the 426 names), a retired model (one the
 * proxy lists instead, remembered), a reasoning effort the model refuses (sent
 * without one), a 429 (after Retry-After, up to 10s), a 5xx or a failure
 * mid-answer, and a dropped connection.
 */
export async function callGrokProxy(req: ProxyRequest, deps: ProxyDeps): Promise<ProxyResult> {
	let model = deps.version.modelFor(req.model);
	let effort: string | undefined = req.effort;
	const body = () => ({
		model,
		input: [{ role: "user", content: req.input }],
		tools: [req.tool],
		stream: true,
		store: false,
		...(effort && { reasoning: { effort } }),
	});
	const signal = deadline(req.timeoutMs, req.signal);
	/** a token renewal runs the Grok CLI for up to a minute; an abort or the deadline must not wait for it. */
	const untilAborted = <T>(work: Promise<T>): Promise<T> =>
		new Promise<T>((resolve, reject) => {
			const stop = () => reject(abortError(req.signal, req.timeoutMs, "X search"));
			if (signal.aborted) return stop();
			signal.addEventListener("abort", stop, { once: true });
			work.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
		});
	const aborted = () => abortError(req.signal, req.timeoutMs, "X search");
	const pause = (ms: number) => untilAborted(new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const retried = new Set<string>();
	const firstTime = (what: string) => !retried.has(what) && Boolean(retried.add(what));
	const tried: string[] = [];
	let version = deps.version.current();
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
				headers: { "Content-Type": "application/json", Accept: "text/event-stream", ...proxyHeaders(token, version, model) },
				body: JSON.stringify(body()),
				signal,
			});
		} catch (err) {
			if (signal.aborted) throw aborted();
			if (firstTime("network")) {
				await pause(1000);
				continue;
			}
			throw networkError(err, HOST);
		}

		if (res.status === 200 && res.body) {
			let outcome: StreamOutcome;
			try {
				outcome = await readEventStream(res.body);
				if (!outcome.response) throw new ProviderError("invalid_response", "Grok's stream ended without a completed response");
			} catch (err) {
				if (signal.aborted) throw aborted();
				if (firstTime("server")) {
					await pause(1000);
					continue;
				}
				throw err instanceof ProviderError ? err : networkError(err, HOST);
			}
			if (!outcome.response) throw new ProviderError("invalid_response", "Grok's stream ended without a completed response");
			const usage = outcome.response.usage ?? {};
			const tools = usage.server_side_tool_usage_details ?? {};
			const sources = collectSources(outcome.response);
			return {
				text: outcome.text,
				model,
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
		if (res.status === 426) {
			const floor = versionFloor(text, version);
			if (floor && firstTime("version")) {
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
		if (res.status === 400 && effort && /reasoning|effort/i.test(text) && firstTime("effort")) {
			effort = undefined;
			continue;
		}
		if ((res.status === 404 || res.status === 400) && /model/i.test(text) && MODEL_GONE.test(text) && firstTime("model")) {
			const replacement = await untilAborted(replacementModel(deps.baseUrl, token, version, model, signal));
			if (replacement) {
				deps.version.learnModel(req.model, replacement);
				model = replacement;
				continue;
			}
		}
		if (res.status === 429 && firstTime("rate")) {
			await pause(Math.min((retryAfterSec(res.headers) ?? 2) * 1000, MAX_WAIT_429_MS));
			continue;
		}
		if (res.status >= 500 && firstTime("server")) {
			await pause(1000);
			continue;
		}
		throw proxyError(res.status, res.headers, text);
	}

	throw new ProviderError(
		"auth",
		`no Grok login was accepted (${tried.join("; ")}). Run \`grok login\` in a shell.`,
	);
}
