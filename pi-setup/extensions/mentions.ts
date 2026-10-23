/**
 * mentions extension — @mention resolution for sessions, commits, handoffs,
 * and agent directives (@oracle, @finder, @codereview, @task).
 *
 * data mentions (@session/id, @commit/sha, @handoff/id) add a hidden
 * context message. agent mentions (@oracle, @finder, etc.) add a directive
 * telling the model to call the specified subagent tool. the message is
 * stored in the session once, next to the user's message, and never edited.
 *
 * ported from bdsqqq/dots mentions extension, adapted for flat-file setup.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { contributeHelp } from "./tools/lib/help-channel";
import {
	clearCommitIndexCache,
	clearSessionMentionCache,
	listMentionSources,
	MentionAwareProvider,
	renderResolvedMentionsText,
	resolveMentions,
	type ResolvedMention,
} from "./tools/lib/mentions/index.js";
import { PI_SESSIONS_DIR } from "./tools/lib/pi-spawn";
// side-effect import — registers @oracle, @finder, @codereview, @task sources
import "./tools/lib/mentions/agent-source.js";

const CUSTOM_TYPE = "mentions:resolved";

export default function mentionsExtension(pi: ExtensionAPI): void {
	let pendingMentionContext = "";

	const clearPending = () => {
		pendingMentionContext = "";
	};

	pi.on("input", async (event, ctx) => {
		clearPending();
		if (event.source === "extension") return { action: "continue" as const };

		const mentions = await resolveMentions(event.text, { cwd: ctx.cwd });
		const resolved = mentions.filter(
			(mention): mention is Extract<ResolvedMention, { status: "resolved" }> =>
				mention.status === "resolved",
		);
		const content = renderResolvedMentionsText(resolved);
		if (!content) return { action: "continue" as const };

		if (event.streamingBehavior) {
			// Input handlers run before pi queues the user's own message, so this lands just before it.
			pi.sendMessage(
				{ customType: CUSTOM_TYPE, content, display: false },
				{ deliverAs: event.streamingBehavior },
			);
		} else {
			pendingMentionContext = content;
		}
		return { action: "continue" as const };
	});

	pi.on("before_agent_start", async (event) => {
		if (event.messageType !== "user" || !pendingMentionContext) return;
		const content = pendingMentionContext;
		clearPending();
		return { message: { customType: CUSTOM_TYPE, content, display: false } };
	});

	pi.on("agent_end", async () => {
		clearPending();
	});

	pi.on("session_start", async (_event, ctx) => {
		clearPending();
		clearSessionMentionCache();
		clearCommitIndexCache();

		if (!ctx.hasUI) return;

		ctx.ui.addAutocompleteProvider(
			(current) =>
				new MentionAwareProvider({
					baseProvider: current,
					cwd: ctx.cwd,
					sessionsDir: PI_SESSIONS_DIR,
				}),
		);
	});

	contributeHelp(pi, (help) => {
		for (const source of listMentionSources()) {
			if (source.standalone) help.mention({ text: `@${source.kind}`, description: `the ${source.kind} sub-agent: ${source.description}` });
			else help.mention({ text: `@${source.kind}/`, description: `a ${source.description}: type its id after the slash` });
		}
	});
}
