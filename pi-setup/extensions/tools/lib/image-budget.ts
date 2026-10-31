/**
 * How many image bytes a tool call may add without breaking the session.
 *
 * pi re-encodes any tool image over its resize profile, and nothing in pi
 * enforces the provider's request-size limit. Every image is resent on every
 * later turn, so one request over that limit (413 request_too_large) makes
 * every turn after it fail too.
 */

import { MAX_IMAGES_PER_CALL, PI_DEFAULT_MAX_SIDE, type TierName, tierForModel } from "./vision";

export interface ImageLimits {
  /** pi re-encodes a tool image with a side over this. */
  maxSide: number;
  /** Largest base64 payload pi passes through untouched. */
  maxImageBase64: number;
  maxRequestBytes: number;
  maxImagesPerRequest: number;
}

/** pi's resize profile when a model declares none (utils/image-resize-core.js). */
const PI_DEFAULT_RESIZE = { maxWidth: PI_DEFAULT_MAX_SIDE, maxHeight: PI_DEFAULT_MAX_SIDE, maxBytes: 4.5 * 1024 * 1024 };
const DEFAULT_MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_IMAGES_PER_REQUEST = 100;

/** System prompt, tool schemas and the turns that follow this one. */
const RESERVED_BYTES = 2 * 1024 * 1024;
const MIN_USEFUL_CALL_BYTES = 512 * 1024;
/** One call's share stays this size however large the request limit is: every model call re-uploads it. */
const MAX_CALL_BYTES = 8 * 1024 * 1024;
const PENDING_TTL_MS = 10 * 60 * 1000;

interface ModelLike {
  id?: string;
  inputLimits?: {
    maxRequestBytes?: number;
    images?: {
      maxPerRequest?: number;
      resize?: { maxWidth?: number; maxHeight?: number; maxBytes?: number };
    };
  };
}

export function limitsForModel(model?: ModelLike): ImageLimits {
  const images = model?.inputLimits?.images;
  const resize = images?.resize;
  return {
    maxSide: Math.min(
      resize?.maxWidth ?? PI_DEFAULT_RESIZE.maxWidth,
      resize?.maxHeight ?? PI_DEFAULT_RESIZE.maxHeight,
    ),
    // pi passes an image through only when its base64 size is strictly below maxBytes.
    maxImageBase64: (resize?.maxBytes ?? PI_DEFAULT_RESIZE.maxBytes) - 1,
    maxRequestBytes: model?.inputLimits?.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES,
    maxImagesPerRequest: images?.maxPerRequest ?? DEFAULT_MAX_IMAGES_PER_REQUEST,
  };
}

export interface SessionImageUsage {
  images: number;
  requestBytes: number;
}

export interface CallBudget {
  /** Base64 bytes this call may return across all its images. */
  bytes: number;
  images: number;
}

export function defaultCallBudget(limits: ImageLimits): CallBudget {
  return {
    bytes: Math.min(Math.floor(limits.maxRequestBytes / 4), MAX_CALL_BYTES),
    images: MAX_IMAGES_PER_CALL,
  };
}

/**
 * Images returned by calls whose results are not in the session yet, keyed by
 * session and tool call id. Parallel calls in one assistant turn all measure
 * the same history; without this, each would spend the whole remaining budget.
 */
const pending = new Map<string, Map<string, { bytes: number; images: number; at: number }>>();

function sessionKey(ctx: any): string {
  try {
    return String(ctx?.sessionManager?.getSessionId?.() ?? "");
  } catch {
    return "";
  }
}

export function recordReturnedImages(ctx: any, toolCallId: string, bytes: number, images: number): void {
  if (images <= 0) return;
  const key = sessionKey(ctx);
  const calls = pending.get(key) ?? new Map();
  calls.set(toolCallId, { bytes, images, at: Date.now() });
  pending.set(key, calls);
}

/** A persisted message never changes, so its JSON size is measured once. */
const messageBytes = new WeakMap<object, number>();

function jsonBytes(message: unknown): number {
  if (!message || typeof message !== "object") return Buffer.byteLength(JSON.stringify(message) ?? "null");
  let bytes = messageBytes.get(message);
  if (bytes === undefined) {
    bytes = Buffer.byteLength(JSON.stringify(message));
    messageBytes.set(message, bytes);
  }
  return bytes;
}

