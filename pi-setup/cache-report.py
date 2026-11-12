#!/usr/bin/env python3
"""How pi's Claude sessions used the prompt cache: what was rebuilt after the cache
expired, what the gap was, the 1h share of writes, cache warms and compactions.

    python3 pi-setup/cache-report.py                 # the last 7 days, main sessions and sub-agents
    python3 pi-setup/cache-report.py --since 2026-10-20
"""
import argparse
import collections
import datetime
import glob
import json
import os

FIVE_MINUTES = 300
ONE_HOUR = 3600


def parse_time(value):
    try:
        return datetime.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except (AttributeError, ValueError):
        return None


def read_session(path, since):
    turns, warms, compactions = [], [], []
    previous = None
    woken_by = None
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            if '"cacheWrite"' not in line and '"compaction"' not in line and '"agent-result"' not in line and '"bash-job"' not in line:
                continue
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            at = parse_time(entry.get("timestamp"))
            if at is None or at < since:
                continue
            if entry.get("type") == "compaction":
                compactions.append({"tokens": entry.get("tokensBefore") or 0, "capture": (entry.get("details") or {}).get("fromCapture")})
                continue
            if entry.get("type") == "custom_message" and entry.get("customType") in ("agent-result", "bash-job"):
                woken_by = "a background agent" if entry.get("customType") == "agent-result" else "a background bash job"
                continue
            if entry.get("type") == "usage" and entry.get("kind") == "cache_warm":
                warms.append(entry.get("usage") or {})
                continue
            if entry.get("type") == "custom" and entry.get("customType") == "cache-ping":
                warms.append((entry.get("data") or {}).get("usage") or {})
                continue
            message = entry.get("message") or {}
            usage = message.get("usage") or {}
            if message.get("role") != "assistant" or message.get("provider") != "anthropic" or not usage:
                continue
            tools = [block.get("name") for block in message.get("content") or [] if isinstance(block, dict) and block.get("type") == "toolCall"]
            turn = {
                "at": at,
                "prompt": usage.get("input", 0) + usage.get("cacheRead", 0) + usage.get("cacheWrite", 0),
                "read": usage.get("cacheRead", 0),
                "write": usage.get("cacheWrite", 0),
                "write1h": usage.get("cacheWrite1h", 0) or 0,
                "gap": None if previous is None else at - previous["at"],
                "waited_on": None if previous is None else ("+".join(sorted(set(previous["tools"]))) if previous["stop"] == "toolUse" else woken_by or "you"),
                "stop": message.get("stopReason"),
                "tools": tools,
            }
            turns.append(turn)
            previous = turn
            woken_by = None
    return turns, warms, compactions


def band(gap):
    if gap < FIVE_MINUTES:
        return "under 5 min"
    if gap < ONE_HOUR:
        return "5 min - 1 h"
    return "over 1 h"


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--since", help="ISO date, default 7 days ago")
    parser.add_argument("--sessions", nargs="+", default=[os.path.expanduser("~/.pi/agent/sessions"), os.path.expanduser("~/.pi/agent/sessions-sub")])
    parser.add_argument("--prefix-log", default=os.path.expanduser("~/.pi/agent/cache/prefix-breaks.jsonl"))
    args = parser.parse_args()
    if args.since:
        since = datetime.datetime.fromisoformat(args.since).replace(tzinfo=datetime.timezone.utc).timestamp()
    else:
        since = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=7)).timestamp()

    turns, warms, compactions, sessions = [], [], [], 0
    for path in (p for root in args.sessions for p in glob.glob(os.path.join(root, "**", "*.jsonl"), recursive=True)):
        if os.path.getmtime(path) < since:
            continue
        t, w, c = read_session(path, since)
        sessions += bool(t)
        turns += t
        warms += w
        compactions += c

    if not turns:
        print("no Claude turns in that window")
        return

    read = sum(t["read"] for t in turns)
    write = sum(t["write"] for t in turns)
    write1h = sum(t["write1h"] for t in turns)
    print(f"{sessions} sessions, {len(turns)} Claude turns since {datetime.datetime.fromtimestamp(since):%Y-%m-%d %H:%M}")
    print(f"cache read  {read:>15,}")
    print(f"cache write {write:>15,}   1h share {write1h / write:.0%}" if write else "cache write 0")
    print(f"hit ratio   {read / (read + write):.3f}" if read + write else "hit ratio   n/a")

    # a turn that re-wrote most of its prompt after a gap the cache could have expired in
    rebuilds = [t for t in turns if t["gap"] is not None and t["gap"] >= FIVE_MINUTES and t["prompt"] and t["write"] > 0.5 * t["prompt"]]
    print(f"\nrebuilds after a gap of 5 min or more: {len(rebuilds)} turns, {sum(t['write'] for t in rebuilds):,} tokens written")
    by_band = collections.defaultdict(lambda: [0, 0])
    by_wait = collections.defaultdict(lambda: [0, 0])
    for t in rebuilds:
        by_band[band(t["gap"])][0] += 1
        by_band[band(t["gap"])][1] += t["write"]
        by_wait[t["waited_on"]][0] += 1
        by_wait[t["waited_on"]][1] += t["write"]
    for name in ("5 min - 1 h", "over 1 h"):
        n, w = by_band[name]
        print(f"  gap {name:<12} {n:>5} turns {w:>14,} tokens")
    print("  what the gap waited on:")
    for name, (n, w) in sorted(by_wait.items(), key=lambda item: -item[1][1])[:8]:
        print(f"    {name[:34]:<34} {n:>5} turns {w:>14,} tokens")

    breaks = [t for t in turns if t["gap"] is not None and t["gap"] < FIVE_MINUTES and t["prompt"] > 20000 and t["write"] > 0.5 * t["prompt"]]
    print(f"\nrebuilds with a gap under 5 min (the prefix changed, not the TTL): {len(breaks)} turns, {sum(t['write'] for t in breaks):,} tokens")
    changed = collections.Counter()
    try:
        with open(args.prefix_log, encoding="utf-8") as fh:
            for line in fh:
                try:
                    record = json.loads(line)
                except ValueError:
                    continue
                at = parse_time(record.get("at"))
                if at is not None and at >= since:
                    changed[record.get("part") if record.get("part") != "message" else f"a {record.get('role') or 'message'} message"] += 1
    except OSError:
        pass
    if changed:
        print("  what changed first (prefix-breaks.jsonl): " + ", ".join(f"{name} {n}" for name, n in changed.most_common()))

    print(f"\nkeep-alive reads: {len(warms)}, {sum(u.get('cacheRead', 0) for u in warms):,} tokens read, {sum(u.get('cacheWrite', 0) for u in warms):,} written")
    print(f"compactions: {len(compactions)}" + (f", tokens before: {', '.join(f'{c:,}' for c in sorted(c['tokens'] for c in compactions))}" if compactions else ""))
    cached = [c["capture"] for c in compactions if isinstance(c["capture"], dict)]
    if cached:
        print(f"  from the prompt cache: {len(cached)}, {sum(c.get('cacheRead', 0) for c in cached):,} tokens read, {sum(c.get('cacheWrite', 0) for c in cached):,} written")


if __name__ == "__main__":
    main()
