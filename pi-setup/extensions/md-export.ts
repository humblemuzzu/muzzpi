import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";
import { withoutTyped } from "./tools/lib/command-args";
import { canShowMenu, type MenuSpec, showMenu } from "./tools/lib/command-menu";

/**
 * Processes Pi agent JSONL session logs into readable text format
 * Output directory: ~/.pi/agent/pi-sessions-extracted/
 */

interface SessionMeta {
  sessionId: string;
  startedAt: Date | null;
  cwd: string;
}

interface ToolCallInfo {
  name: string;
  cmd: string;
  include: boolean;
}

interface ToolFilter {
  mode: "all" | "includeOnly";
  includeNames: Set<string>;
  excludeNames: Set<string>;
}

interface ExportOptions {
  includeThinking: boolean;
  toolFilter: ToolFilter | null;
}

interface ConversationState {
  meta: SessionMeta;
  conversation: string[];
  pendingToolCalls: Map<string, ToolCallInfo>;
}

/**
 * Extract text from various content formats (string, array of content blocks)
 */
function extractTextFromContent(content: unknown): string {
  if (content === null || content === undefined) {
    return "";
  }
  if (typeof content === "string") {
    return content.trim();
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (typeof item !== "object" || item === null) {
        continue;
      }
      const itemObj = item as Record<string, unknown>;
      if (itemObj.type !== "text") {
        continue;
      }
      const text = itemObj.text;
      if (typeof text === "string" && text.trim()) {
        parts.push(text.trim());
      }
    }
    return parts.join("\n").trim();
  }
  return "";
}

/**
 * Parse ISO-ish timestamp string to Date
 */
function parseIsoTimestamp(ts: unknown): Date | null {
  if (!ts || typeof ts !== "string") {
    return null;
  }
  try {
    let normalized = ts;
    if (ts.endsWith("Z")) {
      normalized = ts.slice(0, -1) + "+00:00";
    }
    const date = new Date(normalized);
    return isNaN(date.getTime()) ? null : date;
  } catch {
    return null;
  }
}

/**
 * Create a filesystem-safe slug from a string
 */
function slug(s: string): string {
  const out: string[] = [];
  let prevUnderscore = false;
  for (const ch of s) {
    const isAlphaNum = /[a-zA-Z0-9]/.test(ch);
    const isAllowed = isAlphaNum || ch === "-" || ch === "_";
    if (isAllowed) {
      out.push(ch);
      prevUnderscore = false;
    } else if (!prevUnderscore) {
      out.push("_");
      prevUnderscore = true;
    }
  }
  const result = out.join("").replace(/^_+|_+$/g, "");
  return result || "unknown";
}

/**
 * Iterate through JSONL file line by line, yielding parsed objects
 */
async function* iterJsonl(
  filePath: string
): AsyncGenerator<Record<string, unknown>> {
  const fileStream = fs.createReadStream(filePath, { encoding: "utf-8" });
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const obj = JSON.parse(trimmed);
      if (typeof obj === "object" && obj !== null && !Array.isArray(obj)) {
        yield obj as Record<string, unknown>;
      }
    } catch {
      // Skip malformed JSON lines
      continue;
    }
  }
}

function normalizeToolName(name: string): string {
  return name.trim().toLowerCase();
}

function createConversationState(): ConversationState {
  return {
    meta: {
      sessionId: "",
      startedAt: null,
      cwd: "",
    },
    conversation: [],
    pendingToolCalls: new Map(),
  };
}

function formatThinkingBlock(thinking: string): string {
  return `[thinking]\n${thinking.trim()}\n[/thinking]`;
}

function extractToolCommand(args: unknown): string {
  if (typeof args === "object" && args !== null && !Array.isArray(args)) {
    const argsObj = args as Record<string, unknown>;
    const cmdVal = argsObj.command || argsObj.cmd;
    if (typeof cmdVal === "string") {
      return cmdVal;
    }
    try {
      return JSON.stringify(args, Object.keys(args).sort());
    } catch {
      return String(args);
    }
  }
  return String(args);
}

function shouldIncludeTool(toolName: string, toolFilter: ToolFilter | null): boolean {
  if (!toolFilter) {
    return false;
  }

  const normalized = normalizeToolName(toolName);
  if (toolFilter.excludeNames.has(normalized)) {
    return false;
  }
  if (toolFilter.mode === "includeOnly") {
    return toolFilter.includeNames.has(normalized);
  }
  return true;
}

