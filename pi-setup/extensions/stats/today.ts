import fs from "node:fs/promises";
import path from "node:path";
import { truncateToWidth } from "@mariozechner/pi-tui";
import { type Burn, cacheHit, type Summary } from "./aggregate";
import { duration, int, money, pct } from "./draw";

export interface StatsSettings {
	widget: boolean;
	budget?: number;
}

const settingsFile = (dir: string) => path.join(dir, "settings.json");

export async function readSettings(dir: string): Promise<StatsSettings> {
	try {
		const raw = JSON.parse(await fs.readFile(settingsFile(dir), "utf8"));
		const budget = Number(raw?.budget);
		return { widget: raw?.widget === true, budget: Number.isFinite(budget) && budget > 0 ? budget : undefined };
	} catch {
		return { widget: false };
	}
}

export async function writeSettings(dir: string, settings: StatsSettings): Promise<void> {
	await fs.mkdir(dir, { recursive: true, mode: 0o700 });
	const file = settingsFile(dir);
	const tmp = `${file}.${process.pid}.tmp`;
	await fs.writeFile(tmp, JSON.stringify(settings), { mode: 0o600 });
	await fs.rename(tmp, file);
}

/** "today $42.10 · 94% cache · 3 commits · 2h 10m · MTD 34% of $500". */
export function todayText(s: Summary, month?: Burn): string {
	const commits = s.commits.length;
	const parts = [
		`today ${money(s.cost)}`,
		`${pct(cacheHit(s.usage), 0)} cache`,
		`${int(commits)} ${commits === 1 ? "commit" : "commits"}`,
		s.activeMs > 0 ? duration(s.activeMs) : "0m",
	];
	if (month?.budget) parts.push(`MTD ${pct(month.spent / month.budget, 0)} of ${money(month.budget)}`);
	return parts.join(" · ");
}

/** One terminal row: control characters flattened (a newline would move the cursor), then clamped to `width`. */
export function widgetLine(text: string, width: number): string {
	const flat = text.replace(/[\r\n\t\v\f]+/g, " ").replace(/[\x00-\x08\x0e-\x1a\x1c-\x1f\x7f]+/g, "");
	return width > 0 ? truncateToWidth(flat, width) : "";
}
