/**
 * /local — manage the local llama.cpp router from inside pi.
 *
 * The server command is embedded: an earlier version ran a script outside the
 * repo, and deleting that script took the extension down (bcfefc3). Every probe
 * and wait is asynchronous, since starting and loading take up to two minutes.
 *
 * For llama-local and llama.cpp only, before_agent_start REPLACES the system
 * prompt with BARE_SYSTEM_PROMPT; sub-agent children keep system-prompt.ts's.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { execFile } from "child_process";
import { closeSync, openSync, readSync, statSync } from "fs";
import * as os from "os";
import { completeWords, findWord, splitArgs, type Word } from "./tools/lib/command-args";
import { canShowMenu, type MenuItem, menuAsText, showMenu } from "./tools/lib/command-menu";
import { isLocalProvider } from "./tools/lib/local-providers";
import { SUB_AGENT_TOOLS_ENV } from "./tools/lib/sub-agent-prompt";

const PROVIDER_ID = "llama-local";
const PORT = Number(process.env.LLAMA_PORT || 8080);
const MODELS_DIR = process.env.LLAMA_MODELS_DIR || `${os.homedir()}/models`;
const CTX = Number(process.env.LLAMA_CTX || 65536);
const SLEEP_IDLE = Number(process.env.LLAMA_SLEEP_IDLE || 300);
const DEFAULT_MODEL = process.env.LLAMA_DEFAULT_MODEL || "Qwen3.8-27B-Uncensored";
const TMUX_SESSION = "llama";
const LOG_FILE = "/tmp/llama-server.log";
const LOG_LINES = 40;
const BASE = `http://127.0.0.1:${PORT}`;

const BARE_SYSTEM_PROMPT = `You are a local coding agent on the user's machine. Be brief. Use tools when needed. Do not claim work without a tool call. Two failures of the same tool → stop and report.

Tools (schemas also in the API):
- read — file or image path
- bash — shell; timeout required
- edit — exact text replacement: path + edits[{oldText,newText}]
- write — create or overwrite a whole file
- grep / find / ls — search and list
- undo_edit / redo_edit — revert or redo last edit
- format_file — prettier/biome
- skill — load a named skill
- web_search / read_web_page — web; x_search — posts on X
- screenshot — screen/window/url capture
- github tools — read_github, search_github, list_directory_github, list_repositories, glob_github, commit_search, diff
- finder / oracle / delegate / chad / librarian / code_review — sub-agents (slow on local; avoid unless asked)
- read_session / search_sessions — session history
`;

// ── process helpers ──────────────────────────────────────────────────────────
interface Result {
	ok: boolean;
	out: string;
}

function run(cmd: string, args: string[], timeout = 10_000): Promise<Result> {
	return new Promise((resolve) => {
		execFile(cmd, args, { timeout, encoding: "utf-8" }, (error, stdout, stderr) =>
			resolve({ ok: !error, out: error ? `${stdout ?? ""}${stderr ?? ""}` || error.message : (stdout ?? "") }),
		);
	});
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function fmtBytes(n: number): string {
	if (!n || n < 0) return "?";
	const gb = n / 1024 ** 3;
	return gb >= 1 ? `${gb.toFixed(2)} GB` : `${(n / 1024 ** 2).toFixed(0)} MB`;
}

function fmtCount(n: number): string {
	if (!n) return "?";
	return n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : `${(n / 1e6).toFixed(0)}M`;
}

// Explicit en-US grouping. Bare toLocaleString() follows the SYSTEM locale, which
// on this machine is en-IN and renders 128000 as "1,28,000" (lakh grouping).
function fmtNum(n: number): string {
	return n.toLocaleString("en-US");
}

// ── server state ─────────────────────────────────────────────────────────────
interface LlamaModel {
	id: string;
	status: { value: string };
	meta?: { n_ctx?: number; n_ctx_train?: number; n_params?: number; size?: number; ftype?: string };
	architecture?: { input_modalities?: string[] };
}

const tmuxAlive = async () => (await run("tmux", ["has-session", "-t", TMUX_SESSION])).ok;
const serverUp = async () => (await run("curl", ["-sf", "--max-time", "2", `${BASE}/health`])).ok;

async function listModels(): Promise<LlamaModel[]> {
	const r = await run("curl", ["-sf", "--max-time", "3", `${BASE}/models`]);
	if (!r.ok) return [];
	try {
		return JSON.parse(r.out)?.data ?? [];
	} catch {
		return [];
	}
}

async function findModel(id = DEFAULT_MODEL): Promise<LlamaModel | undefined> {
	return (await listModels()).find((m) => m.id === id);
}

async function serverRam(): Promise<string> {
	const r = await run("ps", ["-eo", "rss=,comm="]);
	const kb = r.out
		.split("\n")
		.filter((line) => line.includes("llama-server"))
		.reduce((sum, line) => sum + (Number(line.trim().split(/\s+/)[0]) || 0), 0);
	return kb > 0 ? fmtBytes(kb * 1024) : "0 MB";
}

function logTail(lines = LOG_LINES): string {
	try {
		const size = statSync(LOG_FILE).size;
		const length = Math.min(size, 64 * 1024);
		const buffer = Buffer.alloc(length);
		const fd = openSync(LOG_FILE, "r");
		try {
			readSync(fd, buffer, 0, length, size - length);
		} finally {
			closeSync(fd);
		}
		return buffer.toString("utf8").split("\n").slice(-lines - 1).join("\n").trim();
	} catch {
		return "";
	}
}

// ── server actions ───────────────────────────────────────────────────────────
async function startServer(): Promise<Result> {
	if (await tmuxAlive()) return { ok: true, out: "already running" };
	const cmd =
		`llama-server --models-dir '${MODELS_DIR}' --no-models-autoload --jinja ` +
		`--host 127.0.0.1 --port ${PORT} -ngl 999 -c ${CTX} ` +
		`--sleep-idle-seconds ${SLEEP_IDLE} 2>&1 | tee ${LOG_FILE}`;
	const r = await run("tmux", ["new-session", "-d", "-s", TMUX_SESSION, "-x", "200", "-y", "50", cmd]);
	if (!r.ok) return r;
	for (let i = 0; i < 30; i++) {
		if (await serverUp()) return { ok: true, out: "started" };
		await sleep(1000);
	}
	return { ok: false, out: "the server did not answer within 30 s" };
}

async function stopServer(): Promise<Result> {
	if (!(await tmuxAlive())) return { ok: true, out: "not running" };
	const r = await run("tmux", ["kill-session", "-t", TMUX_SESSION]);
	return r.ok ? { ok: true, out: "stopped" } : r;
}

async function loadModel(id: string): Promise<Result> {
	const body = JSON.stringify({ model: id });
	const r = await run("curl", ["-sf", "--max-time", "5", "-X", "POST", `${BASE}/models/load`, "-H", "Content-Type: application/json", "-d", body]);
	if (!r.ok) return r;
	for (let i = 0; i < 60; i++) {
		const v = (await findModel(id))?.status?.value;
		if (v === "loaded" || v === "sleeping") return { ok: true, out: v };
		if (v === "unloaded") return { ok: false, out: "the model went back to unloaded; /local logs shows why" };
		await sleep(2000);
	}
	return { ok: false, out: "the model did not finish loading within 120 s" };
}

async function unloadModel(id: string): Promise<Result> {
	const body = JSON.stringify({ model: id });
	return run("curl", ["-sf", "--max-time", "5", "-X", "POST", `${BASE}/models/unload`, "-H", "Content-Type: application/json", "-d", body]);
}

// ── presentation ─────────────────────────────────────────────────────────────
const STATE_ICON: Record<string, string> = {
	loaded: "🟢",
	sleeping: "🌙",
	loading: "⏳",
	downloading: "⏬",
	unloaded: "⚪",
};

interface Snapshot {
	up: boolean;
	tmux: boolean;
	models: LlamaModel[];
}

async function snapshot(): Promise<Snapshot> {
	const tmux = await tmuxAlive();
	const up = tmux && (await serverUp());
	return { up, tmux, models: up ? await listModels() : [] };
}

function statusBarLabel(s: Snapshot): string {
	if (!s.up) return "";
	const m = s.models.find((model) => model.id === DEFAULT_MODEL);
	if (!m) return `🟡 local :${PORT}`;
	return `${STATE_ICON[m.status.value] ?? "🟡"} ${m.id}`;
}

/** For the menu: is the server up, and is the default model in memory. */
function shortStatus(s: Snapshot, ram: string): string[] {
	if (!s.up) return [s.tmux ? "The server is starting or stuck: its tmux session is alive but not answering." : "The server is stopped."];
	const m = s.models.find((model) => model.id === DEFAULT_MODEL);
	return [`Server running on ${BASE} · ${ram} of memory`, m ? `${m.id}: ${m.status.value}` : `${DEFAULT_MODEL} is not in ${MODELS_DIR}`];
}

