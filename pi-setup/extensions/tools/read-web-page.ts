/**
 * cheerio HTML→markdown + LLM Q&A + pagination + raw mode.
 *
 * cheerio strips chrome (nav, footer, scripts), finds main content area,
 * converts to clean markdown. ~95% size reduction on typical pages.
 *
 * the fetch is static: curl runs no JavaScript, so content a page builds in
 * the browser is absent, and every converted result says so. `screenshot`
 * with `url` renders the page instead.
 *
 * `prompt` and `objective` spawn a sub-agent that receives the page content;
 * `start_index`/`max_length` paginate by character; `raw` skips conversion.
 */

import { spawn } from "node:child_process";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { htmlToMarkdown } from "./lib/html-to-md";
import { emptyAgentModels, modelParams, resolveRoute, type AgentModels, type ModelRoute } from "./lib/agent-models";
import { runSubAgent, toolError } from "./lib/run-sub-agent";
import { clip, renderSubAgentResult } from "./lib/sub-agent-render";
import { headTailChars } from "./lib/output-buffer";
import { osc8Link } from "./lib/box-format";

const MAX_CHARS = 64_000;
const MAX_FETCH_BYTES = 10 * 1024 * 1024;
const CURL_TIMEOUT_SECS = 30;
const MAX_REDIRECTS = 5;

const DEFAULT_PROMPT_SYSTEM = `Analyze web page content and answer questions. Be concise, answer from provided content only. No filler.`;

/** the note every converted result carries: what a static fetch cannot contain. */
export function staticFetchNote(html: string): string {
	const scripts = (html.match(/<script\b/gi) ?? []).length;
	return scripts > 0
		? `[static fetch: ${scripts} <script> tag(s) were not run, so content they build is missing — screenshot with url renders the page]`
		: "[static fetch: the page has no <script> tags, so this is its full content]";
}

const STATUS_MARK = "__pi_http_status__";

/** splits curl's stderr into its error text and the final response's HTTP status (0 when none arrived). */
export function parseCurlStderr(stderr: string): { message: string; status: number } {
	const at = stderr.lastIndexOf(STATUS_MARK);
	if (at === -1) return { message: stderr.trim(), status: 0 };
	const status = Number.parseInt(stderr.slice(at + STATUS_MARK.length), 10);
	return { message: stderr.slice(0, at).trim(), status: Number.isFinite(status) ? status : 0 };
}

function fetchUrl(
	url: string,
	signal?: AbortSignal,
): Promise<{ html: string; status?: number; capped?: boolean; error?: string }> {
	return new Promise((resolve) => {
		const args = [
			"-sSL",
			"-w", `%{stderr}${STATUS_MARK}%{http_code}`,
			"-H", "Accept: text/markdown, text/html;q=0.9",
			"-m", String(CURL_TIMEOUT_SECS),
			"--max-redirs", String(MAX_REDIRECTS),
			"-A", "Mozilla/5.0 (compatible; pi-agent/1.0)",
			url,
		];

		const child = spawn("curl", args, {
			stdio: ["ignore", "pipe", "pipe"],
		});

		const chunks: Buffer[] = [];
		let bytes = 0;
		let capped = false;
		let stderr = "";
		let aborted = false;

		const onAbort = () => {
			aborted = true;
			if (!child.killed) child.kill("SIGTERM");
		};
		if (signal) {
			if (signal.aborted) { onAbort(); }
			else signal.addEventListener("abort", onAbort, { once: true });
		}

		child.stdout?.on("data", (data: Buffer) => {
			if (capped) return;
			chunks.push(data);
			bytes += data.length;
			if (bytes > MAX_FETCH_BYTES) {
				capped = true;
				child.kill("SIGTERM");
			}
		});

		child.stderr?.on("data", (data: Buffer) => {
			stderr += data.toString("utf-8");
		});

		child.on("error", (err) => {
			signal?.removeEventListener("abort", onAbort);
			resolve({ html: "", error: `curl error: ${err.message}` });
		});

		child.on("close", (code) => {
			signal?.removeEventListener("abort", onAbort);
			if (aborted) { resolve({ html: "", error: "fetch aborted" }); return; }
			const { message, status } = parseCurlStderr(stderr);
			if (code !== 0 && !capped) {
				resolve({ html: "", error: `fetch failed: ${message.replace(/^curl: /, "") || `curl exited with code ${code}`}` });
				return;
			}
			resolve({ html: Buffer.concat(chunks).subarray(0, MAX_FETCH_BYTES).toString("utf-8"), status, capped });
		});
	});
}

export interface ReadWebPageConfig {
	systemPrompt?: string;
	models?: AgentModels;
}

