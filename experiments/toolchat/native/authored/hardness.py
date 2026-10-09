"""Hardness census of built sessions: how many constraints each turn's reference calls carry.

    python3 authored/hardness.py OUT/T29.gold.jsonl [more .gold.jsonl] [--md FILE]

Why: on val the fail rate rises with the count of constraints on the reference call (k<=1 13-15%,
k=2 22%, k=3 37%, k=4 67%; #1044 phase-6 census) and the train corpus is thin at k>=3. A world
authored under the phase-7 brief ($S/phase7/BRIEF-A.md) must land the shares below.

A constraint is one selection facet the model has to get right, counted over the turn's accepted
reference calls (a `bad` call is a repair, not a constraint):
  find / answer / compute: each `where` clause (split on ` and `), `when`, `linked_to`, `within`,
    `exclude`, `name`, `status`, `text`, `order`+`limit` (together), `op`+`field`+`group` (together)
  act: the row selector (`rows` or `name`), each `where` clause, `when`, `linked_to`, `within`
  ask / decline / open: 0 (the judgement is counted under outcomes)
The `args` payload of a write (the fields set) is not a constraint: it is content the message states.

Reported per world: turns, share of turns at k=0/1, 2, 3, 4+; multi-call turns (2+ accepted calls);
write-then-read turns (`more`); turns with a relation (`linked_to`); turns with a date (`when`);
turns whose gold is an ask or a decline; mean turns per session.
"""

from __future__ import annotations

import argparse
import collections
import json
import sys
from pathlib import Path

FACETS_ONE = ("when", "linked_to", "within", "exclude", "name", "status", "text")
TARGETS = {  # phase-7 authoring targets (share of turns), see $S/phase7/BRIEF-A.md
    "k=2": (0.30, None), "k=3": (0.15, None), "k>=4": (0.05, None),
    "multi-call": (0.20, None), "relation": (0.12, None), "ask|decline": (0.06, 0.14),
}


def constraints(call: dict) -> int:
    tool = call.get("tool")
    a = call.get("args") or {}
    if tool in ("ask", "decline", "open"):
        return 0
    k = 0
    if tool == "act":
        k += 1 if (a.get("rows") or a.get("name")) else 0
    else:
        k += 1 if a.get("name") else 0
    for f in FACETS_ONE:
        if f == "name":
            continue
        if a.get(f):
            k += 1
    w = a.get("where")
    if w:
        k += len([c for c in str(w).split(" and ") if c.strip()])
    if a.get("order") or a.get("limit"):
        k += 1
    if a.get("op") or a.get("field") or a.get("group"):
        k += 1
    return k


def census(sessions: list[dict]) -> dict:
    n = 0
    c: collections.Counter = collections.Counter()
    for s in sessions:
        for t in s["turns"]:
            n += 1
            calls = [x for x in t.get("ref", []) if not x.get("bad")]
            k = max((constraints(x) for x in calls), default=0)
            c["k=0/1" if k <= 1 else "k=2" if k == 2 else "k=3" if k == 3 else "k>=4"] += 1
            if len(calls) >= 2:
                c["multi-call"] += 1
            if any(x.get("tool") == "act" and (x.get("args") or {}).get("more") for x in calls):
                c["write-then-read"] += 1
            if any((x.get("args") or {}).get("linked_to") for x in calls):
                c["relation"] += 1
            if any((x.get("args") or {}).get("when") for x in calls):
                c["date"] += 1
            gold = t.get("gold") or []
            gold = gold if isinstance(gold, list) else [gold]
            if any(isinstance(g, dict) and g.get("type") in ("ask", "decline") for g in gold):
                c["ask|decline"] += 1
    return {"sessions": len(sessions), "turns": n,
            "turns/session": round(n / max(1, len(sessions)), 2),
            **{key: round(c[key] / max(1, n), 3) for key in
               ("k=0/1", "k=2", "k=3", "k>=4", "multi-call", "write-then-read", "relation", "date", "ask|decline")}}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("gold", nargs="+")
    ap.add_argument("--md")
    a = ap.parse_args()
    by_world: dict[str, list[dict]] = collections.defaultdict(list)
    for f in a.gold:
        for line in open(f):
            if line.strip():
                s = json.loads(line)
                by_world[s["world"]].append(s)
    rows = {w: census(ss) for w, ss in sorted(by_world.items())}
    if len(rows) > 1:
        rows["ALL"] = census([s for ss in by_world.values() for s in ss])
    keys = list(next(iter(rows.values())).keys())
    lines = ["| world | " + " | ".join(keys) + " |", "|" + " --- |" * (len(keys) + 1)]
    for w, r in rows.items():
        lines.append(f"| {w} | " + " | ".join(str(r[k]) for k in keys) + " |")
    short = []
    for w, r in rows.items():
        for key, (lo, hi) in TARGETS.items():
            v = r[key]
            if (lo is not None and v < lo) or (hi is not None and v > hi):
                short.append(f"{w}: {key} {v} outside [{lo}, {hi}]")
    text = "\n".join(lines) + ("\n\nshort of target:\n- " + "\n- ".join(short) if short else "\n\nall targets met") + "\n"
    print(text, end="")
    if a.md:
        Path(a.md).write_text(text)
    sys.exit(1 if short else 0)


if __name__ == "__main__":
    main()
