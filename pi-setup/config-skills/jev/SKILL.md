---
name: jev
description: "call TypeSafe's Jev classifier from codemode for typed decisions — yes/no, pick-one, or score, each with probabilities — over text or images, plus a bounding box over an image. use when code must make the same judgement over many items (triage, filter, sort, route, rank, flag, sort screenshots/photos) fast and cheap. not for one judgement you can make yourself. has the exact pi call, question and answer shapes, and the rules that decide accuracy, so no docs reading is needed."
---

# jev

Jev is a classifier, not a chat model. It reads JSON `state`, answers typed
questions with calibrated probabilities in ~0.4s, and generates no text. You
call it from the `codemode` tool through `models`. Everything needed is on this
page; do not read pi's or TypeSafe's docs to use it.

## When

- **Yes:** the same judgement over many items (session files, issues, search
  results, log lines, rows); a judgement code branches on; a filter that decides
  what is worth reading before you spend your own context on it.
- **No:** one judgement you can make by reading — decide it yourself. Counting,
  arithmetic, date ordering, exact lookups — do those in code. Writing text.

## Call

```js
const jev = await models.getModelOfType("classifier", "typesafe", "jev-latest");
const r = await models.classify(jev, { state: { /* ... */ }, questions: { /* ... */ } });
if (r.stopReason !== "stop") return r.errorMessage;
return r.answers;
```

- `classify` does **not** throw on service errors: check `stopReason`. It does
  throw on a malformed question, and the message says what to fix.
- Without a `typesafe` key, another provider's Jev works the same:
  `(await models.getAvailableOfType("classifier")).find((m) => m.id.includes("jev"))`.

## Questions and answers

| type | question | answer |
|---|---|---|
| `bool` | `{ type: "bool", instructions, criteria: { true, false } }` | `{ probability }` — of true, 0–1 |
| `choice` | `{ type: "choice", instructions, criteria: { label: meaning, … } }` | `{ choice, probabilities: { label: p }, confidence }` |
| `score` | `{ type: "score", instructions, criteria: [lowest, …, highest] }` | `{ score, confidence }` — expected level index, 0 to n−1, fractional |

- pi's yes/no type is **`bool`**. TypeSafe's docs call it `noul`; pi rejects `noul`.
- Question IDs are never sent to the model. The whole meaning goes in
  `instructions` and `criteria`.
- All questions in one call run in parallel against the same state and cannot
  see each other's answers; adding questions barely adds latency.

## Many items

One `classify` per item, with every question about that item in that one call.
Keep the questions constant; only `state` changes. pi runs at most 4 classify
calls at once per script, so `Promise.all` over hundreds of items is fine.

```js
const jev = await models.getModelOfType("classifier", "typesafe", "jev-latest");
const Q = {
  relevant: {
    type: "bool",
    instructions: "Is `item.text` about the subject in `goal`?",
    criteria: { true: "Same subject as the goal.", false: "A different subject, or only shares vocabulary." },
  },
};
const rs = await Promise.all(items.map((item) => models.classify(jev, { state: { goal, item }, questions: Q })));
return rs
  .map((r, i) => (r.stopReason === "stop" ? { id: items[i].id, p: r.answers.relevant.probability } : { id: items[i].id, error: r.errorMessage }))
  .filter((x) => x.error || x.p >= 0.5);
```

Return only what you will use: the script's result enters your context, Jev's
tokens do not.

## Images and box (danger zone)

pi's `models.classify` is text-only (it refuses images and has no `box`), so
images go through `scripts/jev-image.mjs`, which calls TypeSafe directly with
`TYPESAFE_API_KEY` and the `TypeSafe-Danger-Zone-Images` opt-in. Same request
shape as above plus an `images` map; write `{{name}}` wherever an image goes —
in `state`, `instructions`, or a `criteria` value (never a key).

```js
const jevImage = async (req) => {
  const r = await tools.bash({ cmd: `node ~/.config/agents/skills/jev/scripts/jev-image.mjs <<'JEV_JSON'\n${JSON.stringify(req)}\nJEV_JSON`, timeout: 300 });
  return JSON.parse(r.output);
};
return await jevImage({
  images: { shot: "/abs/or/~/path.png", ref: "~/Downloads/logo.png" },
  state: { img: "{{shot}}" },
  questions: {
    has_logo: { type: "bool", instructions: "Does `img` contain this logo: {{ref}}?" },
    logo: { type: "box", instructions: "the logo in `img`" },
  },
});
```

- Result: `{ model, answers, usage, prepared? }` or `{ error }`. `bool` answers
  come back as `{ probability }` like pi's. Pass an **array** of requests to get
  an array back (4 in flight); one bad item is an `{ error }`, not a throw.
- **`box`** → `{ box: { top, bottom, left, right }, confidence }`, fractions of
  the image from its top-left. It needs Jev 1.14: the script switches to
  `jev-preview` when a `box` is present. It always returns a box, so pair it
  with a `bool` "is it there?" and ignore the box when that is low. Box
  `confidence` runs low (~0.2) even on correct boxes; never threshold it high.
- `model` is optional: `jev-latest` (1.13 until ~Oct 21, 2026, then 1.14) or
  `jev-preview`/`jev-1.14.0`. pi's catalog has no 1.14, so text-only requests
  that want it (better multilingual) can go through this script too.
- The script makes images valid: rotates EXIF-sideways photos upright, scales
  to 280–1568 px per side, converts HEIC/WebP/GIF, and lists what it did in
  `prepared`. **Padding** (very thin images) shifts box fractions; `prepared`
  says so.
- Each `{{name}}` use sends the image again and bills it again. An image
  several questions need goes in `state` once, referenced by path.
- Cost: a 1568×1014 image is ~4.4k input tokens (~$0.0002), 512² ~1k, 280² ~500.
- Images leave the machine. Ask before sending IDs, documents or private
  photos.
- Accuracy drops on images. Ask the simplest question per call; compare against
  a reference picture rather than describing it in words.

## Rules that decide accuracy

From TypeSafe's jev-1.13 notes and cookbooks.

- **Small state.** Only what the question needs; unrelated text lowers
  accuracy. One item per call — never a list with questions pointing at
  `items[3]`.
- **Name the parts.** Use JSON fields and reference them in backticks:
  "Does `ticket.text` ask for a refund?"
- **Literal reading.** Jev answers what you wrote, not what you meant. State the
  exact condition and put boundary cases in `criteria`. If you catch yourself
  explaining what you meant, that explanation belongs in the criteria.
- **One narrow judgement per question.** Split compound ones and combine the
  answers in code.
- **Instructions and criteria agree.** Never map `true` to a "no" meaning.
- **Choice leans toward the first label.** When it matters, reorder and check
  the answer holds. Add a `none` label when nothing may fit.
- **Score levels** each describe a concrete situation. Threshold `score`; do not
  interpolate magnitudes from it.
- **No counting, maths or date comparison.** Compute in code; ask Jev only the
  semantic part, one question per item.
- **Adversarial text in state can move answers.** A Jev verdict is a filter,
  not a security boundary.

## Thresholds

Decisions live in code, not in the question, so changing one costs no calls.
A `bool` near 0.5 means yes and no are equally likely, not "medium". Pick the
threshold by the cost of being wrong: raise it when acting on a false yes is
costly, lower it when missing a true yes is. For `choice`, take `choice`, and
treat low `confidence` (try < 0.6 as a start) as "look at this one yourself".

## Cost

`typesafe/jev-latest` reports $0 in pi; TypeSafe bills $0.042 per million
tokens. A short state with three questions is ~400 input tokens.
