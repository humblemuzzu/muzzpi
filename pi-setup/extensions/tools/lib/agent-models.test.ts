import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	auditAgentModels,
	describeAgentModels,
	emptyAgentModels,
	followingAgents,
	loadAgentModels,
	modelParams,
	modelViolation,
	normalizeThinking,
	parseAgentModels,
	readModelSource,
	resolveRoute,
	SUB_AGENTS,
	writeModelSource,
	type ModelCatalog,
	type Route,
} from "./agent-models";

const CONFIG = parseAgentModels({
	models: {
		grok: { id: "xai/grok-4.6", about: "Grok 4.6" },
		"DeepSeek-Flash": { id: "deepseek/deepseek-flash" },
		"flash-or": { id: "openrouter/deepseek/deepseek-v4.1-flash" },
		k3: { id: "kimi-coding/k3" },
	},
	agents: {
		chad: { model: "grok", thinking: "high" },
		oracle: { model: "grok", thinking: "xhigh" },
		finder: { thinking: "low" },
	},
});

/** a catalog holding every configured model except `missing`, with credentials except for `noAuth` providers. */
function catalog(opts: { missing?: string[]; noAuth?: string[] } = {}): ModelCatalog & { calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		find(provider, modelId) {
			calls.push(`${provider}|${modelId}`);
			return opts.missing?.includes(`${provider}/${modelId}`) ? undefined : { provider, id: modelId };
		},
		hasConfiguredAuth(model) {
			return !opts.noAuth?.includes(model.provider);
		},
	};
}

describe("parseAgentModels", () => {
	test("a well-formed file loads with no problems, names lowercased", () => {
		expect(CONFIG.problems).toEqual([]);
		expect(Object.keys(CONFIG.models)).toEqual(["grok", "deepseek-flash", "flash-or", "k3"]);
		expect(CONFIG.models.grok).toEqual({ id: "xai/grok-4.6", about: "Grok 4.6" });
	});

	test("a bare model id is refused: it is ambiguous across providers since pi 0.84", () => {
		const parsed = parseAgentModels({ models: { sonnet: { id: "claude-sonnet-5" } } });
		expect(parsed.models.sonnet).toBeUndefined();
		expect(parsed.problems[0]).toContain('"provider/model"');
	});

	test("a default naming a model that is not listed is dropped, so that agent uses pi's default", () => {
		const parsed = parseAgentModels({ models: {}, agents: { chad: { model: "opus", thinking: "high" } } });
		expect(parsed.agents.chad).toEqual({ thinking: "high" });
		expect(parsed.problems[0]).toContain("agents.chad.model");
	});

	test("unknown agents, bad thinking levels and bad names are reported, not fatal", () => {
		const parsed = parseAgentModels({
			models: { "bad name!": { id: "xai/grok-4.6" } },
			agents: { wizard: {}, chad: { thinking: "ultra" } },
		});
		expect(parsed.problems).toHaveLength(3);
		expect(parsed.agents.chad).toEqual({});
	});

	test("a non-object file is one problem and an empty config", () => {
		const parsed = parseAgentModels([1, 2]);
		expect(parsed.models).toEqual({});
		expect(parsed.problems).toHaveLength(1);
	});
});

describe("loadAgentModels never throws", () => {
	const dir = mkdtempSync(join(tmpdir(), "agent-models-"));

	test("missing file", () => {
		const loaded = loadAgentModels(join(dir, "nope.json"));
		expect(loaded.models).toEqual({});
		expect(loaded.problems[0]).toContain("missing");
	});

	test("invalid JSON", () => {
		const file = join(dir, "broken.json");
		writeFileSync(file, "{ models: ");
		const loaded = loadAgentModels(file);
		expect(loaded.models).toEqual({});
		expect(loaded.problems[0]).toContain("not valid JSON");
	});
});

describe("the shipped pi-setup/agent-models.json", () => {
	const shipped = parseAgentModels(
		JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "..", "agent-models.json"), "utf-8")),
	);

	test("parses with zero problems", () => {
		expect(shipped.problems).toEqual([]);
	});

	test("gives every sub-agent a default model and thinking level", () => {
		for (const agent of SUB_AGENTS) {
			expect(shipped.agents[agent]?.model).toBeDefined();
			expect(shipped.agents[agent]?.thinking).toBeDefined();
		}
	});
});

