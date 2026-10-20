import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

/**
 * SINK GUARD: a widget row is ONE terminal line. Newlines/tabs/control chars
 * in segment text are width-0 to truncateToWidth but move the real cursor —
 * the TUI-desync (screen smear) class. Flatten them; keep \x1b so ANSI
 * colors in segments stay intact.
 */
export function flattenSegmentText(text: string): string {
	return text
		.replace(/[\r\n\t\v\f]+/g, " ")
		.replace(/[\x00-\x08\x0e-\x1a\x1c-\x1f\x7f]+/g, "");
}

export interface RowParts {
	left: string;
	center?: string;
	right?: string;
}

export const MIN_GAP = 2;

/** `…/Code stuff/ghosttyyy (main)`: plain text cut from the start, for paths whose end is the part that matters. */
export function keepEnd(text: string, width: number): string {
	if (visibleWidth(text) <= width) return text;
	if (width < 2) return "";
	const chars = Array.from(text);
	while (chars.length > 0 && visibleWidth(chars.join("")) > width - 1) chars.shift();
	return `…${chars.join("")}`;
}

/**
 * One line of exactly `width` columns: left flush left, right flush right,
 * center in the space between. The center gives way first, then the right;
 * the left is cut only when it alone is wider than the line.
 */
export function layoutRow(parts: RowParts, width: number): string {
	if (width <= 0) return "";
	let left = flattenSegmentText(parts.left);
	let center = flattenSegmentText(parts.center ?? "");
	let right = flattenSegmentText(parts.right ?? "");

	if (visibleWidth(left) > width) left = truncateToWidth(left, width, "…");
	const leftWidth = visibleWidth(left);
	const rightRoom = Math.max(0, width - leftWidth - (leftWidth > 0 ? MIN_GAP : 0));
	if (visibleWidth(right) > rightRoom) right = rightRoom > 1 ? truncateToWidth(right, rightRoom, "…") : "";
	const rightWidth = visibleWidth(right);

	const centerRoom = width - leftWidth - rightWidth - (leftWidth > 0 ? MIN_GAP : 0) - (rightWidth > 0 ? MIN_GAP : 0);
	if (centerRoom < 1 || !center) center = "";
	else if (visibleWidth(center) > centerRoom) center = truncateToWidth(center, centerRoom, "…");
	const centerWidth = visibleWidth(center);

	const free = width - leftWidth - centerWidth - rightWidth;
	const before = centerWidth > 0 ? Math.floor(free / 2) : free;
	const after = free - before;
	return truncateToWidth(left + " ".repeat(before) + center + " ".repeat(after) + right, width);
}
