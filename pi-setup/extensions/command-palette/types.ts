export type HelpSection = "muzzpi" | "pi" | "prompts" | "mentions" | "skills";

/**
 * What enter does with an entry. Extension commands run straight away; pi's own
 * commands only run from the editor, so they are typed there for the user to send.
 */
export type HelpAction =
	| { kind: "run"; command: string }
	| { kind: "type"; text: string }
	| { kind: "prefix"; text: string }
	| { kind: "append"; text: string };

export interface HelpEntry {
	section: HelpSection;
	/** as the user types it: /stats, @oracle, /skill:git */
	name: string;
	description: string;
	/** the shortcut that opens it from anywhere */
	key?: string;
	action: HelpAction;
}
