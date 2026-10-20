import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

export interface Styler {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

/**
 * `left` and `right` on one line, `right` flush to the edge. `left` gives way
 * first, down to `minLeft` columns; below that `right` does not fit and is returned apart.
 */
export function justify(left: string, right: string, width: number, minLeft: number): { line: string; right?: string } {
	if (!right) return { line: truncateToWidth(left, width) };
	const room = width - visibleWidth(right) - 2;
	if (room < minLeft) return { line: truncateToWidth(left, width), right };
	const fitted = truncateToWidth(left, room);
	return { line: fitted + " ".repeat(width - visibleWidth(fitted) - visibleWidth(right)) + right };
}

export function padRight(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

/** A component's lines per width, rebuilt only for a new width or after invalidate(). */
export abstract class CachedLines {
	private width = -1;
	private lines: string[] = [];

	protected abstract build(width: number): string[];

	render(width: number): string[] {
		if (width !== this.width) {
			this.width = width;
			this.lines = this.build(width).map((line) => (visibleWidth(line) > width ? truncateToWidth(line, width) : line));
		}
		return this.lines;
	}

	invalidate(): void {
		this.width = -1;
	}
}
