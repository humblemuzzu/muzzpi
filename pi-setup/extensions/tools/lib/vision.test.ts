import { describe, expect, test } from "bun:test";
import {
  countImageTokens,
  MANY_IMAGE_MAX_SIDE,
  PI_DEFAULT_MAX_SIDE,
  MAX_IMAGES_PER_CALL,
  planView,
  resizedSize,
  resolveTier,
  TIERS,
  tierForModel,
} from "./vision";

const size = (width: number, height: number) => ({ width, height });

/** The TypeScript reference implementation from Anthropic's vision-coordinates guide, verbatim. */
function referenceResizedSize(width: number, height: number, maxEdge = 1568, maxTokens = 1568): [number, number] {
  const tokens = (w: number, h: number) => Math.ceil(w / 28) * Math.ceil(h / 28);
  const roundTiesToEven = (value: number) => {
    const floor = Math.floor(value);
    if (value - floor !== 0.5) return Math.round(value);
    return floor % 2 === 0 ? floor : floor + 1;
  };
  const fits = (w: number, h: number) =>
    Math.ceil(w / 28) * 28 <= maxEdge && Math.ceil(h / 28) * 28 <= maxEdge && tokens(w, h) <= maxTokens;
  if (fits(width, height)) return [width, height];
  if (height > width) {
    const [h, w] = referenceResizedSize(height, width, maxEdge, maxTokens);
    return [w, h];
  }
  const aspectRatio = width / height;
  let lo = 1;
  let hi = width;
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (fits(mid, Math.max(roundTiesToEven(mid / aspectRatio), 1))) lo = mid;
    else hi = mid;
  }
  return [lo, Math.max(roundTiesToEven(lo / aspectRatio), 1)];
}

describe("resizedSize — the vision guide's resolution table", () => {
  const rows: Array<[number, number, [number, number], number, [number, number], number]> = [
    [200, 200, [200, 200], 64, [200, 200], 64],
    [1000, 1000, [1000, 1000], 1296, [1000, 1000], 1296],
    [1092, 1092, [1092, 1092], 1521, [1092, 1092], 1521],
    [1920, 1080, [1456, 819], 1560, [1920, 1080], 2691],
    [3840, 2160, [1456, 819], 1560, [2576, 1449], 4784],
  ];
  for (const [w, h, std, stdTokens, high, highTokens] of rows) {
    test(`${w}×${h}`, () => {
      const s = resizedSize(w, h, TIERS.standard);
      const hr = resizedSize(w, h, TIERS.highRes);
      expect([s.width, s.height]).toEqual(std);
      expect(countImageTokens(s.width, s.height)).toBe(stdTokens);
      expect([hr.width, hr.height]).toEqual(high);
      expect(countImageTokens(hr.width, hr.height)).toBe(highTokens);
    });
  }

  test("the A4 scan: 1075×1520 → 924×1307 on standard, untouched on high-res", () => {
    expect(resizedSize(1075, 1520)).toEqual(size(924, 1307));
    expect(resizedSize(1075, 1520, TIERS.highRes)).toEqual(size(1075, 1520));
    expect(countImageTokens(1075, 1520)).toBe(2145);
  });

  test("1920×1080 is token-bound: 1456×819, not the edge-bound 1568×882", () => {
    expect(resizedSize(1920, 1080)).not.toEqual(size(1568, 882));
  });
});

// The guide's table prints 1269×952 for 2000×1500 on standard, but its own
// reference code gives 1270×952: 1270 / (4/3) is exactly 952.5, which rounds to
// even (952, 1564 tokens, fits). Rounding half up gives 953 and 1610 tokens.
describe("resizedSize — 2000×1500, the round-half-to-even case", () => {
  test("matches the reference implementation, 1270×952", () => {
    expect(resizedSize(2000, 1500)).toEqual(size(1270, 952));
    expect(referenceResizedSize(2000, 1500)).toEqual([1270, 952]);
  });

  test("Math.round would push it over budget", () => {
    expect(Math.round(1270 / (2000 / 1500))).toBe(953);
    expect(countImageTokens(1270, 953)).toBeGreaterThan(TIERS.standard.maxTokens);
  });
});