/** What the next request will carry. Undefined when the session cannot be read. */
export function measureSession(ctx: any): SessionImageUsage | undefined {
  let messages: any[];
  try {
    messages = ctx?.sessionManager?.buildSessionProjection?.()?.messages;
  } catch {
    return undefined;
  }
  if (!Array.isArray(messages)) return undefined;

  let images = 0;
  const answered = new Set<string>();
  for (const message of messages) {
    if (message?.role === "toolResult" && typeof message.toolCallId === "string") {
      answered.add(message.toolCallId);
    }
    if (!Array.isArray(message?.content)) continue;
    for (const block of message.content) if (block?.type === "image") images += 1;
  }

  // the bytes of JSON.stringify(messages): the elements plus brackets and commas
  let requestBytes = messages.reduce((sum: number, message: unknown) => sum + jsonBytes(message), 2 + Math.max(0, messages.length - 1));
  try {
    requestBytes += Buffer.byteLength(String(ctx.getSystemPrompt?.() ?? ""));
  } catch {
    // no system prompt available; the reserve covers it
  }

  const now = Date.now();
  const calls = pending.get(sessionKey(ctx));
  for (const [id, entry] of calls ?? []) {
    if (answered.has(id) || now - entry.at > PENDING_TTL_MS) {
      calls!.delete(id);
      continue;
    }
    images += entry.images;
    requestBytes += entry.bytes;
  }
  return { images, requestBytes };
}

export type BudgetDecision =
  | { ok: true; budget: CallBudget }
  | { ok: false; reason: string };

/** Decimal megabytes, the unit providers publish their request limits in. */
const mb = (bytes: number): string => (bytes / 1_000_000).toFixed(1);

export function planCallBudget(limits: ImageLimits, usage: SessionImageUsage | undefined): BudgetDecision {
  const perCall = defaultCallBudget(limits);
  if (!usage) return { ok: true, budget: perCall };

  const freeBytes = limits.maxRequestBytes - RESERVED_BYTES - usage.requestBytes;
  const freeImages = limits.maxImagesPerRequest - usage.images;
  if (freeBytes < MIN_USEFUL_CALL_BYTES || freeImages < 1) {
    const which =
      freeImages < 1
        ? `${usage.images} images, the most one request may carry`
        : `${mb(usage.requestBytes)} MB per request, against a ${mb(limits.maxRequestBytes)} MB limit`;
    return {
      ok: false,
      reason:
        `No image returned: this session already sends ${which}. One more image would ` +
        `make the next request fail (413), and every request after it, because old ` +
        `images are resent each turn. Ask the user to run /compact, which drops old ` +
        `images from the context, then retry.`,
    };
  }
  return {
    ok: true,
    budget: {
      bytes: Math.min(perCall.bytes, freeBytes),
      images: Math.min(perCall.images, freeImages),
    },
  };
}

/** A line for the tool result once the session has used three quarters of its request limit. */
export function sessionNote(
  limits: ImageLimits,
  usage: SessionImageUsage | undefined,
  addedBytes: number,
): string | undefined {
  if (!usage) return undefined;
  const after = usage.requestBytes + addedBytes;
  if (after < limits.maxRequestBytes * 0.75) return undefined;
  const left = Math.max(0, limits.maxRequestBytes - RESERVED_BYTES - after);
  return (
    `session size: requests now carry ~${mb(after)} MB of the ${mb(limits.maxRequestBytes)} MB ` +
    `limit (~${mb(left)} MB left for images). /compact drops old images; image tools refuse ` +
    `before the limit.`
  );
}

export interface ToolImagePlan {
  limits: ImageLimits;
  usage: SessionImageUsage | undefined;
  budget: CallBudget;
  tier: TierName;
}

/** Everything an image-returning tool needs from its context, or why it must not return one. */
export function planToolImages(
  ctx: any,
  requestedTier?: TierName,
): ({ ok: true } & ToolImagePlan) | { ok: false; reason: string } {
  const limits = limitsForModel(ctx?.model);
  const usage = measureSession(ctx);
  const decision = planCallBudget(limits, usage);
  if (!decision.ok) return decision;
  return {
    ok: true,
    limits,
    usage,
    budget: decision.budget,
    tier: requestedTier ?? tierForModel(ctx?.model?.id),
  };
}
