import { describe, expect, test } from "bun:test";
import { registerRetiredCommands, retiredCommand } from "./retired-commands";

function guard() {
	let handler: any;
	const notes: string[] = [];
	registerRetiredCommands({ on: (_event: string, h: unknown) => (handler = h) } as any);
	const ctx = { ui: { notify: (text: string) => notes.push(text) } };
	return { send: (text: string, source = "interactive") => handler({ text, source }, ctx), notes };
}

describe("retired commands", () => {
	test("an old command is stopped before it reaches the model, and its words are never repeated", () => {
		const g = guard();
		expect(g.send("/psst-set STRIPE_KEY sk_live_abc123 billing")).toEqual({ action: "handled" });
		expect(g.notes).toEqual(["/psst-set is gone; use /psst add NAME (it asks for the value). Nothing was sent to the model."]);
		expect(g.notes.join("")).not.toContain("sk_live_abc123");
	});

	test("every old name maps to what replaced it; anything else goes through", () => {
		expect(retiredCommand("  /STUDIO")).toEqual({ name: "studio", use: "/theme" });
		expect(retiredCommand("/create-goal ship it")?.use).toBe("/goal strict <task>");
		expect(retiredCommand("/psst add KEY")).toBeUndefined();
		expect(retiredCommand("/studios")).toBeUndefined();
		expect(retiredCommand("talk about /studio later")).toBeUndefined();
		const g = guard();
		expect(g.send("/theme gruvbox")).toEqual({ action: "continue" });
		expect(g.send("/psst-set X y", "extension")).toEqual({ action: "continue" });
	});
});