describe("resizedSize — agrees with the reference implementation", () => {
  test("on 50,000 random sizes on both published tiers", () => {
    let seed = 12345;
    const next = (max: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return 1 + (seed % max);
    };
    for (let i = 0; i < 50_000; i += 1) {
      const w = next(8000);
      const h = next(8000);
      for (const tier of [TIERS.standard, TIERS.highRes]) {
        const ours = resizedSize(w, h, tier);
        const ref = referenceResizedSize(w, h, tier.maxEdge, tier.maxTokens);
        if (ours.width !== ref[0] || ours.height !== ref[1]) {
          expect({ w, h, tier, ours }).toEqual({ w, h, tier, ours: size(ref[0], ref[1]) });
        }
      }
    }
  });

  test("portrait is the transpose of landscape", () => {
    expect(resizedSize(1080, 1920)).toEqual(size(819, 1456));
    expect(resizedSize(1520, 1075)).toEqual(size(1307, 924));
  });

  test("a very tall image is edge-bound, not token-bound", () => {
    expect(resizedSize(1568, 7698)).toEqual(size(319, 1568));
  });
});

describe("countImageTokens", () => {
  test("one token per 28×28 patch, padding included", () => {
    expect(countImageTokens(1000, 1000)).toBe(1296);
    expect(countImageTokens(1456, 819)).toBe(1560);
    expect(countImageTokens(1560, 28)).toBe(56);
    expect(countImageTokens(1569, 28)).toBe(57);
  });

  test("the largest unresized high-res square is 1932, not 2044", () => {
    expect(countImageTokens(2044, 2044)).toBe(5329);
    expect(resizedSize(2044, 2044, TIERS.highRes)).toEqual(size(1932, 1932));
    expect(countImageTokens(1932, 1932)).toBe(4761);
  });
});

describe("planView", () => {
  test("1568×602 fits as-is", () => {
    const plan = planView(1568, 602);
    expect(plan.kind).toBe("asis");
    if (plan.kind !== "asis") throw new Error("unreachable");
    expect(plan.tokens).toBe(1232);
  });

  test("1568×1388 downscales to 1170×1036", () => {
    const plan = planView(1568, 1388);
    if (plan.kind !== "downscale") throw new Error("expected a downscale plan");
    expect(plan.to).toEqual(size(1170, 1036));
    expect(plan.tokens).toBe(1554);
    expect(Math.round(plan.scale * 100)).toBe(75);
  });

  test("1568×7698 slices rather than shrinking to 319px wide", () => {
    const plan = planView(1568, 7698);
    if (plan.kind !== "slice") throw new Error("expected a slice plan");
    expect(plan.scaleIfForced).toBeCloseTo(319 / 1568, 4);
    expect(plan.reason).toContain("319");
  });

  test("every slice fits the budget on its own and none is a sliver", () => {
    const plan = planView(1568, 7698);
    if (plan.kind !== "slice") throw new Error("expected a slice plan");
    for (const box of plan.slices) {
      expect(box.width).toBe(1568);
      expect(box.height).toBe(784);
      expect(countImageTokens(box.width, box.height)).toBeLessThanOrEqual(TIERS.standard.maxTokens);
    }
  });

  test("slices cover the image top to bottom and overlap by the requested amount", () => {
    const plan = planView(1568, 7698, { overlap: 40 });
    if (plan.kind !== "slice") throw new Error("expected a slice plan");
    expect(plan.slices[0]!.y).toBe(0);
    const last = plan.slices[plan.slices.length - 1]!;
    expect(last.y + last.height).toBe(7698);
    for (let i = 1; i < plan.slices.length; i += 1) {
      const previous = plan.slices[i - 1]!;
      expect(plan.slices[i]!.y).toBeLessThanOrEqual(previous.y + previous.height - 40);
    }
  });

  test("a portrait phone screenshot downscales", () => {
    expect(planView(1080, 1920).kind).toBe("downscale");
  });

  test("a 4K screenshot downscales because full-width slices could never fit", () => {
    const plan = planView(3840, 2160);
    if (plan.kind !== "downscale") throw new Error("expected a downscale plan");
    expect(plan.to).toEqual(size(1456, 819));
  });

  test("an overlap at or above the slice height is refused", () => {
    expect(() => planView(1568, 7698, { overlap: 2000 })).toThrow(/overlap must be between/);
  });
});

