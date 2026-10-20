import type { Styler } from "./agent-layout";

const code = (color: string) => 31 + ([...color].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 7);

/** A stand-in for pi's Theme that really emits ANSI, so widths are measured as in a terminal. */
export const theme: Styler & { bg(color: string, text: string): string } = {
	fg: (color, text) => `\u001b[${code(color)}m${text}\u001b[39m`,
	bg: (_color, text) => text,
	bold: (text) => `\u001b[1m${text}\u001b[22m`,
};
