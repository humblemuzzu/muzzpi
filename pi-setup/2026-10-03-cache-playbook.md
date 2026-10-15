# The cache playbook

Everything learned while finding out why a Claude Max subscription drained through
pi far faster than through the official CLI. Written so a future me can redo the
measurement, avoid the mistakes, and not need an agent to rediscover it.

Read section 14 first if you are in a hurry. Read section 2 if you want the
concept to stick.

---

## Table of contents

0. How to use this document
1. The symptom
2. The mental model (why prefix caching behaves this way)
3. Where the ground truth lives
4. The measuring toolkit, with scripts
5. The investigation, in the order it actually happened
6. The root cause
7. The fix
8. Verification: before and after in numbers
9. Every mistake I made and the lesson
10. Secondary finding: the system prompt losing 2,567 characters
11. Other landmines found
12. Codemode: an honest assessment
13. Reference: exact commands
14. Cheat sheet
15. Glossary
16. Still open / not verified
17. File and line index

---

## 0. How to use this document

Three audiences:

- **Inference learner.** Read section 2, then 15. Sections 2.2 and 2.3 explain
  why prompt caching must be prefix-only, which is the actual reason the bug
  existed.
- **Operator.** Read 4, then 13, then 14. The scripts in 4 are copy-pasteable.
- **Future agent.** Read 1, 5, 9, 14. Section 9 is the part that stops the same
  wrong turns being taken again.

Every number in here was measured on this machine. Every claim about code names a
file and line. Where I did not verify something, it says so.

Two conventions:

- `~` means the home directory of the machine it was measured on
- "the repo" means this repository (muzzpi)

---

## 1. The symptom

A Claude Max 20x plan, $200/month, fresh. The usage page read **19% of the weekly
limit consumed in under 24 hours**. Same plan, same models, same account as other
people who described their own usage as effectively unlimited.

The only difference: this machine ran **pi** instead of the official **Claude
Code CLI**.

That comparison is the whole investigation in one sentence. Same provider, same
billing, same tokenizer, same models. One program behaves normally, the other
burns 19% of a week in a day.

The useful question was never "is 83 million tokens a lot". It was "what does the
same workload look like when it works".

A second symptom, only visible after measuring: the weekly bar drained fast while
the 5-hour session bar read 0%. The 5-hour bar resets often enough to hide a slow
bleed, so only the weekly number showed it.

---

## 2. The mental model

This section is the part that makes the rest obvious. If you only remember one
thing, remember 2.2.

### 2.1 The stack of pages

Anthropic's prompt cache is easiest to hold in your head as a photocopier with a
loyalty scheme.

You send a stack of pages every request. If the new stack starts with exactly the
same pages as last time, you only pay for the new pages at the bottom. Send the
same 300 pages plus one more and you pay for one.

The catch: the comparison runs from the top down, page 1, page 2, page 3. **The
moment a page differs, everything from that page to the bottom counts as new and
you pay for all of it.**

This is why one changed byte near the top is catastrophic and one changed byte at
the bottom is free.

Measured on the broken setup, one session, 40 turns:

```
 #    prompt      read     write      gap   write%
 0     41329         0     41325       --     100%   <- cold start, unavoidable
 1     42752     41325      1425       4s       3%
 2     43062     42750       310       6s       1%
 3     42815     17955     24856      28s      58%   <- a break
 4     43484     42811       669      37s       2%
 ...
39    263558     54127    209427           79%
```

Read the `read` column of the *broken* version, from a different session:

```
  2     99607     55016     44587       45%
  4    124159     55016     69139       56%
  8    206731     55016    151711       73%
 11    228922     55016    173902       76%
 39    263558     54127    209427       79%
```

The prompt grows from 99k to 264k. The read **never moves** from 55,016. That is
the fingerprint. It means the cache was matching the same fixed head every time
and the entire conversation was being re-charged from scratch on every turn.

### 2.2 Why prefixes only (the inference reason)

This is the part worth understanding properly.

A decoder-only transformer generates token N by attending over the key and value
vectors of every token before it. Those KV vectors are computed during
**prefill**. Then generation (**decode**) produces one token at a time.

Causal attention means the KV vector for position 5 depends only on tokens 1
through 5. So:

- change a token at position 3, and KV for positions 3, 4, 5, ... all become
  invalid
- change a token at position 200, and only positions 200 onward are invalid,
  everything before is still good

The cache can therefore only match "everything from the start that is still
byte-identical". **Prefix-only caching is not a policy Anthropic chose. It is a
consequence of how attention works.**

This is why the guardrails bug (section 6) was so expensive. It changed something
near the top of the request on every call, so the KV for everything below it was
thrown away every time.

### 2.3 Cache write versus cache read economics

From Anthropic's prompt-caching pricing page, in dollars per million tokens:

| | Opus 5.5 | Sonnet 5.5 | why |
|---|---|---|---|
| base input | $4 | $2 | you compute KV for these |
| 5-minute cache write | $5 | $2.50 | compute KV **and** store it |
| 1-hour cache write | $8 | (higher tier) | same, storage reserved longer |
| cache read | $0.20 | $0.20 | load the KV, no compute |
| output | $20 | $10 | decode is sequential and slow |

Multiply those: cache writes are 1.25x base input for the 5-minute tier and 2x
for the 1-hour tier. A cache read is **5% of base input**, so a read is 25x
cheaper than a write.

The intuition people get wrong: caching does not make things cheap. It makes
**reuse** cheap and makes the **first write** slightly more expensive. If the
prefix never stabilises you pay the write price forever and the cheap read never
arrives. That is exactly what was happening.

There is a real strategic consequence. If your turns are seconds apart, the
5-minute tier is enough and it is cheaper per write. If your turns are minutes
apart, the 5-minute tier expires and you re-write the whole thing; the 1-hour tier
costs more per write but survives. Which one is better depends on your gap
distribution, and you cannot guess it. Section 4.4 shows how to measure it.

### 2.4 What the Max subscription meter counts

Two separate systems, and mixing them up is the most common error in GitHub
threads:

**API rate limits** (platform.claude.com/docs/en/api/rate-limits). Official and
explicit: for most models only uncached input and cache creation count toward
ITPM. `cache_read_input_tokens` does **not** count.

**The Max subscription meter.** Anthropic publishes no weights at all. Only
qualitative wording on support.claude.com: cached portions "count less against
your limits than new content", and "caches expire after a period of inactivity,
so if you come back after a long break your first message counts that content in
full again".

