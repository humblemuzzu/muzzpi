import type { RunSnapshot } from "../tools/lib/agent-channel";

const LIVE = new Set(["queued", "running"]);

export const isLive = (run: RunSnapshot) => LIVE.has(run.status);

export interface Clock {
	now(): number;
	/** advances while something runs, so animated glyphs and elapsed times move. */
	frame: number;
}

export function systemClock(): Clock {
	return { now: Date.now, frame: 0 };
}

/**
 * The runs the tools extension broadcasts, one entry per conversation: a
 * continued run replaces its earlier one and keeps its messages in front of
 * its own. Extensions share no module state, so the broadcast is the only way
 * the runs arrive here.
 */
export class RunStore {
	version = 0;
	private runs = new Map<string, RunSnapshot>();
	private listeners = new Set<() => void>();

	ingest(snapshots: readonly RunSnapshot[]): void {
		const next = new Map<string, RunSnapshot>();
		for (const run of snapshots) {
			const earlier = next.get(run.id);
			next.delete(run.id);
			next.set(run.id, earlier ? { ...run, messages: [...earlier.messages, ...run.messages] } : run);
		}
		this.runs = next;
		this.version++;
		for (const listener of this.listeners) listener();
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	all(): RunSnapshot[] {
		return [...this.runs.values()];
	}

	get(id: string): RunSnapshot | undefined {
		return this.runs.get(id);
	}

	/** background runs: the ones a blocking tool row does not already show. */
	background(): RunSnapshot[] {
		return this.all().filter((run) => run.background);
	}

	live(): RunSnapshot[] {
		return this.background().filter(isLive);
	}

	/** the id that follows `id` in list order, wrapping around. */
	neighbour(id: string, step: 1 | -1): string | undefined {
		const ids = this.all().map((run) => run.id);
		if (ids.length === 0) return undefined;
		const at = ids.indexOf(id);
		return ids[(at + step + ids.length) % ids.length];
	}
}

/** running first (oldest first), then queued, then finished with the newest first. */
export function dockOrder(runs: readonly RunSnapshot[]): RunSnapshot[] {
	const rank = (run: RunSnapshot) => (run.status === "running" ? 0 : run.status === "queued" ? 1 : 2);
	return [...runs].sort((a, b) => {
		if (rank(a) !== rank(b)) return rank(a) - rank(b);
		if (rank(a) === 2) return (b.endedAt ?? 0) - (a.endedAt ?? 0);
		return (a.startedAt ?? a.queuedAt) - (b.startedAt ?? b.queuedAt);
	});
}
