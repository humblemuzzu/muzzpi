#!/usr/bin/env python3
"""Edit-tool scoreboard: calls, errors, why they failed, and silent damage.

    python3 pi-setup/edit-scoreboard.py --since 2026-10-11 [--list]

Reads every pi transcript under ~/.pi/agent/sessions and sessions-sub; a call
copied into a forked session counts once. A "Could not find" is explained
against the file as it really was at that moment, rebuilt from the undo
records in ~/.pi/file-changes. The pre-2026-08 `edit` tool returned many
errors without isError, so a result is also an error when its text starts
like one.
"""

import argparse
import collections
import datetime
import difflib
import glob
import json
import os
import re

ROOTS = ["~/.pi/agent/sessions", "~/.pi/agent/sessions-sub"]
FILE_CHANGES = "~/.pi/file-changes"
TOOLS = {"edit", "write", "apply_patch"}
DAY_MS = 86_400_000
ERROR_START = re.compile(r"^(could not find|found \d+ occurrences|old_str and new_str are identical|file not found)", re.I)
CLASSES = [
    ("not found", r"Could not find|old_string was not found|failed to find"),
    ("duplicate", r"occurrences|matches \d+ places|ambiguous"),
    ("overlapping edits", r"overlap in "),
    ("identical / no-op", r"identical|made no changes|No changes made"),
    ("comment gate", r"^Blocked: .*comment"),
    ("control character refused", r"invisible control character"),
    ("escape as text refused", r"as six characters of text"),
    ("secret marker refused", r"\[REDACTED\], the marker"),
    ("validation", r"Validation failed|must not be empty"),
    ("undo record failed", r"could not be recorded"),
    ("missing file", r"ENOENT|not found:|Could not edit file"),
    ("permission", r"permission|EACCES"),
    ("call shape", r"accepted shapes"),
    ("patch format", r"invalid patch|Begin Patch|End Patch|unified diff"),
]
RESCUED = "escapes as text; they were read as the characters"

CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
LITERAL_ESCAPE = re.compile(r"\\u([0-9a-fA-F]{4})")
# what Claude's non-ASCII turned into under Anthropic strict decoding (pi #10074)
BROKEN_ESCAPE = re.compile(r"\n(?:n?dash|mdash|geq|leq|invalid|details)\b|\t(?:tt|ools|ry)\b|\\u\{[0-9a-fA-F]+\}")
PROSE = (".md", ".mdx", ".markdown", ".txt", ".rst", ".adoc")
FORMATTER = re.compile(
    r"biome [^|;&]*--(?:write|fix|apply)|prettier [^|;&]*--write|cargo fmt|rustfmt|swift-?format"
    r"|eslint [^|;&]*--fix|ruff (?:format|check --fix)|gofmt"
)
VIEWED_IN_BASH = re.compile(r"\b(?:cat|sed|head|tail|rg|grep|nl|bat|less)\b")


def parse(line):
    try:
        return json.loads(line)
    except ValueError:
        return None


def millis(entry, message):
    stamp = message.get("timestamp")
    if isinstance(stamp, (int, float)):
        return int(stamp)
    text = entry.get("timestamp") or ""
    try:
        return int(datetime.datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp() * 1000)
    except ValueError:
        return 0


def text_of(message):
    return "".join(p.get("text", "") for p in message.get("content") or [] if isinstance(p, dict))


def classify(text):
    return next((name for name, rx in CLASSES if re.search(rx, text, re.I)), "other")