describe("normalizeThinking", () => {
	test("accepts every pi level and the way people say them", () => {
		expect(normalizeThinking("high")).toBe("high");
		expect(normalizeThinking(" XHigh ")).toBe("xhigh");
		expect(normalizeThinking("med")).toBe("medium");
		expect(normalizeThinking("extra high")).toBe("xhigh");
		expect(normalizeThinking("none")).toBe("off");
	});

	test("refuses anything else", () => {
		expect(normalizeThinking("ultra")).toBeUndefined();
		expect(normalizeThinking(3)).toBeUndefined();
	});
});

describe("resolveRoute", () => {
	function errorOf(route: Route): string {
		if (!("error" in route)) throw new Error(`expected a refusal, got ${JSON.stringify(route)}`);
		return route.error;
	}

	test("no model or thinking given: the agent's defaults", () => {
		expect(resolveRoute(CONFIG, "chad", {}, catalog())).toEqual({ model: "xai/grok-4.6", thinking: "high" });
	});

	test("a named model wins, by name in any case, and keeps the default thinking level", () => {
		expect(resolveRoute(CONFIG, "chad", { model: "DeepSeek-Flash" }, catalog())).toEqual({
			model: "deepseek/deepseek-flash",
			thinking: "high",
		});
	});

	test("the full provider/model id is accepted as well as the name", () => {
		const route = resolveRoute(CONFIG, "chad", { model: "kimi-coding/k3" }, catalog());
		expect(route).toEqual({ model: "kimi-coding/k3", thinking: "high" });
	});

	test("thinking can be set alone, and in the way people say it", () => {
		expect(resolveRoute(CONFIG, "oracle", { thinking: "med" }, catalog())).toEqual({
			model: "xai/grok-4.6",
			thinking: "medium",
		});
	});

	test("empty strings and null mean 'not given', not 'unknown'", () => {
		expect(resolveRoute(CONFIG, "chad", { model: "", thinking: null }, catalog())).toEqual({
			model: "xai/grok-4.6",
			thinking: "high",
		});
	});

	test("an agent with no default model leaves --model off entirely", () => {
		expect(resolveRoute(CONFIG, "finder", {}, catalog())).toEqual({ thinking: "low" });
		expect(resolveRoute(CONFIG, "librarian", {}, catalog())).toEqual({ thinking: undefined });
	});

	test("resuming skips the defaults, so a child keeps the model it was started on", () => {
		expect(resolveRoute(CONFIG, "chad", {}, catalog(), true)).toEqual({ thinking: undefined });
	});

	test("resuming with an explicit model or level still switches to it", () => {
		expect(resolveRoute(CONFIG, "chad", { model: "k3", thinking: "low" }, catalog(), true)).toEqual({
			model: "kimi-coding/k3",
			thinking: "low",
		});
	});

	test("an unknown model names every valid choice and the default", () => {
		const error = errorOf(resolveRoute(CONFIG, "chad", { model: "gpt-9" }, catalog()));
		expect(error).toContain('"gpt-9"');
		expect(error).toContain("grok, deepseek-flash, flash-or, k3");
		expect(error).toContain("grok · high");
	});

	test("an unknown thinking level names every valid one", () => {
		expect(errorOf(resolveRoute(CONFIG, "chad", { thinking: "ultra" }, catalog()))).toContain(
			"off, minimal, low, medium, high, xhigh, max",
		);
	});

	test("a model the catalog lost is refused before anything spawns", () => {
		const route = resolveRoute(CONFIG, "chad", { model: "k3" }, catalog({ missing: ["kimi-coding/k3"] }));
		expect(errorOf(route)).toContain("catalog does not have");
	});

	test("a model without credentials says how to log in", () => {
		const route = resolveRoute(CONFIG, "chad", { model: "deepseek-flash" }, catalog({ noAuth: ["deepseek"] }));
		expect(errorOf(route)).toContain("/login deepseek");
	});

	test("a default model without credentials falls back to pi's default instead of failing", () => {
		expect(resolveRoute(CONFIG, "chad", {}, catalog({ noAuth: ["xai"] }))).toEqual({ thinking: "high" });
		expect(resolveRoute(CONFIG, "chad", {}, catalog({ missing: ["xai/grok-4.6"] }))).toEqual({ thinking: "high" });
	});

	test("ids with a slash in the model part split at the first slash", () => {
		const cat = catalog();
		resolveRoute(CONFIG, "chad", { model: "flash-or" }, cat);
		expect(cat.calls).toEqual(["openrouter|deepseek/deepseek-v4.1-flash"]);
	});

	test("with nothing configured, setting a model explains why it cannot", () => {
		expect(errorOf(resolveRoute(emptyAgentModels(), "chad", { model: "grok" }))).toContain("No models are configured");
	});
});