describe("resolveTier", () => {
  test("high unless standard is asked for by name", () => {
    for (const name of [undefined, "high", "ultra", ""]) {
      expect(resolveTier(name).maxTokens).toBe(TIERS.highRes.maxTokens);
    }
    expect(resolveTier("standard").maxTokens).toBe(TIERS.standard.maxTokens);
  });

  test("the high tier is never smaller than standard", () => {
    const shapes: Array<[number, number]> = [
      [3840, 2160], [2800, 1800], [1800, 1200], [1000, 600],
      [1440, 900], [5120, 2880], [660, 1664], [390, 844],
    ];
    for (const [w, h] of shapes) {
      const std = resizedSize(w, h, resolveTier("standard"));
      const high = resizedSize(w, h, resolveTier("high"));
      expect(high.width * high.height).toBeGreaterThanOrEqual(std.width * std.height);
    }
  });

  test("a smaller side cap from the model's resize profile is respected", () => {
    expect(resolveTier("high", 1500).maxSide).toBe(1500);
    expect(Math.max(...Object.values(resizedSize(3840, 2160, resolveTier("high", 1500))))).toBe(1500);
  });

  test("a larger side cap never lifts it past the many-image limit", () => {
    expect(MANY_IMAGE_MAX_SIDE).toBe(3000);
    expect(resolveTier("high", 4000).maxSide).toBe(MANY_IMAGE_MAX_SIDE);
  });

  test("a 2576px resize profile is used in full on the high tier", () => {
    expect(resolveTier("high", 2576).maxSide).toBe(2576);
    expect(resizedSize(3840, 2160, resolveTier("high", 2576))).toEqual(size(2576, 1449));
  });

  test("without a model profile the cap is pi's default", () => {
    expect(resolveTier("high").maxSide).toBe(PI_DEFAULT_MAX_SIDE);
  });
});

// pi re-encodes any tool image over the model's resize profile (2000px by
// default); the API's many-image rule (3000px past 20 images) bounds any profile.
describe("the side cap", () => {
  test("3840×2160 on high becomes 2000×1125: 2000 raw is legal, the padded 2016 is not checked against it", () => {
    const fitted = resizedSize(3840, 2160, resolveTier("high"));
    expect(fitted).toEqual(size(2000, 1125));
    expect(countImageTokens(2000, 1125)).toBeLessThanOrEqual(TIERS.highRes.maxTokens);
  });

  test("no input makes either tier emit a side over the cap it was given", () => {
    const shapes: Array<[number, number]> = [
      [3840, 2160], [2880, 1800], [5120, 2880], [1000, 9000], [9000, 1000],
      [8000, 8000], [2576, 1449], [2001, 2001], [3001, 3001], [1, 12000], [12000, 1],
    ];
    for (const [profile, cap] of [[undefined, PI_DEFAULT_MAX_SIDE], [2576, 2576], [4000, MANY_IMAGE_MAX_SIDE]] as const) {
      for (const name of ["standard", "high"] as const) {
        for (const [w, h] of shapes) {
          const plan = planView(w, h, { tier: resolveTier(name, profile) });
          const sizes = plan.kind === "asis" ? [size(w, h)] : plan.kind === "downscale" ? [plan.to] : plan.slices;
          for (const s of sizes) {
            expect({ profile, name, w, h, over: Math.max(s.width, s.height) > cap }).toEqual({
              profile, name, w, h, over: false,
            });
          }
        }
      }
    }
  });

  test("high-tier slices are 2000px tall and inside the token budget", () => {
    const plan = planView(1440, 6996, { tier: resolveTier("high") });
    if (plan.kind !== "slice") throw new Error("expected a slice plan");
    for (const box of plan.slices) {
      expect(box.height).toBeLessThanOrEqual(2000);
      expect(countImageTokens(box.width, box.height)).toBeLessThanOrEqual(TIERS.highRes.maxTokens);
    }
    expect(plan.slices[0]!.height).toBe(2000);
  });
});

