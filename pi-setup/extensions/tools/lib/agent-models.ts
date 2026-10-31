/**
 * which model each sub-agent runs on, read from ~/.pi/agent/agent-models.json.
 *
 * the file names a short list of models and a default model + thinking level
 * per agent. every sub-agent tool exposes optional `model` / `thinking`
 * parameters whose values come from that list, so the parent passes a name
 * and never has to search the catalog.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Type } from "@sinclair/typebox";
import { isLocalProvider } from "./local-providers";
import { prefsFile, readPrefs, writePrefs } from "./prefs";

export const AGENT_MODELS_FILE = path.join(os.homedir(), ".pi", "agent", "agent-models.json");

/** the `id` that stands for the model the main session is on when the agent starts */
export const MAIN_MODEL_ID = "$main";

/**
 * Where agents marked `followMain` get their default: `list` is their own preset,
 * `main` the main session's model. Read on every launch, so a change applies to
 * the next agent without touching the prompt or the tool schemas.
 */
export type ModelSource = "list" | "main";

const SOURCE_PREFS = "agent-models";

export function readModelSource(file: string = prefsFile(SOURCE_PREFS)): ModelSource {
	return readPrefs(file).source === "main" ? "main" : "list";
}

export function writeModelSource(source: ModelSource, file: string = prefsFile(SOURCE_PREFS)): void {
	writePrefs(file, { source });
}

export interface MainModel {
	provider: string;
	id: string;
}

export interface MainRoute {
	model: MainModel | undefined;
	source: ModelSource;
}

/** what `resolveRoute` needs to know about the main session at launch */
export function mainRoute(model: MainModel | undefined): MainRoute {
	return { model, source: readModelSource() };
}

export const SUB_AGENTS = [
	"chad",
	"delegate",
	"oracle",
	"finder",
	"librarian",
	"review_code",
	"read_session",
	"read_web_page",
] as const;
export type SubAgent = (typeof SUB_AGENTS)[number];

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

const THINKING_ALIASES: Record<string, ThinkingLevel> = {
	none: "off",
	min: "minimal",
	med: "medium",
	mid: "medium",
	"x-high": "xhigh",
	"extra-high": "xhigh",
	"extra high": "xhigh",
};

const MODEL_NAME = /^[a-z0-9][a-z0-9._-]*$/;
const QUALIFIED_ID = /^[^/\s]+\/\S+$/;

export interface ModelChoice {
	id: string;
	about?: string;
}

export interface AgentDefault {
	model?: string;
	thinking?: ThinkingLevel;
	/** runs on the main session's model instead of `model` while the source is `main` */
	followMain?: boolean;
}

export interface AgentModels {
	models: Record<string, ModelChoice>;
	agents: Partial<Record<SubAgent, AgentDefault>>;
	/** everything the loader dropped, worded as fixes. */
	problems: string[];
}

/** the slice of pi's ModelRegistry the resolver needs. */
export interface ModelCatalog {
	find(provider: string, modelId: string): unknown;
	hasConfiguredAuth(model: any): boolean;
}

export interface ModelRoute {
	model?: string;
	thinking?: ThinkingLevel;
}

export type Route = ModelRoute | { error: string };