describe("auditAgentModels", () => {
	test("reports parse problems and every model that cannot run", () => {
		const problems = auditAgentModels(CONFIG, catalog({ missing: ["xai/grok-4.6"], noAuth: ["kimi-coding"] }));
		expect(problems).toHaveLength(2);
		expect(problems.join("\n")).toContain("`grok`");
		expect(problems.join("\n")).toContain("/login kimi-coding");
	});

	test("is empty when everything can run", () => {
		expect(auditAgentModels(CONFIG, catalog())).toEqual([]);
	});
});

describe("modelParams", () => {
	test("model is an optional enum of the configured names; thinking an optional enum of pi's levels", () => {
		const params = modelParams(CONFIG, "chad") as any;
		expect(params.model.enum).toEqual(["grok", "deepseek-flash", "flash-or", "k3"]);
		expect(params.model.description).toContain("Default: grok");
		expect(params.thinking.enum).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
		expect(params.thinking.description).toContain("Default: high");
	});

	test("with no models configured there is no model parameter at all", () => {
		const params = modelParams(emptyAgentModels(), "chad") as any;
		expect(params.model).toBeUndefined();
		expect(params.thinking).toBeDefined();
	});
});

describe("describeAgentModels", () => {
	test("lists every name with its id, and groups agents by default", () => {
		const text = describeAgentModels(CONFIG);
		for (const name of Object.keys(CONFIG.models)) expect(text).toContain(`\`${name}\``);
		expect(text).toContain("openrouter/deepseek/deepseek-v4.1-flash");
		expect(text).toContain("chad → grok · high");
		expect(text).toContain("oracle → grok · xhigh");
		expect(text).toContain("finder → pi's default model · low");
	});

	test("is empty with no models, so the prompt line is dropped", () => {
		expect(describeAgentModels(emptyAgentModels())).toBe("");
	});
});

describe("modelViolation: the child must run on exactly what was asked for", () => {
	const shipped = loadAgentModels(join(import.meta.dir, "../../../agent-models.json"));

	test("the requested provider/model passes, any other provider is stopped", () => {
		expect(modelViolation("anthropic/claude-sonnet-5-5", "anthropic/claude-sonnet-5-5", shipped)).toBeUndefined();
		for (const lookalike of ["openrouter/anthropic/claude-sonnet-5.5", "opencode/claude-sonnet-5-5", "anthropic/claude-opus-5-5"]) {
			expect(modelViolation(lookalike, "anthropic/claude-sonnet-5-5", shipped)).toContain("stopped");
		}
	});

	test("with nothing requested, only a model listed in agent-models.json may run", () => {
		expect(modelViolation("anthropic/claude-opus-5-5", undefined, shipped)).toBeUndefined();
		expect(modelViolation("openrouter/z-ai/glm-5.3-flash", undefined, shipped)).toBeUndefined();
		expect(modelViolation("openrouter/deepseek/deepseek-v4.1-flash", undefined, shipped)).toContain("not one of the models");
		expect(modelViolation("openrouter/anthropic/claude-sonnet-5.5", undefined, shipped)).toContain("not one of the models");
	});

	test("the shipped list names no Claude model outside the anthropic provider", () => {
		for (const { id } of Object.values(shipped.models)) {
			if (/claude|sonnet|opus|haiku/i.test(id)) expect(id.startsWith("anthropic/")).toBe(true);
		}
	});

	test("a resume may run on the model its conversation was saved on, even one outside the list", () => {
		expect(modelViolation("openai-codex/gpt-6-astra", undefined, shipped, "openai-codex/gpt-6-astra")).toBeUndefined();
		expect(modelViolation("openai-codex/gpt-6-astra", undefined, shipped, "openai-codex/gpt-5.6-sol")).toContain("not one of the models");
		expect(modelViolation("openai-codex/gpt-6-astra", "anthropic/claude-opus-5-5", shipped, "openai-codex/gpt-6-astra")).toContain("stopped");
	});
});

