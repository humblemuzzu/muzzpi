/**
 * What /help cannot read from pi itself: each extension's shortcut keys and
 * the @mentions. Extensions do not share module state, so /help asks over
 * pi.events and each extension answers with its own facts, synchronously.
 */

export const HELP_CHANNEL = "muzzpi:help";

export interface HelpShortcut {
	/** the command the key opens, without the slash */
	command: string;
	key: string;
}

export interface HelpMention {
	/** as typed, with the @ */
	text: string;
	description: string;
}

export interface HelpCollector {
	shortcut(entry: HelpShortcut): void;
	mention(entry: HelpMention): void;
}

interface HelpEvents {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
}

interface HelpHost {
	events: HelpEvents;
}

function isCollector(data: unknown): data is HelpCollector {
	const value = data as Partial<HelpCollector> | null;
	return typeof value?.shortcut === "function" && typeof value.mention === "function";
}

/** Answers every /help request with `answer`; pi drops the listener itself when the session ends. */
export function contributeHelp(pi: HelpHost, answer: (help: HelpCollector) => void): void {
	pi.events.on(HELP_CHANNEL, (data) => {
		if (isCollector(data)) answer(data);
	});
}

export interface CollectedHelp {
	shortcuts: Map<string, string>;
	mentions: HelpMention[];
}

export function collectHelp(events: HelpEvents): CollectedHelp {
	const shortcuts = new Map<string, string>();
	const mentions = new Map<string, HelpMention>();
	events.emit(HELP_CHANNEL, {
		shortcut: ({ command, key }: HelpShortcut) => shortcuts.set(command, key),
		mention: (entry: HelpMention) => mentions.set(entry.text, entry),
	} satisfies HelpCollector);
	return { shortcuts, mentions: [...mentions.values()] };
}