async function fullReport(): Promise<string> {
	const s = await snapshot();
	if (!s.up) {
		return `⚪ The local server is stopped\n\n   tmux session '${TMUX_SESSION}': ${s.tmux ? "alive but not answering" : "not running"}\n   /local start starts it`;
	}
	const lines = [
		`🟢 Local server running on ${BASE}`,
		``,
		`   tmux session : ${TMUX_SESSION}`,
		`   memory       : ${await serverRam()}`,
		`   auto-sleep   : after ${SLEEP_IDLE}s idle (wakes in ~1s)`,
		`   log file     : ${LOG_FILE}`,
		``,
	];
	if (s.models.length === 0) {
		lines.push(`   No models found in ${MODELS_DIR}`);
		return lines.join("\n");
	}
	for (const mm of s.models) {
		const meta = mm.meta ?? {};
		lines.push(`   ${STATE_ICON[mm.status.value] ?? "🟡"} ${mm.id} — ${mm.status.value}`);
		lines.push(`        quant   : ${meta.ftype ?? "?"}   size: ${fmtBytes(meta.size ?? 0)}`);
		lines.push(`        context : ${fmtNum(meta.n_ctx ?? CTX)} active${meta.n_ctx_train ? ` (model max ${fmtNum(meta.n_ctx_train)})` : ""}`);
		lines.push(`        params  : ${fmtCount(meta.n_params ?? 0)}   input: ${(mm.architecture?.input_modalities ?? ["text"]).join("+")}`);
	}
	const m = s.models.find((x) => x.id === DEFAULT_MODEL) ?? s.models[0]!;
	lines.push(``, `   Pick it in pi with /model → ${PROVIDER_ID}/${m.id}`);
	return lines.join("\n");
}