function applyMessageRecord(
  rec: Record<string, unknown>,
  state: ConversationState,
  options: ExportOptions
): void {
  const rtype = rec.type;

  if (rtype === "session" && !state.meta.sessionId) {
    state.meta.sessionId = String(rec.id || "");
    state.meta.startedAt = parseIsoTimestamp(rec.timestamp);
    state.meta.cwd = String(rec.cwd || "");
    return;
  }

  if (rtype !== "message") {
    return;
  }

  const msg = rec.message;
  if (typeof msg !== "object" || msg === null || Array.isArray(msg)) {
    return;
  }

  const msgObj = msg as Record<string, unknown>;
  const role = msgObj.role;

  if (role === "user") {
    const text = extractTextFromContent(msgObj.content);
    if (text) {
      state.conversation.push(`USER: ${text}`);
    }
    return;
  }

  if (role === "assistant") {
    appendAssistantMessage(msgObj, state, options);
    return;
  }

  if (role === "toolResult") {
    appendToolResultMessage(msgObj, state, options.toolFilter);
  }
}

function appendAssistantMessage(
  msgObj: Record<string, unknown>,
  state: ConversationState,
  options: ExportOptions
): void {
  const content = msgObj.content;
  const textParts: string[] = [];
  const toolParts: string[] = [];

  if (typeof content === "string") {
    if (content.trim()) {
      textParts.push(content.trim());
    }
  } else if (Array.isArray(content)) {
    for (const item of content) {
      if (typeof item !== "object" || item === null) {
        continue;
      }
      const itemObj = item as Record<string, unknown>;
      const itemType = itemObj.type;

      if (itemType === "text") {
        const text = itemObj.text;
        if (typeof text === "string" && text.trim()) {
          textParts.push(text.trim());
        }
        continue;
      }

      if (itemType === "thinking") {
        const thinking = itemObj.thinking;
        if (
          options.includeThinking &&
          typeof thinking === "string" &&
          thinking.trim()
        ) {
          textParts.push(formatThinkingBlock(thinking));
        }
        continue;
      }

      if (itemType !== "toolCall") {
        continue;
      }

      const toolName = String(itemObj.name || "tool");
      const toolId = String(itemObj.id || "");
      const cmd = extractToolCommand(itemObj.arguments);
      const include = shouldIncludeTool(toolName, options.toolFilter);

      if (toolId) {
        state.pendingToolCalls.set(toolId, { name: toolName, cmd, include });
      }
      if (include) {
        toolParts.push(`[tool:${toolName}] ${cmd}`.trim());
      }
    }
  }

  let fullText = textParts.filter(Boolean).join("\n").trim();
  if (toolParts.length > 0) {
    fullText = (fullText ? `${fullText}\n` : "") + toolParts.join("\n");
  }

  if (fullText) {
    state.conversation.push(`ASSISTANT: ${fullText}`);
  }
}

function appendToolResultMessage(
  msgObj: Record<string, unknown>,
  state: ConversationState,
  toolFilter: ToolFilter | null
): void {
  const toolName = String(msgObj.toolName || msgObj.tool_name || "tool");
  const toolCallId = String(msgObj.toolCallId || msgObj.tool_call_id || "");

  let label = toolName;
  let include = shouldIncludeTool(toolName, toolFilter);

  if (toolCallId && state.pendingToolCalls.has(toolCallId)) {
    const pending = state.pendingToolCalls.get(toolCallId)!;
    state.pendingToolCalls.delete(toolCallId);
    label = pending.name || toolName;
    include = pending.include;
    if (pending.cmd) {
      label = `${label}: ${pending.cmd}`;
    }
  }

  if (!include) {
    return;
  }

  const isError = Boolean(msgObj.isError || msgObj.is_error);
  const out = extractTextFromContent(msgObj.content);
  if (out && out !== "(no content)") {
    state.conversation.push(
      `SYSTEM [${label} output${isError ? " ERROR" : ""}]:\n${out}`
    );
  }
}

/**
 * Extract conversation messages from a Pi session JSONL file
 */
async function extractConversation(
  jsonlFile: string,
  options: ExportOptions
): Promise<{ meta: SessionMeta; conversation: string[] }> {
  const state = createConversationState();

  for await (const rec of iterJsonl(jsonlFile)) {
    applyMessageRecord(rec, state, options);
  }

  return { meta: state.meta, conversation: state.conversation };
}

/**
 * Extract conversation messages from the *currently selected branch* (root → current leaf)
 * using the in-memory SessionManager tree state.
 *
 * This intentionally includes *all* turns on the branch, including turns that may no longer
 * be shown in the TUI after compaction.
 */
