/**
 * /local — run a local model through the Ollama app from inside pi.
 *
 * The models are the `ollama` provider's in models.json; the first is the
 * default. `/local` loads one into Ollama and switches the session to it,
 * `/local off` frees its memory and switches back.
 *
 * For ollama and llama.cpp only, before_agent_start REPLACES the system
 * prompt with BARE_SYSTEM_PROMPT, and each request declares only LOCAL_TOOLS:
 * all ~40 declarations are ~20k tokens, over a minute of prefill on a laptop.
 * The session's active tools are left alone (pi restores them on resume).
 * Sub-agent children keep system-prompt.ts's prompt and their own tools.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { execFile } from "child_process";
import { completeWords, findWord, splitArgs, unknownWord, type Word } from "./tools/lib/command-args";
import { canShowMenu, type MenuItem, menuAsText, showMenu } from "./tools/lib/command-menu";
import { isLocalProvider } from "./tools/lib/local-providers";
import { SUB_AGENT_TOOLS_ENV } from "./tools/lib/sub-agent-prompt";

const PROVIDER_ID = "ollama";
const BASE = "http://127.0.0.1:11434";
const KEEP_ALIVE = process.env.PI_LOCAL_KEEP_ALIVE || "30m";
const LOAD_TIMEOUT_MS = 180_000;

const LOCAL_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", "undo_edit", "web_search", "read_web_page"];

const BARE_SYSTEM_PROMPT = `You are a local coding agent on the user's machine. Be brief. Use tools when needed. Do not claim work without a tool call. Two failures of the same tool → stop and report.

Tools (schemas also in the API):
- read — file or image path
- bash — shell; timeout required
- edit — exact text replacement: path + edits[{oldText,newText}]
- write — create or overwrite a whole file
- grep / find / ls — search and list
- undo_edit — revert the last edit
- web_search / read_web_page — the web
`;

interface Loaded {
	name: string;
	size_vram: number;
	context_length?: number;
	expires_at?: string;
}

type LocalModel = ReturnType<ExtensionContext["modelRegistry"]["getAll"]>[number];

async function api<T>(path: string, body?: object, timeoutMs = 3000): Promise<T | undefined> {
	try {
		const res = await fetch(`${BASE}${path}`, {
			method: body ? "POST" : "GET",
			headers: body ? { "Content-Type": "application/json" } : undefined,
			body: body ? JSON.stringify(body) : undefined,
			signal: AbortSignal.timeout(timeoutMs),
		});
		return res.ok ? ((await res.json()) as T) : undefined;
	} catch {
		return undefined;
	}
}

const ollamaVersion = async () => (await api<{ version: string }>("/api/version"))?.version;
const loadedModels = async () => (await api<{ models: Loaded[] }>("/api/ps"))?.models ?? [];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function ensureOllama(): Promise<string | undefined> {
	if (await ollamaVersion()) return undefined;
	const opened = await new Promise<boolean>((resolve) => execFile("open", ["-a", "Ollama"], (error) => resolve(!error)));
	if (!opened) return "Ollama is not installed: get it from https://ollama.com/download, then /local again.";
	for (let i = 0; i < 30; i++) {
		await sleep(1000);
		if (await ollamaVersion()) return undefined;
	}
	return "Ollama did not answer within 30 s of opening it.";
}

async function loadIntoOllama(id: string): Promise<string | undefined> {
	const res = await api<{ done?: boolean }>("/api/generate", { model: id, keep_alive: KEEP_ALIVE }, LOAD_TIMEOUT_MS);
	return res?.done ? undefined : `Ollama could not load ${id}. Is it pulled? Run: ollama pull ${id}`;
}

const unloadFromOllama = (id: string) => api("/api/generate", { model: id, keep_alive: 0 }, 30_000);

function fmtGB(bytes: number): string {
	return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function shortName(id: string): string {
	return id.split(":")[0]!;
}

const WORDS: Word[] = [
	{ name: "on", aliases: ["start", "use"], description: "load the default local model and switch to it" },
	{ name: "off", aliases: ["stop", "unload"], description: "free the model's memory and switch back" },
	{ name: "status", description: "Ollama, and what it has in memory" },
];

const USAGE = WORDS.map((w) => `/local ${w.name.padEnd(7)} ${w.description}`);

export default function localModelExtension(pi: ExtensionAPI) {
	let busy = false;
	let previous: LocalModel | undefined;

	const localModels = (ctx: ExtensionContext): LocalModel[] => ctx.modelRegistry.getAll().filter((m) => m.provider === PROVIDER_ID);

	const refreshStatus = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		const ids = new Set(localModels(ctx).map((m) => m.id));
		void loadedModels().then((loaded) => {
			const ours = loaded.find((m) => ids.has(m.name));
			try {
				ctx.ui.setStatus("local-model", ours ? `🟢 ${shortName(ours.name)}` : "");
			} catch {
				/* the session was replaced while the probe ran */
			}
		});
	};

	async function useModel(model: LocalModel, ctx: ExtensionCommandContext): Promise<void> {
		const startError = await ensureOllama();
		if (startError) return ctx.ui.notify(startError, "error");
		ctx.ui.setStatus("local-model", `⏳ loading ${shortName(model.id)}…`);
		const loadError = await loadIntoOllama(model.id);
		refreshStatus(ctx);
		if (loadError) return ctx.ui.notify(loadError, "error");
		if (ctx.model && !isLocalProvider(ctx.model.provider)) previous = ctx.model;
		if (!(await pi.setModel(model))) return ctx.ui.notify(`pi refused ${PROVIDER_ID}/${model.id}; check models.json.`, "error");
		ctx.ui.notify(`✅ Now on ${model.name ?? model.id}. /local off frees its memory and switches back.`, "info");
	}

	async function off(ctx: ExtensionCommandContext): Promise<void> {
		const ids = new Set(localModels(ctx).map((m) => m.id));
		const loaded = (await loadedModels()).filter((m) => ids.has(m.name));
		await Promise.all(loaded.map((m) => unloadFromOllama(m.name)));
		refreshStatus(ctx);
		const freed = loaded.length ? `Freed ${fmtGB(loaded.reduce((sum, m) => sum + m.size_vram, 0))}.` : "Nothing was loaded.";
		if (!isLocalProvider(ctx.model?.provider)) return ctx.ui.notify(freed, "info");
		if (previous && (await pi.setModel(previous))) return ctx.ui.notify(`${freed} Back on ${previous.name ?? previous.id}.`, "info");
		ctx.ui.notify(`${freed} Pick your next model with /model.`, "info");
	}

	async function statusReport(ctx: ExtensionContext): Promise<string> {
		const version = await ollamaVersion();
		if (!version) return "⚪ Ollama is not running. /local opens it and loads the model.";
		const loaded = await loadedModels();
		const lines = [`🟢 Ollama ${version} on ${BASE}`, ""];
		if (loaded.length === 0) lines.push("   Nothing in memory.");
		for (const m of loaded) {
			const until = m.expires_at ? new Date(m.expires_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : "?";
			lines.push(`   ${m.name} — ${fmtGB(m.size_vram)}, context ${(m.context_length ?? 0).toLocaleString("en-US")}, unloads at ${until}`);
		}
		lines.push("", `   pi models: ${localModels(ctx).map((m) => `${PROVIDER_ID}/${m.id}`).join(", ") || "none in models.json"}`);
		return lines.join("\n");
	}

	async function menu(ctx: ExtensionCommandContext): Promise<string | undefined> {
		const models = localModels(ctx);
		const items: MenuItem[] = [
			...models.map((m) => ({ id: `use:${m.id}`, label: `Use ${m.name ?? m.id}`, description: "Loads it into Ollama and switches this session to it." })),
			{ id: "off", label: "Free the memory and switch back" },
			{ id: "status", label: "Show what Ollama has loaded" },
		];
		const spec = { title: "Local model · Ollama", status: [(await statusReport(ctx)).split("\n")[0]!], items };
		if (!canShowMenu(ctx)) {
			ctx.ui.notify(menuAsText(spec, USAGE), "info");
			return undefined;
		}
		return (await showMenu(ctx, spec))?.id;
	}

	async function act(choice: string, ctx: ExtensionCommandContext): Promise<void> {
		if (choice === "off") return off(ctx);
		if (choice === "status") return ctx.ui.notify(await statusReport(ctx), "info");
		const models = localModels(ctx);
		const model = choice.startsWith("use:") ? models.find((m) => m.id === choice.slice(4)) : models[0];
		if (!model) return ctx.ui.notify(`models.json has no ${PROVIDER_ID} model.`, "error");
		return useModel(model, ctx);
	}

	pi.registerCommand("local", {
		description: "Run a local model through Ollama: load it and switch to it, or free it and switch back",
		getArgumentCompletions: (prefix) => completeWords(WORDS, prefix),
		handler: async (args, ctx) => {
			const { word } = splitArgs(args);
			const found = word ? findWord(WORDS, word) : undefined;
			if (word && !found) return ctx.ui.notify(unknownWord("local", word, WORDS), "error");
			if (busy) return ctx.ui.notify("/local is still working on the last request.", "info");
			const choice = found?.name ?? (await menu(ctx));
			if (!choice) return;
			// not awaited: a cold load takes a while, and pi waits for a command handler before it takes the next prompt
			busy = true;
			void act(choice, ctx)
				.catch((error) => ctx.ui.notify(`/local failed: ${error instanceof Error ? error.message : String(error)}`, "error"))
				.finally(() => {
					busy = false;
				});
		},
	});

	const onLocalParent = (ctx: any) => isLocalProvider(ctx.model?.provider) && !process.env[SUB_AGENT_TOOLS_ENV]?.trim();

	pi.on("before_agent_start", async (_event: any, ctx: any) => {
		if (!onLocalParent(ctx)) return;
		return { systemPrompt: BARE_SYSTEM_PROMPT };
	});

	pi.on("before_provider_request", (event: any, ctx: any) => {
		const tools = event.payload?.tools;
		if (!onLocalParent(ctx) || !Array.isArray(tools)) return;
		return { ...event.payload, tools: tools.filter((t: any) => LOCAL_TOOLS.includes(t?.function?.name)) };
	});

	pi.on("session_start", async (_event: any, ctx: any) => refreshStatus(ctx));
	pi.on("model_select", async (_event: any, ctx: any) => refreshStatus(ctx));
}
