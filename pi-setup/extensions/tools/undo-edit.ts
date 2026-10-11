/**
 * undo_edit tool — reverts the last edit made to a file.
 *
 * uses lib/file-tracker's disk-based change records to find and
 * revert the most recent non-reverted change for a given file.
 *
 * branch awareness: scans the current session branch (via
 * sessionManager.getBranch()) to extract tool call IDs, then
 * only considers changes from those IDs. this prevents undoing
 * edits from a different conversation branch.
 *
 * mutex-locked to prevent concurrent undo + edit on the same file.
 */

import * as os from "node:os";
import * as path from "node:path";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
	byWriteOrder,
	netPerFile,
	findLatestChange,
	findMovePartner,
	loadChanges,
	matchesRecordedState,
	reapplyChange,
	revertChange,
	simpleDiff,
	type FileChange,
} from "./lib/file-tracker";
import { withFileLock } from "./lib/mutex";
import { resolveWithVariants } from "./read";
import { osc8Link, renderBoxedText } from "./lib/box-format";
import { getText } from "./lib/tui";

/**
 * extract tool call IDs from the current session branch.
 * session entries with type "message" and role "assistant" carry the
 * assistant's tool calls as content blocks of type "toolCall" (pi's
 * normalized format). we collect all tool call IDs so findLatestChange
 * can filter to only branch-visible changes.
 *
 * falls back to empty array if getBranch() isn't available (e.g.,
 * running in a context where session tree access is restricted).
 */
function getActiveToolCallIds(sessionManager: any): string[] {
	try {
		const branch = sessionManager.getBranch?.();
		if (!Array.isArray(branch)) return [];

		const ids: string[] = [];
		for (const entry of branch) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg?.role !== "assistant") continue;

			// pi normalizes every provider's assistant tool calls into CONTENT
			// BLOCKS of type "toolCall" — { type: "toolCall", id, name, arguments }.
			// This is pi's own stable internal format (not a provider wire format
			// like anthropic "tool_use" or openai "tool_calls"), so matching it is
			// exact and complete. The previous code matched only "tool_use" /
			// "tool_calls" and therefore NEVER matched — that was the root bug.
			if (Array.isArray(msg.content)) {
				for (const block of msg.content) {
					if (block && typeof block === "object" && block.type === "toolCall" && block.id) {
						ids.push(block.id);
					}
				}
			}
		}
		return ids;
	} catch {
		return [];
	}
}

