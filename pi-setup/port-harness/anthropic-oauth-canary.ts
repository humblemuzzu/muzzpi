#!/usr/bin/env bun
/**
 *   bun pi-setup/port-harness/anthropic-oauth-canary.ts
 *
 * Four tiny Haiku requests, a few more to find a tool name Anthropic flags;
 * never prints the token. Exit 0 = fine, 1 = act, 2 = no Claude login.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { piDocs } from "../extensions/system-prompt";
import { ANTHROPIC_TRIGGER_PHRASES, isAnthropicRejection, PAYLOAD_LOG_ENV } from "../extensions/tools/lib/anthropic-sub";

const MODEL = "claude-haiku-5-5";
const API = "https://api.anthropic.com/v1/messages?beta=true";
const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const PROMPT = "Reply with the single word OK";
const FALLBACK_TOOLS = ["screenshot", "find", "read_github"];
/** a name check splits the list in halves; this bounds the requests one run spends on it */
const MAX_BISECT_REQUESTS = 24;

type Outcome = "plan" | "refused" | "rejected" | "error";

interface Check {
	name: string;
	expected: Outcome;
	got: Outcome;
	detail: string;
	/** a mismatch here means pi is broken; a mismatch on a control is information */
	critical: boolean;
}

function bearerToken(): string {
	const result = spawnSync("pi", ["auth", "print-bearer-token", "--provider", "anthropic"], {
		encoding: "utf-8",
		timeout: 60_000,
	});
	const token = (result.stdout ?? "").trim();
	if (result.status !== 0 || !token.startsWith("sk-ant-oat")) {
		console.error("No Claude-plan login found. Start pi and run /login anthropic, then try again.");
		process.exit(2);
	}
	return token;
}

function tool(name: string) {
	return {
		name,
		description: `The ${name} tool.`,
		input_schema: { type: "object", properties: { target: { type: "string" } } },
	};
}

function unscrub(text: string): string {
	let out = text;
	for (const [phrase, replacement] of ANTHROPIC_TRIGGER_PHRASES) out = out.replaceAll(replacement, phrase);
	return out;
}

async function direct(token: string, system: string[], tools: string[]): Promise<{ got: Outcome; detail: string }> {
	try {
		const res = await fetch(API, {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"anthropic-version": "2023-06-01",
				"anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
				"anthropic-dangerous-direct-browser-access": "true",
				"content-type": "application/json",
				accept: "application/json",
				"user-agent": "claude-cli/2.1.280",
				"x-app": "cli",
			},
			body: JSON.stringify({
				model: MODEL,
				max_tokens: 8,
				system: system.map((text) => ({ type: "text", text })),
				messages: [{ role: "user", content: PROMPT }],
				...(tools.length > 0 ? { tools: tools.map(tool) } : {}),
			}),
		});
		const body = await res.text();
		const claim = res.headers.get("anthropic-ratelimit-unified-representative-claim");
		const used = res.headers.get("anthropic-ratelimit-unified-5h-utilization");
		if (res.ok && claim) return { got: "plan", detail: `HTTP 200, billed to plan (${claim}, 5h used ${used})` };
		if (isAnthropicRejection(body)) return { got: "refused", detail: `HTTP ${res.status}, "out of extra usage"` };
		if (res.status === 429 && !claim) return { got: "rejected", detail: "HTTP 429 with no plan headers" };
		return { got: "error", detail: `HTTP ${res.status}: ${body.slice(0, 160)}` };
	} catch (error) {
		return { got: "error", detail: error instanceof Error ? error.message : String(error) };
	}
}

/** the tool names of the last request in an anthropic-sub payload log, as they went over the wire */
function sentToolNames(logFile: string): string[] | undefined {
	let text: string;
	try {
		text = readFileSync(logFile, "utf-8");
	} catch {
		return undefined;
	}
	for (const record of text.split("\n---\n").reverse()) {
		const json = record.split("\n").slice(1).join("\n").trim();
		if (!json) continue;
		try {
			const tools = JSON.parse(json)?.payload?.tools;
			if (Array.isArray(tools) && tools.length > 0) return tools.map((t: { name: string }) => t.name);
		} catch {}
	}
	return undefined;
}

