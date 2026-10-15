#!/usr/bin/env python3
"""Diff consecutive pi payloads captured by PI_ANTHROPIC_PAYLOAD_LOG (anthropic-sub).

    PI_ANTHROPIC_PAYLOAD_LOG=/tmp/pi-payload.jsonl pi
    python3 pi-setup/cache-diag.py /tmp/pi-payload.jsonl
"""
import json
import sys

RULES_MARK = "An edit that is mostly commentary"


def count_rules(text):
    # the rules file is hard-wrapped, so the marker spans a newline
    return " ".join(text.split()).count(RULES_MARK)

def parse(buf):
    if not buf:
        return None
    try:
        return buf[0].strip(), json.loads("".join(buf[1:]))
    except Exception:
        return None


def records(path):
    buf = []
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            if line.strip() == "---":
                rec = parse(buf)
                buf = []
                if rec:
                    yield rec
                continue
            buf.append(line)
    rec = parse(buf)
    if rec:
        yield rec


def system_text(payload):
    s = payload.get("system")
    if isinstance(s, str):
        return s
    if isinstance(s, list):
        return "\n".join(b.get("text", "") for b in s if isinstance(b, dict))
    return ""


def blocks(payload):
    s = payload.get("system")
    if isinstance(s, str):
        return [{"type": "text", "text": s}]
    return s or []


def strip_cache_control(value):
    if isinstance(value, dict):
        return {k: strip_cache_control(v) for k, v in value.items() if k != "cache_control"}
    if isinstance(value, list):
        return [strip_cache_control(v) for v in value]
    return value


def same(a, b):
    return json.dumps(strip_cache_control(a), sort_keys=True) == json.dumps(strip_cache_control(b), sort_keys=True)


def first_diffs(a, b):
    out = []
    for key in ("model", "max_tokens", "thinking", "tool_choice", "betas"):
        if not same(a.get(key), b.get(key)):
            out.append(key + " changed")
    xa, xb = blocks(a), blocks(b)
    if len(xa) != len(xb):
        out.append("system blocks %d -> %d" % (len(xa), len(xb)))
    else:
        for i, (x, y) in enumerate(zip(xa, xb)):
            if not same(x, y):
                out.append("system block[%d] changed" % i)
                break
    for key in ("tools", "messages"):
        ya, yb = a.get(key) or [], b.get(key) or []
        if len(ya) != len(yb):
            out.append("%s %d -> %d" % (key, len(ya), len(yb)))
        for i in range(min(len(ya), len(yb))):
            if not same(ya[i], yb[i]):
                label = yb[i].get("name") or yb[i].get("role") or "?"
                out.append("%s[%d] changed (%s)" % (key, i, label))
                break
    return out


def main():
    path = sys.argv[1]
    print("file:", path)
    print("    #  model                 system  tools  msgs  rulesDup  changed-vs-previous")
    prev = None
    n = 0
    for _, rec in records(path):
        if rec.get("stage") != "after":
            continue
        p = rec.get("payload") or {}
        text = system_text(p)
        diff = "-" if prev is None else (", ".join(first_diffs(prev, p)) or "identical")
        print("  %4d  %-20s %7d %6d %5d %9d  %s" % (
            n, str(p.get("model"))[:20], len(text), len(p.get("tools") or []),
            len(p.get("messages") or []), count_rules(text), diff))
        prev = p
        n += 1
    print("final payloads captured:", n)


if __name__ == "__main__":
    main()