const WORDS: Word[] = [
	{ name: "start", aliases: ["on"], description: `start the server and load ${DEFAULT_MODEL}` },
	{ name: "stop", aliases: ["off", "kill"], description: "shut the server down and free its memory" },
	{ name: "restart", description: "stop, then start again" },
	{ name: "load", description: `load ${DEFAULT_MODEL} into a running server` },
	{ name: "unload", description: "drop the model from memory; the server keeps listening" },
	{ name: "status", description: "the server, its memory and every model in detail" },
	{ name: "logs", aliases: ["log"], description: `the last ${LOG_LINES} lines of the server log` },
];

const USAGE = WORDS.map((w) => `/local ${w.name.padEnd(8)} ${w.description}`);

// ── extension ────────────────────────────────────────────────────────────────
export default function localModelExtension(pi: ExtensionAPI) {
	let busy: string | undefined;

	const refreshStatus = (ctx: ExtensionContext, known?: Snapshot) => {
		if (!ctx.hasUI) return;
		void (known ? Promise.resolve(known) : snapshot()).then((s) => {
			try {
				ctx.ui.setStatus("local-model", statusBarLabel(s));
			} catch {
				/* the session was replaced while the probe ran */
			}
		});
	};

	async function start(ctx: ExtensionCommandContext): Promise<void> {
		ctx.ui.setStatus("local-model", "⏳ starting the local server…");
		const s = await startServer();
		if (!s.ok) {
			refreshStatus(ctx);
			ctx.ui.notify(`The server did not start: ${s.out.slice(-500)}`, "error");
			return;
		}
		ctx.ui.setStatus("local-model", `⏳ loading ${DEFAULT_MODEL}…`);
		const l = await loadModel(DEFAULT_MODEL);
		refreshStatus(ctx);
		ctx.ui.notify(l.ok ? `✅ ${DEFAULT_MODEL} is ready. Pick it with /model → ${PROVIDER_ID}/${DEFAULT_MODEL}.` : `The server is up but the model did not load: ${l.out}`, l.ok ? "info" : "error");
	}

	async function stop(ctx: ExtensionCommandContext): Promise<void> {
		if (!(await tmuxAlive())) {
			refreshStatus(ctx);
			ctx.ui.notify("The local server is already stopped.", "info");
			return;
		}
		const r = await stopServer();
		refreshStatus(ctx);
		ctx.ui.notify(r.ok ? "🛑 Local server stopped; its memory is free." : `Could not stop it: ${r.out}`, r.ok ? "info" : "error");
	}

	async function load(ctx: ExtensionCommandContext): Promise<void> {
		if (!(await serverUp())) {
			ctx.ui.notify("The server is stopped. /local start starts it and loads the model.", "warning");
			return;
		}
		ctx.ui.setStatus("local-model", `⏳ loading ${DEFAULT_MODEL}…`);
		const l = await loadModel(DEFAULT_MODEL);
		refreshStatus(ctx);
		ctx.ui.notify(l.ok ? `✅ ${DEFAULT_MODEL} is ready.` : `The model did not load: ${l.out}`, l.ok ? "info" : "error");
	}

	async function unload(ctx: ExtensionCommandContext): Promise<void> {
		if (!(await serverUp())) {
			ctx.ui.notify("The server is stopped, so nothing is loaded.", "info");
			return;
		}
		const r = await unloadModel(DEFAULT_MODEL);
		refreshStatus(ctx);
		ctx.ui.notify(r.ok ? `⚪ ${DEFAULT_MODEL} unloaded. The server still listens on ${BASE}.` : `Could not unload it: ${r.out}`, r.ok ? "info" : "error");
	}

	async function act(name: string, ctx: ExtensionCommandContext): Promise<void> {
		switch (name) {
			case "start":
				return start(ctx);
			case "stop":
				return stop(ctx);
			case "restart":
				await stopServer();
				await sleep(2000);
				return start(ctx);
			case "load":
				return load(ctx);
			case "unload":
				return unload(ctx);
			case "status":
				refreshStatus(ctx);
				ctx.ui.notify(await fullReport(), "info");
				return;
			case "logs":
				ctx.ui.notify(logTail() || "The log is empty.", "info");
				return;
		}
	}

	async function menu(ctx: ExtensionCommandContext): Promise<string | undefined> {
		const s = await snapshot();
		refreshStatus(ctx, s);
		const model = s.models.find((m) => m.id === DEFAULT_MODEL);
		const loaded = model?.status.value === "loaded" || model?.status.value === "sleeping";
		const items: MenuItem[] = s.up
			? [
					loaded
						? { id: "unload", label: "Unload the model", description: "Frees its memory; the server keeps listening." }
						: { id: "load", label: "Load the model", description: `Loads ${DEFAULT_MODEL} so pi can use it.` },
					{ id: "stop", label: "Stop the server", description: "Shuts it down and frees all its memory." },
					{ id: "restart", label: "Restart the server" },
					{ id: "status", label: "Show details", description: "Memory, context size and every model." },
					{ id: "logs", label: "Show the log" },
				]
			: [
					{ id: "start", label: "Start the server", description: `Starts llama.cpp and loads ${DEFAULT_MODEL}; takes up to two minutes.` },
					{ id: "logs", label: "Show the log" },
				];
		const spec = {
			title: "Local model · llama.cpp",
			status: [...shortStatus(s, s.up ? await serverRam() : ""), "pi's own /llama manages which models the router lists; this starts and stops the server."],
			items,
		};
		if (!canShowMenu(ctx)) {
			ctx.ui.notify(menuAsText(spec, USAGE), "info");
			return undefined;
		}
		return (await showMenu(ctx, spec))?.id;
	}

	pi.registerCommand("local", {
		description: "Start or stop the local llama.cpp model server, and load or unload its model",
		getArgumentCompletions: (prefix) => completeWords(WORDS, prefix),
		handler: async (args, ctx) => {
			const { word } = splitArgs(args);
			const found = word ? findWord(WORDS, word) : undefined;
			if (word && !found) {
				ctx.ui.notify(`/local has no "${word}". Try: ${WORDS.map((w) => w.name).join(", ")}, or /local on its own for the menu.`, "error");
				return;
			}
			if (busy) {
				ctx.ui.notify(`The local server is busy (${busy}); try again when it finishes.`, "info");
				return;
			}
			const name = found?.name ?? (await menu(ctx));
			if (!name) return;
			// not awaited: a start can take two minutes, and pi waits for a command handler before it takes the next prompt
			busy = name;
			void act(name, ctx)
				.catch(() => undefined)
				.finally(() => {
					busy = undefined;
				});
		},
	});

	pi.on("before_agent_start", async (_event: any, ctx: any) => {
		if (!isLocalProvider(ctx.model?.provider)) return;
		if (process.env[SUB_AGENT_TOOLS_ENV]?.trim()) return;
		return { systemPrompt: BARE_SYSTEM_PROMPT };
	});

	// ── status bar upkeep ────────────────────────────────────────────────────
	pi.on("session_start", async (_event: any, ctx: any) => refreshStatus(ctx));
	pi.on("model_select", async (_event: any, ctx: any) => refreshStatus(ctx));
}
