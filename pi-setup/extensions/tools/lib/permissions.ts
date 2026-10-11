/**
 * permission evaluation for tool calls.
 *
 * reads rules from ~/.pi/agent/permissions.json (separate from
 * settings.json since this is extension-owned config). rules are
 * evaluated first-match-wins, matching tool name and params via
 * glob patterns. default action when no rule matches: allow.
 *
 * format mirrors amp's amp.permissions schema:
 *   { tool, matches?, action, message? }
 *
 * only "allow" and "reject" actions for now — no "ask" or "delegate"
 * because pi's tool execute API has no confirmation mechanism.
 *
 * these are product guardrails for tool routing and ergonomics, NOT a security
 * boundary — a determined caller can always shell out around them.
 *
 * MATCHERS (cmd/cwd/path ported from bdsqqq/dots `core/tool-policy`, MIT,
 * commit e04b620; names kept as ours since bash.ts already calls
 * evaluatePermission and our rules live in permissions.json):
 *   cmd    — glob the shell command
 *   cwd    — glob the working directory
 *   path   — glob any path the call touches (`path` or `paths[]`)
 *   within — containment guard. EVERY touched path must resolve inside one of
 *            the given roots. resolves to absolute first, so `../` escapes are
 *            caught rather than matched as text. fails closed.
 *
 * all matchers on a rule must pass for the rule to apply (AND); within each
 * matcher a list of patterns is an OR.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expandPath, isPathWithin, resolveToAbsolute } from "./fs";

// --- types ---

type PermissionPattern = string | string[];

export interface PermissionRule {
	tool: string;
	matches?: {
		/** glob against the shell command (bash). */
		cmd?: PermissionPattern;
		/** glob against the working directory. */
		cwd?: PermissionPattern;
		/** glob against any path the call touches (`path` or `paths[]`). */
		path?: PermissionPattern;
		/**
		 * containment guard: EVERY path the call touches must resolve inside at
		 * least one of these roots. unlike `path`, this is not string matching —
		 * paths are resolved to absolute first, so `../` escapes are caught.
		 */
		within?: PermissionPattern;
	};
	action: "allow" | "reject";
	message?: string;
}

/** what the caller observed about a tool invocation. */
export interface PermissionParams {
	cmd?: string;
	cwd?: string;
	path?: string;
	paths?: string[];
	/** used to resolve relative paths/roots to absolute. */
	sessionCwd?: string;
}

export interface PermissionVerdict {
	action: "allow" | "reject";
	message?: string;
}

// --- glob matching ---

/**
 * convert a simple glob pattern (only `*` wildcards) to a regex.
 * covers all patterns amp documents: `*git push*`, `rm *`, `*`.
 */
function globToRegex(pattern: string): RegExp {
	// escape hatch: `regex:<expr>` is used verbatim (unanchored, case-insensitive).
	//
	// plain `*` globs are anchored, so guarding a command word means enumerating
	// every separator form — `rm *`, `* && rm *`, `* ; rm *` ... and anything not
	// listed silently passes. measured bypasses before this existed:
	//   "echo hi; rm f"            (no space before ';')
	//   "echo hi;rm f"
	//   "for f in *; do rm $f; done"
	//   "find . -exec rm {} +"
	//   "xargs rm < list"
	// a regex can express "rm as a command word after any separator" once.
	if (pattern.startsWith("regex:")) {
		try {
			return new RegExp(pattern.slice("regex:".length), "i");
		} catch {
			// a malformed rule must not silently match everything — fail closed by
			// returning a pattern that matches nothing.
			return /(?!)/;
		}
	}
	const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	const withWildcards = escaped.replace(/\*/g, ".*");
	return new RegExp(`^${withWildcards}$`, "i");
}

function toPatterns(patterns: PermissionPattern): string[] {
	return Array.isArray(patterns) ? patterns : [patterns];
}

function matchesGlob(value: string, patterns: PermissionPattern): boolean {
	return toPatterns(patterns).some((pattern) => globToRegex(pattern).test(value));
}

