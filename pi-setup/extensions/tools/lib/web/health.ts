/**
 * Which providers to skip for now, shared by every pi process through one
 * small file: a sub-agent should not pay the same 402 its parent just got.
 * Losing this file only costs one failed request per provider, so every read
 * and write failure is swallowed.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { FailureKind, ProviderError } from "./http";

export interface HealthEntry {
	kind: FailureKind;
	message: string;
	until: number;
	keyTag: string;
}

const HOLD_MS: Partial<Record<FailureKind, number>> = {
	auth: 6 * 3600_000,
	credits: 15 * 60_000,
};
/** a rate limit is held only when the provider asked for a real pause; shorter waits are cheaper to just retry. */
const MIN_RATE_LIMIT_HOLD_SEC = 10;

function holdMs(err: ProviderError): number | undefined {
	if (err.kind !== "rate_limit") return HOLD_MS[err.kind];
	const secs = err.retryAfterSec ?? 0;
	return secs >= MIN_RATE_LIMIT_HOLD_SEC ? secs * 1000 : undefined;
}

export function keyTag(key: string): string {
	return createHash("sha256").update(key).digest("hex").slice(0, 12);
}

export class ProviderHealth {
	constructor(
		private readonly file: string,
		private readonly now: () => number = Date.now,
	) {}

	/** the entry that should keep this provider out, if any. A different key clears it. */
	blocked(provider: string, key: string): HealthEntry | undefined {
		const entry = this.read()[provider];
		if (!entry || entry.until <= this.now() || entry.keyTag !== keyTag(key)) return undefined;
		return entry;
	}

	record(provider: string, key: string, err: ProviderError): void {
		const hold = holdMs(err);
		if (!hold) return;
		this.update((all) => {
			all[provider] = { kind: err.kind, message: err.message, until: this.now() + hold, keyTag: keyTag(key) };
		});
	}

	clear(provider: string): void {
		if (this.read()[provider]) this.update((all) => void delete all[provider]);
	}

	private read(): Record<string, HealthEntry> {
		try {
			const parsed = JSON.parse(fs.readFileSync(this.file, "utf-8"));
			return parsed && typeof parsed === "object" ? parsed : {};
		} catch {
			return {};
		}
	}

	private update(change: (all: Record<string, HealthEntry>) => void): void {
		try {
			const all = this.read();
			change(all);
			const now = this.now();
			for (const [id, entry] of Object.entries(all)) if (entry.until <= now) delete all[id];
			fs.mkdirSync(path.dirname(this.file), { recursive: true });
			const tmp = `${this.file}.${process.pid}.tmp`;
			fs.writeFileSync(tmp, JSON.stringify(all, null, "\t"));
			fs.renameSync(tmp, this.file);
		} catch {}
	}
}