Community header-delta probes against the live `anthropic-ratelimit-unified-*`
response headers (a Dec 2025 gist, and `cwy433-png/claude-quota-meter` in Aug
2026) both found cache reads are effectively free on the 5-hour window and cache
writes cost about 1x uncached input. Those are measurements, not documentation.

Practical upshot: everything cheap about a long session comes from cache reads,
and everything expensive comes from cache writes. Minimise writes.

---

## 3. Where the ground truth lives

Before writing a single hypothesis, find the receipts. Every tool that talks to
Anthropic logs the API's own `usage` object to disk.

### 3.1 pi session files

```
~/.pi/agent/sessions/<workspace-slug>/<timestamp>_<session-id>.jsonl
```

One JSON object per line. Assistant messages carry `message.usage`. Note the
filename contains both a creation timestamp and the session id.

### 3.2 Claude Code session files

```
~/.claude/projects/<workspace-slug>/<session-id>.jsonl
```

Same idea, different slug format (dashes instead of slashes).

Both read the same API fields. Same machine, same account, same OAuth token.
That makes them a controlled experiment, which is the whole reason the comparison
was possible.

### 3.3 The usage object, field by field

pi:

```json
{ "input": 2, "output": 156, "cacheRead": 16356, "cacheWrite": 9719,
  "cacheWrite1h": 0, "reasoning": 0, "totalTokens": 26233 }
```

Claude Code (raw API names):

```json
{ "input_tokens": 2, "output_tokens": 57,
  "cache_creation_input_tokens": 12323,
  "cache_read_input_tokens": 22801,
  "cache_creation": { "ephemeral_1h_input_tokens": 12323,
                      "ephemeral_5m_input_tokens": 0 } }
```

| field | plain meaning |
|---|---|
| `input_tokens` / `input` | fresh text the model had never seen |
| `cache_creation_input_tokens` / `cacheWrite` | text computed and stored into the cache this request |
| `cache_read_input_tokens` / `cacheRead` | text reused from a previous request's cache |
| `cache_creation.ephemeral_5m_input_tokens` | part of that write that lives 5 minutes |
| `cache_creation.ephemeral_1h_input_tokens` | part that lives 1 hour |
| `output_tokens` / `output` | what the model generated, thinking included |
| `output_tokens_details.thinking_tokens` | how much of the output was thinking |

The single most useful line in this whole document:

> **`cache_read` is the good number. `cache_creation` is the number that costs you.**

Two things that trip people up:

- **Field names differ between harnesses.** pi camelCases them. The raw API
  snake_cases them. Any script must handle both or it silently reads zeros.
- **`cacheWrite1h` is read from `cache_creation.ephemeral_1h_input_tokens`**
  (`pi-ai/dist/api/anthropic-messages.js:466`). A value of `0` means the API
  reported zero one-hour cache tokens, which is a real measurement, not a missing
  field. That is how the 1-hour-versus-5-minute difference was found.

### 3.4 The payload logger

pi's session files record usage but not the request. To see what was actually
sent you need the payload log. It was the shim's debug log when this was
written; since the shim's removal it lives in `extensions/anthropic-sub.ts`:

- `PI_ANTHROPIC_PAYLOAD_LOG` is read on every request
- it writes `{ stage: "after", payload }`, the request as it goes on the wire
- one JSON line after an ISO timestamp, records separated by a line containing
  only `---` (the format `cache-diag.py` reads)

Turn it on for one run:

```bash
PI_ANTHROPIC_PAYLOAD_LOG=/tmp/pi-payload.jsonl pi --provider anthropic --model claude-opus-5-5
```

**It only fires on Anthropic over OAuth.** The gate:

```ts
if (model?.provider !== "anthropic" || !ctx.modelRegistry.isUsingOAuth(model)) return undefined;
```

Run the diagnostic session on grok and you get an empty file and a wasted hour.
This is the single most useful gotcha in the whole playbook.

Size: measured at 236 KB per record, two records per request, so about
**472 KB per request**. 400 requests is roughly 190 MB. Not the multi-gigabyte
monster I first feared. It is still unbounded, so do not leave it on permanently,
and remember the file contains full prompt text including your conversation.

---

## 4. The measuring toolkit

Four scripts, increasing in power. Everything here is copy-pasteable.

### 4.1 The minimal reader

Start here. It answers "is caching working at all".

```python
import json, glob, os

def turns(paths):
    for f in paths:
        prev = None
        for line in open(f, errors="ignore"):
            if '"cacheWrite"' not in line and "cache_creation_input_tokens" not in line:
                continue
            try:
                o = json.loads(line)
            except Exception:
                continue
            m = o.get("message") or {}
            u = m.get("usage") or {}
            if m.get("role") != "assistant" or not u:
                continue
            yield {
                "file": f,
                "model": m.get("model"),
                "in":  u.get("input_tokens", u.get("input", 0)),
                "cr":  u.get("cache_read_input_tokens", u.get("cacheRead", 0)),
                "cw":  u.get("cache_creation_input_tokens", u.get("cacheWrite", 0)),
                "out": u.get("output_tokens", u.get("output", 0)),
            }

T = list(turns(glob.glob(os.path.expanduser("~/.pi/agent/sessions/**/*.jsonl"), recursive=True)))
for r in T:
    r["p"] = r["in"] + r["cr"] + r["cw"]

read  = sum(r["cr"] for r in T)
write = sum(r["cw"] for r in T)
print("turns     :", len(T))
print("hit ratio :", round(read / (read + write), 3) if read + write else 0)
print("write share:", round(write / sum(r["p"] for r in T), 3))
```

Notes on why each line is there:

- the string pre-filter avoids parsing 30,000 lines of JSON
- `try/except` matters because a process killed mid-write leaves a truncated line
- the dual field names are required; see 3.3
- `p` (full prompt) is `input + cache_read + cache_write`. That is the true size
  of what you sent

How to read it:

| hit ratio | meaning |
|---|---|
| above 0.9 | healthy, fast |
| 0.5 to 0.9 | something is breaking occasionally |
| below 0.3 | the conversation is not being cached at all |
| 0.17 measured on the broken setup | catastrophic |

### 4.2 The per-turn table (the single most useful view)

Aggregates tell you how bad. They never tell you what. This tells you what.