describe("following the main session's model", () => {
	const config = parseAgentModels({
		models: { sonnet: { id: "anthropic/claude-sonnet-5-5" }, flash: { id: "deepseek/deepseek-flash" }, main: { id: "$main" } },
		agents: {
			oracle: { model: "sonnet", thinking: "high", followMain: true },
			chad: { model: "flash", thinking: "high" },
		},
	});
	const opus = { provider: "anthropic", id: "claude-opus-5-5" };
	const onMain = { model: opus, source: "main" as const };
	const onList = { model: opus, source: "list" as const };

	test("$main and followMain parse, and the catalog is never asked about $main", () => {
		expect(config.problems).toEqual([]);
		expect(followingAgents(config)).toEqual(["oracle"]);
		const cat = catalog();
		expect(auditAgentModels(config, cat)).toEqual([]);
		expect(cat.calls).toEqual(["anthropic|claude-sonnet-5-5", "deepseek|deepseek-flash"]);
		expect(parseAgentModels({ models: {}, agents: { oracle: { followMain: "yes" } } }).problems[0]).toContain("followMain");
	});

	test("the list source keeps every agent on its own model", () => {
		expect(resolveRoute(config, "oracle", {}, catalog(), false, onList)).toEqual({ model: "anthropic/claude-sonnet-5-5", thinking: "high" });
	});

	test("the main source moves only followMain agents, keeping their thinking level", () => {
		expect(resolveRoute(config, "oracle", {}, catalog(), false, onMain)).toEqual({ model: "anthropic/claude-opus-5-5", thinking: "high" });
		expect(resolveRoute(config, "chad", {}, catalog(), false, onMain)).toEqual({ model: "deepseek/deepseek-flash", thinking: "high" });
	});

	test("an explicit model beats following, and `main` can be named whatever the source", () => {
		expect(resolveRoute(config, "oracle", { model: "flash" }, catalog(), false, onMain)).toEqual({ model: "deepseek/deepseek-flash", thinking: "high" });
		expect(resolveRoute(config, "chad", { model: "main" }, catalog(), false, onList)).toEqual({ model: "anthropic/claude-opus-5-5", thinking: "high" });
	});

	test("a resume keeps its own model unless one is named", () => {
		expect(resolveRoute(config, "oracle", {}, catalog(), true, onMain)).toEqual({ thinking: undefined });
		expect(resolveRoute(config, "oracle", { model: "main" }, catalog(), true, onMain)).toEqual({ model: "anthropic/claude-opus-5-5", thinking: undefined });
	});

	test("a local main model is not followed, and `main` without one is refused only when named", () => {
		const local = { model: { provider: "llama-local", id: "LFM2.5-2.6B" }, source: "main" as const };
		expect(resolveRoute(config, "oracle", {}, catalog(), false, local)).toEqual({ model: "anthropic/claude-sonnet-5-5", thinking: "high" });
		const none = { model: undefined, source: "main" as const };
		expect(resolveRoute(config, "oracle", {}, catalog(), false, none)).toEqual({ model: "anthropic/claude-sonnet-5-5", thinking: "high" });
		expect("error" in resolveRoute(config, "chad", { model: "main" }, catalog(), false, none)).toBe(true);
	});

	test("the prompt and schema say what main is and which agents can follow it", () => {
		const text = describeAgentModels(config);
		expect(text).toContain("`main` — the model the main session is on");
		expect(text).toContain("oracle → sonnet · high, or the main session's model");
		expect(text).toContain("chad → flash · high;");
		expect((modelParams(config, "oracle") as any).model.description).toContain("or the main session's model");
		expect((modelParams(config, "chad") as any).model.description).not.toContain("main session");
	});

	test("the source is saved as a pref and anything but main reads as list", () => {
		const file = join(mkdtempSync(join(tmpdir(), "model-source-")), "cache", "agent-models.json");
		expect(readModelSource(file)).toBe("list");
		writeModelSource("main", file);
		expect(readModelSource(file)).toBe("main");
		writeFileSync(file, JSON.stringify({ source: "opus" }));
		expect(readModelSource(file)).toBe("list");
	});
});
