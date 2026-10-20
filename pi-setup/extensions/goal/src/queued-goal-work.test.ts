import { describe, expect, test } from "bun:test";

import goalExtension from "../index.ts";
import { staleGoalContinuationMessage } from "./queued-goal-work.ts";
import { CUSTOM_ENTRY_TYPE } from "./types.ts";

type Handler = (event: any, ctx: any) => any;

function loadGoal() {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const sent: any[] = [];
  const branch: any[] = [];
  let aborts = 0;
  goalExtension({
    on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    sendMessage: (message: any) => sent.push(message),
    sendUserMessage: (content: any) => sent.push({ role: "user", content }),
    appendEntry: (customType: string, data: unknown) =>
      branch.push({ type: "custom", customType, data, id: `c${branch.length}` }),
  } as any);

  const ctx = {
    hasUI: false,
    cwd: "/tmp",
    model: { provider: "anthropic", id: "claude-haiku-5-5", contextWindow: 1_000_000 },
    ui: { notify() {}, setStatus() {}, confirm: async () => false },
    sessionManager: { getBranch: () => branch },
    isIdle: () => true,
    hasPendingMessages: () => false,
    abort: () => {
      aborts += 1;
    },
  };

  const emit = async (name: string, event: Record<string, unknown> = {}) => {
    let result: any;
    for (const handler of handlers.get(name) ?? []) {
      const out = await handler({ type: name, ...event }, ctx);
      if (out !== undefined) result = out;
    }
    return result;
  };

  const boundary = (name: "turn_end" | "agent_before_settle", contextEntries: any[]) =>
    emit(name, {
      entries: [],
      continue: false,
      context: { contextEntries },
      outcome: "completed",
      turnIndex: 0,
      message: { role: "assistant", content: [], stopReason: "stop" },
      toolResults: [],
    });

  const createGoal = async () => {
    await emit("session_start", { reason: "startup" });
    await tools.get("create_goal").execute("call-1", { objective: "ship it" }, undefined, undefined, ctx);
    await emit("agent_end", { messages: [] });
    const continuation = sent.at(-1);
    expect(continuation.details).toEqual({ kind: "continuation", goalId: expect.any(String) });
    return {
      goalId: continuation.details.goalId as string,
      message: { role: "custom", ...continuation, timestamp: 1 },
    };
  };

  const deliver = async (...messages: any[]) => {
    await emit("agent_start");
    await emit("turn_start", { turnIndex: 0, timestamp: 2 });
    for (const message of messages) await emit("message_start", { message });
  };

  const goalCommand = (args: string) => commands.get("goal").handler(args, ctx);
  const completeGoal = () =>
    tools.get("update_goal").execute("call-2", { status: "complete" }, undefined, undefined, ctx);
  return { emit, boundary, createGoal, deliver, goalCommand, completeGoal, aborts: () => aborts };
}

const entry = (id: string, message: any) => ({ sourceEntry: { id, type: "custom_message" }, messages: [message] });
const userMessage = { role: "user", content: [{ type: "text", text: "unrelated question" }], timestamp: 3 };
const clone = <T>(value: T): T => structuredClone(value);

describe("goal continuations in the provider context", () => {
  test("leaves the request of an active goal's continuation untouched", async () => {
    const goal = loadGoal();
    const { message } = await goal.createGoal();
    await goal.deliver(message);
    const messages = [clone(message)];
    expect(await goal.emit("context", { messages })).toBeUndefined();
    expect(messages).toEqual([message]);
  });

  test("older continuations of the active goal stay byte-stable", async () => {
    const goal = loadGoal();
    const { message: first } = await goal.createGoal();
    await goal.deliver(first);
    const second = { ...first, timestamp: 5 };
    await goal.deliver(second);
    const messages = [clone(first), clone(second)];
    expect(await goal.emit("context", { messages })).toBeUndefined();
    expect(messages).toEqual([first, second]);
    expect(await goal.boundary("turn_end", [entry("e1", first), entry("e2", second)])).toBeUndefined();
  });

  test("a continuation that already ran stays as it was after the goal completes", async () => {
    const goal = loadGoal();
    const { message } = await goal.createGoal();
    await goal.deliver(message);
    await goal.boundary("turn_end", [entry("e1", message)]);
    await goal.completeGoal();
    await goal.deliver(userMessage);
    const messages = [clone(message), clone(userMessage)];
    expect(await goal.emit("context", { messages })).toBeUndefined();
    expect(messages).toEqual([message, userMessage]);
    expect(await goal.boundary("turn_end", [entry("e1", message), entry("e2", userMessage)])).toBeUndefined();
  });

  for (const transition of ["pause", "clear"]) {
    test(`a continuation delivered after /goal ${transition} is rewritten once and stored once`, async () => {
      const goal = loadGoal();
      const { goalId, message } = await goal.createGoal();
      await goal.goalCommand(transition);
      await goal.deliver(message, userMessage);

      const stale = staleGoalContinuationMessage(goalId);
      const request = [clone(message), clone(userMessage)];
      expect(await goal.emit("context", { messages: request })).toBeUndefined();
      expect(request).toEqual([{ ...message, content: stale }, userMessage]);
      expect(goal.aborts()).toBe(0);

      const entries = [entry("e1", message), entry("e2", userMessage)];
      expect(await goal.boundary("turn_end", entries)).toEqual({
        entries: [{ type: "context_edit", targetId: "e1", replacement: { content: stale } }],
      });
      expect(await goal.boundary("agent_before_settle", entries)).toBeUndefined();

      const edited = [{ ...message, content: stale }, userMessage];
      const next = clone(edited);
      expect(await goal.emit("context", { messages: next })).toBeUndefined();
      expect(next).toEqual(edited);
    });
  }

  test("a stale continuation the guard aborts is not rewritten in the request, only stored", async () => {
    const goal = loadGoal();
    const { goalId, message } = await goal.createGoal();
    await goal.goalCommand("pause");
    await goal.deliver(message);

    const request = [clone(message)];
    expect(await goal.emit("context", { messages: request })).toBeUndefined();
    expect(goal.aborts()).toBe(1);
    expect(request).toEqual([message]);

    expect(await goal.boundary("turn_end", [entry("e1", message)])).toEqual({
      entries: [
        { type: "context_edit", targetId: "e1", replacement: { content: staleGoalContinuationMessage(goalId) } },
      ],
    });
  });

  test("a stored edit keeps the drafts of earlier handlers", async () => {
    const goal = loadGoal();
    const { message } = await goal.createGoal();
    await goal.goalCommand("clear");
    await goal.deliver(message, userMessage);
    const result = await goal.emit("turn_end", {
      entries: [{ type: "custom", customType: "other" }],
      continue: false,
      context: { contextEntries: [entry("e1", message)] },
      outcome: "completed",
      turnIndex: 0,
      message: { role: "assistant", content: [], stopReason: "stop" },
      toolResults: [],
    });
    expect(result.entries.map((draft: any) => draft.type)).toEqual(["custom", "context_edit"]);
  });

  test("the stale rewrite names only the queued goal", () => {
    expect(staleGoalContinuationMessage("g1")).toContain("Queued goal id: g1.");
    expect(staleGoalContinuationMessage("g1")).not.toContain("current");
  });

  test("goal entries keep the type old sessions load by", () => {
    expect(CUSTOM_ENTRY_TYPE).toBe("pi-codex-goal");
  });
});
