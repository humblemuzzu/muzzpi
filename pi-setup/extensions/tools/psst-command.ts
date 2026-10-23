/** /psst: the secrets vault, one command. Values are typed into a prompt, never onto the command line. */

import * as os from "node:os";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { completeWords, findWord, splitArgs, type Suggestion, unknownWord, type Word } from "./lib/command-args";
import { askText, canShowMenu, type MenuItem, type MenuSpec, menuAsText, showMenu } from "./lib/command-menu";
import {
	findVault,
	getActiveTags,
	listVaultEntries,
	saveSecret,
	setActiveTags,
	type VaultEntry,
	type VaultLocation,
} from "./lib/psst";

const NAME = /^[A-Z][A-Z0-9_]*$/;

const NO_VAULT = "No psst vault yet. Create one in a terminal: `psst init` for this project, or `psst init --global` for everywhere.";

function vaultPlace(vault: VaultLocation): string {
	const home = os.homedir();
	const dir = vault.dir.startsWith(home) ? `~${vault.dir.slice(home.length)}` : vault.dir;
	return `${dir} (${vault.global ? "global" : "this project"})`;
}

function plural(n: number, one: string, many = `${one}s`): string {
	return `${n} ${n === 1 ? one : many}`;
}

function tagsIn(entries: readonly VaultEntry[]): string[] {
	return [...new Set(entries.flatMap((e) => e.tags))].sort();
}

/** "a, b c" → ["a", "b", "c"]; commas and spaces both separate. */
export function parseTagList(text: string): string[] {
	return [...new Set(text.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean))];
}

export type TagFilterResult = { ok: true; tags: string[]; offered: number } | { ok: false; message: string };

/** A tag no secret has would quietly offer the agent nothing, so it is refused, naming the real ones. */
export function checkTagFilter(wanted: readonly string[], entries: readonly VaultEntry[]): TagFilterResult {
	const known = tagsIn(entries);
	const unknown = wanted.filter((tag) => !known.includes(tag));
	if (unknown.length > 0) {
		const list = known.length > 0 ? `Tags in your vault: ${known.join(", ")}.` : "No secret in your vault has a tag yet.";
		return { ok: false, message: `No secret has the tag ${unknown.map((t) => `"${t}"`).join(", ")}. ${list}` };
	}
	const offered = entries.filter((e) => e.tags.some((tag) => wanted.includes(tag))).length;
	return { ok: true, tags: [...wanted], offered };
}

/** Secret names are capitals, digits and _; a lowercase name is accepted and raised. */
export function normalizeSecretName(raw: string): string | undefined {
	const name = raw.trim().toUpperCase();
	return NAME.test(name) ? name : undefined;
}

export function psstStatus(vault: VaultLocation, entries: readonly VaultEntry[], active: readonly string[]): string[] {
	const lines = [
		`${plural(entries.length, "secret")} in ${vaultPlace(vault)}`,
		"The agent sees only names and uses values as $NAME in bash; values are hidden from all output.",
	];
	if (active.length > 0) {
		const offered = entries.filter((e) => e.tags.some((tag) => active.includes(tag))).length;
		lines.push(`Tag filter: ${active.join(", ")} (this session) · ${offered} of ${entries.length} offered to the agent`);
	}
	return lines;
}

export function psstMenu(vault: VaultLocation, entries: readonly VaultEntry[], active: readonly string[]): MenuSpec {
	const items: MenuItem[] = [
		{ id: "list", label: "See secret names", description: "Names and tags only. Values are never shown." },
		{ id: "add", label: "Add or change a secret", description: "Asks for the name, the value and optional tags." },
	];
	if (tagsIn(entries).length > 0) {
		items.push({
			id: "tags",
			label: "Offer only some tags",
			description: "For this session, the agent gets only secrets with the tags you pick. All stay hidden from output.",
		});
	}
	if (active.length > 0) items.push({ id: "all", label: "Offer every secret again", description: "Clears the tag filter." });
	return { title: "Secrets · psst", status: psstStatus(vault, entries, active), items };
}

const USAGE = [
	"/psst list         see secret names",
	"/psst add NAME     add or change a secret (asks for the value)",
	"/psst tags a,b     offer the agent only secrets with these tags, this session",
	"/psst tags off     offer every secret again",
];

