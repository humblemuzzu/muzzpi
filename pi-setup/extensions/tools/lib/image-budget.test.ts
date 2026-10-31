import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import {
  limitsForModel,
  measureSession,
  planCallBudget,
  planToolImages,
  recordReturnedImages,
  sessionNote,
} from "./image-budget";
import { MAX_IMAGES_PER_CALL } from "./vision";

// read by path: pi's package exports do not expose this file to require().
const catalog = JSON.parse(
  fs.readFileSync(
    join(import.meta.dir, "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/providers/data/anthropic.json"),
    "utf8",
  ),
)["anthropic-messages"];
const model = (id: string) => catalog[`chat:${id}`];

const setupDir = join(import.meta.dir, "../../..");
const anthropicOverrides = JSON.parse(fs.readFileSync(join(setupDir, "models.json"), "utf8")).providers.anthropic
  .modelOverrides as Record<string, { inputLimits?: { maxRequestBytes?: number } }>;

/** pi's merge: an override's top-level inputLimits fields replace the catalog's (provider-composer.js). */
const withOverride = (id: string) => ({
  ...model(id),
  inputLimits: { ...model(id).inputLimits, ...anthropicOverrides[id]!.inputLimits },
});

const MiB = 1024 * 1024;

function ctxWith(messages: any[], extra: Record<string, unknown> = {}, sessionId = "budget-test") {
  return {
    sessionManager: { buildSessionProjection: () => ({ messages }), getSessionId: () => sessionId },
    ...extra,
  };
}
const imageBlock = (bytes: number) => ({ type: "image", data: "A".repeat(bytes), mimeType: "image/png" });

describe("limitsForModel", () => {
  test("the 5.5 models: pi's resize profile, a 32 MiB request, 600 images", () => {
    for (const id of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]) {
      expect(limitsForModel(model(id))).toEqual({
        maxSide: 2000,
        maxImageBase64: 4.5 * MiB - 1,
        maxRequestBytes: 32 * MiB,
        maxImagesPerRequest: 600,
      });
    }
  });

  test("a 200k-context model keeps its 100-image limit", () => {
    expect(limitsForModel(model("claude-haiku-4-5")).maxImagesPerRequest).toBe(100);
  });

  test("a model without declared limits gets pi's defaults", () => {
    expect(limitsForModel(undefined)).toEqual({
      maxSide: 2000,
      maxImageBase64: 4.5 * MiB - 1,
      maxRequestBytes: 32 * MiB,
      maxImagesPerRequest: 100,
    });
    expect(limitsForModel({ id: "deepseek-flash" }).maxSide).toBe(2000);
  });
});

describe("measureSession", () => {
  test("counts every image block and the serialized size of the context", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "hi" }, imageBlock(1000)] },
      { role: "toolResult", toolCallId: "a", content: [imageBlock(2000), imageBlock(3000)] },
    ];
    const usage = measureSession(ctxWith(messages))!;
    expect(usage.images).toBe(3);
    expect(usage.requestBytes).toBeGreaterThan(6000);
    expect(usage.requestBytes).toBe(Buffer.byteLength(JSON.stringify(messages)));
  });

  test("includes the system prompt when the context exposes it", () => {
    const usage = measureSession(ctxWith([], { getSystemPrompt: () => "x".repeat(5000) }))!;
    expect(usage.requestBytes).toBe(2 + 5000);
  });

  test("images returned by a call not yet in history are counted until its result lands", () => {
    recordReturnedImages(ctxWith([]), "pending-1", 4 * MiB, 3);
    expect(measureSession(ctxWith([]))!.images).toBe(3);
    expect(measureSession(ctxWith([]))!.requestBytes).toBeGreaterThanOrEqual(4 * MiB);

    const landed = [{ role: "toolResult", toolCallId: "pending-1", content: [] }];
    expect(measureSession(ctxWith(landed))!.images).toBe(0);
    expect(measureSession(ctxWith([]))!.images).toBe(0);
  });

  test("pending images belong to their own session", () => {
    recordReturnedImages(ctxWith([], {}, "session-a"), "call-a", MiB, 2);
    expect(measureSession(ctxWith([], {}, "session-b"))!.images).toBe(0);
    expect(measureSession(ctxWith([], {}, "session-a"))!.images).toBe(2);
  });

  test("undefined when the session cannot be read", () => {
    expect(measureSession(undefined)).toBeUndefined();
    expect(measureSession({ sessionManager: {} })).toBeUndefined();
    expect(measureSession({ sessionManager: { buildSessionProjection: () => { throw new Error("x"); } } })).toBeUndefined();
  });
});

