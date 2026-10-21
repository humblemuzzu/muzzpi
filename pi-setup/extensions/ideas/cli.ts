import { execFile } from "node:child_process";
import { createInterface, emitKeypressEvents } from "node:readline";
import { captureFromPane, type HerdrPane, paneFromJson } from "./capture";
import { addIdea, ideasDir, loadAll, openCount, parseInput, resolveWhere } from "./store";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const SAVED_PAUSE_MS = 900;

function herdrPane(id: string): Promise<HerdrPane | undefined> {
	return new Promise((resolve) => {
		execFile(process.env.HERDR_BIN_PATH || "herdr", ["pane", "get", id], { timeout: 3000 }, (error, stdout) => resolve(error ? undefined : paneFromJson(stdout)));
	});
}

async function prompt(): Promise<void> {
	const paneId = process.env.HERDR_ACTIVE_PANE_ID;
	const cwd = process.env.HERDR_ACTIVE_PANE_CWD || process.cwd();
	const [where, pane] = await Promise.all([resolveWhere(cwd), paneId ? herdrPane(paneId) : Promise.resolve(undefined)]);
	const target = where.isHarness ? "the harness" : where.project;
	const hint = where.isHarness ? "bug: or dislike: in front sets the kind" : "pi: in front files it under the harness · bug: or dislike: sets the kind";

	process.stdout.write(`\n  ${BOLD}idea for ${target}${RESET}\n  ${DIM}${hint} · enter saves · esc cancels${RESET}\n\n`);
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	emitKeypressEvents(process.stdin, rl);
	process.stdin.on("keypress", (_text, key: { name?: string } | undefined) => {
		if (key?.name === "escape") process.exit(0);
	});
	rl.on("SIGINT", () => process.exit(0));
	rl.on("close", () => process.exit(0));

	rl.question("  › ", (answer) => {
		const input = parseInput(answer);
		if (!input.text) process.exit(0);
		try {
			const dir = ideasDir();
			const idea = addIdea(dir, where, input, captureFromPane(pane));
			const all = loadAll(dir);
			const harness = idea.scope === "harness";
			const open = openCount(all, harness ? { root: "", isHarness: true } : where);
			const back = harness && !where.isHarness ? ` · back to ${where.project}` : "";
			process.stdout.write(`\n  saved to ${harness ? "harness" : where.project} · ${open} open${back}\n`);
			rl.removeAllListeners("close");
			rl.close();
			setTimeout(() => process.exit(0), SAVED_PAUSE_MS);
		} catch (error) {
			process.stdout.write(`\n  not saved: ${error instanceof Error ? error.message : String(error)}\n  press enter to close`);
			rl.removeAllListeners("close");
			rl.question("", () => process.exit(1));
		}
	});
}

if (process.argv[2] === "prompt") {
	void prompt();
} else {
	process.stderr.write("usage: cli.js prompt   (the /idea capture box, run by herdr-idea)\n");
	process.exit(2);
}
