/**
 * Catches a model stuck repeating itself mid-reply, by Factory Droid's rule: over
 * the last 4096 characters, a unit of at most 60 characters repeated 4+ times
 * across 180+ characters, or one of at most 1024 repeated 3+ times across 1024+.
 * A unit with no letter or digit (a `────` rule, a `|---|` table row) is not
 * counted: those repeat on purpose.
 */

const TAIL_CHARS = 4096;
const CHECK_EVERY_CHARS = 256;
const MAX_PERIOD = 1024;

export function repetitionAtEnd(text: string): { period: number; reps: number } | undefined {
	const tail = text.slice(-TAIL_CHARS);
	for (let period = 1; period <= MAX_PERIOD && period * 3 <= tail.length; period++) {
		const unit = tail.slice(-period);
		if (!/[\p{L}\p{N}]/u.test(unit)) continue;
		let reps = 1;
		while ((reps + 1) * period <= tail.length && tail.slice(-(reps + 1) * period, -reps * period) === unit) reps++;
		const covered = reps * period;
		if ((period <= 60 && reps >= 4 && covered >= 180) || (reps >= 3 && covered >= 1024)) return { period, reps };
	}
	return undefined;
}

/** fed one streamed reply's deltas; says when the reply has started repeating itself */
export class RepetitionWatch {
	private tail = "";
	private sinceCheck = 0;
	private kind = "";

	reset(): void {
		this.tail = "";
		this.sinceCheck = 0;
	}

	/** `kind` (thinking or text): a switch starts a fresh tail, so the two never join into one repeat */
	feed(delta: string, kind = "text"): boolean {
		if (kind !== this.kind) {
			this.reset();
			this.kind = kind;
		}
		this.tail = (this.tail + delta).slice(-TAIL_CHARS);
		this.sinceCheck += delta.length;
		if (this.sinceCheck < CHECK_EVERY_CHARS) return false;
		this.sinceCheck = 0;
		return repetitionAtEnd(this.tail) !== undefined;
	}
}