```python
import json, glob, os, datetime

def rows(path):
    out = []
    prev = None
    for line in open(path, errors="ignore"):
        if '"cacheWrite"' not in line:
            continue
        try:
            o = json.loads(line)
        except Exception:
            continue
        m = o.get("message") or {}
        u = m.get("usage") or {}
        if m.get("role") != "assistant" or not u:
            continue
        try:
            t = datetime.datetime.fromisoformat(o["timestamp"].replace("Z", "+00:00")).timestamp()
        except Exception:
            continue
        p = u.get("input", 0) + u.get("cacheRead", 0) + u.get("cacheWrite", 0)
        out.append({
            "p": p, "cr": u.get("cacheRead", 0), "cw": u.get("cacheWrite", 0),
            "gap": None if prev is None else t - prev,
        })
        prev = t
    return out

r = rows("/path/to/session.jsonl")
print("   #    prompt     read    write      gap   write%")
for i, x in enumerate(r):
    g = "  --" if x["gap"] is None else "%4.0fs" % x["gap"]
    w = 100 * x["cw"] / x["p"] if x["p"] else 0
    print("%4d %9d %8d %8d %8s   %4.0f%%" % (i, x["p"], x["cr"], x["cw"], g, w))
```

Then read the `read` column, not the `write%` column.

- **`read` climbs as prompt grows** = the cache extends. Working.
- **`read` frozen at one number while prompt grows** = only a fixed head is
  cached and the tail is re-written every turn. Broken.
- **`read` drops to something smaller mid-session** = the prefix changed at that
  point. Find what moved.
- **`read` drops to 0** = the cache was fully invalidated. Usually a model switch,
  which invalidates unconditionally.

### 4.3 Gap analysis (which TTL do you actually need)

This is how the 5-minute-TTL theory was killed.

```python
import collections
big = [x for x in r if x["gap"] is not None and x["p"] > 0 and x["cw"] > 0.5 * x["p"]]
buckets = collections.Counter()
for x in big:
    g = x["gap"]
    buckets["<5m" if g < 300 else "5m-1h" if g < 3600 else ">1h"] += 1
print(dict(buckets))
```

Interpretation: a rewrite with a gap under 5 minutes cannot be TTL expiry. The
cache was still alive. Something changed.

Measured on the broken setup, over 24 hours:

```
<5m      : 325 turns
5m-1h    :   7 turns
>1h      :   1 turn
```

325 of 334 gaps were under 5 minutes. The TTL explained 2% of the damage. See
section 9, mistake 2.

### 4.4 Payload diffing with `cache-diag.py`

The repo has this at `pi-setup/cache-diag.py`. It reads the debug log and prints
one line per request plus the first thing that changed since the previous one.

```
    #  model              system  tools  msgs  rulesDup  changed-vs-previous
    0  claude-sonnet-5-5   62070     39     2         1  -
    1  claude-sonnet-5-5   62070     39     5         1  messages 2 -> 5
    2  claude-sonnet-5-5   62070     39     8         1  messages 5 -> 8
    3  claude-sonnet-5-5   59503     39    11         1  system block[1] changed, messages 8 -> 11
    4  claude-sonnet-5-5   59503     39    14         1  messages 11 -> 14
   ...
   22  claude-sonnet-5-5   59503     39    68         1  messages 65 -> 68
```

Run it:

```bash
python3 pi-setup/cache-diag.py /tmp/pi-payload.jsonl
```

It streams one record at a time, so a large file will not exhaust memory.

How to read it:

- `system` is the character length of system block 1. **A change here is the
  expensive kind.** It invalidates everything.
- `tools` is the tool count. A change here also invalidates from the tools block
  onward.
- `msgs` is the message count. Growth is normal. A *shrink* is not.
- `rulesDup` should read 1 if the behaviour rules are in the system prompt. It
  climbing means duplication.
- `changed-vs-previous` names the first field that differs.

Two real bugs this tool had, worth remembering because both produced false
readings:

1. **The rules marker contained a space where the file has a newline.**
   `rules.amp.md` is hard-wrapped, so the phrase "An edit that is mostly
   commentary" appears across a line break in the rendered file. Counting for it
   with a space returned 0 forever. Fixed by normalising whitespace before
   counting.
2. **pi moves the `cache_control` breakpoint to the last message every turn.**
   Comparing that field made whichever message held the breakpoint last turn look
   "changed", so the tool printed `messages[N] changed` on nearly every row.
   Fixed by stripping `cache_control` recursively before comparison.

Both are the same class of mistake: a comparison that includes a field the
system moves on purpose. If your diff shows changes on almost every row, suspect
the comparison, not the system.

---

## 5. The investigation, in the order it happened

This is the sequence that actually worked. Copy the shape, not the specifics.

### 5.1 Read the code that builds the request, before touching data

I read the Anthropic request builder first:

```
~/.pi/agent/../pi-ai/dist/api/anthropic-messages.js
```

Not the whole file, just the words that matter:

```bash
grep -n "cache_control\|ephemeral\|max_tokens\|thinking\|anthropic-beta" \
  .../pi-ai/dist/api/anthropic-messages.js
```

That surfaced two functions which turned out to be the entire story:

```js
function resolveCacheRetention(cacheRetention, env) {          // :22
    if (cacheRetention) return cacheRetention;
    if (getProviderEnvValue("PI_CACHE_RETENTION", env) === "long") return "long";
    return "short";
}

function getCacheControl(model, cacheRetention, env) {          // :31
    const retention = resolveCacheRetention(cacheRetention, env);
    const ttl = retention === "long" && ... ? "1h" : undefined;
    return { cacheControl: { type: "ephemeral", ...(ttl && { ttl }) } };
}
```

Read that carefully. **The `ttl` field is only ever set when retention is
`"long"`, and retention is only `"long"` when `PI_CACHE_RETENTION=long`.** So
without that variable every cache entry pi writes is the 5-minute tier.

A strong lead. Not proof. Which is why the next step is data.

### 5.2 Find the receipts

Section 3. The specific move that cracked it: **both tools write the same API
usage fields to disk**, on the same machine, for the same account. That is a
controlled experiment you get for free once you notice it.

Three commands in, the comparison already showed the difference:

```
Claude Code: "cache_creation": { "ephemeral_1h_input_tokens": 12323, "ephemeral_5m_input_tokens": 0 }
pi:          "cacheWrite1h": 0
```

Claude Code put 100% of its cache into the 1-hour tier. pi put 0% there. Across
all 324 pi sessions on disk, `cacheWrite1h` was 0.

### 5.3 Aggregate, then go per-turn

Aggregate first to size the problem, then immediately go per-turn to find the
shape. Aggregate output looked like this:

```
turns: 334
prompt total  : 1,289,415
cache READ    : 18,583,688
cache WRITE   : 83,658,669
output        : 677,349
```

99% of the metered tokens were cache writes. That told me the problem was writes,
not volume.

Then the per-turn table, which is where the actual answer lived. The frozen
`read` at 55,016 while the prompt grew to 264k. Aggregate told me the patient was
sick. The per-turn table named the disease.