def load(since_ms):
    """Every edit/write/apply_patch/read call and result, plus bash commands, deduplicated across forks."""
    calls, results, order, bash, sessions = {}, {}, {}, collections.defaultdict(list), {}
    for root in ROOTS:
        for path in glob.glob(os.path.expanduser(root) + "/**/*.jsonl", recursive=True):
            if "private-tmp" in path or os.path.getmtime(path) * 1000 < since_ms:
                continue
            ids = order.setdefault(path, [])
            with open(path, errors="replace") as handle:
                header = parse(handle.readline()) or {}
                sessions[path] = (header.get("id"), header.get("cwd") or "/")
                for line in handle:
                    if '"toolCall"' not in line and '"toolResult"' not in line:
                        continue
                    entry = parse(line)
                    message = (entry or {}).get("message")
                    if not isinstance(message, dict):
                        continue
                    if message.get("role") == "assistant":
                        for block in message.get("content") or []:
                            if not isinstance(block, dict) or block.get("type") != "toolCall":
                                continue
                            name, args = block.get("name"), block.get("arguments") or {}
                            if name == "bash" and isinstance(args, dict):
                                bash[path].append((millis(entry, message), args.get("cmd") or args.get("command") or ""))
                            elif name in TOOLS | {"read"} and block.get("id") not in calls:
                                calls[block["id"]] = {
                                    "id": block["id"], "name": name, "args": args if isinstance(args, dict) else {},
                                    "model": f'{message.get("provider")}/{message.get("model")}',
                                    "ts": millis(entry, message), "file": path,
                                }
                                ids.append(block["id"])
                    elif message.get("role") == "toolResult" and message.get("toolName") in TOOLS | {"read"}:
                        if message.get("toolCallId") in results:
                            continue
                        text = text_of(message)
                        failed = bool(message.get("isError")) or bool(ERROR_START.search(text.strip()))
                        results[message.get("toolCallId")] = (failed, text)
    return calls, results, order, bash, sessions


def target_of(call, sessions):
    raw = os.path.expanduser(call["args"].get("path") or call["args"].get("file_path") or "")
    if raw.startswith("file://"):
        raw = raw[7:]
    if not raw:
        return None
    return os.path.normpath(raw if os.path.isabs(raw) else os.path.join(sessions[call["file"]][1], raw))


def change_records(paths, ok_ids, since_ms):
    """Undo records for the failed paths (with content), and the damage each successful change added."""
    records, damage = collections.defaultdict(list), []
    root = os.path.expanduser(FILE_CHANGES)
    if not os.path.isdir(root):
        return records, damage
    for session in os.listdir(root):
        folder = os.path.join(root, session)
        if not os.path.isdir(folder):
            continue
        for name in os.listdir(folder):
            full = os.path.join(folder, name)
            call_id = name.split(".")[0]
            if os.path.getmtime(full) * 1000 < since_ms - 3 * DAY_MS:
                continue
            try:
                with open(full, errors="replace") as handle:
                    record = json.load(handle)
            except (OSError, ValueError):
                continue
            uri = record.get("uri", "")
            target = uri[7:] if uri.startswith("file://") else uri
            before, after = record.get("before") or "", record.get("after") or ""
            if target in paths:
                records[target].append({"ts": record.get("timestamp", 0), "before": before, "after": after, "session": session})
            if call_id in ok_ids:
                added = added_damage(target, before, after)
                if added:
                    damage.append((ok_ids[call_id], target, added))
    for items in records.values():
        items.sort(key=lambda r: r["ts"])
    return records, damage


def outside_code(text):
    return re.sub(r"```[\s\S]*?```|`[^`\n]*`", "", text)


def added_damage(target, before, after):
    found = []
    for ch in set(CONTROL.findall(after)) - set(CONTROL.findall(before)):
        found.append(f"control character U+{ord(ch):04X}")
    if target.endswith(PROSE):
        extra = len(LITERAL_ESCAPE.findall(outside_code(after))) - len(LITERAL_ESCAPE.findall(outside_code(before)))
        if extra > 0:
            found.append(f"{extra} literal \\uXXXX in prose")
    return found


def decode(text):
    return LITERAL_ESCAPE.sub(lambda m: chr(int(m.group(1), 16)), text)


def squash(text):
    return re.sub(r"\s+", " ", text).strip()


