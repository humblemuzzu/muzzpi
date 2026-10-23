/**
 * Command names that no longer exist. pi sends an unknown /command to the model
 * as an ordinary message, and the old `/psst-set NAME value` would send a secret
 * with it, so these are stopped here, and what was typed after them is never
 * repeated or passed on.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export const RETIRED_COMMANDS: Readonly<Record<string, string>> = {
	"psst-set": "/psst add NAME (it asks for the value)",
	"psst-tag": "/psst tags",
	studio: "/theme",
	palette: "/help (or Ctrl+Shift+P)",
	mentions: "/help, which lists every @mention",
	"create-goal": "/goal strict <task>",
};

/** The replacement for a retired command at the start of `text`, if it is one. */
export function retiredCommand(text: string): { name: string; use: string } | undefined {
	const name = /^\/([a-z-]+)(?=\s|$)/i.exec(text.trimStart())?.[1]?.toLowerCase();
	const use = name ? RETIRED_COMMANDS[name] : undefined;
	return name && use ? { name, use } : undefined;
}

export function registerRetiredCommands(pi: ExtensionAPI): void {
	pi.on("input", (event, ctx) => {
		if (event.source === "extension") return { action: "continue" as const };
		const retired = retiredCommand(event.text);
		if (!retired) return { action: "continue" as const };
		ctx.ui.notify(`/${retired.name} is gone; use ${retired.use}. Nothing was sent to the model.`, "warning");
		return { action: "handled" as const };
	});
}