### 5.4 Test the hypothesis, and let the data kill it

The first theory was cache expiry. It is a good story and it was wrong.

Section 4.3 killed it: 325 of 334 gaps were under 5 minutes. The TTL explained 2%
of the damage. Had I stopped at the good story I would have shipped
`PI_CACHE_RETENTION=long` as the fix and made things worse (section 9, mistake 2).

### 5.5 Trace the surviving mechanism to a line of code

Now knowing something near the top of the request changed on every turn, ask
pi's own source what changes the top of a request:

```bash
grep -rn "restoreSystemMessages" .../pi-coding-agent/dist/
```

That found `dist/core/extensions/runner.js`, whose comment states the rule:

> An unchanged conversation keeps every system message in place, so models with
> mid-conversation support keep their cached prefix. **A changed one gets the
> replayed prompt sections and tool declarations as one leading system message.**

pi was telling me: change the message list and I rebuild the front of the request.
Rebuilding the front is what kills a prefix cache.

Then find which extension changes the list. `grep 'pi.on("context"'` across
`pi-setup/extensions` found it in one call.

Code stated the rule. Data showed the symptom. They matched. That is when the
answer became trustworthy.

### 5.6 Confirm with the payload log

The last step, and the only one that gives byte-level certainty: capture real
requests and diff them. That is section 4.4, and it is what produced the 2,567
character finding in section 10.

---

## 6. The root cause

`pi-setup/extensions/guardrails/index.ts`, old lines 49 to 71:

```ts
pi.on("context", async (event, ctx) => {
    const messages = event.messages.filter(
        (message) => message.customType !== CUSTOM_TYPE,
    );
    return {
        messages: [
            ...messages,
            {
                role: "custom",
                customType: CUSTOM_TYPE,
                content: rules,          // identical text every call
                display: false,
                timestamp: Date.now(),   // different every millisecond
            },
        ],
    };
});
```

Three steps, on every model call, including every tool round-trip inside one user
turn:

1. take the conversation
2. remove the previous rules note
3. append a fresh rules note

The words never changed. So why did it cost anything? Two reasons.

**The list changed shape.** One message out, one message in. pi watches for that
and, by the rule above, rebuilds the front of the request every time.

**`timestamp: Date.now()`.** Even with a stable shape, that field made the note a
different note on every call.

The extension was written for a good reason. From `AGENTS.md`:

> A system prompt stops governing behaviour after roughly eight turns, and
> Anthropic's own tracker has an open bug for Claude ignoring mandatory
> anti-comment rules.

That concern is legitimate. The mistake was *where* the rules were put: into the
message stream, which has to stay byte-stable for caching to work, and then
reshuffled on every call.

Measured cost of that single hook: **83.7 million cache-write tokens in a
24-hour window, 99% of everything metered.**

---

## 7. The fix

Two changes, plus two hardening changes.

### 7.1 Remove the mutating hook

`pi-setup/extensions/guardrails/index.ts` no longer has a `context` hook. The file
is now only the `tool_call` comment gate, which never touches the prompt.

The comment gate was always the free half and it stays:

```ts
pi.on("tool_call", async (event) => {
    if (event.toolName !== GATED_TOOL) return;
    try {
        const verdict = judge(event.input as Record<string, unknown>, thresholds());
        if (verdict.blocked) return { block: true, reason: verdict.reason };
    } catch {
        return;
    }
});
```

Note the second half of that shape: **a gate that cannot decide lets the edit
through.** A guardrail that blocks real work gets switched off permanently, and a
missed essay costs one rewrite. Fail open.

### 7.2 Move the rules into the system prompt

`pi-setup/extensions/system-prompt.ts` now loads the rules once and composes them
into the system prompt at lines 40, 64, 78:

```ts
const rules = readAgentPrompt("rules.amp.md").trim();

const compose = (...parts: (string | undefined)[]) =>
    parts.filter((part): part is string => part.length > 0).join("\n\n");
```

and every return became:

```ts
return { systemPrompt: compose(event.systemPrompt, interpolated, rules) };
```

Same words, delivered on every turn, now sitting in the frozen part of the
request. Written to the cache once, read back free forever.

### 7.3 Freeze `{ls}`

`pi-setup/extensions/tools/lib/interpolate.ts` put a live `readdirSync` of the
workspace root into the system prompt, re-run on every turn. Any file appearing or
disappearing at the repo root changed page one of the stack.

```ts
let listingRoot: string | undefined;
let listingValue = "";

function workspaceListing(root: string): string {
    if (listingRoot === root) return listingValue;
    listingRoot = root;
    try {
        listingValue = fs.readdirSync(root).map((e) => {
            const full = path.join(root, e);
            try { return fs.statSync(full).isDirectory() ? `${full}/` : full; } catch { return full; }
        }).join("\n");
    } catch {
        listingValue = "";
    }
    return listingValue;
}
```

Scale check, honestly: this lists only the repo **root**, not subdirectories, so
working inside `pi-setup/` does not move it. Real but small. I never measured its
individual contribution.

### 7.4 Why not switch the system prompt to section diffing

pi has a section-diffing path (`diffSystemPromptSections`,
`recordSection`/`forgetAllSections` in `dist/core/agent-session.js`). Returning
`{ systemPrompt }` from `before_agent_start` sets `forceSystemPrompt`, which
collapses all system messages into one head (`_installAgentForcedPromptProjection`,
`agent-session.js:1310-1324`).

I did not switch to section diffing, because the text is now stable and a stable
forced head caches identically. Changing it would be churn with real risk and no
measured benefit.

---

## 8. Verification: before and after in numbers

Same metric, same account, same machine.

### Before (broken)

One session, 40 turns, claude-opus-5:

```
prompt total  : 56,551,060
cache READ    :  9,460,816   (17%)
cache WRITE   : 47,089,528   (83%)
read behaviour: frozen at 55,016 while prompt grew 60k -> 264k
```

24-hour window:

```
turns          : 334
cache WRITE    : 83,658,669
cache READ     : 18,583,688
output         : 677,349
input          : 1,336
avg prompt     : 306,118 per turn
```

Per-turn write share climbed with every turn and never recovered: 45%, 46%, 56%,
59%, 65%, 71%, 73%, 75%, 75%, 76%.

### After (fixed)

One session, 18 assistant turns, 4 user turns, claude-sonnet-5-5, 17 tool calls:

```
prompt total  : 1,289,415
cache READ    : 1,154,995   (89.6%)
cache WRITE   :    134,376  (10.4%)
output        :     17,555
HIT RATIO     : 0.896
read growth   : 42,866  ->  104,464
```