/** every path this call touches, via `path` and `paths[]`. */
function collectObservedPaths(params: PermissionParams): string[] {
	return [params.path, ...(params.paths ?? [])].filter(
		(value): value is string => typeof value === "string" && value.length > 0,
	);
}

/** for containment, the working directory counts as a touched path too. */
function collectWithinPaths(params: PermissionParams): string[] {
	const observed = collectObservedPaths(params);
	if (typeof params.cwd === "string" && params.cwd.length > 0) observed.push(params.cwd);
	return observed;
}

function resolvePathLike(value: string, sessionCwd: string | undefined): string | null {
	if (sessionCwd) return resolveToAbsolute(value, sessionCwd);
	const expanded = expandPath(value);
	return path.isAbsolute(expanded) ? expanded : null;
}

/**
 * true only when EVERY observed path resolves inside at least one root.
 * fails closed: unresolvable paths, or no observed paths at all, do not match.
 */
function matchesWithin(params: PermissionParams, roots: PermissionPattern): boolean {
	const observedPaths = collectWithinPaths(params);
	if (observedPaths.length === 0) return false;

	const resolvedRoots = toPatterns(roots)
		.map((root) => resolvePathLike(root, params.sessionCwd))
		.filter((root): root is string => root !== null);
	if (resolvedRoots.length === 0) return false;

	return observedPaths.every((observedPath) => {
		const resolvedTarget = resolvePathLike(observedPath, params.sessionCwd);
		if (!resolvedTarget) return false;
		return resolvedRoots.some((root) => isPathWithin(root, resolvedTarget));
	});
}

const RUNS_HEREDOC = /\b(?:sh|bash|zsh|dash|ksh|fish|python3?|node|bun|deno|perl|ruby|php|osascript|eval|source|ssh|xargs|exec)\b/;
const HEREDOC_OPEN = /<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1/g;

/**
 * Drops heredoc bodies that are only data (a commit message, `cat > file`), so a
 * line in them is not read as a command. A body fed to a shell or interpreter on
 * the same line is kept: that text runs.
 */
export function withoutDataHeredocs(cmd: string): string {
	const lines = cmd.split("\n");
	const kept: string[] = [];
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]!;
		kept.push(line);
		const tags = [...line.matchAll(HEREDOC_OPEN)].map((match) => match[2]!);
		if (tags.length === 0 || RUNS_HEREDOC.test(line)) continue;
		for (const tag of tags) {
			while (index + 1 < lines.length && lines[index + 1]!.trim() !== tag) index++;
			if (index + 1 < lines.length) kept.push(lines[++index]!);
		}
	}
	return kept.join("\n");
}

// --- evaluation ---

export function evaluatePermission(
	toolName: string,
	params: PermissionParams,
	rules: PermissionRule[],
): PermissionVerdict {
	for (const rule of rules) {
		if (!globToRegex(rule.tool).test(toolName)) continue;

		if (rule.matches?.cmd && !matchesGlob(params.cmd ?? "", rule.matches.cmd)) continue;

		if (rule.matches?.cwd) {
			if (!params.cwd || !matchesGlob(params.cwd, rule.matches.cwd)) continue;
		}

		if (rule.matches?.path) {
			const observedPaths = collectObservedPaths(params);
			if (
				observedPaths.length === 0 ||
				!observedPaths.some((observedPath) => matchesGlob(observedPath, rule.matches!.path!))
			) {
				continue;
			}
		}

		if (rule.matches?.within && !matchesWithin(params, rule.matches.within)) continue;

		return { action: rule.action, message: rule.message };
	}

	return { action: "allow" };
}

// --- loading ---

const PERMISSIONS_PATH = path.join(os.homedir(), ".pi", "agent", "permissions.json");

export function loadPermissions(): PermissionRule[] {
	try {
		const raw = fs.readFileSync(process.env.PI_PERMISSIONS_FILE || PERMISSIONS_PATH, "utf-8");
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed;
	} catch {
		return [];
	}
}