export function createReadWebPageTool(config: ReadWebPageConfig = {}): ToolDefinition {
	const models = config.models ?? emptyAgentModels();
	return {
		name: "read_web_page",
		label: "Read Web Page",
		description:
			"Read the contents of a web page at a given URL.\n\n" +
			"Returns the page content converted to Markdown.\n\n" +
			"When an objective is provided, a sub-agent returns verbatim excerpts relevant to that objective.\n\n" +
			"Static fetch: scripts are not run, so content a page builds with JavaScript is missing. " +
			"Use `screenshot` with `url` to see a rendered page.\n\n" +
			"Do NOT use for localhost or local URLs — use `curl` via Bash instead.",

		parameters: Type.Object({
			url: Type.String({
				description: "The URL of the web page to read.",
			}),
			objective: Type.Optional(
				Type.String({
					description:
						"A natural-language description of the research goal. " +
						"If set, a sub-agent returns only relevant verbatim excerpts. If not set, the full content is returned.",
				}),
			),
			prompt: Type.Optional(
				Type.String({
					description:
						"A question to answer about the page content. " +
						"Spawns an AI sub-agent that reads the page and returns a prose answer.",
				}),
			),
			start_index: Type.Optional(
				Type.Number({
					description: "Character offset to start from in the converted content (for pagination).",
				}),
			),
			max_length: Type.Optional(
				Type.Number({
					description: "Maximum number of characters to return (for pagination).",
				}),
			),
			raw: Type.Optional(
				Type.Boolean({
					description: "Return raw HTML instead of converting to Markdown.",
				}),
			),
			...modelParams(models, "read_web_page"),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const url = params.url;

			if (!url.startsWith("http://") && !url.startsWith("https://")) {
				return toolError(`invalid URL: "${url}" — must start with http:// or https://`);
			}

			let route: ModelRoute = {};
			if (params.prompt || params.objective) {
				const resolved = resolveRoute(models, "read_web_page", params, ctx.modelRegistry, false, ctx.model);
				if ("error" in resolved) return toolError(resolved.error);
				route = resolved;
			}

			const { html, status, capped, error } = await fetchUrl(url, signal);
			if (error) return toolError(error);
			if (status !== undefined && status >= 400) {
				const body = (htmlToMarkdown(html) ?? html).replace(/\s+/g, " ").trim();
				const excerpt = body ? `\n\nthe error page says: ${body.length > 400 ? `${body.slice(0, 400)}…` : body}` : "";
				return toolError(`HTTP ${status} from ${url} — the server did not return the page.${excerpt}`);
			}

			if (!html.trim()) {
				return {
					content: [{ type: "text" as const, text: "(empty response)" }],
				} as any;
			}

			// raw mode: skip conversion entirely
			if (params.raw) {
				const content = headTailChars(`Raw HTML content as requested:\n${html}`, MAX_CHARS).text;
				return { content: [{ type: "text" as const, text: content }] } as any;
			}

			const md = htmlToMarkdown(html);
			let content = md ?? html;

			// pagination: slice before truncation so offsets are stable
			if (params.start_index !== undefined || params.max_length !== undefined) {
				const total = content.length;
				const start = params.start_index ?? 0;
				const end = params.max_length !== undefined ? start + params.max_length : total;
				content = content.slice(start, end);
				content += `\n\n[${start}–${Math.min(end, total)} of ${total} characters]`;
			}

			content = headTailChars(content, MAX_CHARS).text;
			const notes = [staticFetchNote(html)];
			if (capped) notes.push(`[the response exceeded ${MAX_FETCH_BYTES / 1024 / 1024} MB; only the start was fetched]`);
			content += `\n\n${notes.join("\n")}`;

			if (params.prompt || params.objective) {
				const ask = params.prompt
					? `Answer this question: ${params.prompt}` +
						(params.objective ? `\n\nResearch goal behind it: ${params.objective}` : "")
					: `Quote, verbatim, every passage relevant to this goal: ${params.objective}\n\n` +
						"Quote only — no commentary. If nothing is relevant, say so.";
				return runSubAgent({
					agent: "read_web_page",
					label: params.prompt ?? params.objective,
					working: "(analyzing...)",
					ctx,
					signal,
					onUpdate,
					spawn: {
						task: `Here is the content of ${url}:\n\n${content}\n\n---\n\n${ask}`,
						model: route.model,
						thinkingLevel: route.thinking,
						builtinTools: ["read"],
						extensionTools: [],
						systemPromptBody: config.systemPrompt || DEFAULT_PROMPT_SYSTEM,
					},
				});
			}

			return { content: [{ type: "text" as const, text: content }] } as any;
		},

		renderCall(args: any, theme: any, context: any) {
			const text = context?.lastComponent ?? new Text("", 0, 0);
			const url = args.url || "...";
			const displayUrl = clip(url, 60);
			const linkedUrl = url.startsWith("http") ? osc8Link(url, displayUrl) : displayUrl;
			let label = theme.fg("toolTitle", theme.bold("read_web_page ")) + theme.fg("dim", linkedUrl);
			const promptLabel = args.prompt || args.objective;
			if (promptLabel) label += theme.fg("muted", ` — ${clip(promptLabel, 40)}`);
			text.setText(label);
			return text;
		},

		renderResult: renderSubAgentResult("read_web_page"),
	};
}
