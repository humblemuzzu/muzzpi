#!/usr/bin/env python3
import json
import re
import subprocess
import sys
import unicodedata

RESET = "\033[0m"
DIM = "\033[2m"
YELLOW = "\033[33m"
RED = "\033[31m"
SEP = f"{DIM} · {RESET}"
SEP_WIDTH = 3


def width_of(text):
    return sum(2 if unicodedata.east_asian_width(c) in "WF" else 1 for c in text)


def paint(text, colour):
    return f"{colour}{text}{RESET}" if colour else text


def short_model(model):
    name = (model or {}).get("display_name") or ""
    for prefix in ("Gemini 4 ", "Gemini ", "Claude "):
        if name.startswith(prefix):
            name = name[len(prefix):]
            break
    return name.replace("(", "").replace(")", "").replace("  ", " ").strip()


def short_tokens(n):
    if not n:
        return ""
    if n >= 1_000_000:
        return f"{n / 1_048_576:.0f}M" if n % 1_048_576 == 0 else f"{n / 1_000_000:.1f}M"
    return f"{round(n / 1024)}K"


def short_duration(seconds):
    seconds = int(seconds or 0)
    days, rest = divmod(seconds, 86_400)
    hours, rest = divmod(rest, 3_600)
    minutes = rest // 60
    if days:
        return f"{days}d {hours}h"
    if hours:
        return f"{hours}h {minutes}m"
    return f"{minutes}m"


def level(fraction_left):
    if fraction_left <= 0.05:
        return RED
    if fraction_left <= 0.20:
        return YELLOW
    return ""


def quota_segment(label, bucket, always):
    if not bucket or bucket.get("disabled"):
        return None
    left = bucket.get("remaining_fraction")
    if left is None:
        return None
    if not always and left >= 1:
        return None
    text = f"{label} {round(left * 100)}%"
    colour = level(left)
    if colour and bucket.get("reset_in_seconds"):
        text += f" for {short_duration(bucket['reset_in_seconds'])}"
    return paint(text, colour)


def branch(cwd, vcs):
    if (vcs or {}).get("type") != "git" or not cwd:
        return ""
    try:
        out = subprocess.run(
            ["git", "-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"],
            capture_output=True, text=True, timeout=0.5,
        )
        return out.stdout.strip() if out.returncode == 0 else ""
    except Exception:
        return ""


def build(data):
    left, right = [], []
    if data.get("tool_confirmation_pending"):
        left.append((100, paint("waiting for you", YELLOW)))
    if data.get("agent_state") == "error":
        left.append((99, paint("error", RED)))
    model = short_model(data.get("model"))
    if model:
        left.append((90, model))
    left.append((60, data.get("cycle_mode") or "default"))
    running = [s for s in (data.get("subagents") or []) if s.get("status") == "running"]
    if running:
        left.append((50, f"{len(running)} agent{'s' if len(running) > 1 else ''}"))
    if data.get("task_count"):
        n = data["task_count"]
        left.append((45, f"{n} task{'s' if n > 1 else ''}"))
    if data.get("pending_input_count"):
        left.append((40, f"{data['pending_input_count']} queued"))
    ctx = data.get("context_window") or {}
    used = ctx.get("used_percentage")
    if used is not None:
        colour = RED if used >= 85 else YELLOW if used >= 70 else ""
        size = short_tokens(ctx.get("context_window_size"))
        right.append((80, paint(f"ctx {round(used)}%" + (f" of {size}" if size else ""), colour)))
    quota = data.get("quota") or {}
    for prio, label, key, always in (
        (75, "5h", "gemini-5h", True),
        (70, "week", "gemini-weekly", True),
        (35, "claude 5h", "3p-5h", False),
        (30, "claude week", "3p-weekly", False),
    ):
        seg = quota_segment(label, quota.get(key), always)
        if seg:
            right.append((prio, seg))
    total = (data.get("cost") or {}).get("total_usd")
    if total:
        right.append((25, f"${total:.2f}"))
    name = branch((data.get("workspace") or {}).get("current_dir") or data.get("cwd"), data.get("vcs"))
    if name:
        right.append((20, name))
    return left, right


def visible(segments):
    plain = [re.sub(r"\033\[[0-9;]*m", "", s) for _, s in segments]
    return sum(width_of(p) for p in plain) + SEP_WIDTH * max(len(plain) - 1, 0)


def layout(left, right, width):
    inset = 2
    room = max(width - inset * 2, 10)
    while left or right:
        need = visible(left) + visible(right) + (2 if left and right else 0)
        if need <= room:
            break
        pool = [(p, "l", i) for i, (p, _) in enumerate(left)] + [(p, "r", i) for i, (p, _) in enumerate(right)]
        _, side, i = min(pool)
        (left if side == "l" else right).pop(i)
    l_text = SEP.join(s for _, s in left)
    r_text = SEP.join(s for _, s in right)
    gap = room - visible(left) - visible(right)
    return " " * inset + l_text + " " * max(gap, 2 if r_text else 0) + r_text


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        return
    left, right = build(data)
    print(layout(left, right, data.get("terminal_width") or 100))


if __name__ == "__main__":
    main()