export function registerPsstCommand(pi: ExtensionAPI): void {
	const tagSuggestions = (rest: string): Suggestion[] => {
		const cut = Math.max(rest.lastIndexOf(","), rest.lastIndexOf(" "));
		const before = rest.slice(0, cut + 1);
		const entries = listVaultEntries();
		const tags = tagsIn(entries).map((tag) => ({
			value: `${before}${tag}`,
			description: plural(entries.filter((e) => e.tags.includes(tag)).length, "secret"),
		}));
		return before ? tags : [{ value: "off", description: "offer every secret again" }, ...tags];
	};

	const words: Word[] = [
		{ name: "list", description: "see secret names" },
		{
			name: "add",
			aliases: ["set"],
			description: "add or change a secret",
			next: () => listVaultEntries().map((e) => ({ value: e.name, description: "replace its value" })),
		},
		{ name: "tags", aliases: ["tag"], description: "offer only some tags to the agent", next: tagSuggestions },
	];

	function list(ctx: ExtensionCommandContext, vault: VaultLocation): void {
		const entries = listVaultEntries();
		if (entries.length === 0) {
			ctx.ui.notify(`Your vault at ${vaultPlace(vault)} is empty. Add a secret with /psst add NAME.`, "info");
			return;
		}
		const active = getActiveTags();
		const lines = entries.map((e) => {
			const tags = e.tags.length > 0 ? `  [${e.tags.join(", ")}]` : "";
			const kept = active.length > 0 && !e.tags.some((tag) => active.includes(tag)) ? "  (not offered: tag filter)" : "";
			return `  • ${e.name}${tags}${kept}`;
		});
		ctx.ui.notify([...psstStatus(vault, entries, active), "", ...lines].join("\n"), "info");
	}

	async function add(ctx: ExtensionCommandContext, rawName: string): Promise<void> {
		if (!ctx.hasUI) {
			ctx.ui.notify("/psst add asks for the value in a prompt, so it needs the interactive TUI. In a shell: psst set NAME", "warning");
			return;
		}
		if (/\s/.test(rawName)) {
			return ctx.ui.notify("Type only the name after /psst add; the value is asked for next, so it never sits in the prompt. Nothing saved.", "error");
		}
		const typed = rawName || ((await askText(ctx, "Secret name", "capitals, digits and _, like STRIPE_KEY")) ?? "");
		if (!typed.trim()) return ctx.ui.notify("Nothing saved.", "info");
		const name = normalizeSecretName(typed);
		if (!name) return ctx.ui.notify("That can't be a secret name: use capitals, digits and _, starting with a letter (like STRIPE_KEY). Nothing saved.", "error");

		const existing = listVaultEntries().find((e) => e.name === name);
		const value = await askText(ctx, `Value for ${name}${existing ? " (replaces the current one)" : ""}`, "shown as you type here; never sent to the model");
		if (!value) return ctx.ui.notify("Nothing saved.", "info");

		const keep = existing && existing.tags.length > 0 ? existing.tags.join(", ") : "";
		const tagText = await askText(ctx, "Tags, comma-separated (optional)", keep ? `enter on its own keeps: ${keep}; none clears them` : "enter on its own skips them");
		if (tagText === undefined) return ctx.ui.notify("Nothing saved.", "info");
		const cleared = tagText.trim().toLowerCase() === "none";
		const tags = cleared ? [] : tagText.trim() ? parseTagList(tagText) : (existing?.tags ?? []);
		const bad = tags.find((t) => t.startsWith("-"));
		if (bad) return ctx.ui.notify(`"${bad}" can't be a tag: tags can't start with "-". Nothing saved.`, "error");

		const failure = await saveSecret(name, value, tags);
		if (failure) return ctx.ui.notify(`Could not save ${name}: ${failure}`, "error");
		const tagNote = tags.length > 0 ? ` with tags ${tags.join(", ")}` : "";
		ctx.ui.notify(`Saved ${name}${tagNote}. The agent can use it as $${name} in bash.`, "info");
	}

	function applyTags(ctx: ExtensionCommandContext, wanted: readonly string[]): void {
		if (wanted.length === 0 || (wanted.length === 1 && ["off", "none", "all", "clear"].includes(wanted[0]!.toLowerCase()))) {
			setActiveTags([]);
			ctx.ui.notify("Tag filter cleared: the agent is offered every secret again.", "info");
			return;
		}
		const entries = listVaultEntries();
		const result = checkTagFilter(wanted, entries);
		if (!result.ok) return ctx.ui.notify(`${result.message} Filter unchanged.`, "error");
		setActiveTags(result.tags);
		ctx.ui.notify(
			`The agent is offered only secrets tagged ${result.tags.join(", ")} (${result.offered} of ${entries.length}) for this session. /psst tags off undoes it.`,
			"info",
		);
	}

	async function pickTags(ctx: ExtensionCommandContext): Promise<void> {
		const active = getActiveTags();
		const entries = listVaultEntries();
		const items: MenuItem[] = tagsIn(entries).map((tag) => ({
			id: `tag:${tag}`,
			label: tag,
			values: ["off", "on"],
			value: active.includes(tag) ? "on" : "off",
			note: plural(entries.filter((e) => e.tags.includes(tag)).length, "secret"),
		}));
		items.push({ id: "apply", label: "Use these tags", description: "With none turned on, every secret is offered." });
		const choice = await showMenu(ctx, { title: "Offer only some tags · this session", items, initial: "apply" });
		if (choice?.id !== "apply") return;
		applyTags(ctx, Object.entries(choice.values).filter(([, v]) => v === "on").map(([id]) => id.slice(4)));
	}

	async function menu(ctx: ExtensionCommandContext, vault: VaultLocation): Promise<void> {
		const spec = psstMenu(vault, listVaultEntries(), getActiveTags());
		if (!canShowMenu(ctx)) return ctx.ui.notify(menuAsText(spec, USAGE), "info");
		const choice = await showMenu(ctx, spec);
		if (choice?.id === "list") list(ctx, vault);
		else if (choice?.id === "add") await add(ctx, "");
		else if (choice?.id === "tags") await pickTags(ctx);
		else if (choice?.id === "all") applyTags(ctx, []);
	}

	pi.registerCommand("psst", {
		description: "Your secrets: see names, add one, or choose which the agent gets",
		getArgumentCompletions: (prefix) => completeWords(words, prefix),
		handler: async (args, ctx) => {
			const vault = findVault();
			if (!vault) return ctx.ui.notify(NO_VAULT, "info");
			const { word, rest } = splitArgs(args);
			if (!word) return menu(ctx, vault);
			const found = findWord(words, word);
			if (!found) return ctx.ui.notify(unknownWord("psst", word, words), "error");
			if (found.name === "list") return list(ctx, vault);
			if (found.name === "add") return add(ctx, rest);
			if (!rest) return canShowMenu(ctx) ? pickTags(ctx) : ctx.ui.notify(menuAsText(psstMenu(vault, listVaultEntries(), getActiveTags()), USAGE), "info");
			applyTags(ctx, parseTagList(rest));
		},
	});
}
