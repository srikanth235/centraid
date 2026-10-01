"""Count a world's new (gap-wave) sessions against the gap-wave quotas.

    python3 authored/gapcheck.py /tmp/authored-T05/T05.gold.jsonl

Reads only sessions numbered 101 and up. Same tagging code as gapreport.py, so what is counted here is
what the report will count. Train worlds only: a val world is refused.
"""
from __future__ import annotations

import json
import re
import sys
from collections import Counter
from pathlib import Path

import split
from gapreport import HERE, derive_tags, world_rows

# tag -> minimum uses per world (GAPBRIEF.md explains each)
QUOTA = {"ask:options": 14, "value:balance": 11, "convention:balance": 9, "write:star": 15, "decline:out_of_scope": 4,
         "context:never_mind": 4, "convention:weekend": 2, "convention:wifi": 2, "decline:fabricated_secret": 2,
         "decline:sealed_egress": 1, "decline:unbounded_destruction": 2, "write:reopen": 1}
MIX = {"outcome:diff": (0.50, 1.0), "outcome:value": (0.14, 1.0), "outcome:rows": (0.0, 0.22)}  # share of new turns
WATCH = ["convention:bare_weekday", "write:reschedule", "decline:not_found", "shape:long_>=12w", "shape:multi_write",
         "shape:fragment_<=3w", "distractor:present", "distractor:absent"]
DIFFICULTY = ("date", "depth", "fit", "typo", "limit", "flow")  # families of gapreport's difficulty tags


def main() -> None:
    sess = [json.loads(line) for line in open(sys.argv[1])]
    if any(split.is_val(s) for s in sess):
        sys.exit("gapcheck: that is a val world (authored/split.json); val worlds take no new sessions")
    new = [s for s in sess if int(re.search(r"-(\d+)$", s["id"]).group(1)) >= 101]
    cache: dict = {}
    c, turns = Counter(), 0
    for s in new:
        rows = world_rows(HERE / "worlds" / f"{s['world']}.json", cache)
        for i, t in enumerate(s["turns"], 1):
            turns += 1
            c.update(derive_tags(t, i, rows, s))
    print(f"{len(new)} new sessions, {turns} turns")
    for tag, q in QUOTA.items():
        print(f"  {'ok ' if c[tag] >= q else 'LOW'} {tag:32s} {c[tag]:3d} / {q}")
    for tag, (lo, hi) in MIX.items():
        v = c[tag] / max(1, turns)
        print(f"  {'ok ' if lo <= v <= hi else 'OFF'} {tag:32s} {v:5.0%} of turns (want {lo:.0%}-{hi:.0%})")
    print("  watch: " + ", ".join(f"{t.split(':', 1)[1]} {c[t]}" for t in WATCH))
    print("  difficulty: " + ", ".join(f"{t.replace(':', ' ')} {c[t]}" for t in sorted(c) if t.split(":")[0] in DIFFICULTY))
    sw = [c[t] for t in ("distractor:present", "distractor:absent")]
    if sum(sw):
        print(f"  near-miss rows on {sw[0] / sum(sw):.0%} of write turns (want 50%+)")


if __name__ == "__main__":
    main()
