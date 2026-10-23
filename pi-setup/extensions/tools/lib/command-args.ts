/**
 * The words a slash command takes after its name, parsed the same way by every
 * command: case-insensitive, aliases allowed, and an unknown word is an error
 * that names the right ones, never a guess.
 */

export interface Suggestion {
	value: string;
	description?: string;
}

export interface Word {
	name: string;
	aliases?: readonly string[];
	/** shown beside the word as you type it */
	description: string;
	/** suggestions for what follows the word, given what is typed after it so far */
	next?: (rest: string) => readonly Suggestion[];
}

export interface CompletionItem {
	value: string;
	label: string;
	description?: string;
}

export interface SplitArgs {
	/** the first word, lowercased */
	word: string;
	/** everything after it, trimmed, case kept */
	rest: string;
}

export function splitArgs(args: string | undefined): SplitArgs {
	const text = (args ?? "").trim();
	const space = text.search(/\s/);
	if (space === -1) return { word: text.toLowerCase(), rest: "" };
	return { word: text.slice(0, space).toLowerCase(), rest: text.slice(space).trim() };
}

export function findWord<T extends Word>(words: readonly T[], word: string): T | undefined {
	const wanted = word.toLowerCase();
	return words.find((w) => w.name === wanted || w.aliases?.includes(wanted));
}

export function unknownWord(command: string, word: string, words: readonly Word[]): string {
	const known = words.map((w) => w.name).join(", ");
	return `/${command} has no "${word}". Try: ${known}, or /${command} on its own for the menu.`;
}

/**
 * Drops an item that is exactly what is already typed: with a suggestion open,
 * enter accepts it instead of sending, so the command would need a second enter.
 */
export function withoutTyped<T extends { value: string }>(items: T[], typed: string): T[] | null {
	const text = typed.trim().toLowerCase();
	const left = items.filter((item) => item.value.trim().toLowerCase() !== text);
	return left.length > 0 ? left : null;
}

/**
 * pi replaces the whole argument text with the chosen item, so every value is
 * the full text from the first word on.
 */
export function completeWords(words: readonly Word[], typed: string): CompletionItem[] | null {
	const text = typed.trimStart();
	const space = text.search(/\s/);
	if (space === -1) {
		const prefix = text.toLowerCase();
		const items = words
			.filter((w) => w.name.startsWith(prefix))
			.map((w) => ({ value: w.next ? `${w.name} ` : w.name, label: w.name, description: w.description }));
		return withoutTyped(items, text);
	}
	const word = findWord(words, text.slice(0, space));
	if (!word?.next) return null;
	const rest = text.slice(space).trimStart();
	const prefix = rest.toLowerCase();
	const items = word.next(rest)
		.filter((s) => s.value.toLowerCase().startsWith(prefix))
		.map((s) => ({ value: `${word.name} ${s.value}`, label: s.value, ...(s.description ? { description: s.description } : {}) }));
	return withoutTyped(items, `${word.name} ${rest}`);
}
