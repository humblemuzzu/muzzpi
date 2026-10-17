#!/usr/bin/env python3
"""Scores strict-ab runs: python3 score.py <out dir> <arm>."""

import glob
import json
import os
import re
import sys

EXPECTED_CHARS = set("\u2014\u2265\u2026\u2192\u00a7\u2013\u2500\u2713")
GARBLED = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]|\\u[0-9a-fA-F]{4}|\\u\{[0-9a-fA-F]+\}|\n(?:n?dash|geq)\b|\t(?:tt|ools)\b")
RESCUED = "escapes as text; they were read as the characters"


def changes_made(run):
    def text(name):
        with open(os.path.join(run, name), encoding="utf-8") as handle:
            return handle.read()

    notes, check, box = text("notes.md"), text("check.sh"), text("box.ts")
    return {
        "design": "v0.74.0 migration, design" in notes,
        "wipe": "`wipe` (use `trash` instead)" in notes,
        "24": "node \u2265 24," in notes,
        "seven": "The seven GitHub tools" in notes,
        "bun run test": "`bun run test`" in notes,
        "last 5": "last 5 deploy" in notes,
        "third party": "third party check \u2500\u2500" in check,
        "stock": "must be stock \u2500\u2500" in check,
        "PATCHES OK": "ALL PATCHES OK \u2713" in check,
        "billing": "extra-usage billing" in box,
        "cols": 'truncateToWidth(line, cols, "\u2026")' in box,
        "the keychain": "unlock the keychain" in box,
    }


def score(run):
    calls, results = {}, {}
    for session in glob.glob(f"{run}/sessions/*.jsonl"):
        with open(session, encoding="utf-8") as handle:
            for line in handle:
                message = json.loads(line).get("message") or {}
                if message.get("role") == "assistant":
                    for block in message.get("content", []):
                        if block.get("type") == "toolCall" and block.get("name") == "edit":
                            calls[block["id"]] = block.get("arguments") or {}
                elif message.get("role") == "toolResult" and message.get("toolName") == "edit":
                    text = "".join(p.get("text", "") for p in message.get("content", []))
                    results[message["toolCallId"]] = (bool(message.get("isError")), text)
    row = {"edits": 0, "errors": 0, "rescued": 0, "raw": 0, "garbled": 0}
    for call_id, args in calls.items():
        failed, text = results.get(call_id, (True, ""))
        row["edits"] += 1
        row["errors"] += failed
        row["rescued"] += RESCUED in text
        old = " ".join(e.get("oldText", "") for e in args.get("edits", []) if isinstance(e, dict))
        row["raw"] += any(ch in EXPECTED_CHARS for ch in old)
        row["garbled"] += bool(GARBLED.search(old))
    strict = None
    if os.path.exists(f"{run}/tools.log"):
        strict = set()
        with open(f"{run}/tools.log") as handle:
            for line in handle:
                strict |= {name for name, is_strict in json.loads(line) if is_strict and str(name).lower() in ("edit", "write")}
    wrong = [name for name, ok in changes_made(run).items() if not ok]
    return row, strict, wrong


def main():
    out, arm = sys.argv[1], sys.argv[2]
    total = {"edits": 0, "errors": 0, "rescued": 0, "raw": 0, "garbled": 0}
    for run in sorted(glob.glob(f"{out}/{arm}-*")):
        row, strict, wrong = score(run)
        for key in total:
            total[key] += row[key]
        if strict is None:
            sent = "tools not logged"
        else:
            sent = f"strict: {', '.join(sorted(strict))}" if strict else "edit/write sent non-strict"
        result = "all 12 changes right" if not wrong else f"WRONG: {', '.join(wrong)}"
        print(f"{os.path.basename(run)}: {row}  {sent}  {result}")
    print(f"TOTAL {arm}: {total}")


if __name__ == "__main__":
    main()