Per-turn, warm turns ran 1% to 19%, mostly 2% to 7%, and `read` climbed with the
prompt the whole way.

### The proof that does not depend on session length

The honest objection is that the old session ran 40 turns and the new one 18, and
write share grows with length when a cache is broken. Fair. So here is an argument
that does not use the percentages at all:

> At turn 2 the read was **42,750**. The cold start at turn 0 wrote **41,325**.
>
> Under the old behaviour, `read` was pinned to the size of the fixed head and
> could never exceed it. That is exactly what "frozen at 55,016" meant. Read
> exceeding the head is **mechanically impossible** under the old behaviour.

A working cache reads the previous turn's entire prompt, which grows. A broken one
reads a fixed head forever. That difference is binary, not statistical, and it
does not care how many turns the session ran.

### The system prompt held

After the one-time drop at request 3, the system prompt stayed at 59,503 characters
for the following 20 consecutive requests. `rulesDup` read 1 on all 23 captured
requests, so the rules are present exactly once and not duplicating.

---

## 9. Every mistake I made and the lesson

This is the section to read before doing this again. All six of these cost time.

### Mistake 1: asserting a 200k context cap from a grep

**What I said.** pi never sends the `context-1m-2025-08-07` beta, so those models
cap at 200k through pi, and `AGENTS.md` claiming 1M is wrong.

**What was true.** pi does not send that beta. It does not need to. Anthropic's
current context-windows doc says: "For every model with a 1M-token context window,
1M is the default: you don't need a beta header, and long-context requests are
billed at standard pricing." pi's own catalog lists
`claude-opus-5-5` and `claude-sonnet-5-5` at `contextWindow: 1000000`.

**How I got it wrong.** I inferred a capability limit from the presence of a
legacy constant in a minified binary, instead of reading the catalog that pi
actually uses.

**Lesson.** A leftover constant is evidence that something *existed*, never that
it is *required*. Check the primary source: the config file the program reads.

### Mistake 2: promoting a real observation to the cause

**What I said.** The 5-minute versus 1-hour cache tier is the whole story, and
`PI_CACHE_RETENTION=long` is the fix.

**What was true.** The tier difference is real and measured. It explained **2%**
of the damage: 7 turns out of 334 had a gap long enough for expiry to matter, and
only 2,082,552 of 101,208,940 re-written tokens sat in a 5m-1h gap.

**How I got it wrong.** I found a real difference between the two programs and
then assumed it was the difference that mattered, without checking whether the
preconditions for it were present in the actual data. The preconditions were
measurable in one command (section 4.3). I ran that command *after* telling the
user the TTL was the fix.

**Lesson.** A real difference is not a cause. Before naming a cause, measure the
magnitude of its effect in your own data. And if a fix sounds satisfying, that is
a reason to test it harder, not less.

**The economic detail that makes this worse.** With the broken cache, writes were
99% of the meter. Switching those writes to the 1-hour tier at 2x the per-token
cost would have raised the bill from roughly $418 to $669 in the same window,
while saving about $10. The "fix" would have made things materially worse. That is
only visible if you compute it.

### Mistake 3: a broken marker string that returned a confident zero

**What I reported.** `rulesDup: 0` on every request, meaning the rules were not in
the system prompt, which I flagged as a risk my own fix had created.

**What was true.** The marker `"An edit that is mostly commentary"` contains a
space. `rules.amp.md` is hard-wrapped, so the rendered text has a newline there.
Counting with a space returned 0 always. Corrected, it read **1** on every
request.

**Lesson.** A check that returns the same value in every case is not measuring
anything. When a metric is suspiciously uniform, suspect the metric. Here the
tell was that it read 0 on *every single request*, including ones that should
have been unaffected.

### Mistake 4: trusting a `ps` environment read without a control

**What I did.** Ran `ps -Eww -p <pid>` on the pi process in a tmux pane, grepped
for the log variable, found nothing, and started to conclude the logger was not
enabled.

**Why it was wrong.** I never confirmed the method worked on that process. It
did: I added a control test grepping for `PATH=` on my own shell and found it,
but grepping `PATH=` on the pane's processes found **0** there too. So `ps -E`
simply would not report environment for anything in that pane, and the absence of
the variable proved nothing.

**Compounding bug.** The line was `... | grep X | sed ... || echo "missing"`. The
`||` fires on the exit status of the **last** command in the pipeline, which is
`sed`, which exits 0 on empty input. So the fallback never printed, and "no
output" was ambiguous rather than being a finding.

**Lesson.** Before trusting a negative result from a tool, make the tool prove it
can produce a positive one. A control test costs one command. Also: in a pipeline,
`a | b | c || echo` reports `c`'s status, not `a`'s.

### Mistake 5: a broken-comparison audit script that produced a false alarm

**What I did.** Wrote a shell loop to find files the repo does not own, comparing
a *relative* path from inside the target directory. Every file resolved against
the wrong base, so every file was reported as live-only. Thousands of false
positives, presented as a risk to the user's skills folder.

**What was true.** Corrected with absolute paths: extensions had exactly **1**
live-only file, and themes/agents/skills had **zero**.

**Lesson.** The user had explicitly asked for "no false alarm landmines, only real
ones". A comparison against the wrong base path produces exactly the alarm they
asked me not to produce. When a result says "everything is wrong", the result is
wrong. Sanity-check the shape of the output before believing the content.

### Mistake 6: overestimating the log size by an order of magnitude

**What I said.** The payload log could reach "hundreds of MB to GBs".

**What was true.** Measured: 8,499,949 bytes over 36 records = 236 KB per record,
about **472 KB per request**. Even 400 requests is roughly 190 MB.

**Lesson.** I scaled a number I had not measured and then warned about it. Label an
estimate as an estimate, or measure it. It was measurable with `ls -la`.

### The meta-lesson

Notice the pattern across all six: **every mistake was a confident statement made
before the check that would have settled it.** Not one of them was a reasoning
error. They were ordering errors.

The fix is mechanical, not intellectual: for every claim, ask "what single command
would falsify this", and run it first.

And note what the method did catch. Mistake 2 was caught by the method itself,
within minutes, because the gap analysis was already written down as a step. The
1M mistake was caught by the user pushing back and me checking the catalog. The
marker and cache_control bugs were caught by the corrected output looking wrong.
The method is not a guarantee. It is a faster loop for being wrong.

---

## 10. Secondary finding: the system prompt losing 2,567 characters

Found only because the payload log existed. Would not have been visible in any
usage statistic.

