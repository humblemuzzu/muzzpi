#!/usr/bin/env python3
"""Edit-tool scoreboard: calls, errors and error classes per tool and model.

    python3 pi-setup/edit-scoreboard.py --since 2026-10-11

Reads every pi transcript under ~/.pi/agent/sessions and sessions-sub. The
pre-2026-08 `edit` tool returned many errors without isError, so a result is
also counted as an error when its text starts like one.
"""

import argparse
import collections
import glob
import json
import os
import re

ROOTS = ["~/.pi/agent/sessions", "~/.pi/agent/sessions-sub"]
TOOLS = {"edit", "write", "apply_patch"}
ERROR_START = re.compile(r"^(could not find|found \d+ occurrences|old_str and new_str are identical|file not found)", re.I)
CLASSES = [
    ("not found", r"Could not find|old_string was not found|failed to find"),
    ("duplicate", r"occurrences|matches \d+ places|ambiguous"),
    ("identical / no-op", r"identical|made no changes|No changes made"),
    ("comment gate", r"^Blocked: .*comment"),
    ("validation", r"Validation failed"),
    ("undo record failed", r"could not be recorded"),
    ("missing file", r"ENOENT|not found:|Could not edit file"),
    ("permission", r"permission"),
    ("call shape", r"accepted shapes"),
    ("patch format", r"invalid patch|Begin Patch|End Patch|unified diff"),
]


def classify(text):
    return next((name for name, rx in CLASSES if re.search(rx, text, re.I)), "other")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--since", default="0000", help="ISO date, e.g. 2026-10-11")
    args = parser.parse_args()

    models = {}
    rows = []
    for root in ROOTS:
        for path in glob.glob(os.path.expanduser(root) + "/**/*.jsonl", recursive=True):
            if "private-tmp" in path:
                continue
            model = None
            with open(path, errors="replace") as handle:
                for line in handle:
                    if '"toolResult"' not in line and '"assistant"' not in line:
                        continue
                    try:
                        entry = json.loads(line)
                    except ValueError:
                        continue
                    message = entry.get("message") or {}
                    if message.get("role") == "assistant" and message.get("model"):
                        model = f'{message.get("provider")}/{message["model"]}'
                        for block in message.get("content") or []:
                            if isinstance(block, dict) and block.get("type") == "toolCall":
                                models[(path, block.get("id"))] = model
                    elif message.get("role") == "toolResult" and message.get("toolName") in TOOLS:
                        if entry.get("timestamp", "")[:10] < args.since:
                            continue
                        text = "".join(p.get("text", "") for p in message.get("content") or [] if isinstance(p, dict))
                        failed = bool(message.get("isError")) or bool(ERROR_START.search(text.strip()))
                        rows.append((message["toolName"], models.get((path, message.get("toolCallId")), model), failed, text))

    print(f"since {args.since}: {len(rows)} edit-tool results\n")
    for tool in sorted(TOOLS):
        mine = [r for r in rows if r[0] == tool]
        if not mine:
            continue
        errors = [r for r in mine if r[2]]
        print(f"{tool:12} {len(mine):6} calls  {len(errors):5} errors  {len(errors) / len(mine):6.1%}")
        for name, count in collections.Counter(classify(r[3]) for r in errors).most_common():
            print(f"    {count:5}  {name}")
    print("\nby model (edit + write):")
    by_model = collections.defaultdict(lambda: [0, 0])
    for tool, model, failed, _ in rows:
        if tool != "apply_patch":
            by_model[model][0] += 1
            by_model[model][1] += failed
    for model, (calls, errors) in sorted(by_model.items(), key=lambda kv: -kv[1][0]):
        print(f"    {str(model):45} {calls:6} calls  {errors / calls:6.1%}")


if __name__ == "__main__":
    main()
