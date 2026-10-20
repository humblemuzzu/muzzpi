import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

export interface BorderSegment {
	text: string;
	/** When the line is too narrow, the lowest priority goes first. */
	priority: number;
}

export interface BorderStyle {
	left: string;
	right: string;
	horizontal: string;
	/** paints the border chrome: corners, dashes and the separators between segments */
	chrome: (text: string) => string;
}

const SEPARATOR = " · ";
const SEPARATOR_WIDTH = visibleWidth(SEPARATOR);

function blockWidth(segments: readonly BorderSegment[]): number {
	if (segments.length === 0) return 0;
	return segments.reduce((sum, segment) => sum + visibleWidth(segment.text), 0) + SEPARATOR_WIDTH * (segments.length - 1) + 2;
}

function lowestPriorityIndex(segments: readonly BorderSegment[]): number {
	let index = 0;
	for (let i = 1; i < segments.length; i++) {
		if (segments[i]!.priority <= segments[index]!.priority) index = i;
	}
	return index;
}

/**
 * `╭─ left · labels ───────── right · labels ─╮`, exactly `width` columns wide.
 * Segments that do not fit are dropped whole, lowest priority first, so a
 * narrow terminal loses the least useful label instead of every label; the
 * last one left is truncated.
 */
export function layoutBorder(width: number, style: BorderStyle, left: readonly BorderSegment[], right: readonly BorderSegment[]): string {
	const inner = width - 4;
	const all = [...left.map((segment) => ({ segment, side: "left" as const })), ...right.map((segment) => ({ segment, side: "right" as const }))];
	const kept = () => ({
		left: all.filter((item) => item.side === "left").map((item) => item.segment),
		right: all.filter((item) => item.side === "right").map((item) => item.segment),
	});
	const need = () => {
		const sides = kept();
		const gap = sides.left.length > 0 && sides.right.length > 0 ? 1 : 0;
		return blockWidth(sides.left) + blockWidth(sides.right) + gap;
	};

	while (all.length > 1 && need() > inner) {
		all.splice(lowestPriorityIndex(all.map((item) => item.segment)), 1);
	}
	if (all.length === 1 && need() > inner) {
		const room = inner - 2;
		if (room < 1) all.length = 0;
		else all[0] = { ...all[0]!, segment: { ...all[0]!.segment, text: truncateToWidth(all[0]!.segment.text, room, "…") } };
	}

	const sides = kept();
	const join = (segments: BorderSegment[]) => (segments.length === 0 ? "" : ` ${segments.map((segment) => segment.text).join(style.chrome(SEPARATOR))} `);
	const leftText = join(sides.left);
	const rightText = join(sides.right);
	const fill = Math.max(0, inner - visibleWidth(leftText) - visibleWidth(rightText));
	return (
		style.chrome(style.left + style.horizontal) +
		leftText +
		style.chrome(style.horizontal.repeat(fill)) +
		rightText +
		style.chrome(style.horizontal + style.right)
	);
}