function realPipeline(logFile: string): { got: Outcome; detail: string } {
	const result = spawnSync("pi", ["-p", "--no-session", "--model", `anthropic/${MODEL}`, PROMPT], {
		cwd: process.cwd(),
		encoding: "utf-8",
		timeout: 240_000,
		env: { ...process.env, [PAYLOAD_LOG_ENV]: logFile },
	});
	const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
	if (isAnthropicRejection(output)) return { got: "refused", detail: 'pi -p got "out of extra usage"' };
	if (result.status === 0 && /\bOK\b/i.test(result.stdout ?? "")) return { got: "plan", detail: "pi -p answered" };
	return { got: "error", detail: `pi -p exit ${result.status}: ${output.trim().slice(0, 160)}` };
}

/** the names that are refused on their own; both halves are searched, since more than one may be flagged */
async function flaggedNames(token: string, system: string[], names: string[], budget: { left: number }): Promise<string[] | undefined> {
	if (budget.left-- <= 0) return undefined;
	const { got } = await direct(token, system, names);
	if (got === "plan") return [];
	if (got !== "refused") return undefined;
	if (names.length === 1) return names;
	const half = Math.ceil(names.length / 2);
	const left = await flaggedNames(token, system, names.slice(0, half), budget);
	const right = await flaggedNames(token, system, names.slice(half), budget);
	return left && right ? [...left, ...right] : undefined;
}

const token = bearerToken();
const docs = piDocs("/pi");
const cleanSystem = [IDENTITY, `You are a coding agent running in pi.\n\n${docs}`];
const checks: Check[] = [];

const payloadLog = join(mkdtempSync(join(tmpdir(), "oauth-canary-")), "payload.log");
checks.push({ name: "real pi, your full setup", expected: "plan", critical: true, ...realPipeline(payloadLog) });
const sent = sentToolNames(payloadLog);
const toolNames = sent ?? FALLBACK_TOOLS;
checks.push({
	name: `clean prompt, ${sent ? `the ${toolNames.length} tool names pi sent` : "3 sample tool names"}`,
	expected: "plan",
	critical: true,
	...(await direct(token, cleanSystem, toolNames)),
});
checks.push({
	name: "control: raw pi docs wording",
	expected: "refused",
	critical: false,
	...(await direct(token, [IDENTITY, `You are a coding agent running in pi.\n\n${unscrub(docs)}`], ["screenshot"])),
});
checks.push({
	name: "control: no Claude Code identity line",
	expected: "rejected",
	critical: false,
	...(await direct(token, ["You are a coding agent running in pi."], [])),
});

for (const check of checks) {
	const mark = check.got === check.expected ? "ok  " : check.critical ? "FAIL" : "info";
	console.log(`${mark}  ${check.name.padEnd(40)} expected ${check.expected.padEnd(8)} got ${check.got.padEnd(8)} ${check.detail}`);
}

const [real, clean, rawDocs, noIdentity] = checks as [Check, Check, Check, Check];
console.log("");
if (real.got === "plan" && clean.got === "plan") {
	console.log("All good: pi's Claude-plan requests are billed to your plan.");
	if (rawDocs.got === "plan") console.log("Note: the raw pi docs wording passes now, so Anthropic's check got looser. Nothing to do.");
	if (noIdentity.got === "plan") console.log("Note: the identity line is no longer required. Nothing to do.");
	process.exit(0);
}
if (!sent) console.log("Could not read the tool names pi sent, so the clean request used 3 sample names.");
if (clean.got === "refused") {
	const flagged = await flaggedNames(token, cleanSystem, toolNames, { left: MAX_BISECT_REQUESTS });
	const sample = await direct(token, cleanSystem, FALLBACK_TOOLS);
	if (flagged && flagged.length > 0) {
		console.log(`Anthropic bills these tool names as extra usage: ${flagged.join(", ")}.`);
		console.log("Rename each tool (and every prompt and mention that names it), as code_review became review_code.");
	} else if (sample.got === "plan") {
		console.log("No single tool name is refused on its own, but the full list is: rename recently added tools one at a time and re-run.");
	} else {
		console.log("Anthropic changed its check: even a clean request is not billed to the plan.");
		console.log("Use DeepSeek for now (/model). The fallback is reinstalling pi-claude-code-use: see pi-setup/pi-migrations.md.");
	}
} else if (clean.got !== "plan") {
	console.log("Anthropic changed its check: even a clean request is not billed to the plan.");
	console.log("Use DeepSeek for now (/model). The fallback is reinstalling pi-claude-code-use: see pi-setup/pi-migrations.md.");
} else {
	console.log("A clean request passes but real pi does not: something in pi's own prompt trips the check.");
	console.log("Use DeepSeek (/model) and ask it to compare the prompt with ANTHROPIC_TRIGGER_PHRASES in tools/lib/anthropic-sub.ts.");
}
process.exit(1);