describe("tierForModel", () => {
  test("Claude 4.7 and later are on the high-resolution tier", () => {
    for (const id of [
      "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1",
      "claude-opus-4-7", "claude-opus-4-8", "anthropic/claude-sonnet-5.5",
    ]) {
      expect({ id, tier: tierForModel(id) }).toEqual({ id, tier: "high" });
    }
  });

  test("older Claude models are on standard", () => {
    for (const id of [
      "claude-opus-4-1", "claude-sonnet-4-5", "claude-sonnet-4-5-20250929", "claude-haiku-4-5",
      "claude-sonnet-4-20250514", "claude-3-5-sonnet-20241022", "claude-3-opus-20240229",
      "anthropic/claude-sonnet-4.5",
    ]) {
      expect({ id, tier: tierForModel(id) }).toEqual({ id, tier: "standard" });
    }
  });

  test("anything else gets high: the API resizes an oversized image, it never rejects it", () => {
    for (const id of [undefined, "", "deepseek-flash", "z-ai/glm-5.3-flash", "claude-mystery"]) {
      expect(tierForModel(id)).toBe("high");
    }
  });
});

describe("the per-call image cap", () => {
  const tall = (h: number, opts = {}) => planView(1440, h, { tier: resolveTier("high"), ...opts });

  test("no page height can produce more than the cap", () => {
    for (const h of [3000, 6996, 12000, 20000, 50000, 100000, 1_000_000]) {
      const plan = tall(h);
      const n = plan.kind === "slice" ? plan.slices.length : 1;
      expect({ h, over: n > MAX_IMAGES_PER_CALL }).toEqual({ h, over: false });
    }
  });

  test("a page under the cap is not marked truncated and is covered to the bottom", () => {
    const plan = tall(6996);
    if (plan.kind !== "slice") throw new Error("expected a slice plan");
    expect(plan.truncated).toBeUndefined();
    const last = plan.slices[plan.slices.length - 1]!;
    expect(last.y + last.height).toBe(6996);
  });

  test("a page over the cap is truncated contiguously from the top and says how far it got", () => {
    const plan = tall(1_000_000);
    if (plan.kind !== "slice") throw new Error("expected a slice plan");
    expect(plan.slices).toHaveLength(MAX_IMAGES_PER_CALL);
    expect(plan.slices[0]!.y).toBe(0);
    for (let i = 1; i < plan.slices.length; i += 1) {
      const prev = plan.slices[i - 1]!;
      expect(plan.slices[i]!.y).toBeLessThan(prev.y + prev.height);
    }
    const last = plan.slices[plan.slices.length - 1]!;
    expect(plan.truncated!.coveredHeight).toBe(last.y + last.height);
    expect(plan.truncated!.coveredHeight).toBeLessThan(1_000_000);
    expect(plan.truncated!.neededSlices).toBeGreaterThan(MAX_IMAGES_PER_CALL);
  });

  test("the cap is overridable, and 1 is a legal value", () => {
    const plan = tall(50_000, { maxSlices: 1 });
    if (plan.kind !== "slice") throw new Error("expected a slice plan");
    expect(plan.slices).toHaveLength(1);
    expect(plan.truncated!.coveredHeight).toBe(plan.slices[0]!.height);
  });

  test("high needs fewer slices than standard for the same page", () => {
    const std = planView(1440, 20000, { tier: resolveTier("standard"), maxSlices: 999 });
    const high = planView(1440, 20000, { tier: resolveTier("high"), maxSlices: 999 });
    if (std.kind !== "slice" || high.kind !== "slice") throw new Error("expected slice plans");
    expect(high.slices.length).toBeLessThan(std.slices.length);
  });
});

describe("the shell workaround this pipeline replaces", () => {
  test("`sips -Z 1400` leaves a 16:10 window over budget, so the API resizes it again", () => {
    expect(countImageTokens(1400, 900)).toBe(1650);
    expect(resizedSize(1400, 900)).toEqual(size(1372, 882));
  });

  test("`sips -Z 1568` is wrong for the same reason", () => {
    expect(countImageTokens(1568, 1008)).toBeGreaterThan(TIERS.standard.maxTokens);
  });

  test("planning from logical points instead of a 2× capture's pixels misjudges the cost 4×", () => {
    expect(countImageTokens(2800, 1800)).toBe(6500);
    expect(countImageTokens(1400, 900)).toBe(1650);
  });
});
