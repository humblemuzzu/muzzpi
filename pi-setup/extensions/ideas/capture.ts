import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { type Capture, lastUserPrompt, sessionNameFrom } from "./store";

export interface HerdrPane {
	cwd?: string;
	agent?: string;
	agent_status?: string;
	agent_session?: { kind?: string; value?: string };
}

export function paneFromJson(json: string): HerdrPane | undefined {
	try {
		const pane = (JSON.parse(json) as { result?: { pane?: HerdrPane } }).result?.pane;
		return pane && typeof pane === "object" ? pane : undefined;
	} catch {
		return undefined;
	}
}

function readSessionEntries(file: string): object[] {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return [];
	}
	const entries: object[] = [];
	for (const line of text.split("\n")) {
		if (!line.includes('"role":"user"') && !line.includes('"type":"session_info"')) continue;
		try {
			entries.push(JSON.parse(line) as object);
		} catch {}
	}
	return entries;
}

export function captureFromPane(pane: HerdrPane | undefined): Capture {
	const capture: Capture = { source: "herdr" };
	if (!pane?.agent) return capture;
	capture.agentBusy = pane.agent_status === "working";
	const file = pane.agent === "pi" && pane.agent_session?.kind === "path" ? pane.agent_session.value : undefined;
	if (!file) return capture;
	const entries = readSessionEntries(file);
	const id = /_([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/i.exec(file)?.[1] ?? basename(file, ".jsonl");
	const name = sessionNameFrom(entries);
	capture.session = name ? { id, file, name } : { id, file };
	const prompt = lastUserPrompt(entries);
	if (prompt) capture.lastPrompt = prompt;
	return capture;
}