function extractConversationFromBranch(
  sessionManager: any,
  options: ExportOptions
): { meta: SessionMeta; conversation: string[]; leafId: string | null } {
  const state = createConversationState();
  const header =
    typeof sessionManager.getHeader === "function"
      ? sessionManager.getHeader()
      : null;

  if (header && typeof header === "object") {
    const headerObj = header as Record<string, unknown>;
    state.meta.sessionId = typeof headerObj.id === "string" ? headerObj.id : "";
    state.meta.startedAt = parseIsoTimestamp(headerObj.timestamp);
    if (typeof headerObj.cwd === "string") {
      state.meta.cwd = headerObj.cwd;
    }
  }

  if (!state.meta.cwd && typeof sessionManager.getCwd === "function") {
    state.meta.cwd = String(sessionManager.getCwd() || "");
  }

  const leafId =
    typeof sessionManager.getLeafId === "function"
      ? (sessionManager.getLeafId() as string | null)
      : null;

  const branchEntries: unknown[] =
    leafId && typeof sessionManager.getBranch === "function"
      ? (sessionManager.getBranch(leafId) as unknown[])
      : [];

  for (const entry of branchEntries) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    applyMessageRecord(entry as Record<string, unknown>, state, options);
  }

  return { meta: state.meta, conversation: state.conversation, leafId };
}

function buildMarkdownContent(
  meta: SessionMeta,
  sessionFile: string,
  conversation: string[],
  lastTurns: number | null,
  branchInfo?: { leafId: string | null }
): { content: string; filename: string } | null {
  const finalConversation =
    lastTurns && lastTurns > 0 ? sliceLastNTurns(conversation, lastTurns) : conversation;

  if (finalConversation.length === 0) {
    return null;
  }

  const project = meta.cwd ? path.basename(meta.cwd) : "unknown";
  const projectSlug = slug(project);

  const started = meta.startedAt || new Date();
  const stamp = formatTimestamp(started);
  const sid = (meta.sessionId || "unknown").slice(0, 8);
  const filename = `${projectSlug}_pi_${stamp}_${sid}.md`;

  const lines: string[] = [];
  lines.push("PI SESSION (processed)");
  if (branchInfo) {
    lines.push("mode: branch");
    lines.push(`leaf: ${branchInfo.leafId === null ? "null" : branchInfo.leafId}`);
  }
  if (meta.sessionId) {
    lines.push(`id: ${meta.sessionId}`);
  }
  if (meta.startedAt) {
    lines.push(`started: ${meta.startedAt.toISOString()}`);
  }
  if (meta.cwd) {
    lines.push(`cwd: ${meta.cwd}`);
  }
  lines.push(`source: ${sessionFile}`);
  if (lastTurns && lastTurns > 0) {
    lines.push(`turns: last ${lastTurns}`);
  }
  lines.push("");

  for (const msg of finalConversation) {
    lines.push(msg.trimEnd());
    lines.push("");
  }

  return { content: lines.join("\n"), filename };
}

/**
 * Generate markdown content from the current branch without writing to file
 */
function generateMarkdownFromBranch(
  sessionManager: any,
  sessionFile: string,
  options: ExportOptions,
  lastTurns: number | null = null
): { content: string; filename: string } | null {
  const { meta, conversation, leafId } = extractConversationFromBranch(
    sessionManager,
    options
  );
  return buildMarkdownContent(meta, sessionFile, conversation, lastTurns, {
    leafId,
  });
}

/**
 * Generate markdown content from full session file without writing to file
 */
async function generateMarkdownFromSession(
  jsonlFile: string,
  options: ExportOptions,
  lastTurns: number | null = null
): Promise<{ content: string; filename: string } | null> {
  const { meta, conversation } = await extractConversation(jsonlFile, options);
  return buildMarkdownContent(meta, jsonlFile, conversation, lastTurns);
}

/**
 * Copy text to clipboard (macOS)
 */
function copyToClipboard(text: string): void {
  execSync("pbcopy", { input: text });
}

/**
 * Format date as YYYYMMDD_HHMMSS
 */
function formatTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/**
 * Slice a flattened conversation array to the last N turns
 *
 * A turn is defined as a unit of [USER message -> ASSISTANT message], including any
 * SYSTEM tool outputs that occur in between, until the next USER message begins.
 */