def first_difference(old, content):
    """The character the model sent and the one the file has, where they first part ways."""
    if len(content) > 2_000_000:
        return None, None
    match = difflib.SequenceMatcher(None, content, old, autojunk=False).find_longest_match(0, len(content), 0, len(old))
    a, b = match.a + match.size, match.b + match.size
    if b >= len(old):
        a, b = match.a - 1, match.b - 1
        while a >= 0 and b >= 0 and content[a] == old[b]:
            a, b = a - 1, b - 1
    sent = old[b] if 0 <= b < len(old) else None
    has = content[a] if 0 <= a < len(content) else None
    return sent, has


def failed_old_text(call, error):
    edits = call["args"].get("edits")
    if isinstance(edits, str):
        edits = parse(edits)
    if not isinstance(edits, list):
        edits = [{"oldText": call["args"].get("oldText") or call["args"].get("old_string")}]
    index = re.search(r"edits\[(\d+)\]", error)
    entry = edits[int(index.group(1))] if index and int(index.group(1)) < len(edits) else (edits[0] if edits else {})
    return (entry or {}).get("oldText") or (entry or {}).get("old_string") or ""


def not_found_cause(call, error, ctx):
    calls, results, order, bash, sessions, records = ctx
    target = target_of(call, sessions)
    session_id = sessions[call["file"]][0]
    old = failed_old_text(call, error).replace("\r\n", "\n")
    history = records.get(target, [])
    before = [r for r in history if r["ts"] < call["ts"]]
    after = [r for r in history if r["ts"] > call["ts"]]
    if after:
        content = after[0]["before"]
    elif before:
        content = before[-1]["after"]
    elif target and os.path.exists(target):
        with open(target, errors="replace") as handle:
            content = handle.read()
    else:
        return "unknown (no copy of the file)"
    content = content.replace("\r\n", "\n")

    if not old:
        return "empty oldText"
    if old in content:
        return "matches now (file changed during the call)"
    if decode(old) != old and decode(old) in content:
        return "garbled non-ASCII: \\u escape sent as text"
    if any(ch not in content for ch in set(CONTROL.findall(old))) or BROKEN_ESCAPE.search(old):
        return "garbled non-ASCII: broken escape"
    sent, has = first_difference(old, content)
    if has is not None and ord(has) > 127 and (sent is None or ord(sent) < 128):
        return "garbled non-ASCII: character dropped or replaced"
    if squash(old) in squash(content):
        return "whitespace or line breaks differ"

    if before and old in before[-1]["after"]:
        prior = [cmd for ts, cmd in bash[call["file"]] if before[-1]["ts"] <= ts < call["ts"]]
        how = "a formatter" if any(FORMATTER.search(cmd) for cmd in prior) else "something outside the tools"
        return f"stale: {how} changed the file after its last edit"
    for record in reversed(before):
        if old in record["before"] or old in record["after"]:
            return "stale: forgot its own earlier edit" if record["session"] == session_id else "stale: another session edited the file"

    base = os.path.basename(target or "")
    seen = []
    for prior_id in order[call["file"]][: order[call["file"]].index(call["id"])]:
        prior = calls[prior_id]
        if prior["name"] == "read" and os.path.basename(prior["args"].get("path") or "") == base:
            failed, text = results.get(prior_id, (True, ""))
            if not failed:
                seen.append(re.sub(r"(?m)^\s*\d+[:|]\s?", "", text))
    if any(old in text for text in seen):
        return "stale: file changed after the model read it"
    if not seen and not any(base in cmd and VIEWED_IN_BASH.search(cmd) for ts, cmd in bash[call["file"]] if ts < call["ts"]):
        return "typed from memory: never read the file"
    return "typed from memory: oldText is not what it read"


