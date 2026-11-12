/**
 * output buffer with fixed head + rolling tail.
 *
 * maintains constant memory regardless of output size by keeping:
 * - first N lines (head, fill once then lock)
 * - last M lines (tail, ring buffer, always rolling)
 * - total line count (for truncation message)
 *
 * used by bash tool to show beginning + end of long outputs,
 * rather than only the tail.
 */

const DEFAULT_HEAD_LINES = 50;
const DEFAULT_TAIL_LINES = 50;

/**
 * truncate an array to head + tail, returning formatted result.
 * simpler than OutputBuffer — for when you have all items upfront (not streaming).
 *
 * @param items - array to truncate
 * @param maxItems - total items to show (split evenly between head/tail)
 * @returns { head, tail, truncated, truncatedCount }
 */
export function headTail<T>(
	items: T[],
	maxItems: number = 100,
): { head: T[]; tail: T[]; truncated: T[]; truncatedCount: number } {
	const total = items.length;
	if (total <= maxItems) {
		return { head: items, tail: [], truncated: [], truncatedCount: 0 };
	}

	const half = Math.floor(maxItems / 2);
	const head = items.slice(0, half);
	const tail = items.slice(-half);
	const truncated = items.slice(half, -half);

	return { head, tail, truncated, truncatedCount: truncated.length };
}

/**
 * format head+tail arrays with truncation marker.
 * returns a single string with items joined by newlines.
 */
export function formatHeadTail<T>(
	items: T[],
	maxItems: number = 100,
	truncatedMsg: (count: number) => string = (n) => `... [${n} lines truncated] ...`,
): string {
	const { head, tail, truncatedCount } = headTail(items, maxItems);

	if (truncatedCount === 0) {
		return head.map(String).join("\n");
	}

	const parts = [
		...head.map(String),
		"",
		truncatedMsg(truncatedCount),
		"",
		...tail.map(String),
	];

	return parts.join("\n");
}

/**
 * truncate raw text to head + tail by characters.
 * for when you have a single string (not lines) that needs truncation.
 */
export function headTailChars(
	text: string,
	maxChars: number = 64_000,
	note?: string,
): { text: string; truncated: boolean; totalChars: number } {
	const total = text.length;
	if (total <= maxChars) {
		return { text, truncated: false, totalChars: total };
	}

	const half = Math.floor(maxChars / 2);
	const head = text.slice(0, half);
	const tail = text.slice(-half);
	const truncated = total - maxChars;

	return {
		text: `${head}\n\n... [${truncated} characters truncated${note ? `; ${note}` : ""}] ...\n\n${tail}`,
		truncated: true,
		totalChars: total,
	};
}

export class OutputBuffer {
	private head: string[] = [];
	private tail: string[] = [];
	private headComplete = false;
	private pendingLine = "";
	totalLines = 0;

	constructor(
		private maxHead: number = DEFAULT_HEAD_LINES,
		private maxTail: number = DEFAULT_TAIL_LINES,
	) {}

	/**
	 * add a chunk of output. handles partial lines at boundaries.
	 * chunks may end mid-line, so we buffer the incomplete part.
	 */
	add(chunk: string): void {
		// prepend any pending partial line from previous chunk
		const text = this.pendingLine + chunk;
		const lines = text.split("\n");

		// last element might be incomplete (no trailing newline)
		// keep it for the next chunk
		this.pendingLine = lines.pop() ?? "";

		for (const line of lines) {
			this.totalLines++;
			this.addLine(line);
		}
	}

	/**
	 * add a complete line to the appropriate buffer.
	 * fills head first, then rolls tail.
	 */
	private addLine(line: string): void {
		if (!this.headComplete && this.head.length < this.maxHead) {
			this.head.push(line);
			if (this.head.length === this.maxHead) {
				this.headComplete = true;
			}
		}

		// always add to tail (handles small-output dedupe in format())
		this.tail.push(line);
		if (this.tail.length > this.maxTail) {
			this.tail.shift();
		}
	}

	/**
	 * format the current output without consuming the pending partial line.
	 *
	 * streaming callers use this so a fast command that writes many partial
	 * chunks does not turn every chunk boundary into a fake line.
	 */
	preview(): { text: string; truncatedLines: number } {
		return this.formatLines(this.pendingLine ? 1 : 0, this.pendingLine);
	}

	/** the last `count` lines so far (at most the tail it keeps), the unfinished one included */
	lastLines(count: number): string[] {
		const lines = this.pendingLine ? [...this.tail, this.pendingLine] : this.tail;
		return lines.slice(-count);
	}

	/**
	 * finalize and format the output.
	 * returns the formatted text and count of truncated lines.
	 *
	 * small output (<= head + tail): dedupes overlap, no truncation marker
	 * large output: head + marker + tail
	 *
	 * `fullOutputPath` is asked only when lines are actually dropped; a path it
	 * returns is named in the marker so the middle can still be read.
	 */
	format(fullOutputPath?: () => string | undefined): { text: string; truncatedLines: number } {
		// flush any remaining pending line
		if (this.pendingLine) {
			this.totalLines++;
			this.addLine(this.pendingLine);
			this.pendingLine = "";
		}

		return this.formatLines(0, undefined, fullOutputPath);
	}

	private formatLines(
		extraLines: number,
		pendingLine?: string,
		fullOutputPath?: () => string | undefined,
	): { text: string; truncatedLines: number } {
		const allLines = this.totalLines + extraLines;

		// no truncation needed: output fits in head + tail combined
		if (allLines <= this.maxHead + this.maxTail) {
			// dedupe: when output is small, tail contains head entirely
			// or tail starts within head region
			const uniqueLines = this.dedupe(this.totalLines);
			if (pendingLine) uniqueLines.push(pendingLine);
			return { text: uniqueLines.join("\n"), truncatedLines: 0 };
		}

		// truncation: head + marker + tail
		const truncated = allLines - this.head.length - this.tail.length;
		const tail = pendingLine ? [...this.tail.slice(1), pendingLine] : this.tail;
		const file = fullOutputPath?.();
		const parts = [
			...this.head,
			"",
			file ? `... [${truncated} lines truncated; full output: ${file}] ...` : `... [${truncated} lines truncated] ...`,
			"",
			...tail,
		];

		return { text: parts.join("\n"), truncatedLines: truncated };
	}

	/**
	 * deduplicate overlapping head/tail for small outputs.
	 *
	 * when total lines <= maxHead + maxTail, the tail buffer
	 * may contain lines already in head. the overlap is positional: the tail
	 * holds the last tail.length lines, so it starts at totalLines - tail.length.
	 * matching it by content breaks on repeated lines (blank lines, `}`).
	 */
	private dedupe(totalLines: number): string[] {
		// copies: preview() appends its pending line to the result, which must
		// never reach the buffers themselves.
		if (totalLines <= this.maxHead) {
			return [...this.head];
		}

		if (totalLines <= this.maxTail) {
			return [...this.tail];
		}

		return [...this.head.slice(0, totalLines - this.tail.length), ...this.tail];
	}

	/**
	 * get current buffer state for debugging.
	 */
	debug(): { head: string[]; tail: string[]; totalLines: number; pendingLine: string } {
		return {
			head: [...this.head],
			tail: [...this.tail],
			totalLines: this.totalLines,
			pendingLine: this.pendingLine,
		};
	}
}