function sliceLastNTurns(conversation: string[], turns: number): string[] {
  if (!Number.isFinite(turns) || turns <= 0) {
    return conversation;
  }

  const userMessageIndices: number[] = [];
  for (let i = 0; i < conversation.length; i++) {
    if (conversation[i].startsWith("USER:")) {
      userMessageIndices.push(i);
    }
  }

  if (userMessageIndices.length === 0) {
    return conversation;
  }

  const startIndex =
    userMessageIndices.length <= turns
      ? 0
      : userMessageIndices[userMessageIndices.length - turns];

  return conversation.slice(startIndex);
}

function parseToolFilter(tokensLower: string[]): ToolFilter {
  const includeNames = new Set<string>();
  const excludeNames = new Set<string>();

  for (const token of tokensLower) {
    if (!["+", "-"].includes(token[0]) || token.length < 2) {
      continue;
    }

    const name = normalizeToolName(token.slice(1));
    if (!name) {
      continue;
    }

    if (token.startsWith("+")) {
      includeNames.add(name);
    } else {
      excludeNames.add(name);
    }
  }

  return {
    mode: includeNames.size > 0 ? "includeOnly" : "all",
    includeNames,
    excludeNames,
  };
}

function hasToolFilterTokens(tokensLower: string[]): boolean {
  return tokensLower.some((token) => /^[+-].+/.test(token));
}

function describeToolFilter(toolFilter: ToolFilter | null): string | null {
  if (!toolFilter) {
    return null;
  }

  const includes = [...toolFilter.includeNames].sort().map((name) => `+${name}`);
  const excludes = [...toolFilter.excludeNames].sort().map((name) => `-${name}`);

  if (toolFilter.mode === "includeOnly") {
    return ["tool calls", ...includes, ...excludes].join(" ");
  }
  if (excludes.length > 0) {
    return ["tool calls", ...excludes].join(" ");
  }
  return "tool calls";
}

// Use session's cwd (where you ran pi from) instead of ~/.pi/agent/pi-sessions-extracted/
const OUTPUT_DIR_FALLBACK = path.join(os.homedir(), ".pi", "agent", "pi-sessions-extracted");

export interface MdRequest {
  thinking: boolean;
  /** null: tool calls left out */
  toolFilter: ToolFilter | null;
  wholeSession: boolean;
  lastTurns: number | null;
}

const MD_WORDS: Record<string, string> = {
  tc: "include tool calls (+name only that tool, -name leave one out)",
  thinking: "include thinking",
  all: "the whole session, not just this branch",
};

const MD_USAGE = "Use tc (tool calls, +name/-name to pick tools), thinking (or t), all (whole session) and a number (last N turns), like /md tc t 3.";

/** The words after /md; anything it does not know is an error, never ignored. */
export function parseMdArgs(args: string): { ok: true; request: MdRequest } | { ok: false; message: string } {
  const tokens = args.trim().split(/\s+/).filter(Boolean).map((t) => t.toLowerCase());
  let thinking = false;
  let toolCalls = false;
  let wholeSession = false;
  let lastTurns: number | null = null;
  for (const token of tokens) {
    if (token === "t" || token === "think" || token === "thinking") thinking = true;
    else if (token === "tc" || token === "tools") toolCalls = true;
    else if (token === "all" || token === "file") wholeSession = true;
    else if (/^\d+$/.test(token)) {
      const n = Number(token);
      if (n < 1) return { ok: false, message: "The number of turns must be 1 or more, like /md 2." };
      lastTurns = n;
    } else if (token === "+all" || token === "-all") {
      return { ok: false, message: "+all and -all don't exist: use tc for every tool call, or tc +name for one tool." };
    } else if (!/^[+-].+/.test(token)) {
      return { ok: false, message: `/md has no "${token}". ${MD_USAGE}` };
    }
  }
  if (hasToolFilterTokens(tokens) && !toolCalls) {
    return { ok: false, message: "Picking tools needs tc too, like /md tc -bash or /md tc +ask." };
  }
  return { ok: true, request: { thinking, toolFilter: toolCalls ? parseToolFilter(tokens) : null, wholeSession, lastTurns } };
}

const TURN_CHOICES = ["everything", "last turn", "last 3 turns", "last 10 turns"];

function turnsLabel(n: number | null): string {
  return n === null ? "everything" : n === 1 ? "last turn" : `last ${n} turns`;
}

function turnsFromLabel(label: string): number | null {
  const n = /^last (\d+) turns$/.exec(label)?.[1];
  return label === "last turn" ? 1 : n ? Number(n) : null;
}