def recovered(call, calls, results, order):
    later = order[call["file"]][order[call["file"]].index(call["id"]) + 1 :]
    base = os.path.basename(call["args"].get("path") or call["args"].get("file_path") or "")
    for next_id in later:
        nxt = calls[next_id]
        if nxt["name"] in TOOLS and os.path.basename(nxt["args"].get("path") or nxt["args"].get("file_path") or "") == base:
            if next_id in results and not results[next_id][0]:
                return True
    return False


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--since", help="ISO date in UTC, e.g. 2026-10-11 (default: all time)")
    parser.add_argument("--list", action="store_true", help="print every failure with its cause")
    args = parser.parse_args()
    since_ms = 0
    if args.since:
        since = datetime.datetime.fromisoformat(args.since).replace(tzinfo=datetime.timezone.utc)
        since_ms = int(since.timestamp() * 1000)

    calls, results, order, bash, sessions = load(since_ms)
    window = [c for c in calls.values() if c["name"] in TOOLS and c["ts"] >= since_ms]
    failures = [c for c in window if c["id"] not in results or results[c["id"]][0]]
    failed_ids = {c["id"] for c in failures}
    ok_ids = {c["id"]: c for c in window if c["id"] in results and not results[c["id"]][0]}
    not_found = [c for c in failures if c["id"] in results and classify(results[c["id"]][1]) == "not found"]
    paths = {target_of(c, sessions) for c in not_found} - {None}
    records, damage = change_records(paths, ok_ids, since_ms)
    ctx = (calls, results, order, bash, sessions, records)
    causes = {c["id"]: not_found_cause(c, results[c["id"]][1], ctx) for c in not_found if c["name"] == "edit"}

    print(f"since {args.since or 'the first session'}: {len(window)} edit-tool calls\n")
    for tool in sorted(TOOLS):
        mine = [c for c in window if c["name"] == tool]
        if not mine:
            continue
        errors = [c for c in failures if c["name"] == tool]
        rescued = sum(RESCUED in results[c["id"]][1] for c in mine if c["id"] in ok_ids)
        extra = f"  (+{rescued} only saved by the \\uXXXX decoder)" if rescued else ""
        print(f"{tool:12} {len(mine):6} calls  {len(errors):5} errors  {len(errors) / len(mine):6.1%}{extra}")
        kinds = collections.Counter(classify(results[c["id"]][1]) if c["id"] in results else "no result" for c in errors)
        for name, count in kinds.most_common():
            print(f"    {count:5}  {name}")

    if causes:
        print("\nwhy edit could not find its oldText:")
        for name, count in collections.Counter(causes.values()).most_common():
            print(f"    {count:5}  {name}")

    print("\nby model (edit + write):")
    by_model = collections.defaultdict(lambda: [0, 0])
    for call in window:
        if call["name"] != "apply_patch":
            by_model[call["model"]][0] += 1
            by_model[call["model"]][1] += call["id"] in failed_ids
    for model, (count, errors) in sorted(by_model.items(), key=lambda kv: -kv[1][0]):
        print(f"    {model:45} {count:6} calls  {errors:5} errors  {errors / count:6.1%}")

    if failures:
        fixed = sum(recovered(c, calls, results, order) for c in failures)
        print(f"\nfixed by a later edit/write to the same file: {fixed} of {len(failures)}")

    print(f"\nsilent damage written by successful calls: {len(damage)}")
    for call, target, added in damage:
        print(f"    {call['model']:30} {', '.join(added)}  {target}")

    if args.list:
        print("\nevery failure:")
        for call in sorted(failures, key=lambda c: c["ts"]):
            text = results.get(call["id"], (True, "<no result>"))[1]
            why = causes.get(call["id"]) or classify(text)
            when = datetime.datetime.fromtimestamp(call["ts"] / 1000).strftime("%m-%d %H:%M")
            print(f"  {when} {call['name']:5} {call['model']:32} {why}")
            print(f"        {target_of(call, sessions)}")
            print(f"        {text.splitlines()[0][:150] if text else ''}")


if __name__ == "__main__":
    main()
