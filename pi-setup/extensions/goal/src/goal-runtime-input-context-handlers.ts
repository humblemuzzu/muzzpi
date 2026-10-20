import type {
  AgentBeforeSettleEvent,
  BeforeAgentStartEvent,
  BoundaryResult,
  ContextEvent,
  ExtensionHandler,
  InputEvent,
  InputEventResult,
  TurnEndEvent,
} from "@earendil-works/pi-coding-agent";

import { continuationGoalIdFromPrompt } from "./prompts.ts";
import { rewriteStaleQueuedGoalWork, staleQueuedGoalWorkEdits } from "./queued-goal-work.ts";
import {
  isActiveGoalQueuedDetails,
  isCommandResumeQueuedGoalMessage,
} from "./queued-goal-messages.ts";
import { applyStaleQueuedWorkEffects } from "./goal-runtime-event-utils.ts";
import type {
  ContextEventResult,
  GoalRuntimeInputContextHandlerContext,
  MessageStartEvent,
  QueuedGoalWorkMessageIdResolver,
} from "./goal-runtime-event-handler-types.ts";

export function createInputContextEventHandlers(
  deps: GoalRuntimeInputContextHandlerContext,
  queuedGoalWorkMessageIdForRuntime: QueuedGoalWorkMessageIdResolver,
) {
  const { runtimeState, stateController, continuation, recoveryRuntime, status, resetErrorRecovery } = deps;

  return {
    onInput: (async (event, ctx) => {
      continuation.clearPassthroughContinuationInput();
      const continuationGoalId = continuationGoalIdFromPrompt(event.text);

      if (event.source !== "extension") {
        deps.providerLimitAutoResume.clear();
        recoveryRuntime.onUserInput();
        applyStaleQueuedWorkEffects(
          runtimeState.staleQueuedWorkGuard.planUserInputClearAbort().effects,
          ctx,
          deps,
        );
        if (continuationGoalId !== null) {
          continuation.notePassthroughContinuationInput(event.text);
        }
        status.refreshUi(ctx);
        return undefined;
      }

      if (continuationGoalId === null) {
        return undefined;
      }

      applyStaleQueuedWorkEffects(
        runtimeState.staleQueuedWorkGuard.planExtensionContinuationClearAbort().effects,
        ctx,
        deps,
      );
      if (stateController.isCurrentActiveGoalId(continuationGoalId)) {
        continuation.markContinuationQueued(continuationGoalId);
        return { action: "continue" } as const;
      }

      continuation.clearContinuationStateFor(continuationGoalId);
      status.refreshUi(ctx);
      return { action: "handled" } as const;
    }) satisfies ExtensionHandler<InputEvent, InputEventResult>,

    onContext: (async (event, ctx) => {
      const contextAbortPlan = runtimeState.staleQueuedWorkGuard.planContextAbort(
        runtimeState.currentTurnIndex,
      );
      if (contextAbortPlan !== null) {
        applyStaleQueuedWorkEffects(contextAbortPlan.effects, ctx, deps);
        return undefined;
      }

      // In place, not a returned list: a returned list makes pi rebuild the system messages.
      rewriteStaleQueuedGoalWork(
        event.messages,
        runtimeState.staleQueuedGoalIds,
        queuedGoalWorkMessageIdForRuntime,
      );
      return undefined;
    }) satisfies ExtensionHandler<ContextEvent, ContextEventResult | undefined>,

    onBoundary: ((event) => {
      const edits = staleQueuedGoalWorkEdits(
        event.context.contextEntries,
        runtimeState.staleQueuedGoalIds,
        queuedGoalWorkMessageIdForRuntime,
      );
      runtimeState.staleQueuedGoalIds.clear();
      return edits.length > 0 ? { entries: [...event.entries, ...edits] } : undefined;
    }) satisfies ExtensionHandler<TurnEndEvent | AgentBeforeSettleEvent, BoundaryResult | undefined>,

    onBeforeAgentStart: (async (event, ctx) => {
      if (!("prompt" in event)) return undefined;
      const continuationGoalId = continuation.continuationGoalIdFromRuntimePrompt(event.prompt);
      if (continuationGoalId !== null) {
        continuation.clearContinuationStateFor(continuationGoalId);
        if (!stateController.isCurrentActiveGoalId(continuationGoalId)) {
          status.refreshUi(ctx);
          return undefined;
        }
        applyStaleQueuedWorkEffects(
          runtimeState.staleQueuedWorkGuard.planBeforeAgentStartClearAbort().effects,
          ctx,
          deps,
        );
      } else {
        applyStaleQueuedWorkEffects(
          runtimeState.staleQueuedWorkGuard.planBeforeAgentStartClearAbort().effects,
          ctx,
          deps,
        );
        continuation.clearContinuationState();
      }
      return undefined;
    }) satisfies ExtensionHandler<BeforeAgentStartEvent, undefined>,

    onMessageStart: (async (event, _ctx) => {
      if (event.message.role === "user") {
        stateController.persistHostOverflowUserReset(false);
      }

      const queuedGoalId = queuedGoalWorkMessageIdForRuntime(event.message);
      if (queuedGoalId === null) {
        if (event.message.role === "user" || event.message.role === "custom") {
          runtimeState.staleQueuedWorkGuard.noteRunnableWorkStarted();
          continuation.clearContinuationState();
        }
        return;
      }

      continuation.clearContinuationStateFor(queuedGoalId);
      if (stateController.isCurrentActiveGoalId(queuedGoalId)) {
        runtimeState.staleQueuedWorkGuard.noteRunnableWorkStarted();
        const details =
          "details" in event.message ? (event.message as { details?: unknown }).details : undefined;
        if (isActiveGoalQueuedDetails(details) && details.kind === "continuation") {
          runtimeState.agentRunFromContinuation = true;
        }
        if (isCommandResumeQueuedGoalMessage(event.message)) {
          resetErrorRecovery();
        }
        return;
      }

      runtimeState.staleQueuedWorkGuard.noteStaleWorkStarted(queuedGoalId);
      runtimeState.staleQueuedGoalIds.add(queuedGoalId);
    }) satisfies ExtensionHandler<MessageStartEvent>,
  };
}
