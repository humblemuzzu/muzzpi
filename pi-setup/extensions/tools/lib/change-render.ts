/**
 * TUI rendering for edit and write: a call header, then the side-by-side Shiki
 * diff of `details.changes`, with a plain boxed diff until Shiki has loaded.
 */

import * as os from "node:os";
import * as path from "node:path";
import { formatBoxesWindowed, osc8Link, type BoxBlock, type BoxLine, type BoxSection, type Excerpt } from "./box-format";
import { computeDiffStats, formatStats, sumStats } from "./diff-stats";
import { createShikiDiffComponent } from "./shiki-diff";
import { getContainer, getText } from "./tui";

export interface FileChangeSummary {
	path: string;
	kind: "added" | "modified";
	diff: string;
}

function shortenPath(file: string): string {
	const home = os.homedir();
	return file.startsWith(home) ? `~${file.slice(home.length)}` : file;
}

function displayName(file: string, cwd: string): string {
	const relative = path.relative(cwd, file);
	if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return relative;
	return shortenPath(file);
}

/** pi-diff titles its view from the ---/+++ headers, so they must carry the same label as the box. */
function relabelDiff(diff: string, label: string): string {
	return diff.replace(/^--- .*$/m, `--- ${label}`).replace(/^\+\+\+ .*$/m, `+++ ${label}`);
}

function parseDiffToSections(filename: string, diffText: string): BoxSection[] {
	const blocks: BoxBlock[] = [];
	let current: BoxLine[] = [];
	let oldLine = 0;
	let newLine = 0;

	for (const line of diffText.split("\n")) {
		if (line.startsWith("--- ") || line.startsWith("+++ ")) continue;
		const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
		if (hunk) {
			if (current.length > 0) blocks.push({ lines: current });
			current = [];
			oldLine = parseInt(hunk[1]!, 10);
			newLine = parseInt(hunk[2]!, 10);
			continue;
		}
		if (line.startsWith("-")) {
			current.push({ gutter: String(oldLine++), text: line, highlight: true });
		} else if (line.startsWith("+")) {
			current.push({ gutter: String(newLine++), text: line, highlight: true });
		} else {
			current.push({ gutter: String(oldLine), text: line, highlight: false });
			oldLine++;
			newLine++;
		}
	}
	if (current.length > 0) blocks.push({ lines: current });
	return [{ header: filename, blocks }];
}

const HUNK_EXCERPTS: Excerpt[] = [
	{ focus: "head", context: 12 },
	{ focus: "tail", context: 13 },
];

export function renderChangeCall(verb: string, streamField?: string) {
	return (args: any, theme: any, context: any) => {
		const Text = getText();
		const Container = getContainer();
		const filePath = typeof args?.path === "string" && args.path ? args.path : typeof args?.file_path === "string" ? args.file_path : "...";
		const header = theme.fg("toolTitle", theme.bold(`${verb} `)) + theme.fg("dim", shortenPath(filePath));
		const streamed = streamField ? args?.[streamField] : undefined;
		if (!context?.isPartial || typeof streamed !== "string" || !streamed) {
			const text = context?.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
			text.setText(header);
			return text;
		}
		const container = new Container();
		container.addChild(new Text(header, 0, 0));
		container.addChild(new Text(streamed, 0, 0));
		return container;
	};
}

export function renderChangeResult(result: any, { expanded }: { expanded: boolean }, theme: any, context: any) {
	const Container = getContainer();
	const Text = getText();
	const container = context?.lastComponent ?? new Container();
	container.clear();

	const changes: FileChangeSummary[] = result.details?.changes ?? [];
	if (changes.length === 0) {
		const text = (result.content ?? [])
			.filter((part: any) => part.type === "text")
			.map((part: any) => part.text)
			.join("\n");
		container.addChild(new Text(theme.fg("dim", text || "(no changes)"), 0, 0));
		return container;
	}

	const cwd: string = context?.cwd ?? process.cwd();
	for (const change of changes) {
		const display = displayName(change.path, cwd);
		const sections = parseDiffToSections(display, change.diff);
		container.addChild(new Text(formatStats(sumStats([computeDiffStats(sections)]), theme), 0, 0));
		const linked = change.path.startsWith("/") ? osc8Link(`file://${change.path}`, display) : display;
		const fallback = (width: number): string[] =>
			formatBoxesWindowed(
				sections.map((s) => ({
					...s,
					header: linked,
					blocks: !expanded && s.blocks.length > 1 ? s.blocks.slice(-1) : s.blocks,
				})),
				{ maxSections: 1, excerpts: HUNK_EXCERPTS },
				undefined,
				width,
			).split("\n");
		container.addChild(
			createShikiDiffComponent({
				diffText: relabelDiff(change.diff, display),
				filePath: change.path,
				expanded,
				split: true,
				fallback,
				invalidate: context?.invalidate,
			}),
		);
	}
	return container;
}
