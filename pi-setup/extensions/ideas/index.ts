import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { SUB_AGENT_TOOLS_ENV } from "../tools/lib/sub-agent-prompt";
import {
	type Idea,
	type Where,
	addIdea,
	flatten,
	ideasDir,
	ideasHere,
	lastUserPrompt,
	loadAll,
	openCount,
	parseInput,
	resolveWhere,
	setScope,
	setStatus,
} from "./store";
import { IdeaList, type ListSource } from "./view";

const LABEL_KEY = "ideas";
const HARNESS_VIEW: Pick<Where, "root" | "isHarness"> = { root: "", isHarness: true };
const PLAIN_LIST_LIMIT = 20;

function newestOpen(ideas: Idea[]): Idea[] {
	return ideas.filter((idea) => idea.status === "open").sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
}

export default function ideas(pi: ExtensionAPI): void {
	if (process.env[SUB_AGENT_TOOLS_ENV]?.trim()) return;
	const dir = ideasDir();
	let here: Where | undefined;

	const showCount = (place: Where) => {
		try {
			const count = openCount(loadAll(dir), place);
			if (count) {
				const text = count === 1 ? "1 idea" : `${count} ideas`;
				pi.events.emit("editor:set-label", { key: LABEL_KEY, text, position: "bottom", align: "right", priority: 30 });
			} else {
				pi.events.emit("editor:remove-label", { key: LABEL_KEY });
			}
		} catch {
			// a replaced session's runtime throws on every pi.* call; the new session paints its own count
		}
	};

	pi.on("session_start", (_event, ctx) => {
		resolveWhere(ctx.cwd, false).then(
			(place) => {
				here = place;
				showCount(place);
			},
			() => undefined,
		);
	});

	pi.on("agent_end", () => {
		if (here) showCount(here);
	});

	async function save(raw: string, ctx: ExtensionCommandContext): Promise<void> {
		const input = parseInput(raw);
		if (!input.text) {
			ctx.ui.notify("Nothing to save: write the idea after the tags, e.g. /idea pi: bug: the dock flickers", "warning");
			return;
		}
		const place = await resolveWhere(ctx.cwd);
		here = place;
		const session = ctx.sessionManager;
		const file = session.getSessionFile();
		const name = session.getSessionName();
		const prompt = lastUserPrompt(session.getBranch());
		const idea = addIdea(dir, place, input, {
			session: { id: session.getSessionId(), ...(file ? { file } : {}), ...(name ? { name } : {}) },
			...(prompt ? { lastPrompt: prompt } : {}),
			agentBusy: !ctx.isIdle(),
			source: "pi",
		});
		showCount(place);
		const harness = idea.scope === "harness";
		const open = openCount(loadAll(dir), harness ? HARNESS_VIEW : place);
		const back = harness && !place.isHarness ? ` · back to ${place.project}` : "";
		ctx.ui.notify(`Saved to ${harness ? "harness" : place.project} · ${open} open${back}`, "info");
	}

	async function review(ctx: ExtensionCommandContext): Promise<void> {
		const place = await resolveWhere(ctx.cwd, false);
		here = place;
		let cache: Idea[] | undefined;
		const all = () => (cache ??= loadAll(dir));

		if (!ctx.hasUI || ctx.mode !== "tui") {
			const open = newestOpen(ideasHere(all(), place));
			const lines = open.slice(0, PLAIN_LIST_LIMIT).map((idea) => `${idea.id}  ${flatten(idea.text)}`);
			ctx.ui.notify(lines.length ? lines.join("\n") : "No open ideas here.", "info");
			return;
		}

		const source: ListSource = {
			harnessView: place.isHarness,
			title: (everything) => (everything ? "All ideas" : place.isHarness ? "Harness ideas" : `${place.project} ideas`),
			ideas: (everything) => newestOpen(everything ? all() : ideasHere(all(), place)),
			moveTarget: (idea) => {
				if (idea.scope === "project") return { scope: "harness", label: "harness" };
				return idea.at.isHarness ? undefined : { scope: "project", label: idea.at.project };
			},
			apply: (change) => {
				if ("status" in change) setStatus(dir, change.idea, change.status);
				else setScope(dir, change.idea, change.scope);
				cache = undefined;
			},
		};

		const start = await ctx.ui.custom<Idea | undefined>((tui, theme, _keybindings, done) => new IdeaList(source, theme, tui, done));
		showCount(place);
		if (!start) return;
		const draft = ctx.ui.getEditorText();
		ctx.ui.setEditorText(draft.trim() ? `${draft.trimEnd()}\n\n${start.text}` : start.text);
	}

	pi.registerCommand("idea", {
		description: "Park an idea for this project (pi: in front files it under the harness) · /idea alone opens the list",
		handler: async (args, ctx) => {
			try {
				if (args.trim()) await save(args, ctx);
				else await review(ctx);
			} catch (error) {
				ctx.ui.notify(`/idea failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
