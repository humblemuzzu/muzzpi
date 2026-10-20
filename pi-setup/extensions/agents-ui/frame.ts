import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { padRight, type Styler } from "../tools/lib/agent-layout";

const CHROME_ROWS = 7;
const MIN_FRAMED_WIDTH = 24;

interface FrameParts {
	title: string;
	body: string[];
	input: string;
	hints: string;
}

/** The inner width a framed screen offers its content at `width` columns. */
export const innerWidth = (width: number) => (width >= MIN_FRAMED_WIDTH ? width - 4 : width);

export const bodyRows = (height: number) => Math.max(1, height - CHROME_ROWS);

/**
 * A full-screen takeover: a box with a title row, a body, an input row and a
 * hint row. Exactly `height` lines, each exactly `width` wide, so it covers the
 * transcript behind it completely.
 */
export function frameScreen(parts: FrameParts, width: number, height: number, theme: Styler): string[] {
	const framed = width >= MIN_FRAMED_WIDTH;
	const inner = innerWidth(width);
	const edge = (text: string) => theme.fg("borderMuted", text);
	const row = (content: string) => {
		const body = padRight(truncateToWidth(content, inner), inner);
		return framed ? `${edge("│")} ${body} ${edge("│")}` : body;
	};
	const rule = (left: string, right: string) => (framed ? edge(`${left}${"─".repeat(width - 2)}${right}`) : edge("─".repeat(width)));
	const body = parts.body.slice(0, bodyRows(height));
	while (body.length < bodyRows(height)) body.push("");
	return [rule("╭", "╮"), row(parts.title), rule("├", "┤"), ...body.map(row), rule("├", "┤"), row(parts.input), row(parts.hints), rule("╰", "╯")]
		.slice(0, Math.max(1, height))
		.map((line) => (visibleWidth(line) > width ? truncateToWidth(line, width) : line));
}

/** The first of `tiers` (longest first) that fits `width`; the last one is kept when none does. */
export function fitHint(tiers: string[], width: number, paint: (text: string) => string): string {
	const fitting = tiers.find((tier) => visibleWidth(tier) <= width) ?? tiers.at(-1) ?? "";
	return paint(fitting);
}
