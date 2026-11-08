/**
 * auto session naming — generates a short title from the first user message.
 *
 * fires on the `input` event so the name appears while the agent is still
 * thinking. uses DeepSeek Flash (thinking off) for speed and cost, through
 * pi's own model registry; only names the session once.
 */

import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { makeScrubber } from "./tools/lib/psst";
import { SUB_AGENT_TOOLS_ENV } from "./tools/lib/sub-agent-prompt";

const NAMING_MODEL = { provider: "deepseek", id: "deepseek-flash" } as const;
const MAX_TITLE_CHARS = 80;

export default function (pi: ExtensionAPI) {
	// a sub-agent's name is never shown and its process exits before the request lands
	if (process.env[SUB_AGENT_TOOLS_ENV]?.trim()) return;
	let named = false;

	pi.on("input", async (event, ctx) => {
		if (named) return;
		if (pi.getSessionName()) {
			named = true;
			return;
		}

		// skip slash commands and very short inputs
		const text = event.text.trim();
		if (text.startsWith("/") || text.length < 10) return;

		named = true;

		const model = namingModel(ctx);
		if (!model) return;

		// fire and forget — don't block the input pipeline
		generateName(model, ctx.modelRegistry, text)
			.then((name) => {
				if (name) pi.setSessionName(name);
			})
			.catch(() => {});
	});

	pi.on("session_start", async (event) => {
		if (event.reason === "startup" || event.reason === "reload") return;
		named = false;
	});
}

/** DeepSeek Flash when its key is set, else the main session's model. */
function namingModel(ctx: ExtensionContext): Model<Api> | undefined {
	const flash = ctx.modelRegistry.find(NAMING_MODEL.provider, NAMING_MODEL.id);
	return flash && ctx.modelRegistry.hasConfiguredAuth(flash) ? flash : ctx.model;
}

function cleanTitle(reply: string): string {
	const line = reply.trim().split("\n")[0]?.trim() ?? "";
	const unquoted = line.replace(/^["'`*]+|["'`*.!?:;]+$/g, "").trim();
	return unquoted.length > MAX_TITLE_CHARS ? unquoted.slice(0, MAX_TITLE_CHARS).trimEnd() : unquoted;
}

async function generateName(model: Model<Api>, registry: ExtensionContext["modelRegistry"], userMessage: string): Promise<string | null> {
	const scrub = await makeScrubber();
	const response: AssistantMessage = await registry.complete(
		model,
		{
			messages: [
				{
					role: "user",
					content: [
						{
							type: "text",
							text: `Generate a 3-5 word title for a coding session that starts with this message. Return ONLY the title, no quotes, no punctuation, no explanation. Lowercase.\n\n${scrub(userMessage.slice(0, 500))}`,
						},
					],
					timestamp: Date.now(),
				},
			],
		},
		{ maxTokens: 30 },
	);
	if (response.stopReason === "aborted" || response.stopReason === "error") return null;

	const title = cleanTitle(
		response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join(""),
	);
	return title || null;
}
