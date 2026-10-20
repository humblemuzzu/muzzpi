import { CUSTOM_ENTRY_TYPE } from "./types.ts";

type GoalQueuedWorkKind = "continuation" | "command_start" | "command_resume";

export interface ActiveGoalQueuedDetails {
  kind: GoalQueuedWorkKind;
  goalId: string;
}

export interface QueuedGoalTextPart {
  readonly type: "text";
  readonly text: string;
}

/** External provider-context message shape before normalization. */
export interface QueuedGoalContextInput {
  role: string;
  customType?: string;
  content?: unknown;
  display?: boolean;
  details?: unknown;
  timestamp?: number;
}

export function userContentFromUnknown(content: unknown): QueuedGoalTextPart[] {
  if (!Array.isArray(content)) {
    return [];
  }

  const parts: QueuedGoalTextPart[] = [];
  for (const part of content) {
    if (part === null || typeof part !== "object") {
      continue;
    }
    const candidate = part as { type?: unknown; text?: unknown };
    if (candidate.type === "text" && typeof candidate.text === "string") {
      parts.push({ type: "text", text: candidate.text });
    }
  }
  return parts;
}

export function isActiveGoalQueuedDetails(details: unknown): details is ActiveGoalQueuedDetails {
  if (details === null || typeof details !== "object") {
    return false;
  }

  const candidate = details as { kind?: unknown; goalId?: unknown };
  const kind = candidate.kind;
  return (
    (kind === "continuation" || kind === "command_start" || kind === "command_resume") &&
    typeof candidate.goalId === "string"
  );
}

export function isCommandResumeQueuedGoalMessage(message: QueuedGoalContextInput): boolean {
  return (
    message.role === "custom" &&
    message.customType === CUSTOM_ENTRY_TYPE &&
    isActiveGoalQueuedDetails(message.details) &&
    message.details.kind === "command_resume"
  );
}
