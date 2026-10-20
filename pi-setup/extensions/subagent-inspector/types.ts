/**
 * shared types for the sub-agent inspector.
 *
 * kept dependency-free (type-only imports) so the pure modules —
 * registry.ts and transcript.ts — stay unit-testable without a TUI.
 */

import type { Message } from "@mariozechner/pi-ai";

export type AgentStatus = "running" | "done" | "error";

export interface AgentUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens?: number;
	turns?: number;
}

/**
 * one sub-agent run, as observed from the parent session.
 *
 * `messages` is the child's FULL transcript — including thinking blocks,
 * which the collapsed tool tree deliberately drops, as the tools
 * extension's run broadcast carries it.
 */
export interface AgentEntry {
	toolCallId: string;
	toolName: string;
	/** short human label derived from the tool's arguments */
	label: string;
	status: AgentStatus;
	startedAt: number;
	endedAt?: number;
	messages: Message[];
	model?: string;
	thinkingLevel?: string;
	stopReason?: string;
	errorMessage?: string;
	usage?: AgentUsage;
}
