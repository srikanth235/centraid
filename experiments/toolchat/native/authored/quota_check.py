"""Fill of the G3 quota cells on the current train authored records; prints RED CELLS.

    python3 authored/quota_check.py [--gold 'GLOB'] [--plan]

Reads authored/quota.json (targets, and the per-group allocation of new sessions). Counts turns on the
verified sessions (report.json pass) of the train worlds only (authored/split.py), tagged by
gapreport.analyse, the same code the gap report uses. Recovery sessions are counted from the replay:
a call the runtime answered with `error: repeated call` (first hint) or `error: repeated call again`
(second), followed in the reference by a call that is not itself a repeat (a changed call or an answer).
--mine W checks one world's new sessions against the per-world plan (quota.json min_new_uses_per_world,
new_hard_share). --plan prints, per cell, the new uses/sessions still needed and the allocation total.
"""
from __future__ import annotations

import argparse
import glob
import json
import math
import re
from collections import Counter
from pathlib import Path

import split
from gapreport import HERE, analyse, world_rows

QUOTA = HERE / "quota.json"
GOLD = "/tmp/authored-T[0-9][0-9]/T[0-9][0-9].gold.jsonl"
REPEAT = "error: repeated call"


def verified(gold_path: str) -> list[dict]:
    """The sessions of a gold file that verified (its report.json says pass)."""
    rp = Path(gold_path).with_name(Path(gold_path).name.replace(".gold.jsonl", ".report.json"))
    ok = {r["id"] for r in json.load(open(rp)) if r["pass"]} if rp.exists() else None
    out = [json.loads(line) for line in open(gold_path)]
    return [s for s in out if ok is None or s["id"] in ok]


def is_recovery(s: dict) -> bool:
    """A turn whose replay shows a rejected repeat (`error: repeated call`, first hint or the second
    nudge) followed, in the same turn, by a call the runtime accepted (a changed call or an answer)."""
    for r in s.get("replay", []):
        errs = r.get("errors", [])
        first = next((i for i, e in enumerate(errs) if e.startswith(REPEAT)), None)
        if first is None:
            continue
        rest = [e for e in errs[first:] if not e.startswith(REPEAT)]
        if rest and errs[-1] == "":
            return True
    return False


def need_new(count: int, hard: int, uses: int, share: float) -> int:
    """New uses (each hard) so that count >= uses and hard/count >= share."""
    n = max(0, uses - count)
    while share and (hard + n) < share * (count + n):
        n += 1
    return n


def fill(sessions: list[dict]) -> dict:
    cache: dict = {}
    c, h = Counter(), Counter()
    for s in sessions:
        rows = world_rows(HERE / "worlds" / f"{s['world']}.json", cache)
        for i, t in enumerate(s["turns"], 1):
            tags, hard = analyse(t, i, rows, s)
            for tag in tags:
                c[tag] += 1
                h[tag] += bool(hard)
    return {"count": c, "hard": h, "recovery": sum(is_recovery(s) for s in sessions)}


def mine(a: argparse.Namespace, q: dict) -> None:
    """One author's check: this world's new sessions (ids 131 and up) against the per-world plan."""
    w = a.mine
    if w not in split.train_worlds():
        raise SystemExit(f"quota_check: {w} is not a train world")
    path = a.gold.replace("T[0-9][0-9]", w)
    sessions = [s for p in sorted(glob.glob(path)) for s in verified(p) if int(re.search(r"-(\d+)$", s["id"]).group(1)) >= 131]
    f = fill(sessions)
    plan = q["min_new_uses_per_world"]
    print(f"{w}: {len(sessions)} verified new sessions (want {len(q['session_plan'])})")
    low = 0
    for name, cell in q["cells"].items():
        if "sessions" in cell:
            n, want = f["recovery"], plan["recovery sessions"]
            line = f"{n} recovery sessions (want {want})"
        else:
            want, n = plan[cell["tag"]], f["count"][cell["tag"]]
            hs = f["hard"][cell["tag"]] / n if n else 0.0
            need = q["new_hard_share"].get(name, 0.0)
            line = f"{n} uses (want {want})" + (f", hard {hs:.0%} (want {need:.0%})" if need else "")
            n_ok = hs >= need
        short = n < want or ("sessions" not in cell and not n_ok)
        low += short
        print(f"  {'LOW' if short else 'ok '} {name:32s} {line}")
    print(f"LOW CELLS {low}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--gold", default=GOLD)
    ap.add_argument("--plan", action="store_true")
    ap.add_argument("--mine", metavar="W", help="check one world's new G3 sessions (ids 131+) against its quota instead of the corpus")
    a = ap.parse_args()
    q = json.load(open(QUOTA))
    if a.mine:
        return mine(a, q)
    sessions = []
    for p in sorted(glob.glob(a.gold)):
        sessions += verified(p)
    sessions = split.drop_val(sessions)  # train worlds only
    f = fill(sessions)
    red = 0
    print(f"{len(sessions)} train sessions")
    for name, cell in q["cells"].items():
        if "sessions" in cell:
            n, target = f["recovery"], cell["sessions"]
            bad = n < target
            line = f"{n} / {target} sessions"
            need = max(0, target - n)
        else:
            n, hd = f["count"][cell["tag"]], f["hard"][cell["tag"]]
            share = cell.get("hard_share", 0.0)
            hs = hd / n if n else 0.0
            bad = n < cell["uses"] or hs < share
            line = f"{n} / {cell['uses']} uses" + (f", hard {hs:.0%} / {share:.0%}" if share else "")
            need = need_new(n, hd, cell["uses"], share)
        red += bad
        print(f"  {'RED' if bad else 'ok '} {name:32s} {line}" + (f"   need {need} more" if bad and a.plan else ""))
    if a.plan:
        alloc = q.get("allocation", {})
        tot = {g: sum(w["sessions"] for w in ws.values()) for g, ws in alloc.items()}
        print("allocation sessions per group:", tot, "total", sum(tot.values()))
    print(f"RED CELLS {red}")


if __name__ == "__main__":
    main()