export function createUndoEditTool(): ToolDefinition {
	return {
		name: "undo_edit",
		label: "Undo Edit",
		description:
			"Undo the last change made to a file.\n\n" +
			"By default this reverts the WHOLE change that last touched the file — when one " +
			"tool call wrote several files (a codemode script), every file it wrote is rolled " +
			"back. Pass scope: \"file\" to revert only the named path.\n\n" +
			"Returns a diff showing what was undone. Use redo_edit to put it back.",

		parameters: Type.Object({
			path: Type.String({
				description:
					"Path of the file whose last edit should be undone: absolute, relative to the working directory, or ~/...",
			}),
			scope: Type.Optional(
				Type.Union([Type.Literal("call"), Type.Literal("file")], {
					description:
						'"call" (default) reverts every file written by the change that last touched this path; "file" reverts only this path.',
				}),
			),
			force: Type.Optional(
				Type.Boolean({
					description:
						"Undo even if the file has been modified by something other than this tool since. Those modifications are not recorded anywhere and will be lost.",
				}),
			),
		}),

		renderCall(args: any, theme: any, context: any) {
			const Text = getText();
			const text = context?.lastComponent ?? new Text("", 0, 0);
			const filePath = args.path || "...";
			const home = os.homedir();
			const shortened = filePath.startsWith(home) ? `~${filePath.slice(home.length)}` : filePath;
			const linked = filePath.startsWith("/") ? osc8Link(`file://${filePath}`, shortened) : shortened;
			text.setText(theme.fg("toolTitle", theme.bold("Undo ")) + theme.fg("dim", linked));
			return text;
		},

		renderResult: renderBoxedText,

		async execute(_toolCallId, params: any, _signal, _onUpdate, ctx) {
			const resolved = resolveWithVariants(params.path, ctx.cwd);

			return withFileLock(resolved, async () => {
				const sessionId = ctx.sessionManager.getSessionId();
				const activeIds = getActiveToolCallIds(ctx.sessionManager);

				if (activeIds.length === 0) {
					return {
						content: [
							{
								type: "text" as const,
								text: "no edits found to undo (no tool calls in current branch).",
							},
						],
						isError: true,
					} as any;
				}

				const latest = findLatestChange(sessionId, resolved, activeIds);
				if (!latest) {
					return {
						content: [
							{
								type: "text" as const,
								text: `no edits found to undo for ${path.basename(resolved)}.`,
							},
						],
						isError: true,
					} as any;
				}

				/*
				 * UNDO IS A STACK, NOT RANDOM ACCESS.
				 *
				 * Reaching past a newer change produces a state nobody can reason
				 * about. grok-4.5's example: create A and C in one batch, later
				 * move A to B, then undo the create batch. Undoing a creation
				 * means "delete it" — but A is not there any more, so the delete
				 * is a no-op and the content lives on at B, with its creation
				 * history marked undone. Not data loss, but an incoherent state,
				 * and incoherent is how data loss starts.
				 *
				 * So: refuse when a LATER still-applied change touches any path
				 * this undo would revert, and name what to undo first. This is
				 * exactly the invalidation rule `redo_edit` uses, pointed the
				 * other way — undo and redo now agree on what "newer" means.
				 *
				 * Independent work is unaffected: editing A then B leaves no
				 * later change on A, so undoing A is still allowed.
				 */
				const scopeIsFile = (params as any).scope === "file";
				const targetUris = new Set(
					loadChanges(sessionId, latest.toolCallId)
						.filter((c) => !c.reverted && (!scopeIsFile || c.uri === latest.change.uri))
						.map((c) => c.uri),
				);
				/*
				 * ORDER COMES FROM THE BRANCH, NOT FROM `timestamp`.
				 *
				 * `Date.now()` is millisecond-resolution, so two tool calls in
				 * quick succession can carry the SAME timestamp — and a
				 * strictly-greater comparison then reads them as concurrent and
				 * lets the undo through. `activeIds` is the branch in order, so a
				 * later index is later in time by construction, with no clock to
				 * be wrong about.
				 */
				const targetIndex = activeIds.lastIndexOf(latest.toolCallId);
				const blockedBy = new Set<string>();
				for (let i = targetIndex + 1; i < activeIds.length; i++) {
					for (const change of loadChanges(sessionId, activeIds[i]!)) {
						if (change.reverted || !targetUris.has(change.uri)) continue;
						blockedBy.add(path.basename(change.uri.replace(/^file:\/\//, "")));
					}
				}
				if (blockedBy.size > 0) {
					return {
						content: [
							{
								type: "text" as const,
								text:
									`cannot undo that change: something newer has since modified ${[...blockedBy].join(", ")}. ` +
									`Undo the newer change first, or the result would be a file whose history says it was ` +
									`never created while its content still exists somewhere.`,
							},
						],
						isError: true,
					} as any;
				}

				/*
				 * REFUSE TO ERASE WORK THIS TOOL DID NOT DO.
				 *
				 * The records make every undo itself undoable — except where the
				 * bytes being overwritten were written by something else, which
				 * recorded nothing. That is the last way this tool can destroy
				 * something unrecoverable, and `redo_edit` already guarded it.
				 *
				 * Deliberately a NOTICE, not a wall: it stays silent whenever the
				 * file is exactly as we left it, which is nearly always. A check
				 * that fires on harmless things is one you learn to force without
				 * reading, and then it protects nothing.
				 */
				const force = (params as any).force === true;
				const outsideEdits = (changes: FileChange[]) =>
					changes
						.filter((c) => !matchesRecordedState(c))
						.map((c) => path.basename(c.uri.replace(/^file:\/\//, "")));
				const refuseDrift = (names: string[]) =>
					({
						content: [
							{
								type: "text" as const,
								text:
									`cannot undo: ${names.join(", ")} ${names.length === 1 ? "has" : "have"} been changed ` +
									`by something other than this tool since that edit — a shell command, a formatter, ` +
									`or another editor. Those changes were never recorded, so undoing would erase them ` +
									`for good. Pass force: true to undo anyway.`,
							},
						],
						isError: true,
					}) as any;
				/*
				 * forcing past the guard is allowed, but never silent: the diff
				 * describes only the tool's own change, so without this the one
				 * unrecoverable thing an undo can do leaves no trace in its own
				 * output. Raised by a sub-agent testing the guard live.
				 */
				const discardNote = (names: string[]) =>
					names.length > 0
						? `\n\n(forced — discarded changes made outside this tool in ${names.join(", ")}; ` +
							`those bytes were not recorded anywhere and are gone)`
						: "";

				// records are grouped by tool call id, so a codemode script's edits undo as one change.
				if ((params as any).scope !== "file") {
					const siblings = loadChanges(sessionId, latest.toolCallId).filter((c) => !c.reverted);
					const net = netPerFile(siblings);
					const outside = outsideEdits([...net.values()].map((n) => n.last));
					if (!force && outside.length > 0) return refuseDrift(outside);
					const undone = new Set<string>();
					for (const change of byWriteOrder(siblings).reverse()) {
						if (revertChange(sessionId, latest.toolCallId, change.id)) {
							undone.add(change.uri.replace(/^file:\/\//, ""));
						}
					}
					if (undone.size > 0) {
						const target = net.get(latest.change.uri)!;
						const diff = simpleDiff(path.basename(resolved), target.last.after, target.first.before);
						const others = [...undone].filter((p) => p !== resolved);
						const note =
							others.length > 0
								? `\n\n(this was one change across ${undone.size} files — also restored: ${others
										.map((p) => path.basename(p))
										.join(", ")})`
								: "";
						return {
							content: [{ type: "text" as const, text: diff + note + discardNote(outside) }],
							details: { header: resolved },
						} as any;
					}
				}

				// resolved BEFORE reverting: a move undoes as one operation, so
				// both halves have to pass the drift check or neither is touched.
				const pairing = findMovePartner(sessionId, latest.toolCallId, latest.change);
				const outsideOne = outsideEdits(
					pairing.partner ? [latest.change, pairing.partner] : [latest.change],
				);
				if (!force && outsideOne.length > 0) return refuseDrift(outsideOne);

				const reverted = revertChange(sessionId, latest.toolCallId, latest.change.id);
				if (!reverted) {
					return {
						content: [
							{
								type: "text" as const,
								text: `failed to revert — change may have already been undone.`,
							},
						],
						isError: true,
					} as any;
				}

				// show reverse diff (after → before)
				const diff = simpleDiff(
					path.basename(resolved),
					reverted.after,
					reverted.before,
				);

				let result = diff;
				// beforeExists is authoritative when present; older records only have isNewFile.
				const existedBefore = reverted.beforeExists ?? !reverted.isNewFile;
				if (!existedBefore) {
					result += `\n\n(file was created by the reverted edit — moved to the Trash)`;
				} else if (reverted.afterExists === false) {
					result += `\n\n(file was deleted by the reverted edit — file restored)`;
				}

				/*
				 * UNDO A MOVE AS ONE OPERATION, NOT TWO HALVES.
				 *
				 * a move is recorded as a deletion at the source plus a creation
				 * at the destination. undoing one half alone is destructive both
				 * ways: revert the destination and the file is gone from both
				 * places; revert the source and it exists twice. so reverting
				 * either half reverts its partner, which is what "undo the move"
				 * has always meant to whoever typed it.
				 */
				if (pairing.partner) {
					const partnerPath = pairing.partner.uri.replace(/^file:\/\//, "");
					const undonePartner = revertChange(sessionId, latest.toolCallId, pairing.partner.id);
					result += undonePartner
						? `\n(this was a move — its other half was reverted too: ${path.basename(partnerPath)})`
						: `\n(WARNING: this was a move, but its other half at ${partnerPath} could not be reverted — check both paths)`;
				} else if (pairing.ambiguous.length > 0) {
					// only reachable for records written before movePartnerUri
					// existed. saying nothing here is what made this look like data
					// loss: the file is recoverable, but only if you know to look.
					result +=
						`\n(WARNING: this looks like half of a move, but ${pairing.ambiguous.length} files in that change ` +
						`hold identical content so the other half cannot be identified. ` +
						`If a file seems missing, undo one of these too: ${pairing.ambiguous.join(", ")})`;
				}

				return {
					content: [{ type: "text" as const, text: result + discardNote(outsideOne) }],
					details: { header: resolved },
				} as any;
			});
		},
	};
}

/**
 * the undone change sitting DIRECTLY on top of the file's current state.
 *
 * REDO POPS THE BOTTOM OF THE UNDONE RUN, NOT THE TIP.
 *
 * undo removes from the top of the applied stack, and it now refuses to reach
 * past a newer change — so the undone changes for a path are always a
 * contiguous run at the top. The one to put back first is therefore the
 * OLDEST of that run: the step the file would take next.
 *
 * Scanning newest-first instead (which this did at first) jumps straight to
 * the tip and silently skips every middle step: with L1→L2→L3 undone twice
 * down to L1, one redo produced L3 and reported the diff as L2→L3 while the
 * file said L1. Reported by grok-4.5.
 *
 * the mirror of `findLatestChange`, which filters reverted records OUT.
 */
function findRedoCandidate(
	sessionId: string,
	filePath: string,
	activeToolCallIds: string[],
): { toolCallId: string; change: FileChange } | null {
	const uri = `file://${path.resolve(filePath)}`;
	for (const toolCallId of activeToolCallIds) {
		const match = byWriteOrder(loadChanges(sessionId, toolCallId)).find((c) => c.reverted && c.uri === uri);
		if (match) return { toolCallId, change: match };
	}
	return null;
}

export function createRedoEditTool(): ToolDefinition {
	return {
		name: "redo_edit",
		label: "Redo Edit",
		description:
			"Re-apply a change that undo_edit reverted.\n\n" +
			"Redoes the whole change, matching undo_edit's default scope: if the undo restored " +
			"several files, the redo re-applies all of them. Repeated calls walk back up one " +
			"step at a time, in the order the undos happened.\n\n" +
			"Refused if the file has been changed since it was undone — the recorded content is " +
			"stale by then, and writing it would silently discard the newer work.",

		parameters: Type.Object({
			path: Type.String({
				description: "Path of the file whose undone change should be re-applied: absolute, relative, or ~/...",
			}),
			force: Type.Optional(
				Type.Boolean({
					description:
						"Re-apply even if the file has been modified by something other than this tool since the undo. Those modifications are not recorded anywhere and will be lost.",
				}),
			),
		}),

		renderCall(args: any, theme: any, context: any) {
			const Text = getText();
			const text = context?.lastComponent ?? new Text("", 0, 0);
			const filePath = args.path || "...";
			const home = os.homedir();
			const shortened = filePath.startsWith(home) ? `~${filePath.slice(home.length)}` : filePath;
			const linked = filePath.startsWith("/") ? osc8Link(`file://${filePath}`, shortened) : shortened;
			text.setText(theme.fg("toolTitle", theme.bold("Redo ")) + theme.fg("dim", linked));
			return text;
		},

		renderResult: renderBoxedText,

		async execute(_toolCallId, params: any, _signal, _onUpdate, ctx) {
			const resolved = resolveWithVariants(params.path, ctx.cwd);

			return withFileLock(resolved, async () => {
				const sessionId = ctx.sessionManager.getSessionId();
				const activeIds = getActiveToolCallIds(ctx.sessionManager);
				const fail = (text: string) =>
					({ content: [{ type: "text" as const, text }], isError: true }) as any;

				if (activeIds.length === 0) {
					return fail("nothing to redo (no tool calls in current branch).");
				}

				const candidate = findRedoCandidate(sessionId, resolved, activeIds);
				if (!candidate) {
					return fail(`nothing to redo for ${path.basename(resolved)}.`);
				}

				/*
				 * THE ONLY RULE THAT MAKES REDO SAFE.
				 *
				 * Redo writes bytes recorded BEFORE the undo. If anything has
				 * edited this path since, those bytes describe a state that no
				 * longer follows from the current file, and re-applying them
				 * silently discards the newer work. This is the classic
				 * redo-invalidation trap, and getting it wrong is worse than
				 * having no redo at all — which is why there wasn't one until the
				 * check existed.
				 */
				// branch order, not `timestamp`, for the same reason undo uses it:
				// two calls in one millisecond share a timestamp and would read
				// as concurrent.
				const uri = `file://${path.resolve(resolved)}`;
				const candidateIndex = activeIds.lastIndexOf(candidate.toolCallId);
				for (let i = candidateIndex + 1; i < activeIds.length; i++) {
					for (const change of loadChanges(sessionId, activeIds[i]!)) {
						if (change.uri !== uri || change.reverted) continue;
						return fail(
							`cannot redo ${path.basename(resolved)}: it has been changed since that undo, ` +
								`so re-applying would discard the newer edit. Make the change again instead.`,
						);
					}
				}

				const siblings = byWriteOrder(loadChanges(sessionId, candidate.toolCallId).filter((c) => c.reverted));
				const net = netPerFile(siblings);

				/*
				 * THE SAME QUESTION UNDO ASKS, POINTED THE OTHER WAY.
				 *
				 * The records check above only sees writes this tool made. A
				 * shell command, a formatter or another editor records nothing,
				 * so redo would happily write its remembered copy over work that
				 * exists in the file and nowhere else. Undo was given this guard
				 * first and redo was not, on my mistaken claim that redo already
				 * had it — it had a different one. Reported by grok-4.5.
				 *
				 * redo starts from what the UNDO restored, so `before` is the
				 * copy the file should be holding.
				 */
				const force = (params as any).force === true;
				const outside = [...net.values()]
					.map((n) => n.first)
					.filter((c) => !matchesRecordedState(c, "before"))
					.map((c) => path.basename(c.uri.replace(/^file:\/\//, "")));
				if (!force && outside.length > 0) {
					return fail(
						`cannot redo: ${outside.join(", ")} ${outside.length === 1 ? "has" : "have"} been changed ` +
							`by something other than this tool since that undo — a shell command, a formatter, ` +
							`or another editor. Those changes were never recorded, so redoing would erase them ` +
							`for good. Pass force: true to redo anyway.`,
					);
				}

				const redone = new Set<string>();
				for (const change of siblings) {
					if (reapplyChange(sessionId, candidate.toolCallId, change.id)) {
						redone.add(change.uri.replace(/^file:\/\//, ""));
					}
				}
				if (redone.size === 0) return fail(`nothing to redo for ${path.basename(resolved)}.`);

				const target = net.get(candidate.change.uri)!;
				const diff = simpleDiff(path.basename(resolved), target.first.before, target.last.after);
				const others = [...redone].filter((p) => p !== resolved);
				const note =
					others.length > 0
						? `\n\n(re-applied ${redone.size} files — also: ${others
								.map((p) => path.basename(p))
								.join(", ")})`
						: "";
				// forcing is allowed but never silent, exactly as in undo: the
				// diff describes only the tool's own change.
				const discarded =
					outside.length > 0
						? `\n\n(forced — discarded changes made outside this tool in ${outside.join(", ")}; ` +
							`those bytes were not recorded anywhere and are gone)`
						: "";
				return {
					content: [{ type: "text" as const, text: diff + note + discarded }],
					details: { header: resolved },
				} as any;
			});
		},
	};
}