describe("planCallBudget", () => {
  const limits = limitsForModel(model("claude-opus-5-5"));

  test("an empty session gets the 8 MiB per-call share and the per-call image cap", () => {
    const decision = planCallBudget(limits, { images: 0, requestBytes: 50_000 });
    expect(decision).toEqual({ ok: true, budget: { bytes: 8 * MiB, images: MAX_IMAGES_PER_CALL } });
  });

  test("a fuller session gets only what is left", () => {
    const decision = planCallBudget(limits, { images: 10, requestBytes: 27 * MiB });
    if (!decision.ok) throw new Error("expected a budget");
    expect(decision.budget.bytes).toBe(32 * MiB - 2 * MiB - 27 * MiB);
  });

  test("refuses before the request limit, and says what to do", () => {
    const decision = planCallBudget(limits, { images: 30, requestBytes: 29.8 * MiB });
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error("unreachable");
    expect(decision.reason).toContain("413");
    expect(decision.reason).toContain("/compact");
  });

  test("refuses at the image-count limit", () => {
    const decision = planCallBudget(limits, { images: 600, requestBytes: 1 * MiB });
    expect(decision.ok).toBe(false);
  });

  test("never lets the session reach the 33,554,432-byte request limit", () => {
    for (let used = 0; used < 32 * MiB; used += 256 * 1024) {
      const decision = planCallBudget(limits, { images: 1, requestBytes: used });
      if (decision.ok) expect(used + decision.budget.bytes).toBeLessThan(32 * MiB);
    }
  });

  test("with no session to measure, falls back to the per-call share", () => {
    expect(planCallBudget(limits, undefined)).toEqual({
      ok: true,
      budget: { bytes: 8 * MiB, images: MAX_IMAGES_PER_CALL },
    });
  });
});

describe("the 128 MB first-party request limit (models.json override)", () => {
  const enabledClaude = (JSON.parse(fs.readFileSync(join(setupDir, "settings.json"), "utf8")).enabledModels as string[])
    .filter((id) => id.startsWith("anthropic/"))
    .map((id) => id.slice("anthropic/".length));
  const limits = limitsForModel(withOverride("claude-opus-5-5"));

  test("every enabled Claude model is raised to 128,000,000 bytes and keeps the rest of its catalog limits", () => {
    expect(enabledClaude.length).toBeGreaterThan(0);
    for (const id of enabledClaude) {
      expect(limitsForModel(withOverride(id))).toEqual({
        maxSide: 2000,
        maxImageBase64: 4.5 * MiB - 1,
        maxRequestBytes: 128_000_000,
        maxImagesPerRequest: 600,
      });
    }
  });

  test("one call still gets 8 MiB, not a quarter of 128 MB", () => {
    expect(planCallBudget(limits, { images: 0, requestBytes: 50_000 })).toEqual({
      ok: true,
      budget: { bytes: 8 * MiB, images: MAX_IMAGES_PER_CALL },
    });
  });

  test("a session far past the old 32 MiB limit still gets its full share", () => {
    expect(planCallBudget(limits, { images: 60, requestBytes: 90 * MiB })).toEqual({
      ok: true,
      budget: { bytes: 8 * MiB, images: MAX_IMAGES_PER_CALL },
    });
  });

  test("refuses only near 128 MB, and never lets a session reach it", () => {
    expect(planCallBudget(limits, { images: 80, requestBytes: 120 * MiB }).ok).toBe(false);
    for (let used = 0; used < 128_000_000; used += 512 * 1024) {
      const decision = planCallBudget(limits, { images: 1, requestBytes: used });
      if (decision.ok) expect(used + decision.budget.bytes).toBeLessThan(128_000_000);
    }
  });

  test("no session-size note until three quarters of 128 MB, then it says how much is left", () => {
    expect(sessionNote(limits, { images: 40, requestBytes: 64 * MiB }, 2 * MiB)).toBeUndefined();
    expect(sessionNote(limits, { images: 60, requestBytes: 90_000_000 }, 2 * MiB)).toBeUndefined();
    const note = sessionNote(limits, { images: 65, requestBytes: 96_000_000 }, 2_000_000);
    expect(note).toContain("~98.0 MB of the 128.0 MB limit");
    expect(note).toContain(`~${((128_000_000 - 2 * MiB - 98_000_000) / 1_000_000).toFixed(1)} MB left`);
  });
});

describe("sessionNote", () => {
  const limits = limitsForModel(model("claude-opus-5-5"));
  test("silent below three quarters of the request limit, a line above it", () => {
    expect(sessionNote(limits, { images: 1, requestBytes: 20 * MiB }, MiB)).toBeUndefined();
    expect(sessionNote(limits, { images: 1, requestBytes: 23 * MiB }, 2 * MiB)).toContain("/compact");
  });
});

describe("planToolImages", () => {
  test("takes the tier from the session's model unless one is requested", () => {
    const opus = planToolImages(ctxWith([], { model: model("claude-opus-5-5") }));
    const haiku45 = planToolImages(ctxWith([], { model: model("claude-haiku-4-5") }));
    const forced = planToolImages(ctxWith([], { model: model("claude-opus-5-5") }), "standard");
    if (!opus.ok || !haiku45.ok || !forced.ok) throw new Error("expected budgets");
    expect(opus.tier).toBe("high");
    expect(haiku45.tier).toBe("standard");
    expect(forced.tier).toBe("standard");
  });

  test("passes a refusal through", () => {
    const full = ctxWith([{ role: "user", content: [imageBlock(31 * MiB)] }], { model: model("claude-opus-5-5") });
    expect(planToolImages(full).ok).toBe(false);
  });
});
