/**
 * /local — manage the local llama.cpp router from inside pi.
 *
 * Rebuild of the `local-model.ts` deleted in bcfefc3 (2026-07-23). The original
 * shelled out to an external `start-local.sh` that lived OUTSIDE the repo; that
 * script was later deleted and took the whole extension down with it. So this
 * version embeds the server command — there is nothing on disk it can lose.
 *
 * SYSTEM PROMPT (llama-local and llama.cpp):
 * before_agent_start REPLACES the full assembled prompt with BARE_SYSTEM_PROMPT
 * when provider is llama-local or llama.cpp. Every other provider gets undefined
 * → prompt unchanged. Sub-agent children (PI_SUBAGENT_TOOLS set) are left alone
 * so the short tool-list prompt from system-prompt.ts still applies.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { execFile, execSync } from "child_process";
import * as os from "os";
import { SUB_AGENT_TOOLS_ENV } from "./tools/lib/sub-agent-prompt";

const PROVIDER_ID = "llama-local";
const PORT = Number(process.env.LLAMA_PORT || 8080);
const MODELS_DIR = process.env.LLAMA_MODELS_DIR || `${os.homedir()}/models`;
const CTX = Number(process.env.LLAMA_CTX || 65536);
const SLEEP_IDLE = Number(process.env.LLAMA_SLEEP_IDLE || 300);
const DEFAULT_MODEL = process.env.LLAMA_DEFAULT_MODEL || "Qwen3.8-27B-Uncensored";
const TMUX_SESSION = "llama";
const LOG_FILE = "/tmp/llama-server.log";
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

// ── shell helpers ────────────────────────────────────────────────────────────
function sh(cmd: string, timeout = 10_000): { ok: boolean; out: string } {
	try {
		return { ok: true, out: execSync(cmd, { timeout, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }) };
	} catch (e: any) {
		return { ok: false, out: String(e?.stdout ?? "") + String(e?.stderr ?? e?.message ?? "") };
	}
}

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

function tmuxAlive(): boolean {
	return sh(`tmux has-session -t ${TMUX_SESSION} 2>/dev/null`).ok;
}

function serverUp(): boolean {
	return sh(`curl -sf --max-time 2 ${BASE}/health`).ok;
}

function listModels(): LlamaModel[] {
	const r = sh(`curl -sf --max-time 3 ${BASE}/models`);
	if (!r.ok) return [];
	try {
		return JSON.parse(r.out)?.data ?? [];
	} catch {
		return [];
	}
}

function findModel(id = DEFAULT_MODEL): LlamaModel | undefined {
	return listModels().find((m) => m.id === id);
}

function serverRam(): string {
	const r = sh(`ps -eo rss,comm | grep llama-server | grep -v grep | awk '{s+=$1} END {print s}'`);
	const kb = Number((r.out || "").trim());
	return kb > 0 ? fmtBytes(kb * 1024) : "0 MB";
}

// ── server actions ───────────────────────────────────────────────────────────
function startServer(): { ok: boolean; out: string } {
	if (tmuxAlive()) return { ok: true, out: "already running" };
	const cmd =
		`llama-server --models-dir '${MODELS_DIR}' --no-models-autoload --jinja ` +
		`--host 127.0.0.1 --port ${PORT} -ngl 999 -c ${CTX} ` +
		`--sleep-idle-seconds ${SLEEP_IDLE} 2>&1 | tee ${LOG_FILE}`;
	const r = sh(`tmux new-session -d -s ${TMUX_SESSION} -x 200 -y 50 ${JSON.stringify(cmd)}`);
	if (!r.ok) return r;
	for (let i = 0; i < 30; i++) {
		if (serverUp()) return { ok: true, out: "started" };
		sh("sleep 1", 2000);
	}
	return { ok: false, out: "server did not become healthy within 30s" };
}

function stopServer(): { ok: boolean; out: string } {
	if (!tmuxAlive()) return { ok: true, out: "not running" };
	const r = sh(`tmux kill-session -t ${TMUX_SESSION}`);
	return r.ok ? { ok: true, out: "stopped" } : r;
}

function loadModel(id: string): { ok: boolean; out: string } {
	const r = sh(`curl -sf --max-time 5 -X POST ${BASE}/models/load -H 'Content-Type: application/json' -d '{"model":"${id}"}'`);
	if (!r.ok) return r;
	for (let i = 0; i < 60; i++) {
		const v = findModel(id)?.status?.value;
		if (v === "loaded" || v === "sleeping") return { ok: true, out: v };
		if (v === "unloaded") return { ok: false, out: "model returned to unloaded — check /local logs" };
		sh("sleep 2", 3000);
	}
	return { ok: false, out: "model did not finish loading within 120s" };
}

function unloadModel(id: string): { ok: boolean; out: string } {
	return sh(`curl -sf --max-time 5 -X POST ${BASE}/models/unload -H 'Content-Type: application/json' -d '{"model":"${id}"}'`);
}

// ── presentation ─────────────────────────────────────────────────────────────
const STATE_ICON: Record<string, string> = {
	loaded: "🟢",
	sleeping: "🌙",
	loading: "⏳",
	downloading: "⏬",
	unloaded: "⚪",
};

function run(cmd: string, args: string[], timeout: number): Promise<{ ok: boolean; out: string }> {
	return new Promise((resolve) => {
		execFile(cmd, args, { timeout, encoding: "utf-8" }, (error, stdout) => resolve({ ok: !error, out: stdout ?? "" }));
	});
}

async function statusBarLabel(): Promise<string> {
	if (!(await run("tmux", ["has-session", "-t", TMUX_SESSION], 10_000)).ok) return "";
	if (!(await run("curl", ["-sf", "--max-time", "2", `${BASE}/health`], 10_000)).ok) return "";
	const r = await run("curl", ["-sf", "--max-time", "3", `${BASE}/models`], 10_000);
	let models: LlamaModel[] = [];
	try {
		models = r.ok ? (JSON.parse(r.out)?.data ?? []) : [];
	} catch {}
	const m = models.find((model) => model.id === DEFAULT_MODEL);
	if (!m) return `🟡 local :${PORT}`;
	const icon = STATE_ICON[m.status.value] ?? "🟡";
	return `${icon} ${m.id}`;
}

function statusReport(): string {
	const tmux = tmuxAlive();
	const up = tmux && serverUp();
	if (!up) {
		return (
			`⚪ Local server is NOT running\n\n` +
			`   tmux session '${TMUX_SESSION}': ${tmux ? "alive but not answering" : "not running"}\n` +
			`   Start it with:  /local start`
		);
	}

	const models = listModels();
	const m = models.find((x) => x.id === DEFAULT_MODEL) ?? models[0];
	const lines = [
		`🟢 Local server running on ${BASE}`,
		``,
		`   tmux session : ${TMUX_SESSION}`,
		`   RAM in use   : ${serverRam()}`,
		`   auto-sleep   : after ${SLEEP_IDLE}s idle (wakes in ~1s)`,
		`   log file     : ${LOG_FILE}`,
		``,
	];

	if (!m) {
		lines.push(`   No models discovered in ${MODELS_DIR}`);
		return lines.join("\n");
	}

	for (const mm of models) {
		const icon = STATE_ICON[mm.status.value] ?? "🟡";
		const meta = mm.meta ?? {};
		lines.push(`   ${icon} ${mm.id} — ${mm.status.value}`);
		lines.push(`        quant   : ${meta.ftype ?? "?"}   size: ${fmtBytes(meta.size ?? 0)}`);
		lines.push(
			`        context : ${fmtNum(meta.n_ctx ?? CTX)} active` +
				(meta.n_ctx_train ? ` (model max ${fmtNum(meta.n_ctx_train)})` : ""),
		);
		lines.push(
			`        params  : ${fmtCount(meta.n_params ?? 0)}   input: ${(mm.architecture?.input_modalities ?? ["text"]).join("+")}`,
		);
	}

	lines.push(``, `   Select in pi with /model → ${PROVIDER_ID}/${m.id}`);
	return lines.join("\n");
}

// ── extension ────────────────────────────────────────────────────────────────
export default function localModelExtension(pi: ExtensionAPI) {
	const refreshStatus = (ctx: any) => {
		if (!ctx.hasUI) return;
		void statusBarLabel().then((label) => {
			try {
				ctx.ui.setStatus("local-model", label);
			} catch {
				/* the session was replaced while the probe ran */
			}
		});
	};

	pi.registerCommand("local", {
		description:
			"Manage the local llama.cpp model server. '/local' shows status, " +
			"'/local start' starts it, '/local stop' shuts it down, " +
			"also: status, unload, logs, restart.",
		handler: async (args, ctx) => {
			const cmd = (args || "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";

			// ── /local stop ──────────────────────────────────────────────────
			if (cmd === "stop" || cmd === "off" || cmd === "kill") {
				if (!tmuxAlive()) {
					ctx.ui.notify("Local server is already stopped.", "info");
					refreshStatus(ctx);
					return;
				}
				const r = stopServer();
				refreshStatus(ctx);
				ctx.ui.notify(
					r.ok
						? `🛑 Local server stopped. RAM released.\n\n   Start again with /local start`
						: `Failed to stop: ${r.out}`,
					r.ok ? "success" : "error",
				);
				return;
			}

			// ── /local start ─────────────────────────────────────────────────
			if (cmd === "start" || cmd === "on") {
				ctx.ui.setStatus("local-model", "⏳ starting local server…");
				const s = startServer();
				if (!s.ok) {
					refreshStatus(ctx);
					ctx.ui.notify(`Failed to start server:\n${s.out.slice(-500)}`, "error");
					return;
				}
				ctx.ui.setStatus("local-model", `⏳ loading ${DEFAULT_MODEL}…`);
				const l = loadModel(DEFAULT_MODEL);
				refreshStatus(ctx);
				ctx.ui.notify(
					l.ok
						? `✅ ${DEFAULT_MODEL} ready\n\n${statusReport()}`
						: `Server is up but the model failed to load:\n${l.out}`,
					l.ok ? "success" : "error",
				);
				return;
			}

			// ── /local restart ───────────────────────────────────────────────
			if (cmd === "restart") {
				stopServer();
				sh("sleep 2", 4000);
				const s = startServer();
				if (s.ok) loadModel(DEFAULT_MODEL);
				refreshStatus(ctx);
				ctx.ui.notify(s.ok ? `♻️ Restarted\n\n${statusReport()}` : `Restart failed: ${s.out}`, s.ok ? "success" : "error");
				return;
			}

			// ── /local unload ────────────────────────────────────────────────
			if (cmd === "unload") {
				if (!serverUp()) {
					ctx.ui.notify("Server is not running.", "warning");
					return;
				}
				const r = unloadModel(DEFAULT_MODEL);
				refreshStatus(ctx);
				ctx.ui.notify(
					r.ok
						? `⚪ ${DEFAULT_MODEL} unloaded. Server still listening on ${BASE}.`
						: `Failed to unload: ${r.out}`,
					r.ok ? "info" : "error",
				);
				return;
			}

			// ── /local logs ──────────────────────────────────────────────────
			if (cmd === "logs" || cmd === "log") {
				const r = sh(`tail -40 ${LOG_FILE} 2>/dev/null`);
				ctx.ui.notify(r.out?.trim() || "No log output yet.", "info");
				return;
			}

			// ── /local status ────────────────────────────────────────────────
			if (cmd === "status") {
				refreshStatus(ctx);
				ctx.ui.notify(statusReport(), "info");
				return;
			}

			// ── /local help ──────────────────────────────────────────────────
			if (cmd === "help" || cmd === "?") {
				ctx.ui.notify(
					`/local            — status, or offer to start if stopped\n` +
						`/local start      — start server + load ${DEFAULT_MODEL}\n` +
						`/local stop       — shut the server down, release RAM\n` +
						`/local restart    — stop then start again\n` +
						`/local unload     — drop the model, keep the server listening\n` +
						`/local status     — full detail (quant, context, params, RAM)\n` +
						`/local logs       — last 40 lines of the server log`,
					"info",
				);
				return;
			}

			// ── /local (bare) ────────────────────────────────────────────────
			const running = tmuxAlive() && serverUp();
			refreshStatus(ctx);

			if (!running) {
				if (!ctx.hasUI) {
					ctx.ui.notify(`${statusReport()}\n\n(run '/local start' to start it)`, "warning");
					return;
				}
				const choice = await ctx.ui.select("Local server is not running.", [
					`Start it and load ${DEFAULT_MODEL}`,
					"Show logs",
					"Cancel",
				]);
				if (!choice || choice === "Cancel") return;
				if (choice === "Show logs") {
					const r = sh(`tail -40 ${LOG_FILE} 2>/dev/null`);
					ctx.ui.notify(r.out?.trim() || "No log output yet.", "info");
					return;
				}
				ctx.ui.setStatus("local-model", "⏳ starting local server…");
				const s = startServer();
				if (!s.ok) {
					refreshStatus(ctx);
					ctx.ui.notify(`Failed to start:\n${s.out.slice(-500)}`, "error");
					return;
				}
				ctx.ui.setStatus("local-model", `⏳ loading ${DEFAULT_MODEL}…`);
				const l = loadModel(DEFAULT_MODEL);
				refreshStatus(ctx);
				ctx.ui.notify(l.ok ? `✅ ${DEFAULT_MODEL} ready\n\n${statusReport()}` : `Model failed to load:\n${l.out}`, l.ok ? "success" : "error");
				return;
			}

			if (!ctx.hasUI) {
				ctx.ui.notify(statusReport(), "info");
				return;
			}

			const m = findModel();
			const loaded = m?.status?.value === "loaded" || m?.status?.value === "sleeping";
			const choice = await ctx.ui.select(statusReport(), [
				loaded ? "Unload model (keep server)" : `Load ${DEFAULT_MODEL}`,
				"Stop server (release RAM)",
				"Restart server",
				"Show logs",
				"Close",
			]);
			if (!choice || choice === "Close") return;

			if (choice.startsWith("Unload")) {
				unloadModel(DEFAULT_MODEL);
				refreshStatus(ctx);
				ctx.ui.notify(`⚪ ${DEFAULT_MODEL} unloaded. Server still listening.`, "info");
			} else if (choice.startsWith("Load")) {
				const l = loadModel(DEFAULT_MODEL);
				refreshStatus(ctx);
				ctx.ui.notify(l.ok ? `✅ ${DEFAULT_MODEL} ready` : `Failed: ${l.out}`, l.ok ? "success" : "error");
			} else if (choice.startsWith("Stop")) {
				stopServer();
				refreshStatus(ctx);
				ctx.ui.notify("🛑 Local server stopped. RAM released.", "success");
			} else if (choice.startsWith("Restart")) {
				stopServer();
				sh("sleep 2", 4000);
				const s = startServer();
				if (s.ok) loadModel(DEFAULT_MODEL);
				refreshStatus(ctx);
				ctx.ui.notify(s.ok ? "♻️ Restarted" : `Restart failed: ${s.out}`, s.ok ? "success" : "error");
			} else if (choice.startsWith("Show logs")) {
				const r = sh(`tail -40 ${LOG_FILE} 2>/dev/null`);
				ctx.ui.notify(r.out?.trim() || "No log output yet.", "info");
			}
		},
	});

	pi.on("before_agent_start", async (_event: any, ctx: any) => {
		if (ctx.model?.provider !== PROVIDER_ID && ctx.model?.provider !== "llama.cpp") return;
		if (process.env[SUB_AGENT_TOOLS_ENV]?.trim()) return;
		return { systemPrompt: BARE_SYSTEM_PROMPT };
	});

	// ── status bar upkeep ────────────────────────────────────────────────────
	pi.on("session_start", async (_event: any, ctx: any) => refreshStatus(ctx));
	pi.on("model_select", async (_event: any, ctx: any) => refreshStatus(ctx));
}
