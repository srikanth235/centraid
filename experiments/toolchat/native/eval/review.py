"""Print a set for a cold gold review: each turn's request with its gold resolved to row names.

    python3 review.py test [--only ID,ID] > review.txt
"""

from __future__ import annotations

import argparse
import json

from lib import SECTION_KIND, load_world, read_jsonl


def describe(world: dict) -> dict[str, str]:
    out = {"me": f"person {world['me']} (me)"}
    for section, kind in SECTION_KIND.items():
        for r in world.get(section, []):
            if not r.get("key"):
                continue
            bits = [f"{kind} {r['name']!r}"]
            for field in ("start", "due", "taken", "created", "status", "cancelled", "trashed", "amount", "direction",
                          "settled", "list", "folder", "notebook", "albums", "role", "nickname"):
                if r.get(field) not in (None, [], False):
                    bits.append(f"{field}={r[field]}")
            out[r["key"]] = " ".join(str(b) for b in bits)
    return out


def show_accept(a: dict, names: dict) -> str:
    def n(k):
        return names.get(k, k) if not k.startswith("+") else f"(created #{k[1:]})"

    kind = a["type"]
    if kind == "rows":
        body = f"ROWS{' (ordered)' if a.get('order') else ''} [{len(a['rows'])}]: " + "; ".join(n(k) for k in a["rows"][:15])
        if len(a["rows"]) > 15:
            body += f"; … +{len(a['rows']) - 15}"
    elif kind == "value":
        body = "VALUE " + json.dumps(a.get("values") or a.get("groups"))
    elif kind == "ask":
        body = "ASK covering: " + "; ".join(n(k) for k in a.get("candidates", []))
    elif kind == "decline":
        body = "DECLINE " + "/".join(a["reasons"])
    else:
        body = "WRITE"
        if a.get("already"):
            body += " already:" + ",".join(a["already"])
        if a.get("reveal"):
            body += " reveal:" + ",".join(r["key"] for r in a["reveal"])
        if a.get("settle"):
            body += " settle:" + json.dumps(a["settle"])
    d = a.get("diff") or {}
    parts = []
    for r in d.get("rows", []):
        if "new" in r:
            parts.append(f"+new {r['new']} {json.dumps(r.get('fields', {}), ensure_ascii=False)}")
        else:
            parts.append(f"{r.get('change', 'updated')} {n(r['key'])} {json.dumps(r.get('fields', {}), ensure_ascii=False)}")
    for l in d.get("links", []):
        parts.append(f"link {l['change']} {l['from']}->{l['to']}")
    if parts:
        body += "\n        diff: " + "\n        diff: ".join(parts[:12]) + (f"\n        … +{len(parts) - 12}" if len(parts) > 12 else "")
    return body


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("set")
    parser.add_argument("--only")
    args = parser.parse_args()
    cache: dict = {}
    for s in read_jsonl(f"sets/{args.set}.jsonl"):
        if args.only and s["id"] not in args.only.split(","):
            continue
        names = cache.setdefault(s["world"], describe(load_world(s["world"])))
        print(f"=== {s['id']}  world {s['world']}  today {s['today']}{'  BLOCKED ' + s['blocked'] if s.get('blocked') else ''}")
        for i, t in enumerate(s["turns"]):
            print(f"  t{i + 1}: {t['user']}")
            for a in t["gold"]:
                print(f"     = {show_accept(a, names)}")


if __name__ == "__main__":
    main()
