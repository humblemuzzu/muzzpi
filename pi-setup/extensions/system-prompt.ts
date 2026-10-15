/**
 * system-prompt — makes the interpolated prompt.amp.system.md the session's system prompt.
 *
 * `systemPromptOptions.customPrompt` replaces pi's default preamble, tool list, rules
 * and docs block; pi still renders project context, skills and cwd. The tool
 * guidelines and docs block pi would have rendered are re-added as sections, so
 * nothing a tool registers is lost. Sub-agents get buildSubAgentPrompt instead.
 */

import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readAgentPrompt } from "./tools/lib/pi-spawn";
import { interpolatePromptVars } from "./tools/lib/interpolate";
import { describeAgentModels, loadAgentModels } from "./tools/lib/agent-models";
import {
	buildSubAgentPrompt,
	parseToolList,
	SUB_AGENT_TOOLS_ENV,
} from "./tools/lib/sub-agent-prompt";

/** harness configuration. TODO: make this configurable via settings or env. */
const HARNESS = "pi";
const IDENTITY = "Coding agent";

// pi's built-in bash guideline; our bash override does not set PI_* model or session vars.
const UNTRUE_HERE = new Set(["You can inspect PI_* environment variables for current model and session details."]);

function piPackageDir(): string | undefined {
	try {
		let dir = dirname(realpathSync(process.argv[1] ?? ""));
		for (let i = 0; i < 4; i++) {
			if (existsSync(join(dir, "docs", "codemode.md"))) return dir;
			dir = dirname(dir);
		}
	} catch {}
	return undefined;
}

export function piDocs(dir: string): string {
	return `Pi documentation (read only when the user asks about the cli itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: ${join(dir, "README.md")}
- Additional docs: ${join(dir, "docs")}
- Examples: ${join(dir, "examples")} (extensions, custom tools, SDK)
- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), cli packages (docs/packages.md), environment variables (docs/environment-variables.md), MCP servers (docs/mcp.md), codemode scripts and non-LLM models such as classifiers and image models (docs/codemode.md)
- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing
- Always read cli .md files completely and follow links to related docs (e.g., tui.md for TUI API details)`;
}

function toolGuidelines(options: any): string {
	const hidden: string[] = options.hiddenTools ?? [];
	const declared: string[] = options.selectedTools.filter((name: string) => !hidden.includes(name));
	const rules = [...declared.flatMap((name) => options.toolGuidelines[name] ?? []), ...options.promptGuidelines]
		.map((rule: string) => rule.trim())
		.filter((rule: string) => rule && !UNTRUE_HERE.has(rule));
	return [...new Set(rules)].map((rule) => `- ${rule}`).join("\n");
}

export default function (pi: ExtensionAPI) {
	const body = readAgentPrompt("prompt.amp.system.md");
	if (!body) return;

	const harnessDocs = readAgentPrompt(`prompt.harness-docs.${HARNESS}.md`) || "";
	const rules = readAgentPrompt("rules.amp.md").trim();
	const piDir = piPackageDir();
	const agentModels = describeAgentModels(loadAgentModels());

	pi.on("before_agent_start", async (event, ctx) => {
		const options = event.systemPromptOptions;
		const addShared = () => {
			const guidelines = toolGuidelines(options);
			if (guidelines) options.sections.tool_guidelines = guidelines;
			if (piDir) options.sections.docs = piDocs(piDir);
		};

		// a child gets its own prompt instead of the parent template, not the template plus a
		// correction: a child reading "every file modification" or "exactly six sub-agents" is
		// misled before any footnote arrives. its agent prompt arrives as appendSystemPrompt.
		const childTools = process.env[SUB_AGENT_TOOLS_ENV]?.trim();
		if (childTools && parseToolList(childTools).length > 0) {
			options.customPrompt = buildSubAgentPrompt(IDENTITY, childTools);
			if (rules) options.sections.rules = rules;
			addShared();
			return;
		}

		if (ctx.model?.provider === "llama-local" || ctx.model?.provider === "llama.cpp") return;

		options.customPrompt = interpolatePromptVars(body, ctx.cwd, {
			sessionId: ctx.sessionManager.getSessionId(),
			identity: IDENTITY,
			harness: HARNESS,
			harnessDocsSection: harnessDocs,
			agentModels,
		});
		if (rules) options.sections.rules = rules;
		addShared();
	});
}
