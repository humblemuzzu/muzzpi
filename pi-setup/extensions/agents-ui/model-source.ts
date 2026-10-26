/**
 * `/agents models`: whether the agents marked `followMain` in agent-models.json
 * run on their own model or on the main session's. The choice is a pref the
 * tools extension reads at every launch, so it applies to the next agent.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	followingAgents,
	loadAgentModels,
	readModelSource,
	writeModelSource,
	type AgentModels,
	type ModelSource,
	type SubAgent,
} from "../tools/lib/agent-models";
import { findWord, splitArgs, unknownWord, type Word } from "../tools/lib/command-args";
import { canShowMenu, menuAsText, showMenu, type MenuSpec } from "../tools/lib/command-menu";

const SOURCES: ReadonlyArray<Word & { name: ModelSource }> = [
	{ name: "list", aliases: ["own"], description: "each agent on its own model from agent-models.json" },
	{ name: "main", aliases: ["follow"], description: "the main session's model, whatever /model has it on" },
];

export const MODELS_WORD: Word = {
	name: "models",
	description: "run delegate, oracle and code_review on their own models or the main one",
	next: () => SOURCES.map((s) => ({ value: s.name, description: s.description })),
};

const USAGE = ["/agents models list   each agent on its own model", "/agents models main   the main session's model"];

function joinNames(agents: readonly string[]): string {
	return agents.length <= 1 ? (agents[0] ?? "") : `${agents.slice(0, -1).join(", ")} and ${agents.at(-1)}`;
}

function ownModels(config: AgentModels, agents: readonly SubAgent[]): string {
	const groups = new Map<string, SubAgent[]>();
	for (const agent of agents) {
		const preset = config.agents[agent]!;
		const label = [preset.model ?? "pi's default model", preset.thinking].filter(Boolean).join(" · ");
		groups.set(label, [...(groups.get(label) ?? []), agent]);
	}
	return [...groups].map(([label, names]) => `${names.join(", ")} → ${label}`).join("; ");
}

function mainName(ctx: ExtensionContext): string {
	return ctx.model ? ctx.model.id : "no model selected";
}

function menuSpec(ctx: ExtensionContext, config: AgentModels, agents: readonly SubAgent[], source: ModelSource): MenuSpec {
	const now = source === "main" ? `the main session's model (${mainName(ctx)} right now)` : "their own models";
	return {
		title: "Sub-agent models",
		status: [`${joinNames(agents)} run on ${now}. Every other agent keeps its own model.`],
		items: [
			{ id: "list", label: "Their own models", note: source === "list" ? "current" : undefined, description: `${ownModels(config, agents)}, from agent-models.json.` },
			{
				id: "main",
				label: "The main session's model",
				note: source === "main" ? "current" : undefined,
				description: "Follows /model at each launch. A resumed agent keeps the model it ran on; a local model is never followed.",
			},
		],
		initial: source,
	};
}

function apply(ctx: ExtensionContext, agents: readonly SubAgent[], next: ModelSource): void {
	try {
		writeModelSource(next);
	} catch (err) {
		ctx.ui.notify(`Could not save that: ${err instanceof Error ? err.message : String(err)}`, "error");
		return;
	}
	const where = next === "main" ? `the main session's model (${mainName(ctx)} right now)` : "their own models from agent-models.json";
	ctx.ui.notify(`${joinNames(agents)} now run on ${where}, from their next launch. Remembered across sessions.`, "info");
}

export async function runModelsCommand(rest: string, ctx: ExtensionContext, config: AgentModels = loadAgentModels()): Promise<void> {
	const agents = followingAgents(config);
	if (agents.length === 0) {
		ctx.ui.notify("No agent in agent-models.json has \"followMain\": true, so every agent runs on its own model.", "info");
		return;
	}
	const source = readModelSource();
	const { word } = splitArgs(rest);
	if (word) {
		const found = findWord(SOURCES, word);
		if (!found) return ctx.ui.notify(unknownWord("agents models", word, SOURCES), "error");
		return apply(ctx, agents, found.name);
	}
	const spec = menuSpec(ctx, config, agents, source);
	if (!canShowMenu(ctx)) return ctx.ui.notify(menuAsText(spec, USAGE), "info");
	const choice = await showMenu(ctx, spec);
	if (choice && choice.id !== source) apply(ctx, agents, choice.id as ModelSource);
}