export function emptyAgentModels(problems: string[] = []): AgentModels {
	return { models: {}, agents: {}, problems };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeThinking(value: unknown): ThinkingLevel | undefined {
	if (typeof value !== "string") return undefined;
	const key = value.trim().toLowerCase();
	if ((THINKING_LEVELS as readonly string[]).includes(key)) return key as ThinkingLevel;
	return THINKING_ALIASES[key];
}

export function parseAgentModels(raw: unknown): AgentModels {
	if (!isRecord(raw)) return emptyAgentModels(["the file must hold a JSON object with `models` and `agents`"]);
	const result = emptyAgentModels();

	for (const [rawName, entry] of Object.entries(isRecord(raw.models) ? raw.models : {})) {
		const name = rawName.trim().toLowerCase();
		const id = isRecord(entry) ? entry.id : undefined;
		if (!MODEL_NAME.test(name)) {
			result.problems.push(`models."${rawName}": use lowercase letters, digits, '.', '-' or '_'`);
		} else if (typeof id !== "string" || (id.trim() !== MAIN_MODEL_ID && !QUALIFIED_ID.test(id.trim()))) {
			result.problems.push(`models.${name}.id must be "provider/model" or "${MAIN_MODEL_ID}", got ${JSON.stringify(id)}`);
		} else {
			const about = isRecord(entry) && typeof entry.about === "string" ? entry.about.trim() : "";
			result.models[name] = about ? { id: id.trim(), about } : { id: id.trim() };
		}
	}

	for (const [agent, entry] of Object.entries(isRecord(raw.agents) ? raw.agents : {})) {
		if (!(SUB_AGENTS as readonly string[]).includes(agent)) {
			result.problems.push(`agents.${agent}: no such sub-agent (known: ${SUB_AGENTS.join(", ")})`);
			continue;
		}
		if (!isRecord(entry)) {
			result.problems.push(`agents.${agent} must be an object like { "model": "...", "thinking": "high" }`);
			continue;
		}
		const preset: AgentDefault = {};
		if (entry.model !== undefined) {
			const name = typeof entry.model === "string" ? entry.model.trim().toLowerCase() : "";
			if (result.models[name]) preset.model = name;
			else result.problems.push(`agents.${agent}.model "${entry.model}" is not in models; it falls back to pi's default model`);
		}
		if (entry.thinking !== undefined) {
			const level = normalizeThinking(entry.thinking);
			if (level) preset.thinking = level;
			else result.problems.push(`agents.${agent}.thinking "${entry.thinking}" is not one of ${THINKING_LEVELS.join(", ")}`);
		}
		if (entry.followMain !== undefined) {
			if (typeof entry.followMain === "boolean") preset.followMain = entry.followMain;
			else result.problems.push(`agents.${agent}.followMain must be true or false`);
		}
		result.agents[agent as SubAgent] = preset;
	}

	return result;
}

/** never throws: a broken file degrades to pi's default model and says why. */
export function loadAgentModels(file: string = AGENT_MODELS_FILE): AgentModels {
	let text: string;
	try {
		text = fs.readFileSync(file, "utf-8");
	} catch (error: any) {
		return emptyAgentModels([
			error?.code === "ENOENT"
				? `${file} is missing, so every sub-agent runs on pi's default model`
				: `cannot read ${file}: ${error?.message ?? error}`,
		]);
	}
	try {
		return parseAgentModels(JSON.parse(text));
	} catch (error: any) {
		return emptyAgentModels([`${file} is not valid JSON (${error?.message ?? error}); every sub-agent runs on pi's default model`]);
	}
}

function splitId(id: string): [provider: string, modelId: string] {
	const slash = id.indexOf("/");
	return [id.slice(0, slash), id.slice(slash + 1)];
}

function findName(config: AgentModels, value: string): string | undefined {
	const wanted = value.trim().toLowerCase();
	if (config.models[wanted]) return wanted;
	return Object.keys(config.models).find((name) => config.models[name].id.toLowerCase() === wanted);
}

const FOLLOWS_MAIN = "or the main session's model when the user switched these agents to it";

function defaultLabel(config: AgentModels, agent: SubAgent): string {
	const preset = config.agents[agent];
	const model = preset?.model ?? "pi's default model";
	const label = preset?.thinking ? `${model} · ${preset.thinking}` : model;
	return preset?.followMain ? `${label}, ${FOLLOWS_MAIN}` : label;
}

/** the agents that move to the main session's model when the source is `main` */
export function followingAgents(config: AgentModels): SubAgent[] {
	return SUB_AGENTS.filter((agent) => config.agents[agent]?.followMain === true);
}

function present(value: unknown): boolean {
	return value !== undefined && value !== null && !(typeof value === "string" && value.trim() === "");
}

/** a catalog or credential problem with one model, or undefined when it can run. */
export function checkModel(config: AgentModels, name: string, catalog: ModelCatalog): string | undefined {
	const { id } = config.models[name];
	if (id === MAIN_MODEL_ID) return undefined;
	const [provider, modelId] = splitId(id);
	const model = catalog.find(provider, modelId);
	if (!model) return `\`${name}\` points at ${id}, which pi's model catalog does not have; fix it in ${AGENT_MODELS_FILE}`;
	if (!catalog.hasConfiguredAuth(model)) return `\`${name}\` (${id}) has no credentials: run /login ${provider} or set its API key`;
	return undefined;
}

/**
 * the model and thinking level one call runs on. an explicit `model` /
 * `thinking` wins over the agent's default; a missing default, or one with no
 * credentials, leaves the flag off so the child uses pi's own default.
 *
 * `resuming` skips the defaults: pi restores a resumed child's own model and
 * thinking level when no flag is passed, and a default would silently move a
 * child started on another model back onto the default.
 *
 * `main` is the model the main session is on and the saved source; without
 * it the name `main` cannot run and nothing follows it.
 */
export function resolveRoute(
	config: AgentModels,
	agent: SubAgent,
	params: { model?: unknown; thinking?: unknown },
	catalog?: ModelCatalog,
	resuming = false,
	main?: MainRoute,
): Route {
	const preset: AgentDefault = resuming ? {} : (config.agents[agent] ?? {});
	const mainId = main?.model ? `${main.model.provider}/${main.model.id}` : undefined;
	let name = preset.model;
	let thinking = preset.thinking;
	let followMain = preset.followMain === true && main?.source === "main" && !!mainId && !isLocalProvider(main.model!.provider);

	if (present(params.model)) {
		const found = typeof params.model === "string" ? findName(config, params.model) : undefined;
		const names = Object.keys(config.models);
		if (!found) {
			return {
				error: names.length > 0
					? `Unknown model ${JSON.stringify(params.model)}. Use one of: ${names.join(", ")} — or omit \`model\` for ${agent}'s default (${defaultLabel(config, agent)}).`
					: `No models are configured in ${AGENT_MODELS_FILE}, so \`model\` cannot be set. Omit it to run on pi's default model.`,
			};
		}
		name = found;
		followMain = false;
	}

	if (present(params.thinking)) {
		const level = normalizeThinking(params.thinking);
		if (!level) {
			return {
				error: `Unknown thinking level ${JSON.stringify(params.thinking)}. Use one of: ${THINKING_LEVELS.join(", ")} — or omit \`thinking\` for ${agent}'s default.`,
			};
		}
		thinking = level;
	}

	if (followMain) return { model: mainId, thinking };
	if (!name) return { thinking };
	if (config.models[name].id === MAIN_MODEL_ID) {
		if (mainId) return { model: mainId, thinking };
		if (present(params.model)) return { error: "The main session has no model selected, so `main` cannot run. Pick another `model`." };
		return { thinking };
	}
	if (catalog) {
		const problem = checkModel(config, name, catalog);
		// a default the user cannot run (no DeepSeek key, say) must not take the agent down; the footer names the model that ran
		if (problem && !present(params.model)) return { thinking };
		if (problem) return { error: `${problem}. Or pick another \`model\`.` };
	}
	return { model: config.models[name].id, thinking };
}

/**
 * Why a child that answered on `actual` ("provider/model") must be stopped, or
 * undefined when it may run. With a requested id only that id passes; without
 * one (a resume, or a default that could not run) only a configured id or the
 * model the resumed conversation was saved on does.
 * pi's --model resolver can fall back to another provider's look-alike id, so
 * what the child reports is checked, not what was asked for.
 */
export function modelViolation(actual: string, requested: string | undefined, config: AgentModels, savedOn?: string): string | undefined {
	const got = actual.toLowerCase();
	if (requested) {
		return got === requested.toLowerCase()
			? undefined
			: `sub-agent stopped: it started on ${actual}, but ${requested} was requested. Nothing else was run.`;
	}
	const allowed = Object.values(config.models).map((model) => model.id.toLowerCase());
	if (allowed.length === 0 || allowed.includes(got) || savedOn?.toLowerCase() === got) return undefined;
	return `sub-agent stopped: it started on ${actual}, which is not one of the models in ${AGENT_MODELS_FILE}. Nothing else was run.`;
}

/** every problem worth telling the user about at session start. */
export function auditAgentModels(config: AgentModels, catalog: ModelCatalog): string[] {
	const problems = [...config.problems];
	for (const name of Object.keys(config.models)) {
		const problem = checkModel(config, name, catalog);
		if (problem) problems.push(problem);
	}
	return problems;
}

/** the optional `model` / `thinking` parameters for one sub-agent tool's schema. */
export function modelParams(config: AgentModels, agent: SubAgent) {
	const preset = config.agents[agent] ?? {};
	const names = Object.keys(config.models);
	const onResume = agent === "read_session" || agent === "read_web_page" ? "" : " A continueId resume keeps the child's own.";
	const thinking = Type.Optional(
		Type.Unsafe<ThinkingLevel>({
			type: "string",
			enum: [...THINKING_LEVELS],
			description: `Omit unless the user names a thinking level. Default: ${preset.thinking ?? "pi's default"}.${onResume}`,
		}),
	);
	if (names.length === 0) return { thinking };
	return {
		model: Type.Optional(
			Type.Unsafe<string>({
				type: "string",
				enum: names,
				description: `Omit unless the user names a model. Default: ${preset.model ?? "pi's default model"}${preset.followMain ? `, ${FOLLOWS_MAIN}` : ""}.${onResume}`,
			}),
		),
		thinking,
	};
}

/** the system-prompt section that tells the parent which names exist. */
export function describeAgentModels(config: AgentModels): string {
	const names = Object.keys(config.models);
	if (names.length === 0) return "";

	const byDefault = new Map<string, string[]>();
	for (const agent of SUB_AGENTS) {
		const label = defaultLabel(config, agent);
		byDefault.set(label, [...(byDefault.get(label) ?? []), agent]);
	}

	return [
		"**Sub-agent models.** Every sub-agent tool (and `read_web_page` with `prompt`) takes optional `model` and `thinking`. Leave both out unless the user names a model or a thinking level; the agent then runs on its default. When the user asks for one, pass the name below exactly — no lookup is needed — on every call it applies to, until they say otherwise.",
		"",
		...names.map((name) => {
			const { id, about } = config.models[name];
			return `- \`${name}\` — ${id === MAIN_MODEL_ID ? "the model the main session is on" : id}${about ? `, ${about}` : ""}`;
		}),
		"",
		"If the user names a model that is not in this list, do not substitute the nearest one: say it is not configured and name the closest choices.",
		`Defaults: ${[...byDefault].map(([label, agents]) => `${agents.join(", ")} → ${label}`).join("; ")}.`,
		`Thinking levels: ${THINKING_LEVELS.join(", ")} ("med" means medium). pi adjusts a level to what the chosen model supports.`,
		"Each result ends with the model and thinking level that actually ran.",
	].join("\n");
}
