/**
 * Claude's image budget. `countImageTokens` and `resizedSize` match the
 * reference implementation in Anthropic's vision-coordinates guide; the
 * `maxSide` cap is this harness's addition (see MANY_IMAGE_MAX_SIDE).
 */

export interface Size {
  width: number;
  height: number;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const PATCH = 28;

export interface Tier {
  /** Longest side after padding to a multiple of PATCH. */
  readonly maxEdge: number;
  readonly maxTokens: number;
  /** Longest side before padding. The published tiers leave it unset. */
  readonly maxSide?: number;
}

export const TIERS = {
  standard: { maxEdge: 1568, maxTokens: 1568 },
  highRes: { maxEdge: 2576, maxTokens: 4784 },
} as const satisfies Record<string, Tier>;

export type TierName = "standard" | "high";

/** pi re-encodes a tool image with a side over this when the model declares no resize profile. */
export const PI_DEFAULT_MAX_SIDE = 2000;

/**
 * Once a request holds more than 20 images, the API rejects any image with a
 * side over 3000px. Old images are resent every turn, so no image may exceed
 * it, whatever a model's resize profile allows.
 */
export const MANY_IMAGE_MAX_SIDE = 3000;

export const MAX_IMAGES_PER_CALL = 12;

/** The API rounds .5 ties to even, like Python's round(); Math.round is a pixel off there. */
function roundHalfToEven(x: number): number {
  const lower = Math.floor(x);
  const frac = x - lower;
  if (frac > 0.5) return lower + 1;
  if (frac < 0.5) return lower;
  return lower % 2 === 0 ? lower : lower + 1;
}

export function countImageTokens(width: number, height: number): number {
  return Math.ceil(width / PATCH) * Math.ceil(height / PATCH);
}

function fits(width: number, height: number, tier: Tier): boolean {
  const side = tier.maxSide ?? Number.POSITIVE_INFINITY;
  return (
    width <= side &&
    height <= side &&
    Math.ceil(width / PATCH) * PATCH <= tier.maxEdge &&
    Math.ceil(height / PATCH) * PATCH <= tier.maxEdge &&
    countImageTokens(width, height) <= tier.maxTokens
  );
}

/** The largest aspect-preserving size that fits the tier; unchanged if it already fits. */
export function resizedSize(width: number, height: number, tier: Tier = TIERS.standard): Size {
  if (fits(width, height, tier)) return { width, height };

  if (height > width) {
    const swapped = resizedSize(height, width, tier);
    return { width: swapped.height, height: swapped.width };
  }

  const aspectRatio = width / height;
  const heightFor = (w: number): number => Math.max(roundHalfToEven(w / aspectRatio), 1);

  let lo = 1;
  let hi = width;
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (fits(mid, heightFor(mid), tier)) lo = mid;
    else hi = mid;
  }
  return { width: lo, height: heightFor(lo) };
}

export function base64Bytes(rawBytes: number): number {
  return Math.ceil(rawBytes / 3) * 4;
}

export type ViewPlan =
  | { kind: "asis"; tokens: number }
  | { kind: "downscale"; to: Size; scale: number; tokens: number }
  | {
      kind: "slice";
      slices: Box[];
      scaleIfForced: number;
      reason: string;
      /** Present only when the page was too tall for `maxSlices`. */
      truncated?: {
        coveredHeight: number;
        totalHeight: number;
        neededSlices: number;
      };
    };

export interface ViewOptions {
  tier?: Tier;
  /** Slice instead of shrinking when the shrink would leave less than this many pixels across a full-size capture. */
  minLongEdge?: number;
  /** Vertical overlap between slices, so a line of text on a seam is whole in one of them. */
  overlap?: number;
  maxSlices?: number;
}

function sideLimit(tier: Tier): number {
  return Math.min(tier.maxEdge, tier.maxSide ?? Number.POSITIVE_INFINITY);
}

/** Full-width slice height in whole patch rows, so no tokens are spent on padding. */
function maxSliceHeight(width: number, tier: Tier): number {
  const patchCols = Math.ceil(width / PATCH);
  const patchRows = Math.min(
    Math.floor(tier.maxTokens / patchCols),
    Math.floor(tier.maxEdge / PATCH),
  );
  return Math.min(patchRows * PATCH, tier.maxSide ?? Number.POSITIVE_INFINITY);
}

