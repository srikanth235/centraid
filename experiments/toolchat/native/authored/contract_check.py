"""Schema coverage: every gold call in val and in the train worlds' gold uses only tools and
parameters the contract (SPEC §4, CONTRACT_V2.md) allows.

    python3 authored/contract_check.py --gold '/tmp/authored-T*/T*.gold.jsonl'

Prints the share of calls that fit; exits 1 below 100%.
"""
from __future__ import annotations

import argparse
import glob
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SEL = {"kind", "name", "where", "when", "linked_to", "within", "exclude", "order", "limit", "trashed"}
ALLOWED = {
    "search": {"text", "kind"},
    "find": SEL,
    "open": {"row"},
    "compute": SEL | {"op", "field", "group", "rows"},
    "act": SEL | {"verb", "rows", "args", "more"},
    "answer": SEL | {"rows", "op", "field", "value"},
    "ask": {"question", "options"},
    "decline": {"reason"},
}


def calls(path):
    for line in open(path):
        rec = json.loads(line)
        for turn in rec.get("turns", []):
            yield from turn.get("ref") or []


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--gold", required=True)
    a = ap.parse_args()
    files = [str(HERE.parent / "eval/sets/val.jsonl")] + sorted(glob.glob(a.gold))
    total = bad = 0
    for f in files:
        for c in calls(f):
            total += 1
            args = set((c.get("args") or {}))
            if c.get("tool") not in ALLOWED or args - ALLOWED[c["tool"]]:
                bad += 1
                if bad <= 10:
                    print("misfit", f, c.get("tool"), sorted(args - ALLOWED.get(c.get("tool"), set())))
    print("schema coverage: %d/%d = %.2f%%" % (total - bad, total, 100 * (total - bad) / max(total, 1)))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
