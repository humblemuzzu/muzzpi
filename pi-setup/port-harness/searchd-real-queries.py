# Samples real grep and find calls from pi's session history, for
# searchd-real-parity.ts. Fixed seed: the same history gives the same sample.
#   python3 pi-setup/port-harness/searchd-real-queries.py [out.json]
import glob, json, os, random, sys

out_path = sys.argv[1] if len(sys.argv) > 1 else "/tmp/searchd-real-queries.json"
home = os.path.expanduser("~")
files = glob.glob(f"{home}/.pi/agent/sessions/**/*.jsonl", recursive=True) + glob.glob(f"{home}/.pi/agent/sessions-sub/**/*.jsonl", recursive=True)
greps, finds = set(), set()
for f in files:
    try:
        for ln in open(f, encoding="utf-8", errors="replace"):
            if '"toolCall"' not in ln:
                continue
            e = json.loads(ln)
            for c in (e.get("message") or {}).get("content") or []:
                if c.get("type") != "toolCall":
                    continue
                a = c.get("arguments") or {}
                if c.get("name") == "grep" and isinstance(a.get("pattern"), str) and a["pattern"]:
                    ci = a.get("caseSensitive") is False or a.get("ignoreCase") is True
                    greps.add((a["pattern"], bool(a.get("literal")), ci, a.get("glob") if isinstance(a.get("glob"), str) else None))
                elif c.get("name") in ("find", "glob"):
                    g = a.get("filePattern") or a.get("pattern")
                    if isinstance(g, str) and g:
                        finds.add(g)
    except Exception:
        pass
rnd = random.Random(42)
greps = sorted(greps, key=lambda t: (t[0], t[1], t[2], t[3] or ""))
finds = sorted(finds)
json.dump(
    {
        "grep": [dict(pattern=p, literal=l, ignoreCase=c, glob=g) for p, l, c, g in rnd.sample(greps, min(300, len(greps)))],
        "find": rnd.sample(finds, min(150, len(finds))),
    },
    open(out_path, "w"),
)
print(f"{len(greps)} distinct grep calls, {len(finds)} distinct find patterns in history; sample written to {out_path}")
