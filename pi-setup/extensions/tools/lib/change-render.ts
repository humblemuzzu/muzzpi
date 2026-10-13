/**
 * TUI rendering for edit and write: a call header, then a boxed, colored diff
 * of `details.changes`, rendered once per width.
 */

import * as os from "node:os";
import * as path from "node:path";
import { boxRendererWindowed, osc8Link, type BoxBlock, type BoxLine, type BoxSection, type BoxWindowedOpts, type Excerpt } from "./box-format";
import { computeDiffStats, formatStats, sumStats } from "./diff-stats";
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
const DIFF_BOX: BoxWindowedOpts = { maxSections: 1, excerpts: HUNK_EXCERPTS };

function colorLine(line: BoxLine, theme: any): BoxLine {
	if (!line.highlight) return line;
	return { ...line, text: theme.fg(line.text.startsWith("+") ? "toolDiffAdded" : "toolDiffRemoved", line.text) };
}

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
		const build = (): BoxSection[] =>
			sections.map((s) => ({
				header: linked,
				blocks: (!expanded && s.blocks.length > 1 ? s.blocks.slice(-1) : s.blocks).map((b) => ({
					lines: b.lines.map((line) => colorLine(line, theme)),
				})),
			}));
		container.addChild(boxRendererWindowed(build, { collapsed: DIFF_BOX, expanded: DIFF_BOX }));
	}
	return container;
}
