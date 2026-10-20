import type { ContextEditEntryDraft, ProjectedSessionEntry } from "@earendil-works/pi-coding-agent";

import type { QueuedGoalWorkMessageIdResolver } from "./goal-runtime-event-handler-types.ts";
import { continuationGoalIdFromPrompt } from "./prompts.ts";
import {
  isActiveGoalQueuedDetails,
  type QueuedGoalContextInput,
  type QueuedGoalTextPart,
  userContentFromUnknown,
} from "./queued-goal-messages.ts";
import { CUSTOM_ENTRY_TYPE } from "./types.ts";

function textContentFromMessageContent(content: unknown): string | null {
  if (typeof content === "string") {
    return content;
  }

  const parts = userContentFromUnknown(content);
  if (parts.length === 0) {
    return null;
  }

  return parts.map((part) => part.text).join("\n");
}

function continuationGoalIdFromMessageContent(content: unknown): string | null {
  const text = textContentFromMessageContent(content);
  return text === null ? null : continuationGoalIdFromPrompt(text);
}

export function staleGoalContinuationMessage(queuedGoalId: string): string {
  return [
    "A queued hidden goal continuation was stale and has been cancelled before running.",
    `Queued goal id: ${queuedGoalId}.`,
    "Ignore only this stale hidden bookkeeping message; do not perform work for the queued goal id above or mention this cancellation to the user.",
  ].join("\n");
}

function extensionQueuedGoalWorkMessageId(message: QueuedGoalContextInput): string | null {
  if (message.role !== "custom" || message.customType !== CUSTOM_ENTRY_TYPE) {
    return null;
  }

  if (isActiveGoalQueuedDetails(message.details)) {
    return message.details.goalId;
  }

  return continuationGoalIdFromMessageContent(message.content);
}

function queuedGoalWorkMessageId(message: QueuedGoalContextInput): string | null {
  if (message.role === "user") {
    return continuationGoalIdFromMessageContent(message.content);
  }

  return extensionQueuedGoalWorkMessageId(message);
}

/**
 * The content that cancels the latest queued work for `goalId` among `messages`, or null when
 * there is none or it already carries that content.
 */
function staleQueuedGoalWorkRewrite(
  messages: readonly QueuedGoalContextInput[],
  goalId: string,
  resolveQueuedGoalWorkMessageId: QueuedGoalWorkMessageIdResolver,
): { index: number; content: string | QueuedGoalTextPart[] } | null {
  let index = messages.length - 1;
  while (index >= 0 && resolveQueuedGoalWorkMessageId(messages[index]) !== goalId) {
    index -= 1;
  }
  const text = staleGoalContinuationMessage(goalId);
  if (index < 0 || textContentFromMessageContent(messages[index].content) === text) {
    return null;
  }
  return { index, content: messages[index].role === "custom" ? text : [{ type: "text", text }] };
}

/** Rewrites, in place, the stale queued work a request is about to send. */
export function rewriteStaleQueuedGoalWork(
  messages: readonly QueuedGoalContextInput[],
  staleGoalIds: ReadonlySet<string>,
  resolveQueuedGoalWorkMessageId: QueuedGoalWorkMessageIdResolver,
): void {
  for (const goalId of staleGoalIds) {
    const rewrite = staleQueuedGoalWorkRewrite(messages, goalId, resolveQueuedGoalWorkMessageId);
    if (rewrite) {
      messages[rewrite.index].content = rewrite.content;
    }
  }
}

/** Context edits that store the same rewrite in the session, so later requests send identical bytes. */
export function staleQueuedGoalWorkEdits(
  entries: readonly ProjectedSessionEntry[],
  staleGoalIds: ReadonlySet<string>,
  resolveQueuedGoalWorkMessageId: QueuedGoalWorkMessageIdResolver,
): ContextEditEntryDraft[] {
  const messages = entries.flatMap((entry) => entry.messages);
  const owners = entries.flatMap((entry) => entry.messages.map(() => entry.sourceEntry.id));
  const edits: ContextEditEntryDraft[] = [];
  for (const goalId of staleGoalIds) {
    const rewrite = staleQueuedGoalWorkRewrite(messages, goalId, resolveQueuedGoalWorkMessageId);
    if (rewrite) {
      edits.push({
        type: "context_edit",
        targetId: owners[rewrite.index],
        replacement: { content: rewrite.content },
      });
    }
  }
  return edits;
}

export function extensionQueuedGoalWorkMessageIdForRuntime(
  message: QueuedGoalContextInput,
  resolveContinuationGoalIdFromPrompt: (prompt: string) => string | null,
): string | null {
  if (message.role === "user") {
    const text = textContentFromMessageContent(message.content);
    return text === null ? null : resolveContinuationGoalIdFromPrompt(text);
  }

  return queuedGoalWorkMessageId(message);
}

export function agentEndMessagesIncludeQueuedGoalWork(
  messages: readonly QueuedGoalContextInput[],
): boolean {
  return messages.some((message) => queuedGoalWorkMessageId(message) !== null);
}

export function pendingStaleQueuedGoalWorkIdsFromMessages(
  messages: readonly QueuedGoalContextInput[],
  staleQueuedGoalWorkAgentEndGoalIds: ReadonlySet<string>,
): string[] {
  const goalIds: string[] = [];
  for (const message of messages) {
    const queuedGoalId = queuedGoalWorkMessageId(message);
    if (queuedGoalId !== null && staleQueuedGoalWorkAgentEndGoalIds.has(queuedGoalId)) {
      goalIds.push(queuedGoalId);
    }
  }
  return goalIds;
}
