/** diff statistics (`+3 ~1 -2`) shared by the file-mutating tools. */

import type { BoxSection } from "./box-format";

export interface DiffStats {
	added: number;
	removed: number;
	modified: number;
}

/**
 * compute +added/~modified/-removed from diff lines.
 *
 * adjacent `-` then `+` runs are paired as MODIFICATIONS rather than counted
 * as a separate delete and add, because that is what a human sees: a changed
 * line is one change, not two. the min of the two run lengths is `~modified`
 * and the excess falls back to pure `+`/`-`.
 */
export function computeDiffStats(sections: BoxSection[]): DiffStats {
	let added = 0;
	let removed = 0;
	let modified = 0;

	for (const section of sections) {
		for (const block of section.blocks) {
			let i = 0;
			while (i < block.lines.length) {
				const line = block.lines[i];
				if (line.text.startsWith("-")) {
					let delCount = 0;
					while (i < block.lines.length && block.lines[i].text.startsWith("-")) {
						delCount++;
						i++;
					}
					let addCount = 0;
					while (i < block.lines.length && block.lines[i].text.startsWith("+")) {
						addCount++;
						i++;
					}
					const paired = Math.min(delCount, addCount);
					modified += paired;
					removed += delCount - paired;
					added += addCount - paired;
				} else if (line.text.startsWith("+")) {
					added++;
					i++;
				} else {
					i++;
				}
			}
		}
	}

	return { added, removed, modified };
}

/** render stats as the familiar `+3 ~1 -2`, omitting zero categories. */
export function formatStats(stats: DiffStats, theme: any): string {
	const parts: string[] = [];
	if (stats.added > 0) parts.push(theme.fg("toolDiffAdded", `+${stats.added}`));
	if (stats.modified > 0) parts.push(theme.fg("warning", `~${stats.modified}`));
	if (stats.removed > 0) parts.push(theme.fg("toolDiffRemoved", `-${stats.removed}`));
	return parts.length > 0 ? parts.join(" ") : theme.fg("dim", "no changes");
}

/** sum several files' stats into one summary. */
export function sumStats(all: DiffStats[]): DiffStats {
	return all.reduce<DiffStats>(
		(acc, s) => ({
			added: acc.added + s.added,
			removed: acc.removed + s.removed,
			modified: acc.modified + s.modified,
		}),
		{ added: 0, removed: 0, modified: 0 },
	);
}
