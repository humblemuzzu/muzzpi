import type { Styler } from "../tools/lib/agent-layout";
import { type CacheView, cacheLifetime, compactCacheText, fullCacheText } from "./cache-line";
import { MIN_GAP, keepEnd, layoutRow } from "./widget-row";
import { visibleWidth } from "@mariozechner/pi-tui";

export interface MetaSource {
	detail(): boolean;
	running(): boolean;
	cache(): CacheView | undefined;
	/** the working tree's diff summary, painted */
	changes(): string;
	/** other extensions' setStatus() texts, painted */
	statuses(): string;
	/** detail view, second row: context, provider, run figures */
	session(): string;
	/** detail view, second row: the full cwd and branch, plain text */
	place(): string;
}

const TICK_MS = 1000;
const INSET = 3;

/**
 * The one line under the prompt box: cache on the left, other extensions'
 * statuses in the middle, the working tree's changes on the right. The detail
 * view adds the full cache meter and a second row with the session figures.
 */
export class MetaRow {
	private cached: { key: string; lines: string[] } | undefined;
	private timer: ReturnType<typeof setInterval> | undefined;
	private lastCacheText = "";
	private disposed = false;

	constructor(
		private readonly source: MetaSource,
		private readonly paint: Styler,
		private readonly tui: { requestRender(): void },
		private readonly now: () => number = Date.now,
	) {}

	invalidate(): void {
		this.cached = undefined;
	}

	dispose(): void {
		this.disposed = true;
		this.stopTimer();
	}

	render(width: number): string[] {
		const detail = this.source.detail();
		const cacheText = this.cacheText(detail);
		this.lastCacheText = cacheText;
		const changes = this.source.changes();
		const statuses = this.source.statuses();
		const session = detail ? this.source.session() : "";
		const place = detail ? this.source.place() : "";
		const key = [width, cacheText, changes, statuses, session, place].join("\u0000");
		if (this.cached?.key === key) return this.cached.lines;

		const lines: string[] = [];
		if (cacheText || changes || statuses) lines.push(this.inset({ left: cacheText, center: statuses, right: changes }, width));
		if (session || place) {
			const room = this.innerWidth(width) - visibleWidth(session) - (session ? MIN_GAP : 0);
			lines.push(this.inset({ left: session, right: this.paint.fg("dim", keepEnd(place, room)) }, width));
		}
		this.cached = { key, lines };
		return lines;
	}

	/** Starts or stops the countdown tick; call after anything that feeds it changes. */
	sync(): void {
		if (this.disposed) return;
		if (this.counting()) {
			if (this.timer) return;
			this.timer = setInterval(() => this.tick(), TICK_MS);
			this.timer.unref?.();
		} else {
			this.stopTimer();
		}
		this.tui.requestRender();
	}

	private innerWidth(width: number): number {
		return width < INSET * 2 + 10 ? width : width - INSET * 2;
	}

	private inset(parts: { left: string; center?: string; right?: string }, width: number): string {
		const inner = this.innerWidth(width);
		if (inner === width) return layoutRow(parts, width);
		const pad = " ".repeat(INSET);
		return pad + layoutRow(parts, inner) + pad;
	}

	private cacheText(detail: boolean): string {
		const view = this.source.cache();
		if (!view) return "";
		const now = this.now();
		return detail ? fullCacheText(view, now, this.paint) : compactCacheText(view, now, this.source.running(), this.paint);
	}

	private counting(): boolean {
		const view = this.source.cache();
		if (!view) return false;
		if (this.source.running() && !this.source.detail()) return false;
		return (cacheLifetime(view, this.now())?.remaining ?? 0) > 0;
	}

	private stopTimer(): void {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = undefined;
	}

	/** A timer body must never throw: after session replacement pi exits on an uncaughtException. */
	private tick(): void {
		try {
			if (!this.counting()) this.stopTimer();
			if (this.cacheText(this.source.detail()) !== this.lastCacheText) this.tui.requestRender();
		} catch {
			this.stopTimer();
		}
	}
}
