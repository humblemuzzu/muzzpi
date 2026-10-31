import type { RunStatus } from "./agent-channel";
import type { UsageStats } from "./pi-spawn";

type StatusColor = "success" | "error" | "warning" | "muted";

export const STATUS_STYLE: Record<RunStatus, { icon: string; color: StatusColor; verb: string }> = {
	queued: { icon: "◌", color: "muted", verb: "queued" },
	running: { icon: "◐", color: "warning", verb: "working" },
	done: { icon: "✓", color: "success", verb: "finished" },
	failed: { icon: "✕", color: "error", verb: "failed" },
	stopped: { icon: "■", color: "warning", verb: "stopped" },
	interrupted: { icon: "↯", color: "warning", verb: "interrupted" },
};

const IDENTITY: Record<string, string> = {
	delegate: "accent",
	chad: "syntaxVariable",
	oracle: "thinkingHigh",
	finder: "mdLink",
	librarian: "syntaxNumber",
	review_code: "mdQuote",
};
const FALLBACK_IDENTITY = ["accent", "syntaxVariable", "thinkingHigh", "mdLink", "syntaxNumber", "mdQuote", "borderAccent", "customMessageLabel"];

/** An agent's colour is its identity; the status colours stay success / error / warning. */
export function identityColor(agent: string): string {
	const known = IDENTITY[agent];
	if (known) return known;
	let hash = 0;
	for (const ch of agent) hash = (hash * 31 + ch.codePointAt(0)!) >>> 0;
	return FALLBACK_IDENTITY[hash % FALLBACK_IDENTITY.length]!;
}

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

export function formatCost(cost: number): string {
	return cost >= 0.01 ? `$${cost.toFixed(2)}` : `$${cost.toFixed(4)}`;
}

/** Tokens a run processed freshly or produced; re-reading its cache is not work. */
export function freshTokens(usage: Pick<UsageStats, "input" | "output" | "cacheWrite">): number {
	return usage.input + usage.output + usage.cacheWrite;
}

export function shortModel(model: string | undefined): string {
	return model?.split("/").at(-1) ?? "";
}

/** The first line worth showing of a markdown answer, with its markup removed. */
export function firstAnswerLine(text: string): string {
	for (const raw of text.split("\n")) {
		const line = raw.replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+\.\s+)/, "").replace(/\*\*|__|`/g, "").trim();
		if (line) return line;
	}
	return "";
}
