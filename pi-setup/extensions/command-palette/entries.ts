import type { CollectedHelp } from "../tools/lib/help-channel";
import type { HelpEntry, HelpSection } from "./types";

export interface CommandInfo {
	name: string;
	description?: string;
	source: string;
	sourceInfo?: { source?: string };
}

export interface BuiltinCommand {
	name: string;
	description: string;
}

const SECTION_ORDER: readonly HelpSection[] = ["muzzpi", "pi", "prompts", "mentions", "skills"];

/** Every command, prompt, skill and @mention this session has, in the order /help lists them. */
export function buildEntries(commands: readonly CommandInfo[], builtins: readonly BuiltinCommand[], help: CollectedHelp): HelpEntry[] {
	const entries: HelpEntry[] = [];
	for (const command of commands) {
		const description = command.description ?? "";
		if (command.source === "extension") {
			if (command.name === "help") continue;
			const section = command.sourceInfo?.source === "builtin" ? "pi" : "muzzpi";
			const key = help.shortcuts.get(command.name);
			entries.push({ section, name: `/${command.name}`, description, ...(key ? { key } : {}), action: { kind: "run", command: command.name } });
		} else if (command.source === "prompt" || command.source === "skill") {
			const section = command.source === "skill" ? "skills" : "prompts";
			entries.push({ section, name: `/${command.name}`, description, action: { kind: "prefix", text: `/${command.name} ` } });
		}
	}
	for (const builtin of builtins) {
		entries.push({ section: "pi", name: `/${builtin.name}`, description: builtin.description, action: { kind: "type", text: `/${builtin.name}` } });
	}
	for (const mention of help.mentions) {
		entries.push({ section: "mentions", name: mention.text, description: mention.description, action: { kind: "append", text: `${mention.text} ` } });
	}
	const rank = (entry: HelpEntry) => SECTION_ORDER.indexOf(entry.section);
	return entries.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/** The editor text after an entry's action, or undefined when doing it would throw away the user's draft. */
export function editorTextFor(entry: HelpEntry, draft: string): string | undefined {
	const { action } = entry;
	if (action.kind === "run") return undefined;
	if (action.kind === "type") return draft.trim() ? undefined : action.text;
	if (action.kind === "prefix") return `${action.text}${draft.trimStart()}`;
	return draft.trim() ? `${draft.trimEnd()} ${action.text}` : action.text;
}

/** What enter will do, said under the list. */
export function describeAction(entry: HelpEntry): string {
	const { action } = entry;
	if (action.kind === "run") return `enter runs ${entry.name}`;
	if (action.kind === "type") return `enter puts ${action.text} in the prompt; press enter again to run it`;
	if (action.kind === "prefix") return `enter starts your message with ${entry.name}`;
	return `enter adds ${entry.name} to your message`;
}