export function mdMenu(request: MdRequest, outputDir: string): MenuSpec {
  const turns = turnsLabel(request.lastTurns);
  const filter = describeToolFilter(request.toolFilter);
  return {
    title: "Export this chat as Markdown",
    items: [
      {
        id: "tools",
        label: "Tool calls",
        values: ["left out", "included"],
        value: request.toolFilter ? "included" : "left out",
        ...(filter && filter !== "tool calls" ? { note: filter.replace(/^tool calls /, "") } : {}),
      },
      { id: "thinking", label: "Thinking", values: ["left out", "included"], value: request.thinking ? "included" : "left out" },
      { id: "scope", label: "From", values: ["this branch", "the whole session"], value: request.wholeSession ? "the whole session" : "this branch" },
      { id: "turns", label: "How much", values: TURN_CHOICES.includes(turns) ? TURN_CHOICES : [...TURN_CHOICES, turns], value: turns },
      { id: "copy", label: "Copy to clipboard" },
      { id: "save", label: "Save as a .md file", note: `in ${outputDir}` },
    ],
    initial: "copy",
  };
}

/** The request with the menu's settings applied; a tool filter typed on the command line is kept while tool calls stay on. */
export function applyMdMenu(request: MdRequest, values: Record<string, string>): MdRequest {
  const tools = values.tools === "included";
  return {
    thinking: values.thinking === "included",
    toolFilter: tools ? (request.toolFilter ?? parseToolFilter([])) : null,
    wholeSession: values.scope === "the whole session",
    lastTurns: turnsFromLabel(values.turns ?? "everything"),
  };
}

function completeMd(typed: string): { value: string; label: string; description: string }[] | null {
  const cut = typed.lastIndexOf(" ") + 1;
  const before = typed.slice(0, cut);
  const word = typed.slice(cut).toLowerCase();
  const used = new Set(before.toLowerCase().split(/\s+/));
  const items = Object.entries(MD_WORDS)
    .filter(([name]) => name.startsWith(word) && !used.has(name))
    .map(([name, description]) => ({ value: `${before}${name} `, label: name, description }));
  return withoutTyped(items, typed);
}

export default function (pi: ExtensionAPI) {
  async function exportChat(ctx: ExtensionCommandContext, sessionFile: string, request: MdRequest, target: "copy" | "save", outputDir: string): Promise<void> {
    const options: ExportOptions = { includeThinking: request.thinking, toolFilter: request.toolFilter };
    const result = request.wholeSession
      ? await generateMarkdownFromSession(sessionFile, options, request.lastTurns)
      : generateMarkdownFromBranch(ctx.sessionManager, sessionFile, options, request.lastTurns);
    if (!result) {
      ctx.ui.notify(`Nothing to export: no conversation in ${request.wholeSession ? "this session" : "this branch"} yet.`, "warning");
      return;
    }
    const extras = [request.thinking ? "thinking" : "", describeToolFilter(request.toolFilter) ?? ""].filter(Boolean);
    const what = `${request.wholeSession ? "the whole session" : "this branch"}${request.lastTurns ? `, ${turnsLabel(request.lastTurns)}` : ""}${extras.length ? `, with ${extras.join(" and ")}` : ""}`;
    if (target === "copy") {
      copyToClipboard(result.content);
      ctx.ui.notify(`Copied ${what} to the clipboard.`, "info");
      return;
    }
    const outputFile = path.join(outputDir, result.filename);
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(outputFile, result.content, "utf-8");
    ctx.ui.notify(`Saved ${what} to ${outputFile}`, "info");
  }

  pi.registerCommand("md", {
    description: "Copy or save this chat as Markdown, with or without tool calls and thinking",
    getArgumentCompletions: completeMd,
    handler: async (args, ctx) => {
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile) {
        ctx.ui.notify("This session isn't saved to a file, so there is nothing to export.", "error");
        return;
      }
      const parsed = parseMdArgs(args);
      if (!parsed.ok) {
        ctx.ui.notify(parsed.message, "error");
        return;
      }
      const outputDir = ctx.sessionManager.getCwd() || OUTPUT_DIR_FALLBACK;
      let request = parsed.request;
      let target: "copy" | "save";
      if (canShowMenu(ctx)) {
        const choice = await showMenu(ctx, mdMenu(request, outputDir));
        if (choice?.id !== "copy" && choice?.id !== "save") return;
        request = applyMdMenu(request, choice.values);
        target = choice.id;
      } else {
        const copy = "Copy to clipboard";
        const picked = await ctx.ui.select("Export this chat as Markdown", [copy, `Save as a .md file in ${outputDir}`]);
        if (!picked) return;
        target = picked === copy ? "copy" : "save";
      }
      try {
        await exportChat(ctx, sessionFile, request, target, outputDir);
      } catch (err) {
        ctx.ui.notify(`Export failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });
}