### The measurement

```
system block[1] length, requests 0..22:
62012, 62012, 62012, 59445, 59445, 59445, 59445, ... (stable at 59445)
```

One change, at request 3, permanent after. That single edit is the entire 58%
write at that turn and the read falling 43,546 -> 19,486.

### What the 14 removed lines were

```
- Call init_experiment exactly once at the start of an autoresearch session...
- If the session log (.auto/log.jsonl) already exists with a config, do NOT call init_experiment again.
- Always call log_experiment after run_experiment to record the result.
- log_experiment automatically runs git add -A && git commit on 'keep'...
  ... (14 lines total)
  Be concise in your responses
```

### The mechanism

Those lines are `promptGuidelines` entries on the gated tools registered by
`pi-autoresearch`.

- `~/.pi/agent/git/github.com/davebcn87/pi-autoresearch/extensions/pi-autoresearch/index.ts:1573`
  (and `:1692`, `:2208`) carry `promptSnippet` and `promptGuidelines`
- `index.ts:1094-1107` gates them:

```js
// Registering through this gates the tool, so a new one can't slip in ungated.
const gatedToolNames = new Set<string>();
const registerGatedTool = (tool) => { gatedToolNames.add(tool.name); pi.registerTool(tool); };

// The one place mode flips: gated tools follow the flag, never drifting from it.
const setAutoresearchMode = (ctx, enabled) => {
  getRuntime(ctx).autoresearchMode = enabled;
  const activeTools = new Set(pi.getActiveTools());
  for (const tool of gatedToolNames) { enabled ? activeTools.add(tool) : activeTools.delete(tool); }
  pi.setActiveTools([...activeTools]);
};
```

- pi core filters tool snippets by hidden declarations
  (`dist/core/agent-session.js:1238`, `:1270`) and drops a tool whose exposure is
  `"hidden"` (`:1122-1124`)

So the chain: the tools carry the guidelines, pi renders them into the system
prompt, and when the gated tools left the active set their guidelines left the
prompt.

### The activation rule, and why it cannot be a setting

`shouldAutoActivateAutoresearch` (`index.ts:521-534`):

```js
if (!hasPersistedLog) return false;              // needs .auto/log.jsonl to exist
if (recordedDecision !== null) return recordedDecision;  // a recorded /autoresearch on|off wins
return samePath(ctxCwd, workDir);                // otherwise same-cwd sessions default ON
```

There is no config knob. So the only reliable way to keep it off is to stop
loading it. It was removed from `packages` in `pi-setup/settings.json` and
`pi-setup/install.sh`.

### Why this one cannot be "fixed"

The text is **conditionally present** inside the cacheable prefix. Its presence is
a runtime flag plus a file-existence check.

> "It never drops" and "the flag can change mid-session" are mutually exclusive.

Any toggle rewrites the system prompt at character ~4,204, which invalidates
everything behind it. That is prefix caching working as designed, applied to a
feature that changes its own inputs.

You can only make the condition constant:

| | system prompt | drops |
|---|---|---|
| never enable autoresearch | 59,445 every request | 0 |
| enable it and leave it on | 62,012 every request | 0 |

The only thing that drops is toggling. That is why the fix is "do not toggle it",
and why removing the package is the honest answer.

### The cost of the one flip we saw

```
2,567 chars removed -> one full prefix re-write of 27,099 tokens
27,099 / 1,000,000 x $5 = $0.135
```

About **fourteen cents, once per session**. Against the 83,658,669 cache-write
tokens the main bug was costing, that is 0.03%. Worth removing because it is easy,
not worth chasing with a code change.

### Ruled out as a cause

I suspected my own `defaultTools: ["+codemode"]` change caused it. Wrong.
`prepareCodemodeLoadout` returns `hiddenDeclarations: []` whenever the mode is
`on` (`dist/extensions/codemode/tool.js:230-232`), and the mode is `on`, so
codemode hides nothing. Cleared by reading the code.

---

## 11. Other landmines found

### `install.sh` had five recursive deletes

Old lines 96, 109, 116, 123, 130, each shaped like:

```bash
backup_if_exists "$TARGET"
rm -rf "$TARGET"
cp -R "$SOURCE" "$TARGET"
```

The `rm -rf` destroys anything in the target the repo does not own.

**What it would actually have destroyed, measured with correct absolute paths:**

| target | live files | live-only |
|---|---|---|
| `~/.pi/agent/extensions` | 43,184 | **1** |
| `~/.pi/agent/themes` | 4 | 0 |
| `~/.pi/agent/agents` | 11 | 0 |
| `~/.pi/agent/skills` | 0 | 0 |
| `~/.config/agents/skills` | 65 | 0 |

The one file was `herdr-agent-state.ts`, installed by an external tool called
herdr (`HERDR_INTEGRATION_ID=pi`, version 9), not present in the repo or in git
history. Every `install.sh` run would have deleted it silently.

**Fixed** by replacing the five pairs with a `sync_dir` helper that copies the
repo tree over the target, overwrites same-named files, adds new ones, and
**reports** files the repo does not own instead of deleting them. Verified with a
sandbox dry run that a not-owned file survives while the repo file still lands.

Tradeoff, named: an extension deleted *from the repo* now stays live and gets
reported rather than removed. That is the safe direction.

One targeted `rm -f "$PI_AGENT/mcp.json"` remains on purpose. That file makes the
MCP adapter double-load servers, so its removal is deliberate and names exactly
one file.

### The skill of spotting this class

A destructive script is dangerous in proportion to how much it deletes that it did
not create. `rm -rf` on a directory you fully own is fine. `rm -rf` on a directory
the user also writes to is a landmine. The test: can every file in that directory
be regenerated from the repo? If not, do not delete the directory.

---

## 12. Codemode: an honest assessment

### What it is

A pi tool that lets the model write a JavaScript script which calls the other
tools. Only the script's output reaches the model. Scripts run in a QuickJS
sandbox with no filesystem, network, or timers; they reach the outside world only
through `tools.<name>(args)` and `models`.

Enabled with `{"defaultTools": ["+codemode"]}` — verified against
`docs/cli.md:148-162` and `docs/settings.md:40,46`, which state that a list of
only `+name`/`-name` entries modifies the inherited selection rather than
replacing it. `/reload` enables a newly added default tool without a full restart
(`settings.md:56`).

### What it measured in a real session

| | value |
|---|---|
| schema cost on the wire | 1,264 chars, **~316 tokens** (in the cached prefix) |
| calls | 10 |
| result volume | 88,007 chars |
| direct `bash` for comparison | 14 calls, 53,407 chars, avg 3,814 |
| **script source the model wrote** | **10,883 chars, ~2,721 output tokens** |

