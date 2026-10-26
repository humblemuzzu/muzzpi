/**
 * search_sessions — find session branches by keyword, file, or date.
 *
 * a pi session is a tree, so the unit is a branch (one root-to-leaf path), not
 * a whole file. the sessions are read through lib/session-index, which keeps a
 * summary per file and re-reads only files that changed. never writes a session.
 */

import * as path from "node:path";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { type BoxSection, type Excerpt, boxRendererWindowed } from "./lib/box-format";
import { type BranchResult, branchesOf, createSlicer, defaultSessionIndex, type SessionIndex } from "./lib/session-index";

const MAX_RESULTS = 50;
const PROGRESS_EVERY_MS = 250;

const COLLAPSED_EXCERPTS: Excerpt[] = [{ focus: "head" as const, context: 5 }];

function uniqueBy<T>(values: T[], key: (value: T) => string): T[] {
  const claimed = new Set<string>();
  return values.filter((value) => {
    const identity = key(value);
    if (claimed.has(identity)) return false;
    claimed.add(identity);
    return true;
  });
}

// --- search filtering ---

function matchesKeyword(branch: BranchResult, keyword: string): boolean {
  const lower = keyword.toLowerCase();
  if (branch.sessionName.toLowerCase().includes(lower)) return true;
  if (branch.searchableText.toLowerCase().includes(lower)) return true;
  return false;
}

function matchesFile(branch: BranchResult, fileQuery: string): boolean {
  const lower = fileQuery.toLowerCase();
  return branch.filesTouched.some((f) => f.toLowerCase().includes(lower));
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

function parseDate(dateStr: string): Date | null {
  const relMatch = dateStr.trim().match(/^(\d+)([dw])$/);
  if (relMatch && relMatch[1] && relMatch[2]) {
    const n = parseInt(relMatch[1], 10);
    const unit = relMatch[2];
    const now = new Date();
    if (unit === "d") now.setDate(now.getDate() - n);
    else if (unit === "w") now.setDate(now.getDate() - n * 7);
    return now;
  }
  if (!ISO_DATE.test(dateStr.trim())) return null;
  const d = new Date(dateStr.trim());
  return isNaN(d.getTime()) ? null : d;
}

function matchesDateRange(
  branch: BranchResult,
  after: Date | null,
  before: Date | null,
): boolean {
  if (after && new Date(branch.timestampEnd) < after) return false;
  if (before && new Date(branch.timestampStart) > before) return false;
  return true;
}

// --- format results ---

function formatBranchResults(
  branches: BranchResult[],
  total = branches.length,
): string {
  if (branches.length === 0) return "(no matching sessions found)";

  const lines: string[] = [];

  const half = Math.floor(branches.length / 2);
  lines.push(
    total > branches.length
      ? `found ${total} matching branches; showing the ${half} newest and ${branches.length - half} oldest ` +
          `(${total - branches.length} in between omitted — narrow with keyword, file, after or before):`
      : `found ${total} matching branch${total !== 1 ? "es" : ""}:`,
  );
  lines.push("");

  for (let i = 0; i < branches.length; i++) {
    const b = branches[i];
    if (!b) continue;
    const dateStr = new Date(b.timestampEnd).toLocaleDateString("en-US", {
      weekday: "short",
      year: "numeric",
      month: "short",
      day: "numeric",
    });
    const timeStr = new Date(b.timestampEnd).toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
    });

    lines.push(`### ${i + 1}. ${b.sessionName || "(unnamed)"}`);
    lines.push(`session: ${b.sessionId} / branch: ${b.leafId}`);
    if (b.parentSessionPath) lines.push(`forked from: ${parentIdOf(b.parentSessionPath)}`);
    lines.push(`${dateStr} ${timeStr} — ${b.messageCount} messages`);
    if (b.models.length > 0) lines.push(`models: ${b.models.join(", ")}`);
    if (b.filesTouched.length > 0) {
      const shown = b.filesTouched.slice(0, 10);
      lines.push(
        `files: ${shown.join(", ")}${b.filesTouched.length > 10 ? ` (+${b.filesTouched.length - 10} more)` : ""}`,
      );
    }
    if (b.firstUserMessage) {
      const preview =
        b.firstUserMessage.length > 150
          ? `${b.firstUserMessage.slice(0, 150)}...`
          : b.firstUserMessage;
      lines.push(`> ${preview}`);
    }

    if (i < branches.length - 1) lines.push("");
  }

  return lines.join("\n");
}