function tile(
  width: number,
  height: number,
  sliceHeight: number,
  overlap: number,
  maxSlices: number,
): { boxes: Box[]; neededSlices: number } {
  if (overlap < 0 || overlap >= sliceHeight) {
    throw new Error(
      `overlap must be between 0 and ${sliceHeight - 1}px for a ${sliceHeight}px slice, got ${overlap}`,
    );
  }
  const step = sliceHeight - overlap;
  const neededSlices = Math.max(1, Math.ceil((height - sliceHeight) / step) + 1);

  const boxes: Box[] = [];
  for (let y = 0; y < height; y += step) {
    // A capped plan stops at the cap instead of bottom-aligning, which would
    // leave an unannounced hole in the middle.
    if (boxes.length >= maxSlices) return { boxes, neededSlices };
    if (y + sliceHeight >= height) {
      boxes.push({
        x: 0,
        y: Math.max(0, height - sliceHeight),
        width,
        height: Math.min(sliceHeight, height),
      });
      break;
    }
    boxes.push({ x: 0, y, width, height: sliceHeight });
  }
  return { boxes, neededSlices };
}

/**
 * Ship as-is, downscale once, or cut into full-width slices when a downscale
 * would shrink text below `minLongEdge`.
 */
export function planView(width: number, height: number, opts: ViewOptions = {}): ViewPlan {
  const tier: Tier = opts.tier ?? TIERS.standard;
  const minLongEdge = opts.minLongEdge ?? 900;
  const overlap = opts.overlap ?? 40;
  const maxSlices = opts.maxSlices ?? MAX_IMAGES_PER_CALL;

  const fitted = resizedSize(width, height, tier);
  if (fitted.width === width && fitted.height === height) {
    return { kind: "asis", tokens: countImageTokens(width, height) };
  }

  const scale = fitted.width / width;
  const sliceable =
    Math.ceil(width / PATCH) * PATCH <= tier.maxEdge &&
    width <= (tier.maxSide ?? Number.POSITIVE_INFINITY);

  if (sliceable && scale * sideLimit(tier) < minLongEdge) {
    const sliceHeight = maxSliceHeight(width, tier);
    const { boxes: slices, neededSlices } = tile(width, height, sliceHeight, overlap, maxSlices);
    const percent = Math.round(scale * 100);

    const last = slices[slices.length - 1]!;
    const coveredHeight = last.y + last.height;
    const truncated =
      neededSlices > slices.length
        ? { coveredHeight, totalHeight: height, neededSlices }
        : undefined;

    return {
      kind: "slice",
      slices,
      scaleIfForced: scale,
      ...(truncated ? { truncated } : {}),
      reason:
        `fitting ${width}×${height} would give ${fitted.width}×${fitted.height} — ` +
        `${percent}% of the width, under the ${minLongEdge}px legibility floor. ` +
        `${slices.length} full-width slices of ${width}×${sliceHeight} instead, ` +
        `${overlap}px overlap.`,
    };
  }

  return {
    kind: "downscale",
    to: fitted,
    scale,
    tokens: countImageTokens(fitted.width, fitted.height),
  };
}

/**
 * The tier a tool actually uses: the published limits plus the side cap, so
 * no output can become illegal later in a session. Any name but "standard"
 * gets the high tier, which is never smaller.
 */
export function resolveTier(name?: TierName | string, maxSide: number = PI_DEFAULT_MAX_SIDE): Tier {
  const base = name === "standard" ? TIERS.standard : TIERS.highRes;
  return { ...base, maxSide: Math.min(maxSide, MANY_IMAGE_MAX_SIDE) };
}

const CLAUDE_FAMILY_ID = /^(?:anthropic\/)?claude-[a-z]+-(\d+)(?:[-.](\d{1,2}))?(?:-\d{8})?$/;
const CLAUDE_LEGACY_ID = /^(?:anthropic\/)?claude-(\d+)(?:[-.](\d{1,2}))?-[a-z]+/;

/**
 * Claude 4.7 and later are on the high-resolution tier; older Claude models
 * downscale anything past the standard limits themselves. Unknown models get
 * "high": an oversized image is resized by the API, never rejected.
 */
export function tierForModel(modelId?: string): TierName {
  const match = modelId ? CLAUDE_FAMILY_ID.exec(modelId) ?? CLAUDE_LEGACY_ID.exec(modelId) : null;
  if (!match) return "high";
  const major = Number(match[1]);
  const minor = Number(match[2] ?? 0);
  return major > 4 || (major === 4 && minor >= 7) ? "high" : "standard";
}