At Sonnet 5.5 output rates ($10/MTok): `2,721 / 1,000,000 x $10 = $0.027`.

### The honest verdict

**It saved nothing in that session and cost about 2.7 cents.** Codemode results
averaged 8,800 chars per call against 3,814 for direct bash, so per call *more*
context entered. The script source was roughly 3.4x the JSON arguments it
replaced.

The reason is visible in the scripts. Script 1:

```js
const run = async (cmd) => await tools.bash({cmd, timeout: 30});
const [log, status, todo, docs] = await Promise.all([...]);
return {log, status, todo, docs};
```

**That `return` sends the raw output of four commands straight through with no
filtering.** So the context cost equals four batched bash calls, plus the script
you had to write.

Codemode has exactly one mechanism for saving tokens: the return value being much
smaller than the data read.

### How to use it so it actually pays

- **Return the answer, not the data.** `return { count: hits.length, files: [...new Set(hits.map(h => h.file))] }`, never the grep text.
- **Filter before returning.** `lines.filter(l => !l.includes("node_modules")).slice(0, 10)`
- **Use it where you need a conclusion from many reads.** "Which of these 40 files import X" should return six filenames.
- **Its unambiguous win is round trips and wall clock.** From the three scripts sampled, each made 4 `run()` calls, so on the order of 40 internal executions collapsed into 10 results. That is latency and turn count, not tokens.

### Where it actually fits

It is a leverage tool, not a discount. It pays when the return value is much
smaller than what was read. When the return value *is* the data, you have paid 316
schema tokens and about a thousand characters of script for nicer syntax.

The same discipline as reading with `grep` instead of dumping a whole file into
context. Codemode just makes it possible to do that across many files at once.

---

## 13. Reference: exact commands

### Turn the payload logger on for one run

```bash
PI_ANTHROPIC_PAYLOAD_LOG=/tmp/pi-payload.jsonl pi --provider anthropic --model claude-opus-5-5
```

Must be Anthropic over OAuth (the gate in `extensions/anthropic-sub.ts`).

### Analyse a capture

```bash
python3 pi-setup/cache-diag.py /tmp/pi-payload.jsonl
```

### Check current cache health across all sessions

```bash
python3 - <<'EOF'
import json, glob, os
rows = []
for f in glob.glob(os.path.expanduser("~/.pi/agent/sessions/**/*.jsonl"), recursive=True):
    for line in open(f, errors="ignore"):
        if '"cacheWrite"' not in line:
            continue
        try: o = json.loads(line)
        except Exception: continue
        m = o.get("message") or {}; u = m.get("usage") or {}
        if m.get("role") != "assistant" or not u: continue
        rows.append((u.get("cacheRead", 0), u.get("cacheWrite", 0)))
read = sum(r[0] for r in rows); write = sum(r[1] for r in rows)
print("turns:", len(rows), " hit ratio:", round(read / (read + write), 3) if read + write else 0)
EOF
```

### Verify the deployed patches are in place

```bash
bash pi-setup/verify-patches.sh
```

### Check which extension is mutating the prompt

```bash
grep -rn 'pi.on("context"' ~/.pi/agent/extensions pi-setup/extensions
grep -rln "before_agent_start" ~/.pi/agent/npm/node_modules ~/.pi/agent/git
```

Anything that hooks `before_agent_start` and returns a `systemPrompt`, or that
hooks `context` and returns a changed list, is a cache risk. The test for the
second: does it early-return when it has nothing to say? If not, it mutates on
every call.

### Compare against Claude Code on the same account

```bash
ls ~/.claude/projects/
```

Its session files carry the same usage fields. Useful as a control when you are
unsure whether a number is bad or normal.

---

## 14. Cheat sheet

### Diagnosing "usage is draining too fast"

1. Find the receipts (`~/.pi/agent/sessions/`). Do not theorise first.
2. Compute the hit ratio. Below 0.3 means the conversation is not cached at all.
3. Print the per-turn table. **Look at the `read` column, not `write%`.**
   - climbing = healthy
   - frozen while prompt grows = only the head is cached
   - dropping mid-session = something changed the prefix at that point
   - dropping to 0 = full invalidation, usually a model switch
4. If a break exists, find *what* moved. `grep -rn 'pi.on("context"'` on your extensions is the first place to look.
5. Only if the per-turn view is clean, consider TTL. Run the gap analysis before believing it.

### The three fingerprints

| fingerprint | meaning |
|---|---|
| `read` frozen at a constant | fixed head cached, tail re-written every turn |
| `read` climbing with prompt | working |
| `write%` climbing with turn number and never recovering | broken, and getting worse |

### Rules of thumb

- Anything that appears or disappears inside the cached prefix costs a full
  re-write. Conditional guidance belongs in a new message at the tail, or in
  nothing at all.
- A `context` hook that returns a changed list makes pi rebuild the front of the
  request. Always early-return when you have nothing to add.
- `timestamp: Date.now()` in anything that reaches the wire is a cache bomb.
- Cache reads are the good number. Cache writes are the cost. Optimise writes.
- Once caching works, static overhead in the prefix is nearly free. Do not delete
  packages expecting savings.
- Never enable a 1-hour TTL to fix a problem caused by per-turn rewrites. It
  multiplies the thing that is already broken.

### Before believing any diagnosis

Ask: what single command would falsify this? Run it first.

---

## 15. Glossary

**Prefill.** Computing the key and value vectors for the input tokens. Parallel and
compute-bound. This is where a cache write happens.

**Decode.** Generating output tokens one at a time, each attend over all previous
KV. Sequential and memory-bandwidth-bound. This is where output tokens come from.

**KV cache.** The stored key/value vectors for a prefix. Prompt caching is a
server-side KV cache keyed by the exact prefix bytes.

**Causal attention.** Token N attends only to tokens 1..N. This is why a change at
position 3 invalidates KV from position 3 onward, and therefore why caching is
prefix-only. See 2.2.

**Cache write.** Computing KV for the tokens after the cached prefix and storing
it. Costs 1.25x base input for the 5-minute tier, 2x for the 1-hour tier.

**Cache read.** Loading KV that already exists. Costs about 5% of base input, so
20x cheaper than a write and 25x cheaper than a fresh write.

**Cache breakpoint.** The `cache_control` marker that tells Anthropic where to
store. pi places them on the OAuth identity block, the system text, the last tool,
and the last user or system content block
(`pi-ai/dist/api/anthropic-messages.js:1175-1199`, `:1281`). Anthropic allows four.