/** format: 2026-02-20T14-50-17-926Z_<id>.jsonl */
function parentIdOf(parentSessionPath: string): string {
  return path.basename(parentSessionPath).replace(/\.jsonl$/, "").split("_")[1] || parentSessionPath;
}

function branchesToSections(branches: BranchResult[]): BoxSection[] {
  return branches.map((b, i) => {
    const dateStr = new Date(b.timestampEnd).toLocaleDateString("en-US", {
      weekday: "short",
      year: "numeric",
      month: "short",
      day: "numeric",
    });
    const timeStr = new Date(b.timestampEnd).toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
    });

    const lines: { text: string; highlight?: boolean }[] = [];
    lines.push({
      text: `session: ${b.sessionId} / branch: ${b.leafId}`,
      highlight: true,
    });
    if (b.parentSessionPath) lines.push({ text: `forked from: ${parentIdOf(b.parentSessionPath)}`, highlight: true });
    lines.push({
      text: `${dateStr} ${timeStr} — ${b.messageCount} messages`,
      highlight: true,
    });
    if (b.models.length > 0)
      lines.push({ text: `models: ${b.models.join(", ")}`, highlight: true });
    if (b.filesTouched.length > 0) {
      const shown = b.filesTouched.slice(0, 10);
      lines.push({
        text: `files: ${shown.join(", ")}${b.filesTouched.length > 10 ? ` (+${b.filesTouched.length - 10} more)` : ""}`,
        highlight: true,
      });
    }
    if (b.firstUserMessage) {
      const preview =
        b.firstUserMessage.length > 150
          ? `${b.firstUserMessage.slice(0, 150)}...`
          : b.firstUserMessage;
      lines.push({ text: `> ${preview}`, highlight: false });
    }

    return {
      header: b.sessionName || `session ${i + 1}`,
      blocks: [{ lines }],
    };
  });
}

// --- tool ---

interface SearchSessionsParams {
  keyword?: string;
  file?: string;
  after?: string;
  before?: string;
  workspace?: string;
  all_workspaces?: boolean;
}

const text = (value: string, isError = false) => ({ content: [{ type: "text" as const, text: value }], ...(isError ? { isError: true } : {}) }) as any;

export function createSearchSessionsTool(index: SessionIndex = defaultSessionIndex()): ToolDefinition<any> {
  return {
    name: "search_sessions",
    label: "Search Sessions",
    description:
      "Search pi session history by keyword, file path, or date range.\n\n" +
      "Sessions are trees with branches. Each branch (root-to-leaf path) is a " +
      "separate search result with its own files-touched set and message chain.\n\n" +
      "Scoped to current workspace by default. Use `all_workspaces: true` to search everywhere.\n\n" +
      "Use `read_session` to extract detailed content from a specific session.\n\n" +
      "WHEN TO USE:\n" +
      '- "Find the session where I worked on X"\n' +
      '- "What session touched this file?"\n' +
      '- "Show recent sessions"\n' +
      "- Looking up prior context from past conversations\n\n" +
      "WHEN NOT TO USE:\n" +
      "- Current session context (already available)\n" +
      "- Git history (use git log)",

    parameters: Type.Object({
      keyword: Type.Optional(
        Type.String({
          description:
            "Text to search for in session names, user messages, and assistant responses.",
        }),
      ),
      file: Type.Optional(
        Type.String({
          description:
            "File path (partial match) to find sessions that touched this file.",
        }),
      ),
      after: Type.Optional(
        Type.String({
          description:
            "Only return sessions after this date. ISO date (2026-02-20) or relative (7d, 2w).",
        }),
      ),
      before: Type.Optional(
        Type.String({
          description:
            "Only return sessions before this date. ISO date or relative.",
        }),
      ),
      workspace: Type.Optional(
        Type.String({
          description:
            "Filter by workspace path (partial match against session cwd). Defaults to current workspace.",
        }),
      ),
      all_workspaces: Type.Optional(
        Type.Boolean({
          description:
            "Search across all workspaces instead of just the current one.",
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const p = params as SearchSessionsParams;
      const dates: Record<"after" | "before", Date | null> = { after: null, before: null };
      for (const key of ["after", "before"] as const) {
        const raw = p[key];
        if (!raw) continue;
        dates[key] = parseDate(raw);
        if (!dates[key]) {
          return text(`invalid ${key} date ${JSON.stringify(raw)}: use an ISO date (2026-02-20, 2026-02-20T14:30) or a relative age (7d, 2w).`, true);
        }
      }

      let reported = 0;
      try {
        await index.refresh(signal, ({ done, total }) => {
          const now = Date.now();
          if (now - reported < PROGRESS_EVERY_MS) return;
          reported = now;
          onUpdate?.({ content: [{ type: "text", text: `(indexing past sessions: ${done} of ${total})` }] } as any);
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        return text(`(could not read the sessions: ${(error as Error).message})`, true);
      }

      // the first file holding a session id is that session; a copy is not a second one
      let rows = uniqueBy(index.rows().filter((row) => row.id), (row) => row.id);
      if (rows.length === 0) return text("(no sessions found)");

      const workspaceFilter = (p.all_workspaces ? undefined : p.workspace || ctx.cwd)?.toLowerCase();
      if (workspaceFilter) rows = rows.filter((row) => row.cwd.toLowerCase().includes(workspaceFilter));

      // `after` is about the LAST activity, which the filename (session start) cannot tell
      if (dates.after) rows = rows.filter((row) => row.mtimeMs >= dates.after!.getTime());
      if (dates.before) {
        rows = rows.filter((row) => {
          const started = path.basename(row.path).match(/^(\d{4}-\d{2}-\d{2})T/)?.[1];
          return !started || new Date(started) <= dates.before!;
        });
      }

      if (p.keyword) {
        const keys = await index.keysContaining(p.keyword, signal);
        if (keys) rows = rows.filter((row) => keys.has(row.key));
      }

      const slice = createSlicer();
      const allBranches: BranchResult[] = [];
      for (const row of rows) {
        signal?.throwIfAborted();
        const summary = await index.summary(row, signal);
        if (summary) allBranches.push(...branchesOf(summary, row.path));
        await slice();
      }

      let filtered = uniqueBy(allBranches, (branch) => `${branch.sessionId}\0${branch.leafId}`);
      if (p.keyword) filtered = filtered.filter((b) => matchesKeyword(b, p.keyword!));
      if (p.file) filtered = filtered.filter((b) => matchesFile(b, p.file!));
      if (p.after || p.before) filtered = filtered.filter((b) => matchesDateRange(b, dates.after, dates.before));

      filtered.sort((a, b) => new Date(b.timestampEnd).getTime() - new Date(a.timestampEnd).getTime());

      const shown =
        filtered.length > MAX_RESULTS
          ? [...filtered.slice(0, MAX_RESULTS / 2), ...filtered.slice(-MAX_RESULTS / 2)]
          : filtered;
      const truncated = filtered.length - shown.length;

      return {
        content: [{ type: "text" as const, text: formatBranchResults(shown, filtered.length) }],
        details: { resultSections: branchesToSections(shown), truncated },
      } as any;
    },

    renderCall(args: any, theme: any) {
      const parts: string[] = [];
      if (args.keyword) parts.push(args.keyword);
      if (args.file) parts.push(`file:${args.file}`);
      if (args.after) parts.push(`after:${args.after}`);
      if (args.before) parts.push(`before:${args.before}`);
      if (args.workspace) parts.push(`ws:${args.workspace}`);
      const preview = parts.join(" ") || "...";
      return new Text(
        theme.fg("toolTitle", theme.bold("search_sessions ")) +
          theme.fg("dim", preview),
        0,
        0,
      );
    },

    renderResult(
      result: any,
      { expanded }: { expanded: boolean },
      _theme: any,
    ) {
      const sections: BoxSection[] | undefined = result.details?.resultSections;
      if (!sections?.length)
        return new Text(result.content?.[0]?.text ?? "(no output)", 0, 0);

      const truncated: number = result.details?.truncated ?? 0;
      const notices =
        truncated > 0 ? [`${truncated} sessions omitted`] : undefined;

      return boxRendererWindowed(
        () => sections,
        {
          collapsed: { maxSections: 3, excerpts: COLLAPSED_EXCERPTS },
          expanded: {},
        },
        notices,
        expanded,
      );
    },
  };
}