**TTL.** Time to live. 5 minutes for the default ephemeral tier, 1 hour when
requested. A read after expiry is a miss and re-charges the whole prefix.

**Hit ratio.** `cache_read / (cache_read + cache_creation)`. Healthy above 0.9.

**Prefix.** Everything from the first byte up to a breakpoint. The only thing a
cache can match.

**System prompt.** The first block of the request. Changing it invalidates
everything after it. The most expensive place to change anything.

**Tool schema.** The JSON declaration of a tool. Lives in the cached prefix with
the system prompt. Costs once per session, not per turn.

**`prepareLoadout`.** A pi tool-definition hook that can rewrite tool descriptions
and hide declarations from requests. Only codemode implements it, and it hides
nothing in the default `"on"` mode
(`dist/extensions/codemode/tool.js:230-232`).

**`forceSystemPrompt`.** What pi does when a `before_agent_start` handler returns
`{ systemPrompt }`: it collapses all system messages into one head for that
request (`dist/core/agent-session.js:1310-1324`).

**Metered token.** Something the subscription limit counts. Unclear weights, but
community probes suggest cache reads are ~free and cache writes cost about 1x
uncached input. See 2.4.

---

## 16. Still open / not verified

Things I could not establish. Do not treat them as settled.

1. **Which of the six `setAutoresearchMode` call sites** (`index.ts:1386, 1645,
   2473, 3002, 3049, 3090`) flipped the mode off at the second user turn. I have
   the one flipping function and all its callers, not the trigger.
2. **Why the autoresearch tools' guidelines were in the system prompt at all**
   while the tools themselves were never in the wire `tools` array across 18
   requests. Both facts are measured; the connection between them is not.
3. **Whether `pi-tool-display/src/thinking-label.ts` and
   `pi-codex-goal/src/goal-runtime-events.ts`** can mutate the prompt mid-session.
   Both register `context` hooks. Neither produced a break across 23 captured
   requests, so they either early-return or only fire on state change. Inferred,
   not read line by line.
4. **The individual contribution of the `{ls}` memoisation.** Measured in the code,
   never isolated by experiment.
5. **Whether `apply_patch` shadows pi's built-in `edit` and `write` schemas.**
   pi still registers `DEFAULT_TOOL_NAMES = ["read","bash","edit","write"]` and
   `apply_patch` does not shadow those names, so those two schemas may still be on
   the wire alongside it. Not resolved.
6. **Official cache-read and cache-write weights for the Max meter.** Anthropic
   publishes none. The ~free-reads finding is community measurement.
7. **The exact token counts for the system prompt.** All figures here are
   chars/4 or chars/3.6 estimates, not provider-reported tokens.

---

## 17. File and line index

### pi core (`/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent`)

| what | where |
|---|---|
| cache retention default (`short` unless `PI_CACHE_RETENTION=long`) | `node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js:22-30` |
| where `ttl: "1h"` is set | same file, `:31-41` |
| `cacheWrite1h` read from the API field | same file, `:466` |
| which beta headers pi can send | same file, `:820-856` |
| cache breakpoint on the last user/system block | same file, `:1175-1199` |
| cache breakpoint on the last tool | same file, `:1281` |
| `restoreSystemMessages` and the cache-prefix rule | `dist/core/extensions/runner.js:93-105` |
| `prepareLoadout` execution, tool exposure filter | `dist/core/agent-session.js:1118-1170` |
| `_hiddenDeclarations` assignment | `dist/core/agent-session.js:1164` |
| tool snippet filters | `dist/core/agent-session.js:1238`, `:1270` |
| forced-prompt projection | `dist/core/agent-session.js:1310-1324` |
| codemode loadout, `hiddenDeclarations` only in `"only"` mode | `dist/extensions/codemode/tool.js:204-234` |
| codemode registers `prepareLoadout` | `dist/extensions/codemode/tool.js:246` |
| `PI_CACHE_RETENTION` documented | `docs/environment-variables.md:87` |
| `defaultTools` semantics | `docs/settings.md:40`, `:44`, `:46`, `:56` |
| enabling codemode | `docs/cli.md:148-162` |
| codemode inline budget, 3000 tokens | `docs/codemode.md:49` |

### The payload logger (`pi-setup/extensions/anthropic-sub.ts`, replaced the shim)

| what | where |
|---|---|
| log path, read per request | `PI_ANTHROPIC_PAYLOAD_LOG` |
| Anthropic + OAuth gate | the `before_provider_request` handler |
| writes `stage: "after"` | `writePayloadLog` |

### pi-autoresearch (`~/.pi/agent/git/github.com/davebcn87/pi-autoresearch`)

| what | where |
|---|---|
| auto-activation rule | `extensions/pi-autoresearch/index.ts:521-534` |
| gated tool registration, the one mode flip | `extensions/pi-autoresearch/index.ts:1094-1107` |
| `before_agent_start` returning `systemPrompt` | `extensions/pi-autoresearch/index.ts:1524`, `:1560` |
| tool `promptSnippet` / `promptGuidelines` | `extensions/pi-autoresearch/index.ts:1573`, `:1692`, `:2208` |

### The repo

| what | where |
|---|---|
| the removed `context` hook (old) | `pi-setup/extensions/guardrails/index.ts:49-71` |
| the surviving comment gate | `pi-setup/extensions/guardrails/index.ts:73-87` |
| rules composed into the system prompt | `pi-setup/extensions/system-prompt.ts:40`, `:64`, `:78` |
| `{ls}` memoisation | `pi-setup/extensions/tools/lib/interpolate.ts:51-65`, `:79` |
| `sync_dir` replacing the recursive deletes | `pi-setup/install.sh:55`, used at `:116`, `:127`, `:132`, `:137`, `:142` |
| payload diffing tool | `pi-setup/cache-diag.py` |

---

## Appendix: the one-paragraph version

pi was re-writing the entire conversation into the prompt cache on every turn
because an extension called `guardrails` re-appended the behaviour rules to the
message list on every model call, and pi rebuilds the front of the request
whenever the message list changes. Since the cache can only match a byte-identical
prefix, and the system prompt is the first thing in the request, that rebuild
threw away every cached token behind it. The fix was to move the rules into the
system prompt where they are written once and read back free, and to stop the
`{ls}` directory listing from being re-read every turn. The hit ratio went from
0.17 to 0.90. The way to find this was to read the API's own `usage` object out of
the session logs rather than reasoning about it: the dead giveaway was
`cache_read` sitting frozen at 55,016 tokens while the prompt grew from 60k to
264k, which means only a fixed head was ever cached.
